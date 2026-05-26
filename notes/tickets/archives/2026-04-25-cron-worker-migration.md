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

### 1.6 事务模型：保留原 cronTask 的 STEP 级隔离 + 新增 STEP 级 try/catch

**原 cronTask 的事务边界**（实际代码确认，与首次描述不同，做澄清）：

| STEP | 事务边界 | 失败影响 |
|---|---|---|
| STEP 1（customer_status） | **整体一个事务**：3 段 SQL 在同一 BEGIN/COMMIT | 任一段失败 → 整段回滚，但不影响后续 STEP（因为在入口 try 里被 catch） |
| STEP 2（member_level） | 外层无事务；**每个用户一个子事务**（processUpgrade/processDowngrade 自己 BEGIN/COMMIT） | 单用户失败：ROLLBACK 该用户、`errorCount++`、继续下个用户 |
| STEP 3（生日权益） | 外层无事务；**每个用户一个子事务**（grantBirthdayBenefits + operation_logs） | 同 STEP 2 |
| STEP 4（感恩日权益） | 外层无事务；**每个用户一个子事务**；**day≠20 直接短路返回** | 同 STEP 2 |
| STEP 5（积分审计） | **无事务**：仅 SELECT + 逐条 INSERT operation_logs | 单条失败：原代码会向上抛、终止该 STEP；其他 STEP 已跑完不受影响 |

但**原入口的整体 try/catch 仍是单点**：原 `exports.main` 的 try 块包了 STEP 1~5 全部串行调用，**任意 STEP 抛 uncaught error 会跳到入口 catch、记录 ERROR、return -1，剩余 STEP 不跑**（注意：STEP 1 的 ROLLBACK 是 catch 里调用，但 STEP 2~5 内部出错时入口 catch 也只会 ROLLBACK 一次没用的事务）。

**迁移调整**：
- 入口 `runDailyJobs()` 用 §3.1 的 `for ([name, fn] of [...])` 循环，**每个 STEP 独立 try/catch**——避免 STEP 1 失败导致 STEP 5 不跑
- 每个 STEP 内部的子事务改用 `db.transaction(async (tx) => ...)`，比手写 BEGIN/COMMIT 更安全（异常自动 ROLLBACK）
- STEP 1 整体事务也用 `db.transaction()` 包三段 SQL
- 汇总日志最后输出 `{ ok, errorStepCount, summary }`，errorStepCount > 0 时 worker 进程**不退出**（保持 cron 调度），仅写 console.error

### 1.7 关键遗漏点（与首版 ticket 的修正与补充）

迁移过程中**必须遵守**以下约定，否则会出现数据漂移或下游兼容问题。

**A. postgres-js 的 `db.execute(sql\`...\`)` 返回值不同于 pg**

| 调用 | pg（原 cronTask） | postgres-js（admin） |
|---|---|---|
| UPDATE / DELETE 后影响行数 | `result.rowCount` | `result.count`（Drizzle 包装后）；裸 postgres-js 是 `result.length === 0` 但带 `.count` 属性 |
| INSERT ... ON CONFLICT ... RETURNING id | `result.rowCount > 0 ? result.rows[0].id : null` | `result.length > 0 ? result[0].id : null`（postgres-js 直接返回 array） |
| SELECT | `result.rows`（数组） | `result`（直接是数组） |

**约定**：所有 `db.execute(sql\`...\`)` 调用都 `as any[]`（参考 `allocations.ts:51`），按 array 处理；判断"插入是否成功"用 `inserted.length > 0` 而不是 `inserted.rowCount`。

**B. `operation_logs.source` 字段保留 `'cronTask'` 字符串**

原代码所有日志写 `source = 'cronTask'`（5 处：memberLevelChange / memberLevelHeld / birthdayBenefits / thanksgivingBenefits / points.balanceMismatch）。

**决策**：迁移到 cron-worker 后**保留 `'cronTask'` 不改**。理由：
- admin 日志页 / 历史 SQL 报表可能按这个 source 字符串筛选
- source 是审计字段，名称稳定有利于历史数据追溯
- 如要改名应另开 ticket 同时改下游

**C. 年份 / 月份必须从 DB 取，不能用 JS `new Date()`**

原代码三处明确从 DB 取（注释写明"规避 CloudBase Node.js UTC 时区漂移"）：
- STEP 3：`SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS year`
- STEP 4 day 判断：`SELECT EXTRACT(DAY FROM CURRENT_DATE)::int AS d`
- STEP 4 月份字符串：`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM') AS ym`

