// Turn a built graph (the `{ clusters, singletons, kinds }` shape from
// `buildGraph`) into a flat, render-and-export friendly model — and from there
// into a plain-text block the user can copy out of the List view.
//
// This is the same data the graph canvas and the focus panel draw, just
// linearised: every cluster's edges with their evidence hops, plus the acts
// that ended up with no connections. Kept as a pure module (no DOM) so both the
// List UI and its Copy button share one source of truth and it's unit-testable.

import { normaliseName } from './merge.js';

// Build the structured model the List view renders. `lineup` is the original
// act-name order; singletons are derived from it (acts not in any cluster) so
// the list matches the graph's own "no connections" section exactly, rather
// than trusting graph.singletons (which is graph-internal).
export function buildExportModel(graph, { lineup = [] } = {}) {
  const clusters = graph?.clusters ?? [];

  // Keep only clusters that actually have connections to show — an edgeless
  // cluster has nothing to say in a text list.
  const modelClusters = clusters
    .filter((cluster) => (cluster.edges ?? []).length > 0)
    .map((cluster) => ({
      nodes: cluster.nodes ?? [],
      edges: cluster.edges.map((edge) => ({
        a: edge.a,
        b: edge.b,
        evidence: (edge.evidence ?? []).map((e) => ({
          person: e.person,
          hops: (e.hops ?? []).map((h) => ({ rel: h.rel, with: h.with })),
        })),
      })),
    }));

  // Singletons = lineup acts not shown as connected. Basing this on the
  // edge-bearing clusters (not every cluster node) means an act stranded in an
  // edgeless cluster still surfaces here rather than disappearing from both.
  const connected = new Set(modelClusters.flatMap((c) => c.nodes));
  const singletons = lineup.filter((name) => !connected.has(name));

  return { clusters: modelClusters.map(({ edges }) => ({ edges })), singletons };
}

// Render one evidence row as "Person — rel with · rel with". The hop chain
// mirrors the focus panel's inline rendering, in plain text.
function evidenceLine(ev) {
  const chain = (ev.hops ?? []).map((h) => `${h.rel} ${h.with}`).join(' · ');
  return chain ? `${ev.person} — ${chain}` : ev.person;
}

// Flatten the model to a copy-paste plain-text block. Stable, human-readable,
// and dependency-free so it pastes cleanly into notes, chat, a spreadsheet cell.
export function toPlainText(model) {
  const { clusters = [], singletons = [] } = model ?? {};
  const blocks = [];

  if (clusters.length) {
    const lines = ['Same act, different names', '========================='];
    for (const cluster of clusters) {
      for (const edge of cluster.edges) {
        lines.push(`${edge.a} ↔ ${edge.b}`);
        for (const ev of edge.evidence) lines.push(`  via ${evidenceLine(ev)}`);
      }
    }
    blocks.push(lines.join('\n'));
  }

  if (singletons.length) {
    const lines = ['No connections found', '--------------------', ...singletons];
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}
