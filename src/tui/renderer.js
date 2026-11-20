import { displayWidth, padEndWidth, truncateToWidth } from '../utils/text.js';

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  fg: {
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    brightWhite: '\x1b[97m',
    brightCyan: '\x1b[96m',
    brightYellow: '\x1b[93m',
    brightGreen: '\x1b[92m',
  },
  bg: {
    black: '\x1b[40m',
    blue: '\x1b[44m',
    cyan: '\x1b[46m',
    gray: '\x1b[100m',
    darkGray: '\x1b[48;5;236m',
    navy: '\x1b[48;5;24m',
    teal: '\x1b[48;5;30m',
  },
};

export class ScreenBuffer {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.chunks = [];
    this.rowChunks = Array.from({ length: this.rows }, () => []);
    this.rowStrings = null;
    this.hitBoxes = [];
    this._cursor = null;
    this._clipMaxX = null;
    this._clear = true;
    this._plainOps = Array.from({ length: this.rows }, () => []);
    this._grid = null;
  }

  get grid() {
    return this._ensureGrid();
  }

  _createGrid() {
    return Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
  }

  _applyPlainOp(row, x, text) {
    const raw = String(text);
    const plain = raw.includes('\x1b') ? raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') : raw;
    let col = x - 1;
    for (const ch of plain) {
      if (col >= this.cols) break;
      const w = displayWidth(ch);
      if (w === 0) continue;
      if (col >= 0) row[col] = ch;
      if (w === 2 && col + 1 >= 0 && col + 1 < this.cols) {
        row[col + 1] = '';
      }
      col += w;
    }
  }

  _ensureGrid() {
    if (this._grid) return this._grid;
    const g = this._createGrid();
    for (let r = 0; r < this.rows; r++) {
      const ops = this._plainOps[r];
      if (!ops || ops.length === 0) continue;
      const row = g[r];
      for (let i = 0; i < ops.length; i += 2) {
        this._applyPlainOp(row, ops[i], ops[i + 1]);
      }
    }
    this._grid = g;
    return g;
  }

  begin({ clear = true } = {}) {
    this._clear = Boolean(clear);
    this.chunks = [clear ? '\x1b[?2026h\x1b[?25l\x1b[H\x1b[2J' : '\x1b[?2026h\x1b[?25l\x1b[H'];
    this.rowChunks = Array.from({ length: this.rows }, () => []);
    this.rowStrings = null;
    this.hitBoxes = [];
    this._cursor = null;
    this._clipMaxX = null;
    this._plainOps = Array.from({ length: this.rows }, () => []);
    this._grid = null;
  }

  setClipMaxX(maxX) {
    this._clipMaxX = maxX;
  }

  clearClipMaxX() {
    this._clipMaxX = null;
  }

  setCursor(x, y) {
    if (x >= 1 && x <= this.cols && y >= 1 && y <= this.rows) {
      this._cursor = { x, y };
    }
  }

  moveTo(x, y) {
    const seq = `\x1b[${y};${x}H`;
    this.chunks.push(seq);
    if (y >= 1 && y <= this.rows) {
      this.rowChunks[y - 1]?.push(seq);
    }
  }

  writeAt(x, y, text, style = '') {
    if (y < 1 || y > this.rows || x > this.cols) return;
    this.moveTo(x, y);
    const rowArr = this.rowChunks[y - 1];
    if (style) {
      this.chunks.push(style, text, ANSI.reset);
      rowArr?.push(style, text, ANSI.reset);
    } else {
      this.chunks.push(text);
      rowArr?.push(text);
    }
    this._plainOps[y - 1]?.push(x, text);
    if (this._grid) {
      this._applyPlainOp(this._grid[y - 1], x, text);
    }
  }

  /**
   * Draw a padded full-width line at row y (1-based).
   */
  drawLine(y, text, style = '') {
    // Avoid writing to the bottom-right cell (cols, rows) to prevent terminal auto-wrap/scroll
    if (y === this.rows) {
      const safe = padEndWidth(text, Math.max(0, this.cols - 1));
      this.writeAt(1, y, `${safe}\x1b[K`, style);
      return;
    }
    const padded = padEndWidth(text, this.cols);
    this.writeAt(1, y, padded, style);
  }

  /**
   * Draw a clickable/tappable button and register its hitbox.
   * Returns the next X column after the button.
   */
  drawButton(x, y, label, action, payload = null, { active = false, primary = false, danger = false } = {}) {
    const text = ` ${label} `;
    const w = displayWidth(text);
    const limitX = this._clipMaxX ? Math.min(this.cols, this._clipMaxX) : this.cols;
    if (x + w - 1 > limitX) return x;

    let style = `${ANSI.bg.darkGray}${ANSI.fg.brightWhite}`;
    if (active) style = `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}`;
    else if (primary) style = `${ANSI.bg.teal}${ANSI.fg.brightWhite}${ANSI.bold}`;
    else if (danger) style = `\x1b[41m${ANSI.fg.brightWhite}${ANSI.bold}`;

    this.writeAt(x, y, text, style);
    this.addHitBox(x, y, x + w - 1, y, action, payload);
    return x + w + 1;
  }

  /**
   * Draw a horizontal box border or separator.
   */
  drawRule(y, ch = '─', style = ANSI.fg.gray) {
    this.writeAt(1, y, ch.repeat(this.cols), style);
  }

  /**
   * Draw a vertical draggable scrollbar at column x (1-based).
   */
  drawScrollbar(x, y, h, scroll, total, visible, action = 'scrollbarDrag', extra = null) {
    if (x < 1 || x > this.cols || h < 2 || total <= visible) return;
    const maxScroll = Math.max(1, total - visible);
    const thumbH = Math.max(1, Math.min(h, Math.round((visible / total) * h)));
    const ratio = Math.max(0, Math.min(1, scroll / maxScroll));
    const thumbOffset = Math.round(ratio * (h - thumbH));
    const hovered = Boolean(extra?.hovered);
    const thumbCh = hovered ? '█' : '┃';
    const thumbStyle = hovered ? `${ANSI.fg.brightWhite}${ANSI.bold}` : ANSI.fg.brightCyan;
    const trackStyle = hovered ? ANSI.fg.white : ANSI.fg.gray;
    for (let i = 0; i < h; i++) {
      const isThumb = i >= thumbOffset && i < thumbOffset + thumbH;
      this.writeAt(x, y + i, isThumb ? thumbCh : '│', isThumb ? thumbStyle : trackStyle);
    }
    this.addHitBox(x, y, x, y + h - 1, action, { y, h, total, visible, ...(extra || {}) });
  }

  /**
   * Draw a centered modal box and return inner bounds { x, y, w, h }.
   */
  drawBox(x, y, w, h, title = '') {
    const innerW = Math.max(2, w - 2);
    const titleStr = title ? ` ${truncateToWidth(title, innerW - 4)} ` : '';
    const titleW = displayWidth(titleStr);
    const leftDashes = Math.max(0, Math.floor((innerW - titleW) / 2));
    const rightDashes = Math.max(0, innerW - titleW - leftDashes);

    this.writeAt(
      x,
      y,
      `┌${'─'.repeat(leftDashes)}${titleStr}${'─'.repeat(rightDashes)}┐`,
      `${ANSI.bg.navy}${ANSI.fg.brightWhite}${ANSI.bold}`
    );
    for (let row = 1; row < h - 1; row++) {
      this.writeAt(x, y + row, `│${' '.repeat(innerW)}│`, `${ANSI.bg.navy}${ANSI.fg.brightWhite}`);
    }
    this.writeAt(
      x,
      y + h - 1,
      `└${'─'.repeat(innerW)}┘`,
      `${ANSI.bg.navy}${ANSI.fg.brightWhite}`
    );
    return { x: x + 2, y: y + 1, w: w - 4, h: h - 2 };
  }

  addHitBox(x1, y1, x2, y2, action, payload = null) {
    this.hitBoxes.push({ x1, y1, x2, y2, action, payload });
  }

  /**
   * Find the topmost hitbox containing (x, y) (1-based).
   */
  hitTest(x, y) {
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const b = this.hitBoxes[i];
      if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) {
        return b;
      }
    }
    return null;
  }

  normalizeSelection(x1, y1, x2, y2) {
    let sx = Math.max(1, Math.min(this.cols, x1));
    let sy = Math.max(1, Math.min(this.rows, y1));
    let ex = Math.max(1, Math.min(this.cols, x2));
    let ey = Math.max(1, Math.min(this.rows, y2));
    if (sy > ey || (sy === ey && sx > ex)) {
      [sx, ex] = [ex, sx];
      [sy, ey] = [ey, sy];
    }
    return { sx, sy, ex, ey };
  }

  extractText(x1, y1, x2, y2) {
    const { sx, sy, ex, ey } = this.normalizeSelection(x1, y1, x2, y2);
    const lines = [];
    for (let y = sy; y <= ey; y++) {
      const row = this.grid[y - 1];
      if (!row) continue;
      const cStart = y === sy ? sx - 1 : 0;
      const cEnd = y === ey ? ex - 1 : this.cols - 1;
      let s = '';
      for (let c = cStart; c <= cEnd; c++) {
        if (row[c]) s += row[c];
      }
      lines.push(s.replace(/\s+$/g, ''));
    }
    return lines.join('\n').trim();
  }

  highlightSelection(x1, y1, x2, y2) {
    const { sx, sy, ex, ey } = this.normalizeSelection(x1, y1, x2, y2);
    for (let y = sy; y <= ey; y++) {
      const row = this.grid[y - 1];
      if (!row) continue;
      let cStart = y === sy ? sx - 1 : 0;
      const cEnd = y === ey ? ex - 1 : this.cols - 1;
      // If starting on the trailing half of a wide char, step back 1 cell
      if (cStart > 0 && row[cStart] === '') cStart -= 1;
      let s = '';
      for (let c = cStart; c <= cEnd; c++) {
        s += row[c] === '' ? '' : row[c];
      }
      if (s) {
        this.moveTo(cStart + 1, y);
        this.chunks.push('\x1b[7m', s, ANSI.reset);
        this.rowChunks[y - 1]?.push('\x1b[7m', s, ANSI.reset);
      }
    }
  }

  flush({ prevScreen = null } = {}) {
    this.rowStrings = this.rowChunks.map((arr) => arr.join(''));
    const canDiff =
      !this._clear &&
      prevScreen &&
      prevScreen.cols === this.cols &&
      prevScreen.rows === this.rows &&
      Array.isArray(prevScreen.rowStrings);

    if (canDiff) {
      const diffParts = [];
      for (let r = 0; r < this.rows; r++) {
        if (this.rowStrings[r] !== prevScreen.rowStrings[r]) {
          diffParts.push(this.rowStrings[r]);
        }
      }
      const prevCur = prevScreen._cursor;
      const curChanged =
        Boolean(this._cursor) !== Boolean(prevCur) ||
        (this._cursor && prevCur && (this._cursor.x !== prevCur.x || this._cursor.y !== prevCur.y));

      if (diffParts.length === 0 && !curChanged) {
        return true;
      }

      const out = ['\x1b[?2026h\x1b[?25l', ...diffParts];
      if (this._cursor) {
        out.push(`\x1b[${this._cursor.y};${this._cursor.x}H\x1b[5 q\x1b[?25h`);
      }
      out.push('\x1b[?2026l');
      return process.stdout.write(out.join(''));
    }

    if (this._cursor) {
      this.chunks.push(`\x1b[${this._cursor.y};${this._cursor.x}H\x1b[5 q\x1b[?25h`);
    }
    this.chunks.push('\x1b[?2026l');
    return process.stdout.write(this.chunks.join(''));
  }
}
