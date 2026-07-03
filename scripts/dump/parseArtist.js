// Pure parser for one Discogs artists-dump record. No I/O.
//
// The monthly Discogs artists dump (`discogs_YYYYMM01_artists.xml.gz`) is
// line-delimited XML: one `<artist>…</artist>` per line, wrapped by a single
// `<artists>` open/close pair and an XML declaration. Field order inside a
// record is fixed: images?, id, name, realname?, profile?, data_quality,
// urls?, namevariations?, aliases?, groups?, members?.
//
// `parseArtist(line)` turns one record string into
//   { id, name, namevariations: string[],
//     aliases: {id,name}[], groups: {id,name}[], members: {id,name}[] }
// and returns `null` for any line that is not an `<artist>` record (the
// wrapper tags, the XML declaration, blank lines). It tolerates a record
// spanning more than one physical line, so the build script may hand it a
// buffered `<artist>…</artist>` slice if a future dump is pretty-printed.

const SECTION_RE = {
  namevariations: /<namevariations>([\s\S]*?)<\/namevariations>/,
  aliases: /<aliases>([\s\S]*?)<\/aliases>/,
  groups: /<groups>([\s\S]*?)<\/groups>/,
  members: /<members>([\s\S]*?)<\/members>/,
};

// `<name id="123">Text</name>` — the shape every relation entry uses. Members
// also carry redundant bare `<id>` elements; those have no text and are
// ignored because we only read `<name id=…>`.
const NAMED_ENTRY_RE = /<name id="(\d+)">([\s\S]*?)<\/name>/g;
// `<name>Text</name>` with no attributes — the namevariation shape.
const BARE_NAME_RE = /<name>([\s\S]*?)<\/name>/g;

export function parseArtist(line) {
  if (typeof line !== 'string') return null;
  if (line.indexOf('<artist>') === -1) return null;

  const idMatch = line.match(/<id>(\d+)<\/id>/);
  if (!idMatch) return null;
  const id = Number(idMatch[1]);

  // The artist's own name is the first bare `<name>` immediately after its
  // `<id>`. Anchoring on the id keeps namevariation/alias names from winning.
  const nameMatch = line.match(/<id>\d+<\/id>\s*<name>([\s\S]*?)<\/name>/);
  const name = nameMatch ? decodeEntities(nameMatch[1]) : '';

  return {
    id,
    name,
    namevariations: parseBareNames(sectionBody(line, 'namevariations')),
    aliases: parseNamedEntries(sectionBody(line, 'aliases')),
    groups: parseNamedEntries(sectionBody(line, 'groups')),
    members: parseNamedEntries(sectionBody(line, 'members')),
  };
}

function sectionBody(line, section) {
  const m = line.match(SECTION_RE[section]);
  return m ? m[1] : '';
}

function parseNamedEntries(body) {
  const out = [];
  if (!body) return out;
  NAMED_ENTRY_RE.lastIndex = 0;
  let m;
  while ((m = NAMED_ENTRY_RE.exec(body)) !== null) {
    const name = decodeEntities(m[2]);
    if (!name) continue;
    out.push({ id: Number(m[1]), name });
  }
  return out;
}

function parseBareNames(body) {
  const out = [];
  if (!body) return out;
  BARE_NAME_RE.lastIndex = 0;
  let m;
  while ((m = BARE_NAME_RE.exec(body)) !== null) {
    const name = decodeEntities(m[1]);
    if (name) out.push(name);
  }
  return out;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(text) {
  if (!text) return '';
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => NAMED_ENTITIES[name])
    .trim();
}

function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}
