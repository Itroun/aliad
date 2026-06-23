import { describe, it, expect } from 'vitest';
import { createLayout } from '../src/ui/graph/layout.js';

// Count edge-segment crossings (edges sharing an endpoint don't count) — the
// same measure the layout's restart pass minimises.
function ccw(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}
function crosses(p1, p2, p3, p4) {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}
function countCrossings(nodes, edges, pos) {
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = [edges[i].a, edges[i].b];
      const [c, d] = [edges[j].a, edges[j].b];
      if (a === c || a === d || b === c || b === d) continue;
      if (crosses(pos.get(a), pos.get(b), pos.get(c), pos.get(d))) n++;
    }
  }
  return n;
}

const cluster = (nodes, edgePairs) => ({
  nodes,
  edges: edgePairs.map(([a, b]) => ({ a, b, evidence: [{ person: a, hops: [] }] })),
});

describe('layout edge-crossing minimisation', () => {
  // A triangle with a tail off one vertex is planar but the raw force sim folds
  // the tail back over the body (the real "Cosmosis" cluster). The restart pass
  // must untangle it.
  it('lays out a triangle-plus-tail with no crossings', () => {
    const c = cluster(
      ['A', 'B', 'C', 'D', 'E'],
      [
        ['A', 'B'],
        ['A', 'C'],
        ['B', 'C'],
        ['C', 'D'],
        ['D', 'E'],
      ],
    );
    const { positions } = createLayout({ width: 800, height: 600 }).compute({ clusters: [c] }, 250);
    expect(countCrossings(c.nodes, c.edges, positions)).toBe(0);
  });

  it('lays out a path with no crossings', () => {
    const c = cluster(
      ['A', 'B', 'C', 'D'],
      [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
      ],
    );
    const { positions } = createLayout({ width: 800, height: 600 }).compute({ clusters: [c] }, 250);
    expect(countCrossings(c.nodes, c.edges, positions)).toBe(0);
  });

  it('is deterministic across runs (reproducible restarts)', () => {
    const make = () =>
      createLayout({ width: 800, height: 600 })
        .compute(
          {
            clusters: [
              cluster(
                ['A', 'B', 'C', 'D', 'E'],
                [
                  ['A', 'B'],
                  ['A', 'C'],
                  ['B', 'C'],
                  ['C', 'D'],
                  ['D', 'E'],
                ],
              ),
            ],
          },
          250,
        )
        .positions.get('E');
    expect(make()).toEqual(make());
  });
});
