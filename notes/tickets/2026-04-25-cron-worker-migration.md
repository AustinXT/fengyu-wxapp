# Ticket: cronTask 从 CloudBase 云函数迁移到 admin cron-worker

> 生成日期：2026-04-25
> 严重级别：P1（迁移会员等级 / 生日权益 / 积分校验等核心定时任务）
> 端：fengyu-admin（新增 cron-worker sidecar 容器） + fengyu-client（删除 cronTask 云函数）
> 影响面：
> - 新增：`fengyu-admin/src/cron/` 模块 + Docker compose `cron-worker` 服务
> - 删除：`fengyu-client/cloudfunctions/cronTask/`（含 index.js / config.js / __tests__）
> - 修改：`fengyu-client/cloudbaserc.json`（移除 cronTask 配置）+ `docker/Dockerfile.admin` + `docker/docker-compose.yml`
> 前置：无（开发阶段，cronTask 刚开发完未验证，可直接迁移，无需双跑）
> 并行：可与其他业务 ticket 并行，但**自身的 5 个 STEP 串行迁移**避免漏改
>
> **一句话目标**：把 `fengyu-client/cloudfunctions/cronTask`（5 个 STEP 的每日 03:00 定时任务）
> 完整迁移到 admin 仓库下的独立 Node 进程，与 admin 容器同一份 Drizzle schema、共用一份 PG，
> 用 `node-cron` 调度，Docker compose 起独立 sidecar 容器；迁移完成后**直接删除云函数**，不双跑。

---

## 0 一句话背景

cronTask 现状：
- 部署在 fengyu-client envId（`cloud1-3gpht4b01ff88838`），CloudBase 触发器 `0 0 3 * * * *`
- 800 行原生 SQL + 1258 行 vitest 测试（4 个测试文件）
- 5 个 STEP：customer_status / member_level + 升降级权益 / 生日权益 / 感恩日权益 / 积分余额校验
- **业务库已经是同一个 PG（5434/fengyu）**，跟 admin 已经共享数据
- 刚开发完、**线上未跑过一次**，无任何运行时数据依赖

迁移后：
- 改用 admin 的 Drizzle schema + 类型，schema 重命名能被 TS 即时检查到
- 取消跨腾讯云账号部署的负担（client envId 与 staff envId 互不可见）
- Docker compose 一处定义、一次部署、一处看日志
- 复用 admin 已有的 `db/index.ts`、`@db/schema/*` 路径别名、Vitest 测试基础设施

---

## 1 设计决策

### 1.1 进程隔离方式：sidecar 容器（不是 Next.js 路由）

**决策**：在 `docker-compose.yml` 加一个 `cron-worker` 服务，**复用 admin 镜像**，仅覆盖 entrypoint。

**否决方案**：
- ❌ 把 cron 逻辑挂在 admin Next.js 的某个 API route + 外部 HTTP 触发：鉴权复杂、易被外部撞库、Server Action 有 maxDuration 限制
- ❌ pg_cron 数据库扩展：业务逻辑跨表事务太复杂，纯 SQL 难维护
- ❌ Linux crontab 调宿主 docker exec：宿主 cron 与 compose 生命周期不一致

**为什么 sidecar**：
- 跟 admin 共用同一份 build 产物（drizzle / postgres-js / db schema），无重复依赖管理
- compose 一起 up，宕机时跟着重启，运维统一
- 进程内 `node-cron` 调度，重启后自动 catch-up（默认下次触发点）

### 1.2 调度库：`node-cron`

**决策**：用 `node-cron`（npm 周下载 3M+，最简 API），cron 表达式 `0 3 * * *`。

```ts
import cron from 'node-cron'
cron.schedule('0 3 * * *', runDailyJobs, { timezone: 'Asia/Shanghai' })
```

**注意时区**：CloudBase 触发器是 UTC，原 `0 0 3 * * * *` 已被 CloudBase 自动转换为北京时间 03:00。
迁移后必须显式带 `timezone: 'Asia/Shanghai'`，否则会变成 UTC 03:00 = 北京 11:00。

