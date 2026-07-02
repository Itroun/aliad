import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateExtractionInput, buildPayload, handle } from '../server/api/openrouter.js';
import { PRIMARY, FALLBACK } from '../src/core/models.js';
import {
  SYSTEM_PROMPT_HTML,
  SYSTEM_PROMPT_TEXT,
  ARTIST_SCHEMA,
} from '../src/core/extractPrompt.js';

describe('validateExtractionInput', () => {
  it('accepts a well-formed { kind, content } body', () => {
    expect(validateExtractionInput({ kind: 'html', content: 'festival page' })).toEqual({
      ok: true,
    });
  });

  it('rejects an invalid kind', () => {
    expect(validateExtractionInput({ kind: 'sql', content: 'x' }).error.status).toBe(400);
  });

  it('rejects missing / empty / non-string content', () => {
    expect(validateExtractionInput({ kind: 'text' }).error.status).toBe(400);
    expect(validateExtractionInput({ kind: 'text', content: '   ' }).error.status).toBe(400);
    expect(validateExtractionInput({ kind: 'text', content: 42 }).error.status).toBe(400);
  });

  it('rejects a null body', () => {
    expect(validateExtractionInput(null).error.status).toBe(400);
  });

  it('rejects pathologically large content with 413', () => {
    const huge = 'x'.repeat(600_001);
    expect(validateExtractionInput({ kind: 'text', content: huge }).error.status).toBe(413);
  });

  it('accepts content right at the size cap', () => {
    const atCap = 'x'.repeat(600_000);
    expect(validateExtractionInput({ kind: 'text', content: atCap })).toEqual({ ok: true });
  });
});

describe('buildPayload', () => {
  it('cages the request to the server prompt, schema and token cap for the given model', () => {
    const payload = buildPayload(PRIMARY, { kind: 'html', content: 'page text' });
    expect(payload.model).toBe(PRIMARY);
    expect(payload.max_tokens).toBe(4096);
    expect(payload.response_format).toEqual(ARTIST_SCHEMA);
    expect(payload.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT_HTML },
      { role: 'user', content: 'page text' },
    ]);
  });

  it('selects the text prompt for kind "text"', () => {
    const payload = buildPayload(FALLBACK, { kind: 'text', content: 'x' });
    expect(payload.messages[0].content).toBe(SYSTEM_PROMPT_TEXT);
  });
});

// ── handle(): end-to-end over a stubbed global fetch + fake KV ──────────────
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v);
    },
  };
}

function makeRequest(body, { ip = '9.9.9.9', method = 'POST', signal } = {}) {
  return {
    method,
    signal,
    headers: { get: (h) => (h === 'CF-Connecting-IP' ? ip : null) },
    json: async () => {
      if (body === Symbol.for('bad-json')) throw new Error('bad json');
      return body;
    },
  };
}

function makeContext(body, { env, ...reqOpts } = {}) {
  const waited = [];
  const request = makeRequest(body, reqOpts);
  const context = {
    request,
    env: env ?? { KV: fakeKV(), OPENROUTER_API_KEY: 'sk-test' },
    waitUntil: (p) => waited.push(p),
  };
  return { context, waited };
}

// OpenRouter chat-completions shaped upstream response.
function upstreamOk(artists) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ artists }) } }] }),
  };
}
function upstreamErr(status, bodyText = 'UPSTREAM SECRET DETAIL') {
  return { ok: false, status, text: async () => bodyText };
}
// An ok (billed) upstream response whose completion body isn't valid JSON.
function upstreamUnparseable() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
  };
}

function usageCount(env) {
  for (const [k, v] of env.KV.store) if (k.startsWith('openrouter:usage')) return Number(v);
  return 0;
}

afterEach(() => vi.unstubAllGlobals());

