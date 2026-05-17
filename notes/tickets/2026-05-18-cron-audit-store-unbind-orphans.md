# cron STEP — audit-store-unbind-orphans（门店解绑申请孤儿巡检）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P0**（SUMMARY §4 L11 列名） |
| 端 | fengyu-admin（cron-worker 子模块） |
| 修复成本 | **S**（半天） |
| 来源 | SUMMARY §6.4 L11 长期 — `audit-store-unbind-orphans.ts` |
| 关联 schema | `db/schema/store-unbind.ts` `storeUnbindRequests` + `db/schema/user.ts` `clientWechatUsers.boundStoreId` + `db/schema/org.ts` `stores` |
| 关联 cron | `fengyu-admin/src/cron/steps/audit-payment-invariants.ts`（结构参考） / `audit-points-balance.ts`（"只告警不修复"语义参考） |

---

## 0 一句话背景

`store_unbind_requests` 表内存在长期挂着 `status='待处理'` 但顾客早已通过其他路径解绑（`client_wechat_users.bound_store_id IS NULL`）或目标门店已下线的"僵尸申请"。这些行不会自然清理也不影响主流程，但会让员工端解绑审批列表 (`staff.approveUnbind`) 上越积越多、店长 UI 出现幽灵条目。缺乏巡检的根本原因：申请关闭只走 `approveUnbind` / `rejectUnbind` / `cancelUnbindRequest` 三条 happy-path，任何在这些路径之外把 `bound_store_id` 改成 NULL 的写入都会留下 orphan（包括 admin 手动改顾客档案、cron 后续数据修补、`client.bindStore` 重新绑别店后旧 pending 没清理等）。

本 ticket 新增 `fengyu-admin/src/cron/steps/audit-store-unbind-orphans.ts` 每日扫一次，发现 orphan 仅 `INSERT operation_logs` + `notifyOps` 告警，**永不自动修补**（与 STEP 5/7 决策一致 — 自动修复会掩盖上游 bug）。

## 1 现状（grep 实证）

### 1.1 schema 结构

`db/schema/store-unbind.ts:7-31`：

```ts
export const storeUnbindRequests = pgTable('store_unbind_requests', {
  requestId:    text('request_id').primaryKey(),
  userId:       text('user_id').notNull().references(() => clientWechatUsers.userId),
  fromStoreId:  text('from_store_id').notNull().references(() => stores.storeId),
  status:       storeUnbindRequestStatusEnum('status').notNull().default('待处理'),
  note:         text('note'),
  reviewedBy:   varchar('reviewed_by', { length: 30 }).references(() => staffWechatUsers.employeeId),
  reviewedAt:   timestamp('reviewed_at'),
  rejectReason: text('reject_reason'),
  createdAt:    timestamp('created_at').notNull().defaultNow(),
  updatedAt:    timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('uq_store_unbind_pending').on(table.userId).where(sql`status = '待处理'`),
])
```

约束已经保证"同顾客同时只 1 条 pending"（migration 0029 落地的 partial UNIQUE），但**没有保证 pending 行的 userId/fromStoreId 仍指向有效的顾客绑定关系**——这正是 orphan 的来源。

### 1.2 已有 cron STEP 列表（structure 参考）

`fengyu-admin/src/cron/run.ts:40-53` 当前 STEP 数组：

```ts
const STEPS = [
  ['closeExpiredAppointments', closeExpiredAppointments],   // STEP 1
  ['customerStatus',           refreshCustomerStatus],       // STEP 2
  ['memberLevels',             refreshMemberLevels],         // STEP 3
  ['birthday',                 grantBirthdayBenefits],       // STEP 4
  ['thanksgiving',             grantThanksgivingBenefits],   // STEP 5
  ['pointsAudit',              auditPointsBalance],          // STEP 6
  ['roleTypeNullsAudit',       auditRoleTypeNulls],          // STEP 7
  ['paymentInvariants',        auditPaymentInvariants],      // STEP 8
] as const
```

参考最相似的 `audit-payment-invariants.ts`（只读 SELECT → 偏差聚合 → 单条 `INSERT operation_logs` + `notifyOps` 一次告警 → return `{ violations, details }`）。

