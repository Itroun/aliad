import { describe, it, expect } from 'vitest';
import { buildExportModel, toPlainText } from '../src/core/lineupExport.js';

// A minimal graph in the shape `buildGraph` returns: clusters with edges whose
// evidence carries person + hop chains. Only the fields lineupExport reads.
function graph() {
  return {
    clusters: [
      {
        id: 'c0',
        nodes: ['Cosmic Tide', 'Aurora Veil'],
        edges: [
          {
            a: 'Cosmic Tide',
            b: 'Aurora Veil',
            evidence: [
              {
                person: 'Some Person',
                hops: [
                  { rel: 'aka', with: 'Aurora Veil' },
                  { rel: 'member of', with: 'The Glass Orchard' },
                ],
              },
            ],
          },
        ],
      },
      // An edgeless cluster — should be dropped from the text model.
      { id: 'c1', nodes: ['Lonely Act'], edges: [] },
    ],
    singletons: [],
    kinds: new Map(),
  };
}

describe('buildExportModel', () => {
  it('keeps only clusters that have edges', () => {
    const model = buildExportModel(graph(), {
      lineup: ['Cosmic Tide', 'Aurora Veil', 'Lonely Act'],
    });
    expect(model.clusters).toHaveLength(1);
    expect(model.clusters[0].edges[0].a).toBe('Cosmic Tide');
  });

  it('derives singletons from lineup acts not in any cluster', () => {
    const model = buildExportModel(graph(), {
      lineup: ['Cosmic Tide', 'Aurora Veil', 'Nova Drift', 'Lonely Act'],
    });
    // Nova Drift and Lonely Act are not in the (edge-bearing) clustered set.
    expect(model.singletons).toEqual(['Nova Drift', 'Lonely Act']);
  });

  it('preserves person + hop chain on evidence', () => {
    const model = buildExportModel(graph(), { lineup: [] });
    const ev = model.clusters[0].edges[0].evidence[0];
    expect(ev.person).toBe('Some Person');
    expect(ev.hops).toEqual([
      { rel: 'aka', with: 'Aurora Veil' },
      { rel: 'member of', with: 'The Glass Orchard' },
    ]);
  });

  it('returns empty model for an empty graph', () => {
    const model = buildExportModel({ clusters: [], singletons: [] }, { lineup: [] });
    expect(model).toEqual({ clusters: [], singletons: [] });
  });
});

describe('toPlainText', () => {
  it('renders connections with a heading and via-chains', () => {
    const text = toPlainText(buildExportModel(graph(), { lineup: ['Cosmic Tide', 'Aurora Veil'] }));
    expect(text).toContain('Connected acts');
    expect(text).toContain('Cosmic Tide ↔ Aurora Veil');
    expect(text).toContain('via Some Person — aka Aurora Veil · member of The Glass Orchard');
  });

  it('renders a no-connections section listing leftover acts', () => {
    const text = toPlainText(buildExportModel(graph(), { lineup: ['Nova Drift'] }));
    expect(text).toMatch(/\d+ acts? with no connections/);
    expect(text).toContain('Nova Drift');
  });

  it('omits a section that has no content', () => {
    const text = toPlainText(buildExportModel(graph(), { lineup: ['Cosmic Tide', 'Aurora Veil'] }));
    expect(text).not.toContain('with no connections');
  });

  it('returns an empty string for an empty model', () => {
    expect(toPlainText({ clusters: [], singletons: [] })).toBe('');
  });
});