describe('handle', () => {
  it('rejects non-POST', async () => {
    const { context } = makeContext({}, { method: 'GET' });
    const res = await handle(context);
    expect(res.status).toBe(405);
  });

  it('runs only the cheap model and bills one call for a small clean extraction', async () => {
    const fetchMock = vi.fn(async () => upstreamOk(['One', 'Two']));
    vi.stubGlobal('fetch', fetchMock);

    const { context, waited } = makeContext({ kind: 'text', content: 'a short lineup' });
    const res = await handle(context);
    await Promise.all(waited);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artists).toEqual(['One', 'Two']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Server chose the cheap tier — the client never named a model.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(PRIMARY);
    expect(usageCount(context.env)).toBe(1);
  });

  it('ignores a client-supplied model / messages (no passthrough) and escalates server-side', async () => {
    const fetchMock = vi.fn(async (_url, opts) => {
      const model = JSON.parse(opts.body).model;
      // Cheap under-extracts on a big input → server escalates to FALLBACK.
      return model === PRIMARY ? upstreamOk(['One']) : upstreamOk(['A', 'B', 'C', 'D', 'E', 'F']);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { context, waited } = makeContext({
      kind: 'html',
      content: 'x'.repeat(5000),
      model: 'openai/gpt-4o', // must be ignored
      messages: [{ role: 'user', content: 'jailbreak' }], // must be ignored
    });
    const res = await handle(context);
    await Promise.all(waited);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artists).toHaveLength(6);

    // Two upstream calls: cheap then expensive — both server-chosen, never gpt-4o.
    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);
    expect(models).toEqual([PRIMARY, FALLBACK]);
    for (const c of fetchMock.mock.calls) {
      const sent = JSON.parse(c[1].body);
      expect(sent.messages[0].role).toBe('system');
      expect(sent.messages[1]).toEqual({ role: 'user', content: 'x'.repeat(5000) });
      expect(sent.response_format).toEqual(ARTIST_SCHEMA);
    }
    // An escalation draws down two units of the daily budget, not one.
    expect(usageCount(context.env)).toBe(2);
  });

  it('threads request.signal into the upstream fetch so escalation is cancellable', async () => {
    const fetchMock = vi.fn(async () => upstreamOk(['One', 'Two']));
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const { context, waited } = makeContext(
      { kind: 'text', content: 'a short lineup' },
      { signal: controller.signal },
    );
    await handle(context);
    await Promise.all(waited);

    // The upstream call must carry the client's abort signal; without it a
    // superseded run would still complete the (expensive) fallback server-side.
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('records a billed-but-unparseable completion in meta so the call count matches billing', async () => {
    const fetchMock = vi.fn(async (_url, opts) => {
      const model = JSON.parse(opts.body).model;
      // Cheap returns an ok-but-unparseable body (billed) → escalate; fallback ok.
      return model === PRIMARY ? upstreamUnparseable() : upstreamOk(['A', 'B', 'C', 'D', 'E', 'F']);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { context, waited } = makeContext({ kind: 'html', content: 'x'.repeat(5000) });
    const res = await handle(context);
    await Promise.all(waited);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artists).toHaveLength(6);

    // Both completions were billed AND both appear in meta (the first flagged as a
    // parse failure), so telemetry agrees with the 2-unit budget draw-down.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data.meta.calls).toHaveLength(2);
    expect(data.meta.calls[0]).toMatchObject({
      model: PRIMARY,
      outputArtists: 0,
      parseFailed: true,
    });
    expect(usageCount(context.env)).toBe(2);
  });

  it('returns a generic 502 without echoing the upstream error body', async () => {
    const fetchMock = vi.fn(async () => upstreamErr(500, 'UPSTREAM SECRET DETAIL'));
    vi.stubGlobal('fetch', fetchMock);

    const { context, waited } = makeContext({ kind: 'text', content: 'some lineup' });
    const res = await handle(context);
    await Promise.all(waited);

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe('Extraction failed');
    expect(text).not.toContain('SECRET');
    // Both attempts were non-ok (never billed) → no budget drawn down.
    expect(usageCount(context.env)).toBe(0);
  });

  it('rejects oversize content with 413 before any upstream call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { context } = makeContext({ kind: 'text', content: 'x'.repeat(600_001) });
    const res = await handle(context);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the API key is unconfigured', async () => {
    const { context } = makeContext({ kind: 'text', content: 'x' }, { env: { KV: fakeKV() } });
    const res = await handle(context);
    expect(res.status).toBe(500);
  });

  it('rejects invalid JSON bodies', async () => {
    const { context } = makeContext(Symbol.for('bad-json'));
    const res = await handle(context);
    expect(res.status).toBe(400);
  });
});
