import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PLUGIN_REGISTRY_URL = 'https://github.com/is-hp-is-mad/ssh4work-plugins';

export function getDefaultConfigPath() {
  if (process.env.SSH4WORK_CONFIG) {
    return process.env.SSH4WORK_CONFIG;
  }
  if (process.env.CLAUDE_VPS_CONFIG) {
    return process.env.CLAUDE_VPS_CONFIG;
  }
  const preferred = path.join(os.homedir(), '.ssh4work', 'profiles.json');
  const legacy = path.join(os.homedir(), '.claude-vps', 'profiles.json');
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

export function createDefaultSettings(input = {}) {
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
  };
  return {
    sshTimeoutSec: num(input.sshTimeoutSec, 20, 5, 120),
    connectTimeoutSec: num(input.connectTimeoutSec, 10, 3, 60),
    serverAliveIntervalSec: num(input.serverAliveIntervalSec, 30, 5, 300),
    defaultShell: String(input.defaultShell || 'auto').trim() || 'auto', // 'auto' | 'bash' | 'zsh' | 'sh'
    sessionScanLimit: num(input.sessionScanLimit, 120, 20, 500),
    showHiddenByDefault: Boolean(input.showHiddenByDefault),
    enableImageClipboard:
      input.enableImageClipboard !== undefined
        ? Boolean(input.enableImageClipboard)
        : true,
    enableAutoCopy: input.enableAutoCopy !== undefined ? Boolean(input.enableAutoCopy) : true,
    showMotd: input.showMotd !== undefined ? Boolean(input.showMotd) : true,
    theme: ['cyber', 'emerald', 'amber', 'rose'].includes(input.theme) ? input.theme : 'cyber',
    pluginRegistryUrl:
      String(input.pluginRegistryUrl ?? DEFAULT_PLUGIN_REGISTRY_URL).trim() ||
      DEFAULT_PLUGIN_REGISTRY_URL,
  };
}

export function createProfile(input = {}) {
  const portNum = Number(input.port);
  return {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || input.host || 'New VPS').trim(),
    host: String(input.host || '').trim(),
    port: Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 22,
    user: String(input.user ?? '').trim(),
    homeDir: String(input.homeDir || '~').trim() || '~',
    identityFile: String(input.identityFile || '').trim(),
    password: String(input.password || ''),
    proxyJump: String(input.proxyJump || '').trim(),
    extraSshArgs: String(input.extraSshArgs || '').trim(),
    preCommand: String(input.preCommand || '').trim(),
    claudeCommand: String(input.claudeCommand || 'claude').trim() || 'claude',
    privilegeMode: ['none', 'sudo', 'root'].includes(String(input.privilegeMode || '').trim().toLowerCase())
      ? String(input.privilegeMode).trim().toLowerCase()
      : 'none',
    sudoPassword: String(input.sudoPassword || ''),
    disabledPlugins: Array.isArray(input.disabledPlugins)
      ? [...new Set(input.disabledPlugins.map((s) => String(s).trim()).filter(Boolean))]
      : [],
    lastDir: String(input.lastDir || '').trim(),
    pinnedDirs: Array.isArray(input.pinnedDirs)
      ? [...new Set(input.pinnedDirs.map((d) => String(d).trim()).filter(Boolean))]
      : [],
    quickCommands: Array.isArray(input.quickCommands)
      ? input.quickCommands
          .filter((q) => q && (q.name || q.command))
          .map((q) => ({
            id: q.id || crypto.randomUUID(),
            name: String(q.name || q.command || '').trim(),
            command: String(q.command || '').trim(),
            dir: String(q.dir || '').trim(),
          }))
      : [],
  };
}

