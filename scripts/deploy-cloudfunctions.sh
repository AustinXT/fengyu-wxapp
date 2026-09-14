#!/usr/bin/env bash
# 部署云函数到当前 active env
# 处理：
#   - 部署前【强制按 .active 重新渲染 cloudbaserc】→ 保证 cloudbaserc.json 的 envId 指向目标环境
#   - 渲染后【校验 envId + PG 端口与 .active 一致】→ 不一致直接中止（防 dev 配置误推 prod）
#   - 渲染后【扫描占位符】→ 仍含 <待用户提供…>/PLACEHOLDER 的 env 给出告警
#   - tcb 双账号切换（staff/client 各自登录）
#   - prod 强制 confirm prompt
#   - tcb env list 校验目标 env 可见
#
# ⚠️ envId 的来源：tcb 3.x 的 `fn code update` 【不接受 --envId 参数】，它从【当前工作目录的
#    cloudbaserc.json 读取 envId】来决定部署到哪个环境。因此本脚本对每个函数都先 `cd` 进对应
#    子项目目录（fengyu-staff / fengyu-client），再执行 `tcb fn code update <fn>`。
#    → 重渲染 + envId 校验是关键安全闸：若 cloudbaserc.json 是 dev 渲染态（envId=dev），
#      `fn code update` 会把代码部署到 dev 环境而非 prod。envId 错 = 代码进错环境。
#    注意：`tcb fn code update` 会把 cloudbaserc.json 的 envVariables 一并推送覆盖。
#    代码更新后，本脚本再通过 SCF API 对指定变量执行“读取→合并→回读验证”，
#    避免 `tcb config update` 3.0.1 的键名损坏问题，也不会覆盖未纳入模板的变量。
#
# Usage: scripts/deploy-cloudfunctions.sh [client|staff|all] [--yes]
#   client → 只部 clientApi + payNotify（client 账号 / CLIENT_ENV_ID）
#   staff  → 只部 staffApi（staff 账号 / STAFF_ENV_ID）
#   all    → 三个函数都部（默认）
#   --yes  → 跳过 prod confirm（位置任意）

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── 参数解析（target + --yes，顺序无关）──
TARGET=all
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    client|staff|all) TARGET="$arg" ;;
    --yes|-y)         ASSUME_YES=1 ;;
    *) echo "ERROR: unknown arg '$arg'. Usage: $0 [client|staff|all] [--yes]" >&2; exit 1 ;;
  esac
done
DO_STAFF=0; DO_CLIENT=0
[[ "$TARGET" == "staff"  || "$TARGET" == "all" ]] && DO_STAFF=1
[[ "$TARGET" == "client" || "$TARGET" == "all" ]] && DO_CLIENT=1

if [[ ! -f "$ROOT/envs/.active" ]]; then
  echo "ERROR: envs/.active not found. Run scripts/use-env.sh <env> first." >&2
  exit 1
fi
ACTIVE=$(cat "$ROOT/envs/.active")

# ── .active 白名单：只允许 dev / prod ──
# 独立 test 环境已于 2026-09-01 退役。若 .active 残留 'test' 且本地仍有 envs/test.env，
# 由于 test.env 的 PG host 与 dev 同为 101，PG 校验会误判通过，而它的 envId 复用 prod ——
# 结果是把 dev 的 PG 变量推进 prod CloudBase（2026-05-26 跨环境污染事故的同族路径）。
if [[ ! "$ACTIVE" =~ ^(dev|prod)$ ]]; then
  echo "ERROR: envs/.active='$ACTIVE' 不在白名单（只允许 dev / prod）。请先执行 scripts/use-env.sh <dev|prod>。" >&2
  exit 1
fi

if [[ ! -f "$ROOT/envs/$ACTIVE.env" ]]; then
  echo "ERROR: envs/$ACTIVE.env not found." >&2
  exit 1
fi

