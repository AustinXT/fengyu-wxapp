---
name: release-all
description: |
  Orchestrates a full code-release for the fengyu-wxapp monorepo to either dev or prod:
  runs pre-flight test/type gates, bumps miniprogram APP_VERSION from the latest
  git tag, runs pending Drizzle migrations against the selected target database,
  cross-compiles the Next.js admin and fengyu-analyst, then ships both to the target host
  (prod→fengyu-prod / dev→ali-demo), then deploys the three CloudBase cloud
  functions (staffApi / clientApi / payNotify) to the target CloudBase env —
  prod targets 118.178.196.26:5433, dev targets 47.113.202.7:5433 (both fengyu_wxapp).
  Use when the user says 发版 / 上线 / 发布生产 / 发布测试 / 发 dev / release / ship to dev|prod.
  This is an UPDATE release — runs pending migrations only through db:migrate, never wipes the DB.
argument-hint: '[dev|prod] [skip-tests|skip-version|skip-admin|skip-analyst|skip-cloudfn]'
disable-model-invocation: true
user-invocable: true
allowed-tools: 'Bash, Read, Grep'
metadata:
  author: NightVoyager
  version: 2.2.0
  title: 代码发版（dev/prod）
  description_zh: 预检门禁 + 目标库 db:migrate + admin/analyst 交叉编译发布 + client/staff 云函数发布 + 版本号更新（dev/prod 双环境参数化）
  license: 42plugin-personal
---

# release-all — fengyu-wxapp 代码发版（dev/prod）

把 monorepo 各运行端**已存在**的部署脚本编排成一条发版流水线，**支持 dev 和 prod 双环境**（参数选择，无参默认 prod）。本技能**不重写任何部署逻辑**，只按正确顺序调用现有脚本并做部署前后验证。每个 Phase 顺序执行，把命令输出复述给用户。

## 目标环境（ENV 形参）

`/release-all <dev|prod> [skip-*]`：首个 token 为 `dev` 或 `prod` 时锁定该环境；无环境参数默认 `prod`。发版全程按 ENV 切换下表（下文以 `$ENV` / `$SSH_HOST` / `$EXPECT_IP` 代指）：

| 维度 | dev | prod |
|------|-----|------|
| SSH host（admin / analyst） | `ali-demo` | `fengyu-prod` |
| DB host（IP 断言 `$EXPECT_IP`） | `47.113.202.7` | `118.178.196.26` |
| env 文件 | `envs/dev.env` | `envs/prod.env` |
| `ENV_PROFILE` | `dev` | `prod` |
| `ALLOW_TEST_OPENID` | `true` | `false` |
| `WXACODE_ENV_VERSION` | `develop` | `release` |
| staff envId | `cloud1-9g3ydpg512eecc99` | `fengyu-staff-prod-d4dtv6052992e9` |
| client envId | `cloud1-3gpht4b01ff88838` | `fengyu-client-prod-d1cga6909c0ba` |
| admin 部署命令 | `deploy-admin.sh dev` | `deploy-admin.sh prod` |
| analyst 部署命令 | `deploy-analyst.sh dev` | `deploy-analyst.sh prod` |
| 云函数 confirm | 无（dev 不 prompt） | 有（输入 yes） |

两端均用 5433 端口 + `fengyu_wxapp` 库名，仅靠 IP 区分环境（2026-07-17 迁移后口径）。

复用脚本（不要新写、不要改）：
- `node scripts/gen-version.js` — 版本号写入两端 `miniprogram/utils/version.ts`（env 无关）
- `npm --prefix db run db:migrate` — 将 Drizzle pending migration 应用到显式指定的目标库
- `.claude/skills/remote-deploy/deploy-admin.sh <dev|prod>` — admin 交叉编译 + 远程部署（dev 一等公民，两端均走 admin override 连远程 PG + DB IP 断言）
- `.claude/skills/remote-deploy/deploy-analyst.sh <dev|prod>` — analyst 交叉编译 + 远程部署（读取同环境 `ANALYST_PUBLIC_ORIGIN`，并校验容器 DB / public origin）
- `scripts/use-env.sh <dev|prod>` — 切 env + 渲染 cloudbaserc（含 ENV_PROFILE 守卫）
- `scripts/deploy-cloudfunctions.sh` — 按 `.active` 串行双账号部署 staffApi/clientApi/payNotify

