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
# Usage: scripts/deploy-cloudfunctions.sh [dev|prod|both] [client|staff|all] [--yes] [--plan]
#
# 两个正交维度，顺序无关：
#
#   ① 通道（部署哪一套函数）—— 单 env 内并存两套同代码、连不同库的部署
#      dev   → 只部影子函数 clientApiDev / payNotifyDev / staffApiDev（连 dev 库）
#              **完全不碰生产函数**，因此跳过 confirm
#      prod  → 只部正式函数 clientApi / payNotify / staffApi（连 prod 库），需 confirm
#      both  → 六个都部（默认，发版场景），需 confirm
#
#   ② 端（部署哪一侧）
#      client → clientApi 系（client 账号 / CLIENT_ENV_ID）
#      staff  → staffApi 系（staff 账号 / STAFF_ENV_ID）
#      all    → 两端都部（默认）
#
#   --yes  → 跳过 confirm（位置任意）
#   --plan → 只打印部署计划与函数数后退出，不做任何改动（渲染/登录/上传都不执行）
#
# 常用：
#   ...deploy-cloudfunctions.sh dev          # 改完代码先只发 dev 验证，生产不动
#   ...deploy-cloudfunctions.sh dev staff    # 只发 staffApiDev
#   ...deploy-cloudfunctions.sh prod         # 验证通过后再发生产
#   ...deploy-cloudfunctions.sh              # 发版：六个全发
#   ...deploy-cloudfunctions.sh prod --plan  # 拿不准会动什么，先看计划
#
# ⚠️ 注意 `.active` 恒为 prod（所有函数都住 prod env）。这里的 dev/prod 指的是
#    【函数连哪个库】，不是【部到哪个 CloudBase 环境】——后者已只剩一个。

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── 参数解析（channel + target + --yes，顺序无关）──
# 通道用 both 而非 all 表示全选，避免与端维度的 all 撞词。
CHANNEL=both
TARGET=all
ASSUME_YES=0
PLAN_ONLY=0
CHANNEL_SET=0
TARGET_SET=0
for arg in "$@"; do
  case "$arg" in
    # 同一维度给两个值一律拒绝，不做「最后一个生效」。
    # `deploy-cloudfunctions.sh prod dev` 这种手误会让 CHANNEL=dev：生产函数不部署，
    # 且因 DO_PRIMARY=0 连 confirm 都跳过 —— 操作者以为发了生产，实际全程无人工闸口。
    dev|prod|both)
      [[ "$CHANNEL_SET" == "1" ]] && { echo "ERROR: 通道参数重复（已是 '$CHANNEL'，又给了 '$arg'）。请只指定一个。" >&2; exit 1; }
      CHANNEL="$arg"; CHANNEL_SET=1 ;;
    client|staff|all)
      [[ "$TARGET_SET" == "1" ]] && { echo "ERROR: 端参数重复（已是 '$TARGET'，又给了 '$arg'）。请只指定一个。" >&2; exit 1; }
      TARGET="$arg"; TARGET_SET=1 ;;
    --yes|-y)         ASSUME_YES=1 ;;
    --plan|-n)        PLAN_ONLY=1 ;;
    *) echo "ERROR: unknown arg '$arg'. Usage: $0 [dev|prod|both] [client|staff|all] [--yes] [--plan]" >&2; exit 1 ;;
  esac
done
DO_STAFF=0; DO_CLIENT=0
[[ "$TARGET" == "staff"  || "$TARGET" == "all" ]] && DO_STAFF=1
[[ "$TARGET" == "client" || "$TARGET" == "all" ]] && DO_CLIENT=1
DO_PRIMARY=0; DO_SHADOW=0
[[ "$CHANNEL" == "prod" || "$CHANNEL" == "both" ]] && DO_PRIMARY=1
[[ "$CHANNEL" == "dev"  || "$CHANNEL" == "both" ]] && DO_SHADOW=1

if [[ ! -f "$ROOT/envs/.active" ]]; then
  echo "ERROR: envs/.active not found. Run scripts/use-env.sh <env> first." >&2
  exit 1
fi
ACTIVE=$(cat "$ROOT/envs/.active")

