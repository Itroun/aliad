import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Config-consistency guard for the native [[ratelimits]] bindings
// (wrangler.toml ↔ server code). Two failure modes, both verified silent:
//  - a binding name referenced in code but not declared in wrangler.toml
//    deploys fine and degrades that endpoint's per-IP cap open (ipLimit.js
//    treats a missing binding as "unconfigured" by design);
//  - two bindings sharing a namespace_id deploy fine and silently SHARE one
//    counter per key, so unrelated endpoints eat each other's budget.
// No toml parser dep: the [[ratelimits]] blocks are regex-scanned.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function ratelimitBlocks() {
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  const blocks = [];
  const re = /^\[\[ratelimits\]\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
  for (const [, body] of toml.matchAll(re)) {
    const name = body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const namespaceId = body.match(/^\s*namespace_id\s*=\s*"([^"]+)"/m)?.[1];
    blocks.push({ name, namespaceId });
  }
  return blocks;
}

function serverJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return serverJsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

function referencedBindings() {
  const names = new Set();
  for (const file of serverJsFiles(join(root, 'server'))) {
    const source = readFileSync(file, 'utf8');
    for (const [name] of source.matchAll(/\bRL_[A-Z0-9_]+\b/g)) {
      names.add(name);
    }
  }
  return names;
}

describe('ratelimits config consistency', () => {
  const blocks = ratelimitBlocks();

  it('parses the [[ratelimits]] blocks out of wrangler.toml', () => {
    // Guards the regex itself: if the toml layout changes and the scan comes
    // back empty, fail here rather than vacuously passing the checks below.
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.name).toMatch(/^RL_[A-Z0-9_]+$/);
      expect(block.namespaceId).toMatch(/^\d+$/);
    }
  });

  it('declares every RL_* binding referenced in server code', () => {
    const declared = new Set(blocks.map((b) => b.name));
    const missing = [...referencedBindings()].filter((n) => !declared.has(n));
    expect(missing).toEqual([]);
  });

  it('gives every binding a unique namespace_id', () => {
    const ids = blocks.map((b) => b.namespaceId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
