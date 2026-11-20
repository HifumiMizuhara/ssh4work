import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quoteSh, runRemote } from './ssh.js';

/**
 * PowerShell script that watches Windows clipboard sequence number and emits
 * `IMG:<base64>\n` whenever a new image is copied to the clipboard.
 */
const WIN_CLIP_WATCH_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$hasNative = $false
try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinClipNative {
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
}
"@
    $hasNative = $true
} catch {
    $hasNative = $false
}

function Get-ClipPngBase64 {
    if ([System.Windows.Forms.Clipboard]::ContainsData('PNG')) {
        $data = [System.Windows.Forms.Clipboard]::GetData('PNG')
        if ($data -is [System.IO.MemoryStream]) {
            return [Convert]::ToBase64String($data.ToArray())
        }
    }
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($null -ne $img) {
            $ms = New-Object System.IO.MemoryStream
            $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $img.Dispose()
            $b64 = [Convert]::ToBase64String($ms.ToArray())
            $ms.Dispose()
            return $b64
        }
    }
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        if ($files.Count -gt 0) {
            $f = $files[0]
            if ($f -match '\.(png|jpe?g|gif|bmp|webp)$' -and (Test-Path $f)) {
                $img = [System.Drawing.Image]::FromFile($f)
                if ($null -ne $img) {
                    $ms = New-Object System.IO.MemoryStream
                    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                    $img.Dispose()
                    $b64 = [Convert]::ToBase64String($ms.ToArray())
                    $ms.Dispose()
                    return $b64
                }
            }
        }
    }
    return $null
}

$lastSeq = -1
$lastHash = ''
while ($true) {
    $changed = $true
    if ($hasNative) {
        $seq = [WinClipNative]::GetClipboardSequenceNumber()
        if ($seq -eq $lastSeq) { $changed = $false }
        else { $lastSeq = $seq }
    }
    if ($changed) {
        $b64 = Get-ClipPngBase64
        if ($b64 -and ($hasNative -or $b64 -ne $lastHash)) {
            $lastHash = $b64
            [Console]::Out.WriteLine("IMG:$b64")
            [Console]::Out.Flush()
        }
    }
    Start-Sleep -Milliseconds 800
}
`;

const WIN_CLIP_ONCE_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsData('PNG')) {
    $data = [System.Windows.Forms.Clipboard]::GetData('PNG')
    if ($data -is [System.IO.MemoryStream]) {
        [Console]::Out.Write([Convert]::ToBase64String($data.ToArray()))
        exit 0
    }
}
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($null -ne $img) {
        $ms = New-Object System.IO.MemoryStream
        $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $img.Dispose()
        [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
        $ms.Dispose()
        exit 0
    }
}
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
    if ($files.Count -gt 0) {
        $f = $files[0]
        if ($f -match '\.(png|jpe?g|gif|bmp|webp)$' -and (Test-Path $f)) {
            $img = [System.Drawing.Image]::FromFile($f)
            if ($null -ne $img) {
                $ms = New-Object System.IO.MemoryStream
                $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $img.Dispose()
                [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
                $ms.Dispose()
                exit 0
            }
        }
    }
}
exit 1
`;

const CLIP_MAX_BUFFER = 64 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function hasCommand(cmd) {
  if (process.platform === 'win32') return false;
  const res = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0;
}

let _imageBackend;

/**
 * Detect which local clipboard image backend is usable on this machine.
 * Returns 'win32' | 'darwin' | 'wayland' | 'x11' | null.
 */
export function detectClipboardImageBackend() {
  if (_imageBackend !== undefined) return _imageBackend;
  if (process.platform === 'win32') _imageBackend = 'win32';
  else if (process.platform === 'darwin') _imageBackend = 'darwin';
  else if (process.env.WAYLAND_DISPLAY && hasCommand('wl-paste')) _imageBackend = 'wayland';
  else if (process.env.DISPLAY && hasCommand('xclip')) _imageBackend = 'x11';
  else _imageBackend = null;
  return _imageBackend;
}

