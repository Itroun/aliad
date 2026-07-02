#!/usr/bin/env node
// Model bake-off for the artist-extraction task (src/core/extract.js).
//
// Runs a set of candidate OpenRouter models over a small gold-labelled set of
// festival lineups and reports, per model: JSON-validity rate, extraction
// precision/recall/F1 against the gold names, latency (p50/p95), and projected
// cost. The point is to pick a Haiku replacement on evidence from *our* prompts
// and *our* inputs, not a leaderboard.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/bakeoff.mjs
//   node scripts/bakeoff.mjs --models mistralai/mistral-nemo,openai/gpt-oss-20b:free
//   node scripts/bakeoff.mjs --runs 3        # repeat each case N times (latency/variance)
//
// The key is read from OPENROUTER_API_KEY, or from .dev.vars if present.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SYSTEM_PROMPT_TEXT, SYSTEM_PROMPT_HTML, ARTIST_SCHEMA } from '../src/core/extract.js';
import { normaliseName } from '../src/core/merge.js';
import { PRIMARY, FALLBACK } from '../src/core/models.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Candidates under test. The call mirrors prod by sending the strict json_schema
// response_format (see callModel), so a candidate that can't honour structured
// outputs surfaces as errors / invalid JSON here — which is the right signal,
// since prod relies on that schema. Override per-run with --models. The two prod
// tiers lead so a run always re-measures the current baseline.
const DEFAULT_MODELS = [PRIMARY, FALLBACK];

// Gold set: { label, type, input, expected[] }. `type` picks the same system
// prompt prod would use ('html' → SYSTEM_PROMPT_HTML, else SYSTEM_PROMPT_TEXT).
// Names are drawn from the real test fixtures plus messy real-world phrasings
// (collabs, set-type annotations to strip, bullets, prose, comma lists). Expand
// this — the more representative the gold set, the more decisive the result.
const GOLD = [
  {
    label: 'messy-text',
    type: 'text',
    input: `Infected Mushroom, Shpongle (Live)
Aphex Twin · Hallucinogen
Astral Projection (DJ Set)`,
    expected: ['Infected Mushroom', 'Shpongle', 'Aphex Twin', 'Hallucinogen', 'Astral Projection'],
  },
  {
    label: 'collabs',
    type: 'text',
    input: `Dado vs Dino Psaras
Electric Universe b2b Astrix (Producer Set)`,
    expected: ['Dado vs Dino Psaras', 'Electric Universe b2b Astrix'],
  },
  {
    label: 'html-scrape',
    type: 'html',
    input: `<div class="lineup"><ul>
      <li><a href="/a/1">Dado vs Dino Psaras</a> <span class="stage">Main Stage</span></li>
      <li><a href="/a/2">Electric Universe</a> — Berlin</li>
      <li><a href="/a/3">Astrix</a> (Live)</li>
      </ul><footer>Presented by Some Promoter at The Venue</footer></div>`,
    expected: ['Dado vs Dino Psaras', 'Electric Universe', 'Astrix'],
  },
  {
    label: 'prose',
    type: 'text',
    input: `This summer's edition brings headliners Infected Mushroom and Shpongle to the
main stage, with support from Aphex Twin across the weekend. The forest stage hosts
Astral Projection and Hallucinogen for a special back-to-back closing set.`,
    expected: ['Infected Mushroom', 'Shpongle', 'Aphex Twin', 'Astral Projection', 'Hallucinogen'],
  },
  // Real acts from the dev example lineup (src/ui/inputScreen.js EXAMPLE_LINEUP),
  // re-rendered into the *messy* shape that actually reaches the LLM in prod —
  // the clean one-per-line original bypasses it via the clean-text path. Stage
  // headers and set annotations are noise the model must drop; odd collab
  // separators (VS, and "vc" — a real vs-typo) must stay combined per the prompt.
  {
    label: 'real-messy',
    type: 'text',
    input: `Main Stage
Atmos (Live), Battle of the Future Buddhas, Filteria, Ultravibe (DJ Set)
Moon Beasts · Proxeeus · DOOF
The Infinity Project VS Excess Head
Forest Stage
Process, Mark Allen (Producer Set), Skizologic vc Filteria
Cosmosis VS Laughing Buddha, Psychaos, Growling Mad Scientists`,
    expected: [
      'Atmos',
      'Battle of the Future Buddhas',
      'Filteria',
      'Ultravibe',
      'Moon Beasts',
      'Proxeeus',
      'DOOF',
      'The Infinity Project VS Excess Head',
      'Process',
      'Mark Allen',
      'Skizologic vc Filteria',
      'Cosmosis VS Laughing Buddha',
      'Psychaos',
      'Growling Mad Scientists',
    ],
  },
  {
    label: 'real-prose',
    type: 'text',
    input: `The festival returns this year with a stacked bill. Saturday's main stage is
anchored by Atmos and Filteria, with Battle of the Future Buddhas and Ultravibe
warming up the afternoon. Over on the forest stage, expect Moon Beasts, Proxeeus
and DOOF deep into the night, plus a rare The Infinity Project VS Excess Head
reunion. Sunday brings Process, Mark Allen and a Cosmosis VS Laughing Buddha
back-to-back, before Growling Mad Scientists close things out.`,
    expected: [
      'Atmos',
      'Filteria',
      'Battle of the Future Buddhas',
      'Ultravibe',
      'Moon Beasts',
      'Proxeeus',
      'DOOF',
      'The Infinity Project VS Excess Head',
      'Process',
      'Mark Allen',
      'Cosmosis VS Laughing Buddha',
      'Growling Mad Scientists',
    ],
  },
];

