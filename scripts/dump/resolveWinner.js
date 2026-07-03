// Pure collision resolver for the dump name index. No I/O.
//
// Many Discogs artists share a `norm_name` (the production identity key):
// primary names collide with other artists' namevariations, "(N)"-suffixed
// disambiguations collapse once the suffix is stripped, etc. `dump_names` holds
// exactly one winner per `norm_name`, chosen deterministically so a rebuild of
// the same dump always picks the same artist.
//
// Tie-break, highest priority first:
//   1. a primary name beats a namevariation
//   2. an unsuffixed raw name beats a "(N)"-suffixed one
//   3. more identity edges beats fewer
//   4. lowest artist id wins (the final, always-decisive tiebreaker)
//
// Each candidate: { artist_id, primary: boolean, suffixed: boolean, edges: number }.
// `resolveWinner(candidates)` returns the winning `artist_id`.

export function resolveWinner(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('resolveWinner: need at least one candidate');
  }
  return candidates.reduce((best, c) => (isBetter(c, best) ? c : best)).artist_id;
}

// Is candidate `a` a better winner than the current best `b`?
function isBetter(a, b) {
  // 1. primary > namevariation
  if (a.primary !== b.primary) return a.primary;
  // 2. unsuffixed > "(N)"-suffixed
  if (a.suffixed !== b.suffixed) return !a.suffixed;
  // 3. more identity edges
  const ae = a.edges ?? 0;
  const be = b.edges ?? 0;
  if (ae !== be) return ae > be;
  // 4. lowest artist id — always decisive, so the result is deterministic
  return a.artist_id < b.artist_id;
}