function osascriptPngArgs() {
  return ['-e', 'try', '-e', 'return (the clipboard as «class PNGf»)', '-e', 'end try'];
}

export function parseOsascriptPng(stdout) {
  const m = String(stdout || '').match(/«data PNGf([0-9A-Fa-f]+)»/);
  return m ? Buffer.from(m[1], 'hex') : null;
}

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 4).equals(PNG_MAGIC);
}

function runCapture(cmd, args, { asText = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > CLIP_MAX_BUFFER) child.kill();
      else chunks.push(c);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const buf = Buffer.concat(chunks);
      resolve(asText ? buf.toString('utf8') : buf);
    });
  });
}

/**
 * Asynchronously read a PNG image from the local clipboard on macOS / Linux (non-blocking).
 */
async function readClipboardPngBufferPosix(backend) {
  if (backend === 'darwin') {
    return parseOsascriptPng(await runCapture('osascript', osascriptPngArgs(), { asText: true }));
  }
  if (backend === 'wayland') {
    const types = await runCapture('wl-paste', ['--list-types'], { asText: true });
    if (!types || !/^image\/png$/m.test(types)) return null;
    const buf = await runCapture('wl-paste', ['--no-newline', '--type', 'image/png']);
    return isPng(buf) ? buf : null;
  }
  if (backend === 'x11') {
    const targets = await runCapture('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { asText: true });
    if (!targets || !/^image\/png$/m.test(targets)) return null;
    const buf = await runCapture('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
    return isPng(buf) ? buf : null;
  }
  return null;
}

/**
 * Read a PNG image from the local clipboard (Windows / macOS / Linux Wayland / Linux X11).
 */
export function readClipboardPngBuffer() {
  const backend = detectClipboardImageBackend();
  if (backend === 'win32') {
    const encoded = Buffer.from(WIN_CLIP_ONCE_PS, 'utf16le').toString('base64');
    const res = spawnSync('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const b64 = res.stdout.trim();
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
  if (backend === 'darwin') {
    const res = spawnSync('osascript', osascriptPngArgs(), { encoding: 'utf8', maxBuffer: CLIP_MAX_BUFFER, timeout: 5000 });
    return res.status === 0 ? parseOsascriptPng(res.stdout) : null;
  }
  if (backend === 'wayland') {
    const res = spawnSync('wl-paste', ['--no-newline', '--type', 'image/png'], { maxBuffer: CLIP_MAX_BUFFER, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return res.status === 0 && isPng(res.stdout) ? res.stdout : null;
  }
  if (backend === 'x11') {
    const res = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { maxBuffer: CLIP_MAX_BUFFER, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return res.status === 0 && isPng(res.stdout) ? res.stdout : null;
  }
  return null;
}

/**
 * Push a PNG buffer into VPS RAM (/dev/shm) via non-interactive SSH
 * without touching shell history or the interactive Claude PTY.
 */
export async function pushClipboardPngToRemote(profile, token, pngBuffer, settings = {}) {
  const safeToken = String(token).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeToken || !pngBuffer || pngBuffer.length === 0) return { ok: false };

  const cmd = [
    'd=$([ -d /dev/shm ] && echo /dev/shm || echo "${XDG_RUNTIME_DIR:-/tmp}")',
    'base="$d/.claude-clip-${USER:-u}"',
    'mkdir -p "$base" && chmod 700 "$base"',
    `tmp="$base/${safeToken}.png.tmp.$$"; cat > "$tmp" && mv -f "$tmp" "$base/${safeToken}.png"`,
  ].join(' && ');

  return runRemote(profile, cmd, {
    stdinData: pngBuffer,
    timeoutMs: Math.max(15000, (Number(settings.sshTimeoutSec) || 20) * 1000),
    settings,
  });
}

/**
 * Resize the remote PTY of an embedded SSH session and trigger SIGWINCH.
 */
export async function resizeRemotePty(profile, token, cols, rows, settings = {}) {
  const safeToken = String(token).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeToken) return { ok: false };
  const cmd = [
    'd=$([ -d /dev/shm ] && echo /dev/shm || echo "${XDG_RUNTIME_DIR:-/tmp}")',
    `ttyf="$d/.claude-clip-\${USER:-u}/${safeToken}.tty"`,
    't=$(cat "$ttyf" 2>/dev/null)',
    `[ -n "$t" ] && stty rows ${Math.max(4, rows)} cols ${Math.max(10, cols)} < "$t" 2>/dev/null`,
  ].join('; ');
  return runRemote(profile, cmd, { timeoutMs: 5000, settings });
}

/**
 * Generate a clean, POSIX-safe shell snippet that creates RAM shims for xclip & wl-paste.
 */
export function buildClipboardEnvAndTrap(token) {
  const safeToken = String(token).replace(/[^a-zA-Z0-9_-]/g, '');
  const shimScript = `
CLIP_ROOT=$([ -d /dev/shm ] && echo /dev/shm || echo "\${XDG_RUNTIME_DIR:-/tmp}")
CLIP_BASE="$CLIP_ROOT/.claude-clip-\${USER:-u}"
CLIP_DIR="$CLIP_BASE/${safeToken}"
CLIP_IMG="$CLIP_BASE/${safeToken}.png"
CLIP_TTY="$CLIP_BASE/${safeToken}.tty"
mkdir -p "$CLIP_DIR/bin" && chmod 700 "$CLIP_BASE"
tty 2>/dev/null > "$CLIP_TTY" || true
cat > "$CLIP_DIR/bin/xclip" << EOF_XCLIP
#!/bin/sh
case "\\$*" in
  *TARGETS*) printf 'TARGETS\\nimage/png\\n'; exit 0 ;;
  *-o*|*image/png*) [ -s "$CLIP_IMG" ] && exec cat "$CLIP_IMG"; exit 1 ;;
esac
exit 1
EOF_XCLIP
cat > "$CLIP_DIR/bin/wl-paste" << EOF_WL
#!/bin/sh
case "\\$*" in
  *--list-types*) printf 'image/png\\n'; exit 0 ;;
  *) [ -s "$CLIP_IMG" ] && exec cat "$CLIP_IMG"; exit 1 ;;
esac
EOF_WL
chmod +x "$CLIP_DIR/bin/xclip" "$CLIP_DIR/bin/wl-paste"
export CLIP_BIN="$CLIP_DIR/bin"
export PATH="$CLIP_BIN:$PATH"
export DISPLAY="\${DISPLAY:-:99}"
export WAYLAND_DISPLAY="\${WAYLAND_DISPLAY:-wayland-0}"
export PROMPT_COMMAND='case ":$PATH:" in *":$CLIP_BIN:"*) ;; *) export PATH="$CLIP_BIN:$PATH" ;; esac'
trap 'rm -rf "$CLIP_DIR" "$CLIP_IMG" "$CLIP_IMG.tmp" "$CLIP_TTY"' EXIT
`.trim();

  // Single-line safe wrapper via base64 (GNU/busybox `base64 -d`, falls back to BSD/macOS `base64 -D`)
  const b64 = Buffer.from(shimScript, 'utf8').toString('base64');
  const q = quoteSh(b64);
  return `eval "$(printf '%s' ${q} | base64 -d 2>/dev/null || printf '%s' ${q} | base64 -D)"`;
}

/**
 * Watches the local Windows clipboard for new images and silently pushes them
 * to VPS RAM (/dev/shm) over a separate non-interactive SSH channel.
 */
export class ClipboardImageSync {
  constructor(profile, settings = {}) {
    this.profile = profile;
    this.settings = settings;
    this.token = crypto.randomBytes(8).toString('hex');
    this._proc = null;
    this._buf = '';
    this._stopped = false;
    this._pushQueue = Promise.resolve();
  }

  start() {
    this._stopped = false;
    const backend = detectClipboardImageBackend();
    if (!backend) return;
    if (backend !== 'win32') {
      this._startPosixPolling(backend);
      return;
    }
    const encoded = Buffer.from(WIN_CLIP_WATCH_PS, 'utf16le').toString('base64');
    this._proc = spawn('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    this._proc.stdout.on('data', (chunk) => {
      if (this._stopped) return;
      this._buf += chunk.toString('utf8');
      if (this._buf.length > 32 * 1024 * 1024) {
        this._buf = '';
        return;
      }
      let nl;
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl).trim();
        this._buf = this._buf.slice(nl + 1);
        if (line.startsWith('IMG:')) {
          const b64 = line.slice(4);
          if (b64) {
            const png = Buffer.from(b64, 'base64');
            this._pushQueue = this._pushQueue
              .then(() => pushClipboardPngToRemote(this.profile, this.token, png, this.settings))
              .catch(() => {});
          }
        }
      }
    });

    this._proc.on('error', () => {});
  }

  /**
   * macOS / Linux: poll the clipboard asynchronously (never blocks the event loop)
   * and push only when the PNG content hash changes.
   */
  _startPosixPolling(backend) {
    let lastHash = '';
    let busy = false;
    const tick = async () => {
      if (this._stopped || busy) return;
      busy = true;
      try {
        const png = await readClipboardPngBufferPosix(backend);
        if (this._stopped || !png || png.length === 0) return;
        const hash = crypto.createHash('sha1').update(png).digest('hex');
        if (hash === lastHash) return;
        lastHash = hash;
        this._pushQueue = this._pushQueue
          .then(() => pushClipboardPngToRemote(this.profile, this.token, png, this.settings))
          .catch(() => {});
      } catch {
        // Ignore transient clipboard read errors
      } finally {
        busy = false;
      }
    };
    this._pollTimer = setInterval(tick, 1200);
    this._pollTimer.unref?.();
    tick();
  }

  async pushNow() {
    const backend = detectClipboardImageBackend();
    if (!backend) {
      return {
        ok: false,
        error: '本机未检测到图片剪贴板工具 (Linux 需安装 wl-clipboard 或 xclip)',
      };
    }
    const png = backend === 'win32' ? readClipboardPngBuffer() : await readClipboardPngBufferPosix(backend);
    if (!png || png.length === 0) {
      return { ok: false, error: '剪贴板中暂无图片' };
    }
    const task = this._pushQueue.then(() =>
      pushClipboardPngToRemote(this.profile, this.token, png, this.settings)
    );
    this._pushQueue = task.catch(() => {});
    return task;
  }

  stop() {
    this._stopped = true;
    this._buf = '';
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._proc) {
      try {
        this._proc.kill();
      } catch {
        // ignore
      }
      this._proc = null;
    }
  }
}

/**
 * Read plain text from the local system clipboard.
 */
export function readClipboardText() {
  if (process.platform === 'win32') {
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-STA', '-Command', '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-Clipboard -Raw'],
      { encoding: 'utf8', windowsHide: true }
    );
    return res.status === 0 ? String(res.stdout || '') : '';
  }
  if (process.platform === 'darwin') {
    const res = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 5000 });
    return res.status === 0 ? String(res.stdout || '') : '';
  }
  const candidates = [];
  if (process.env.WAYLAND_DISPLAY) candidates.push(['wl-paste', ['-n']]);
  if (process.env.DISPLAY) {
    candidates.push(['xclip', ['-selection', 'clipboard', '-o']]);
    candidates.push(['xsel', ['--clipboard', '--output']]);
  }
  candidates.push(['termux-clipboard-get', []]);
  for (const [cmd, args] of candidates) {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status === 0) return String(res.stdout || '');
  }
  return '';
}

