import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Parse a single ANSI/UTF-8 input buffer into an array of key & mouse/touch events.
 */
export function parseInputEvents(buf) {
  const str = typeof buf === 'string' ? buf : buf.toString('utf8');
  const events = [];
  let i = 0;

  while (i < str.length) {
    const rest = str.slice(i);

    // Bracketed paste sequence: \x1b[200~ ... \x1b[201~
    if (rest.startsWith('\x1b[200~')) {
      const endIdx = rest.indexOf('\x1b[201~', 6);
      if (endIdx >= 0) {
        const pasted = rest
          .slice(6, endIdx)
          .replace(/[\r\n]+/g, ' ')
          .replace(/[\x00-\x1f\x7f]/g, '');
        if (pasted) {
          events.push({ type: 'key', name: 'paste', char: pasted, ctrl: false, raw: pasted });
        }
        i += endIdx + 6;
        continue;
      }
    }

    // SGR mouse / touch sequence: \x1b[<b;x;yM or m
    const m = rest.match(SGR_MOUSE_RE);
    if (m) {
      const code = Number(m[1]);
      const x = Number(m[2]); // 1-based column
      const y = Number(m[3]); // 1-based row
      const suffix = m[4];
      const isWheel = (code & 64) !== 0;
      const isDrag = (code & 32) !== 0;
      const button = code & 3;

      if (isWheel) {
        events.push({
          type: 'mouse',
          action: (code & 1) === 0 ? 'wheelUp' : 'wheelDown',
          x,
          y,
          button,
          code,
          suffix,
        });
      } else if (isDrag) {
        events.push({
          type: 'mouse',
          action: button === 3 ? 'move' : 'drag',
          x,
          y,
          button,
          code,
          suffix,
        });
      } else if (suffix === 'M') {
        events.push({ type: 'mouse', action: 'down', x, y, button, code, suffix });
      } else {
        events.push({ type: 'mouse', action: 'up', x, y, button, code, suffix });
      }
      i += m[0].length;
      continue;
    }

    // CSI / SS3 sequences
    if (rest.startsWith('\x1b[')) {
      const csi = rest.match(/^\x1b\[([0-9;]*[A-Za-z~])/);
      if (csi) {
        const seq = csi[1];
        const map = {
          A: 'up',
          B: 'down',
          C: 'right',
          D: 'left',
          H: 'home',
          F: 'end',
          '1~': 'home',
          '4~': 'end',
          '5~': 'pageup',
          '6~': 'pagedown',
          '3~': 'delete',
          '11~': 'f1',
          '12~': 'f2',
          '13~': 'f3',
          '14~': 'f4',
          '15~': 'f5',
          '17~': 'f6',
          '18~': 'f7',
          '19~': 'f8',
          '20~': 'f9',
          '21~': 'f10',
          Z: 'shift-tab',
        };
        const csiU = seq.match(/^(\d+)(?:;(\d+))?u$/);
        let name = map[seq] || seq;
        if (csiU) {
          const cp = Number(csiU[1]);
          if (cp === 127 || cp === 8) name = 'backspace';
          else if (cp === 13) name = 'enter';
          else if (cp === 27) name = 'escape';
          else if (cp === 9) name = Number(csiU[2]) === 2 ? 'shift-tab' : 'tab';
        } else if (/^3;\d+~$/.test(seq)) {
          name = 'delete';
        }
        events.push({ type: 'key', name, char: '', ctrl: false, raw: csi[0] });
        i += csi[0].length;
        continue;
      }
    }

    if (rest.startsWith('\x1b\x7f') || rest.startsWith('\x1b\b')) {
      events.push({ type: 'key', name: 'backspace', char: '', ctrl: false, raw: rest.slice(0, 2) });
      i += 2;
      continue;
    }

    if (rest.startsWith('\x1bO')) {
      const ss3 = rest.match(/^\x1bO([PQRS])/);
      if (ss3) {
        const fmap = { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
        events.push({ type: 'key', name: fmap[ss3[1]], char: '', ctrl: false, raw: ss3[0] });
        i += ss3[0].length;
        continue;
      }
    }

    const ch = str[i];
    const code = ch.charCodeAt(0);

    if (ch === '\x1b' && i + 1 < str.length) {
      const next = str[i + 1];
      const nextCode = next.charCodeAt(0);
      if (next !== '[' && next !== 'O' && next !== '\x1b' && nextCode >= 32 && nextCode < 127) {
        events.push({
          type: 'key',
          name: next.toLowerCase(),
          char: next,
          ctrl: false,
          alt: true,
          raw: str.slice(i, i + 2),
        });
        i += 2;
        continue;
      }
    }

    if (ch === '\x1b') {
      events.push({ type: 'key', name: 'escape', char: '', ctrl: false, raw: ch });
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      events.push({ type: 'key', name: 'enter', char: '', ctrl: false, raw: ch });
      i += 1;
    } else if (ch === '\t') {
      events.push({ type: 'key', name: 'tab', char: '', ctrl: false, raw: ch });
      i += 1;
    } else if (ch === '\x7f' || ch === '\b') {
      events.push({ type: 'key', name: 'backspace', char: '', ctrl: false, raw: ch });
      i += 1;
    } else if (ch === ' ') {
      events.push({ type: 'key', name: 'space', char: ' ', ctrl: false, raw: ch });
      i += 1;
    } else if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96);
      events.push({ type: 'key', name: letter, char: '', ctrl: true, raw: ch });
      i += 1;
    } else {
      // Handle surrogate pairs (emoji, etc.) cleanly
      const cp = str.codePointAt(i);
      const fullCh = String.fromCodePoint(cp);
      events.push({ type: 'key', name: fullCh, char: fullCh, ctrl: false, raw: fullCh });
      i += fullCh.length;
    }
  }

  return events;
}

