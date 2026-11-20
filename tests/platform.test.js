import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { buildClipboardEnvAndTrap, parseOsascriptPng } from '../src/clipboard.js';
import { createDefaultSettings } from '../src/config.js';
import { buildSshArgs } from '../src/ssh.js';

test('image clipboard sync is enabled by default on every platform', () => {
  assert.equal(createDefaultSettings().enableImageClipboard, true);
  assert.equal(createDefaultSettings({ enableImageClipboard: false }).enableImageClipboard, false);
});

test('parseOsascriptPng decodes macOS «data PNGf…» clipboard output', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const out = `«data PNGf${png.toString('hex').toUpperCase()}»\n`;
  assert.deepEqual(parseOsascriptPng(out), png);
  assert.equal(parseOsascriptPng(''), null);
  assert.equal(parseOsascriptPng('some text'), null);
});

test('buildSshArgs expands ~ in identityFile for POSIX shells-free spawn', () => {
  const args = buildSshArgs({ host: 'example.com', identityFile: '~/.ssh/id_ed25519' });
  const keyArg = args[args.indexOf('-i') + 1];
  assert.ok(keyArg.startsWith(os.homedir()));
  assert.ok(keyArg.endsWith('id_ed25519'));
});

test('clipboard shim wrapper falls back to BSD base64 -D on macOS hosts', () => {
  const snippet = buildClipboardEnvAndTrap('tok');
  assert.ok(snippet.includes('base64 -d 2>/dev/null'));
  assert.ok(snippet.includes('base64 -D'));
});