# 解析 envId（不 source 整个 .env，避免污染当前 shell）
STAFF_ENV_ID=$(grep -E '^STAFF_ENV_ID=' "$ROOT/envs/$ACTIVE.env" | head -1 | cut -d= -f2)
CLIENT_ENV_ID=$(grep -E '^CLIENT_ENV_ID=' "$ROOT/envs/$ACTIVE.env" | head -1 | cut -d= -f2)

if [[ -z "$STAFF_ENV_ID" || -z "$CLIENT_ENV_ID" ]]; then
  echo "ERROR: STAFF_ENV_ID / CLIENT_ENV_ID missing in envs/$ACTIVE.env" >&2
  exit 1
fi

# `fn code update` uploads local code verbatim and these functions set
# installDependency=false. Refuse to deploy a package with unresolved runtime deps.
assert_function_dependencies() {  # $1=relative function directory  $2=function name
  local function_dir="$ROOT/$1"
  local function_name="$2"

  if [[ ! -d "$function_dir/node_modules" ]]; then
    echo "ERROR: $function_name/node_modules missing. Run 'npm ci' in $1 before deploying." >&2
    exit 1
  fi

  if ! (
    cd "$function_dir"
    node -e '
      const path = require("path")
      const pkg = require("./package.json")
      const nodeModules = path.resolve("node_modules") + path.sep
      const missing = []
      for (const name of Object.keys(pkg.dependencies || {})) {
        try {
          const resolved = require.resolve(name)
          if (!resolved.startsWith(nodeModules)) missing.push(name)
        } catch {
          missing.push(name)
        }
      }
      if (missing.length > 0) {
        console.error(`Unresolved runtime dependencies: ${missing.join(", ")}`)
        process.exit(1)
      }
    '
  ); then
    echo "ERROR: $function_name runtime dependencies are incomplete. Run 'npm ci' in $1 before deploying." >&2
    exit 1
  fi

  echo "  ✓ $function_name runtime dependencies ready"
}

[[ "$DO_STAFF" == "1" ]] && assert_function_dependencies fengyu-staff/cloudfunctions/staffApi staffApi
if [[ "$DO_CLIENT" == "1" ]]; then
  assert_function_dependencies fengyu-client/cloudfunctions/clientApi clientApi
  assert_function_dependencies fengyu-client/cloudfunctions/payNotify payNotify
fi

# 防呆：prod 强制 confirm（仅列出本次实际部署的目标）
if [[ "$ACTIVE" == "prod" && "$ASSUME_YES" != "1" ]]; then
  echo "⚠️  About to deploy to PROD (target=$TARGET):"
  [[ "$DO_STAFF"  == "1" ]] && echo "    staffApi              → $STAFF_ENV_ID"
  [[ "$DO_CLIENT" == "1" ]] && echo "    clientApi + payNotify → $CLIENT_ENV_ID"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── 强制按 .active 重新渲染，保证 cloudbaserc 的 envId 指向目标环境（防代码误推 dev）──
# render 脚本总是同时渲染 client + staff 两侧；只部一侧时另一侧的渲染产物不会被部署，无害。
echo "==> Re-rendering cloudbaserc from .active=$ACTIVE （保证 envId 指向正确环境）"
node "$ROOT/scripts/render-cloudbaserc.mjs" "$ACTIVE"

