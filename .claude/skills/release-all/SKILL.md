---
name: release-all
description: |
  Orchestrates a code release for the fengyu-wxapp monorepo to dev, test, or prod:
  runs pre-flight test/type gates, bumps miniprogram APP_VERSION from the latest
  git tag, runs pending Drizzle migrations against the selected target database,
  cross-compiles the Next.js admin and fengyu-analyst, then ships both to the target host
  (prod→fengyu-prod / test→sqlserver101 / dev→ali-demo). Dev and prod also deploy
  staffApi, clientApi, and payNotify to their own CloudBase envs; test deploys admin
  and fengyu-analyst but skips CloudBase functions because it has no independent
  CloudBase environment and must never overwrite prod CloudBase.
  Use when the user says 发版 / 上线 / 发布生产 / 发布测试 / 发 dev / release / ship to dev|test|prod.
  This is an UPDATE release — runs pending migrations only through db:migrate, never wipes the DB.
argument-hint: '[dev|test|prod] [skip-tests|skip-version|skip-admin|skip-analyst|skip-cloudfn]'
disable-model-invocation: true
user-invocable: true
allowed-tools: 'Bash, Read, Grep'
metadata:
  author: NightVoyager
  version: 2.4.0
  title: 代码发版（dev/test/prod）
  description_zh: 预检门禁 + 目标库 db:migrate + admin/analyst 交叉编译发布 + CloudBase 云函数发布 + 版本号更新（dev/test/prod 三环境参数化）
  license: 42plugin-personal
---

# release-all — fengyu-wxapp 代码发版（dev/test/prod）

把 monorepo 各运行端**已存在**的部署脚本编排成一条发版流水线，支持 `dev`、`test`、`prod`（无参默认 prod）。每个 Phase 顺序执行，把命令输出复述给用户。

## 目标环境（ENV 形参）

`/release-all <dev|test|prod> [skip-*]`：首个 token 锁定环境；无环境参数默认 `prod`。`test` 是独立服务器和数据库，但没有独立 CloudBase，必须使用下表的受限发布矩阵。

| 维度 | dev | test | prod |
|------|-----|------|------|
| SSH host | `ali-demo` | `sqlserver101` | `fengyu-prod` |
| 远程目录 | `/root/proj.xt.com/fengyu-wxapp/docker` | `/www/wwwroot/fengyu-admin/docker` | `/www/wwwroot/fengyu-admin/docker` |
| 迁移 DB host | `47.113.202.7` | `101.34.242.103` | `118.178.196.26` |
| 容器 DB host | `47.113.202.7` | `172.18.0.1`（Docker 网桥回连 101） | `118.178.196.26` 或经验证的同机网桥 |
| env 文件 | `envs/dev.env` | `envs/test.env` | `envs/prod.env` |
| `ENV_PROFILE` | `dev` | `test` | `prod` |
| admin | 发布 | 发布 | 发布 |
| analyst | 发布 | 发布 | 发布 |
| CloudBase 云函数 | dev env | **强制跳过** | prod env |
| admin 命令 | `deploy-admin.sh dev` | `deploy-admin.sh test` | `deploy-admin.sh prod` |
| analyst 命令 | `deploy-analyst.sh dev` | `deploy-analyst.sh test` | `deploy-analyst.sh prod` |

三个数据库均用 5433 端口 + `fengyu_wxapp` 库名，按 host 区分。test 的 `ADMIN_DATABASE_URL` 是只在 101 宿主可用的 `172.18.0.1`；本地迁移必须改用 `test.env` 的 `PG_CONNECTION_STRING`（公网 host 101.34.242.103）。

`test.env` 当前复用 prod 的 CloudBase envId。这只供 test admin 访问既有 CloudBase 资源，**不代表存在 test CloudBase**；禁止执行 `scripts/use-env.sh test`、`render-cloudbaserc.mjs test` 或 `deploy-cloudfunctions.sh`。

