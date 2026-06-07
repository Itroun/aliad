-- Phase 2 graph substrate. See PHASE2_GRAPH_PLAN.md.
-- `lookups` holds one freshness row per (provider, normalisedName) lookup;
-- `quads` holds the decomposed typed edges, attributed to the producing lookup
-- via source_key. D1 has no TTL, so expiry is logical (expires_at + schema_version
-- checked on read); dead rows linger until a future cleanup job.

CREATE TABLE IF NOT EXISTS lookups (
  source_key     TEXT PRIMARY KEY,   -- `${provider}:${nameKey}`
  provider       TEXT NOT NULL,
  name_key       TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  fetched_at     INTEGER NOT NULL,
  is_empty       INTEGER NOT NULL,   -- 0/1
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quads (
  source_key    TEXT NOT NULL,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,       -- aka | member_of | related_project
  object        TEXT NOT NULL,
  subject_label TEXT,
  object_label  TEXT,
  entry_type    TEXT,
  source_url    TEXT
);

CREATE INDEX IF NOT EXISTS idx_quads_source  ON quads(source_key);         -- reconstitution (Phase 2)
CREATE INDEX IF NOT EXISTS idx_quads_subject ON quads(subject, predicate); -- Phase 3
CREATE INDEX IF NOT EXISTS idx_quads_object  ON quads(predicate, object);  -- Phase 3