参数（可组合）：`dev` / `prod`（二选一，默认 prod）+ `skip-tests` `skip-version` `skip-admin` `skip-analyst` `skip-cloudfn`。数据库迁移是发布前硬门禁，**不提供** `skip-migrate`。

## Usage

`/release-all [dev|prod] [skip-tests|skip-version|skip-admin|skip-analyst|skip-cloudfn]` — 手动触发（有部署副作用，不会被自动调用）。无环境参数 = prod 全流程；显式 `dev` = 发测试环境（ali-demo + 47.113.202.7）。无论目标环境，均在代码部署前执行目标库的 `db:migrate`。

---

## §0 护栏（每次发版必须遵守，不可破例）

- 本技能是**代码更新发版，不是初始化**。只允许用 `DATABASE_URL=<目标库> npm --prefix db run db:migrate` 应用本次发版工作树中已 review 的 Drizzle migration；**禁止**：清库、`db:push`、手写 DDL、`db:baseline:reset`、`tcb fn deploy --force`。
- **云函数部署必须串行**：tcb 鉴权是全局单例（`~/.cloudbase-cli/auth.json`），staff 与 client 是**两个不同腾讯子账号**。**绝不**为这步开并行 agent —— 会中途互相踢登录。`deploy-cloudfunctions.sh` 已内部串行处理。
- **永不用 `--force`**：env 变量会被清空（2026-04-02 事故）。只用 `tcb fn code update`（脚本已遵守）。
- 技能**完全不碰 git**（不 commit / 不 push）。版本文件改动留给用户用 `/smart-commit`。
- **目标 DB 硬约束**：admin / analyst 容器 + 三个云函数的 DB 连接**必须全部指向 `$EXPECT_IP:5433/fengyu_wxapp`**（prod=118.178.196.26 / dev=47.113.202.7）。部署前后都 assert。
- **发 prod 后必须恢复 dev env（§8）**，避免误留 prod 配置；发 dev 则保持 dev（dev 是安全态）。
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

4. **analyst 发布配置**（除非传入 `skip-analyst`）：读取 `envs/$ENV.env` 的 `ANALYST_PUBLIC_ORIGIN`，必须是无账号密码的 `http` 或 `https` URL。该值会同时注入 admin 顶栏和 analyst 镜像；缺失或格式错误立即停止，不能让生产入口指向另一环境。`skip-analyst` 时跳过本项与 Phase 4/Phase 6 的 analyst 专属检查。
   ```bash
   ANALYST_PUBLIC_ORIGIN="$(grep -m1 '^ANALYST_PUBLIC_ORIGIN=' "envs/$ENV.env" | cut -d= -f2- | tr -d '\r\"')"
   test -n "$ANALYST_PUBLIC_ORIGIN" || { echo 'ANALYST_PUBLIC_ORIGIN 缺失 ✗ 停' >&2; exit 1; }
   node -e 'const u = new URL(process.argv[1]); if (!/^https?:$/.test(u.protocol) || u.username || u.password) process.exit(1); console.log(`analyst public origin -> ${u.origin} ✓`)' "$ANALYST_PUBLIC_ORIGIN" || { echo 'ANALYST_PUBLIC_ORIGIN 格式错误 ✗ 停' >&2; exit 1; }
   unset ANALYST_PUBLIC_ORIGIN
   ```

