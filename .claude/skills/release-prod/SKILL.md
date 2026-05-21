---
name: release-prod
description: |
  Orchestrates a full production code-release for the fengyu-wxapp monorepo:
  runs pre-flight test/type gates, bumps miniprogram APP_VERSION from the latest
  git tag, cross-compiles the Next.js admin and ships it to the ali-demo host,
  then deploys the three CloudBase cloud functions (staffApi / clientApi /
  payNotify) to production — all targeting prod PG 5433/fengyu_wxapp.
  Use when the user says 发版 / 上线 / 发布生产 / release / ship to prod.
  This is an UPDATE release — never runs DB migrations, never wipes the DB.
argument-hint: "[skip-tests|skip-version|skip-admin|skip-cloudfn]"
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash, Read, Grep
metadata:
  author: NightVoyager
  version: 1.0.0
  title: 生产发版
  description_zh: 预检门禁 + admin 交叉编译发布 ali-demo + client/staff 云函数发布生产 + 版本号更新
---

# release-prod — fengyu-wxapp 生产代码发版

把 monorepo 三端**已存在**的部署脚本编排成一条 prod 发版流水线。本技能**不重写任何部署逻辑**，只按正确顺序调用现有脚本并做部署前后验证。每个 Phase 顺序执行，把命令输出复述给用户。

复用脚本（不要新写、不要改）：
- `node scripts/gen-version.js` — 版本号写入两端 `miniprogram/utils/version.ts`
- `.claude/skills/remote-deploy/deploy-admin.sh prod ali-demo` — admin 交叉编译 + 远程部署
- `scripts/use-env.sh <dev|prod>` — 切 env + 渲染 cloudbaserc（含 ENV_PROFILE 守卫）
- `scripts/deploy-cloudfunctions.sh` — 串行双账号部署 staffApi/clientApi/payNotify

参数（可组合）：`skip-tests` `skip-version` `skip-admin` `skip-cloudfn`。

## Usage

`/release-prod [skip-tests|skip-version|skip-admin|skip-cloudfn]` — 手动触发（生产副作用，不会被自动调用）。无参数 = 走完整 Phase 0→5 + 收尾手工提醒。

---

## §0 护栏（每次发版必须遵守，不可破例）

- 本技能是**代码更新发版，不是初始化**。**禁止**：`db:migrate`、清库、`tcb fn deploy --force`、任何 schema 变更。
- **云函数部署必须串行**：tcb 鉴权是全局单例（`~/.cloudbase-cli/auth.json`），staff 与 client 是**两个不同腾讯子账号**。**绝不**为这步开并行 agent —— 会中途互相踢登录。`deploy-cloudfunctions.sh` 已内部串行处理。
- **永不用 `--force`**：env 变量会被清空（2026-04-02 事故）。只用 `tcb fn code update`（脚本已遵守）。
- 技能**完全不碰 git**（不 commit / 不 push）。版本文件改动留给用户用 `/smart-commit`。
- prod DB 目标硬约束：admin 容器 + 三个云函数的 DB 连接**必须全部指向 `5433/fengyu_wxapp`**（2026-05-21 实测口径：5433=prod 上线前空库，5434=dev/e2e）。部署前后都 assert。
- 若本次涉及 schema 变更：迁移到 5433 是**独立人工前置**（见 `db/CLAUDE.md`），不在本技能内 —— 停下来告诉用户。

---

## §1 Phase 0 — 预检门禁

全部只读 / 无副作用。逐项报告，**任一失败立即停下问用户**，不要继续往下跑。

1. **版本号确认**：`git describe --tags --abbrev=0`
   - 展示将写入的版本号，请用户确认这是本次发版意图的 tag（用户应已手动 `git tag`）。
   - 若 HEAD 没有新 tag，提醒用户先 `git tag vX.Y.Z`，再回来。

2. **类型门禁**：`cd fengyu-admin && npx tsc --noEmit` —— 必须 0 错误。

