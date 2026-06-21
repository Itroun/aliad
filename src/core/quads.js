// Pure decompose/reconstitute between a mapped provider result and typed quads.
// No I/O — imported by the server lookup endpoint (and anything else that wants
// to reason about the graph). The quad store (functions/_lib/quadStore.js) owns
// persistence; this module owns the shape.
//
// A mapped result `{ aliases, groups, members, relatedProjects }` for a subject
// `s = normaliseName(name)` decomposes into directed quads:
//
//   aliases[]         → aka(s, alias)
//   groups[]          → member_of(s, group)        (s is a member of the group)
//   members[]         → member_of(member, s)        (reversed: member is in s)
//   relatedProjects[] → related_project(s, project)
//
// Reconstitution scopes to a single producing lookup (`sourceKey`) so the blob
// round-trips exactly and no edges leak in from other lookups — that wider,
// cross-lookup view is the closure query's job (server/api/closure.js,
// getQuadsTouching), not this round-trip's.

import { emptyResult } from '../providers/provider.js';
import { normaliseName } from './merge.js';

export const PRED_AKA = 'aka';
export const PRED_MEMBER_OF = 'member_of';
export const PRED_RELATED = 'related_project';

export function sourceKeyFor(provider, nameKey) {
  return `${provider}:${nameKey}`;
}

function quad(sourceKey, subject, predicate, object, ctx) {
  return {
    sourceKey,
    subject,
    predicate,
    object,
    subjectLabel: ctx.subjectLabel,
    objectLabel: ctx.objectLabel,
    entryType: ctx.entryType,
    sourceUrl: ctx.sourceUrl,
  };
}

/**
 * Decompose a mapped result into quads attributed to one (provider, name) lookup.
 * @returns {Array} quad rows; empty if the result has no usable entries.
 */
export function resultToQuads(provider, nameKey, name, result) {
  const s = normaliseName(name);
  if (!s) return [];
  const sourceKey = sourceKeyFor(provider, nameKey);
  const quads = [];

  for (const e of result?.aliases ?? []) {
    const o = normaliseName(e?.name);
    if (!o) continue;
    quads.push(
      quad(sourceKey, s, PRED_AKA, o, {
        subjectLabel: name,
        objectLabel: e.name,
        entryType: e.type,
        sourceUrl: e.sourceUrl,
      }),
    );
  }

  for (const e of result?.groups ?? []) {
    const o = normaliseName(e?.name);
    if (!o) continue;
    quads.push(
      quad(sourceKey, s, PRED_MEMBER_OF, o, {
        subjectLabel: name,
        objectLabel: e.name,
        entryType: e.type,
        sourceUrl: e.sourceUrl,
      }),
    );
  }

  // Reversed orientation: the member is the subject, this lookup's artist the object.
  for (const e of result?.members ?? []) {
    const subj = normaliseName(e?.name);
    if (!subj) continue;
    quads.push(
      quad(sourceKey, subj, PRED_MEMBER_OF, s, {
        subjectLabel: e.name,
        objectLabel: name,
        entryType: e.type,
        sourceUrl: e.sourceUrl,
      }),
    );
  }

  for (const e of result?.relatedProjects ?? []) {
    const o = normaliseName(e?.name);
    if (!o) continue;
    quads.push(
      quad(sourceKey, s, PRED_RELATED, o, {
        subjectLabel: name,
        objectLabel: e.name,
        entryType: e.type,
        sourceUrl: e.sourceUrl,
      }),
    );
  }

  return quads;
}

/**
 * Rebuild the mapped result for subject `nameKey` from that lookup's quads.
 * Inverse of resultToQuads. Entry shape matches the providers' mappers
 * (`{ name, type, sourceUrl }`) so cached and live results merge identically.
 * Quad order is assumed to be insertion order (the store sorts by rowid).
 */
export function quadsToResult(nameKey, quads) {
  const result = emptyResult();
  const s = normaliseName(nameKey);
  for (const q of quads ?? []) {
    if (q.predicate === PRED_AKA && q.subject === s) {
      result.aliases.push(entry(q.objectLabel, q.entryType, q.sourceUrl));
    } else if (q.predicate === PRED_MEMBER_OF && q.subject === s) {
      result.groups.push(entry(q.objectLabel, q.entryType, q.sourceUrl));
    } else if (q.predicate === PRED_MEMBER_OF && q.object === s) {
      result.members.push(entry(q.subjectLabel, q.entryType, q.sourceUrl));
    } else if (q.predicate === PRED_RELATED && q.subject === s) {
      result.relatedProjects.push(entry(q.objectLabel, q.entryType, q.sourceUrl));
    }
  }
  return result;
}

function entry(name, type, sourceUrl) {
  return { name, type, sourceUrl };
}