5. **目标 env 安全扫描**（读 `envs/$ENV.env`，**不要打印 secret 值**，只断言）：
   - `ENV_PROFILE=$ENV`
   - prod 专属：`ALLOW_TEST_OPENID=false`、`WXACODE_ENV_VERSION=release`
   - dev 专属：`ALLOW_TEST_OPENID=true`、`WXACODE_ENV_VERSION=develop`（dev 容许测试 openid）
   - 【DB assert ①】`PG_CONNECTION_STRING` 与迁移使用的 `ADMIN_DATABASE_URL` 均为 `$EXPECT_IP:5433/fengyu_wxapp`（dev/测试同库名同端口，按 IP 断言）
   - 扫描 `PLACEHOLDER`（尤其 `CLIENT_SERVICE_URL`）→ 命中则告警并问用户是否继续。
     - 说明：更新发版用 `code update` 不会把 PLACEHOLDER 重烤进函数 env；但若这是首次 provisioning 就会，需先在控制台补真实 URL（见 §8）。
   ```bash
   grep -E '^(ENV_PROFILE|ALLOW_TEST_OPENID|WXACODE_ENV_VERSION)=' envs/$ENV.env
   grep -q "$EXPECT_IP" <(grep '^PG_CONNECTION_STRING=' envs/$ENV.env) || { echo 'cloudfn PG 目标错误 ✗ 停' >&2; exit 1; }
   echo "cloudfn PG→$ENV($EXPECT_IP) ✓"
   MIGRATE_DATABASE_URL="$(grep -m1 '^ADMIN_DATABASE_URL=' "envs/$ENV.env" | cut -d= -f2- | tr -d '\r\"')"
   test -n "$MIGRATE_DATABASE_URL" || { echo 'ADMIN_DATABASE_URL 缺失 ✗ 停'; exit 1; }
   node -e 'const u=new URL(process.argv[1]), h=process.argv[2]; if (u.hostname!==h || u.port!=="5433" || u.pathname!=="/fengyu_wxapp") process.exit(1); console.log(`migration DB→${u.hostname}:${u.port}${u.pathname} ✓`)' "$MIGRATE_DATABASE_URL" "$EXPECT_IP" || { echo 'migration DB 目标错误 ✗ 停' >&2; exit 1; }
   unset MIGRATE_DATABASE_URL
   grep -n 'PLACEHOLDER' envs/$ENV.env || echo 'no placeholder ✓'
   ```
   （`$ENV` / `$EXPECT_IP` 执行时按上方事实表代入实际值。）

6. **【DB assert ②】admin / analyst 远程库**：两者均经 compose remote override 读取 `$SSH_HOST` 的 `docker/.env` 中 `ADMIN_DATABASE_URL`，不是本地。
   ```bash
   # prod=/www/wwwroot/fengyu-admin/docker; dev=/root/proj.xt.com/fengyu-wxapp/docker
   ssh $SSH_HOST "grep ADMIN_DATABASE_URL $REMOTE_DIR/.env" | sed -E 's#://[^@]+@#://***@#'
   ```
   - 必须含 `$EXPECT_IP`（按 IP 断言）。`REMOTE_DIR` 默认 prod=`/www/wwwroot/fengyu-admin/docker`、dev=`/root/proj.xt.com/fengyu-wxapp/docker`（与 `deploy-admin.sh` 一致）；远程路径首跑前确认。

7. **环境就绪**：
   ```bash
   docker info >/dev/null 2>&1 && echo 'docker ✓' || echo 'docker 未运行 ✗'
   ssh $SSH_HOST true && echo "$SSH_HOST 可达 ✓"
   cat envs/.active   # 记录当前 env；发 prod 时 Phase 6 须恢复回此值
   ```

---

## §2 Phase 1 — 版本号（除非 `skip-version`）

```bash
node scripts/gen-version.js
git --no-pager diff fengyu-client/miniprogram/utils/version.ts fengyu-staff/miniprogram/utils/version.ts
```
- 展示 diff，确认两端 `APP_VERSION` == Phase 0 的 tag。**不 commit**。

---

## §3 Phase 2 — 数据库迁移（强制，不可跳过）

此阶段必须在任何会读取新 schema 的 admin 或云函数代码上线前完成。每次均显式传入目标库 URL，**绝不**使用 `db/.env` 的默认连接，也不输出 URL 中的凭据。