### 1.3 代码位置：admin 项目内 `src/cron/`

**决策**：`fengyu-admin/src/cron/`，作为 admin 子模块；不另开仓库 / 包。

**理由**：
- 直接 import admin 的 `src/db/index.ts`、`@db/schema/*`、`src/lib/operation-log.ts`（如需）
- Vitest 配置一套通用，测试与 actions 测试同跑（`bun run test`）
- TS 类型一致；schema 重命名时 TS 编译会同步报错，不会出现 cron-worker 跟 admin 漂移

### 1.4 SQL 改写策略：核心查询用 Drizzle，复杂批量 UPDATE 保留 raw SQL

**决策**：
- **SELECT 类**：全部改为 Drizzle ORM（query builder），享受类型推断
- **批量 UPDATE 含 WITH / CASE WHEN 类**：保留为 `db.execute(sql\`...\`)` 模板字面量（参数化），但所有列名引用 `customers.customerStatus` 这种从 schema 引入的常量，避免裸字符串

**理由**：cronTask 里 STEP 1 的 `WITH visit_stats AS (...) UPDATE ...` 用 Drizzle 写出来比 raw SQL 还啰嗦；保留 raw SQL 更易读，但通过 schema 引用列名仍能享受 schema 重命名时的类型保护。

### 1.5 配置缓存

**决策**：原 `config.js` 的 `getMemberThreshold` 双层缓存（30s / 5min）**保留不动**，迁移到 `src/cron/config.ts`。

cron-worker 是长驻进程（不像云函数冷启动），缓存反而比云函数更实用。

### 1.6 错误处理：单 STEP 失败不影响下一 STEP

原 cronTask 的入口是 try/catch 包整体 + `BEGIN/ROLLBACK`，单个 STEP 的事务失败会让整个任务失败回滚。

**调整**：每个 STEP 独立 try/catch，单 STEP 失败 console.error 但继续跑下一 STEP。理由：
- STEP 1（customer_status 重算）失败不应阻止 STEP 5（积分审计）
- STEP 2 已经按用户独立子事务，单用户失败不影响其他用户

汇总日志最后输出，整体 worker 仍标记 `success: stepCount - errorStepCount`。

---

## 2 目标产物

### 2.1 新增目录结构

```
fengyu-admin/
├── src/
│   ├── cron/                              # 新增
│   │   ├── index.ts                       # 入口：node-cron 调度 + runDailyJobs()
│   │   ├── config.ts                      # 会员门槛缓存（迁自 cronTask/config.js）
│   │   ├── steps/
│   │   │   ├── refresh-customer-status.ts # STEP 1
│   │   │   ├── refresh-member-levels.ts   # STEP 2（含 grantUpgradeBenefits / processDowngrade）
│   │   │   ├── grant-birthday-benefits.ts # STEP 3
│   │   │   ├── grant-thanksgiving-benefits.ts # STEP 4
│   │   │   └── audit-points-balance.ts    # STEP 5
│   │   ├── lib/
│   │   │   ├── member-level.ts            # determineMemberLevel / isUpgrade / isDowngrade / LEVEL_RANK
│   │   │   └── benefits-loader.ts         # loadBenefitsConfig / loadBirthdayBenefitsConfig / loadThanksgivingBenefitsConfig
│   │   └── __tests__/
│   │       ├── refresh-customer-status.test.ts   # 迁自 customer-status.test.js
│   │       ├── refresh-member-levels.test.ts     # 新增（原 cronTask 缺）
│   │       ├── grant-birthday-benefits.test.ts   # 迁自 birthday.test.js
│   │       ├── grant-thanksgiving-benefits.test.ts # 迁自 thanksgiving.test.js
│   │       ├── audit-points-balance.test.ts      # 新增（原 cronTask 缺）
│   │       └── config.test.ts                    # 迁自 config.test.js
│   └── ...
├── package.json     # 新增 dep: node-cron；新增 script: cron / cron:once
└── tsconfig.json
docker/
├── Dockerfile.admin       # 新增 cron-worker 构建产物
└── docker-compose.yml     # 新增 cron-worker 服务
```