// Large/noisy reader-page captures (real fetches via /api/fetch-page mode=reader,
// the path prod falls through to when direct+cleanHTML is thin → type 'text' →
// SYSTEM_PROMPT_TEXT). These are the inputs the tiny inline GOLD cases above never
// exercised — exactly where mistral-nemo silently under-extracted in prod (a 101k
// reader page yielded 26 of 65 acts). Ground truth is the page's own `### ` artist
// headings; labels (set-type annotations stripped, _country codes stripped, collabs
// + aka/by/presents forms kept whole) live in zna-labels.json next to the captures.
function loadReaderFixtures() {
  const dir = join(ROOT, 'tests/fixtures/extract');
  try {
    const labels = JSON.parse(readFileSync(join(dir, 'zna-labels.json'), 'utf8'));
    // The per-slug capture read is inside the try too: a label entry whose
    // .reader.txt is missing should degrade to the inline GOLD, not crash the
    // whole bake-off at import time.
    return Object.entries(labels).map(([slug, expected]) => ({
      label: `zna-${slug}`,
      type: 'text',
      input: readFileSync(join(dir, `zna-${slug}.reader.txt`), 'utf8'),
      expected,
    }));
  } catch {
    return []; // fixtures absent/incomplete — fall back to the inline GOLD only
  }
}

GOLD.push(...loadReaderFixtures());

function parseArgs(argv) {
  const args = { models: DEFAULT_MODELS, runs: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--models') args.models = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--runs') args.runs = Math.max(1, Number(argv[++i]) || 1);
  }
  return args;
}

function readApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const vars = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
    const m = vars.match(/^\s*OPENROUTER_API_KEY\s*=\s*["']?([^"'\n]+)/m);
    if (m) return m[1].trim();
  } catch {
    /* no .dev.vars */
  }
  return null;
}

// Mirror of extract.js parseJSON: tolerate ```-fenced output.
function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1].trim());
    throw new Error('unparseable');
  }
}

// precision/recall/F1 over normalised name sets.
function score(predicted, expected) {
  const pred = new Set((predicted ?? []).map(normaliseName).filter(Boolean));
  const gold = new Set(expected.map(normaliseName));
  let tp = 0;
  for (const p of pred) if (gold.has(p)) tp++;
  const fp = pred.size - tp;
  const fn = gold.size - tp;
  const precision = pred.size ? tp / pred.size : 0;
  const recall = gold.size ? tp / gold.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const missed = [...gold].filter((g) => !pred.has(g));
  const spurious = [...pred].filter((p) => !gold.has(p));
  return { tp, fp, fn, precision, recall, f1, missed, spurious };
}

