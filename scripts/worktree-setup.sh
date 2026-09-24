#!/bin/bash
set -e

BRANCH=$1
START=$2          # 可选 start-point；省略时基于当前 HEAD（与历史行为一致）
DIR=".tree/$BRANCH"
REPO_ROOT=$(git rev-parse --show-toplevel)

if [ -z "$BRANCH" ]; then
  echo "用法: $0 <分支名> [start-point]"
  echo "示例: $0 feat/order-refactor"
  echo "      $0 fix/issue-70-xxx origin/dev   # 强制基于 origin/dev 建分支"
  exit 1
fi

# 1. 创建 worktree（新建分支或 checkout 现有分支）
if [ -n "$START" ]; then
  git worktree add "$DIR" -b "$BRANCH" "$START" 2>/dev/null || git worktree add "$DIR" "$BRANCH"
else
  git worktree add "$DIR" -b "$BRANCH" 2>/dev/null || git worktree add "$DIR" "$BRANCH"
fi

WT_ABS="$REPO_ROOT/$DIR"

# 2. 复制 .env 文件（不覆盖已有）
for f in fengyu-admin/.env.local fengyu-client/.env fengyu-staff/.env db/.env; do
  cp -n "$f" "$DIR/$f" 2>/dev/null || true
done

# 3. 复制小程序私有配置（含 appid、devtools 设置）
for f in fengyu-client/miniprogram/project.private.config.json \
         fengyu-staff/miniprogram/project.private.config.json; do
  if [ -f "$f" ]; then
    cp -n "$f" "$DIR/$f" 2>/dev/null || true
  fi
done

# 3.5 复制本机 AI 协作配置（已 gitignore，但 issue-dev 双谱系评审闸门依赖它）
if [ -f ".claude/dev-launch.review.md" ]; then
  mkdir -p "$DIR/.claude"
  cp -n ".claude/dev-launch.review.md" "$DIR/.claude/dev-launch.review.md" 2>/dev/null || true
fi

# 4. 复制 miniprogram_npm（小程序 devtools 不识别 symlink，必须实体目录）
for d in fengyu-client/miniprogram/miniprogram_npm \
         fengyu-staff/miniprogram/miniprogram_npm; do
  if [ -d "$d" ] && [ ! -e "$DIR/$d" ]; then
    rsync -a "$d/" "$DIR/$d/"
  fi
done

# 5. 软链 node_modules（admin + db），避免 bun/npm install 等待
link_node_modules() {
  local sub=$1
  local src="$REPO_ROOT/$sub/node_modules"
  local dst="$WT_ABS/$sub/node_modules"
  if [ ! -d "$src" ]; then
    echo "⚠️  主仓 $sub/node_modules 不存在，跳过软链"
    echo "   请先在主仓运行：cd $sub && bun install  (或 npm install)"
    return
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    return  # 已存在（实体或软链），不覆盖
  fi
  ln -s "$src" "$dst"
}
link_node_modules "fengyu-admin"
link_node_modules "db"

# 6. 给 admin dev 写入专属端口，避免与主仓 3000 冲突
ADMIN_ENV="$DIR/fengyu-admin/.env.local"
if [ -f "$ADMIN_ENV" ] && ! grep -q '^PORT=' "$ADMIN_ENV"; then
  printf '\n# worktree 并行端口\nPORT=3010\n' >> "$ADMIN_ENV"
fi

# 7. 复制 admin 的 next-env.d.ts（Next.js 类型声明，被 .gitignore 忽略但 tsc 必需）
if [ -f "fengyu-admin/next-env.d.ts" ] && [ ! -f "$DIR/fengyu-admin/next-env.d.ts" ]; then
  cp "fengyu-admin/next-env.d.ts" "$DIR/fengyu-admin/next-env.d.ts"
fi

# 8. 生成 admin 的 src/generated/version.ts（被 predev/prebuild 生成，tsc 依赖）
if [ -f "fengyu-admin/scripts/gen-version.mjs" ] && [ ! -f "$DIR/fengyu-admin/src/generated/version.ts" ]; then
  (cd "$DIR/fengyu-admin" && node scripts/gen-version.mjs) || true
fi

echo ""
echo "✓ Worktree 已创建: $DIR"
echo ""
echo "已复制/链接："
echo "  .env × 4、project.private.config.json × 2、miniprogram_npm × 2"
echo "  .claude/dev-launch.review.md（双谱系评审配置）"
echo "  node_modules: fengyu-admin, db  (软链到主仓)"
echo "  admin PORT=3010 已写入 .env.local"
echo ""
echo "下一步："
echo "  cd $DIR && claude                         # 进入独立会话"
echo "  cd $DIR/fengyu-admin && bun run dev       # 端口 3010"
echo "  cd $DIR/fengyu-admin && bun run test      # 跑测试"
echo ""
echo "注意事项："
echo "  - db:migrate 与主仓互斥（共享 PG）"
echo "  - 小程序 devtools 同 appid 不能同时打开两处"
echo "  - 依赖升级前先把 node_modules 软链换成实体：rm node_modules && bun install"
echo ""
echo "完成后清理："
echo "  git worktree remove $DIR"