### 2.2 删除目录结构

```
fengyu-client/
├── cloudfunctions/
│   └── cronTask/        # 整个目录删除
└── cloudbaserc.json     # 移除 functions[] 中的 cronTask 配置项
```

云端函数删除：
```bash
cd fengyu-client && tcb fn delete cronTask --envId cloud1-3gpht4b01ff88838
```

---

## 3 实现步骤

### 3.1 STEP A：admin 加 node-cron 依赖与 cron-worker 入口

`fengyu-admin/package.json`：

```diff
   "dependencies": {
+    "node-cron": "^3.0.3",
     ...
   },
   "scripts": {
+    "cron": "node dist/cron-worker.js",
+    "cron:dev": "bun run src/cron/index.ts",
+    "cron:once": "bun run src/cron/index.ts --once",
     ...
   }
```

`fengyu-admin/src/cron/index.ts`：

```ts
import 'dotenv/config'
import cron from 'node-cron'
import { runDailyJobs } from './run'

const ONCE = process.argv.includes('--once')

if (ONCE) {
  // 本地开发 / 部署后冒烟测试：跑一次立即退出
  runDailyJobs()
    .then((result) => {
      console.log('[cron-worker] one-shot done:', JSON.stringify(result))
      process.exit(0)
    })
    .catch((err) => {
      console.error('[cron-worker] one-shot failed:', err)
      process.exit(1)
    })
} else {
  // 生产：长驻调度
  cron.schedule(
    '0 3 * * *',
    () => {
      runDailyJobs().catch((err) => console.error('[cron-worker] tick error:', err))
    },
    { timezone: 'Asia/Shanghai' },
  )

  console.log('[cron-worker] scheduled at 03:00 Asia/Shanghai (cron: 0 3 * * *)')
  // SIGTERM 优雅退出（compose down 时）
  process.on('SIGTERM', () => {
    console.log('[cron-worker] received SIGTERM, exiting')
    process.exit(0)
  })
}
```

`fengyu-admin/src/cron/run.ts`：

```ts
import { db } from '@/db'
import { refreshCustomerStatus } from './steps/refresh-customer-status'
import { refreshMemberLevels } from './steps/refresh-member-levels'
import { grantBirthdayBenefits } from './steps/grant-birthday-benefits'
import { grantThanksgivingBenefits } from './steps/grant-thanksgiving-benefits'
import { auditPointsBalance } from './steps/audit-points-balance'

export async function runDailyJobs() {
  console.log('[cron-worker] start daily jobs at', new Date().toISOString())
  const summary: Record<string, unknown> = {}
  let errorStepCount = 0

  // 单 STEP 失败不影响下一 STEP
  for (const [name, fn] of [
    ['customerStatus', refreshCustomerStatus],
    ['memberLevels', refreshMemberLevels],
    ['birthday', grantBirthdayBenefits],
    ['thanksgiving', grantThanksgivingBenefits],
    ['pointsAudit', auditPointsBalance],
  ] as const) {
    try {
      summary[name] = await fn(db)
      console.log(`[cron-worker] ${name}:`, JSON.stringify(summary[name]))
    } catch (err) {
      errorStepCount++
      summary[name] = { error: (err as Error).message }
      console.error(`[cron-worker] ${name} failed:`, err)
    }
  }

  return { ok: errorStepCount === 0, errorStepCount, summary }
}
```

### 3.2 STEP B：5 个 STEP 改写为 Drizzle/raw SQL 混合

按 §1.4 决策：SELECT 用 Drizzle、批量 UPDATE 保留 raw SQL 但通过 schema 引用列名。

**示例：STEP 1 customer_status 改写**（原 `cronTask/index.js:34-86`）

`src/cron/steps/refresh-customer-status.ts`：

