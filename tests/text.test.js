import test from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, padEndWidth, stripAnsi, truncateToWidth } from '../src/utils/text.js';

test('displayWidth handles ASCII, CJK, and ANSI escapes', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('中文测试'), 8);
  assert.equal(displayWidth('VPS列表'), 7);
  assert.equal(stripAnsi('\x1b[32mhello\x1b[0m'), 'hello');
  assert.equal(displayWidth('\x1b[36m目录\x1b[0m'), 4);
});

test('truncateToWidth and padEndWidth respect CJK widths', () => {
  assert.equal(truncateToWidth('abcdef', 4), 'abc…');
  assert.equal(truncateToWidth('中文目录浏览', 6), '中文…');
  assert.equal(displayWidth(padEndWidth('目录', 8)), 8);
  assert.equal(padEndWidth('abc', 5), 'abc  ');
});
