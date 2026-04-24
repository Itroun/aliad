import { describe, it, expect } from 'vitest';
import { diffGraph } from '../src/ui/graph/eventStream.js';

const edge = (a, b, persons) => ({
  a,
  b,
  evidence: persons.map((p) => ({ person: p, hops: [] })),
});

describe('diffGraph', () => {
  it('returns empty deltas when snapshots match', () => {
    const g = { clusters: [{ id: 'c0', nodes: ['A', 'B'], edges: [edge('A', 'B', ['p1'])] }] };
    expect(diffGraph(g, g)).toEqual({ newEdges: [], evidenceDeltas: [] });
  });

  it('flags a brand-new edge as newEdges', () => {
    const prev = { clusters: [] };
    const next = { clusters: [{ id: 'c0', nodes: ['A', 'B'], edges: [edge('A', 'B', ['p1'])] }] };
    const { newEdges, evidenceDeltas } = diffGraph(prev, next);
    expect(newEdges).toHaveLength(1);
    expect(newEdges[0].edge.a).toBe('A');
    expect(newEdges[0].edge.b).toBe('B');
    expect(evidenceDeltas).toEqual([]);
  });

  it('flags new evidence on an existing edge', () => {
    const prev = { clusters: [{ id: 'c0', nodes: ['A', 'B'], edges: [edge('A', 'B', ['p1'])] }] };
    const next = {
      clusters: [{ id: 'c0', nodes: ['A', 'B'], edges: [edge('A', 'B', ['p1', 'p2', 'p3'])] }],
    };
    const { newEdges, evidenceDeltas } = diffGraph(prev, next);
    expect(newEdges).toEqual([]);
    expect(evidenceDeltas).toHaveLength(1);
    expect(evidenceDeltas[0].added.map((e) => e.person)).toEqual(['p2', 'p3']);
  });

  it('handles null/undefined inputs', () => {
    expect(diffGraph(null, null)).toEqual({ newEdges: [], evidenceDeltas: [] });
    expect(diffGraph(undefined, { clusters: [] })).toEqual({ newEdges: [], evidenceDeltas: [] });
  });
});
