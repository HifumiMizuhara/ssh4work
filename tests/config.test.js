import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, parseSshConfig } from '../src/config.js';

test('ConfigStore CRUD, pin, and lastDir persistence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-test-'));
  const cfgPath = path.join(tmpDir, 'profiles.json');

  try {
    const store = new ConfigStore(cfgPath);
    store.load();
    assert.equal(store.list().length, 0);

    const p = store.upsert({
      name: 'Prod-VPS',
      host: '203.0.113.10',
      port: 22,
      user: 'ubuntu',
    });
    assert.equal(store.list().length, 1);
    assert.equal(store.data.activeProfileId, p.id);

    assert.equal(store.togglePinDir(p.id, '/home/ubuntu/app'), true);
    assert.equal(store.getById(p.id).pinnedDirs.includes('/home/ubuntu/app'), true);
    assert.equal(store.togglePinDir(p.id, '/home/ubuntu/app'), false);

    store.updateLastDir(p.id, '/home/ubuntu/work');
    const q = store.upsertQuickCommand(p.id, { name: '查看容器', command: 'docker ps' });
    assert.ok(q?.id);

    const reloaded = new ConfigStore(cfgPath);
    reloaded.load();
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.getById(p.id).lastDir, '/home/ubuntu/work');
    assert.equal(reloaded.getById(p.id).quickCommands.length, 1);
    assert.equal(reloaded.getById(p.id).quickCommands[0].command, 'docker ps');
    assert.equal(reloaded.removeQuickCommand(p.id, q.id), true);
    assert.equal(reloaded.getById(p.id).quickCommands.length, 0);

    assert.equal(reloaded.remove(p.id), true);
    assert.equal(reloaded.list().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseSshConfig extracts hosts and skips wildcards', () => {
  const sshCfg = `
Host *
  ServerAliveInterval 60

Host prod-vps
  HostName 1.2.3.4
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/prod.pem
`;
  const list = parseSshConfig(sshCfg);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'prod-vps');
  assert.equal(list[0].host, '1.2.3.4');
  assert.equal(list[0].port, 2222);
  assert.equal(list[0].user, 'ubuntu');
  assert.ok(list[0].identityFile.endsWith('prod.pem'));
});