# ── 一致性校验：envId 必须匹配 .active 的 env-id；PG host(IP) 必须匹配环境
#    （所有环境均用 5433 端口 + fengyu_wxapp 库名，只能靠 IP 区分。
#     2026-09-01 起 dev 迁入 sqlserver101，与 test 同库：dev=test=101.34.242.103；
#     prod=118.178.196.26。旧的 ali-demo 47.113.202.7 已弃用，不再是任何环境的目标。）──
EXPECT_PG_HOST=$([[ "$ACTIVE" == "prod" ]] && echo "118.178.196.26" || echo "101.34.242.103")
assert_rc() {  # $1=side 目录  $2=期望 envId
  local f="$ROOT/$1/cloudbaserc.json"
  [[ -f "$f" ]] || { echo "ERROR: $f 缺失（渲染失败）。中止。" >&2; exit 1; }
  local got_env got_host
  got_env=$(node -e "console.log(require('$f').envId||'')")
  if [[ "$got_env" != "$2" ]]; then
    echo "ERROR: $1/cloudbaserc.json envId=$got_env ≠ 期望 $2（.active=$ACTIVE 渲染异常）。中止。" >&2; exit 1
  fi
  got_host=$(node -e "const c=require('$f');const fn=(c.functions||[]).find(x=>(x.envVariables||{}).PG_CONNECTION_STRING);const s=fn&&fn.envVariables.PG_CONNECTION_STRING;const m=s&&s.match(/@([^:]+):\d+\//);console.log(m?m[1]:'')")
  if [[ -n "$got_host" && "$got_host" != "$EXPECT_PG_HOST" ]]; then
    echo "ERROR: $1 的 PG host=$got_host ≠ ${ACTIVE} 期望 ${EXPECT_PG_HOST}（env 值与环境不符，疑似跨环境污染）。中止。" >&2; exit 1
  fi
}
[[ "$DO_STAFF"  == "1" ]] && assert_rc fengyu-staff  "$STAFF_ENV_ID"
[[ "$DO_CLIENT" == "1" ]] && assert_rc fengyu-client "$CLIENT_ENV_ID"
echo "  ✓ envId + PG host 校验通过（${ACTIVE}）"

# ── 占位符扫描：渲染后仍含占位符的 env 给出告警（不中止，部分占位是预期的，如 prod 未填的 SM4）──
SCAN_FILES=()
[[ "$DO_STAFF"  == "1" ]] && SCAN_FILES+=("$ROOT/fengyu-staff/cloudbaserc.json")
[[ "$DO_CLIENT" == "1" ]] && SCAN_FILES+=("$ROOT/fengyu-client/cloudbaserc.json")
PLACEHOLDERS=$(grep -ohE '<待用户提供[^>]*>|[A-Za-z0-9_.-]*PLACEHOLDER[A-Za-z0-9_.-]*' "${SCAN_FILES[@]}" 2>/dev/null | sort -u || true)
if [[ -n "$PLACEHOLDERS" ]]; then
  echo "⚠️  注意：cloudbaserc 仍含以下占位符，将原样上传到 [$ACTIVE]，请确认是否预期："
  echo "$PLACEHOLDERS" | sed 's/^/      /'
fi

# ── 步骤计数（staff=1 步 / client=2 步）──
TOTAL=0
[[ "$DO_STAFF"  == "1" ]] && TOTAL=$((TOTAL + 1))
[[ "$DO_CLIENT" == "1" ]] && TOTAL=$((TOTAL + 2))
STEP=0

# --- staff side ---
if [[ "$DO_STAFF" == "1" ]]; then
  STEP=$((STEP + 1))
  echo "==> [$STEP/$TOTAL] Deploy staffApi → $STAFF_ENV_ID"
  cd "$ROOT/fengyu-staff"
  set -a; source .env 2>/dev/null || true; set +a
  if [[ -z "${TENCENTCLOUD_SECRETID:-}" || -z "${TENCENTCLOUD_SECRETKEY:-}" ]]; then
    echo "ERROR: fengyu-staff/.env missing TENCENTCLOUD_SECRETID/SECRETKEY" >&2
    exit 1
  fi
  tcb logout >/dev/null 2>&1 || true
  tcb login -k --apiKeyId "$TENCENTCLOUD_SECRETID" --apiKey "$TENCENTCLOUD_SECRETKEY" >/dev/null
  if ! tcb env list 2>/dev/null | grep -q "$STAFF_ENV_ID"; then
    echo "ERROR: staff 账号看不到 ${STAFF_ENV_ID}（tcb env list 未列出）。" >&2
    echo "  检查：fengyu-staff/.env 的 TENCENTCLOUD_SECRETID 是 staff 账号子号" >&2
    exit 1
  fi
  # envId 取自 cwd（已 cd fengyu-staff）的 cloudbaserc.json；tcb 3.x 不接受 --envId
  tcb fn code update staffApi
  node "$ROOT/scripts/sync-cloudfunction-env.mjs" "$ROOT/fengyu-staff/cloudbaserc.json" staffApi \
    --sync CLIENT_SECRET \
    --require PG_CONNECTION_STRING,CLIENT_SECRET,CLIENT_APPSECRET,WXACODE_ENV_VERSION
  echo "  ✓ staffApi deployed"
