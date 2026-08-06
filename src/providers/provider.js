export function emptyResult() {
  return { aliases: [], groups: [], members: [], relatedProjects: [] };
}

// True when a result carries no relations at all — i.e. the name resolved to
// nothing. Distinct from "not found": a real artist with no catalogued
// relations looks identical here, which is fine for every current caller
// (they're deciding whether there is anything to show/walk, not whether the
// upstream knew the name).
export function isEmptyResult(result) {
  return (
    !result?.aliases?.length &&
    !result?.groups?.length &&
    !result?.members?.length &&
    !result?.relatedProjects?.length
  );
}
