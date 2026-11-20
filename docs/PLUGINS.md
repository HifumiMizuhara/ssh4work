# ssh4work 插件系统与开发指南

`ssh4work` 采用**插件化架构**管理远程开发工具与 AI 编程助手。核心底座只负责 **纯 SSH 连接、多服务器标签页、远程目录浏览与内存级剪贴板直通**；各类 AI CLI（Claude Code、Codex、Antigravity、Pi、OpenCode）以及自定义远程运维/开发指令集均以插件形式按需启用，互不干扰。

---

## 目录

- [1. 插件管理操作指南](#1-插件管理操作指南)
  - [全局安装、启停与卸载](#全局安装启停与卸载)
  - [按服务器独立控制插件权限](#按服务器独立控制插件权限)
- [2. 内置插件一览与远程路径约定](#2-内置插件一览与远程路径约定)
- [3. 编写自定义本地插件 (`plugin.json`)](#3-编写自定义本地插件-pluginjson)
  - [清单字段规范](#清单字段规范)
  - [安装与更新自定义插件](#安装与更新自定义插件)
  - [实战示例](#实战示例)
- [4. 配置存储结构](#4-配置存储结构)
- [5. 二次开发：新增内置远程开发插件](#5-二次开发新增内置远程开发插件)

---

## 1. 插件管理操作指南

在主界面顶部点击 **`[🧩 插件]`**（或在服务器列表 / 目录页按 `l` 键）即可打开插件管理中心。

### 全局安装、启停与卸载

| 操作 | 快捷键 | 界面按钮 | 说明 |
| :--- | :--- | :--- | :--- |
| 选择插件 | `↑` / `↓` | 单击行 | 移动高亮光标 |
| 安装 / 更新 / 启停 | `Enter` / `Space` | `[✓ 安装/启停]` / `[⬆ 更新]` | 未安装插件自动下载并启用；有新版本时执行更新；已安装插件切换启停状态 |
| 同步远端插件源 | `f` | `[🔄 同步]` | 从插件仓库实时发现新插件并检测已安装插件的版本更新 |
| 设置自定义插件源 | `r` | `[🌐 源设置]` | 配置 GitHub 仓库（如 `is-hp-is-mad/ssh4work-plugins`）或自定义 `registry.json` URL |
| 本地安装自定义插件 | `i` | `[📦 本地]` | 输入本地 `plugin.json` 文件路径或其所在目录路径 |
| 服务器权限配置 | `s` / `c` | `[⚙ 权限]` | 打开该插件的逐服务器启用/禁用矩阵 |
| 卸载插件 | `d` / `Delete` | `[✕ 卸载]` | 移除安装状态；自定义/远端插件还会从 `plugins.custom` 中移除 |
| 关闭弹窗 | `Esc` | `[关闭]` | 返回主界面 |

### 按服务器独立控制插件权限

不同 VPS 上安装的开发工具可能不同（例如 A 机只装了 Claude Code，B 机只装了 Codex）。

1. 在插件列表中选中目标插件，按 `s`（或点击 **`[⚙ 服务器权限]`**）进入服务器权限配置窗口。
2. 使用 `Enter` / `Space` 或点击某台服务器，即可切换该服务器上此插件的启用状态（`[✓ 已启用]` / `[⊘ 已禁用]`）。
3. 也可点击 **`[✓ 全部启用]`** 或 **`[⊘ 全部禁用]`** 批量操作。
4. 被某台服务器禁用的插件：
   - 该插件自带的 `quickCommands` 不会出现在该服务器的快捷指令栏中；
   - 切换到该插件对应的顶部标签页时，会自动跳过已禁用该插件的服务器。

也可以直接在「编辑服务器」表单的 **`禁用插件 (逗号分隔ID)`** 字段中手动填写（如 `codex-cli, pi-cli`）。

---

## 2. 内置插件一览与远程路径约定

所有内置插件均由 [`src/plugins.js`](../src/plugins.js) 定义，远程探针通过 [`src/remote.js`](../src/remote.js) 以纯内存 `python3 -` 管道执行，不在 VPS 落盘任何脚本。

| 插件 ID | 名称 | 顶部 Tab (`id`) | 远程会话路径 | 远程配置管理路径 |
| :--- | :--- | :--- | :--- | :--- |
| `claude-code` | **Claude Code 助手** | `Claude Code` (`sessions`) | `~/.claude/projects/*/*.jsonl` | 全局提示词：`~/.claude/CLAUDE.md`<br>分项目 Memory：`~/.claude/projects/*/memory/*.md`<br>Skills：`~/.claude/skills/`<br>MCP：`~/.claude.json` (`mcpServers`) |
| `codex-cli` | **Codex CLI 助手** | `Codex` (`codex`) | `~/.codex/sessions/*/*/*/rollout-*.jsonl` | 全局提示词：`~/.codex/AGENTS.md`<br>Skills：`~/.codex/skills/`<br>MCP：`~/.codex/config.toml` (`[mcp_servers.*]`) |
| `antigravity-cli` | **Antigravity CLI (AGY)** | `AGY` (`agy`) | `~/.gemini/antigravity-cli/brain/*/transcript.jsonl`<br>`~/.gemini/antigravity/brain/*/transcript.jsonl` | 全局提示词：`~/.gemini/GEMINI.md`<br>Skills：`~/.gemini/skills/`, `~/.gemini/antigravity/skills/`<br>MCP：`~/.gemini/antigravity/mcp_config.json` (`mcpServers`) |
| `pi-cli` | **Pi Agent 助手** | `Pi` (`pi`) | `~/.pi/agent/sessions/**/*.jsonl`<br>`~/.pi/sessions/**/*.jsonl` | 全局提示词：`~/.pi/agent/AGENTS.md`<br>Skills：`~/.pi/agent/skills/`<br>MCP：`~/.pi/agent/mcp.json` (`mcpServers`) |
| `opencode-cli` | **OpenCode 助手** | `OpenCode` (`opencode`) | `~/.local/share/opencode/storage/session/**/*.json*`<br>`~/.opencode/sessions/**/*.json*` | 全局提示词：`~/.config/opencode/AGENTS.md`<br>Skills：`~/.config/opencode/skills/`<br>MCP：`~/.config/opencode/opencode.json` (`mcp`) |

> **Claude Code 专属增强能力**：
> - 支持 `--fork-session` 分叉恢复会话；
> - 支持「按当前目录过滤」会话；
> - 内置 **Token 统计面板 (`t`)**：基于 `cc-switch` 模型计费表自动计算输入/输出/缓存读取/缓存创建成本（USD）、缓存命中率、TTFT 首字延迟、生成速率（`tok/s`），支持按小时/按天/按模型/按请求路由聚合，并高亮标红「请求模型 ≠ 实际响应模型」的差异路由。

---

## 3. 编写自定义本地插件 (`plugin.json`)

通过编写 `plugin.json` 清单文件，您可以把常用的远程开发、服务监控、容器运维或构建部署命令封装为可复用的插件包。

### 清单字段规范

```json
{
  "id": "my-remote-kit",
  "name": "我的远程开发工具箱",
  "version": "1.0.0",
  "author": "is-hp-is-mad",
  "description": "常用远程开发与运维快捷指令集",
  "quickCommands": [
    {
      "id": "cmd-unique-id",
      "name": "显示名称",
      "command": "实际在远程 Shell 执行的命令",
      "dir": "~"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `id` | `string` | **是** | 插件唯一标识符（建议小写字母与连字符，如 `docker-devops`）。不可与内置插件 ID 冲突。 |
| `name` | `string` | 否 | 插件显示名称，缺省时回退为 `id`。 |
| `version` | `string` | 否 | 语义化版本号，默认 `"1.0.0"`。 |
| `author` | `string` | 否 | 作者名称，默认 `"custom"`。 |
| `description` | `string` | 否 | 插件功能简述，显示在插件中心列表中。 |
| `quickCommands` | `Array<Object>` | 否 | 注入到服务器快捷指令面板（及目录页快捷启动）的命令列表。 |
| `quickCommands[].id` | `string` | 推荐 | 指令唯一 ID。 |
| `quickCommands[].name` | `string` | **是** | 在 UI 列表与终端标签页标题中显示的名称。 |
| `quickCommands[].command` | `string` | **是** | 通过远程交互式登录 Shell（`"$SHELL" -lic`）执行的命令；执行前会自动附加内存剪贴板垫片（`xclip`/`wl-paste`）和服务器的 `preCommand`。 |
| `quickCommands[].dir` | `string` | 否 | 默认工作目录（如 `"~"`、`"/srv/app"`）；留空则使用当前服务器配置目录或当前浏览目录。 |
| `tab` | `Object \| null` | 否 | 可选顶部标签页定义 `{ "id": "...", "label": "...", "agentType": "..." }`。**注意**：自定义视图标签页目前仅绑定内置 `agentType`（`claude` / `codex` / `agy` / `pi` / `opencode`）；纯命令集插件请省略 `tab` 或设为 `null`。 |

### 安装与更新自定义插件

1. 按 `l` 打开插件管理中心，按 `i`（或点击 **`[📦 本地安装]`**）。
2. 输入 `plugin.json` 的完整路径，或包含 `plugin.json` 的文件夹路径（程序会自动寻找 `<dir>/plugin.json`）。
3. **更新插件**：修改 `plugin.json` 后用相同路径重新安装一次即可原地覆盖更新，不会丢失已配置的服务器禁用列表。

### 实战示例

#### 示例 A：远程 Docker & 容器运维工具箱

```json
{
  "id": "docker-devops",
  "name": "Docker 远程运维",
  "version": "1.0.0",
  "author": "ssh4work",
  "description": "容器状态、实时资源监控与日志追踪快捷指令",
  "quickCommands": [
    {
      "id": "docker-ps",
      "name": "容器列表 (ps)",
      "command": "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'; echo; read -n 1 -s -r -p '按任意键退出...'",
      "dir": "~"
    },
    {
      "id": "docker-stats",
      "name": "容器实时资源",
      "command": "docker stats",
      "dir": "~"
    },
    {
      "id": "compose-ps",
      "name": "Compose 服务状态",
      "command": "docker compose ps; echo; read -n 1 -s -r -p '按任意键退出...'",
      "dir": ""
    }
  ]
}
```

#### 示例 B：远程开发工作流（Tmux + Git + 系统监控）

```json
{
  "id": "remote-dev-kit",
  "name": "远程开发工作流",
  "version": "1.0.0",
  "author": "ssh4work",
  "description": "Tmux 会话接入、Git 状态巡检与 btop/htop 系统监控",
  "quickCommands": [
    {
      "id": "tmux-attach",
      "name": "接入/新建 Tmux",
      "command": "tmux attach || tmux new -s dev",
      "dir": ""
    },
    {
      "id": "sys-top",
      "name": "系统监控 (btop/htop)",
      "command": "command -v btop >/dev/null && btop || htop || top",
      "dir": "~"
    },
    {
      "id": "git-lazy",
      "name": "Lazygit",
      "command": "lazygit",
      "dir": ""
    }
  ]
}
```

> **提示**：由于快捷指令在内嵌式 `VirtualTerminal` 标签页中运行，支持完整交互式全屏 TUI 程序（如 `tmux`、`htop`、`btop`、`lazygit`、`vim`、`docker stats`）；对于一次性打印命令（如 `docker ps`），可在末尾加上 `read -n 1 -s -r` 暂停查看输出。

---

## 4. 配置存储结构

插件状态持久化在本地配置文件 `~/.claude-vps/profiles.json`（或 `--config` / `CLAUDE_VPS_CONFIG` 指定路径）中：

```json
{
  "version": 1,
  "activeProfileId": "...",
  "settings": { ... },
  "plugins": {
    "installed": ["claude-code", "docker-devops"],
    "enabled": ["claude-code", "docker-devops"],
    "custom": [
      {
        "id": "docker-devops",
        "name": "Docker 远程运维",
        "version": "1.0.0",
        "author": "ssh4work",
        "description": "...",
        "tab": null,
        "quickCommands": [ ... ]
      }
    ]
  },
  "profiles": [
    {
      "id": "...",
      "name": "Prod-VPS",
      "disabledPlugins": ["docker-devops"]
    }
  ]
}
```

---

## 5. 二次开发：新增内置远程开发插件

如果你希望为社区贡献一个新的内置插件（例如新的 AI Coding CLI 或远程 DevContainer / Tmux 管理面板），只需修改以下 3 个文件：

1. **[`src/plugins.js`](../src/plugins.js)**：
   - 在 `BUILTIN_PLUGINS` 数组中注册插件元数据、`tab`（定义 `id`、`label`、`agentType`）与默认 `quickCommands`。
2. **[`src/remote.js`](../src/remote.js)**：
   - 在 `MULTI_AGENT_PY` 中补充对应 `agentType` 的远程会话扫描与预览逻辑；
   - 在 `AGENT_CFG_PY` 的 `PROMPT_PATHS`、`SKILL_DIRS`、`MCP_PATHS` 中登记其全局提示词、Skills 与 MCP 配置文件路径。
3. **[`src/app.js`](../src/app.js)**：
   - 在 `isAgentTab()` 与 `getAgentTypeForTab()` 中加入新的 `tab.id` 与 `agentType` 映射；
   - 如有专属快捷操作，在 `renderSessions()` / `renderActionBar()` 中按 `agentType` 扩展即可。