export class ConfigStore {
  constructor(filePath = getDefaultConfigPath()) {
    this.filePath = filePath;
    this.data = {
      version: 1,
      activeProfileId: null,
      settings: createDefaultSettings(),
      plugins: { installed: [], enabled: [], custom: [] },
      profiles: [],
    };
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return this.data;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.map((p) => createProfile(p))
        : [];
      const rawPlugins = parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
      this.data = {
        version: 1,
        activeProfileId: parsed.activeProfileId || (profiles[0]?.id ?? null),
        settings: createDefaultSettings(parsed.settings),
        plugins: {
          installed: Array.isArray(rawPlugins.installed) ? rawPlugins.installed : [],
          enabled: Array.isArray(rawPlugins.enabled) ? rawPlugins.enabled : [],
          custom: Array.isArray(rawPlugins.custom) ? rawPlugins.custom : [],
        },
        profiles,
      };
    } catch {
      this.data = {
        version: 1,
        activeProfileId: null,
        settings: createDefaultSettings(),
        plugins: { installed: [], enabled: [], custom: [] },
        profiles: [],
      };
    }
    return this.data;
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Ignore chmod errors on non-standard filesystems
      }
    }
  }

  getSettings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    this.data.settings = createDefaultSettings({ ...this.data.settings, ...patch });
    this.save();
    return this.data.settings;
  }

  list() {
    return this.data.profiles;
  }

  getById(id) {
    return this.data.profiles.find((p) => p.id === id) || null;
  }

  upsert(profileInput) {
    const profile = createProfile(profileInput);
    const idx = this.data.profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      this.data.profiles[idx] = profile;
    } else {
      this.data.profiles.push(profile);
    }
    if (!this.data.activeProfileId) {
      this.data.activeProfileId = profile.id;
    }
    this.save();
    return profile;
  }

  remove(id) {
    const before = this.data.profiles.length;
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.activeProfileId === id) {
      this.data.activeProfileId = this.data.profiles[0]?.id ?? null;
    }
    if (this.data.profiles.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  moveProfile(index, delta) {
    const list = this.data.profiles;
    if (index < 0 || index >= list.length) return -1;
    const target = Math.max(0, Math.min(list.length - 1, index + delta));
    if (target === index) return index;
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    this.save();
    return target;
  }

  setActive(id) {
    if (this.getById(id)) {
      this.data.activeProfileId = id;
      this.save();
    }
  }

  togglePinDir(profileId, dirPath) {
    const p = this.getById(profileId);
    if (!p || !dirPath) return false;
    const idx = p.pinnedDirs.indexOf(dirPath);
    let pinned = false;
    if (idx >= 0) {
      p.pinnedDirs.splice(idx, 1);
    } else {
      p.pinnedDirs.unshift(dirPath);
      pinned = true;
    }
    this.save();
    return pinned;
  }

  upsertQuickCommand(profileId, cmdInput) {
    const p = this.getById(profileId);
    if (!p) return null;
    if (!Array.isArray(p.quickCommands)) p.quickCommands = [];
    const command = String(cmdInput.command || '').trim();
    const name = String(cmdInput.name || command || '').trim();
    const dir = String(cmdInput.dir || '').trim();
    if (!name && !command) return null;
    const item = {
      id: cmdInput.id || crypto.randomUUID(),
      name,
      command,
      dir,
    };
    const idx = p.quickCommands.findIndex((q) => q.id === item.id);
    if (idx >= 0) {
      p.quickCommands[idx] = item;
    } else {
      p.quickCommands.push(item);
    }
    this.save();
    return item;
  }

  removeQuickCommand(profileId, cmdId) {
    const p = this.getById(profileId);
    if (!p || !Array.isArray(p.quickCommands)) return false;
    const before = p.quickCommands.length;
    p.quickCommands = p.quickCommands.filter((q) => q.id !== cmdId);
    if (p.quickCommands.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  updateLastDir(profileId, dirPath) {
    const p = this.getById(profileId);
    if (!p || !dirPath) return;
    if (p.lastDir !== dirPath) {
      p.lastDir = dirPath;
      this.save();
    }
  }
}

/**
 * Parse ~/.ssh/config into candidate profile objects.
 */
export function parseSshConfig(content) {
  const results = [];
  let current = null;

  const flush = () => {
    if (current && current.aliases.length > 0) {
      for (const alias of current.aliases) {
        if (!alias || alias.includes('*') || alias.includes('?')) continue;
        results.push(
          createProfile({
            name: alias,
            host: current.hostname || alias,
            port: current.port || 22,
            user: current.user || '',
            identityFile: current.identityFile || '',
            proxyJump: current.proxyJump || '',
            homeDir: '~',
          })
        );
      }
    }
  };

  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');

    if (key === 'host') {
      flush();
      current = {
        aliases: val.split(/\s+/).filter(Boolean),
        hostname: '',
        port: 22,
        user: '',
        identityFile: '',
        proxyJump: '',
      };
    } else if (current) {
      if (key === 'hostname') current.hostname = val;
      else if (key === 'port') current.port = Number(val) || 22;
      else if (key === 'user') current.user = val;
      else if (key === 'proxyjump') current.proxyJump = val;
      else if (key === 'identityfile' && !current.identityFile) {
        current.identityFile = val.replace(/^~(?=$|[\\/])/, os.homedir());
      }
    }
  }
  flush();
  return results;
}

export function readLocalSshConfig(sshConfigPath = path.join(os.homedir(), '.ssh', 'config')) {
  try {
    if (!fs.existsSync(sshConfigPath)) return [];
    const content = fs.readFileSync(sshConfigPath, 'utf8');
    return parseSshConfig(content);
  } catch {
    return [];
  }
}