```ts
import { sql } from 'drizzle-orm'
import { clientWechatUsers, serviceOrders } from '@db/schema'
import type { Database } from '@/db'  // 等同 db 类型

export async function refreshCustomerStatus(db: Database) {
  // 段 1：非会员客一律置 NULL
  const cleared = await db.execute(sql`
    UPDATE ${clientWechatUsers}
       SET ${clientWechatUsers.customerStatus} = NULL,
           ${clientWechatUsers.updatedAt} = NOW()
     WHERE ${clientWechatUsers.customerStatus} IS NOT NULL
       AND ${clientWechatUsers.customerType} != '会员客'
  `)

  // 段 2：会员客有到店记录的，按 visits_90d / total_visits 打状态
  const updated = await db.execute(sql`
    WITH visit_stats AS (
      SELECT so.client_user_id,
             MAX(so.service_date) AS last_service_date,
             COUNT(DISTINCT so.service_date) AS total_visits,
             COUNT(DISTINCT so.service_date) FILTER (
               WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
             ) AS visits_90d
      FROM ${serviceOrders} so
      WHERE so.status = '已完成' AND so.client_user_id IS NOT NULL
      GROUP BY so.client_user_id
    )
    UPDATE ${clientWechatUsers} u
       SET ${clientWechatUsers.customerStatus} = CASE
             WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
             WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
             WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '沉睡'::customer_status
             WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
             ELSE '休眠'::customer_status
           END,
           ${clientWechatUsers.updatedAt} = NOW()
      FROM visit_stats vs
     WHERE u.user_id = vs.client_user_id
       AND u.customer_type = '会员客'
  `)

  // 段 3：会员客但无到店记录的，置 '休眠'
  const reset = await db.execute(sql`
    UPDATE ${clientWechatUsers} u
       SET ${clientWechatUsers.customerStatus} = '休眠'::customer_status,
           ${clientWechatUsers.updatedAt} = NOW()
     WHERE u.customer_type = '会员客'
       AND u.user_id NOT IN (
         SELECT DISTINCT client_user_id FROM ${serviceOrders}
         WHERE status = '已完成' AND client_user_id IS NOT NULL
       )
  `)

  return {
    clearedNonMember: cleared.count ?? 0,
    updatedMember: updated.count ?? 0,
    resetNoVisit: reset.count ?? 0,
  }
}
```

> **关键变化**：
> - `${clientWechatUsers}` Drizzle 模板会展开成实际表名（如 `"client_wechat_users"`），表名重命名时 schema 一改全改
> - `${clientWechatUsers.customerStatus}` 同理保护列名
> - `'保有会员-稳定'::customer_status` 这类 PG enum cast 仍是字符串字面量（Drizzle 没有 enum 字面量类型工具），保留即可

**STEP 2~5 改写遵循同一原则**，不在本 ticket 重复贴代码（实现时按文件 1:1 翻译）：
- STEP 2：`refreshMemberLevels` 含 `loadBenefitsConfig` / `grantUpgradeBenefits` / `processDowngrade` —— 保留单用户子事务
- STEP 3：`grantBirthdayBenefits` —— 当日生日 + 当日年份未发放过的会员
- STEP 4：`grantThanksgivingBenefits` —— 仅每月 20 号执行；其他日期返回 `{ skippedNotDay20: true }`
- STEP 5：`auditPointsBalance` —— 写 `operation_logs('points.balanceMismatch')`，**不自动修复**（决策 D7 保留）

### 3.3 STEP C：Dockerfile 加 cron-worker 构建产物

cron-worker 不是 Next 路由，**不能复用 .next/standalone**。需要在 builder 阶段单独 bundle。

`docker/Dockerfile.admin`：