# ── .active 白名单：云函数部署只允许 prod ──
# 独立 test 环境已于 2026-09-01 退役。若 .active 残留 'test' 且本地仍有 envs/test.env，
# 由于 test.env 的 PG host 与 dev 同为 101，PG 校验会误判通过，而它的 envId 复用 prod ——
# 结果是把 dev 的 PG 变量推进 prod CloudBase（2026-05-26 跨环境污染事故的同族路径）。
#
# dev 也于 2026-09-21 一并退役：dev 侧 CloudBase 环境已不可用（staff 的 envId 不在任何密钥
# 账号下、client 的已到期），dev 库改由 prod env 内的影子函数（*Dev）承载。
# 之所以要**主动拒绝**而不是放着不管：本脚本所有期望值都取自 `envs/$ACTIVE.env`，
# 一旦有人把 dev.env 的 envId 改成 prod env（在 dev env 已死的前提下这是很自然的下一步），
# `.active=dev` 就会把正式 clientApi/staffApi/payNotify 连着 dev 连接串推进生产 env，
# 而 envId 与 PG 两道断言**全部自证通过**——期望值和实际值出自同一个文件。
# 生产全量流量会静默切到 dev 库。
if [[ "$ACTIVE" == "dev" ]]; then
  echo "ERROR: dev 部署线已退役——dev 侧 CloudBase 环境不可用，dev 库现由 prod env 内的影子函数(*Dev)承载。" >&2
  echo "       请执行 scripts/use-env.sh prod，本脚本会同时部署正式函数与影子函数（共 6 个）。" >&2
  exit 1
fi
if [[ "$ACTIVE" != "prod" ]]; then
  echo "ERROR: envs/.active='$ACTIVE' 不在白名单（云函数部署只允许 prod）。请先执行 scripts/use-env.sh prod。" >&2
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

# ── 数据库 host 绝对常量（confirm 提示与 assert_rc 共用，故须早于两者定义）──
# 所有环境均用 5433 端口 + fengyu_wxapp 库名，只能靠 IP 区分。
PROD_PG_HOST=118.178.196.26
DEV_PG_HOST=101.34.242.103

# ── 步骤计数：每端每通道 staff 1 个 / client 2 个函数 ──
# 放在计划打印之前，好让 --plan 也能暴露计数，避免 TOTAL 与实际步数脱节却没人看见。
TOTAL=0
for _ch in primary shadow; do
  [[ "$_ch" == "primary" && "$DO_PRIMARY" != "1" ]] && continue
  [[ "$_ch" == "shadow"  && "$DO_SHADOW"  != "1" ]] && continue
  [[ "$DO_STAFF"  == "1" ]] && TOTAL=$((TOTAL + 1))
  [[ "$DO_CLIENT" == "1" ]] && TOTAL=$((TOTAL + 2))
done
STEP=0

# ── 本次部署计划（无论是否 confirm 都打印，让操作者看见实际目标）──
echo "==> 部署计划：channel=$CHANNEL  target=$TARGET  共 $TOTAL 个函数"
if [[ "$DO_PRIMARY" == "1" ]]; then
  [[ "$DO_STAFF"  == "1" ]] && echo "    staffApi                    → $STAFF_ENV_ID   [prod 库 $PROD_PG_HOST]"
  [[ "$DO_CLIENT" == "1" ]] && echo "    clientApi + payNotify       → $CLIENT_ENV_ID  [prod 库 $PROD_PG_HOST]"
fi
if [[ "$DO_SHADOW" == "1" ]]; then
  [[ "$DO_STAFF"  == "1" ]] && echo "    staffApiDev                 → $STAFF_ENV_ID   [dev  库 $DEV_PG_HOST]"
  [[ "$DO_CLIENT" == "1" ]] && echo "    clientApiDev + payNotifyDev → $CLIENT_ENV_ID  [dev  库 $DEV_PG_HOST]"
fi
echo "    注：两套函数同住 prod env，仅连接库不同；此处 dev/prod 指【连哪个库】。"

if [[ "$PLAN_ONLY" == "1" ]]; then
  echo "(--plan：仅预览，未做任何改动)"
  exit 0
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

