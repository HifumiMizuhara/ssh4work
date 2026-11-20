import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver } from './plugins.js';

export const APP_REPO = 'is-hp-is-mad/ssh4work';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT_DIR = path.resolve(__dirname, '..');

export function getCurrentVersion(rootDir = APP_ROOT_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0').trim();
  } catch {
    return '0.0.0';
  }
}

/**
 * Check GitHub Releases (with raw package.json fallback) for a newer version of ssh4work.
 */
export async function checkForAppUpdate({
  repo = APP_REPO,
  currentVersion = getCurrentVersion(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      releaseUrl: `https://github.com/${repo}/releases`,
      releaseNotes: '',
      error: '当前 Node 环境不支持 fetch',
    };
  }

  const fetchJson = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'ssh4work', Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) return { ok: false, status: resp.status, data: null };
      return { ok: true, status: resp.status, data: await resp.json() };
    } catch (err) {
      return { ok: false, status: 0, error: err?.name === 'AbortError' ? '请求超时' : err?.message || '网络错误' };
    } finally {
      clearTimeout(timer);
    }
  };

  const relRes = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  if (relRes.ok && relRes.data) {
    const tag = String(relRes.data.tag_name || relRes.data.name || '').trim();
    const latestVersion = tag.replace(/^v/i, '');
    if (latestVersion) {
      return {
        ok: true,
        currentVersion,
        latestVersion,
        tagName: tag,
        hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
        releaseUrl: relRes.data.html_url || `https://github.com/${repo}/releases`,
        releaseNotes: String(relRes.data.body || '').trim(),
        publishedAt: relRes.data.published_at || '',
        error: '',
      };
    }
  }

  // Fallback to main branch package.json when no Release exists or API is rate-limited
  const pkgRes = await fetchJson(`https://raw.githubusercontent.com/${repo}/main/package.json`);
  if (pkgRes.ok && pkgRes.data?.version) {
    const latestVersion = String(pkgRes.data.version).trim().replace(/^v/i, '');
    return {
      ok: true,
      currentVersion,
      latestVersion,
      tagName: `v${latestVersion}`,
      hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
      releaseUrl: `https://github.com/${repo}/releases`,
      releaseNotes: '',
      publishedAt: '',
      error: '',
    };
  }

  return {
    ok: false,
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    releaseUrl: `https://github.com/${repo}/releases`,
    releaseNotes: '',
    error: relRes.error || pkgRes.error || `检查更新失败 (HTTP ${relRes.status || pkgRes.status || 0})`,
  };
}

/**
 * Upgrade the local ssh4work installation (git pull + npm link for cloned repos, or npm install -g).
 */
export function performAppUpgrade({ repo = APP_REPO, installDir = APP_ROOT_DIR } = {}) {
  const previousVersion = getCurrentVersion(installDir);
  const isGitRepo = fs.existsSync(path.join(installDir, '.git'));
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  if (isGitRepo) {
    const dirty = spawnSync('git', ['-C', installDir, 'status', '--porcelain'], { encoding: 'utf8' });
    if (dirty.status === 0 && dirty.stdout.trim()) {
      return {
        ok: false,
        method: 'git',
        previousVersion,
        newVersion: previousVersion,
        error: `本地仓库存在未提交的修改，请先处理后再升级 (${installDir})`,
      };
    }

    const pull = spawnSync('git', ['-C', installDir, 'pull', '--ff-only', 'origin', 'main'], {
      encoding: 'utf8',
    });
    if (pull.status !== 0) {
      return {
        ok: false,
        method: 'git',
        previousVersion,
        newVersion: previousVersion,
        error: (pull.stderr || pull.stdout || 'git pull 失败').trim(),
      };
    }

    // Refresh global npm link if ssh4work is linked from this directory
    spawnSync(npmCmd, ['link'], { cwd: installDir, encoding: 'utf8', shell: process.platform === 'win32' });

    const newVersion = getCurrentVersion(installDir);
    return {
      ok: true,
      method: 'git',
      previousVersion,
      newVersion,
      output: (pull.stdout || '').trim(),
      error: '',
    };
  }

  const install = spawnSync(npmCmd, ['install', '-g', `git+https://github.com/${repo}.git`], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) {
    return {
      ok: false,
      method: 'npm',
      previousVersion,
      newVersion: previousVersion,
      error: (install.stderr || install.stdout || 'npm 全局升级失败').trim(),
    };
  }
  const newVersion = getCurrentVersion(installDir);
  return {
    ok: true,
    method: 'npm',
    previousVersion,
    newVersion,
    output: (install.stdout || '').trim(),
    error: '',
  };
}