fi

# --- client side（clientApi + payNotify 同属 CLIENT_ENV_ID）---
if [[ "$DO_CLIENT" == "1" ]]; then
  cd "$ROOT/fengyu-client"
  unset TENCENTCLOUD_SECRETID TENCENTCLOUD_SECRETKEY  # 清空可能残留的 staff 账号 secrets
  set -a; source .env 2>/dev/null || true; set +a
  if [[ -z "${TENCENTCLOUD_SECRETID:-}" || -z "${TENCENTCLOUD_SECRETKEY:-}" ]]; then
    echo "ERROR: fengyu-client/.env missing TENCENTCLOUD_SECRETID/SECRETKEY" >&2
    exit 1
  fi
  tcb logout >/dev/null 2>&1 || true
  tcb login -k --apiKeyId "$TENCENTCLOUD_SECRETID" --apiKey "$TENCENTCLOUD_SECRETKEY" >/dev/null
  if ! tcb env list 2>/dev/null | grep -q "$CLIENT_ENV_ID"; then
    echo "ERROR: client 账号看不到 ${CLIENT_ENV_ID}。" >&2
    echo "  检查：fengyu-client/.env 的 TENCENTCLOUD_SECRETID 是 client 账号子号" >&2
    exit 1
  fi
  # envId 取自 cwd（fengyu-client）的 cloudbaserc.json；clientApi 与 payNotify 共用同一 env
  STEP=$((STEP + 1))
  echo "==> [$STEP/$TOTAL] Deploy clientApi → $CLIENT_ENV_ID"
  tcb fn code update clientApi
  node "$ROOT/scripts/sync-cloudfunction-env.mjs" "$ROOT/fengyu-client/cloudbaserc.json" clientApi \
    --sync CLIENT_SECRET \
    --require PG_CONNECTION_STRING,TMAP_KEY,TMAP_SECRET,CLIENT_SECRET
  echo "  ✓ clientApi deployed"

  STEP=$((STEP + 1))
  echo "==> [$STEP/$TOTAL] Deploy payNotify → $CLIENT_ENV_ID"
  tcb fn code update payNotify
  node "$ROOT/scripts/sync-cloudfunction-env.mjs" "$ROOT/fengyu-client/cloudbaserc.json" payNotify \
    --sync CLIENT_SECRET \
    --require PG_CONNECTION_STRING,CLIENT_SECRET
  echo "  ✓ payNotify deployed"
fi

echo ""
echo "==> Done (target=$TARGET)。请在 CloudBase 控制台验证环境变量正确。"
[[ "$DO_STAFF"  == "1" ]] && echo "    staff:  https://console.cloud.tencent.com/tcb/scf?envId=$STAFF_ENV_ID"
[[ "$DO_CLIENT" == "1" ]] && echo "    client: https://console.cloud.tencent.com/tcb/scf?envId=$CLIENT_ENV_ID"

# 兜底正常退出：末尾 `[[ ]] && echo` 在 target≠all 时会因条件 false 短路返回 1，否则会污染脚本退出码（部署成功却 exit 1）
exit 0