export class TerminalController extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this._decoder = new StringDecoder('utf8');
    this._onData = this._handleData.bind(this);
    this._onResize = () => this.emit('resize', this.getSize());
    this._onExit = () => this.leave();
    this._onSignal = (sig) => {
      this.leave();
      process.exit(sig === 'SIGHUP' ? 129 : 143);
    };
    this._dragState = null;
    this._mouseTracking = false;
  }

  getSize() {
    return {
      cols: process.stdout.columns || 100,
      rows: process.stdout.rows || 30,
    };
  }

  setMouseTracking(enabled) {
    const want = Boolean(enabled);
    if (!this.active || this._mouseTracking === want) return;
    this._mouseTracking = want;
    if (want) {
      process.stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
    } else {
      process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
    }
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this._mouseTracking = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', this._onData);
    process.stdout.on('resize', this._onResize);
    process.on('exit', this._onExit);
    process.on('SIGTERM', this._onSignal);
    if (process.platform !== 'win32') process.on('SIGHUP', this._onSignal);

    // Alt screen + hide cursor + bracketed paste + enable SGR mouse & hover/drag
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this._mouseTracking = false;
    process.stdin.off('data', this._onData);
    process.stdout.off('resize', this._onResize);
    process.off('exit', this._onExit);
    process.off('SIGTERM', this._onSignal);
    process.off('SIGHUP', this._onSignal);

    // Disable mouse tracking & bracketed paste + restore cursor + leave alt screen + reset SGR
    process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[?1049l\x1b[0m');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  /**
   * Temporarily suspend TUI mode so `ssh -t` can own the terminal.
   */
  suspendForChild(fn) {
    this.leave();
    try {
      return fn();
    } finally {
      this.enter();
    }
  }

  /**
   * Async variant of suspendForChild: keeps the Node event loop alive while the child owns the TTY.
   */
  async suspendForChildAsync(fn) {
    this.leave();
    try {
      return await fn();
    } finally {
      this.enter();
    }
  }

  _handleData(chunk) {
    const text = Buffer.isBuffer(chunk) ? this._decoder.write(chunk) : String(chunk);
    if (!text) return;
    const events = parseInputEvents(text);
    for (const ev of events) {
      if (ev.type === 'key') {
        this.emit('key', ev);
      } else if (ev.type === 'mouse') {
        this._handleMouse(ev);
      }
    }
  }

  _handleMouse(ev) {
    this.emit('mouseRaw', ev);
    if (ev.action === 'wheelUp' || ev.action === 'wheelDown') {
      this.emit('wheel', ev.action === 'wheelUp' ? -1 : 1, ev);
      return;
    }

    if (ev.action === 'down' && ev.button === 0) {
      this._dragState = {
        startX: ev.x,
        startY: ev.y,
        lastY: ev.y,
        swiped: false,
        selecting: false,
      };
      return;
    }

    if (ev.action === 'drag' && this._dragState) {
      if (Math.abs(ev.x - this._dragState.startX) >= 2) {
        this._dragState.selecting = true;
      }
      if (this._dragState.selecting) return;
      const dy = ev.y - this._dragState.lastY;
      if (Math.abs(ev.y - this._dragState.startY) >= 1 && dy !== 0) {
        this._dragState.swiped = true;
        this._dragState.lastY = ev.y;
        // Natural touch swipe: dragging finger up (dy < 0) scrolls content down (+1)
        this.emit('swipe', dy < 0 ? 1 : -1, ev);
      }
      return;
    }

    if (ev.action === 'up') {
      const st = this._dragState;
      this._dragState = null;
      if (st && !st.swiped && !st.selecting) {
        this.emit('tap', { x: ev.x, y: ev.y });
      }
    }
  }
}
