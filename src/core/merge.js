import { emptyResult } from '../providers/provider.js';

const BUCKETS = ['aliases', 'groups', 'members', 'relatedProjects'];

export function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names ?? []) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function normaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function mergeResults(...results) {
  const merged = emptyResult();
  for (const bucket of BUCKETS) {
    const seen = new Map();
    for (const result of results) {
      for (const entry of result?.[bucket] ?? []) {
        if (!entry?.name) continue;
        const key = normaliseName(entry.name);
        if (!key) continue;
        if (!seen.has(key)) {
          seen.set(key, { ...entry, sources: [] });
        }
        const existing = seen.get(key);
        if (entry.sourceUrl && !existing.sources.includes(entry.sourceUrl)) {
          existing.sources.push(entry.sourceUrl);
        }
      }
    }
    merged[bucket] = [...seen.values()];
  }
  return merged;
}