```bash
MIGRATE_DATABASE_URL="$(grep -m1 '^ADMIN_DATABASE_URL=' "envs/$ENV.env" | cut -d= -f2- | tr -d '\r\"')"
test -n "$MIGRATE_DATABASE_URL" || { echo 'ADMIN_DATABASE_URL 缺失'; exit 1; }
node -e 'const u=new URL(process.argv[1]), h=process.argv[2]; if (u.hostname!==h || u.port!=="5433" || u.pathname!=="/fengyu_wxapp") { console.error("migration DB target mismatch"); process.exit(1); } console.log(`migration DB→${u.hostname}:${u.port}${u.pathname} ✓`)' "$MIGRATE_DATABASE_URL" "$EXPECT_IP" || { echo 'migration DB 目标错误，停止发版。' >&2; exit 1; }
if ! DATABASE_URL="$MIGRATE_DATABASE_URL" npm --prefix db run db:migrate; then
  unset MIGRATE_DATABASE_URL
  echo 'db:migrate 失败，停止发版。' >&2
  exit 1
fi
unset MIGRATE_DATABASE_URL
```

- `$ENV=prod` 时，在执行 `db:migrate` 命令前，必须明确告知用户即将迁移 `118.178.196.26:5433/fengyu_wxapp`，并取得本次迁移的 `yes` 确认；`dev` 由用户触发 `/release-all dev` 即视为确认。
- 命令 0 退出（包括“无 pending migration”）才可进入下一阶段；失败、网络中断或目标库断言失败都立即停止，**不**部署 admin 或云函数。
- 不自动执行 baseline reset、journal 修复、DDL 回滚或数据回填。遇到这类历史/数据问题，停止并按 `db/CLAUDE.md` 的专项流程处理。

---

## §4 Phase 3 — admin 交叉编译 + 发布（除非 `skip-admin`）

```bash
.claude/skills/remote-deploy/deploy-admin.sh $ENV
```
- `$ENV=prod` 时脚本有**交互式二次确认**（输入 `yes`）+ 生产库迁移状态预检；`$ENV=dev` 无 confirm（测试环境）。
- Phase 2 已完成后，prod 预检应显示无 pending migration；若仍提示待迁移，视为工作树在发版中变化或迁移未成功，选择中止并从 Phase 0 重跑，不依赖该脚本的兜底迁移。若仅因本机缺少 `psql` 进入“跳过迁移预检”询问，只有在 Phase 2 已成功且目标断言通过时才允许跳过。
- 脚本内部：prod 迁移状态预检（仅 prod）→ buildx `--platform linux/amd64` → `docker save|gzip|ssh load` → 同步 base+override compose（dev/prod 通用）→ `compose up -d admin cron-worker` → curl 健康检查 → **DB IP 断言**（host==$EXPECT_IP，不符即报错+回滚指引）。
- 复述 `✓ HTTP 健康检查通过`、RSA 公钥来源、DATABASE_URL 脱敏回显、`✓ admin DB host=... 与 $ENV 一致`。
- ⚠️ dev admin 首跑前确认 ali-demo 远程 `docker/.env` 已配 `ADMIN_DATABASE_URL`/`ADMIN_JWT_SECRET`/`ADMIN_RSA_PRIVATE_KEY`（实测已配，连 47.113.202.7）；旧 trick `deploy-admin.sh prod ali-demo` 已被 DB 断言淘汰，发 ali-demo 一律用 `deploy-admin.sh dev`。

## §5 Phase 4 — analyst 交叉编译 + 发布（除非 `skip-analyst`）

```bash
.claude/skills/remote-deploy/deploy-analyst.sh $ENV
```