async function callModel(apiKey, model, system, userContent) {
  const start = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'aliad-bakeoff',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      // Mirror prod (server/api/openrouter.js): constrain the reply to { artists: [] }.
      // Without it, larger pages drift into prose/fences and bloat past max_tokens
      // — measuring the unconstrained shape would misrepresent prod behaviour.
      response_format: ARTIST_SCHEMA,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
  });
  const durationMs = Date.now() - start;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, durationMs, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage ?? {};
  return { ok: true, durationMs, raw, usage };
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const ms = (n) => `${Math.round(n)}ms`;
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runModel(apiKey, model, runs) {
  const latencies = [];
  let jsonOk = 0;
  let calls = 0;
  let httpErrors = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const f1s = [];
  const precisions = [];
  const recalls = [];
  const notes = [];

  for (const c of GOLD) {
    const system = c.type === 'html' ? SYSTEM_PROMPT_HTML : SYSTEM_PROMPT_TEXT;
    for (let r = 0; r < runs; r++) {
      calls++;
      const out = await callModel(apiKey, model, system, c.input);
      if (!out.ok) {
        httpErrors++;
        notes.push(`  ✗ ${c.label}: ${out.error}`);
        continue;
      }
      latencies.push(out.durationMs);
      promptTokens += out.usage.prompt_tokens ?? 0;
      completionTokens += out.usage.completion_tokens ?? 0;
      let parsed;
      try {
        parsed = parseJSON(out.raw);
        jsonOk++;
      } catch {
        notes.push(`  ⚠ ${c.label}: invalid JSON → ${out.raw.slice(0, 80).replace(/\n/g, ' ')}`);
        f1s.push(0);
        precisions.push(0);
        recalls.push(0);
        continue;
      }
      const s = score(parsed.artists, c.expected);
      f1s.push(s.f1);
      precisions.push(s.precision);
      recalls.push(s.recall);
      if (s.missed.length || s.spurious.length) {
        const parts = [];
        if (s.missed.length) parts.push(`missed [${s.missed.join(', ')}]`);
        if (s.spurious.length) parts.push(`spurious [${s.spurious.join(', ')}]`);
        notes.push(`  · ${c.label}: ${parts.join('; ')}`);
      }
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sortedLat = [...latencies].sort((a, b) => a - b);
  return {
    model,
    calls,
    httpErrors,
    jsonOkRate: calls ? jsonOk / calls : 0,
    precision: avg(precisions),
    recall: avg(recalls),
    f1: avg(f1s),
    p50: percentile(sortedLat, 50),
    p95: percentile(sortedLat, 95),
    promptTokens,
    completionTokens,
    notes,
  };
}

// Per-token prices ($/token) pulled from /api/v1/models; multiply for projected cost.
async function loadPricing(models) {
  const out = {};
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const data = (await res.json()).data ?? [];
    const byId = new Map(data.map((m) => [m.id, m.pricing]));
    for (const m of models) {
      const p = byId.get(m) ?? byId.get(m.replace(/:free$/, ''));
      out[m] = p ? { in: Number(p.prompt) || 0, out: Number(p.completion) || 0 } : null;
    }
  } catch {
    /* pricing best-effort */
  }
  return out;
}

async function main() {
  const { models, runs } = parseArgs(process.argv.slice(2));
  const apiKey = readApiKey();
  if (!apiKey) {
    console.error(
      'Missing OPENROUTER_API_KEY (env or .dev.vars). Get one at https://openrouter.ai/keys',
    );
    process.exit(1);
  }

  console.log(`Bake-off: ${models.length} models × ${GOLD.length} cases × ${runs} run(s)\n`);
  const pricing = await loadPricing(models);
  const results = [];
  for (const model of models) {
    process.stdout.write(`running ${model} … `);
    try {
      results.push(await runModel(apiKey, model, runs));
      console.log('done');
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }

  results.sort((a, b) => b.f1 - a.f1 || a.p50 - b.p50);

  console.log('\n' + '='.repeat(96));
  console.log(
    `${'model'.padEnd(38)}${'JSON'.padStart(6)}${'P'.padStart(6)}${'R'.padStart(6)}${'F1'.padStart(6)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'err'.padStart(6)}`,
  );
  console.log('-'.repeat(96));
  for (const r of results) {
    console.log(
      r.model.padEnd(38) +
        pct(r.jsonOkRate).padStart(6) +
        pct(r.precision).padStart(6) +
        pct(r.recall).padStart(6) +
        r.f1.toFixed(2).padStart(6) +
        ms(r.p50).padStart(8) +
        ms(r.p95).padStart(8) +
        String(r.httpErrors).padStart(6),
    );
  }
  console.log('='.repeat(96));

  // Projected cost per 1000 extractions, extrapolated from measured token usage.
  console.log('\nProjected cost per 1,000 extractions (from measured tokens):');
  for (const r of results) {
    const p = pricing[r.model];
    if (!p || (p.in === 0 && p.out === 0)) {
      console.log(`  ${r.model.padEnd(38)} free / unpriced`);
      continue;
    }
    const perCall = (r.promptTokens * p.in + r.completionTokens * p.out) / r.calls;
    console.log(`  ${r.model.padEnd(38)} $${(perCall * 1000).toFixed(3)}`);
  }

  console.log('\nNotes (misses / spurious / errors):');
  for (const r of results) {
    if (!r.notes.length) continue;
    console.log(`\n${r.model}:`);
    for (const n of r.notes) console.log(n);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
