import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PLUGIN_REGISTRY_URL } from './config.js';

export function compareSemver(a, b) {
  const parse = (v) =>
    String(v || '0')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Normalize a plugin registry source string (GitHub repo URL, owner/repo, or direct registry.json URL).
 */
export function normalizeRegistrySource(input) {
  const raw = String(input || '').trim() || DEFAULT_PLUGIN_REGISTRY_URL;
  const ghUrl = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s#?]+))?\/?$/i);
  if (ghUrl) {
    const [, owner, repo, branch = 'main'] = ghUrl;
    return {
      kind: 'github',
      owner,
      repo,
      branch,
      display: `https://github.com/${owner}/${repo}`,
      rawRegistryUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/registry.json`,
      rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`,
      apiTreeUrl: `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    };
  }
  const ghShort = raw.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (ghShort) {
    const [, owner, repo] = ghShort;
    const branch = 'main';
    return {
      kind: 'github',
      owner,
      repo,
      branch,
      display: `https://github.com/${owner}/${repo}`,
      rawRegistryUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/registry.json`,
      rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`,
      apiTreeUrl: `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    };
  }
  return {
    kind: 'json',
    display: raw,
    rawRegistryUrl: raw,
  };
}

function sanitizePluginManifest(parsed, fallbackCategory = '') {
  if (!parsed || typeof parsed !== 'object') return null;
  const id = String(parsed.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(parsed.name || id).trim(),
    version: String(parsed.version || '1.0.0'),
    author: String(parsed.author || 'community'),
    category: String(parsed.category || fallbackCategory || 'general'),
    description: String(parsed.description || '远程插件'),
    tab: parsed.tab && parsed.tab.id ? parsed.tab : null,
    quickCommands: Array.isArray(parsed.quickCommands) ? parsed.quickCommands : [],
  };
}

/**
 * Fetch and parse remote plugin catalog from a registry URL or GitHub repository.
 */
export async function fetchRemotePluginRegistry(
  sourceInput = DEFAULT_PLUGIN_REGISTRY_URL,
  { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}
) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, source: String(sourceInput || ''), plugins: [], error: '当前环境不支持 fetch' };
  }
  const src = normalizeRegistrySource(sourceInput);
  const fetchJson = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'ssh4work', Accept: 'application/json' },
      });
      if (!resp.ok) return { ok: false, status: resp.status, data: null };
      return { ok: true, status: resp.status, data: await resp.json() };
    } catch (err) {
      return { ok: false, status: 0, error: err?.name === 'AbortError' ? '请求超时' : err?.message || '网络错误' };
    } finally {
      clearTimeout(timer);
    }
  };

  const regRes = await fetchJson(src.rawRegistryUrl);
  if (regRes.ok && regRes.data) {
    const rawList = Array.isArray(regRes.data) ? regRes.data : Array.isArray(regRes.data.plugins) ? regRes.data.plugins : [];
    const plugins = rawList.map((p) => sanitizePluginManifest(p)).filter(Boolean);
    return { ok: true, source: src.display, resolvedUrl: src.rawRegistryUrl, plugins, error: '' };
  }

  // Fallback for GitHub repositories without a prebuilt registry.json
  if (src.kind === 'github') {
    const treeRes = await fetchJson(src.apiTreeUrl);
    if (treeRes.ok && Array.isArray(treeRes.data?.tree)) {
      const manifestPaths = treeRes.data.tree
        .filter((n) => n.type === 'blob' && /^plugins\/[^/]+\/[^/]+\/plugin\.json$/.test(n.path))
        .map((n) => n.path);
      const loaded = await Promise.all(
        manifestPaths.map(async (p) => {
          const r = await fetchJson(`${src.rawBaseUrl}/${p}`);
          if (!r.ok || !r.data) return null;
          const parts = p.split('/');
          return sanitizePluginManifest(r.data, parts[1] || 'general');
        })
      );
      const plugins = loaded.filter(Boolean);
      return { ok: true, source: src.display, resolvedUrl: src.apiTreeUrl, plugins, error: '' };
    }
  }

  return {
    ok: false,
    source: src.display,
    resolvedUrl: src.rawRegistryUrl,
    plugins: [],
    error: regRes.error || (regRes.status ? `HTTP ${regRes.status}` : '无法读取插件源'),
  };
}

export const BUILTIN_PLUGINS = [
  {
    id: 'claude-code',
    name: 'Claude Code 助手',
    version: '1.1.0',
    author: 'built-in',
    description: '会话查找/预览/恢复/分叉，以及 Token 统计(缓存率/分时段/模型差异标红)',
    tab: { id: 'sessions', label: 'Claude Code', agentType: 'claude', requiresServer: true },
    quickCommands: [
      { id: 'plugin-claude-new', name: 'Claude 新会话', command: 'claude', dir: '' },
      { id: 'plugin-claude-cont', name: 'Claude 继续', command: 'claude --continue', dir: '' },
    ],
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI 助手',
    version: '1.0.0',
    author: 'built-in',
    description: '扫描 ~/.codex/sessions 会话，支持搜索、预览与 codex resume 恢复',
    tab: { id: 'codex', label: 'Codex', agentType: 'codex', requiresServer: true },
    quickCommands: [
      { id: 'plugin-codex-new', name: 'Codex 新会话', command: 'codex', dir: '' },
      { id: 'plugin-codex-last', name: 'Codex 继续上次', command: 'codex resume --last', dir: '' },
    ],
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity CLI (AGY)',
    version: '1.0.0',
    author: 'built-in',
    description: '扫描 ~/.gemini/antigravity-cli/brain 会话，支持搜索、预览与 agy 恢复',
    tab: { id: 'agy', label: 'AGY', agentType: 'agy', requiresServer: true },
    quickCommands: [
      { id: 'plugin-agy-new', name: 'AGY 新会话', command: 'agy', dir: '' },
      { id: 'plugin-agy-cont', name: 'AGY 继续 (-c)', command: 'agy -c', dir: '' },
    ],
  },
  {
    id: 'pi-cli',
    name: 'Pi Agent 助手',
    version: '1.0.0',
    author: 'built-in',
    description: '扫描 ~/.pi/agent/sessions 会话，支持全局 AGENTS.md、Skills 与 MCP 管理',
    tab: { id: 'pi', label: 'Pi', agentType: 'pi', requiresServer: true },
    quickCommands: [
      { id: 'plugin-pi-new', name: 'Pi 新会话', command: 'pi', dir: '' },
      { id: 'plugin-pi-cont', name: 'Pi 继续 (-c)', command: 'pi -c', dir: '' },
    ],
  },
  {
    id: 'opencode-cli',
    name: 'OpenCode 助手',
    version: '1.0.0',
    author: 'built-in',
    description: '扫描 OpenCode 会话，支持全局 AGENTS.md、Skills 与 opencode.json MCP 管理',
    tab: { id: 'opencode', label: 'OpenCode', agentType: 'opencode', requiresServer: true },
    quickCommands: [
      { id: 'plugin-opencode-new', name: 'OpenCode 新会话', command: 'opencode', dir: '' },
      { id: 'plugin-opencode-cont', name: 'OpenCode 继续 (-c)', command: 'opencode -c', dir: '' },
    ],
  },
];

export class PluginManager {
  constructor(store) {
    this.store = store;
  }

  _state() {
    if (!this.store.data.plugins) {
      this.store.data.plugins = { installed: [], enabled: [], custom: [] };
    }
    return this.store.data.plugins;
  }

  listAllDefinitions() {
    const st = this._state();
    const custom = Array.isArray(st.custom) ? st.custom.filter((c) => c && c.id) : [];
    const customById = new Map(custom.map((c) => [c.id, c]));
    const mergedBuiltins = BUILTIN_PLUGINS.map((b) => (customById.has(b.id) ? { ...b, ...customById.get(b.id) } : b));
    const builtinIds = new Set(BUILTIN_PLUGINS.map((p) => p.id));
    return [...mergedBuiltins, ...custom.filter((c) => !builtinIds.has(c.id))];
  }

  listCatalog() {
    const st = this._state();
    return this.listAllDefinitions().map((p) => ({
      ...p,
      builtin: BUILTIN_PLUGINS.some((b) => b.id === p.id),
      installed: st.installed.includes(p.id),
      enabled: st.installed.includes(p.id) && st.enabled.includes(p.id),
    }));
  }

  mergeRemoteCatalog(remotePlugins = []) {
    const local = this.listCatalog();
    const byId = new Map(local.map((p) => [p.id, { ...p, remoteAvailable: false, hasUpdate: false }]));
    for (const rp of remotePlugins || []) {
      if (!rp?.id) continue;
      const existing = byId.get(rp.id);
      if (existing) {
        const hasUpdate = existing.installed && compareSemver(rp.version, existing.version) > 0;
        byId.set(rp.id, {
          ...existing,
          category: rp.category || existing.category || '',
          remoteAvailable: true,
          remoteVersion: rp.version,
          hasUpdate,
          remotePlugin: rp,
        });
      } else {
        byId.set(rp.id, {
          ...rp,
          builtin: false,
          installed: false,
          enabled: false,
          remoteAvailable: true,
          remoteVersion: rp.version,
          hasUpdate: false,
          remotePlugin: rp,
        });
      }
    }
    return [...byId.values()];
  }

  installRemote(pluginDef, { sourceUrl = '' } = {}) {
    const clean = sanitizePluginManifest(pluginDef);
    if (!clean) return { ok: false, error: '无效的远程插件清单' };
    const st = this._state();
    if (!Array.isArray(st.custom)) st.custom = [];
    const entry = {
      ...clean,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
    const existingIdx = st.custom.findIndex((c) => c.id === clean.id);
    const updated = existingIdx >= 0 || st.installed.includes(clean.id);
    if (existingIdx >= 0) st.custom[existingIdx] = entry;
    else st.custom.push(entry);
    if (!st.installed.includes(clean.id)) st.installed.push(clean.id);
    if (!st.enabled.includes(clean.id)) st.enabled.push(clean.id);
    this.store.save();
    return { ok: true, plugin: entry, updated };
  }

  isInstalled(id) {
    return this._state().installed.includes(id);
  }

  isEnabled(id) {
    const st = this._state();
    return st.installed.includes(id) && st.enabled.includes(id);
  }

  isDisabledForProfile(pluginId, profile) {
    if (!profile || !Array.isArray(profile.disabledPlugins)) return false;
    return profile.disabledPlugins.includes(pluginId);
  }

  isEnabledForProfile(pluginId, profile) {
    return this.isEnabled(pluginId) && !this.isDisabledForProfile(pluginId, profile);
  }

  getPluginIdForTab(tabId) {
    const found = this.listAllDefinitions().find((p) => p.tab?.id === tabId);
    return found ? found.id : null;
  }

  getEnabledPlugins() {
    return this.listCatalog().filter((p) => p.enabled);
  }

  getEnabledTabs() {
    return this.getEnabledPlugins()
      .filter((p) => p.tab && p.tab.id && p.tab.label)
      .map((p) => ({ ...p.tab, pluginId: p.id }));
  }

  getPluginQuickCommands(profile = null) {
    const cmds = [];
    for (const p of this.getEnabledPlugins()) {
      if (this.isDisabledForProfile(p.id, profile)) continue;
      for (const q of p.quickCommands || []) {
        cmds.push({ ...q, pluginId: p.id, pluginName: p.name });
      }
    }
    return cmds;
  }

  install(idOrManifestPath) {
    const input = String(idOrManifestPath || '').trim();
    if (!input) return { ok: false, error: '插件 ID 或路径不能为空' };

    const st = this._state();
    const builtin = BUILTIN_PLUGINS.find((p) => p.id === input);
    if (builtin) {
      if (!st.installed.includes(builtin.id)) st.installed.push(builtin.id);
      if (!st.enabled.includes(builtin.id)) st.enabled.push(builtin.id);
      this.store.save();
      return { ok: true, plugin: builtin };
    }

    let manifestPath = path.resolve(input);
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isDirectory()) {
      manifestPath = path.join(manifestPath, 'plugin.json');
    }
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, error: `未找到插件或清单文件: ${input}` };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const id = String(parsed.id || '').trim();
      const name = String(parsed.name || id).trim();
      if (!id) return { ok: false, error: '插件清单缺少 id 字段' };
      const pluginDef = {
        id,
        name,
        version: String(parsed.version || '1.0.0'),
        author: String(parsed.author || 'custom'),
        description: String(parsed.description || '自定义本地插件'),
        tab: parsed.tab && parsed.tab.id ? parsed.tab : null,
        quickCommands: Array.isArray(parsed.quickCommands) ? parsed.quickCommands : [],
      };
      if (!Array.isArray(st.custom)) st.custom = [];
      const existingIdx = st.custom.findIndex((c) => c.id === id);
      if (existingIdx >= 0) st.custom[existingIdx] = pluginDef;
      else st.custom.push(pluginDef);
      if (!st.installed.includes(id)) st.installed.push(id);
      if (!st.enabled.includes(id)) st.enabled.push(id);
      this.store.save();
      return { ok: true, plugin: pluginDef };
    } catch (err) {
      return { ok: false, error: `解析插件清单失败: ${err.message}` };
    }
  }

  uninstall(id) {
    const st = this._state();
    st.installed = st.installed.filter((x) => x !== id);
    st.enabled = st.enabled.filter((x) => x !== id);
    if (Array.isArray(st.custom)) {
      st.custom = st.custom.filter((c) => c.id !== id);
    }
    this.store.save();
    return true;
  }

  toggle(id) {
    const st = this._state();
    if (!st.installed.includes(id)) return false;
    if (st.enabled.includes(id)) {
      st.enabled = st.enabled.filter((x) => x !== id);
    } else {
      st.enabled.push(id);
    }
    this.store.save();
    return st.enabled.includes(id);
  }
}

function calcCacheRate(input, cacheRead, cacheCreate) {
  const denom = input + cacheRead + cacheCreate;
  if (denom <= 0) return 0;
  return (cacheRead / denom) * 100;
}

function formatLocalTimestamp(tsStr) {
  const d = new Date(tsStr);
  if (Number.isNaN(d.getTime())) {
    return { full: String(tsStr || '-').slice(0, 19), hour: '未知时段', day: '未知日期' };
  }
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hour = `${day} ${p(d.getHours())}:00`;
  const full = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return { full, hour, day };
}

export function formatTokenCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

/**
 * Per-million-token pricing table (USD), modeled after cc-switch ModelPricing.
 */
export const MODEL_PRICING_TABLE = [
  { match: /opus-4-[5-9]|opus-[5-9]/i, input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  { match: /opus/i, input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  { match: /sonnet/i, input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  { match: /haiku-4|4-5-haiku/i, input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  { match: /3-5-haiku|haiku-3-5/i, input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1.0 },
  { match: /haiku/i, input: 0.25, output: 1.25, cacheRead: 0.03, cacheCreation: 0.3 },
];

export function getModelPricing(modelId) {
  const name = String(modelId || '').trim();
  for (const row of MODEL_PRICING_TABLE) {
    if (row.match.test(name)) return row;
  }
  return { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 };
}

export function computeTokenCostUsd({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0, respModel = '', reqModel = '' }) {
  const p = getModelPricing(respModel || reqModel);
  return (
    (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheCreate * p.cacheCreation) /
    1_000_000
  );
}

export function formatCostUsd(usd) {
  const v = Number(usd) || 0;
  if (v <= 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function getLocalTzLabel() {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return mm === 0 ? `UTC${sign}${hh}` : `UTC${sign}${hh}:${String(mm).padStart(2, '0')}`;
}

export function formatLocalDateTimeNow(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * Parse a user-entered local datetime string (e.g. "2026-11-20 13:05:30") into epoch ms.
 */
export function parseLocalDateTimeInput(input, { isEnd = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'now' || raw === '现在' || raw === '到现在') {
    return Date.now();
  }
  // If string explicitly includes timezone ('Z' or '+/-HH:MM'), parse as ISO
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const hasTime = m[4] !== undefined;
    const H = hasTime ? Number(m[4]) : isEnd ? 23 : 0;
    const M = m[5] !== undefined ? Number(m[5]) : isEnd && !hasTime ? 59 : isEnd && m[5] === undefined ? 59 : 0;
    const S = m[6] !== undefined ? Number(m[6]) : isEnd ? 59 : 0;
    const ms = isEnd ? 999 : 0;
    const dt = new Date(y, mo, d, H, M, S, ms);
    return Number.isNaN(dt.getTime()) ? null : dt.getTime();
  }
  const fallback = Date.parse(raw);
  return Number.isNaN(fallback) ? null : fallback;
}

/**
 * Aggregate Claude Code JSONL usage records into per-item, hourly, daily, and per-model stats.
 */
export function aggregateTokenStats(records = [], { startTime = '', endTime = '' } = {}) {
  const startMs = parseLocalDateTimeInput(startTime, { isEnd: false });
  const endMs = parseLocalDateTimeInput(endTime, { isEnd: true });

  const summary = {
    calls: 0,
    successCalls: 0,
    successRate: 100,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    totalTokens: 0,
    cacheRate: 0,
    costUsd: 0,
    tokPerSec: null,
    avgTtftMs: null,
    durationMsSum: 0,
    speedOutputSum: 0,
    ttftSum: 0,
    ttftCount: 0,
    tzLabel: getLocalTzLabel(),
  };

  const items = [];
  const hourMap = new Map();
  const dayMap = new Map();
  const modelMap = new Map();
  const routeMap = new Map();

  const bump = (map, key, extra, rec) => {
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        ...extra,
        calls: 0,
        successCalls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        costUsd: 0,
        durationMsSum: 0,
        speedOutputSum: 0,
        ttftSum: 0,
        ttftCount: 0,
      };
      map.set(key, entry);
    }
    entry.calls += 1;
    if (rec.ok) entry.successCalls += 1;
    entry.input += rec.input;
    entry.output += rec.output;
    entry.cacheRead += rec.cacheRead;
    entry.cacheCreate += rec.cacheCreate;
    entry.costUsd += rec.costUsd;
    if (rec.durationMs > 0 && rec.output > 0) {
      entry.durationMsSum += rec.durationMs;
      entry.speedOutputSum += rec.output;
    }
    if (rec.ttftMs > 0) {
      entry.ttftSum += rec.ttftMs;
      entry.ttftCount += 1;
    }
  };

  for (const raw of records) {
    const reqModel = String(raw.reqModel || '').trim();
    const respModel = String(raw.respModel || '').trim();
    if (respModel === '<synthetic>' || reqModel === '<synthetic>') continue;

    const tsMs = raw.ts ? Date.parse(raw.ts) : NaN;
    if (startMs !== null && (Number.isNaN(tsMs) || tsMs < startMs)) continue;
    if (endMs !== null && (Number.isNaN(tsMs) || tsMs > endMs)) continue;

    const input = Number(raw.in ?? raw.input ?? 0) || 0;
    const output = Number(raw.out ?? raw.output ?? 0) || 0;
    const cacheRead = Number(raw.cr ?? raw.cacheRead ?? 0) || 0;
    const cacheCreate = Number(raw.cc ?? raw.cacheCreate ?? 0) || 0;
    const durationMs = Number(raw.durationMs ?? 0) || 0;
    const ttftMs = Number(raw.ttftMs ?? 0) || 0;
    const ok = raw.ok !== false;
    const t = formatLocalTimestamp(raw.ts);
    const costUsd = computeTokenCostUsd({ input, output, cacheRead, cacheCreate, respModel, reqModel });

    const rec = {
      ts: raw.ts || '',
      localTime: t.full,
      sessionId: raw.sessionId || '',
      sessionTitle: raw.sessionTitle || '',
      reqModel: reqModel || respModel || '-',
      respModel: respModel || reqModel || '-',
      input,
      output,
      cacheRead,
      cacheCreate,
      totalTokens: input + output + cacheRead + cacheCreate,
      cacheRate: calcCacheRate(input, cacheRead, cacheCreate),
      costUsd,
      ok,
      durationMs,
      ttftMs,
    };
    items.push(rec);

    summary.calls += 1;
    if (ok) summary.successCalls += 1;
    summary.input += input;
    summary.output += output;
    summary.cacheRead += cacheRead;
    summary.cacheCreate += cacheCreate;
    summary.costUsd += costUsd;
    if (durationMs > 0 && output > 0) {
      summary.durationMsSum += durationMs;
      summary.speedOutputSum += output;
    }
    if (ttftMs > 0) {
      summary.ttftSum += ttftMs;
      summary.ttftCount += 1;
    }

    bump(hourMap, t.hour, { bucket: t.hour }, rec);
    bump(dayMap, t.day, { bucket: t.day }, rec);
    bump(modelMap, rec.respModel, { model: rec.respModel }, rec);
    bump(
      routeMap,
      `${rec.reqModel}=>${rec.respModel}`,
      { reqModel: rec.reqModel, respModel: rec.respModel },
      rec
    );
  }

  summary.totalTokens = summary.input + summary.output + summary.cacheRead + summary.cacheCreate;
  summary.cacheRate = calcCacheRate(summary.input, summary.cacheRead, summary.cacheCreate);
  summary.successRate = summary.calls > 0 ? (summary.successCalls / summary.calls) * 100 : 100;
  summary.tokPerSec =
    summary.durationMsSum > 0 && summary.speedOutputSum > 0
      ? summary.speedOutputSum / (summary.durationMsSum / 1000)
      : null;
  summary.avgTtftMs = summary.ttftCount > 0 ? summary.ttftSum / summary.ttftCount : null;

  const finalize = (arr) =>
    arr.map((e) => ({
      ...e,
      totalTokens: e.input + e.output + e.cacheRead + e.cacheCreate,
      cacheRate: calcCacheRate(e.input, e.cacheRead, e.cacheCreate),
      successRate: e.calls > 0 ? (e.successCalls / e.calls) * 100 : 100,
      tokPerSec:
        e.durationMsSum > 0 && e.speedOutputSum > 0
          ? e.speedOutputSum / (e.durationMsSum / 1000)
          : null,
      avgTtftMs: e.ttftCount > 0 ? e.ttftSum / e.ttftCount : null,
    }));

  const byHour = finalize([...hourMap.values()]).sort((a, b) => b.bucket.localeCompare(a.bucket));
  const byDay = finalize([...dayMap.values()]).sort((a, b) => b.bucket.localeCompare(a.bucket));
  const byModel = finalize([...modelMap.values()]).sort((a, b) => b.calls - a.calls);
  const byRoute = finalize([...routeMap.values()]).sort((a, b) => b.calls - a.calls);

  return { summary, items, byHour, byDay, byModel, byRoute };
}