### 1.3 现有 orphan 触发面 grep

```
$ grep -rn "bound_store_id\s*=\s*NULL\|boundStoreId.*null\|bound_store_id\s*=\s*\$" \
    fengyu-admin/src fengyu-staff/cloudfunctions fengyu-client/cloudfunctions 2>/dev/null
fengyu-staff/cloudfunctions/staffApi/routes/store.js  approveUnbind → 同事务 UPDATE bound_store_id=NULL + UPDATE store_unbind_requests SET status='已通过'
fengyu-admin/src/actions/store-unbind.ts             approveStoreUnbind → 同 happy-path
fengyu-admin/src/actions/customers.ts                updateCustomer → 允许 admin 手改 bound_store_id（不触动 store_unbind_requests）← orphan 触发点 #1
fengyu-client/cloudfunctions/clientApi/routes/store.js  bindStore → 重新绑别店时未清理旧 pending ← orphan 触发点 #2
```

→ 至少 2 条已知 orphan 路径，且未来 admin 任何新的"顾客资料维护"功能都可能再开一条。**所以审计层必须存在**。

## 2 修复方案

### 2.1 新建 cron step 文件

新建 `fengyu-admin/src/cron/steps/audit-store-unbind-orphans.ts`，4 类异常并入一次扫描，每类样例最多 10 条（节约消息体）：

