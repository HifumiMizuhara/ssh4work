import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeVpsApp } from '../src/app.js';
import { buildDockerExecCommand, buildDockerLogsFollowCommand } from '../src/docker.js';
import { ScreenBuffer } from '../src/tui/renderer.js';

test('buildDockerExecCommand and buildDockerLogsFollowCommand handle quoting and sudo', () => {
  const normal = buildDockerExecCommand('web-app', { privilegeMode: 'none' });
  assert.ok(normal.includes("docker exec -it 'web-app' /bin/bash"));
  assert.ok(normal.includes("docker exec -it 'web-app' /bin/sh"));

  const elevated = buildDockerLogsFollowCommand('api', { privilegeMode: 'sudo', sudoPassword: 'pw' }, { tail: 50 });
  assert.ok(elevated.includes('sudo -S'));
  assert.ok(elevated.includes('docker logs -f --tail 50'));
  assert.ok(elevated.includes('api'));
});

test('ClaudeVpsApp renders Docker tab across containers, images, and compose sub-tabs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-docker-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    app.activeProfile = app.store.upsert({ name: 'Prod-A', host: '203.0.113.10', user: 'ubuntu' });
    app.tab = 'docker';
    app.dockerData = {
      loadedForProfileId: app.activeProfile.id,
      containers: [
        { id: 'abc123456789', name: 'nginx-proxy', image: 'nginx:alpine', state: 'running', status: 'Up 2 hours', ports: '80->80/tcp' },
        { id: 'bbb222333444', name: 'old-worker', image: 'python:3.12', state: 'exited', status: 'Exited (0)', ports: '' },
      ],
      images: [
        { id: 'def987654321', repository: 'nginx', tag: 'alpine', size: '42MB', createdSince: '2 days ago' },
      ],
      compose: [
        { name: 'prod-stack', status: 'running(3)', configFiles: '/srv/prod/docker-compose.yml' },
      ],
      networks: [
        { id: 'net111222333', name: 'app-net', driver: 'bridge', scope: 'local' },
      ],
      volumes: [
        { name: 'pg-data', driver: 'local', mountpoint: '/var/lib/docker/volumes/pg-data/_data' },
      ],
    };

    const scr = new ScreenBuffer(100, 20);
    scr.begin({ clear: false });
    app.renderDocker(scr, 5, 10, 100);
    const out1 = scr.extractText(1, 4, 100, 14);
    assert.ok(out1.includes('Prod-A'));
    assert.ok(out1.includes('nginx-proxy'));
    assert.ok(out1.includes('old-worker'));

    await app.dispatchAction('dockerToggleRunning');
    assert.equal(app.getDockerListItems().length, 1);
    assert.equal(app.getDockerListItems()[0].name, 'nginx-proxy');
    await app.dispatchAction('dockerToggleRunning');

    app.dockerKeyword = 'worker';
    assert.equal(app.getDockerListItems().length, 1);
    assert.equal(app.getDockerListItems()[0].name, 'old-worker');
    app.dockerKeyword = '';

    await app.dispatchAction('dockerSubTab', 'images');
    const scr2 = new ScreenBuffer(100, 20);
    scr2.begin({ clear: false });
    app.renderDocker(scr2, 5, 10, 100);
    assert.ok(scr2.extractText(1, 5, 100, 14).includes('42MB'));

    await app.dispatchAction('dockerSubTab', 'compose');
    const scr3 = new ScreenBuffer(100, 20);
    scr3.begin({ clear: false });
    app.renderDocker(scr3, 5, 10, 100);
    assert.ok(scr3.extractText(1, 5, 100, 14).includes('prod-stack'));

    await app.dispatchAction('dockerSubTab', 'networks');
    const scr4 = new ScreenBuffer(100, 20);
    scr4.begin({ clear: false });
    app.renderDocker(scr4, 5, 10, 100);
    assert.ok(scr4.extractText(1, 5, 100, 14).includes('app-net'));

    await app.dispatchAction('dockerSubTab', 'volumes');
    const scr5 = new ScreenBuffer(100, 20);
    scr5.begin({ clear: false });
    app.renderDocker(scr5, 5, 10, 100);
    assert.ok(scr5.extractText(1, 5, 100, 14).includes('pg-data'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