/**
 * Write plain text to the local system clipboard.
 */
export function writeClipboardText(text) {
  const val = String(text ?? '');
  if (!val) return false;
  if (process.platform === 'win32') {
    const b64 = Buffer.from(val, 'utf8').toString('base64');
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-STA',
        '-Command',
        `$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`,
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    return res.status === 0;
  }
  if (process.platform === 'darwin') {
    const res = spawnSync('pbcopy', [], { input: val, encoding: 'utf8', timeout: 5000 });
    return res.status === 0;
  }
  // NOTE: wl-copy / xclip fork a background process that keeps serving the selection.
  // stdout/stderr MUST be ignored, otherwise spawnSync waits on the inherited pipe forever.
  const candidates = [];
  if (process.env.WAYLAND_DISPLAY) candidates.push(['wl-copy', []]);
  if (process.env.DISPLAY) {
    candidates.push(['xclip', ['-selection', 'clipboard']]);
    candidates.push(['xsel', ['--clipboard', '--input']]);
  }
  candidates.push(['termux-clipboard-set', []]);
  for (const [cmd, args] of candidates) {
    const res = spawnSync(cmd, args, { input: val, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
    if (res.status === 0) return true;
  }
  if (process.stdout?.isTTY) {
    const b64 = Buffer.from(val, 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    return true;
  }
  return false;
}

/**
 * Validate and normalize private key content (LF line endings + trailing newline).
 */
export function normalizePrivateKey(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return { ok: false, error: '剪贴板内容为空' };
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text) || !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) {
    return { ok: false, error: '剪贴板内容不是有效的私钥格式 (缺少 BEGIN/END PRIVATE KEY)' };
  }
  return { ok: true, content: `${text}\n` };
}

/**
 * Save a private key to the specified directory with restricted permissions for OpenSSH.
 */
export function savePrivateKeyFile(targetDir, filename, rawContent) {
  const cleanName = String(filename || '').trim();
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '.' || cleanName === '..') {
    return { ok: false, error: '文件名不合法' };
  }

  const normalized = normalizePrivateKey(rawContent);
  if (!normalized.ok) return normalized;

  const fullPath = path.join(targetDir, cleanName);
  try {
    fs.writeFileSync(fullPath, normalized.content, { encoding: 'utf8', mode: 0o600 });
    let permNote = '权限 600';
    if (process.platform === 'win32') {
      const user = os.userInfo().username;
      const icacls = spawnSync('icacls', [fullPath, '/inheritance:r', '/grant:r', `${user}:F`], {
        encoding: 'utf8',
        windowsHide: true,
      });
      permNote = icacls.status === 0 ? '已设置仅当前用户可访问' : '已保存 (请确认文件权限)';
    } else {
      fs.chmodSync(fullPath, 0o600);
    }
    return { ok: true, path: fullPath, permNote };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const PRIVATE_KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage']);

/**
 * Scan a project directory (up to maxDepth) for private key files and return relative paths.
 */
export function scanPrivateKeys(rootDir = process.cwd(), { maxDepth = 2 } = {}) {
  const results = [];

  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (SKIP_SCAN_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.ssh') continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(fullPath);
          if (st.size === 0 || st.size > 64 * 1024) continue;
          const fd = fs.openSync(fullPath, 'r');
          try {
            const buf = Buffer.alloc(Math.min(512, st.size));
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
            const head = buf.subarray(0, bytesRead).toString('utf8');
            if (PRIVATE_KEY_HEADER_RE.test(head)) {
              results.push(path.relative(rootDir, fullPath).replace(/\\/g, '/'));
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          // Ignore unreadable files
        }
      }
    }
  }

  walk(rootDir, 0);
  results.sort((a, b) => {
    const depthDiff = a.split('/').length - b.split('/').length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
  return results;
}

