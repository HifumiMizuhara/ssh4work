import { charWidth } from '../utils/text.js';

const CSI_STICKY_RE = /\x1b\[([0-9;?><=!]*[A-Za-z@`~])/y;

function emptyCell() {
  return { ch: ' ', style: '', wide: false, cont: false };
}

function makeRow(cols) {
  const row = new Array(cols);
  for (let c = 0; c < cols; c++) row[c] = emptyCell();
  row._dirty = true;
  row._rendered = null;
  row._renderedCols = -1;
  return row;
}

function makeGrid(cols, rows) {
  const grid = new Array(rows);
  for (let r = 0; r < rows; r++) grid[r] = makeRow(cols);
  return grid;
}

/**
 * Lightweight VT100/ANSI virtual terminal screen buffer for embedded SSH tabs.
 */
export class VirtualTerminal {
  constructor(cols = 80, rows = 24, { onResponse = null, onOsc = null } = {}) {
    this.cols = Math.max(10, cols);
    this.rows = Math.max(4, rows);
    this.onResponse = onResponse;
    this.onOsc = onOsc;
    this.grid = makeGrid(this.cols, this.rows);
    this.altGrid = null;
    this.savedMain = null;
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedCursor = { row: 0, col: 0 };
    this.cursorVisible = true;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.scrollback = [];
    this.maxScrollback = 2000;
    this.scrollOffset = 0;
    this.currentStyle = '';
    this._sgr = { attrs: new Set(), fg: '', bg: '' };
    this.mouseModes = new Set();
    this.bracketedPaste = false;
    this._escBuf = '';
  }

  hasMouseTracking() {
    return this.mouseModes.size > 0;
  }

  scrollBy(delta) {
    if (this.altGrid) return;
    // delta < 0 scrolls up into history (increases scrollOffset)
    const next = this.scrollOffset - delta;
    this.scrollOffset = Math.max(0, Math.min(this.scrollback.length, next));
  }

  resetScroll() {
    this.scrollOffset = 0;
  }

  resize(newCols, newRows) {
    const cols = Math.max(10, newCols);
    const rows = Math.max(4, newRows);
    if (cols === this.cols && rows === this.rows) return;

    // Preserve top lines into scrollback if main screen shrinks below cursorRow
    let shiftUp = 0;
    if (!this.altGrid && rows < this.rows && this.cursorRow >= rows) {
      shiftUp = Math.min(this.grid.length - rows, this.cursorRow - rows + 1);
      for (let i = 0; i < shiftUp; i++) {
        this.scrollback.push(this.grid[i]);
      }
      if (this.scrollback.length > this.maxScrollback) {
        this.scrollback.splice(0, this.scrollback.length - this.maxScrollback);
      }
    }

    const copyGrid = (oldGrid, rowStart = 0) => {
      const next = makeGrid(cols, rows);
      const copyR = Math.min(oldGrid.length - rowStart, rows);
      for (let r = 0; r < copyR; r++) {
        const copyC = Math.min(oldGrid[r + rowStart].length, cols);
        for (let c = 0; c < copyC; c++) {
          next[r][c] = { ...oldGrid[r + rowStart][c] };
        }
      }
      return next;
    };

    this.grid = copyGrid(this.grid, shiftUp);
    if (this.altGrid) this.altGrid = copyGrid(this.altGrid, 0);
    this.cols = cols;
    this.rows = rows;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.cursorRow = Math.max(0, Math.min(rows - 1, this.cursorRow - shiftUp));
    this.cursorCol = Math.max(0, Math.min(cols - 1, this.cursorCol));
    this.scrollOffset = Math.max(0, Math.min(this.scrollback.length, this.scrollOffset));
  }

  write(data) {
    const str = this._escBuf + (typeof data === 'string' ? data : data.toString('utf8'));
    this._escBuf = '';
    let i = 0;

    while (i < str.length) {
      const ch = str[i];

      if (ch === '\x1b') {
        const rem = str.length - i;
        if (rem === 1) {
          this._escBuf = '\x1b';
          break;
        }
        const nextCh = str[i + 1];
        if (nextCh === '[') {
          CSI_STICKY_RE.lastIndex = i;
          const csi = CSI_STICKY_RE.exec(str);
          if (!csi) {
            if (rem < 32) {
              this._escBuf = str.slice(i);
              break;
            }
            i += 2;
            continue;
          }
          this._handleCsi(csi[1]);
          i += csi[0].length;
          continue;
        }
        if (nextCh === ']') {
          const bel = str.indexOf('\x07', i + 2);
          const st = str.indexOf('\x1b\\', i + 2);
          let end = -1;
          let step = 0;
          if (bel >= 0 && (st < 0 || bel < st)) {
            end = bel;
            step = 1;
          } else if (st >= 0) {
            end = st;
            step = 2;
          }
          if (end < 0) {
            if (rem < 1024 * 1024) {
              this._escBuf = str.slice(i);
              break;
            }
            i += 2;
            continue;
          }
          const oscSeq = str.slice(i, end + step);
          if (this.onOsc && oscSeq.startsWith('\x1b]52;')) {
            this.onOsc(oscSeq);
          }
          i = end + step;
          continue;
        }
        if (nextCh === '(' || nextCh === ')' || nextCh === '*' || nextCh === '+') {
          if (rem < 3) {
            this._escBuf = str.slice(i);
            break;
          }
          i += 3;
          continue;
        }
        if (nextCh === '7') {
          this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
          i += 2;
          continue;
        }
        if (nextCh === '8') {
          this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.savedCursor.row));
          this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.savedCursor.col));
          i += 2;
          continue;
        }
        if (nextCh === 'M') {
          // Reverse index
          if (this.cursorRow === this.scrollTop) {
            this._scrollDown(1);
          } else if (this.cursorRow > 0) {
            this.cursorRow -= 1;
          }
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === '\r') {
        this.cursorCol = 0;
        i += 1;
        continue;
      }
      if (ch === '\n' || ch === '\v' || ch === '\f') {
        this._lineFeed();
        i += 1;
        continue;
      }
      if (ch === '\b') {
        if (this.cursorCol > 0) this.cursorCol -= 1;
        i += 1;
        continue;
      }
      if (ch === '\t') {
        const nextTab = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        this.cursorCol = nextTab;
        i += 1;
        continue;
      }
      if (ch.charCodeAt(0) < 32) {
        i += 1;
        continue;
      }

      const cp = str.codePointAt(i);
      if (cp >= 0x20 && cp <= 0x7e) {
        this._putChar(ch, 1);
        i += 1;
        continue;
      }
      const fullCh = String.fromCodePoint(cp);
      const w = Math.max(1, charWidth(cp));
      this._putChar(fullCh, w);
      i += fullCh.length;
    }
  }

  _putChar(ch, w) {
    if (this.cursorCol >= this.cols || (w === 2 && this.cursorCol >= this.cols - 1)) {
      this.cursorCol = 0;
      this._lineFeed();
    }
    const row = this.grid[this.cursorRow];
    if (!row) return;
    const cell = row[this.cursorCol];
    if (cell) {
      cell.ch = ch;
      cell.style = this.currentStyle;
      cell.wide = w === 2;
      cell.cont = false;
    } else {
      row[this.cursorCol] = { ch, style: this.currentStyle, wide: w === 2, cont: false };
    }
    if (w === 2 && this.cursorCol + 1 < this.cols) {
      const next = row[this.cursorCol + 1];
      if (next) {
        next.ch = '';
        next.style = this.currentStyle;
        next.wide = false;
        next.cont = true;
      } else {
        row[this.cursorCol + 1] = { ch: '', style: this.currentStyle, wide: false, cont: true };
      }
    }
    row._dirty = true;
    this.cursorCol += w;
  }

  _lineFeed() {
    if (this.cursorRow >= this.scrollBottom) {
      this._scrollUp(1);
      this.cursorRow = this.scrollBottom;
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow += 1;
    }
  }

  _scrollUp(n = 1) {
    const count = Math.min(Math.max(0, n), this.rows);
    const saveHistory = !this.altGrid && this.scrollTop === 0 && this.scrollBottom === this.rows - 1;
    for (let k = 0; k < count; k++) {
      const removed = this.grid.splice(this.scrollTop, 1);
      if (saveHistory && removed[0]) {
        this.scrollback.push(removed[0]);
        if (this.scrollback.length > this.maxScrollback) {
          this.scrollback.shift();
        }
        if (this.scrollOffset > 0) {
          this.scrollOffset = Math.min(this.scrollback.length, this.scrollOffset + 1);
        }
      }
      this.grid.splice(this.scrollBottom, 0, makeRow(this.cols));
    }
  }

  _scrollDown(n = 1) {
    const count = Math.min(Math.max(0, n), this.rows);
    for (let k = 0; k < count; k++) {
      this.grid.splice(this.scrollBottom, 1);
      this.grid.splice(this.scrollTop, 0, makeRow(this.cols));
    }
  }

  _clearRow(r, fromCol = 0, toCol = this.cols - 1) {
    const row = this.grid[r];
    if (!row) return;
    const start = Math.max(0, fromCol);
    const end = Math.min(this.cols - 1, toCol);
    for (let c = start; c <= end; c++) {
      const cell = row[c];
      if (cell) {
        cell.ch = ' ';
        cell.style = '';
        cell.wide = false;
        cell.cont = false;
      } else {
        row[c] = emptyCell();
      }
    }
    row._dirty = true;
  }

  _handleCsi(seq) {
    const final = seq[seq.length - 1];
    const body = seq.slice(0, -1);
    const isPrivate = /^[?><=!]/.test(body);
    const rawParams = isPrivate ? body.slice(1) : body;
    const params = rawParams ? rawParams.split(';').map((s) => (s === '' ? 0 : Number(s))) : [];
    const p1 = params[0] || 0;
    const p2 = params[1] || 0;

    if (isPrivate) {
      if (body.startsWith('?') && (final === 'h' || final === 'l')) {
        const enable = final === 'h';
        for (const p of params) {
          if (p === 25) this.cursorVisible = enable;
          else if (p === 2004) this.bracketedPaste = enable;
          else if (p === 1000 || p === 1002 || p === 1003) {
            if (enable) this.mouseModes.add(p);
            else this.mouseModes.delete(p);
          } else if (p === 1049 || p === 47) {
            if (enable && !this.savedMain) {
              this.savedMain = {
                grid: this.grid,
                cursorRow: this.cursorRow,
                cursorCol: this.cursorCol,
              };
              this.grid = makeGrid(this.cols, this.rows);
              this.cursorRow = 0;
              this.cursorCol = 0;
            } else if (!enable && this.savedMain) {
              this.grid = this.savedMain.grid;
              this.cursorRow = Math.min(this.rows - 1, this.savedMain.cursorRow);
              this.cursorCol = Math.min(this.cols - 1, this.savedMain.cursorCol);
              this.savedMain = null;
            }
          }
        }
      }
      return;
    }

    switch (final) {
      case 'A':
        this.cursorRow = Math.max(this.scrollTop, this.cursorRow - (p1 || 1));
        break;
      case 'B':
        this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + (p1 || 1));
        break;
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (p1 || 1));
        break;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - (p1 || 1));
        break;
      case 'E':
        this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + (p1 || 1));
        this.cursorCol = 0;
        break;
      case 'F':
        this.cursorRow = Math.max(this.scrollTop, this.cursorRow - (p1 || 1));
        this.cursorCol = 0;
        break;
      case 'G':
      case '`':
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (p1 || 1) - 1));
        break;
      case 'd':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1));
        break;
      case 'H':
      case 'f':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, (p2 || 1) - 1));
        break;
      case 'J': {
        const mode = p1 || 0;
        if (mode === 0) {
          this._clearRow(this.cursorRow, this.cursorCol, this.cols - 1);
          for (let r = this.cursorRow + 1; r < this.rows; r++) this._clearRow(r);
        } else if (mode === 1) {
          for (let r = 0; r < this.cursorRow; r++) this._clearRow(r);
          this._clearRow(this.cursorRow, 0, this.cursorCol);
        } else {
          for (let r = 0; r < this.rows; r++) this._clearRow(r);
        }
        break;
      }
      case 'K': {
        const mode = p1 || 0;
        if (mode === 0) this._clearRow(this.cursorRow, this.cursorCol, this.cols - 1);
        else if (mode === 1) this._clearRow(this.cursorRow, 0, this.cursorCol);
        else this._clearRow(this.cursorRow);
        break;
      }
      case 'L': {
        const count = Math.min(this.scrollBottom - this.cursorRow + 1, p1 || 1);
        for (let k = 0; k < count; k++) {
          this.grid.splice(this.scrollBottom, 1);
          this.grid.splice(this.cursorRow, 0, makeRow(this.cols));
        }
        break;
      }
      case 'M': {
        const count = Math.min(this.scrollBottom - this.cursorRow + 1, p1 || 1);
        for (let k = 0; k < count; k++) {
          this.grid.splice(this.cursorRow, 1);
          this.grid.splice(this.scrollBottom, 0, makeRow(this.cols));
        }
        break;
      }
      case 'P': {
        const row = this.grid[this.cursorRow];
        const count = Math.min(this.cols - this.cursorCol, p1 || 1);
        row.splice(this.cursorCol, count);
        for (let k = 0; k < count; k++) row.push(emptyCell());
        row._dirty = true;
        break;
      }
      case '@': {
        const row = this.grid[this.cursorRow];
        const count = Math.min(this.cols - this.cursorCol, p1 || 1);
        for (let k = 0; k < count; k++) {
          row.splice(this.cursorCol, 0, emptyCell());
          row.pop();
        }
        row._dirty = true;
        break;
      }
      case 'X': {
        const count = p1 || 1;
        this._clearRow(this.cursorRow, this.cursorCol, this.cursorCol + count - 1);
        break;
      }
      case 'S':
        this._scrollUp(p1 || 1);
        break;
      case 'T':
        this._scrollDown(p1 || 1);
        break;
      case 'r':
        this.scrollTop = Math.max(0, (p1 || 1) - 1);
        this.scrollBottom = Math.min(this.rows - 1, (p2 || this.rows) - 1);
        if (this.scrollTop > this.scrollBottom) {
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        this.cursorRow = 0;
        this.cursorCol = 0;
        break;
      case 's':
        this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
        break;
      case 'u':
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.savedCursor.row));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.savedCursor.col));
        break;
      case 'n':
        if (this.onResponse) {
          if (p1 === 6) this.onResponse(`\x1b[${this.cursorRow + 1};${this.cursorCol + 1}R`);
          else if (p1 === 5) this.onResponse('\x1b[0n');
        }
        break;
      case 'c':
        if (this.onResponse && (p1 === 0 || !rawParams)) {
          this.onResponse('\x1b[?1;2c');
        }
        break;
      case 'm':
        this._applySgr(params);
        break;
    }
  }

  _applySgr(params) {
    const sgr = this._sgr;
    if (params.length === 0) {
      sgr.attrs.clear();
      sgr.fg = '';
      sgr.bg = '';
      this.currentStyle = '';
      return;
    }
    for (let idx = 0; idx < params.length; idx++) {
      const p = params[idx];
      if (p === 0) {
        sgr.attrs.clear();
        sgr.fg = '';
        sgr.bg = '';
      } else if (p >= 1 && p <= 9) {
        sgr.attrs.add(p);
      } else if (p === 21 || p === 22) {
        sgr.attrs.delete(1);
        sgr.attrs.delete(2);
      } else if (p === 23) {
        sgr.attrs.delete(3);
      } else if (p === 24) {
        sgr.attrs.delete(4);
      } else if (p === 25) {
        sgr.attrs.delete(5);
      } else if (p === 27) {
        sgr.attrs.delete(7);
      } else if (p === 28) {
        sgr.attrs.delete(8);
      } else if (p === 29) {
        sgr.attrs.delete(9);
      } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        sgr.fg = String(p);
      } else if (p === 39) {
        sgr.fg = '';
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        sgr.bg = String(p);
      } else if (p === 49) {
        sgr.bg = '';
      } else if (p === 38) {
        const mode = params[idx + 1];
        if (mode === 5 && idx + 2 < params.length) {
          sgr.fg = `38;5;${params[idx + 2]}`;
          idx += 2;
        } else if (mode === 2 && idx + 4 < params.length) {
          sgr.fg = `38;2;${params[idx + 2]};${params[idx + 3]};${params[idx + 4]}`;
          idx += 4;
        }
      } else if (p === 48) {
        const mode = params[idx + 1];
        if (mode === 5 && idx + 2 < params.length) {
          sgr.bg = `48;5;${params[idx + 2]}`;
          idx += 2;
        } else if (mode === 2 && idx + 4 < params.length) {
          sgr.bg = `48;2;${params[idx + 2]};${params[idx + 3]};${params[idx + 4]}`;
          idx += 4;
        }
      }
    }
    const parts = [];
    for (const a of sgr.attrs) parts.push(a);
    if (sgr.fg) parts.push(sgr.fg);
    if (sgr.bg) parts.push(sgr.bg);
    this.currentStyle = parts.length > 0 ? `\x1b[${parts.join(';')}m` : '';
  }

  renderTo(scr, startRow, viewCols = this.cols, viewRows = this.rows) {
    const rCount = Math.min(this.rows, viewRows);
    const cCount = Math.min(this.cols, viewCols);
    const useScrollback = !this.altGrid && this.scrollOffset > 0 && this.scrollback.length > 0;
    const totalHistory = this.scrollback.length;
    const endIdx = totalHistory + this.rows - Math.min(totalHistory, this.scrollOffset);
    const startIdx = Math.max(0, endIdx - rCount);

    for (let r = 0; r < rCount; r++) {
      const row = useScrollback
        ? startIdx + r < totalHistory
          ? this.scrollback[startIdx + r]
          : this.grid[startIdx + r - totalHistory]
        : this.grid[r];
      if (!row) continue;
      if (!useScrollback && !row._dirty && row._renderedCols === cCount && row._rendered !== null) {
        scr.writeAt(1, startRow + r, row._rendered);
        continue;
      }
      const rowCols = Math.min(cCount, row.length);
      let lastNonEmpty = -1;
      for (let c = rowCols - 1; c >= 0; c--) {
        const cell = row[c];
        if (cell.ch !== ' ' || cell.style !== '' || cell.cont) {
          lastNonEmpty = c;
          break;
        }
      }
      let out = '';
      let activeStyle = '';
      for (let c = 0; c <= lastNonEmpty; c++) {
        const cell = row[c];
        if (cell.cont) continue;
        if (cell.style !== activeStyle) {
          out += cell.style ? `\x1b[0m${cell.style}` : '\x1b[0m';
          activeStyle = cell.style;
        }
        out += cell.ch;
      }
      if (activeStyle) out += '\x1b[0m';
      if (lastNonEmpty < cCount - 1) out += '\x1b[K';
      if (!useScrollback) {
        row._rendered = out;
        row._renderedCols = cCount;
        row._dirty = false;
      }
      scr.writeAt(1, startRow + r, out);
    }

    if (this.cursorVisible && !useScrollback) {
      const cx = Math.max(1, Math.min(viewCols, this.cursorCol + 1));
      const cy = Math.max(startRow, Math.min(startRow + viewRows - 1, startRow + this.cursorRow));
      scr.setCursor(cx, cy);
    }
  }
}
