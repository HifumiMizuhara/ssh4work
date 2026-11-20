#!/usr/bin/env node
import { ClaudeVpsApp } from '../src/app.js';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`claude-vps - SSH 终端 TUI 启动器 (支持触控 & Claude Code 会话管理)

用法:
  claude-vps [--config <path>]

选项:
  --config <path>  指定 VPS 配置文件路径 (默认: ~/.claude-vps/profiles.json)
  -h, --help       显示帮助信息
`);
  process.exit(0);
}

let configPath;
const cfgIdx = args.indexOf('--config');
if (cfgIdx >= 0 && args[cfgIdx + 1]) {
  configPath = args[cfgIdx + 1];
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('请在交互式终端 (TTY) 中运行 claude-vps');
  process.exit(1);
}

const app = new ClaudeVpsApp({ configPath });
app.start();