复用脚本（不要新写、不要改）：
- `node scripts/gen-version.js` — 版本号写入两端 `miniprogram/utils/version.ts`（env 无关）
- `npm --prefix db run db:migrate` — 将 Drizzle pending migration 应用到显式指定的目标库
- `.claude/skills/remote-deploy/deploy-admin.sh <dev|test|prod>` — admin 交叉编译 + 远程部署
- `.claude/skills/remote-deploy/deploy-analyst.sh <dev|test|prod>` — analyst 交叉编译 + 远程部署（读取同环境 `ANALYST_PUBLIC_ORIGIN`，并校验容器 DB / public origin）
- `scripts/use-env.sh <dev|prod>` — 切 env + 渲染 cloudbaserc（含 ENV_PROFILE 守卫）
- `scripts/deploy-cloudfunctions.sh` — 按 `.active` 串行双账号部署 staffApi/clientApi/payNotify

参数（可组合）：`dev` / `test` / `prod`（三选一，默认 prod）+ `skip-tests` `skip-version` `skip-admin` `skip-analyst` `skip-cloudfn`。数据库迁移不可跳过。选择 `test` 时强制追加 `skip-cloudfn`；analyst 默认正常发布，除非显式传入 `skip-analyst`。

## Usage

`/release-all [dev|test|prod] [skip-tests|skip-version|skip-admin|skip-analyst|skip-cloudfn]`。`dev` 是开发联调环境，`test` 是 101 独立测试服务器，`prod` 是生产环境。不得再把自然语言参数 `test` 解释成 `dev`。

---

## §0 护栏（每次发版必须遵守，不可破例）

- 本技能是**代码更新发版，不是初始化**。只允许用 `DATABASE_URL=<目标库> npm --prefix db run db:migrate` 应用本次发版工作树中已 review 的 Drizzle migration；**禁止**：清库、`db:push`、手写 DDL、`db:baseline:reset`、`tcb fn deploy --force`。
- **云函数部署必须串行**：tcb 鉴权是全局单例（`~/.cloudbase-cli/auth.json`），staff 与 client 是**两个不同腾讯子账号**。**绝不**为这步开并行 agent —— 会中途互相踢登录。`deploy-cloudfunctions.sh` 已内部串行处理。
- **永不用 `--force`**：env 变量会被清空（2026-04-02 事故）。只用 `tcb fn code update`（脚本已遵守）。
- 技能**完全不碰 git**（不 commit / 不 push）。允许携带未提交改动发版；Admin/Analyst 镜像必须用 `<commit>-dirty.<fingerprint>` 标记脏状态，CloudBase 则按当前工作树上传。不得把脏发布表述为已提交或仅由 commit 可复现。
- **目标 DB 硬约束**：迁移目标必须为 dev=`47.113.202.7`、test=`101.34.242.103`、prod=`118.178.196.26` 的 `:5433/fengyu_wxapp`。test 远程容器允许 `172.18.0.1`，但必须同时验证宿主公网 IP=101.34.242.103 且宿主 5433 正在监听。
- **发 prod 后必须恢复 dev env（§8）**；发 test 不调用 `use-env.sh`，不得改变当前 active CloudBase 环境。
- `db:migrate` 出错、连接目标不符，或本地 migration journal 比目标库旧时，立即停止；不得继续 admin 或云函数发布。已成功应用的 migration 不做回滚，按 `db/CLAUDE.md` 新建向前修复 migration。

---

## §1 Phase 0 — 预检门禁

全部只读 / 无副作用。逐项报告，**任一失败立即停下问用户**，不要继续往下跑。

1. **版本号确认**：`git describe --tags --abbrev=0`
   - 展示将写入的版本号，请用户确认这是本次发版意图的 tag（用户应已手动 `git tag`）。
   - 若 HEAD 没有新 tag，提醒用户先 `git tag vX.Y.Z`，再回来。

2. **类型门禁**：两个 Next.js 站点均须 0 错误。
   ```bash
   cd fengyu-admin && npx tsc --noEmit
   cd fengyu-analyst && npx tsc --noEmit
   ```

