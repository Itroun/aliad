// Shared data model for the aka graph.
// Clusters and singletons built from the sample lineup in the brief.

window.AKA_DATA = {
  lineup: [
    'Atmos',
    'Battle of the Future Buddhas',
    'Blue Planet Corporation',
    'Doof',
    'Eat Static',
    'Growling Mad Scientists',
    'Filteria',
    'Ultravibe',
    '1200mic',
    'Bumbling Loons',
    'Dickster',
    'Etnica',
    'Green Nuns of the Revolution',
    'Pleiadians',
  ],

  // Nodes that belong to clusters. Each node references its cluster id.
  clusters: [
    {
      id: 'c1',
      nodes: ['Dickster', 'Bumbling Loons', 'Green Nuns of the Revolution'],
      edges: [
        {
          a: 'Dickster',
          b: 'Bumbling Loons',
          evidence: [
            {
              person: 'Dick Trevor',
              hops: [
                { rel: 'aka', with: 'Dickster' },
                { rel: 'member of', with: 'Bumbling Loons' },
              ],
            },
          ],
        },
        {
          a: 'Dickster',
          b: 'Green Nuns of the Revolution',
          evidence: [
            {
              person: 'Dick Trevor',
              hops: [
                { rel: 'aka', with: 'Dickster' },
                { rel: 'member of', with: 'Green Nuns of the Revolution' },
              ],
            },
          ],
        },
        {
          a: 'Bumbling Loons',
          b: 'Green Nuns of the Revolution',
          evidence: [
            {
              person: 'Dick Trevor',
              hops: [
                { rel: 'member of', with: 'Bumbling Loons' },
                { rel: 'member of', with: 'Green Nuns of the Revolution' },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'c2',
      nodes: ['Etnica', 'Pleiadians'],
      edges: [
        {
          a: 'Etnica',
          b: 'Pleiadians',
          evidence: [
            {
              person: 'Maurizio Begotti',
              hops: [
                { rel: 'member of', with: 'Etnica' },
                { rel: 'member of', with: 'Pleiadians' },
              ],
            },
            {
              person: 'Max Lanfranconi',
              hops: [
                { rel: 'member of', with: 'Etnica' },
                { rel: 'member of', with: 'Pleiadians' },
              ],
            },
            {
              person: 'Carlo Paternò',
              hops: [
                { rel: 'member of', with: 'Etnica' },
                { rel: 'member of', with: 'Pleiadians' },
              ],
            },
            {
              person: 'Andrea Rizzo',
              hops: [
                { rel: 'member of', with: 'Etnica' },
                { rel: 'member of', with: 'Pleiadians' },
              ],
            },
          ],
        },
      ],
    },
  ],

  singletons: [
    'Atmos',
    'Battle of the Future Buddhas',
    'Blue Planet Corporation',
    'Doof',
    'Eat Static',
    'Growling Mad Scientists',
    'Filteria',
    'Ultravibe',
    '1200mic',
  ],
};

// Short summary of an evidence item for inline labels.
window.AKA_SUMMARY = function summary(ev, a, b) {
  const { person, hops } = ev;
  // Two-hop: aka + member of, member of + member of, etc.
  if (hops.length === 2) {
    const h1 = hops[0],
      h2 = hops[1];
    if (h1.rel === 'member of' && h2.rel === 'member of') {
      return `${person} — member of both`;
    }
    if (h1.rel === 'aka') {
      return `${person} — aka of ${h1.with}, ${h2.rel} ${h2.with}`;
    }
    return `${person} — ${h1.rel} ${h1.with}, ${h2.rel} ${h2.with}`;
  }
  if (hops.length === 1) {
    return `${person} — ${hops[0].rel} ${hops[0].with}`;
  }
  return person;
};