3. **跨端一致性门禁**（除非传入 `skip-tests`）：
   ```bash
   cd fengyu-staff/cloudfunctions/staffApi && npx vitest run cross-end-error-codes-snapshot cross-end-sql-snapshot
   cd fengyu-admin && npx vitest run src/lib/__tests__/error-codes-cross-end.test.ts src/lib/__tests__/orders-sql-cross-end.test.ts
   ```
   - 重 e2e（L2 `bun run test:l2` / L3 / playwright）**不自动跑**：耗时，且 client 与 staff L2 共用 TE2L2_ 命名空间 + 同一 5434 库，并发会污染夹具产生假失败。如用户要跑，提醒先确认无其它端并发。

4. **prod env 安全扫描**（读 `envs/prod.env`，**不要打印 secret 值**，只断言）：
   - `ENV_PROFILE=prod`、`ALLOW_TEST_OPENID=false`、`WXACODE_ENV_VERSION=release`
   - 【DB assert ①】`PG_CONNECTION_STRING` 含 `5433/fengyu_wxapp`
   - 扫描 `PLACEHOLDER`（尤其 `CLIENT_SERVICE_URL`）→ 命中则告警并问用户是否继续。
     - 说明：更新发版用 `code update` 不会把 PLACEHOLDER 重烤进函数 env；但若这是首次 provisioning 就会，需先在控制台补真实 URL（见 §7）。
   ```bash
   grep -E '^(ENV_PROFILE|ALLOW_TEST_OPENID|WXACODE_ENV_VERSION)=' envs/prod.env
   grep -q '5433/fengyu_wxapp' <(grep '^PG_CONNECTION_STRING=' envs/prod.env) && echo 'PG→5433 ✓' || echo 'PG 目标错误 ✗ 停'
   grep -n 'PLACEHOLDER' envs/prod.env || echo 'no placeholder ✓'
   ```

5. **【DB assert ②】admin 远程库**：admin 的 `ADMIN_DATABASE_URL` 取自 ali-demo 远程 `docker/.env`（被 `docker-compose.prod.yml` 引用），不是本地。
   ```bash
   ssh ali-demo "grep ADMIN_DATABASE_URL /root/proj.xt.com/fengyu-wxapp/docker/.env"
   ```
   - 必须含 `5433/fengyu_wxapp`。远程 docker 目录默认 `/root/proj.xt.com/fengyu-wxapp/docker`（同 `deploy-admin.sh` 第 3 参数默认值）；首跑前确认实际路径。

6. **环境就绪**：
   ```bash
   docker info >/dev/null 2>&1 && echo 'docker ✓' || echo 'docker 未运行 ✗'
   ssh ali-demo true && echo 'ali-demo 可达 ✓'
   cat envs/.active   # 记录当前 env，Phase 5 恢复用
   ```

---

## §2 Phase 1 — 版本号（除非 `skip-version`）

```bash
node scripts/gen-version.js
git --no-pager diff fengyu-client/miniprogram/utils/version.ts fengyu-staff/miniprogram/utils/version.ts
```
- 展示 diff，确认两端 `APP_VERSION` == Phase 0 的 tag。**不 commit**。

---

## §3 Phase 2 — admin 交叉编译 + 发布 ali-demo（除非 `skip-admin`）

```bash
.claude/skills/remote-deploy/deploy-admin.sh prod ali-demo
```
- 脚本对 prod 有**交互式二次确认**（需在终端输入 `yes`）—— 提醒用户这是 interactive prompt。
- 脚本内部：buildx `--platform linux/amd64` 交叉编译 → `docker save | gzip | ssh load` → 同步 compose 文件 → `compose up -d admin cron-worker` → curl 健康检查 + 回显 DATABASE_URL。
- 等待并复述 `✓ HTTP 健康检查通过` 与 DATABASE_URL 回显。

---

## §4 Phase 3 — 云函数发布生产（除非 `skip-cloudfn`；**串行，禁止并行**）

