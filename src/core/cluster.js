import { normaliseName } from './merge.js';

export function clusterArtists(perArtistResults) {
  const entries = (perArtistResults ?? []).filter((r) => normaliseName(r?.name));
  const n = entries.length;
  if (n === 0) return { clusters: [], singletons: [] };

  const keyToIndex = new Map();
  entries.forEach((r, i) => {
    const key = normaliseName(r.name);
    if (!keyToIndex.has(key)) keyToIndex.set(key, i);
  });

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  entries.forEach((r, i) => {
    const closure = r?.closure;
    if (!closure) return;
    for (const key of closure) {
      const j = keyToIndex.get(key);
      if (j !== undefined && j !== i) union(i, j);
    }
  });

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [];
  const singletons = [];
  const sortedRoots = [...groups.keys()].sort((a, b) => a - b);
  for (const root of sortedRoots) {
    const indices = groups.get(root).sort((a, b) => a - b);
    if (indices.length >= 2) {
      clusters.push({
        names: indices.map((i) => entries[i].name),
        entries: indices.map((i) => entries[i]),
      });
    } else {
      const i = indices[0];
      singletons.push({ name: entries[i].name, entry: entries[i] });
    }
  }

  return { clusters, singletons };
}