```diff
 # ---- 构建 ----
 FROM base AS builder
 RUN apk add --no-cache nodejs
 WORKDIR /app

 COPY --from=deps /app/node_modules ./node_modules
 COPY --from=deps /db/schema/ /db/schema/
 COPY db/utils/ /db/utils/
 COPY fengyu-admin/ .

 ENV NEXT_TELEMETRY_DISABLED=1
 ENV NODE_ENV=production

 ARG APP_VERSION=dev
 ARG APP_COMMIT=
 ENV APP_VERSION=$APP_VERSION
 ENV APP_COMMIT=$APP_COMMIT

 RUN bun run build
+
+# 构建 cron-worker：bundle 成单文件 dist/cron-worker.js
+RUN bun build src/cron/index.ts \
+      --target=node \
+      --outfile=dist/cron-worker.js \
+      --external pg-native

 # ---- 生产运行 ----
 FROM node:18-alpine AS runner
 WORKDIR /app

 ENV NEXT_TELEMETRY_DISABLED=1
 ENV NODE_ENV=production
 ENV PORT=3000
 ENV HOSTNAME="0.0.0.0"

 RUN addgroup --system --gid 1001 nodejs
 RUN adduser --system --uid 1001 nextjs

-# 复制 standalone 输出
 COPY --from=builder /app/public ./public
 COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
 COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
+# cron-worker bundle（含所有依赖）
+COPY --from=builder --chown=nextjs:nodejs /app/dist/cron-worker.js ./cron-worker.js

 USER nextjs

 EXPOSE 3000

 CMD ["node", "server.js"]
```

> **`--external pg-native`**：postgres-js 默认会尝试 require 原生扩展，但 alpine 镜像没装；标记 external + 使用 JS 实现路径。
> 若打包时报其它依赖问题（如 node-cron 内部模块），按报错追加 `--external <pkg>`。

### 3.4 STEP D：docker-compose 加 cron-worker 服务

`docker/docker-compose.yml`：

```diff
   admin:
     image: fengyu-admin:latest
     ...

+  cron-worker:
+    image: fengyu-admin:latest    # 复用 admin 镜像
+    container_name: fengyu-cron-worker
+    restart: unless-stopped
+    env_file: .env
+    environment:
+      - DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
+      - TZ=Asia/Shanghai
+    depends_on:
+      postgres:
+        condition: service_healthy
+    command: ["node", "cron-worker.js"]   # 覆盖 Dockerfile 的 CMD
+    # 不暴露端口；不需要 healthcheck（任务 cron 触发时才工作）
```

> **`TZ=Asia/Shanghai`** 双保险：node-cron 已带 timezone 参数，但容器系统时区也设上，避免日志时间戳混乱。

### 3.5 STEP E：删除 fengyu-client 侧的 cronTask

```bash
# 1. 切换 client 账号删除云端函数
cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client
tcb logout
# 用 fengyu-client/.env 的 TENCENTCLOUD_SECRETID 登录
tcb login -k --apiKeyId <CLIENT_ID> --apiKey <CLIENT_KEY>
tcb fn delete cronTask --envId cloud1-3gpht4b01ff88838

# 2. 删除本地代码
rm -rf cloudfunctions/cronTask

# 3. 修改 cloudbaserc.json：从 functions[] 中移除 cronTask 那一项
```

`fengyu-client/cloudbaserc.json`：

```diff
   "functions": [
     { "name": "clientApi", ... },
     { "name": "payNotify", ... },
-    { "name": "cronTask", ... }
   ]
```

### 3.6 STEP F：测试迁移

将 `cronTask/__tests__/*.js`（4 个文件、1258 行）迁移到 `src/cron/__tests__/*.test.ts`：
- 改 CommonJS 为 ESM import
- mock pg 客户端改为 mock Drizzle `db`（参照 `src/actions/__tests__/` 已有模式）
- 断言点保持不变（输入相同 → 输出相同）

补充原 cronTask **缺测的两处**：
- `refresh-member-levels.test.ts` —— 升降级路径、锁定期、benefits 配置加载、单用户失败不影响其他用户
- `audit-points-balance.test.ts` —— 偏差检测、operation_logs 写入

### 3.7 STEP G：本地端到端验证

