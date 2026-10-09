// Parses the subscriptions.csv from Google Takeout (YouTube and YouTube Music -> subscriptions).
// Expected columns: "Channel Id","Channel Url","Channel Title" (found by header name, with a
// positional fallback), quoted fields, escaped quotes, CRLF and a BOM are all handled.

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// -> { subs: [{ id, title }] sorted by title, ignored: number of unusable rows }
export function parseSubscriptions(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { subs: [], ignored: 0 };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  let idCol = header.findIndex((h) => h.includes('id'));
  let titleCol = header.findIndex((h) => h.includes('title'));
  const hasHeader = idCol !== -1 || titleCol !== -1;

  if (idCol === -1) idCol = 0;
  if (titleCol === -1) titleCol = Math.min(2, rows[0].length - 1);

  const data = hasHeader ? rows.slice(1) : rows;
  const seen = new Set();
  const subs = [];
  let ignored = 0;

  for (const r of data) {
    const id = (r[idCol] || '').trim();
    if (!CHANNEL_ID_RE.test(id) || seen.has(id)) {
      ignored++;
      continue;
    }
    seen.add(id);
    subs.push({ id, title: (r[titleCol] || '').replace(/\s+/g, ' ').trim() || id });
  }

  subs.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return { subs, ignored };
}
