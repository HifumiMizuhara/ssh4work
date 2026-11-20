import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeVpsApp } from '../src/app.js';
import { checkForAppUpdate, getCurrentVersion } from '../src/updater.js';

test('getCurrentVersion reads package.json version', () => {
  const v = getCurrentVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('checkForAppUpdate detects newer GitHub Release and falls back to package.json', async () => {
  const resRelease = await checkForAppUpdate({
    currentVersion: '1.1.0',
    fetchImpl: async (url) => {
      assert.ok(url.includes('/releases/latest'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.2.0',
          html_url: 'https://github.com/is-hp-is-mad/ssh4work/releases/tag/v1.2.0',
          body: '### Highlights\n- Faster SSH tabs',
          published_at: '2026-11-20T12:00:00Z',
        }),
      };
    },
  });
  assert.equal(resRelease.ok, true);
  assert.equal(resRelease.hasUpdate, true);
  assert.equal(resRelease.latestVersion, '1.2.0');

  const resFallback = await checkForAppUpdate({
    currentVersion: '1.1.0',
    fetchImpl: async (url) => {
      if (url.includes('/releases/latest')) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '1.1.0' }),
      };
    },
  });
  assert.equal(resFallback.ok, true);
  assert.equal(resFallback.hasUpdate, false);
  assert.equal(resFallback.latestVersion, '1.1.0');
});

test('ClaudeVpsApp.openAppUpdateModal populates appUpdate modal state', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-upd-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    await app.openAppUpdateModal({
      force: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/is-hp-is-mad/ssh4work/releases/tag/v9.9.9',
          body: 'New release',
        }),
      }),
    });
    assert.equal(app.modal?.type, 'appUpdate');
    assert.equal(app.modal.info.hasUpdate, true);
    assert.equal(app.modal.info.latestVersion, '9.9.9');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
