$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $scriptDir 'bin\claude-vps.js'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '未找到 Node.js，请先安装 Node.js 20+' -ForegroundColor Red
    Read-Host '按回车退出' | Out-Null
    exit 1
}

& $node.Source $entry @args
exit $LASTEXITCODE
