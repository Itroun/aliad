// Pure lineup-name → source-name rules. Festival programs bill acts in forms no
// discography database carries, and every match in the pipeline is exact on the
// normalised name (dump `norm_name`, discogs `pickMatch`, MB `pickMatch`), so a
// billing the sources don't use resolves to nothing at all.
//
// Two shapes, handled differently because they mean different things:
//
//  - SPLIT ("X vs Y", "X aka Y"): the billing names TWO identities and matches
//    nothing itself. `lookupAll` opens one closure stream per part and merges.
//  - SUBSTITUTION ("X in Dub"): the billing names ONE identity under a
//    performance-mode label. `/api/closure` re-roots the walk onto the base name.
//
// Both live here so the client split and the server re-root read the same rules
// — the re-root has to know what the client already split, or it re-walks a
// combo name that was never going to resolve. Kept UI-free and I/O-free so the
// Worker can import it.

// Festival lineups commonly use "X vs Y", "X b2b Y", "X & Y" for collab acts.
// Providers don't know these combined names, so we look up the constituents
// individually and merge their data + closures into the combo's entry.
const COLLAB_SEPARATORS = [/\s+vs\.?\s+/i, /\s+b2b\s+/i, /\s+&\s+/, /\s+f(?:ea)?t\.?\s+/i];

// Same split, different meaning: these bill ONE person under two names, so the
// act is not a collaboration even though it yields two nodes. "Robert Leiner aka
// The Source Experience" is the festival stating the alias outright — the one
// form the app couldn't read, despite aliases being its whole subject.
const ALIAS_SEPARATORS = [/\s+aka\s+/i, /\s+presents\s+/i];

// NOTE: a trailing parenthetical ("Benji Vaughan (Prometheus)") looks like the
// same shape and is deliberately NOT split. Festival billings use that slot for
// origin far more often than for a second identity — "Nu Zau (RO)", "DJ Bone
// (Detroit)" — and short place tokens like "UK" and "Detroit" are themselves
// real Discogs artists, so splitting merged an unrelated act's members onto the
// row. No denylist fixes it: "Detroit" is indistinguishable from "Prometheus"
// without knowing which is a place. Measured cost of dropping it: one node on a
// 136-act lineup, and that node was already reachable from another row.

// Base must keep ≥3 chars, matching stripCountrySuffix's guard — a two-letter
// residue is far more likely a mangled name than a real artist worth a lookup.
const MIN_BASE = 3;

// Anchored to the END and required to follow a word boundary, so a qualifier
// word that is part of the name survives: "Gabi Von Dub", "Kukan dub Lagan" and
// "Synergy Dub" are all real artists and none of these patterns touch them.
// A bare trailing "live" is here rather than in the extraction prompt (which
// only strips the parenthesised "(Live)") because it also turns up mid-name
// after a split: "Mathew Jonson presents Freedom Engine Live" splits to
// "Freedom Engine Live", and each part is its own closure root, so the two
// rules compose without either knowing about the other.
const QUALIFIERS = [
  /\s+in\s+dub$/i,
  /\s+sound\s?system$/i,
  /\s+acoustic$/i,
  /\s+unplugged$/i,
  /\s+live$/i,
];

function splitOn(name, separators) {
  for (const sep of separators) {
    if (!sep.test(name)) continue;
    const parts = name
      .split(sep)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return null;
}

/**
 * Split a multi-identity billing into its parts, tagged with what the billing
 * MEANS: `collab` (two acts performing together) or `alias` (one act under two
 * names). The tag drives the node glyph + a11y label, so an alias billing isn't
 * announced as a collaboration. Returns null for an ordinary single name.
 */
export function splitBilling(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  const collab = splitOn(s, COLLAB_SEPARATORS);
  if (collab) return { parts: collab, kind: 'collab' };
  const alias = splitOn(s, ALIAS_SEPARATORS);
  if (alias) return { parts: alias, kind: 'alias' };
  return null;
}

/**
 * The base name behind a performance-mode billing, or null when the name
 * carries no qualifier (the overwhelmingly common case — measured at 1 act in
 * 136 across a three-stage lineup, so this must stay a fallback, never a
 * rewrite applied up front).
 */
export function stripPerformanceQualifier(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  for (const q of QUALIFIERS) {
    if (!q.test(s)) continue;
    const base = s.replace(q, '').trim();
    if (base.length >= MIN_BASE) return base;
  }
  return null;
}

/**
 * Which lineup row owns the re-root onto `baseKey`, given every billed row.
 * Two rows can strip to the same base ("X in Dub" + "X Live"); each closure
 * stream is a separate request and can't see the others, so ownership is
 * resolved deterministically from the shared `roots` list instead — first row
 * wins, the rest skip. Without this both re-root onto the same node and the
 * graph draws an edge between an artist and itself.
 *
 * `normalise` is injected to avoid this module depending on merge.js.
 */
export function reRootOwner(roots, baseKey, normalise) {
  for (const row of roots ?? []) {
    const base = stripPerformanceQualifier(row);
    if (base && normalise(base) === baseKey) return row;
  }
  return null;
}
