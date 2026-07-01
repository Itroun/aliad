// User-facing labels shared across the map, list, and plain-text export views,
// so the three renderings of the same data never drift out of sync.

// English plural helper: pluralize(1, 'act') → 'act', pluralize(2, 'act') → 'acts'.
export function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

// Heading for the acts that ended up with no connections. Rendered identically
// on the map (singleton label), the list view, and the copy-as-text export.
export function noConnectionsHeading(count) {
  return `${count} ${pluralize(count, 'act')} with no connections`;
}
