import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClipboardEnvAndTrap, normalizePrivateKey, savePrivateKeyFile, scanPrivateKeys } from '../src/clipboard.js';
import { buildClaudeLaunchCommand, buildQuickLaunchCommand, validateDirName } from '../src/remote.js';
import { buildSshArgs, quoteSh, splitArgs } from '../src/ssh.js';

test('quoteSh and validateDirName handle edge cases safely', () => {
  assert.equal(quoteSh("a'b"), "'a'\\''b'");
  assert.equal(validateDirName('my-app'), null);
  assert.ok(validateDirName('a/b'));
  assert.ok(validateDirName('..'));
  assert.ok(validateDirName(''));
});

test('buildSshArgs and buildClaudeLaunchCommand construct expected commands', () => {
  assert.deepEqual(splitArgs('-o "ForwardAgent=yes" -F ~/.ssh/custom'), [
    '-o',
    'ForwardAgent=yes',
    '-F',
    '~/.ssh/custom',
  ]);

  const args = buildSshArgs(
    {
      host: '203.0.113.10',
      port: 2222,
      user: 'ubuntu',
      identityFile: 'C:\\keys\\id.pem',
      proxyJump: 'bastion@10.0.0.1',
      extraSshArgs: '-o ForwardAgent=yes',
    },
    { settings: { connectTimeoutSec: 15, serverAliveIntervalSec: 45 } }
  );
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('2222'));
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('-J'));
  assert.ok(args.includes('bastion@10.0.0.1'));
  assert.ok(args.includes('ForwardAgent=yes'));
  assert.ok(args.includes('Compression=yes'));
  assert.ok(args.includes('ConnectTimeout=15'));
  assert.ok(args.includes('ubuntu@203.0.113.10'));

  const newCmd = buildClaudeLaunchCommand('/home/ubuntu/my app', {
    mode: 'new',
    shell: 'zsh',
    preCommand: 'nvm use 20',
  });
  assert.ok(newCmd.includes("cd '/home/ubuntu/my app'"));
  assert.ok(newCmd.includes("exec 'zsh' -lic 'nvm use 20; claude'"));

  const resumeCmd = buildClaudeLaunchCommand('/home/ubuntu/app', {
    mode: 'resume',
    sessionId: 'abc-123',
    fork: true,
  });
  assert.ok(resumeCmd.includes('--resume'));
  assert.ok(resumeCmd.includes('abc-123'));
  assert.ok(resumeCmd.includes('--fork-session'));

  const clipSnippet = buildClipboardEnvAndTrap('tok123');
  assert.ok(clipSnippet.includes('base64 -d'));
  const b64 = clipSnippet.match(/printf '%s' '([^']+)'/)[1];
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  assert.ok(decoded.includes('CLIP_DIR/bin/xclip'));
  assert.ok(decoded.includes('CLIP_DIR/bin/wl-paste'));
  assert.equal(decoded.includes('System.Windows.Forms'), false);

  const clipCmd = buildClaudeLaunchCommand('/home/ubuntu/app', {
    mode: 'new',
    clipboardToken: 'tok123',
  });
  assert.ok(clipCmd.includes('base64 -d'));
  assert.ok(!clipCmd.includes('exec '));

  assert.equal(buildQuickLaunchCommand(''), '');
  const quickCmd = buildQuickLaunchCommand('docker ps', { dirPath: '/srv/app', shell: 'bash' });
  assert.ok(quickCmd.includes("cd '/srv/app'"));
  assert.ok(quickCmd.includes("exec 'bash' -lic 'docker ps'"));
});

test('normalizePrivateKey and savePrivateKeyFile validate and write LF key', () => {
  assert.equal(normalizePrivateKey('not a key').ok, false);
  const sample = '-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc123\r\n-----END OPENSSH PRIVATE KEY-----\r\n';
  const norm = normalizePrivateKey(sample);
  assert.equal(norm.ok, true);
  assert.equal(norm.content.includes('\r'), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-key-'));
  try {
    assert.equal(savePrivateKeyFile(tmpDir, '../bad.pem', sample).ok, false);
    const saved = savePrivateKeyFile(tmpDir, 'test.pem', sample);
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(saved.path, 'utf8'), norm.content);

    fs.mkdirSync(path.join(tmpDir, 'keys'));
    fs.writeFileSync(path.join(tmpDir, 'keys', 'prod_ed25519'), sample, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'keys', 'prod_ed25519.pub'), 'ssh-ed25519 AAAA', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'ignored.pem'), sample, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello world', 'utf8');

    assert.deepEqual(scanPrivateKeys(tmpDir), ['test.pem', 'keys/prod_ed25519']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
