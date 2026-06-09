// D1 adapter for the Phase 2 graph substrate. The ONLY place raw D1 SQL lives —
// handleLookup talks to the small interface returned by makeD1Store, and tests
// inject an in-memory fake implementing the same three methods (mirroring how
// fakeKV stands in for the KV binding). Schema in migrations/0001_create_graph.sql.
//
// Two tables:
//   lookups — one row per (provider, normalisedName) lookup: freshness + is_empty.
//   quads   — the decomposed edges, attributed to the producing lookup via
//             source_key. Reconstitution selects a single source_key's quads.
//
// Phase 3a adds getQuadsTouching: the first read that crosses source_keys — it
// gathers a node's edges in BOTH orientations across every lookup, which is what
// the graph-query layer (src/core/closure.js) needs to reconstitute a node's
// cross-provider view. Backed by idx_quads_subject / idx_quads_object.

// Map a snake_case quads row back to the camelCase shape quads.js expects.
function rowToQuad(r) {
  return {
    sourceKey: r.source_key,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    subjectLabel: r.subject_label,
    objectLabel: r.object_label,
    entryType: r.entry_type,
    sourceUrl: r.source_url,
  };
}

export function makeD1Store(db) {
  return {
    // Returns the lookups row for a source_key, or null.
    async getLookup(sourceKey) {
      return db
        .prepare(
          `SELECT source_key, provider, name_key, schema_version, fetched_at, is_empty, expires_at
             FROM lookups WHERE source_key = ?`,
        )
        .bind(sourceKey)
        .first();
    },

    // Returns the quads produced by a source_key, in insertion (rowid) order so
    // the reconstituted result preserves per-bucket ordering.
    async getQuads(sourceKey) {
      const { results } = await db
        .prepare(
          `SELECT source_key, subject, predicate, object, subject_label, object_label,
                  entry_type, source_url
             FROM quads WHERE source_key = ? ORDER BY rowid`,
        )
        .bind(sourceKey)
        .all();
      return (results ?? []).map(rowToQuad);
    },

    // Cross-lookup read: every quad where `key` is the subject OR the object,
    // across all source_keys. Both orientations matter — a node is the subject of
    // its aka/groups/related edges but the OBJECT of the member_of edges that put
    // its members under it. quads.js's quadsToResult buckets by orientation, so
    // handing it this union reconstitutes the node's full cross-provider result.
    async getQuadsTouching(key) {
      const { results } = await db
        .prepare(
          `SELECT source_key, subject, predicate, object, subject_label, object_label,
                  entry_type, source_url
             FROM quads WHERE subject = ? OR object = ? ORDER BY rowid`,
        )
        .bind(key, key)
        .all();
      return (results ?? []).map(rowToQuad);
    },

    // Atomically replace a lookup and its quads. delete-then-insert keeps a
    // rewrite from accumulating stale edges; the upsert refreshes freshness.
    async putLookupWithQuads(row, quads) {
      const statements = [
        db
          .prepare(
            `INSERT INTO lookups
               (source_key, provider, name_key, schema_version, fetched_at, is_empty, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_key) DO UPDATE SET
               provider = excluded.provider,
               name_key = excluded.name_key,
               schema_version = excluded.schema_version,
               fetched_at = excluded.fetched_at,
               is_empty = excluded.is_empty,
               expires_at = excluded.expires_at`,
          )
          .bind(
            row.sourceKey,
            row.provider,
            row.nameKey,
            row.schemaVersion,
            row.fetchedAt,
            row.isEmpty ? 1 : 0,
            row.expiresAt,
          ),
        db.prepare(`DELETE FROM quads WHERE source_key = ?`).bind(row.sourceKey),
        ...quads.map((q) =>
          db
            .prepare(
              `INSERT INTO quads
                 (source_key, subject, predicate, object, subject_label, object_label,
                  entry_type, source_url)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              q.sourceKey,
              q.subject,
              q.predicate,
              q.object,
              q.subjectLabel ?? null,
              q.objectLabel ?? null,
              q.entryType ?? null,
              q.sourceUrl ?? null,
            ),
        ),
      ];
      await db.batch(statements);
    },
  };
}