# 防呆：只有会动【生产库函数】时才强制 confirm。
# 纯 dev 通道不碰任何正式函数，每次都要敲 yes 只会训练出肌肉记忆式确认，
# 反而稀释了这道闸在真正碰生产时的警示作用。
if [[ "$DO_PRIMARY" == "1" && "$ASSUME_YES" != "1" ]]; then
  echo ""
  echo "⚠️  本次会更新【连生产库】的正式函数。"
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
#     2026-09-01 起 dev 迁入 lx-test（原 sqlserver101）：dev=101.34.242.103；
#     prod=118.178.196.26。旧的 ali-demo 47.113.202.7 已弃用，不再是任何环境的目标。）──
#
#    影子函数（名字以 Dev 结尾，如 clientApiDev）是同一 env 内连 dev 库的第二份部署，
#    它们的期望 host 恒为 DEV_PG_HOST，与 .active 无关。校验是双向的：
#    正式函数连错到 dev 库、影子函数连错到 prod 库，两个方向都中止。
#    后者尤其重要——影子函数误连 prod 就意味着开发版/体验版直接写生产数据。
#
#    ⚠️ 期望值是【绝对常量】（定义见文件上方），不从 .active / env 文件推导。
#    这两道断言的意义在于「拿一个独立于被检对象的事实去校验它」；若期望值也取自
#    envs/$ACTIVE.env，就变成自己证明自己——改一处 env 文件即可让断言全绿。
EXPECT_PG_HOST=$PROD_PG_HOST   # 正式函数恒连 prod 库（.active 已被限定为 prod）
assert_rc() {  # $1=side 目录  $2=期望 envId
  local f="$ROOT/$1/cloudbaserc.json"
  [[ -f "$f" ]] || { echo "ERROR: $f 缺失（渲染失败）。中止。" >&2; exit 1; }
  local got_env got_host
  got_env=$(node -e "console.log(require('$f').envId||'')")
  if [[ "$got_env" != "$2" ]]; then
    echo "ERROR: $1/cloudbaserc.json envId=$got_env ≠ 期望 $2（.active=$ACTIVE 渲染异常）。中止。" >&2; exit 1
  fi
  # PG 连接串完整断言：host / port / dbname 三者全中才放行。
  # 只比 host 是不够的——同一台 101 上还有 :5433/fengyu_e2e（e2e 独立库）与历史的 :5434，
  # 只要 host 对就放行会把 e2e 库或错端口的串推进云函数。解析失败/缺值一律拒绝（fail-closed）。
  node -e '
    const f = process.argv[1], expectHost = process.argv[2], devHost = process.argv[3]
    const c = require(f)
    // 逐个函数校验——不能只看第一个：client 侧有 clientApi + payNotify 两个函数，
    // 任一条串指错库都会被 `fn code update` 一并推上去。
    const fns = (c.functions || []).filter((x) => x.envVariables && "PG_CONNECTION_STRING" in x.envVariables)
    if (fns.length === 0) {
      console.error("  未找到任何带 PG_CONNECTION_STRING 的函数——渲染异常，fail-closed 中止"); process.exit(1)
    }
    // 影子函数按名字后缀识别（clientApiDev / payNotifyDev / staffApiDev），期望库与正式函数相反
    const isShadow = (name) => /Dev$/.test(name)
    const mask = (v) => String(v).replace(/:\/\/[^@]*@/, "://***@")
    const allErrs = []
    for (const fn of fns) {
      const name = fn.name || "(未命名函数)"
      const s = fn.envVariables.PG_CONNECTION_STRING
      if (!s || /PLACEHOLDER|待用户提供/.test(s)) {
        allErrs.push(`${name}: PG_CONNECTION_STRING 缺失或仍是占位符`); continue
      }
      let u
      try { u = new URL(s) } catch {
        allErrs.push(`${name}: 无法解析 ${mask(s)}`); continue
      }
      const want = isShadow(name) ? devHost : expectHost
      const errs = []
      if (u.hostname !== want) errs.push(`host=${u.hostname} ≠ ${want}${isShadow(name) ? "（影子函数必须连 dev 库）" : ""}`)
      if (u.port !== "5433") errs.push(`port=${u.port || "(空)"} ≠ 5433`)
      if (u.pathname !== "/fengyu_wxapp") errs.push(`dbname=${u.pathname || "(空)"} ≠ /fengyu_wxapp`)
      // query 可覆盖 authority 的 host/port/dbname（libpq 语义），只比 authority 会被 ?host=<旧库> 绕过
      const overriding = ["host","hostaddr","port","dbname","database","options","service","passfile"].filter((k) => u.searchParams.has(k))
      if (overriding.length) errs.push(`query 试图覆盖连接目标：${overriding.join(",")}`)
      if (errs.length) allErrs.push(`${name}: ${errs.join("；")}`)
    }
    if (allErrs.length) { console.error("  " + allErrs.join("\n  ")); process.exit(1) }
  ' "$f" "$EXPECT_PG_HOST" "$DEV_PG_HOST" || {
    echo "ERROR: $1 的 PG_CONNECTION_STRING 与 ${ACTIVE} 环境不符（详见上行），疑似跨环境污染。中止。" >&2
    exit 1
  }
}
[[ "$DO_STAFF"  == "1" ]] && assert_rc fengyu-staff  "$STAFF_ENV_ID"
[[ "$DO_CLIENT" == "1" ]] && assert_rc fengyu-client "$CLIENT_ENV_ID"
echo "  ✓ envId + PG host 校验通过（${ACTIVE}）"

