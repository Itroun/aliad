// Single source of truth for the Discogs-dump relation-kind codes. The build
// (scripts/dump/build.js) encodes each relation section to a one-letter code in
// dump_edges.kind; the Worker adapter (server/_lib/dumpStore.js) decodes it back
// to a result bucket. Keeping both directions here — with BUCKET_FOR_CODE
// derived from KIND_CODE — means they cannot drift out of sync (a mismatch would
// silently drop edges on read).

// result bucket → dump_edges.kind letter
export const KIND_CODE = { aliases: 'a', groups: 'g', members: 'm' };

// dump_edges.kind letter → result bucket (the exact inverse, derived)
export const BUCKET_FOR_CODE = Object.fromEntries(
  Object.entries(KIND_CODE).map(([bucket, code]) => [code, bucket]),
);