- 正常全量发布时在 admin 发布之后执行，使 admin 顶栏与 analyst 容器使用同一 `ANALYST_PUBLIC_ORIGIN`。
- `$ENV=prod` 时脚本有交互式二次确认（输入 `yes`）；`$ENV=dev` 无 confirm。
- 脚本内部：本地 buildx `--platform linux/amd64` → 镜像传输 → 同步 compose + analyst 运行期配置 → `compose up -d analyst` → 容器、HTTP、DB IP、`NEXT_PUBLIC_ANALYST_ORIGIN`、JWT 终检。
- 复述 `✓ HTTP 健康检查通过`、DATABASE_URL 脱敏回显、`NEXT_PUBLIC_ANALYST_ORIGIN` 与 Phase 0 的值一致，以及 analyst DB host 与 `$ENV` 一致。失败时停止，按脚本输出使用 `deploy-analyst.sh --rollback $SSH_HOST` 回滚。

---

## §6 Phase 5 — 云函数发布（除非 `skip-cloudfn`；**串行，禁止并行**）

```bash
scripts/use-env.sh $ENV          # 渲染 $ENV cloudbaserc + 写 .active=$ENV（ENV_PROFILE 守卫兜底）
scripts/deploy-cloudfunctions.sh  # prod confirm + 串行双账号 + tcb fn code update ×3
```
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
   必须 host=`$EXPECT_IP`；不符 → 报错并提示回滚（见 reference）。

2. **analyst 终检**【DB assert ④】（除非传入 `skip-analyst`）：
   ```bash
   ssh $SSH_HOST "docker exec fengyu-analyst sh -c 'printf \"%s|%s\" \"\$DATABASE_URL\" \"\$NEXT_PUBLIC_ANALYST_ORIGIN\"'" | sed -E 's#://[^@]+@#://***@#'
   ```
   - `DATABASE_URL` host 必须为 `$EXPECT_IP`；`NEXT_PUBLIC_ANALYST_ORIGIN` 必须等于 Phase 0 的 `ANALYST_PUBLIC_ORIGIN`。
   - 容器状态须为 `running`，`curl http://localhost:3001/` 必须为 `200` 或 `307`。

3. **云函数 env 终检**【DB assert ⑤】：逐个 `getFunctionConfig`（cloudbase-mcp 或 `tcb fn detail <fn>`）核对**线上**值：
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
- 发 dev 时**跳过此步**（已是 dev，保持即可）。

---

## §9 收尾 — 必读手工步骤（自动化无法替代，醒目列给用户）

1. **微信开发者工具重新上传 client + staff 两端小程序**并设为体验版/正式版。
   - prod 发版 → 传正式版；dev 发版 → 传开发版/体验版。
   - 无 miniprogram-ci 通道，纯手工。新 `APP_VERSION` 及任何前端改动**只有重传后才生效**，旧体验版不会自动切。两端都要传。
2. （仅**首次** provisioning，常规更新发版 N/A）CloudBase 控制台手建 HTTP 访问服务（`/cloudfunctions/clientApi`、`/lakala/notify`，enableAuth: false）；若 `CLIENT_SERVICE_URL` 之前是 PLACEHOLDER，需在控制台补 staffApi 的 `CLIENT_API_HTTP_URL` env 变量。
3. 提示用户用 `/smart-commit` 提交 `version.ts` 改动（技能不碰 git）。

---

## §10 When to Use / When NOT to Use

**Use**：完整 dev/prod 发版；只发某一端（用 `skip-*` 参数）；dev 验证即将上 prod 的代码；版本号更新 + admin/analyst/云函数上线。

**NOT**：
- baseline reset、journal 修复、手工 DDL、不可逆数据回填或需要 DB 恢复的 schema 事故 → 先走 `db/CLAUDE.md` 对应专项流程，不能由常规 `db:migrate` 发版处理。
- 首次 provisioning 全流程（HTTP 触发器、lakala 凭证、CLIENT_SERVICE_URL 收尾）。
- 本地 dev 联调 → 用各端原生命令。
- 客户交付源码 zip → 用 `/pack-delivery` skill（合并 main→prod + 剥净注释 + 内置 pack-delivery.mjs 加固打包），与本技能无关；本技能部署的是**原始** `cloudfunctions/`。
