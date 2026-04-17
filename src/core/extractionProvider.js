import { emptyResult } from '../providers/provider.js';
import { normaliseName } from './merge.js';

export function createExtractionProvider(discoveredAliases) {
  const aliasMap = new Map();
  for (const { artist, aliases } of discoveredAliases) {
    if (!artist || !Array.isArray(aliases)) continue;
    aliasMap.set(normaliseName(artist), {
      ...emptyResult(),
      aliases: aliases.map((name) => ({ name, source: 'page content' })),
    });
  }

  return {
    name: 'extraction',
    minIntervalMs: 0,
    async lookup(artistName) {
      return aliasMap.get(normaliseName(artistName)) ?? emptyResult();
    },
  };
}
