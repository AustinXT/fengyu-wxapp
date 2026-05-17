#!/usr/bin/env bash
# run-staff-l3.sh — 一键切换 IDE 到 staff 项目 → 跑 L3 全套 → 切回原项目
#
# 用法：
#   ./fengyu-staff/tests/run-staff-l3.sh                    # 全套
#   ./fengyu-staff/tests/run-staff-l3.sh --filter sales    # 过滤（未来 run-all 支持时生效）
#
# 行为：
#   1. probe IDE 当前 appId
#   2. 若 != staff (wxe3f5d9ee6a94d22d)：记下原 project path → quit IDE → cli auto staff
#   3. 跑 run-all
#   4. 若 step 2 切换过：quit → cli auto 切回原 project
#
# 退出码：0 = run-all 全过；1 = run-all 有失败；2 = 环境异常

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAFF_PROJECT="$REPO_ROOT/fengyu-staff/miniprogram"
CLIENT_PROJECT="$REPO_ROOT/fengyu-client/miniprogram"
WX_CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
STAFF_APPID="wxe3f5d9ee6a94d22d"
CLIENT_APPID="wx811eb4ded3dfba3f"
PORT=9420

if [[ ! -x "$WX_CLI" ]]; then
  echo "❌ 找不到 wechatwebdevtools cli: $WX_CLI"
  exit 2
fi

# ─── 1. probe 当前 appId ───
probe_appid() {
  bun -e "
    import automator from 'miniprogram-automator';
    for (const host of ['localhost', '[::1]', '127.0.0.1']) {
      try {
        const mp = await automator.connect({ wsEndpoint: 'ws://' + host + ':$PORT' });
        const appId = await mp.evaluate(() => getApp()?.globalData?.appId || wx.getAccountInfoSync?.()?.miniProgram?.appId);
        await mp.disconnect();
        console.log(appId);
        process.exit(0);
      } catch (e) {}
    }
    process.exit(1);
  " 2>/dev/null
}

# ─── 2. 切到指定项目 ───
switch_ide() {
  local project_path="$1"
  echo "  [switch] quit IDE..."
  "$WX_CLI" quit >/dev/null 2>&1 || true
  sleep 2
  pkill -9 -f wechatwebdevtools 2>/dev/null || true
  sleep 5
  echo "  [switch] cli auto $project_path..."
  "$WX_CLI" auto --project "$project_path" --port $PORT --auto-port $PORT >/dev/null 2>&1 &
  echo "  [switch] 等 IPv6 listener..."
  until lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -q IPv6; do sleep 3; done
  echo "  [switch] IPv6 ready"
}

echo "[run-staff-l3] probe 当前 IDE appId..."
CURRENT_APPID=$(probe_appid || true)
echo "  current = ${CURRENT_APPID:-<未连通>}"

# 记下原 project 用于复原
ORIGINAL_PROJECT=""
case "$CURRENT_APPID" in
  "$STAFF_APPID")
    echo "  ✓ 已是 staff 项目，无需切换"
    ;;
  "$CLIENT_APPID")
    ORIGINAL_PROJECT="$CLIENT_PROJECT"
    echo "  当前是 client，需切到 staff（跑完会切回）"
    switch_ide "$STAFF_PROJECT"
    ;;
  "")
    echo "  IDE 未连通 / 未装载项目，直接 cli auto staff"
    switch_ide "$STAFF_PROJECT"
    ;;
  *)
    echo "  当前是未知 appId=$CURRENT_APPID（可能是 admin/其他），切到 staff（跑完不复原）"
    switch_ide "$STAFF_PROJECT"
    ;;
esac

# ─── 3. 跑 测试 ───
# 默认跑 run-all（smoke）；--scenarios 切到 run-scenarios（业务场景）
RUNNER="run-all.mjs"
RUNNER_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--scenarios" ]]; then
    RUNNER="run-scenarios.mjs"
  else
    RUNNER_ARGS+=("$arg")
  fi
done
echo ""
echo "[run-staff-l3] 跑 $RUNNER..."
bun "$REPO_ROOT/fengyu-staff/tests/e2e-miniprogram/$RUNNER" "${RUNNER_ARGS[@]+"${RUNNER_ARGS[@]}"}"
RUN_EXIT=$?

# ─── 4. 若有原项目，切回 ───
if [[ -n "$ORIGINAL_PROJECT" ]]; then
  echo ""
  echo "[run-staff-l3] 切回原项目 $ORIGINAL_PROJECT..."
  switch_ide "$ORIGINAL_PROJECT"
fi

echo ""
echo "[run-staff-l3] 完成，run-all 退出码=$RUN_EXIT"
exit $RUN_EXIT