3. **跨端一致性门禁**（除非传入 `skip-tests`）：
   ```bash
   cd fengyu-staff/cloudfunctions/staffApi && npx vitest run cross-end-error-codes-snapshot cross-end-sql-snapshot
   cd fengyu-admin && npx vitest run src/lib/__tests__/error-codes-cross-end.test.ts src/lib/__tests__/orders-sql-cross-end.test.ts
   cd fengyu-analyst && npx vitest run
   ```
   - 重 e2e（L2 `bun run test:l2` / L3 / playwright）**不自动跑**：耗时，且 client 与 staff L2 共用 TE2L2_ 命名空间 + 同一库，并发会污染夹具产生假失败。如用户要跑，提醒先确认无其它端并发。

4. **analyst 发布配置**（未传 `skip-analyst`）：读取 `envs/$ENV.env` 的 `ANALYST_PUBLIC_ORIGIN`，必须是无账号密码的 `http` 或 `https` URL。
   ```bash
   ANALYST_PUBLIC_ORIGIN="$(grep -m1 '^ANALYST_PUBLIC_ORIGIN=' "envs/$ENV.env" | cut -d= -f2- | tr -d '\r\"')"
   test -n "$ANALYST_PUBLIC_ORIGIN" || { echo 'ANALYST_PUBLIC_ORIGIN 缺失 ✗ 停' >&2; exit 1; }
   node -e 'const u = new URL(process.argv[1]); if (!/^https?:$/.test(u.protocol) || u.username || u.password) process.exit(1); console.log(`analyst public origin -> ${u.origin} ✓`)' "$ANALYST_PUBLIC_ORIGIN" || { echo 'ANALYST_PUBLIC_ORIGIN 格式错误 ✗ 停' >&2; exit 1; }
   unset ANALYST_PUBLIC_ORIGIN
   ```

5. **目标 env 安全扫描**（读 `envs/$ENV.env`，**不要打印 secret 值**，只断言）：
   - `ENV_PROFILE=$ENV`
   - prod：`ALLOW_TEST_OPENID=false`、`WXACODE_ENV_VERSION=release`
   - dev：`ALLOW_TEST_OPENID=true`、`WXACODE_ENV_VERSION=develop`
   - test：`ALLOW_TEST_OPENID=false`、`WXACODE_ENV_VERSION=release`
   - 【DB assert ①】dev/prod 的 `PG_CONNECTION_STRING` 与 `ADMIN_DATABASE_URL` 都必须命中目标公网 IP；test 的 `PG_CONNECTION_STRING` 必须为 `101.34.242.103:5433/fengyu_wxapp`，`ADMIN_DATABASE_URL` 必须为 `172.18.0.1:5433/fengyu_wxapp`
   - 扫描 `PLACEHOLDER`（尤其 `CLIENT_SERVICE_URL`）→ 命中则告警并问用户是否继续。
     - 说明：更新发版用 `code update` 不会把 PLACEHOLDER 重烤进函数 env；但若这是首次 provisioning 就会，需先在控制台补真实 URL（见 §8）。
   ```bash
   grep -E '^(ENV_PROFILE|ALLOW_TEST_OPENID|WXACODE_ENV_VERSION)=' envs/$ENV.env
   grep -q "$EXPECT_IP" <(grep '^PG_CONNECTION_STRING=' envs/$ENV.env) || { echo 'cloudfn PG 目标错误 ✗ 停' >&2; exit 1; }
   echo "cloudfn PG→$ENV($EXPECT_IP) ✓"
   MIGRATE_KEY=$([[ "$ENV" == test ]] && echo PG_CONNECTION_STRING || echo ADMIN_DATABASE_URL)
   MIGRATE_DATABASE_URL="$(grep -m1 "^${MIGRATE_KEY}=" "envs/$ENV.env" | cut -d= -f2- | tr -d '\r\"')"
   test -n "$MIGRATE_DATABASE_URL" || { echo "$MIGRATE_KEY 缺失 ✗ 停"; exit 1; }
   node -e 'const u=new URL(process.argv[1]), h=process.argv[2]; if (u.hostname!==h || u.port!=="5433" || u.pathname!=="/fengyu_wxapp") process.exit(1); console.log(`migration DB→${u.hostname}:${u.port}${u.pathname} ✓`)' "$MIGRATE_DATABASE_URL" "$EXPECT_IP" || { echo 'migration DB 目标错误 ✗ 停' >&2; exit 1; }
   unset MIGRATE_DATABASE_URL
   grep -n 'PLACEHOLDER' envs/$ENV.env || echo 'no placeholder ✓'
   ```
   （`$ENV` / `$EXPECT_IP` 执行时按上方事实表代入实际值。）