```bash
# 1. 本地起一次（不调度，立即跑一次）
cd fengyu-admin
bun run cron:once

# 2. 容器内验证
cd ..
docker compose -f docker/docker-compose.yml build admin
docker compose -f docker/docker-compose.yml up -d cron-worker
docker logs -f fengyu-cron-worker

# 3. 触发一次（不等到 03:00）
docker exec fengyu-cron-worker node cron-worker.js --once
# 观察日志输出含 5 个 STEP 摘要 + ok: true
```

### 3.8 STEP H：远程部署

`.claude/skills/remote-deploy/deploy-admin.sh` 已有的"传输镜像 + compose up admin"流程会**自动覆盖 cron-worker 容器**（同镜像）。

```bash
# 修改 deploy-admin.sh，最后一行同时 up cron-worker
ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose up -d admin cron-worker"
```

或保持 deploy-admin.sh 不动，只 up admin；cron-worker 跟着重启策略 restart unless-stopped 在镜像 reload 后自动应用新 image。**首次**部署需手动：

```bash
ssh ali-demo "cd /root/proj.xt.com/fengyu-wxapp/docker && docker compose up -d cron-worker"
```

---

## 4 测试策略

### 4.1 单元测试（与现有 admin 测试同 vitest 跑）

`fengyu-admin/src/cron/__tests__/*.test.ts` 共预计 **6 个测试文件、约 1500 行**（迁原 1258 + 新增 STEP 2/5 测试约 250 行）。

最小覆盖 case：
- STEP 1：3 段 SQL 各覆盖一次（非会员客置 NULL / 有访问的会员客分档 / 无访问的会员客置休眠）
- STEP 2：升级 / 降级 / 锁定期 / 配置加载失败兜底 / 单用户错误不影响下个
- STEP 3：当日生日命中 / 已发放跳过 / 配置缺失跳过
- STEP 4：仅 20 号触发 / 当月已发放跳过 / 优惠券 10 天有效期
- STEP 5：偏差检测 / operation_logs 写入正确

集成测试可选（接真实 PG）：
- `bun run cron:once` 跑一遍空库不抛错
- 种 1 个会员客 + 满足升级条件 → 跑后等级正确变化

### 4.2 部署后联调

部署后 12 小时内：
- 03:00 实际触发后 `docker logs fengyu-cron-worker --since 24h` 检查输出
- 5 个 STEP 都有 ok 标志
- 抽查 1 个升级用户的 `operation_logs` / `client_messages` / `point_transactions` / `coupons` 4 张表数据正确

### 4.3 性能

5 个 STEP 串行，各 STEP 内部按用户循环：
- 当前数据量（< 1k 会员客）预计单次执行 < 30s
- 加 `console.time / console.timeEnd` 标记每个 STEP 耗时
- 若执行 > 5 分钟，转为 STEP 内并发（`Promise.all` 限流），但首版不做

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| `bun build` 打包 postgres / node-cron 时漏 `--external` 导致 runner 镜像运行报错 | 本地 `bun build` 后 `node dist/cron-worker.js` 先验，再进 Docker；保留 `--external pg-native` 已知项 |
| node-cron 进程崩溃后未重启导致漏跑 | compose 已有 `restart: unless-stopped`；可加 STEP "进程崩了 → 重启后下次 03:00 继续" 的人工核查清单 |
| 时区配置错（变成 UTC 03:00 = 北京 11:00） | 双保险：node-cron 显式 `timezone: 'Asia/Shanghai'` + 容器 `TZ=Asia/Shanghai`；测试用 `cron:once` 不依赖时区 |
| 5 STEP 串行单点失败 | §1.6 改造为 STEP 级 try/catch，单 STEP 失败不阻塞下一 STEP |
| Drizzle `db.execute(sql\`...\`)` 返回值跟原 `client.query()` 字段名不同（`rowCount` → `count`） | 改写时统一改为 `result.count ?? 0`；测试覆盖 |
| 删除 cronTask 后发现 admin 还没起 / 部署失败 | 部署顺序：先在 admin 跑通 cron:once + 部署 sidecar 验证日志 → 再 `tcb fn delete cronTask` |
| 双进程同时跑（删除前 admin 已上线 = 重复发权益） | 严格按"先验证 admin 单跑成功 → 再删云函数"顺序；中间有时间窗就让 admin 等 1 天，云函数 03:00 跑完后再上 admin |