**迁移后保留全部这些 SQL**。即使容器 `TZ=Asia/Shanghai`，也不靠 JS 的 `new Date().getFullYear()`——保留"DB 是单一时间真相"的语义。

**D. benefits config 不缓存（每次 STEP 跑前 load）**

原代码 `loadBenefitsConfig` / `loadBirthdayBenefitsConfig` / `loadThanksgivingBenefitsConfig` 每次进入 STEP 时都重新 SELECT。**保留此行为**：admin 改了 system_configs.value 后下次 03:00 应即时生效，不能因为 cron-worker 长驻进程缓存而漂移。

**例外**：`new_member_threshold` 单独缓存（30s/5min 双层），因为 STEP 2 在 for 循环里每个用户都调用 `getMemberThreshold`，对所有顾客来说门槛是同一个值。

**E. `system_configs.value` 的列类型**

原代码假设 value 是 text（手动 `JSON.parse`）。迁移前先 grep 确认：

```bash
grep -n "value:" db/schema/system-configs.ts 2>/dev/null
```

- 如果是 `text` → 保留 `JSON.parse(row.value)`
- 如果是 `jsonb` → Drizzle 自动 parse，去掉 `JSON.parse`
- 如果不一致 → 在 ticket §3.2 实施时统一为 `jsonb`（更安全）

**F. tsconfig paths 解析在 bun build 中**

`@db/schema` / `@db/utils` 路径别名在 admin 的 `tsconfig.json paths` 已配置。`bun build` 默认读 tsconfig.json paths，无需额外配置。但如果用 esbuild/tsup 替代 bun build，需手动配 alias resolver。

**G. `member_level` PG enum 在 raw SQL 中保持字符串字面量**

原代码 SQL 含 `'保有会员-稳定'::customer_status` / `'初钻'`/`'星钻'` 等。Drizzle 不直接提供 enum 字面量类型工具，**保留字符串**即可。

但 schema 里的 enum 常量（如 `clientWechatUsers.memberLevel`）做列名引用仍可享受重命名保护——因此 `${clientWechatUsers.memberLevel} = '初钻'::member_level` 这种写法兼顾"列名保护 + 值保留中文字面量"。

**H. `member_level_locked_until` 与 `became_member_at` 的边界**

原代码 processUpgrade / processDowngrade 注释明确：
- 不写 `became_member_at`（该字段仅在 customer_type 跃迁到 '会员客' 时由 staffApi/payNotify 写入）
- 写入字段：`old_member_level` / `member_level` / `member_level_upgraded_at` / `member_level_locked_until`

迁移代码必须**完整保留这个边界**，不能"为了完整性"顺手写 `became_member_at = NOW()`。

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

---

#### STEP 2：member_level 重算 + 升降级权益

**`src/cron/lib/member-level.ts`**（纯函数，迁自 cronTask/index.js:91-113）：

```ts
import type { MemberLevel } from '@db/schema'  // PG enum 类型导出

export const LEVEL_RANK: Record<string, number> = {
  null: 0, '初钻': 1, '星钻': 2, '粉钻': 3, '金钻': 4, '黑钻': 5,
}

export function determineMemberLevel(spend: number, threshold: number): MemberLevel | null {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000)  return '金钻'
  if (spend >= 30000)  return '粉钻'
  if (spend >= 10000)  return '星钻'
  if (spend >= threshold) return '初钻'
  return null
}

export function isUpgrade(from: MemberLevel | null, to: MemberLevel | null): boolean {
  return (LEVEL_RANK[String(to)] || 0) > (LEVEL_RANK[String(from)] || 0)
}

export function isDowngrade(from: MemberLevel | null, to: MemberLevel | null): boolean {
  return (LEVEL_RANK[String(to)] || 0) < (LEVEL_RANK[String(from)] || 0)
}
```

**`src/cron/lib/benefits-loader.ts`**（迁自 cronTask/index.js:119-133，三套配置加载共享一个工厂）：

