import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeVpsApp } from '../src/app.js';
import { DEFAULT_PLUGIN_REGISTRY_URL } from '../src/config.js';
import { compareSemver, fetchRemotePluginRegistry, normalizeRegistrySource } from '../src/plugins.js';

test('normalizeRegistrySource and compareSemver handle GitHub, shorthand, and custom JSON URLs', () => {
  const gh = normalizeRegistrySource('https://github.com/is-hp-is-mad/ssh4work-plugins');
  assert.equal(gh.kind, 'github');
  assert.equal(gh.rawRegistryUrl, 'https://raw.githubusercontent.com/is-hp-is-mad/ssh4work-plugins/main/registry.json');

  const short = normalizeRegistrySource('my-org/custom-plugins');
  assert.equal(short.kind, 'github');
  assert.equal(short.rawRegistryUrl, 'https://raw.githubusercontent.com/my-org/custom-plugins/main/registry.json');

  const custom = normalizeRegistrySource('https://plugins.example.com/index.json');
  assert.equal(custom.kind, 'json');
  assert.equal(custom.rawRegistryUrl, 'https://plugins.example.com/index.json');

  assert.equal(compareSemver('1.2.0', '1.1.0'), 1);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.9', '1.1.0'), -1);
});

test('fetchRemotePluginRegistry loads registry.json and falls back to GitHub tree API', async () => {
  const mockFetchRegistry = async (url) => {
    if (url.endsWith('/registry.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          version: 1,
          plugins: [
            {
              id: 'docker-devops',
              name: 'Docker 运维',
              version: '1.0.0',
              category: 'devops',
              description: 'Docker helper',
              quickCommands: [{ id: 'ps', name: 'ps', command: 'docker ps' }],
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const res1 = await fetchRemotePluginRegistry(DEFAULT_PLUGIN_REGISTRY_URL, { fetchImpl: mockFetchRegistry });
  assert.equal(res1.ok, true);
  assert.equal(res1.plugins.length, 1);
  assert.equal(res1.plugins[0].id, 'docker-devops');

  const mockFetchTreeFallback = async (url) => {
    if (url.endsWith('/registry.json')) return { ok: false, status: 404 };
    if (url.includes('/git/trees/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tree: [{ type: 'blob', path: 'plugins/devops/nginx-community/plugin.json' }],
        }),
      };
    }
    if (url.endsWith('plugins/devops/nginx-community/plugin.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'nginx-community',
          name: 'Nginx 社区助手',
          version: '1.0.0',
          description: 'Reload & test nginx',
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const res2 = await fetchRemotePluginRegistry('someone/fork-plugins', { fetchImpl: mockFetchTreeFallback });
  assert.equal(res2.ok, true);
  assert.equal(res2.plugins.length, 1);
  assert.equal(res2.plugins[0].id, 'nginx-community');
  assert.equal(res2.plugins[0].category, 'devops');
});

test('ClaudeVpsApp discovers, downloads, and updates plugins from custom remote registry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-reg-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    app.plugins.install('claude-code');
    app.store.updateSettings({ pluginRegistryUrl: 'https://custom.example.com/registry.json' });
    app.openPluginsModal();

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        plugins: [
          {
            id: 'claude-code',
            name: 'Claude Code 助手',
            version: '1.2.0',
            category: 'ai-agents',
            description: 'Updated Claude Code helper',
          },
          {
            id: 'docker-devops',
            name: 'Docker 运维',
            version: '1.0.0',
            category: 'devops',
            description: 'Docker helper',
            quickCommands: [{ id: 'dps', name: 'Docker PS', command: 'docker ps' }],
          },
        ],
      }),
    });

    const syncRes = await app.refreshRemotePlugins({ fetchImpl: mockFetch });
    assert.equal(syncRes.ok, true);

    const claudeIdx = app.modal.catalog.findIndex((p) => p.id === 'claude-code');
    assert.equal(app.modal.catalog[claudeIdx].hasUpdate, true);
    assert.equal(app.modal.catalog[claudeIdx].remoteVersion, '1.2.0');

    // Update claude-code from 1.1.0 -> 1.2.0
    app.modal.idx = claudeIdx;
    await app.dispatchAction('pluginToggleOrInstall');
    assert.equal(app.modal.catalog[claudeIdx].version, '1.2.0');
    assert.equal(app.modal.catalog[claudeIdx].hasUpdate, false);

    // Download & install new remote plugin docker-devops
    const dockerIdx = app.modal.catalog.findIndex((p) => p.id === 'docker-devops');
    assert.ok(dockerIdx >= 0);
    assert.equal(app.modal.catalog[dockerIdx].installed, false);
    app.modal.idx = dockerIdx;
    await app.dispatchAction('pluginToggleOrInstall');
    assert.equal(app.plugins.isEnabled('docker-devops'), true);
    assert.ok(app.plugins.getPluginQuickCommands().some((q) => q.command === 'docker ps'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