6. **【DB assert ②】admin / analyst 容器库**：remote-deploy 以本地 `envs/$ENV.env` 为唯一权威生成服务白名单 env；远端历史 `.env` 不再参与发布。`ADMIN_DATABASE_URL` 的容器目标必须为 dev/prod 对应公网 IP，test 必须为 `172.18.0.1:5433/fengyu_wxapp`，并额外验证 test SSH 宿主公网 IP=`101.34.242.103` 且 5433 正在监听。

7. **环境就绪**：
   ```bash
   docker info >/dev/null 2>&1 && echo 'docker ✓' || echo 'docker 未运行 ✗'
   ssh $SSH_HOST true && echo "$SSH_HOST 可达 ✓"
   cat envs/.active   # 记录当前 env；发 prod 时 Phase 7 须恢复回此值
   ```
8. **工作树状态**：`git status --short`。脏工作树不再阻断，但必须展示文件清单；后续 Admin/Analyst 发布清单必须显示 `dirty.<fingerprint>`，prod 确认文本也必须包含该指纹。

---

## §2 Phase 1 — 版本号（除非 `skip-version`）

```bash
node scripts/gen-version.js
git --no-pager diff fengyu-client/miniprogram/utils/version.ts fengyu-staff/miniprogram/utils/version.ts
```
- 展示 diff，确认两端 `APP_VERSION` == Phase 0 的 tag。若本步产生修改，保留改动并继续；将其作为脏工作树的一部分纳入部署指纹。无需为了发版先提交，但收尾时必须明确列出仍未提交的文件。

---

## §3 Phase 2 — 数据库迁移（强制，不可跳过）

此阶段必须在任何会读取新 schema 的 admin 或云函数代码上线前完成。每次均显式传入目标库 URL，**绝不**使用 `db/.env` 的默认连接，也不输出 URL 中的凭据。

```bash
MIGRATE_KEY=$([[ "$ENV" == test ]] && echo PG_CONNECTION_STRING || echo ADMIN_DATABASE_URL)
MIGRATE_DATABASE_URL="$(grep -m1 "^${MIGRATE_KEY}=" "envs/$ENV.env" | cut -d= -f2- | tr -d '\r\"')"
test -n "$MIGRATE_DATABASE_URL" || { echo "$MIGRATE_KEY 缺失"; exit 1; }
node -e 'const u=new URL(process.argv[1]), h=process.argv[2]; if (u.hostname!==h || u.port!=="5433" || u.pathname!=="/fengyu_wxapp") { console.error("migration DB target mismatch"); process.exit(1); } console.log(`migration DB→${u.hostname}:${u.port}${u.pathname} ✓`)' "$MIGRATE_DATABASE_URL" "$EXPECT_IP" || { echo 'migration DB 目标错误，停止发版。' >&2; exit 1; }
if ! DATABASE_URL="$MIGRATE_DATABASE_URL" npm --prefix db run db:migrate; then
  unset MIGRATE_DATABASE_URL
  echo 'db:migrate 失败，停止发版。' >&2
  exit 1
fi
unset MIGRATE_DATABASE_URL
```

- prod 在迁移前必须单独取得 `yes`；dev/test 由用户显式触发对应环境即视为确认。test 迁移目标必须回显为 `101.34.242.103:5433/fengyu_wxapp`，绝不能使用容器网桥地址。
- 命令 0 退出（包括“无 pending migration”）才可进入下一阶段；失败、网络中断或目标库断言失败都立即停止，**不**部署 admin 或云函数。
- 不自动执行 baseline reset、journal 修复、DDL 回滚或数据回填。遇到这类历史/数据问题，停止并按 `db/CLAUDE.md` 的专项流程处理。

---

## §4 Phase 3 — admin 交叉编译 + 发布（除非 `skip-admin`）

