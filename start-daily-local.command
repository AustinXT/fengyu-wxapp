#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "凤御日报本地后台"
echo "项目目录：$ROOT_DIR"
echo "数据库：日报独立库（101.34.242.103:8151/fengyu_daily_dev）"
echo "地址：http://localhost:3010"
echo ""
echo "正在启动，请保持此窗口打开；按 Ctrl+C 停止。"

npm --prefix fengyu-admin run dev:daily