```ts
import { sql } from 'drizzle-orm'
import type { Database } from '@/db'

type ConfigKey = 'member_level_benefits' | 'birthday_benefits' | 'thanksgiving_benefits'

export async function loadJsonConfig<T = Record<string, any>>(
  db: Database,
  key: ConfigKey,
): Promise<T | null> {
  const rows = (await db.execute(sql`
    SELECT value FROM system_configs WHERE key = ${key}
  `)) as any[]
  if (!rows[0]?.value) {
    console.warn(`[cron-worker] ${key} 配置不存在，跳过对应 STEP`)
    return null
  }
  try {
    // 注意：value 列若已是 jsonb，Drizzle 已自动 parse，去掉 JSON.parse
    // 见 §1.7 E
    return typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value
  } catch (err) {
    console.error(`[cron-worker] ${key} 解析失败:`, (err as Error).message)
    return null
  }
}
```

**`src/cron/steps/refresh-member-levels.ts`**（迁自 cronTask/index.js:215-384）：

```ts
import { sql, eq } from 'drizzle-orm'
import { clientWechatUsers, saleOrders, operationLogs, messages,
         pointTransactions, userCoupons, couponTemplates } from '@db/schema'
import type { Database } from '@/db'
import { determineMemberLevel, isUpgrade, isDowngrade, LEVEL_RANK } from '../lib/member-level'
import { loadJsonConfig } from '../lib/benefits-loader'
import { getMemberThreshold } from '../config'

type BenefitsConfig = Record<string, {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
}>

export async function refreshMemberLevels(db: Database) {
  const benefitsConfig = await loadJsonConfig<BenefitsConfig>(db, 'member_level_benefits')
  const memberThreshold = await getMemberThreshold(db)

  const memberClients = (await db.execute(sql`
    SELECT user_id, member_level, member_level_locked_until
    FROM ${clientWechatUsers}
    WHERE customer_type = '会员客'
  `)) as Array<{
    user_id: string
    member_level: string | null
    member_level_locked_until: Date | null
  }>

  let upgradeCount = 0, downgradeCount = 0, heldCount = 0
  let unchangedCount = 0, errorCount = 0

  for (const row of memberClients) {
    try {
      // 滚动 12 个月消费额：仅销售单、paid_amount > 0
      const spendRows = (await db.execute(sql`
        SELECT COALESCE(SUM(paid_amount::numeric), 0) AS spend
        FROM ${saleOrders}
        WHERE client_user_id = ${row.user_id}
          AND sale_order_type = '销售单'
          AND paid_amount > 0
          AND paid_at >= (NOW() - INTERVAL '12 months')
      `)) as Array<{ spend: string | number }>

      const spend = Number(spendRows[0]?.spend ?? 0)
      const newLevel = determineMemberLevel(spend, memberThreshold)
      const oldLevel = row.member_level

      if (newLevel === oldLevel) {
        unchangedCount++
        continue
      }

      if (isUpgrade(oldLevel as any, newLevel)) {
        await processUpgrade(db, row.user_id, oldLevel, newLevel, spend, benefitsConfig)
        upgradeCount++
      } else if (isDowngrade(oldLevel as any, newLevel)) {
        const held = await processDowngrade(
          db, row.user_id, oldLevel, newLevel, spend, row.member_level_locked_until,
        )
        held ? heldCount++ : downgradeCount++
      } else {
        unchangedCount++
      }
    } catch (err) {
      console.error(`[cron-worker/memberLevel] failed for ${row.user_id}:`, (err as Error).message)
      errorCount++
    }
  }

  return {
    total: memberClients.length,
    upgradeCount, downgradeCount, heldCount, unchangedCount, errorCount,
  }
}

// ============ 升级：UPDATE + 日志 + 权益（150d 保级期重置） ============
async function processUpgrade(
  db: Database, userId: string,
  oldLevel: string | null, newLevel: string | null,
  spend: number, benefitsConfig: BenefitsConfig | null,
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE ${clientWechatUsers}
         SET old_member_level = member_level,
             member_level = ${newLevel},
             member_level_upgraded_at = NOW(),
             member_level_locked_until = NOW() + INTERVAL '150 days',
             updated_at = NOW()
       WHERE user_id = ${userId}
         AND member_level IS DISTINCT FROM ${newLevel}
    `)

    await tx.execute(sql`
      INSERT INTO ${operationLogs} (action, target_type, target_id, detail, source, created_at)
      VALUES (
        'customer.memberLevelChange', 'customer', ${userId},
        ${JSON.stringify({
          _v: 3, _t: 'transition',
          from: oldLevel, to: newLevel,
          context: { rolling12mSpend: spend, trigger: 'cronTask',
                     direction: 'upgrade', lockedUntil: '+150d' },
        })}::jsonb,
        'cronTask',
        NOW()
      )
    `)

    if (newLevel && benefitsConfig?.[newLevel]) {
      await grantUpgradeBenefits(tx, userId, oldLevel, newLevel, benefitsConfig[newLevel])
    }
  })
}

