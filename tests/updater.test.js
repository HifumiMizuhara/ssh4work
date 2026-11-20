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

test('appUpdate modal handles keyboard: Esc closes, r refreshes, u upgrades when update available', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-upd-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    // Open modal with no update available
    await app.openAppUpdateModal({
      force: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: `v${getCurrentVersion()}`,
          html_url: `https://github.com/is-hp-is-mad/ssh4work/releases/tag/v${getCurrentVersion()}`,
          body: '',
        }),
      }),
    });
    assert.equal(app.modal?.type, 'appUpdate');
    assert.equal(app.modal.info.hasUpdate, false);

    // Esc should close the modal
    await app.handleKey({ name: 'escape' });
    assert.equal(app.modal, null);

    // Open modal with update available
    await app.openAppUpdateModal({
      force: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/is-hp-is-mad/ssh4work/releases/tag/v99.0.0',
          body: 'New stuff',
        }),
      }),
    });
    assert.equal(app.modal?.type, 'appUpdate');
    assert.equal(app.modal.info.hasUpdate, true);

    // 'r' key should trigger refresh (re-opens the modal)
    let refreshCalled = false;
    const origOpen = app.openAppUpdateModal.bind(app);
    app.openAppUpdateModal = async (opts) => {
      refreshCalled = true;
      return origOpen(opts);
    };
    await app.handleKey({ char: 'r' });
    assert.equal(refreshCalled, true);

    // Close and clean up
    await app.handleKey({ name: 'escape' });
    assert.equal(app.modal, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('appUpdate modal buttons have correct hitboxes for mouse click', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-upd-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    // Open modal with update available
    await app.openAppUpdateModal({
      force: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/is-hp-is-mad/ssh4work/releases/tag/v99.0.0',
          body: 'Big update',
        }),
      }),
    });
    assert.equal(app.modal?.type, 'appUpdate');

    // Enable render and trigger it
    app._running = true;
    app.render();

    // Check that the screen has buttons with correct actions
    const scr = app._lastScreen;
    assert.ok(scr, 'screen should exist after render');
    const actions = scr.buttons.map((b) => b.action);
    assert.ok(actions.includes('runAppUpgrade'), 'should have upgrade button');
    assert.ok(actions.includes('refreshAppUpdate'), 'should have refresh button');
    assert.ok(actions.includes('modalCancel'), 'should have close button');

    // Verify hitTest finds the refresh button when clicking its coordinates
    const refreshBtn = scr.buttons.find((b) => b.action === 'refreshAppUpdate');
    const hit = scr.hitTest(refreshBtn.x1, refreshBtn.y);
    assert.equal(hit.action, 'refreshAppUpdate', 'hitTest should find refresh button');

    // Verify hitTest finds the close button
    const closeBtn = scr.buttons.find((b) => b.action === 'modalCancel');
    const hit2 = scr.hitTest(closeBtn.x1, closeBtn.y);
    assert.equal(hit2.action, 'modalCancel', 'hitTest should find close button');

    await app.handleKey({ name: 'escape' });
    app._running = false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