# ── DB 前置依赖闸：云函数 SQL 依赖的 DB 对象必须已迁到目标库（#187）──
# 背景：云函数与 admin 的退款 JSON 解析统一走 migration 0045 的 public.try_jsonb /
# public.try_numeric。若目标库漏迁就部署，所有解析退款 note 的收款路径都会报
# `function public.try_jsonb(text) does not exist` —— 报错点在收款主链上，是生产事故。
# 这里用目标环境自己的连接串做**只读**探测（Node pg，不依赖本机 psql）。
# 处置分环境：dev 探测不通告警放行；**prod 一律 fail-closed**（无法确认迁移状态就拒绝部署）。
assert_db_prereqs() {  # $1=cloudbaserc 路径  $2=channel(primary|shadow)
  local want_shadow="$2"
  local pg_conn
  pg_conn=$(node -e '
    const fs = require("fs")
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const wantShadow = process.argv[2] === "shadow"
    // 必须按【本次实际部署的通道】取连接串：正式函数连 prod 库、影子函数连 dev 库，
    // 探测目标要跟着走。从前同 env 各函数连接串一致，取哪个都等价；
    // 自打影子函数进场就不再成立——不加过滤的 .find() 会在只部 prod 时去探 dev 库，
    // 等于这道迁移闸形同虚设。反过来只部 dev 时探 prod 库，则 dev 库漏迁照样放行。
    const fn = (c.functions || []).find(
      (x) => x.envVariables && x.envVariables.PG_CONNECTION_STRING
        && /Dev$/.test(x.name || "") === wantShadow
    )
    process.stdout.write(fn ? fn.envVariables.PG_CONNECTION_STRING : "")
  ' "$1" "$2" 2>/dev/null || true)
  # 探测不通时的处置跟着【目标库】走，而不是跟着 .active（它恒为 prod）：
  # 探不到 prod 库 → fail-closed，生产最不能"无法确认迁移状态还继续上传"；
  # 探不到 dev 库  → 告警放行，dev 库偶发不可达不该挡住开发自测。
  # fail_closed=1 → 探测失败即中止；=0 → 告警放行。（原名 soft_fail 语义是反的）
  local fail_closed db_label
  if [[ "$want_shadow" == "shadow" ]]; then fail_closed=0; db_label="dev"; else fail_closed=1; db_label="prod"; fi
  _db_probe_unavailable() {  # $1=原因
    if [[ "$fail_closed" == "1" ]]; then
      echo "ERROR: 部署正式函数前无法确认 ${db_label} 库的迁移状态（$1），拒绝继续。" >&2
      echo "       请先确认 ${db_label} 库已执行 db:migrate（0045_try_cast_helpers）。" >&2
      exit 1
    fi
    echo "  ⚠️  $1，跳过 ${db_label} 库的前置依赖检查（放行；请自行确认已迁 0045）"
    return 0
  }

  [[ -z "$pg_conn" ]] && { _db_probe_unavailable "未取到 PG 连接串"; return 0; }

  # 用项目已有的 Node pg 探测，不依赖本机 psql（CI / 同事机器上未必装）。
  # ⚠️ 必须写成 `if probe=$(...); then`：本脚本开头 set -e，裸写 `probe=$(...)` 后再读 $? 时，
  # 命令替换非零会让脚本**直接退出**，下面的分环境处理根本不可达（闸门 2 codex 实测指出）。
  local probe
  if probe=$(cd "$ROOT/db" && node -e '
    const { Client } = require("pg")
    // connectionTimeoutMillis 只覆盖建连；statement_timeout 防「连上了但查询 hang 住」把发版卡死
    const c = new Client({
      connectionString: process.argv[1],
      connectionTimeoutMillis: 8000,
      statement_timeout: 8000,
      query_timeout: 8000,
    })
    c.connect()
      // WARNING: 下面这段 SQL 内禁止出现双引号标识符。外层是 bash 单引号写不了裸单引号，
      // 故 SQL 里用双引号占位、再由末尾的 .replace 统一翻成单引号；
      // 若写了带双引号的标识符（如 schema.table 的引号形式），会被静默变形导致 SQL 报错。
      .then(() => c.query(`
        SELECT COALESCE(string_agg(f, ", "), "") AS missing
          FROM (VALUES (\x27public.try_jsonb(text)\x27), (\x27public.try_numeric(text)\x27)) AS t(f)
         WHERE to_regprocedure(f) IS NULL
      `.replace(/"/g, "\x27")))
      .then((r) => { process.stdout.write(r.rows[0].missing || ""); return c.end() })
      .catch((e) => { console.error(e.message); process.exit(2) })
  ' "$pg_conn"); then
    : # 探测成功，结果在 $probe 里（空串=全部就绪）
  else
    _db_probe_unavailable "DB 探测失败（网络/权限/依赖）"
    return 0
  fi

  if [[ -n "${probe//[[:space:]]/}" ]]; then
    # 必须报 $db_label 而不是 $ACTIVE：后者恒为 prod，
    # 探 shadow 通道发现 dev 库漏迁时会把人指去迁 prod 库，越迁越错。
    echo "ERROR: ${db_label} 库缺少云函数依赖的 DB 对象：${probe}" >&2
    echo "       请先对 ${db_label} 库执行 db:migrate（migration 0045_try_cast_helpers），再部署。" >&2
    echo "       参见 db/CLAUDE.md「schema 变更两个库都要迁」的目标断言流程。" >&2
    exit 1
  fi
  echo "  ✓ ${db_label} 库 DB 前置依赖就绪（public.try_jsonb / public.try_numeric）"
}
# 按【通道】探测，每个通道只探一次：staff 与 client 在同一通道下连的是同一个库，
# 按「端×通道」探会做重复探测，每次还带 8s 超时。
# 取哪一侧的 cloudbaserc 都等价，优先用本次实际会部署的那一侧。
for _ch in primary shadow; do
  [[ "$_ch" == "primary" && "$DO_PRIMARY" != "1" ]] && continue
  [[ "$_ch" == "shadow"  && "$DO_SHADOW"  != "1" ]] && continue
  if [[ "$DO_CLIENT" == "1" ]]; then
    assert_db_prereqs "$ROOT/fengyu-client/cloudbaserc.json" "$_ch"
  else
    assert_db_prereqs "$ROOT/fengyu-staff/cloudbaserc.json" "$_ch"
  fi
done

# ── 占位符扫描：渲染后仍含占位符的 env 给出告警（不中止，部分占位是预期的，如 prod 未填的 SM4）──
SCAN_FILES=()
[[ "$DO_STAFF"  == "1" ]] && SCAN_FILES+=("$ROOT/fengyu-staff/cloudbaserc.json")
[[ "$DO_CLIENT" == "1" ]] && SCAN_FILES+=("$ROOT/fengyu-client/cloudbaserc.json")
PLACEHOLDERS=$(grep -ohE '<待用户提供[^>]*>|[A-Za-z0-9_.-]*PLACEHOLDER[A-Za-z0-9_.-]*' "${SCAN_FILES[@]}" 2>/dev/null | sort -u || true)
if [[ -n "$PLACEHOLDERS" ]]; then
  echo "⚠️  注意：cloudbaserc 仍含以下占位符，将原样上传到 [$ACTIVE]，请确认是否预期："
  echo "$PLACEHOLDERS" | sed 's/^/      /'
fi

# ── 解析函数的代码目录 ──
# 影子函数（*Dev）在 cloudbaserc 里用 `dir` 指向正式函数的目录，两套函数因此同源。
# 输出绝对路径；函数未声明 `dir` 时输出空串，交回 CLI 自己按 functionRoot/<name> 解析。
fn_code_dir() {  # $1=cloudbaserc 路径  $2=函数名
  node -e '
    const fs = require("fs"), path = require("path")
    const [rc, name] = process.argv.slice(1)
    const fn = (JSON.parse(fs.readFileSync(rc, "utf8")).functions ?? []).find((f) => f.name === name)
    if (!fn) { console.error(`cloudbaserc 中找不到函数 ${name}`); process.exit(1) }
    if (fn.dir) console.log(path.resolve(path.dirname(rc), fn.dir))
  ' "$1" "$2"
}

# ── 单函数部署：不存在则创建，存在则只更新代码 ──
# `tcb fn code update` 要求函数已存在；影子函数（*Dev）首次上线时该 env 里还没有它，
# 必须先走 `tcb fn deploy` 按 cloudbaserc 创建。两条路径都会把 envVariables 一并推上去。
# 注意这里用 `fn detail` 而非解析 `fn list` 表格：clientApi 是 clientApiDev 的前缀，
# 对表格做子串匹配会把两者混为一谈。
#
# ⚠️ CLI 3.0.1 两条路径对配置项 `dir` 的处理并不一致（2026-09-22 首次实发影子函数时踩到）：
#   · `tcb fn deploy`      —— 认 `dir`，代码目录解析正确
#   · `tcb fn code update` —— 只把 `dir` 打印出来（"Using directory from config file: …/clientApi"），
#                             打包时仍按 functionRoot/<函数名> 拼路径，于是影子函数必报
#                             「路径不存在：…/cloudfunctions/clientApiDev」
# 所以更新路径必须显式传 `--dir`（CLI 优先级 --dir > 配置项 dir > functionRoot/<name>）。
# 三个 *Dev 一旦建好，往后每次部署都走 code update，不传 --dir 就是每次必挂。
deploy_one_fn() {  # $1=函数名  $2=cloudbaserc 路径  $3=--sync 值  $4=--require 值
  local fn="$1" rc="$2" sync="$3" req="$4"
  local dir
  dir="$(fn_code_dir "$rc" "$fn")"
  if [[ -n "$dir" && ! -d "$dir" ]]; then
    echo "ERROR: $fn 在 cloudbaserc 里声明的代码目录不存在：$dir" >&2
    return 1
  fi
  if tcb fn detail "$fn" >/dev/null 2>&1; then
    if [[ -n "$dir" ]]; then
      tcb fn code update "$fn" --dir "$dir"
    else
      tcb fn code update "$fn"
    fi
  else
    echo "     函数 $fn 在该 env 中尚不存在 → 首次创建（tcb fn deploy）"
    # CLI 3.0.1 建不了 http 类型触发器（报「不支持的触发器类型 [http]，目前仅支持定时触发器」）。
    # 该错误发生在函数与代码都已上传成功之后，失败的只是其后的触发器创建步骤，
    # 所以这里用 fn detail 复核实际结果：函数确实建出来了就放行，没建出来才算真失败。
    # HTTP 入口本就不由 cloudbaserc 承载，须另行 `tcb service create` 建。
    if ! tcb fn deploy "$fn"; then
      if ! tcb fn detail "$fn" >/dev/null 2>&1; then
        echo "ERROR: $fn 首次创建失败（函数未建出）。" >&2
        return 1
      fi
      echo "     ⚠️  $fn 函数本体与代码已创建成功，失败的是触发器创建（CLI 不支持 http 触发器）。"
      echo "        如该函数需要 HTTP 入口，另行执行：tcb service create -p <路径> -f $fn"
    fi
  fi
  node "$ROOT/scripts/sync-cloudfunction-env.mjs" "$rc" "$fn" --sync "$sync" --require "$req"
}

# --- staff side ---
if [[ "$DO_STAFF" == "1" ]]; then
  # 登录只做一次，两个通道共用（tcb 鉴权是全局单例，反复切会互相踢）
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
  if [[ "$DO_PRIMARY" == "1" ]]; then
    STEP=$((STEP + 1))
    echo "==> [$STEP/$TOTAL] Deploy staffApi (prod 库) → $STAFF_ENV_ID"
    deploy_one_fn staffApi "$ROOT/fengyu-staff/cloudbaserc.json" \
      CLIENT_SECRET,PG_CONNECTION_STRING,DEPLOY_CHANNEL \
      PG_CONNECTION_STRING,CLIENT_SECRET,CLIENT_APPSECRET,WXACODE_ENV_VERSION,DEPLOY_CHANNEL
    echo "  ✓ staffApi deployed"
  fi

  # 影子函数：同一 env、同一份代码（cloudbaserc 的 dir 指向 cloudfunctions/staffApi），连 dev 库
  if [[ "$DO_SHADOW" == "1" ]]; then
    STEP=$((STEP + 1))
    echo "==> [$STEP/$TOTAL] Deploy staffApiDev (dev 库) → $STAFF_ENV_ID"
    deploy_one_fn staffApiDev "$ROOT/fengyu-staff/cloudbaserc.json" \
      CLIENT_SECRET,PG_CONNECTION_STRING,DEPLOY_CHANNEL \
      PG_CONNECTION_STRING,CLIENT_SECRET,CLIENT_APPSECRET,WXACODE_ENV_VERSION,DEPLOY_CHANNEL
    echo "  ✓ staffApiDev deployed"
  fi
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
  if [[ "$DO_PRIMARY" == "1" ]]; then
    STEP=$((STEP + 1))
    echo "==> [$STEP/$TOTAL] Deploy clientApi (prod 库) → $CLIENT_ENV_ID"
    deploy_one_fn clientApi "$ROOT/fengyu-client/cloudbaserc.json" \
      CLIENT_SECRET,PG_CONNECTION_STRING,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL \
      PG_CONNECTION_STRING,TMAP_KEY,TMAP_SECRET,CLIENT_SECRET,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL
    echo "  ✓ clientApi deployed"

    STEP=$((STEP + 1))
    echo "==> [$STEP/$TOTAL] Deploy payNotify (prod 库) → $CLIENT_ENV_ID"
    deploy_one_fn payNotify "$ROOT/fengyu-client/cloudbaserc.json" \
      CLIENT_SECRET,PG_CONNECTION_STRING,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL \
      PG_CONNECTION_STRING,CLIENT_SECRET,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL
    echo "  ✓ payNotify deployed"
  fi

  # 影子函数：同一 env、同一份代码（dir 指向正式函数目录），连 dev 库。
  # PAYNOTIFY_FN_NAME 必须一并回读校验——它决定 clientApiDev 的对账自调打向哪个 payNotify，
  # 错了就是拿 dev 库的订单号去写 prod 库。
  if [[ "$DO_SHADOW" == "1" ]]; then
    STEP=$((STEP + 1))
    echo "==> [$STEP/$TOTAL] Deploy clientApiDev (dev 库) → $CLIENT_ENV_ID"
    deploy_one_fn clientApiDev "$ROOT/fengyu-client/cloudbaserc.json" \
      CLIENT_SECRET,PG_CONNECTION_STRING,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL \
      PG_CONNECTION_STRING,TMAP_KEY,TMAP_SECRET,CLIENT_SECRET,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL
    echo "  ✓ clientApiDev deployed"

    STEP=$((STEP + 1))
    echo "==> [$STEP/$TOTAL] Deploy payNotifyDev (dev 库) → $CLIENT_ENV_ID"
    deploy_one_fn payNotifyDev "$ROOT/fengyu-client/cloudbaserc.json" \
      CLIENT_SECRET,PG_CONNECTION_STRING,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL \
      PG_CONNECTION_STRING,CLIENT_SECRET,PAYNOTIFY_FN_NAME,DEPLOY_CHANNEL
    echo "  ✓ payNotifyDev deployed"
  fi
fi

echo ""
echo "==> Done (target=$TARGET)。请在 CloudBase 控制台验证环境变量正确。"
[[ "$DO_STAFF"  == "1" ]] && echo "    staff:  https://console.cloud.tencent.com/tcb/scf?envId=$STAFF_ENV_ID"
[[ "$DO_CLIENT" == "1" ]] && echo "    client: https://console.cloud.tencent.com/tcb/scf?envId=$CLIENT_ENV_ID"

# 兜底正常退出：末尾 `[[ ]] && echo` 在 target≠all 时会因条件 false 短路返回 1，否则会污染脚本退出码（部署成功却 exit 1）
exit 0