// ============ 降级：保级期内 hold；保级期过则降并清 locked_until ============
async function processDowngrade(
  db: Database, userId: string,
  oldLevel: string | null, newLevel: string | null,
  spend: number, lockedUntil: Date | null,
): Promise<boolean> {
  if (lockedUntil && lockedUntil > new Date()) {
    await db.execute(sql`
      INSERT INTO ${operationLogs} (action, target_type, target_id, detail, source, created_at)
      VALUES (
        'customer.memberLevelHeld', 'customer', ${userId},
        ${JSON.stringify({
          _v: 3, _t: 'hold',
          currentLevel: oldLevel, recomputedLevel: newLevel,
          context: { rolling12mSpend: spend, lockedUntil, reason: '150d_lock' },
        })}::jsonb,
        'cronTask',
        NOW()
      )
    `)
    return true
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE ${clientWechatUsers}
         SET old_member_level = member_level,
             member_level = ${newLevel},
             member_level_upgraded_at = NOW(),
             member_level_locked_until = NULL,
             updated_at = NOW()
       WHERE user_id = ${userId}
         AND member_level IS DISTINCT FROM ${newLevel}
    `)
    await tx.execute(sql`
      INSERT INTO ${operationLogs} (action, target_type, target_id, detail, source, created_at)
      VALUES (
        'customer.memberLevelChange', 'customer', ${userId},
        ${JSON.stringify({
          _v: 3, _t: 'transition',
          from: oldLevel, to: newLevel,
          context: { rolling12mSpend: spend, trigger: 'cronTask', direction: 'downgrade' },
        })}::jsonb,
        'cronTask',
        NOW()
      )
    `)
  })
  return false
}

// ============ 升级三件套权益（消息 / 积分 / 优惠券） ============
async function grantUpgradeBenefits(
  tx: any, userId: string, fromLevel: string | null, toLevel: string,
  config: BenefitsConfig[string],
) {
  const idemKey = `member-upgrade-${userId}-${toLevel}`

  // 1) 消息
  if (config.messageTitle) {
    await tx.execute(sql`
      INSERT INTO ${messages}
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody || null},
              'system', ${idemKey}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  // 2) 积分（流水成功插入才累加余额，避免幂等冲突重复加）
  if (config.points && config.points > 0) {
    const inserted = (await tx.execute(sql`
      INSERT INTO ${pointTransactions}
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '等级升级奖励', ${config.points}, NULL, ${idemKey}, NOW())
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    `)) as any[]
    if (inserted.length > 0) {  // §1.7 A：postgres-js 用 length 而非 rowCount
      await tx.execute(sql`
        UPDATE ${clientWechatUsers}
           SET points_balance = COALESCE(points_balance, 0) + ${config.points},
               points_updated_at = NOW()
         WHERE user_id = ${userId}
      `)
    }
  }

  // 3) 优惠券
  if (Array.isArray(config.couponTemplateIds)) {
    for (const templateId of config.couponTemplateIds) {
      const tplRows = (await tx.execute(sql`
        SELECT validity_mode, valid_days, valid_to, is_active
        FROM ${couponTemplates}
        WHERE template_id = ${templateId}
      `)) as any[]
      const tpl = tplRows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cron-worker/upgrade] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }

      let expireAt: Date
      if (tpl.validity_mode === 'days' && tpl.valid_days) {
        expireAt = new Date(Date.now() + tpl.valid_days * 86400000)
      } else if (tpl.valid_to) {
        expireAt = new Date(tpl.valid_to)
      } else {
        expireAt = new Date(Date.now() + 365 * 86400000)
      }

      const couponId = `cpn-up-${userId}-${toLevel}-${templateId}`
      await tx.execute(sql`
        INSERT INTO ${userCoupons}
          (coupon_id, template_id, user_id, status, expire_at, created_at)
        VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${expireAt}, NOW())
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    }
  }
}
```

> **关键差异点**：
> - 原 `await client.query('BEGIN')` / `'COMMIT'` 改为 `db.transaction(async (tx) => { ... })`
> - 子函数 `grantUpgradeBenefits` 接收 `tx`（事务上下文），不能用顶层 `db`
> - JSON 详情改为 `${JSON.stringify(...)}::jsonb` 模板
> - `inserted.length > 0` 替代 `inserted.rowCount > 0`（§1.7 A）

---

#### STEP 3：生日权益发放

**`src/cron/steps/grant-birthday-benefits.ts`**（迁自 cronTask/index.js:421-557）：

```ts
import { sql } from 'drizzle-orm'
import { clientWechatUsers, operationLogs } from '@db/schema'
import type { Database } from '@/db'
import { loadJsonConfig } from '../lib/benefits-loader'

type BirthdayConfig = Record<string, {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
}>

export async function grantBirthdayBenefits(db: Database) {
  const benefitsConfig = await loadJsonConfig<BirthdayConfig>(db, 'birthday_benefits')
  if (!benefitsConfig) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }
  }

  // §1.7 C：年份从 DB 取，不用 JS new Date()
  const yearRow = (await db.execute(sql`
    SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS year
  `)) as any[]
  const year: number = yearRow[0].year

  // 当日生日 + 已设会员等级（未设等级跳过，避免无配置匹配错乱）
  // 闰年策略 B1：非闰年 2/29 自然跳过
  const rows = (await db.execute(sql`
    SELECT user_id, member_level
    FROM ${clientWechatUsers}
    WHERE birthday IS NOT NULL
      AND member_level IS NOT NULL
      AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
      AND EXTRACT(DAY FROM birthday)   = EXTRACT(DAY FROM CURRENT_DATE)
  `)) as Array<{ user_id: string; member_level: string }>

  let sentCount = 0, skippedNoConfig = 0, errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig[row.member_level]
    if (!cfg) {
      skippedNoConfig++
      continue
    }

    try {
      await db.transaction(async (tx) => {
        await grantOneBirthday(tx, row.user_id, year, row.member_level, cfg)
        await tx.execute(sql`
          INSERT INTO ${operationLogs} (action, target_type, target_id, detail, source, created_at)
          VALUES (
            'customer.birthdayBenefits', 'customer', ${row.user_id},
            ${JSON.stringify({
              _v: 1, _t: 'birthday', year,
              memberLevel: row.member_level,
              config: {
                points: cfg.points || 0,
                couponTemplateCount: Array.isArray(cfg.couponTemplateIds)
                  ? cfg.couponTemplateIds.length : 0,
                messageTitle: cfg.messageTitle || null,
              },
            })}::jsonb,
            'cronTask', NOW()
          )
        `)
      })
      sentCount++
    } catch (err) {
      console.error(`[cron-worker/birthday] failed for ${row.user_id}:`, (err as Error).message)
      errorCount++
    }
  }

  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}

// 三件套权益（幂等键带 year）
async function grantOneBirthday(
  tx: any, userId: string, year: number, level: string,
  config: BirthdayConfig[string],
) {
  // 1) 消息：birthday-msg-{YYYY}-{userId}
  if (config.messageTitle) {
    await tx.execute(sql`
      INSERT INTO messages
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody || null},
              'system', ${`birthday-msg-${year}-${userId}`}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  // 2) 积分：birthday-pts-{YYYY}-{userId}
  if (config.points && config.points > 0) {
    const externalRef = `birthday-pts-${year}-${userId}`
    const inserted = (await tx.execute(sql`
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '生日积分', ${config.points}, NULL, ${externalRef}, NOW())
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    `)) as any[]
    if (inserted.length > 0) {
      await tx.execute(sql`
        UPDATE client_wechat_users
           SET points_balance = points_balance + ${config.points},
               points_updated_at = NOW()
         WHERE user_id = ${userId}
      `)
    }
  }

  // 3) 优惠券：bday-{YYYY}-{userId}-{templateId}（每模板一张）
  if (Array.isArray(config.couponTemplateIds)) {
    for (const templateId of config.couponTemplateIds) {
      const tplRows = (await tx.execute(sql`
        SELECT validity_mode, valid_days, valid_to, is_active
        FROM coupon_templates WHERE template_id = ${templateId}
      `)) as any[]
      const tpl = tplRows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cron-worker/birthday] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }

      let expireAt: Date
      if (tpl.validity_mode === 'days' && tpl.valid_days) {
        expireAt = new Date(Date.now() + tpl.valid_days * 86400000)
      } else if (tpl.valid_to) {
        expireAt = new Date(tpl.valid_to)
      } else {
        expireAt = new Date(Date.now() + 365 * 86400000)
      }

      const couponId = `bday-${year}-${userId}-${templateId}`
      await tx.execute(sql`
        INSERT INTO user_coupons
          (coupon_id, template_id, user_id, status, expire_at, created_at)
        VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${expireAt}, NOW())
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    }
  }
}
```

---

#### STEP 4：感恩日权益发放

与 STEP 3 几乎对称，差异：
- **每月 20 号才执行**（其他日 SELECT EXTRACT 一次后短路返回）
- 幂等键带 `{YYYY-MM}`（月度事件，非年度）
- **优惠券固定 10 天有效期**（admin UI 硬约束，不读 `validity_mode`）
- 扫描范围：当日有 `service_orders.status IN ('已完成','服务中')` 的会员（DISTINCT 去重）

**`src/cron/steps/grant-thanksgiving-benefits.ts`**（迁自 cronTask/index.js:598-737）：

```ts
import { sql } from 'drizzle-orm'
import { operationLogs } from '@db/schema'
import type { Database } from '@/db'
import { loadJsonConfig } from '../lib/benefits-loader'

type ThanksgivingConfig = Record<string, {
  messageTitle?: string
  messageBody?: string
  points?: number
  couponTemplateIds?: string[]
}>

export async function grantThanksgivingBenefits(db: Database) {
  // §1.7 C：从 DB 判断 day（不用 JS new Date().getDate()）
  const dayRow = (await db.execute(sql`
    SELECT EXTRACT(DAY FROM CURRENT_DATE)::int AS d
  `)) as any[]
  if (dayRow[0].d !== 20) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0, skippedNotDay20: true }
  }

  const benefitsConfig = await loadJsonConfig<ThanksgivingConfig>(db, 'thanksgiving_benefits')
  if (!benefitsConfig) {
    return { total: 0, sentCount: 0, skippedNoConfig: 0, errorCount: 0 }
  }

  const ymRow = (await db.execute(sql`
    SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM') AS ym
  `)) as any[]
  const yearMonth: string = ymRow[0].ym  // '2026-04'

  // 当日有进行中或已完成的服务单 + 已设会员等级（DISTINCT 去重）
  const rows = (await db.execute(sql`
    SELECT DISTINCT cwu.user_id, cwu.member_level
    FROM service_orders so
    JOIN client_wechat_users cwu ON cwu.user_id = so.client_user_id
    WHERE so.service_date = CURRENT_DATE
      AND so.status IN ('已完成', '服务中')
      AND so.client_user_id IS NOT NULL
      AND cwu.member_level IS NOT NULL
  `)) as Array<{ user_id: string; member_level: string }>

  let sentCount = 0, skippedNoConfig = 0, errorCount = 0

  for (const row of rows) {
    const cfg = benefitsConfig[row.member_level]
    if (!cfg) {
      skippedNoConfig++
      continue
    }

    try {
      await db.transaction(async (tx) => {
        await grantOneThanksgiving(tx, row.user_id, yearMonth, row.member_level, cfg)
        await tx.execute(sql`
          INSERT INTO ${operationLogs} (action, target_type, target_id, detail, source, created_at)
          VALUES (
            'customer.thanksgivingBenefits', 'customer', ${row.user_id},
            ${JSON.stringify({
              _v: 1, _t: 'thanksgiving', yearMonth,
              memberLevel: row.member_level,
              config: {
                points: cfg.points || 0,
                couponTemplateCount: Array.isArray(cfg.couponTemplateIds)
                  ? cfg.couponTemplateIds.length : 0,
                messageTitle: cfg.messageTitle || null,
              },
            })}::jsonb,
            'cronTask', NOW()
          )
        `)
      })
      sentCount++
    } catch (err) {
      console.error(`[cron-worker/thanksgiving] failed for ${row.user_id}:`,
                    (err as Error).message)
      errorCount++
    }
  }

  return { total: rows.length, sentCount, skippedNoConfig, errorCount }
}

async function grantOneThanksgiving(
  tx: any, userId: string, yearMonth: string, level: string,
  config: ThanksgivingConfig[string],
) {
  // 1) 消息：thx-msg-{YYYY-MM}-{userId}
  if (config.messageTitle) {
    await tx.execute(sql`
      INSERT INTO messages
        (recipient_type, recipient_id, title, body, message_type, idempotency_key, created_at)
      VALUES ('客户', ${userId}, ${config.messageTitle}, ${config.messageBody || null},
              'system', ${`thx-msg-${yearMonth}-${userId}`}, NOW())
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
  }

  // 2) 积分：thx-pts-{YYYY-MM}-{userId}
  if (config.points && config.points > 0) {
    const externalRef = `thx-pts-${yearMonth}-${userId}`
    const inserted = (await tx.execute(sql`
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '感恩回馈', ${config.points}, NULL, ${externalRef}, NOW())
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    `)) as any[]
    if (inserted.length > 0) {
      await tx.execute(sql`
        UPDATE client_wechat_users
           SET points_balance = points_balance + ${config.points},
               points_updated_at = NOW()
         WHERE user_id = ${userId}
      `)
    }
  }

  // 3) 优惠券：固定 10 天有效期（admin UI 硬约束，不读 validity_mode）
  if (Array.isArray(config.couponTemplateIds)) {
    for (const templateId of config.couponTemplateIds) {
      const tplRows = (await tx.execute(sql`
        SELECT is_active FROM coupon_templates WHERE template_id = ${templateId}
      `)) as any[]
      const tpl = tplRows[0]
      if (!tpl || !tpl.is_active) {
        console.warn(`[cron-worker/thanksgiving] 跳过优惠券 ${templateId}: 模板不存在或已停用`)
        continue
      }

      const expireAt = new Date(Date.now() + 10 * 86400000)  // 固定 10 天
      const couponId = `thx-${yearMonth}-${userId}-${templateId}`
      await tx.execute(sql`
        INSERT INTO user_coupons
          (coupon_id, template_id, user_id, status, expire_at, created_at)
        VALUES (${couponId}, ${templateId}, ${userId}, '未使用', ${expireAt}, NOW())
        ON CONFLICT (coupon_id) DO NOTHING
      `)
    }
  }
}
```

---

#### STEP 5：积分余额一致性校验（仅告警，不修复）

**`src/cron/steps/audit-points-balance.ts`**（迁自 cronTask/index.js:748-783）：

```ts
import { sql } from 'drizzle-orm'
import { clientWechatUsers } from '@db/schema'
import type { Database } from '@/db'

