// The single "paste anything" field hands its raw contents here. We sort it
// line-by-line into URLs to fetch vs. lineup text to parse, so the UI can show a
// live readout of what it found and the submit path can resolve both and merge.
//
// Detection is deliberately conservative: a line counts as a URL only if, once
// trimmed, it is *nothing but* an http(s) link (or a bare `www.` host we can
// promote to https). A link sitting inside a sentence is left in the text — far
// better to under-detect a stray URL than to yank a word out of a lineup because
// it happened to look link-ish. `javascript:` / `file:` and friends never match.
const URL_LINE = /^(https?:\/\/|www\.)\S+$/i;

export function classifyInput(text) {
  const lines = String(text ?? '').split('\n');
  const urls = [];
  const seen = new Set();
  const textLines = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (URL_LINE.test(line)) {
      const url = /^www\./i.test(line) ? `https://${line}` : line;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    } else {
      textLines.push(raw);
    }
  }

  const textValue = textLines.join('\n').trim();
  const actCount = textValue ? textValue.split('\n').filter((l) => l.trim()).length : 0;

  return { urls, text: textValue, actCount };
}