```bash
.claude/skills/remote-deploy/deploy-admin.sh $ENV
```
- `$ENV=prod` 时脚本要求输入 `prod:<revision>`；干净工作树的 revision 是 commit，脏工作树是 `<commit>-dirty.<fingerprint>`。dev/test 无交互确认。三个环境的 host、目录和端口均固定，不允许覆盖。
- Phase 2 完成后，脚本会只读复核最新 Drizzle `created_at + hash`；仍有 pending、漂移或数据库领先本地代码时直接停止，不提供迁移或跳过入口。
- 脚本内部：本地配置/RSA/工作树指纹 → 只读迁移门禁 → buildx → 不可变镜像传输与 ID 校验 → 版本化 compose → 健康检查；test 同时验证 `101.34.242.103` 宿主和 `172.18.0.1` 容器网桥。
- 失败时脚本自动恢复上一成功 release；复述 release ID、镜像 tag、HTTP、DB、CloudBase 和 Analyst origin 验证结果。

## §5 Phase 4 — analyst 交叉编译 + 发布（除非 `skip-analyst`）

```bash
.claude/skills/remote-deploy/deploy-analyst.sh $ENV
```

- 正常全量发布时在 admin 发布之后执行，使 admin 顶栏与 analyst 容器使用同一 `ANALYST_PUBLIC_ORIGIN`。
- `$ENV=prod` 时脚本要求输入与 Admin 同规则的 `prod:<revision>`；dev/test 无交互确认。
- 脚本复用与 Admin 相同的本地配置、迁移、固定目标、不可变镜像和版本化回滚核心。
- 复述 release ID、HTTP、DB host 与 `NEXT_PUBLIC_ANALYST_ORIGIN`。失败会自动回滚；需要人工切换上一成功版本时使用 `deploy-analyst.sh --rollback $ENV`。

---

## §6 Phase 5 — 云函数发布（test 强制跳过；否则除非 `skip-cloudfn`；**串行，禁止并行**）

```bash
scripts/use-env.sh $ENV          # 渲染 $ENV cloudbaserc + 写 .active=$ENV（ENV_PROFILE 守卫兜底）
scripts/deploy-cloudfunctions.sh  # prod confirm + 串行双账号 + tcb fn code update ×3
```
- test 禁止运行本段任何命令。`test.env` 的 envId 与 prod 相同，执行会污染生产 CloudBase。
- `$ENV=prod` 时脚本有 confirm（输入 `yes`）；`$ENV=dev` 无 confirm。
- 脚本内置 envId + PG host(IP) 双校验：prod 期望 118.178.196.26 / dev 期望 47.113.202.7，不符即中止（防跨环境污染）。
- 逐个确认 `✓ staffApi deployed` → `✓ clientApi deployed` → `✓ payNotify deployed`。
- **再次强调**：这步绝不开并行 agent（全局 auth.json 单例，并行会互相踢登录）。

---

## §7 Phase 6 — 部署后验证（以线上实际值为准）

详细必检清单见 [reference/verify-checklist.md](reference/verify-checklist.md)。

1. **admin 库终检**【DB assert ③】：
   ```bash
   ssh $SSH_HOST "docker exec fengyu-admin sh -c 'echo \$DATABASE_URL'" | sed -E 's#://[^@]+@#://***@#'
   ```
   dev/prod 必须命中对应公网 IP；test 允许 `172.18.0.1`，但必须同时验证宿主公网 IP=`101.34.242.103` 且 5433 正在监听。不符则报错并提示回滚。

2. **analyst 终检**【DB assert ④】（除非传入 `skip-analyst`）：
   ```bash
   ssh $SSH_HOST "docker exec fengyu-analyst sh -c 'printf \"%s|%s\" \"\$DATABASE_URL\" \"\$NEXT_PUBLIC_ANALYST_ORIGIN\"'" | sed -E 's#://[^@]+@#://***@#'
   ```
   - dev/prod 的 `DATABASE_URL` host 必须为 `$EXPECT_IP`；test 允许 `172.18.0.1`，但须同时验证宿主公网 IP=`101.34.242.103` 且 5433 正在监听。`NEXT_PUBLIC_ANALYST_ORIGIN` 必须等于 Phase 0 的 `ANALYST_PUBLIC_ORIGIN`。
   - 容器状态须为 `running`，`curl http://localhost:3001/` 必须为 `200` 或 `307`。

