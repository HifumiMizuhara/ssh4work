const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ASCII_PRINTABLE_RE = /^[\x20-\x7e]*$/;

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(str) {
  const s = String(str ?? '');
  if (!s.includes('\x1b')) return s;
  return s.replace(ANSI_RE, '');
}

/**
 * Approximate terminal column width of a single Unicode code point.
 */
export function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;

  // Combining diacritical marks & variation selectors & ZWJ
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }

  // East Asian Wide / Fullwidth + common Emoji ranges
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }

  return 1;
}

/**
 * Calculate terminal display width (ignoring ANSI codes).
 */
export function displayWidth(str) {
  const clean = stripAnsi(str);
  if (ASCII_PRINTABLE_RE.test(clean)) return clean.length;
  let w = 0;
  for (const ch of clean) {
    w += charWidth(ch.codePointAt(0));
  }
  return w;
}

function truncateWithWidth(str, maxWidth, ellipsis = '…') {
  const clean = stripAnsi(str);
  if (maxWidth <= 0) return { text: '', width: 0 };
  if (ASCII_PRINTABLE_RE.test(clean)) {
    if (clean.length <= maxWidth) return { text: clean, width: clean.length };
    const ellW = displayWidth(ellipsis);
    if (maxWidth < ellW) return { text: '', width: 0 };
    const cut = maxWidth - ellW;
    return { text: clean.slice(0, cut) + ellipsis, width: cut + ellW };
  }

  let totalW = 0;
  for (const ch of clean) {
    totalW += charWidth(ch.codePointAt(0));
  }
  if (totalW <= maxWidth) return { text: clean, width: totalW };

  const ellW = displayWidth(ellipsis);
  const target = Math.max(0, maxWidth - ellW);
  let out = '';
  let w = 0;
  for (const ch of clean) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > target) break;
    out += ch;
    w += cw;
  }
  if (maxWidth >= ellW) {
    return { text: out + ellipsis, width: w + ellW };
  }
  return { text: out, width: w };
}

/**
 * Truncate plain text to fit within maxWidth terminal columns.
 */
export function truncateToWidth(str, maxWidth, ellipsis = '…') {
  return truncateWithWidth(str, maxWidth, ellipsis).text;
}

/**
 * Pad plain text on the right with spaces to reach exact target width.
 */
export function padEndWidth(str, width) {
  const { text, width: w } = truncateWithWidth(str, width);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

/**
 * Format ISO or unix-ms timestamp into compact local string (MM-DD HH:mm).
 */
export function formatShortTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
