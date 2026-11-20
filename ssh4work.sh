#!/bin/sh
# Linux / macOS launcher for ssh4work
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 20+" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/bin/ssh4work.js" "$@"