3. **云函数 env 终检**【DB assert ⑤】（test 跳过）：逐个 `getFunctionConfig`（cloudbase-mcp 或 `tcb fn detail <fn>`）核对**线上**值：
   - 三端 `PG_CONNECTION_STRING` 都 → `$EXPECT_IP:5433/fengyu_wxapp`
   - staffApi：`ALLOW_TEST_OPENID`（prod=false / dev=true）、`WXACODE_ENV_VERSION`（prod=release / dev=develop）、`CLIENT_SECRET` 非空
   - clientApi：`TMAP_KEY` / `TMAP_SECRET` 非空
   - payNotify：`PG_CONNECTION_STRING`（启用支付时还需 `LAKALA_*`）
   - envId 前缀：prod=`fengyu-*-prod-*` / dev=`cloud1-*`
   - 注意：`code update` 不改 env，这些值由首次 provisioning 决定 —— 必须查线上，不能只信 envs/$ENV.env。

4. **冒烟**：`tcb fn invoke staffApi`（空 payload）期望返回 **-401 UNAUTHORIZED**（证明函数运行 + DB 鉴权中间件生效）；返回 **-1** 也算通过（云函数冒烟常见，非 halt 信号）。

5. **版本核对**：`grep APP_VERSION fengyu-client/miniprogram/utils/version.ts fengyu-staff/miniprogram/utils/version.ts` == Phase 0 的 tag。

6. **迁移结果**：复述 Phase 2 的 `db:migrate` 成功输出，并确认执行目标为 `$EXPECT_IP:5433/fengyu_wxapp`；不要在此阶段重复执行迁移。

---

## §8 Phase 7 — 恢复 dev env（防呆，仅发 prod 时）

```bash
# 仅当本次 $ENV=prod：
scripts/use-env.sh dev
```
- 发 prod 后把 `cloudbaserc.json` 重渲染回 dev、`.active` 复位 dev，避免后续误操作打到 prod。
- 发 dev 时保持 dev；发 test 时 active env 从未改变，保持进入发版前的值。

---

## §9 收尾 — 必读手工步骤（自动化无法替代，醒目列给用户）

1. **若本次包含小程序改动，用微信开发者工具重新上传 client + staff 两端小程序**。
   - prod → 正式版；dev → 开发版。test 没有独立小程序/CloudBase 通道，不上传 test 版小程序。
   - 无 miniprogram-ci 通道，纯手工。新 `APP_VERSION` 及任何前端改动**只有重传后才生效**，旧体验版不会自动切。两端都要传。
2. （仅**首次** provisioning，常规更新发版 N/A）CloudBase 控制台手建 HTTP 访问服务（`/cloudfunctions/clientApi`、`/lakala/notify`，enableAuth: false）；若 `CLIENT_SERVICE_URL` 之前是 PLACEHOLDER，需在控制台补 staffApi 的 `CLIENT_API_HTTP_URL` env 变量。
3. 列出发版结束时仍未提交的文件；可提示用户之后用 `/smart-commit`，但未提交状态本身不阻断本次发版。

---

## §10 When to Use / When NOT to Use

**Use**：完整 dev/prod 发版；test admin + 独立测试库发版；只发某一端（用 `skip-*` 参数）；版本号更新。

**NOT**：
- baseline reset、journal 修复、手工 DDL、不可逆数据回填或需要 DB 恢复的 schema 事故 → 先走 `db/CLAUDE.md` 对应专项流程，不能由常规 `db:migrate` 发版处理。
- 首次 provisioning 全流程（HTTP 触发器、lakala 凭证、CLIENT_SERVICE_URL 收尾）。
- 本地 dev 联调 → 用各端原生命令。
- 客户交付源码 zip → 用 `/pack-delivery` skill（合并 main→prod + 剥净注释 + 内置 pack-delivery.mjs 加固打包），与本技能无关；本技能部署的是**原始** `cloudfunctions/`。