```ts
/**
 * STEP 9 — store_unbind_requests 孤儿巡检（audit-12 后续）
 *
 * 决议：与 STEP 6/8 一致，**只告警不修复**。
 *   - 自动 UPDATE status='已关闭' 会掩盖上游业务流的 bug（admin 手改 / client 重绑 / data fix）
 *   - 仅写 operation_logs + notifyOps，由运维 / PM 人工处理
 *
 * 4 类异常（同一次 SELECT 各自一条 query）：
 *   O1: status='待处理' AND clientWechatUsers.boundStoreId IS NULL
 *       → 顾客已通过其他路径解绑，pending 应同步关闭
 *   O2: status='待处理' AND clientWechatUsers.boundStoreId <> fromStoreId
 *       → 顾客已绑别的门店，原 pending 失去意义
 *   O3: status='待处理' AND fromStoreId 对应 stores 行被 inactive / 删除
 *       → 目标门店已下线，无人能审批
 *   O4: status='待处理' AND createdAt < NOW() - INTERVAL '30 days'
 *       → 超过 30 天无人审批的僵尸申请（业务流监控）
 *
 * 告警机制（与 STEP 6/8 一致）：
 *   - operation_logs(action='cron.audit_store_unbind_orphans',
 *                     target_type='unbind_orphan',
 *                     target_id=YYYY-MM-DD,
 *                     detail=jsonb { _v, _t, totals, samples_by_kind })
 *   - notifyOps 单条 markdown：每类计数 + 前 N 条 requestId 样例
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const SAMPLE_LIMIT = 10

interface OrphanCategory {
  kind: 'unbound_but_pending' | 'bound_to_other_store' | 'target_store_inactive' | 'pending_over_30d'
  count: number
  samples: Array<{ request_id: string; user_id: string; from_store_id: string; created_at: string }>
}

export interface StoreUnbindOrphansResult {
  totalOrphans: number
  byKind: Record<OrphanCategory['kind'], number>
}

export async function auditStoreUnbindOrphans(db: Db): Promise<StoreUnbindOrphansResult> {
  const categories: OrphanCategory[] = []

  // O1
  const o1 = (await db.execute(sql`
    SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
    FROM store_unbind_requests sur
    JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
    WHERE sur.status = '待处理'
      AND cwu.bound_store_id IS NULL
    ORDER BY sur.created_at
    LIMIT ${SAMPLE_LIMIT}
  `)) as OrphanCategory['samples']
  const o1cnt = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM store_unbind_requests sur
    JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
    WHERE sur.status = '待处理' AND cwu.bound_store_id IS NULL
  `)) as Array<{ cnt: number }>
  if ((o1cnt[0]?.cnt ?? 0) > 0) {
    categories.push({ kind: 'unbound_but_pending', count: Number(o1cnt[0].cnt), samples: o1 })
  }

  // O2/O3/O4 — 同一模板，按 WHERE 条件分别 SELECT。完整 SQL 见 §3。
  // ...

  const totalOrphans = categories.reduce((acc, c) => acc + c.count, 0)
  const byKind = categories.reduce((acc, c) => {
    acc[c.kind] = c.count
    return acc
  }, {} as Record<OrphanCategory['kind'], number>)

  if (totalOrphans > 0) {
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1,
      _t: 'unbind_orphans',
      date: dateStamp,
      total: totalOrphans,
      by_kind: categories,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_store_unbind_orphans', 'unbind_orphan', ${dateStamp}, ${detailJson}::jsonb, 'cronTask', NOW())
    `)

    const lines = categories.map((c) => `- ${c.kind}: ${c.count} 条（样例 ${c.samples.length} 条）`)
    await notifyOps(
      [
        '⚠️ [cron-worker] cron.audit_store_unbind_orphans',
        `门店解绑申请 orphan 巡检发现 ${totalOrphans} 条异常：`,
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { totalOrphans, byKind }
}
```

### 2.2 注册到 STEP 数组

`fengyu-admin/src/cron/run.ts` 修改：

```diff
 import { closeExpiredAppointments } from './steps/close-expired-appointments'
+import { auditStoreUnbindOrphans } from './steps/audit-store-unbind-orphans'

 const STEPS = [
   ['closeExpiredAppointments', closeExpiredAppointments],
   ['customerStatus',           refreshCustomerStatus],
   ['memberLevels',             refreshMemberLevels],
   ['birthday',                 grantBirthdayBenefits],
   ['thanksgiving',             grantThanksgivingBenefits],
   ['pointsAudit',              auditPointsBalance],
   ['roleTypeNullsAudit',       auditRoleTypeNulls],
   ['paymentInvariants',        auditPaymentInvariants],
+  ['storeUnbindOrphans',       auditStoreUnbindOrphans],
 ] as const
```

run.ts 注释也要从"STEP 顺序（8 个）"改为"STEP 顺序（9 个）"。

### 2.3 dry-run 命令与本地冒烟

run.ts 已支持 `--once` 模式（见 cron/index.ts:22-34）：

```bash
cd fengyu-admin
bun run cron:once                                            # 跑完所有 STEP 单次
# 或 docker exec：
docker exec fengyu-cron-worker node cron-worker.js --once
```

仅看本 STEP 输出（开发期临时跑单 STEP）：

```bash
cd fengyu-admin
bun -e "import('./src/cron/steps/audit-store-unbind-orphans').then(async ({ auditStoreUnbindOrphans }) => {
  const { db } = await import('./src/db')
  console.log(JSON.stringify(await auditStoreUnbindOrphans(db), null, 2))
})"
```

### 2.4 单元测试

新建 `fengyu-admin/src/cron/__tests__/audit-store-unbind-orphans.test.ts`（参考 `audit-payment-invariants.test.ts` 已有的 mock 模式）：

| 用例 | 期望 |
|------|------|
| 所有 pending 均合法（顾客 bound_store_id = fromStoreId） | `totalOrphans = 0`；不写 operation_logs；不调 notifyOps |
| 1 条 O1 + 1 条 O2 + 1 条 O3 + 1 条 O4 | `totalOrphans = 4`；operation_logs 1 行；notifyOps 1 次；message 含 4 个 kind 名 |
| O1 = 12 条（超 SAMPLE_LIMIT） | `count = 12` 但 `samples.length = 10` |

## 3 完整 SQL 模板

```sql
-- O2: 顾客已绑别的店
SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
FROM store_unbind_requests sur
JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
WHERE sur.status = '待处理'
  AND cwu.bound_store_id IS NOT NULL
  AND cwu.bound_store_id <> sur.from_store_id
ORDER BY sur.created_at
LIMIT 10

-- O3: 目标门店 inactive / 不存在
-- stores 当前无 is_active 列；用 LEFT JOIN IS NULL 检 store_id 还存在（外键虽存在但停业不破 FK）
SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
FROM store_unbind_requests sur
LEFT JOIN stores s ON s.store_id = sur.from_store_id
WHERE sur.status = '待处理'
  AND (s.store_id IS NULL OR COALESCE(s.is_active, true) = false)
ORDER BY sur.created_at
LIMIT 10

-- O4: 超过 30 天 pending
SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
FROM store_unbind_requests sur
WHERE sur.status = '待处理'
  AND sur.created_at < NOW() - INTERVAL '30 days'
ORDER BY sur.created_at
LIMIT 10
```

> ⚠️ O3 中 `s.is_active` 列存在与否需先查 `db/schema/org.ts` 确认；若 stores 表无该列，O3 退化为 `LEFT JOIN ... s.store_id IS NULL` 单条件（FK 不允许 NULL 时 0 命中，可能可省略 O3 直接给 future-proof 占位）。

## 4 DoD（验收 Checklist）

- [ ] `fengyu-admin/src/cron/steps/audit-store-unbind-orphans.ts` 新建，4 类 SELECT 完整
- [ ] `fengyu-admin/src/cron/run.ts` STEPS 数组追加 `storeUnbindOrphans` 注册项，注释 8→9
- [ ] `bun run cron:once` 本地跑通，零 orphan 时静默退出（不告警、不写 operation_logs）
- [ ] 临时手工构造 1 条 O1（`UPDATE client_wechat_users SET bound_store_id=NULL WHERE user_id IN (SELECT user_id FROM store_unbind_requests WHERE status='待处理' LIMIT 1)`），跑 `--once` 后 `SELECT * FROM operation_logs WHERE action='cron.audit_store_unbind_orphans' ORDER BY created_at DESC LIMIT 1` 命中且 detail 含 1 条 O1 样例
- [ ] 单元测试 3 用例全部 PASS（`bun run test -- audit-store-unbind-orphans`）
- [ ] `WECHAT_BOT_WEBHOOK_URL` 未设置时 console.warn 但 STEP 不抛（继承 notifyOps 行为）
- [ ] PR 中包含 ticket 自检：`grep -rn "auditStoreUnbindOrphans" fengyu-admin/src/cron` 至少 2 处命中（steps + run）
- [ ] 生产 5434 上 dry-run（`docker exec ...`）：报告 orphan 数量并人工 review 前 10 条样例，确认告警通道走通

## 5 风险与回滚

| 风险点 | 评估 | 缓解 |
|--------|------|------|
| 历史 orphan 数量可能数百 → 单次 notifyOps 消息过长 | 中 | SAMPLE_LIMIT=10 / 类，最多 40 条；超过部分仅记 count，不入 message |
| O3 中 stores 表无 is_active 列导致 SQL 失败 | 中 | §3 SQL 上线前先 `\d stores` 确认；无此列则保留 LEFT JOIN IS NULL 单条件 |
| 与 admin 手改 customer.bound_store_id 并发，正在写时巡检读到瞬态 NULL | 低 | cron 仅告警不修复，下一日重跑会自然消除瞬态噪声 |
| operation_logs 表写入累积 | 低 | 单条聚合 INSERT，每日 1 行；与 STEP 7/8 同模式 |
| notifyOps 网络故障 | 低 | notifyOps 已 catch + console.warn 退化，不抛异常（lib/notify.ts:42-47） |

**回滚**：纯新增文件 + run.ts 1 行 import + 1 行 STEP 数组追加，回退 PR 即恢复（不涉及 schema / 数据迁移）。

## 6 关联

| 项 | 说明 |
|----|------|
| 来源 | [SUMMARY §6.4 / §4 L11 Cron 守护层](../../docs/audit/SUMMARY.md) |
| 关联 audit | audit-12 P0-12-0X 门店解绑流程审计 + CC2 并发幂等 |
| 关联 cron | `audit-payment-invariants.ts`（结构模板）+ `audit-points-balance.ts`（"仅告警"语义） |
| 关联 schema | `db/schema/store-unbind.ts` / `db/schema/user.ts` / `db/schema/org.ts` |
| 部署 | cron-worker 走 admin 同镜像，无需额外部署；run.ts merge 后下次容器重启自动生效 |