```bash
scripts/use-env.sh prod          # 渲染 prod cloudbaserc + 写 .active=prod（ENV_PROFILE 守卫兜底）
scripts/deploy-cloudfunctions.sh  # prod confirm + 串行双账号 + tcb fn code update ×3
```
- 逐个确认 `✓ staffApi deployed` → `✓ clientApi deployed` → `✓ payNotify deployed`。
- **再次强调**：这步绝不开并行 agent（全局 auth.json 单例，并行会互相踢登录）。

---

## §5 Phase 4 — 部署后验证（以线上实际值为准）

详细必检清单见 [reference/prod-verify-checklist.md](reference/prod-verify-checklist.md)。

1. **admin 库终检**【DB assert ③】：
   ```bash
   ssh ali-demo "docker exec fengyu-admin sh -c 'echo \$DATABASE_URL'"
   ```
   必须含 `5433/fengyu_wxapp`；不符 → 报错并提示回滚（见 reference）。

2. **云函数 env 终检**【DB assert ④】：逐个 `getFunctionConfig`（cloudbase-mcp 或 `tcb fn detail <fn>`）核对**线上**值：
   - 三端 `PG_CONNECTION_STRING` 都 → `5433/fengyu_wxapp`
   - staffApi：`ALLOW_TEST_OPENID=false`、`WXACODE_ENV_VERSION=release`、`CLIENT_SECRET` 非空
   - clientApi：`TMAP_KEY` / `TMAP_SECRET` 非空
   - payNotify：`PG_CONNECTION_STRING`（启用支付时还需 `LAKALA_*`）
   - 注意：`code update` 不改 env，这些值由首次 provisioning 决定 —— 必须查线上，不能只信 prod.env。

3. **冒烟**：`tcb fn invoke staffApi`（空 payload）期望返回 **-401 UNAUTHORIZED**（证明函数运行 + DB 鉴权中间件生效）。

4. **版本核对**：`grep APP_VERSION fengyu-client/miniprogram/utils/version.ts fengyu-staff/miniprogram/utils/version.ts` == Phase 0 的 tag。

5. 重申：**本次未跑任何 DB 迁移**。

---

## §6 Phase 5 — 恢复 dev env（防呆）

```bash
scripts/use-env.sh dev
```
- 把 `cloudbaserc.json` 重渲染回 dev、`.active` 复位 dev，避免后续误操作打到 prod。

---

## §7 收尾 — 必读手工步骤（自动化无法替代，醒目列给用户）

1. **微信开发者工具重新上传 client + staff 两端小程序**并设为体验版/正式版。
   - 无 miniprogram-ci 通道，纯手工。新 `APP_VERSION` 及任何前端改动**只有重传后才生效**，旧体验版不会自动切。两端都要传。
2. （仅**首次** prod provisioning，常规更新发版 N/A）CloudBase 控制台手建 HTTP 访问服务（`/cloudfunctions/clientApi`、`/lakala/notify`，enableAuth: false）；若 `CLIENT_SERVICE_URL` 之前是 PLACEHOLDER，需在控制台补 staffApi 的 `CLIENT_API_HTTP_URL` env 变量。
3. 提示用户用 `/smart-commit` 提交 `version.ts` 改动（技能不碰 git）。

---

## §8 When to Use / When NOT to Use

**Use**：完整 prod 发版；只发某一端（用 `skip-*` 参数）；版本号更新 + 云函数/admin 上线。

**NOT**：
- 需要 DB schema 迁移 → 走 `db/CLAUDE.md`，迁移到 5433 是独立人工前置。
- 首次 prod provisioning 全流程（HTTP 触发器、lakala 凭证、CLIENT_SERVICE_URL 收尾）。
- 本地 dev 联调 → 用各端原生命令。
- 客户交付混淆产物 → 那是 `scripts/build-delivery.js` 产 `delivery/`，与本技能无关；本技能部署的是**原始** `cloudfunctions/`。