---

## 6 不在本 ticket 范围

- 监控告警接入（Prometheus / 钉钉机器人推送 cron 失败）—— 后续 ticket
- 把 STEP 内循环改并发 / 限流 —— 当前数据量 < 1k 不需要
- 把 cron-worker 拆成多个进程（每个 STEP 独立容器）—— 单进程已足够
- pg_cron 扩展尝试 —— 已在 §1.1 否决
- 历史数据回填 —— 全新功能、无回填需求

---

## 7 交付物清单

### 7.1 新增

- [ ] `fengyu-admin/src/cron/index.ts`（节流入口 + node-cron 调度 + `--once` 模式）
- [ ] `fengyu-admin/src/cron/run.ts`（runDailyJobs 串行 5 STEP）
- [ ] `fengyu-admin/src/cron/config.ts`（迁自 cronTask/config.js，会员门槛缓存）
- [ ] `fengyu-admin/src/cron/lib/member-level.ts`（determineMemberLevel / isUpgrade / isDowngrade）
- [ ] `fengyu-admin/src/cron/lib/benefits-loader.ts`（3 个 loadXxxBenefitsConfig）
- [ ] `fengyu-admin/src/cron/steps/refresh-customer-status.ts`（STEP 1）
- [ ] `fengyu-admin/src/cron/steps/refresh-member-levels.ts`（STEP 2 + 升降级 + 单用户子事务）
- [ ] `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts`（STEP 3）
- [ ] `fengyu-admin/src/cron/steps/grant-thanksgiving-benefits.ts`（STEP 4 + 20 号判断）
- [ ] `fengyu-admin/src/cron/steps/audit-points-balance.ts`（STEP 5）
- [ ] `fengyu-admin/src/cron/__tests__/*.test.ts`（6 个测试文件）

### 7.2 修改

- [ ] `fengyu-admin/package.json`：新增 `node-cron` 依赖 + `cron` / `cron:dev` / `cron:once` scripts
- [ ] `docker/Dockerfile.admin`：builder 阶段加 `bun build` cron-worker；runner 阶段 COPY cron-worker.js
- [ ] `docker/docker-compose.yml`：新增 `cron-worker` 服务（复用 admin 镜像，覆盖 command）
- [ ] `.claude/skills/remote-deploy/deploy-admin.sh`：最后一步 `up -d admin cron-worker`
- [ ] `fengyu-admin/CLAUDE.md`：新增"cron-worker 子模块"章节，列出 5 个 STEP 与触发时间
- [ ] `fengyu-client/CLAUDE.md`：从云函数清单移除 cronTask（该文档原本就漏列，顺手补正）
- [ ] `fengyu-client/cloudbaserc.json`：移除 cronTask 配置项

### 7.3 删除

- [ ] `fengyu-client/cloudfunctions/cronTask/`（整个目录）
- [ ] CloudBase 远程函数：`tcb fn delete cronTask --envId cloud1-3gpht4b01ff88838`

### 7.4 验证

- [ ] `bun run test` 全绿（admin 测试集 + cron 新增 6 个测试文件）
- [ ] `bun run cron:once` 本地跑一次，5 STEP 摘要 + `ok: true`
- [ ] Docker compose 起 cron-worker 容器，`docker logs` 看到 "scheduled at 03:00"
- [ ] 远程部署后次日 03:00 实际触发，日志含完整 5 STEP 摘要
- [ ] 抽样 1 个升级会员的下游 4 张表数据正确（`operation_logs` / `client_messages` / `point_transactions` / `coupons`）
