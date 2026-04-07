#!/bin/bash
set -e

BRANCH=$1
DIR=".tree/$BRANCH"

if [ -z "$BRANCH" ]; then
  echo "用法: $0 <分支名>"
  echo "示例: $0 feat/order-refactor"
  exit 1
fi

# 创建 worktree
git worktree add "$DIR" -b "$BRANCH" 2>/dev/null || git worktree add "$DIR" "$BRANCH"

# 复制 .env 文件（不覆盖已有）
for f in fengyu-admin/.env.local fengyu-client/.env fengyu-staff/.env db/.env; do
  cp -n "$f" "$DIR/$f" 2>/dev/null || true
done

echo "✓ Worktree 已创建: $DIR"
echo ""
echo "使用方式:"
echo "  cd $DIR && claude"
echo ""
echo "按需安装依赖:"
echo "  cd $DIR/fengyu-admin && bun install"
echo "  cd $DIR/db && npm install"
echo ""
echo "完成后清理:"
echo "  git worktree remove $DIR"
