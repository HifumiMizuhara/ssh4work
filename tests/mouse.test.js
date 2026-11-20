import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputEvents } from '../src/tui/terminal.js';
import { ScreenBuffer } from '../src/tui/renderer.js';
import { VirtualTerminal } from '../src/tui/vterm.js';

test('parseInputEvents parses SGR mouse tap, drag, wheel, and keys', () => {
  const evs = parseInputEvents('\x1b[<0;12;5M\x1b[<0;12;5m\x1b[<64;10;10M\x1b[A\x1bOQ中文');
  assert.equal(evs[0].type, 'mouse');
  assert.equal(evs[0].action, 'down');
  assert.equal(evs[0].x, 12);
  assert.equal(evs[0].y, 5);

  assert.equal(evs[1].action, 'up');
  assert.equal(evs[2].action, 'wheelUp');
  assert.equal(evs[3].name, 'up');
  assert.equal(evs[4].name, 'f2');
  assert.equal(evs[5].char, '中');
  assert.equal(evs[6].char, '文');
});

test('ScreenBuffer.hitTest returns topmost matching hitbox', () => {
  const scr = new ScreenBuffer(80, 24);
  scr.begin();
  scr.addHitBox(1, 5, 80, 5, 'selectFile', 0);
  scr.addHitBox(10, 4, 40, 8, 'modalSubmit', null);

  const hit = scr.hitTest(15, 5);
  assert.equal(hit.action, 'modalSubmit');

  const miss = scr.hitTest(2, 5);
  assert.equal(miss.action, 'selectFile');
});

test('parseInputEvents handles CSI-u backspace and alt-backspace', () => {
  const evs = parseInputEvents('\x1b[127;1u\x1b[8;1u\x1b\x7f\x1b[3;2~');
  assert.equal(evs[0].name, 'backspace');
  assert.equal(evs[1].name, 'backspace');
  assert.equal(evs[2].name, 'backspace');
  assert.equal(evs[3].name, 'delete');
});

test('parseInputEvents handles bracketed paste without triggering enter', () => {
  const evs = parseInputEvents('\x1b[200~docker ps\r\n-a\x1b[201~');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].name, 'paste');
  assert.equal(evs[0].char, 'docker ps -a');
});

test('ScreenBuffer.flush diffs unchanged rows and avoids bottom-right wrap', () => {
  const writes = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const s1 = new ScreenBuffer(20, 4);
    s1.begin({ clear: false });
    s1.drawLine(1, 'header');
    s1.drawLine(2, 'row-2');
    s1.drawLine(4, 'status-line-text');
    s1.flush();

    assert.equal(writes.length, 1);
    assert.ok(writes[0].includes('\x1b[K'));

    // Identical frame should produce 0 stdout writes
    const s2 = new ScreenBuffer(20, 4);
    s2.begin({ clear: false });
    s2.drawLine(1, 'header');
    s2.drawLine(2, 'row-2');
    s2.drawLine(4, 'status-line-text');
    s2.flush({ prevScreen: s1 });
    assert.equal(writes.length, 1);

    // Changing only row 2 should only emit row 2
    const s3 = new ScreenBuffer(20, 4);
    s3.begin({ clear: false });
    s3.drawLine(1, 'header');
    s3.drawLine(2, 'row-2-updated');
    s3.drawLine(4, 'status-line-text');
    s3.flush({ prevScreen: s2 });
    assert.equal(writes.length, 2);
    assert.ok(writes[1].includes('row-2-updated'));
    assert.ok(!writes[1].includes('header'));
    // Lazy grid should still extract text accurately on demand
    assert.equal(s3.extractText(1, 2, 20, 2), 'row-2-updated');
  } finally {
    process.stdout.write = origWrite;
  }
});

test('VirtualTerminal bounds SGR style accumulation and caches clean rows', () => {
  const vt = new VirtualTerminal(30, 5);
  vt.write('\x1b[31m\x1b[38;5;196m\x1b[32mHi\x1b[39m');
  assert.equal(vt.grid[0][0].style, '\x1b[32m');
  assert.equal(vt.currentStyle, '');

  const scr1 = new ScreenBuffer(30, 5);
  scr1.begin({ clear: false });
  vt.renderTo(scr1, 1, 30, 5);
  assert.equal(vt.grid[0]._dirty, false);
  assert.equal(vt.grid[1]._dirty, false);

  vt.write('\r\nNext');
  assert.equal(vt.grid[0]._dirty, false);
  assert.equal(vt.grid[1]._dirty, true);
});