/**
 * 校验 client_wechat_users.points_balance 与 point_transactions 流水合计是否一致
 *
 * 决策 D7：自动修补会掩盖上游 bug，只告警让人工排查
 *   → 发现偏差仅写 operation_logs('points.balanceMismatch')
 *   → 永远不 UPDATE client_wechat_users.points_balance
 */
export async function auditPointsBalance(db: Database) {
  const rows = (await db.execute(sql`
    WITH sums AS (
      SELECT user_id, COALESCE(SUM(amount), 0)::int AS total_from_txns
      FROM point_transactions
      GROUP BY user_id
    )
    SELECT u.user_id,
           COALESCE(u.points_balance, 0) AS cached_balance,
           COALESCE(s.total_from_txns, 0) AS expected_balance
      FROM ${clientWechatUsers} u
      LEFT JOIN sums s ON s.user_id = u.user_id
     WHERE COALESCE(u.points_balance, 0) <> COALESCE(s.total_from_txns, 0)
  `)) as Array<{
    user_id: string
    cached_balance: number | string
    expected_balance: number | string
  }>

  for (const row of rows) {
    const cached = Number(row.cached_balance)
    const expected = Number(row.expected_balance)
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES (
        'points.balanceMismatch', 'customer', ${row.user_id},
        ${JSON.stringify({
          cachedBalance: cached,
          expectedBalance: expected,
          delta: expected - cached,
        })}::jsonb,
        'cronTask', NOW()
      )
    `)
  }

  const checkedRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM ${clientWechatUsers}
  `)) as any[]
  const checkedCount = Number(checkedRows[0]?.cnt ?? 0)

  return { mismatchCount: rows.length, checkedCount }
}
```

> **此 STEP 无事务**：原代码也没事务，逐条 INSERT operation_logs。某条失败会向上抛，由 §3.1 入口的 STEP 级 try/catch 捕获后继续下一 STEP。

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
