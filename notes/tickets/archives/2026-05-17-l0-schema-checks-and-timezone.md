---
ticket: L0 schema CHECK 收尾（手机号 / 流水符号 / 余额非负）+ PG timezone 实例锁定
date: 2026-05-17
severity: P0
端: db（主）/ ops（PG 实例配置）/ 三端云函数 + admin（间接：CHECK 触发后失败路径需可观测）
cost: M（1–3 天；其中 ALTER DATABASE 段需停业务窗口或灰度重连）
来源:
  - docs/audit/SUMMARY.md §2 Top10 #6（L0 一次性 migration epic 剩 8 项）
  - docs/audit/SUMMARY.md §4 L0 P0（剩 5 项）+ §3 "金额/比例 CHECK 剩 2 项"
  - docs/audit/SCHEMA-CHANGES.md S01-1 / S-CC1-2 / S-CC2-11 / S-CC7-1
  - docs/audit/audit-CC1-numeric-precision.md P0-CC1-02 / P2-15-18
  - docs/audit/audit-CC2-concurrency-idempotency.md §6（prepaid balance 守护）
  - docs/audit/audit-CC7-time-field.md P1-CC7-09（PG TZ 单点漂移）
关联:
  - 已落：migration 0022 + 0024（sale_allocations.allocation_ratio / commission_rate 已 CHECK）
  - 已落：migration 0018 + 0025（uq_sop_status_audit / 7 项退款专属列 DROP）
  - 并行：另开 partial UNIQUE 10 项一次性 migration（SUMMARY §3 "TOCTOU partial UNIQUE 剩 10 项"）
  - 后续：audit-prepaid-balance.ts cron 守护脚本（L11 P0，与 S-CC2-11 配套）
状态: ✅ 已完成归档（2026-05-17 全流程落地，下文末尾"## 完成记录（2026-05-17）"）
---

## v2 修订摘要（2026-05-17，R2 复核后）

本版根据 R2 复核反馈做以下 inline 修订（详见末尾 `## 复核反馈（R2，2026-05-17）`）：

- **Block 1（§3.3 新增 admin SQL 同步 patch 子节 §3.4）**：grep 实证 `fengyu-admin/src/actions/` 全部 `cast(... as int)` 命中位置，其中 `points.ts:154-158` 5 处对 `point_transactions.amount` 的 SUM 聚合会随 bigint 升级出现 `integer out of range`；需同步 patch 为 `as bigint` + Drizzle 类型 `sql<bigint>` + 前端 `Number()` 安全转换。
- **Block 2（§2.3 / §3.3 SUM 安全边界声明）**：明确 bigint 升级动机是防 int4 21 亿溢出；long-term 仍假设**单值 <2^53**；**SUM 聚合路径**须特别警告（业务总积分超 2^53 时 `mode: 'number'` 静默精度丢失），必要时改 `mode: 'bigint'` + 业务层 BigInt 处理。
- **Warn 3（§4 timezone 追加策略）**：明确 `ALTER DATABASE` 由 drizzle-kit 不会生成，按 db/CLAUDE.md "唯一例外" 追加到本 epic 末尾 migration .sql 文件末尾；双库分别处理（5434 `ALTER DATABASE fengyu`、5433 `ALTER DATABASE fengyu_wxapp`）。
- **Warn 4（§6.2 加 phone 列全 schema grep）**：dry-run 前先 grep 全 schema phone 列，确认范围（已实证：`order.ts:56 client_phone`、`org.ts:59 phone` 为冗余/联系人字段，是否纳入 CHECK 需业务决策）。
- **Warn 5（§3.2 / §6.2 加 type 分布 dry-run）**：CHECK 表达式落地前先 `SELECT DISTINCT type, COUNT(*), MIN(amount), MAX(amount) FROM point_transactions GROUP BY type` 枚举全部负值 type（"退款冲销"/"过期扣减"/"管理员调整" 等），再决定符号 CHECK 表达式。
- **Warn 6（§4.2 重启清单加 payNotify）**：admin / cron-worker / staffApi / clientApi / **payNotify** 五端齐重启。
- **改进 5（§3 / §5 全部 ADD CONSTRAINT 改两阶段 NOT VALID）**：`ALTER TABLE ... ADD CONSTRAINT ... NOT VALID;` + `ALTER TABLE ... VALIDATE CONSTRAINT ...;` 拆开提交，避免长锁；PG 12+ 支持。

---

## 0 一句话背景

SUMMARY v3 Top10 #6 列出 L0 epic"剩 8 项"，逐项 grep 后 P0 schema 层实为 **5 项**（其余被 0022/0024/0025 收掉）；本 ticket 一次性 migration 收尾，剩余 partial UNIQUE 10 项由独立 ticket 处理。

---

## 1 现状逐项核查表

| # | 项 | S 编号 | schema 文件 | 当前状态 | 仍缺? | 证据 |
|---|----|--------|-------------|----------|-------|------|
| 1 | `staff_wechat_users.phone` + `client_wechat_users.phone` 中国手机号 CHECK | S01-1 | `db/schema/user.ts:20, 104` | `varchar(30)`，**无 CHECK** | ✅ 仍缺 | grep `chk_cwu_phone\|chk_swu_phone\|phone_format` 在 schema/migrations 全部 0 命中 |
| 2 | `card_transactions.amount` 符号 CHECK（与 type 联动） | S-CC1-2 | `db/schema/prepaid-card.ts:40` | `numeric(10,2)`，**无 CHECK** | ✅ 仍缺 | grep `chk_card_tx_amount_sign` 0 命中；2026-04-26 重构未带 |
| 3 | `point_transactions.amount` 符号 CHECK | S-CC1-2 / S15-02 | `db/schema/points.ts:20` | `integer`，**无 CHECK** | ✅ 仍缺 | grep `chk_pt_amount_sign` 0 命中 |
| 4 | `point_transactions.amount` 改 bigint | S15-03 | `db/schema/points.ts:20` | `integer` (int4) | ✅ 仍缺 | int4 上限 ±21 亿，长尾累积/错误回放风险 |
| 5 | `prepaid_cards.balance >= 0` CHECK | S-CC2-11 | `db/schema/prepaid-card.ts:19` | `numeric(10,2) default '0'`，**无 CHECK** | ✅ 仍缺 | grep `chk_prepaid_balance_nonneg` 0 命中 |
| 6 | PG 实例 `timezone = 'Asia/Shanghai'` 写入 migration | S-CC7-1 | — | `docker/docker-compose.yml:14 PGTZ` 仅作用于本地容器；生产 5434 未在 schema-as-code 中声明 | ✅ 仍缺 | migrations 0000-0027 全部 grep `ALTER DATABASE\|SET timezone` 0 命中；audit-CC7 §6 L0 列项 |
| ~~7~~ | ~~`products.display_icon` 删除决策（L0 P2 顺带）~~ | ~~S-CC9-2~~ | — | **字段在 `product_categories` 不在 `products`；admin `lib/card-kinds.ts:28-44` 实际使用** | ❌ **不缺**（误列） | grep `display_icon` 在 admin 有 4 处使用 — 非 dead column |
| ~~8~~ | ~~`staff_wechat_users.store_id` 重命名为 `default_store_id`（L0 P2 顺带）~~ | ~~S-CC3-4~~ | `db/schema/user.ts:111` | 仍是 `store_id` | ❌ 不在本 ticket 范围 | 跨端命名传播（L0→L9 全栈），单独 ticket（与 audit-CC3 命名混淆消除一起做） |

**收敛结果：7 项 grep 实证 → 实际 P0 schema 层 5 项**（第 4 项 bigint 与第 3 项符号 CHECK 在同一 migration 里捎带，可视为同一 ALTER 内的两个子动作；故 "5 项" 与 SUMMARY 标号一致）。

已落地的混淆项（不要再列）：
- migration 0022：`chk_sale_alloc_ratio` / `chk_svc_comm_*`（CC1 比例三件套）
- migration 0024：`chk_svc_comm_commission_rate` 数据回填 + 兜底
- migration 0025：`sale_orders` 7 项退款专属列 DROP
- migration 0018：`uq_sop_status_audit`（退款 in-flight partial unique）+ `service_commissions.voided_at`

---

## 2 设计原则

### 2.1 CHECK 容历史空值 / 非破坏性

- **统一用 `IS NULL OR <条件>` 形式**：phone / 部分流水类型字段允许历史 NULL。
- **类型 + 金额联动用 OR-block**：`(type=A AND amount > 0) OR (type=B AND amount < 0)`，避免单边遗漏。
- **数据违反 CHECK 阻断 ALTER**：每个 ALTER 前必须 SELECT 违例行数；非 0 时先决策"清洗 / 临时放宽"再 apply。
- **CHECK 一旦 apply 写入 schema snapshot**：不可"绕过"，需要回滚必须新 migration `DROP CONSTRAINT`。

### 2.2 ALTER DATABASE timezone 需停业务窗口

- `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'` **对已建立的连接无效**，仅影响新连接。
- 所有 admin / staffApi / clientApi / payNotify / cron-worker 进程必须**滚动重启**才能加载新 timezone。
- 选项：
  - **A（推荐）**：业务低峰窗口（02:00–04:00 北京时间）跑 ALTER → 滚动重启所有 admin pod + tcb fn deploy 触发云函数容器重建 → SHOW timezone 复核。
  - **B（灰度）**：ALTER 不重启，等连接池自然轮转（PG 连接池 max 5，约 4 小时内全部新建一次）；缺点是这段时间内同进程的 `NOW()` / `CURRENT_DATE` 行为不一致。
- **风险评估**：当前生产 5434 实际 timezone 未知（需先 `SHOW timezone` 复核，见 §6 验证 SQL #0）；若已经是 Asia/Shanghai（容器 PGTZ env 在镜像层生效），本 ALTER 退化为"显式声明 + 防漂移"，零业务影响。

### 2.3 bigint 改类型与 SUM 安全边界

> **R2 复核澄清**：PG 16 文档及社区实测表明 `integer → bigint` 实际**需要 ACCESS EXCLUSIVE 锁 + 全表 rewrite**（列宽 4→8 byte 必须重写元组）；`point_transactions` 当前体量预计几分钟完成，但**不是零 rewrite**。措辞修正。

- `integer → bigint` PG 端语法是 in-place `ALTER COLUMN ... TYPE`，但内部要重写表；需 ACCESS EXCLUSIVE 锁，业务停写窗口对齐 §4.2 滚动重启窗口一并处理。
- **升级动机**：防 int4 ±21 亿（2^31）溢出。`point_transactions.amount` 长尾累积或错误回放可能触顶。
- **安全边界**（重要）：
  - **单值**：仍假设 < 2^53（9 007 199 254 740 992），JS `Number()` 在此范围内精确。
  - **SUM 聚合**：理论上 N 行求和可突破 2^53。当前 `points_balance` 业务上限远低于此（人均 < 1M 积分 × 全店百万顾客 ≈ 10^12，距离 2^53 还有 4 个数量级），**当前**用 Drizzle `bigint({ mode: 'number' })` + JS `Number` 仍安全；但若未来积分单价或顾客量级跃迁，必须切到 `mode: 'bigint'` + 业务层 BigInt 处理。
  - **必须警告**：node-pg 默认 int8 返回字符串，Drizzle `mode: 'number'` 用 `Number()` 强转，**超 2^53 后不报错、精度静默丢失**。本 ticket 落地时需在 schema.ts 上方加注释明示此前提。
- JS 端 `Number()` 当前路径仍安全（现有 `Number(rows[0]?.spend ?? 0)` 模式不需立即改），但 §3.4 admin SQL `cast(... as int)` 路径必须同步改 `as bigint`（int4 cast 比 JS Number 上限低 4 个数量级，更早爆）。
- 配套：`client_wechat_users.points_balance` 当前也是 `integer`，**同步升 bigint** 保持 schema 一致。

---

## 3 一次性 migration 设计

### 3.1 文件命名与分组

建议生成**单个 migration**：`00NN_l0_schema_checks_and_timezone.sql`（drizzle-kit 名称由 generate 决定，本地 review 后改名）。

按表分组的 ALTER 顺序（**改进 5**：所有 ADD CONSTRAINT 分两阶段 `NOT VALID` → `VALIDATE CONSTRAINT`）：

```
1. ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';                       -- 5434
   ALTER DATABASE fengyu_wxapp SET timezone = 'Asia/Shanghai';                 -- 5433 冷备（库名不同）
2. ALTER TABLE point_transactions ALTER COLUMN amount TYPE bigint;
3. ALTER TABLE client_wechat_users ALTER COLUMN points_balance TYPE bigint;
4. ALTER TABLE staff_wechat_users   ADD CONSTRAINT chk_swu_phone_format         CHECK (...) NOT VALID;
5. ALTER TABLE client_wechat_users  ADD CONSTRAINT chk_cwu_phone_format         CHECK (...) NOT VALID;
6. ALTER TABLE card_transactions    ADD CONSTRAINT chk_card_tx_amount_sign      CHECK (...) NOT VALID;
7. ALTER TABLE point_transactions   ADD CONSTRAINT chk_pt_amount_sign           CHECK (...) NOT VALID;
8. ALTER TABLE prepaid_cards        ADD CONSTRAINT chk_prepaid_balance_nonneg   CHECK (...) NOT VALID;
9.  ALTER TABLE staff_wechat_users   VALIDATE CONSTRAINT chk_swu_phone_format;
10. ALTER TABLE client_wechat_users  VALIDATE CONSTRAINT chk_cwu_phone_format;
11. ALTER TABLE card_transactions    VALIDATE CONSTRAINT chk_card_tx_amount_sign;
12. ALTER TABLE point_transactions   VALIDATE CONSTRAINT chk_pt_amount_sign;
13. ALTER TABLE prepaid_cards        VALIDATE CONSTRAINT chk_prepaid_balance_nonneg;
```

**两阶段说明**：
- `ADD CONSTRAINT ... NOT VALID` 只对**新行/新更新**强制检查，**不扫历史表**，秒级返回，只需短暂 ACCESS EXCLUSIVE 锁（毫秒）。
- `VALIDATE CONSTRAINT` 后台扫描历史表，**仅持 SHARE UPDATE EXCLUSIVE 锁**（允许 DML 并发），失败时只阻断该条 ALTER，不影响 §3 其他约束已生效部分。
- 历史违例可在 NOT VALID 落地后从容清洗，最后再跑 VALIDATE。这样**长锁窗口 = 0**。

### 3.2 历史回填策略（按项）

| ALTER | 预期违例 | 回填策略 |
|-------|----------|----------|
| `chk_swu_phone_format` | 同步进来的脏号（11 位非 1[3-9] 开头 / 含空格 / 带 +86） | 先 `SELECT phone FROM staff_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{8}$'`；< 10 行手工修；> 10 行先做一次 `UPDATE ... SET phone = NULL WHERE phone !~ ...` 兜底（业务上"phone 为 NULL" = 未绑定，等用户重新绑） |
| `chk_cwu_phone_format` | 同上 | 同上策略；预期 WorkFine 同步进来的顾客行较多脏号，需提前评估清洗规模 |
| `chk_card_tx_amount_sign` | 历史 type='充值' amount<0 / type='扣款' amount>0 错位行 | `SELECT id, type, amount FROM card_transactions WHERE NOT ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))`；任何违例必须停下来与业务方逐行决策（错位行可能影响余额 SUM） |
| `chk_pt_amount_sign` | 多种负值 type（不止"消费冲销"，还可能有"退款冲销"/"过期扣减"/"管理员调整"） | **前置 dry-run**：`SELECT type, COUNT(*), MIN(amount), MAX(amount) FROM point_transactions GROUP BY type ORDER BY MIN(amount)` — 枚举全部 type 与 amount 符号分布，再决定 CHECK 表达式精度。**直到这一步出结果前，本节 CHECK 表达式不得 freeze**；§5 SQL 草稿 3.2 段仅作占位示例，正式落地版需按 dry-run 结果列出全部负值 type。|
| `chk_prepaid_balance_nonneg` | balance < 0 的行（理论不应存在；并发 D4 trigger 已阻止扣穿） | `SELECT card_id, balance FROM prepaid_cards WHERE balance < 0`；预期 0 行（D4 trigger 已落地见 migration 0020）；若 > 0 行说明 trigger 有绕过路径，必须先修代码再 apply |

### 3.3 schema.ts 同步改动

```diff
// db/schema/user.ts
 export const staffWechatUsers = pgTable(
   'staff_wechat_users',
   { ... phone: varchar('phone', { length: 30 }), ... },
   (table) => [
     ...,
+    check('chk_swu_phone_format', sql`${table.phone} IS NULL OR ${table.phone} ~ '^1[3-9][0-9]{8}$'`),
   ],
 )

 export const clientWechatUsers = pgTable(
   'client_wechat_users',
   { ... },
   (table) => [
     ...,
+    check('chk_cwu_phone_format', sql`${table.phone} IS NULL OR ${table.phone} ~ '^1[3-9][0-9]{8}$'`),
   ],
 )

// db/schema/prepaid-card.ts
 export const prepaidCards = pgTable(
   'prepaid_cards',
   { ... balance: numeric('balance', { precision: 10, scale: 2 }).notNull().default('0'), ... },
   (table) => [
     uniqueIndex('uq_prepaid_cards_user').on(table.userId),
+    check('chk_prepaid_balance_nonneg', sql`${table.balance} >= 0`),
   ],
 )

 export const cardTransactions = pgTable(
   'card_transactions',
   { ... type: cardTransactionTypeEnum('type').notNull(), amount: numeric('amount', { precision: 10, scale: 2 }).notNull(), ... },
   (table) => [
     index('idx_card_txns_card_id').on(table.cardId),
+    check('chk_card_tx_amount_sign', sql`(${table.type} = '充值' AND ${table.amount} > 0) OR (${table.type} = '扣款' AND ${table.amount} < 0)`),
   ],
 )

// db/schema/points.ts
+// NOTE(R2): bigint mode='number' 选型前提：
+//   - 单值 amount < 2^53（JS Number 精确范围），业务上限 << 2^53。
+//   - SUM 聚合理论可越过 2^53，但当前业务上限（人均 < 1M 积分 × 百万顾客 ≈ 10^12）距离 2^53 还有 4 个数量级。
+//   - 一旦业务量级跃迁逼近 2^53，必须切到 mode: 'bigint' 并在 admin/cloud actions 路径全部用 BigInt 处理。
 export const pointTransactions = pgTable(
   'point_transactions',
-  { ... amount: integer('amount').notNull(), ... },
+  { ... amount: bigint('amount', { mode: 'number' }).notNull(), ... },
   (table) => [
     ...,
+    check('chk_pt_amount_sign', sql`(${table.type} IN (<列出全部负值 type，由 §3.2 dry-run 结果决定>) AND ${table.amount} < 0) OR (${table.type} NOT IN (...) AND ${table.amount} > 0)`),
   ],
 )

// db/schema/user.ts (clientWechatUsers.pointsBalance 同步 bigint)
-    pointsBalance: integer('points_balance').notNull().default(0),
+    pointsBalance: bigint('points_balance', { mode: 'number' }).notNull().default(0),
```

> 注：上述 schema.ts diff 是规划，**禁止本 ticket 阶段直接改 .ts 文件**。等所有 ALTER SQL 和数据清洗策略评审通过后，再走标准 `db:generate` 流程（schema.ts 修改 → `npm run db:generate` → drizzle-kit 自动生成 .sql）。手写 .sql 塞进 migrations/ 不符合 db/CLAUDE.md 规范。
>
> **唯一例外（R2 Warn 3）**：`ALTER DATABASE ... SET timezone` 不是 schema-level DDL，drizzle-kit **不会生成**这条。按 db/CLAUDE.md "唯一例外：generate 产出的 .sql 末尾可手写追加"模式，把 §5 段 1（双库 ALTER DATABASE 两条）追加到**本 epic generate 出来的最末一条 .sql 文件末尾**；并在 PR 描述里显式标注"此处含手写 ALTER DATABASE，不可被后续 generate 覆盖"。5433 冷备库名为 `fengyu_wxapp`（区别于 5434 的 `fengyu`），必须连入 5433 单独 ALTER 一次。

### 3.4 admin SQL `cast as int` 同步 patch（R2 Block 1）

bigint 升级后，`fengyu-admin/src/actions/` 中所有对 `point_transactions.amount` 或 `points_balance` 做 SUM 聚合并 `cast(... as int)` 的位置，必须同步改 `as bigint`，否则聚合区间一旦突破 int4 ±21 亿（PG int4 上限），即 `ERROR: integer out of range`，admin 页面 500。

**实证命中清单**（`grep -rn 'cast.*as int' fengyu-admin/src/actions/` 全量扫描）：

| 文件路径 | 行号 | 当前表达 | 风险 | 同步 patch |
|---------|------|---------|------|-----------|
| `fengyu-admin/src/actions/points.ts` | 154 | `sql<number>`cast(coalesce(sum(case when ${pointTransactions.amount} > 0 then ${pointTransactions.amount} else 0 end), 0) as int)`` | **高**（amount SUM 直接溢出）| `sql<bigint>`cast(... as bigint)``，调用方 `Number(totalEarn)` 兜底 |
| `fengyu-admin/src/actions/points.ts` | 155 | `sql<number>`cast(coalesce(sum(case when ${pointTransactions.amount} < 0 then -${pointTransactions.amount} else 0 end), 0) as int)`` | **高** | 同上 |
| `fengyu-admin/src/actions/points.ts` | 156 | `sql<number>`cast(coalesce(sum(${pointTransactions.amount}), 0) as int)`` | **高** | 同上 |
| `fengyu-admin/src/actions/points.ts` | 157 | `sql<number>`cast(count(*) as int)`` | 低（count 不涉及金额）| 可保留 `as int`（count(*) 上限 2^31，业务远低于）|
| `fengyu-admin/src/actions/points.ts` | 158 | `sql<number>`cast(count(distinct ${pointTransactions.userId}) as int)`` | 低 | 同上保留 |
| `fengyu-admin/src/actions/points.ts` | 126 | `sql<number>`cast(count(*) as int)`` (列表分页 count) | 低 | 保留 |

**其他文件**（grep 命中全部为 `count(*)` 或 `count(distinct ...)`，**不涉及 amount SUM**，本 ticket 不需 patch）：
- `customers.ts:214`、`coupons.ts:816`、`employees.ts:186`
- `messages.ts:100,337,438`
- `card-transactions.ts:122,157,158`（amount 是 `numeric(10,2)`，与 bigint 升级无关；但**长期**也应审计 numeric SUM 是否被 cast 成 int）
- `appointments.ts:136,142,143`、`cards.ts:151`
- `orders.ts:339`、`pickup-records.ts:97`、`services.ts:131`、`refunds.ts:1000`

**patch 模式参考**：
```ts
// before:
totalEarn: sql<number>`cast(coalesce(sum(case when ${pointTransactions.amount} > 0 then ${pointTransactions.amount} else 0 end), 0) as int)`,
// after:
totalEarn: sql<bigint>`cast(coalesce(sum(case when ${pointTransactions.amount} > 0 then ${pointTransactions.amount} else 0 end), 0) as bigint)`,
// 调用方：
const totalEarnNum = Number(stats.totalEarn);
if (totalEarnNum > Number.MAX_SAFE_INTEGER) {
  console.warn('[points.stats] totalEarn 超 2^53，精度可能丢失', { raw: stats.totalEarn });
}
```

> 上述 patch 由本 ticket **同 PR 提交**（schema.ts + drizzle generate 的 .sql + admin actions/points.ts 的 cast 改动），缺一会引入 prod regression。本节列入 §9 验收条目。

---

## 4 timezone 切换计划

### 4.1 前置复核（不改任何东西）

```sql
-- 在 5434 上执行（read-only）
SHOW timezone;
SELECT current_setting('TIMEZONE'), NOW(), NOW() AT TIME ZONE 'Asia/Shanghai', CURRENT_DATE;

-- 0a) 确认当前连接库名（避免 ALTER 错库）
SELECT datname, pg_encoding_to_char(encoding) AS encoding
  FROM pg_database
 WHERE datname IN ('fengyu', 'fengyu_wxapp', 'postgres');
-- 期望：5434 上出现 `fengyu`（活跃业务库）；5433 上出现 `fengyu_wxapp`（冷备）。
-- ALTER DATABASE 必须连入对应实例并使用对应库名（5434 ALTER fengyu，5433 ALTER fengyu_wxapp）。

-- 0b) 5433 同样跑一次（如可访问冷备）
-- SHOW timezone;
-- SELECT datname FROM pg_database WHERE datname = 'fengyu_wxapp';
```

**判定**：
- 若 5434 结果已是 `Asia/Shanghai` → ALTER 退化为"防漂移声明"，无业务影响，正常 apply。
- 若 5434 结果是 `UTC` 或其他 → 跳到 4.2 评估窗口期 + 重启计划，并先评估**历史订单号 dateStr 漂移影响面**（参考 audit-CC7 §7 SQL #3 / #8）。
- 5433 冷备 timezone 也需要对齐：理论上 5433 自 2026-04-24 起停写（见 memory `project_db_dual_env`），但若未来恢复双写或回切，timezone 漂移会引起新 bug，必须同步 ALTER。

### 4.2 实施步骤（按当前 TZ != Asia/Shanghai 假设）

1. **业务低峰窗口**（建议 02:30 北京时间）：
   ```sql
   -- 5434（生产业务库）
   ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';
   -- 5433（冷备库，库名不同！）
   ALTER DATABASE fengyu_wxapp SET timezone = 'Asia/Shanghai';
   ```
2. **滚动重启**（5 端齐重启，**R2 Warn 6 补 payNotify**）：
   - admin web (docker compose): `docker compose -f docker/docker-compose.yml restart admin`
   - cron-worker: `docker compose ... restart cron-worker`
   - 云函数容器：`tcb fn code update` 触发重建（不要用 `tcb fn deploy --force`，会重置环境变量，详见 memory `project_cloudbase_envvar_risk`）
     - staffApi
     - clientApi
     - **payNotify**（admin CLAUDE.md 列出的第 4 个 PG 消费方，过去常被遗漏）
3. **复核**：
   - 在每个端的容器 / 函数日志里观察 `SHOW timezone` 输出
   - 跑 audit-CC7 §7 SQL #1 + #8 验证

### 4.3 三端 `new Date().toISOString().slice(...)` lint 规则

audit-CC7 §3.1 列出 12+ 处 `Date#toISOString().slice(2,10)` 副本（订单号 dateStr 跨午夜重号根因）。

- **本 ticket 不修这些副本**（属于 L3 routes 层，audit-CC7 P0-CC7-01 单独 ticket 处理）。
- 本 ticket 仅在 L0 ALTER 完成后**追加 ESLint 规则**（fengyu-admin/eslint.config.mjs 已存在；fengyu-staff/cloudfunctions 与 fengyu-client/cloudfunctions 需新建）：
  ```js
  // 禁止 `*.toISOString().slice(...)` 字面量切片（绕过时区）
  {
    selector: "CallExpression[callee.object.callee.property.name='toISOString'][callee.property.name='slice']",
    message: "禁止用 toISOString().slice 切片日期字符串（会按 UTC 截断）；用 to_char(NOW(),...) 或 dayjs.tz('Asia/Shanghai')",
  }
  ```
- ESLint 规则纳入本 ticket 验收的最后一步（防止 ALTER 后新代码再引入漂移）。

---

## 5 详细 SQL 草稿

> 仅供评审讨论；**禁止直接落 migrations/**。schema.ts 改完后由 drizzle-kit generate 产出权威 .sql。

```sql
-- ============================================================
-- 0. PG 实例 timezone 锁定（schema-as-code 防漂移）
-- ★ R2 Warn 3：drizzle-kit 不生成此条，按"唯一例外"模式追加到本 epic
--   末尾 generate 出来的 .sql 文件末尾；且双库分别 ALTER（库名不同）。
-- ============================================================
-- 5434 生产业务库
ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';
-- 5433 冷备库（库名 = fengyu_wxapp，需单独连入 5433 实例执行）
-- ALTER DATABASE fengyu_wxapp SET timezone = 'Asia/Shanghai';

-- ============================================================
-- 1. point_transactions.amount + client_wechat_users.points_balance 类型升级
-- （bigint，防 int4 ±21 亿溢出；PG 16 需 ACCESS EXCLUSIVE 锁 + 全表 rewrite）
-- ============================================================
ALTER TABLE point_transactions
  ALTER COLUMN amount TYPE bigint USING amount::bigint;
ALTER TABLE client_wechat_users
  ALTER COLUMN points_balance TYPE bigint USING points_balance::bigint;

-- ============================================================
-- 2. 手机号格式 CHECK（容历史 NULL + 中国大陆 11 位）
-- ★ R2 改进 5：分两阶段 NOT VALID → VALIDATE CONSTRAINT，避免长锁
-- ============================================================
-- 2.1 staff（NOT VALID 仅对新行强制；秒返回）
ALTER TABLE staff_wechat_users
  ADD CONSTRAINT chk_swu_phone_format
  CHECK (phone IS NULL OR phone ~ '^1[3-9][0-9]{8}$') NOT VALID;

-- 2.2 client
ALTER TABLE client_wechat_users
  ADD CONSTRAINT chk_cwu_phone_format
  CHECK (phone IS NULL OR phone ~ '^1[3-9][0-9]{8}$') NOT VALID;

-- ============================================================
-- 3. 流水符号 CHECK（与 chk_sop_amount_sign 同模式）
-- ============================================================
-- 3.1 充值卡流水
ALTER TABLE card_transactions
  ADD CONSTRAINT chk_card_tx_amount_sign
  CHECK (
    (type = '充值' AND amount > 0)
    OR (type = '扣款' AND amount < 0)
  ) NOT VALID;

-- 3.2 积分流水
-- ★ R2 Warn 5：CHECK 表达式必须由 §6.2 (e) 的 SELECT DISTINCT type 结果决定，
--   下面是占位示例（仅假设负值 type 为"消费冲销"），不可作为最终落地版。
ALTER TABLE point_transactions
  ADD CONSTRAINT chk_pt_amount_sign
  CHECK (
    (type IN ('消费冲销' /*, '退款冲销', '过期扣减', '管理员调整' — 由 dry-run 决定 */) AND amount < 0)
    OR (type NOT IN ('消费冲销' /*, ... */) AND amount > 0)
  ) NOT VALID;

-- ============================================================
-- 4. 充值卡余额非负 CHECK（D4 trigger 已守，本 CHECK 是兜底）
-- ============================================================
ALTER TABLE prepaid_cards
  ADD CONSTRAINT chk_prepaid_balance_nonneg
  CHECK (balance >= 0) NOT VALID;

-- ============================================================
-- 5. VALIDATE 阶段（历史违例清洗到 0 行后跑；仅 SHARE UPDATE EXCLUSIVE 锁，允许并发 DML）
-- ============================================================
ALTER TABLE staff_wechat_users   VALIDATE CONSTRAINT chk_swu_phone_format;
ALTER TABLE client_wechat_users  VALIDATE CONSTRAINT chk_cwu_phone_format;
ALTER TABLE card_transactions    VALIDATE CONSTRAINT chk_card_tx_amount_sign;
ALTER TABLE point_transactions   VALIDATE CONSTRAINT chk_pt_amount_sign;
ALTER TABLE prepaid_cards        VALIDATE CONSTRAINT chk_prepaid_balance_nonneg;
```

---

## 6 验证 Checklist

### 6.1 临时 docker PG 验证（apply 前必跑）

按 `db/CLAUDE.md` "临时 PG（仅用于 migration 验证）" 章节：

```bash
docker run -d --name drizzle-migrate-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  -p 54399:5432 postgres:16

DATABASE_URL="postgresql://postgres:test@localhost:54399/test" npm run db:migrate
# 期望：从 0000 baseline 一路 apply 到本新 migration 零失败

# 跑完后销毁
docker rm -f drizzle-migrate-test
```

### 6.2 5434 历史数据违例 dry-run（apply 前必跑）

```sql
-- a) 全 schema phone 列盘点（R2 Warn 4）—— 确认 CHECK 范围
-- 已实证命中：
--   db/schema/user.ts:20    staff_wechat_users.phone   varchar(30)  ← 本 ticket 加 CHECK
--   db/schema/user.ts:104   client_wechat_users.phone  varchar(30)  ← 本 ticket 加 CHECK
--   db/schema/order.ts:56   sale_orders.client_phone   varchar(30)  ← 订单冗余快照，是否纳入 CHECK 需业务决策
--   db/schema/org.ts:59     stores.phone               text         ← 门店联系电话（座机/总机），不应套 11 位 CHECK
-- 命令复核（apply 前再跑一次防止 schema 漂移）：
--   grep -rn "phone" db/schema/ | grep -E "varchar|text"
-- 决策：本 ticket 仅对 staff_wechat_users + client_wechat_users 加 CHECK；
--      sale_orders.client_phone / stores.phone 列入后续 ticket 单独评估。

-- b) 手机号违例（仅扫本 ticket 覆盖的两张表）
SELECT 'staff' AS realm, count(*) AS bad_rows
  FROM staff_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{8}$'
UNION ALL
SELECT 'client', count(*)
  FROM client_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{8}$';

-- c) card_transactions 符号违例
SELECT count(*) AS bad_card_tx
  FROM card_transactions
 WHERE NOT ((type = '充值' AND amount > 0) OR (type = '扣款' AND amount < 0));

-- d) point_transactions 符号违例（占位）— 真正使用前必须先跑 (e)
SELECT type, count(*) AS bad_rows
  FROM point_transactions
 WHERE NOT ((type = '消费冲销' AND amount < 0) OR (type <> '消费冲销' AND amount > 0))
 GROUP BY type;

-- e) **R2 Warn 5：枚举 point_transactions 全部 type + amount 符号分布**
--    用于决定 §3 chk_pt_amount_sign 的最终 CHECK 表达式
SELECT type,
       COUNT(*)       AS row_count,
       MIN(amount)    AS min_amount,
       MAX(amount)    AS max_amount,
       SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS negative_rows,
       SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS positive_rows
  FROM point_transactions
 GROUP BY type
 ORDER BY MIN(amount);
-- 判读：所有 (negative_rows > 0 AND min_amount < 0) 的 type 必须列入 chk_pt_amount_sign
--      的 "IN (...) AND amount < 0" 分支，否则 VALIDATE CONSTRAINT 阶段会失败。

-- f) prepaid_cards.balance < 0（理论 0 行；D4 trigger 已守）
SELECT card_id, balance FROM prepaid_cards WHERE balance < 0;

-- g) PG 当前 timezone（决定 §4 路径）
SHOW timezone;
```

**判定**：
- a：确认 phone 列盘点已 freeze，避免遗漏。
- b/c/d 任一 > 0：先跑数据清洗，结果归 0 后再 VALIDATE。
- e：**必须先出结果**，再 freeze §3.2 / §5 段 3.2 的 CHECK 表达式。
- f > 0：**stop & ask** — 说明 D4 trigger 有绕过路径，先修代码再 apply。
- g 已是 Asia/Shanghai：ALTER 退化为防漂移声明。

### 6.3 5434 上 SELECT 复核（apply 后跑）

```sql
-- a) CHECK 约束清单（应出现本 ticket 5 条新约束）
SELECT con.conname, rel.relname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
 WHERE con.contype = 'c'
   AND con.conname IN (
     'chk_swu_phone_format', 'chk_cwu_phone_format',
     'chk_card_tx_amount_sign', 'chk_pt_amount_sign',
     'chk_prepaid_balance_nonneg'
   )
 ORDER BY rel.relname;
-- 期望：5 行

-- b) 类型升级
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'point_transactions' AND column_name = 'amount';
-- 期望：bigint

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'client_wechat_users' AND column_name = 'points_balance';
-- 期望：bigint

-- c) timezone
SHOW timezone;
-- 期望：Asia/Shanghai

-- d) 触发性插入（CHECK 验证）— 跑 ROLLBACK 模式，不写实数据
BEGIN;
  INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
    VALUES ((SELECT card_id FROM prepaid_cards LIMIT 1), '充值', -1.00, NULL);
  -- 期望：ERROR new row for relation "card_transactions" violates check constraint "chk_card_tx_amount_sign"
ROLLBACK;
```

### 6.4 应用层回归（apply 后跑）

- admin: `cd fengyu-admin && bun run test`（537 用例不应出现新失败）
- staff/client 云函数：跑既有 e2e（`fengyu-staff/tests/e2e-cloudfn/run-all.mjs`）
- 重点观察是否有"现存代码写入了违反 CHECK 的数据"路径漏网

---

## 7 风险与回滚

### 7.1 CHECK 一旦 apply 不可"软回滚"

- PG CHECK 没有 `DISABLE CONSTRAINT`（不像 MSSQL），只能 `DROP CONSTRAINT`。
- 回滚策略：写一个新 migration `00NN+1_drop_chk_*.sql` 包含 `ALTER TABLE ... DROP CONSTRAINT chk_*`，按 db/CLAUDE.md "已 apply 的 migration 要改：不要改它，写新的修复" 原则。
- **不要在已 apply 的 migration .sql 上原地修改**。

### 7.2 ALTER DATABASE timezone 风险

- **当前**：仅生效于新连接，旧连接（admin pod 内连接池、云函数 cold start 容器）继续用旧 TZ。
- **缓解**：滚动重启所有进程（admin / cron-worker / staffApi / clientApi / payNotify）。
- **回滚**：`ALTER DATABASE fengyu SET timezone = '<旧值>'` + 同样滚动重启；零数据损失。
- **历史订单号风险**：如果之前 timezone=UTC 且持续较久，所有跨午夜窗口（北京 00:00–08:00）生成的订单号 dateStr 已写实，**回滚 timezone 不会修复历史 ID**（这是 audit-CC7 P0-CC7-01 的根因数据债，本 ticket 不处理历史，只防未来）。

### 7.3 bigint 升级风险

- PG 端 in-place 升级，对正在运行的查询透明。
- node-pg 驱动 int8 默认返回字符串，**现有 `Number(x)` / 算术运算需复核**（所有 sum/balance 路径已是 `Number(rows[0]?.spend ?? 0)` 模式，预期零代码改动；但需要 grep 兜底确认）。
- 验证 grep：`grep -rn "points_balance\|point_transactions.*amount" --include='*.ts' --include='*.js' fengyu-admin/src fengyu-staff/cloudfunctions fengyu-client/cloudfunctions`

### 7.4 手机号 CHECK 误伤

- 若历史脏号回填策略选 "UPDATE ... SET phone = NULL"，会**清除部分用户的手机号绑定**。
- 缓解：清洗前导出脏号 + user_id 快照 (`COPY (SELECT user_id, phone FROM ... WHERE phone !~ ...) TO STDOUT`)，落归档文件 `docs/migrations/2026-05-17-phone-cleanup-backup.csv`；业务方按此追溯。

### 7.5 与其他 in-flight 工作的冲突

- 与 SUMMARY §4 L0 "剩 10 项 partial UNIQUE 索引" 的 partial unique migration 是**正交**的，可同时推进；建议先合并本 ticket（CHECK 类是阻断式守卫，先落更安全），再做 partial unique。
- 与 L3 layer 的 dateStr 统一 (audit-CC7 P0-CC7-01) **必须先做本 ticket 的 §4 ALTER + 重启**，否则 dateStr 改造 PR 合入后云函数 cold start 拿到的还是旧 PG TZ。

---

## 8 关联

| 项 | 说明 |
|----|------|
| 前置 | 无 schema 依赖；仅依赖业务低峰窗口可用（§4） |
| 并行 | 另开 partial UNIQUE 10 项 ticket（SUMMARY §3 TOCTOU partial UNIQUE） |
| 后续 | L11 audit-prepaid-balance.ts cron 守护（与 S-CC2-11 配套，对 balance 做 SUM 重算校验） |
| 后续 | L11 audit-money-invariants.ts cron 守护（SUMMARY §4 L11 P0） |
| 后续 | L3 audit-CC7 P0-CC7-01 三端 dateStr 统一 ticket（依赖本 ticket §4 ALTER 落地） |
| 关联决策 | D-CC1-2026-04-26（保留 NUMERIC(5,2) 不升级，仅补 CHECK）— 与本 ticket 同理念，pure CHECK 加固，不动列类型（除 bigint 一项）|
| 关联 ticket | 2026-04-27-allocation-ratio-check-constraint.md（已归档；CC1 已完成部分）|
| 参考 | db/CLAUDE.md "Schema 变更工作流"（强制 schema.ts → db:generate → 临时 PG 验证 → 5434 migrate）|
| 参考 | audit-CC7 §7 验证 SQL（本 ticket §6 复用其中 #1/#3/#8）|

---

## 9 验收标准

- [x] ~~§6.1 临时 docker PG 从 0000 baseline 跑通新 migration 零失败~~ — baseline 0000 重放在 0018 enum-in-tx 限制下不可行（pre-existing 问题，非本 ticket 引入）；改为 pg_dump 当前 5434 schema → temp PG → 单独 apply 0028 验证（commit 352a629 前已通过，5 CHECK + 2 bigint + timezone 全到位）
- [x] §6.2 (a) 全 schema phone 列盘点已 freeze（见 dry-run 报告 §b：staff_wechat_users / client_wechat_users 加 CHECK；sale_orders.client_phone + stores.phone 列入 follow-up）
- [x] §6.2 (e) `SELECT type, count, min/max FROM point_transactions GROUP BY type` 已跑 — 生产仅 1 行 `消费赠送 +5`；CHECK 表达式按 admin/actions/points.ts 顶部注释确认的"已知 type 表"freeze 为半严格 `(amount<0 AND type='消费冲销') OR amount>0`
- [x] §6.2 5434 历史违例：phone 211 行（9 staff + 202 client）已 UPDATE NULL 清洗（migration 0028 内置 UPDATE），card_tx/pt/prepaid 全部 0 行违例 ✅
- [x] schema.ts 改动 + drizzle-kit 生成的 migration .sql + meta snapshot 同 commit 352a629 提交
- [x] **§3.4 admin SQL `cast(... as int)`** — `fengyu-admin/src/actions/points.ts:154-156` 3 处 amount SUM 已改 `as bigint` + safeNumber 调用方兜底 + safe-int 警告（commit 9651afd）
- [x] §2.3 bigint 升级前提注释 — `db/schema/points.ts` 顶部加 bigint mode='number' 安全前提注释（commit 352a629）
- [x] migration 末尾手写追加 `ALTER DATABASE fengyu SET timezone`；5433 单独跑 `ALTER DATABASE fengyu_wxapp SET timezone`（双库均 `TimeZone=Asia/Shanghai`）
- [ ] ~~所有 ADD CONSTRAINT 采用 `NOT VALID` + 后续 `VALIDATE CONSTRAINT` 两阶段（R2 改进 5）~~ — **实施时改为单阶段**：本项目首次引入 NOT VALID（历史 0 命中），且 5 张表都是中小规模（< 100 万行），单阶段 ACCESS EXCLUSIVE 锁实测秒级；NOT VALID 优化收益微薄，徒增 migration 复杂度
- [x] migration 在 5434 apply 成功，§6.3 SELECT 复核：5 条 CHECK 存在 / 2 bigint 字段 / timezone='Asia/Shanghai' / 触发性 INSERT '充值/-1' 抛 check_violation ✅
- [x] §4.2 admin + cron-worker（deploy-admin.sh ali-demo 全镜像重建） + staffApi + clientApi + payNotify（`echo y | tcb fn deploy` 同步 TZ env） 全部滚动重启
- [x] §6.4 admin 单测 — points + refunds 24/24 通过；admin smoke-record-payment 生产环境 PASS（bigint 路径下 points_balance 0→2，新 pt 流水 +2 通过 chk_pt_amount_sign）；9 个不相关失败来自 error-codes 重构（commit 711d7cc）非本 ticket
- [x] §4.3 ESLint 规则 — `fengyu-admin/eslint.config.mjs` 加 `no-restricted-syntax` 禁 `toISOString().slice` (warn 软着陆 3 处已知命中，commit 6d9123c)；cloudfunctions 三端 ESLint 留 follow-up（用户决策 D=1）
- [x] SUMMARY.md §4 L0 "P0 剩 5 项" → **0 项** ✅；表 §3 "金额/比例 CHECK 剩 2 项" → **0 项** ✅；Top10 #6 标记 DONE

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**：
1. **§3.3 schema diff 的 bigint 升级与 admin SQL 冲突**：`fengyu-admin/src/actions/points.ts:154-158` 用 `cast(sum(...) as int)` 聚合 `point_transactions.amount`，升 bigint 后聚合区间能突破 int4 上限 → PG 抛 `integer out of range`。ticket §7.3 仅 grep 字段名但没扫 `as int` / `cast.*int` SQL cast，验收 §6.4 "537 用例不应出现新失败" 不能覆盖（聚合溢出要造大数据才触发）。需在 §3.3 同步把这些 cast 改为 `as bigint`，否则积分对账页一旦总量 >21 亿就 500。
2. **§3.3 第 154-158 行 Drizzle 类型 `bigint({ mode: 'number' })` 选择不安全**：pg 驱动 int8 默认返回字符串；`mode: 'number'` 强转 Number，超出 2^53（9 007 199 254 740 992）后精度丢失且**不报错**。既然升 bigint 的动机是"防 21 亿溢出"，理论上单值不会超 2^53，但 `points_balance` 的 SUM 聚合可以。建议要么 `mode: 'bigint'`（业务层全部改 BigInt 处理），要么明确写入 ticket"long-term 仍假设 <2^53，bigint 只防 int4 21 亿"——目前 ticket §2.3 论述"JS 端 Number() 仍然安全"过于乐观，应警告 SUM 路径。

**Warn 级问题**：
3. **§5 SQL 草稿与 §3.3 "禁止直接落 migrations/" 规约矛盾的执行风险**：ticket §3.3 明确"由 drizzle-kit generate 产出权威 .sql"。但 `ALTER DATABASE fengyu SET timezone` 不是 schema-level DDL，drizzle-kit **不会生成**这条；只能通过 db/CLAUDE.md "唯一例外：生成的 migration 末尾追加手写"模式追加到某条 generate 的 .sql 尾部。ticket 没说明追加到哪条 migration，也没提示这一条对 5433 冷备库无效（`ALTER DATABASE fengyu` 在 5433 实例上库名是 `fengyu_wxapp`，需双库分别 ALTER 不同库名）。
4. **§6.2 dry-run 缺 sale_orders 等大表的违例审计**：手机号 CHECK 落地前只查 `staff_wechat_users` / `client_wechat_users`，但 `sale_orders` / `appointments` 等表是否有 phone 列冗余？应在 §6.2 加一条"全 schema grep `phone` 列"确认范围。
5. **§3.2 `point_transactions` 符号 CHECK 假设 type 自由文本"消费冲销"为唯一负值场景**：未提及"退款冲销"、"过期扣减"、"管理员调整"等可能的负值 type；落地后这些路径会被阻断。需要先 `SELECT DISTINCT type FROM point_transactions WHERE amount < 0` 枚举出全部负值 type，再决定 CHECK 表达式。
6. **§4.2 滚动重启遗漏 cron-worker 节点**——OK 已列出。建议加 payNotify（admin CLAUDE.md 列出 4 个 PG 消费方 admin/staffApi/clientApi/payNotify）。

**OK**：
- 5 项 grep 实证全部复核通过：`db/schema/user.ts:20,104` phone 确无 CHECK；`db/schema/prepaid-card.ts:19,40` balance + card_tx amount 确无 CHECK；`db/schema/points.ts:20` 仍是 integer；`db/migrations/` 0000-0027 grep `ALTER DATABASE\|SET timezone` 零命中；`docker/init-scripts/` 目录为空。
- 剔除项理由成立：`display_icon` 实际在 `product_categories` 不在 `products`，`fengyu-admin/src/lib/card-kinds.ts:28-44` 在用，**确非 dead column**。
- §7.1 关于 CHECK 不可 DISABLE 只能 DROP 正确，回滚策略合规。
- §3.3 末尾强调"禁止本 ticket 阶段直接改 .ts 文件，走 db:generate"符合 db/CLAUDE.md 规约。
- bigint 升级零数据 rewrite 描述基本准确（PG 16 int4→int8 需 ACCESS EXCLUSIVE 锁+全表 rewrite，小表 point_transactions 几分钟即可，§2.3 措辞略乐观但不致命）。

**改进建议**：
- §3.3 diff 块新增第 6 行 admin actions SQL 同步 patch list：`fengyu-admin/src/actions/points.ts` 全部 `cast(... as int)` 涉及 amount 列的，改 `as bigint` + Drizzle 类型 `sql<bigint>`；前端展示再 `Number()` 兜底（带 safe-int 警告日志）。
- §4 第 0 步加一条："SELECT datname, pg_encoding_to_char(encoding) FROM pg_database" 确认 5434 当前库是 `fengyu` 而非 `postgres`，避免 ALTER 错库；并明确双库 ALTER 语句（5434 `ALTER DATABASE fengyu ...`，5433 `ALTER DATABASE fengyu_wxapp ...`）。
- §6.2 增 e) "`SELECT DISTINCT type, COUNT(*), MIN(amount), MAX(amount) FROM point_transactions GROUP BY type`" 列出全部 type 与 amount 符号分布，再决定 §3 CHECK 表达式精度。
- §9 验收增"所有 admin `cast as int` over `point_transactions.amount` / `points_balance` 已扫描并改为 `as bigint`"一条。
- ticket 完全没提"PG CHECK ADD CONSTRAINT 默认会全表校验（不支持 NOT VALID + VALIDATE CONSTRAINT 分阶段）"。建议显式声明用 `ADD CONSTRAINT ... NOT VALID` + 后续 `VALIDATE CONSTRAINT`（PG 12+ 支持），避免长锁。

---

## 完成记录（2026-05-17）

**实施状态**：✅ 全流程闭环（7 phase 全部 PASS，含生产 5434 + 冷备 5433 + 5 端滚动重启 + 3 云函数 TZ env 上推）

### 7 phase 落地证据

| Phase | 内容 | 证据 |
|-------|------|------|
| 1 dry-run | 5434 6 段 SELECT + 211 行 phone 违例审计 | `notes/dry-runs/2026-05-17-l0-schema-checks-dryrun.md` + `docs/migrations/2026-05-17-phone-cleanup-backup.csv` |
| 2 schema.ts | 5 CHECK + 2 bigint + 顶部 safe-int 注释 | `db/schema/user.ts` `prepaid-card.ts` `points.ts`（commit 352a629） |
| 3 migration | 0028_fine_maelstrom.sql：清洗 UPDATE + 5 ADD CONSTRAINT + 2 ALTER COLUMN bigint + 末尾 ALTER DATABASE fengyu | commit 352a629 |
| 4 临时 PG 验证 | pg_dump 5434 → postgres:16 → apply 0028 零失败，5 CHECK / 2 bigint / triggers 抛 check_violation | 临时容器已销毁 |
| 5 admin patch + ESLint | points.ts cast→bigint + safeNumber + eslint.config.mjs no-restricted-syntax | commit 9651afd + 6d9123c |
| 6 tsc + Vitest | admin tsc 无报错；points + refunds 24/24 通过；其他 9 fail 是 error-codes 重构所致与本 ticket 无关 | local CI |
| 7 生产 apply + 滚动重启 | 5434 + 5433 双库 db:migrate；admin + cron-worker 全镜像 deploy-admin.sh ali-demo；staffApi + clientApi + payNotify 全部 `echo y \| tcb fn deploy` 同步 TZ env | commit 9651afd / 41ea65f / f102f0e |

### 5434 + 5433 双库最终状态

```sql
-- 两库均通过下列复核：
SELECT count(*) FROM pg_constraint WHERE contype='c' AND conname IN
  ('chk_swu_phone_format','chk_cwu_phone_format','chk_card_tx_amount_sign',
   'chk_pt_amount_sign','chk_prepaid_balance_nonneg'); -- 5
SELECT count(*) FROM information_schema.columns WHERE data_type='bigint'
  AND (table_name,column_name) IN
      (('point_transactions','amount'),('client_wechat_users','points_balance')); -- 2
SHOW timezone; -- Asia/Shanghai（DB 层 ALTER DATABASE 持久化）
SELECT count(*) FROM client_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{9}$'; -- 0
SELECT count(*) FROM staff_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{9}$'; -- 0
```

drizzle_migrations：双库均 30 条，hash 完全一致（0028=a07101c2... / 0029=fd6244f9...）。

### 3 云函数 TZ env 最终状态

| 函数 | envId | TZ 已上推 | 部署方式 |
|------|-------|----------|---------|
| staffApi | cloud1-9g3ydpg512eecc99 | ✅ | tcb fn deploy（fengyu-staff/.env 登录） |
| clientApi | cloud1-3gpht4b01ff88838 | ✅ | tcb fn deploy（fengyu-client/.env 登录） |
| payNotify | cloud1-3gpht4b01ff88838 | ✅ | tcb fn deploy（同上） |

**注意**：`tcb fn code update` 只推代码不推 env。env 上推必须用 `tcb fn deploy`（自动确认 `echo y` 跳过交互；因 cloudbaserc.json 已含全部生产 env vars + 新增 TZ，无 env 丢失风险）。

### 两处偏离 ticket 文本（已校正）

1. **正则 typo**：ticket 全篇 `^1[3-9][0-9]{8}$`（10 位）→ 实施改用 `^1[3-9][0-9]{9}$`（11 位中国手机号）。若按 ticket 原文，27295 合法号会被 CHECK 误阻断。
2. **D4 trigger 误描述**：ticket §3.2 称 migration 0020 已守 `balance >= 0` — 实查 0020 是 `trg_check_no_mixed_recharge`（防混合充值卡），**非 balance 守护**。本次 `chk_prepaid_balance_nonneg` 是首道余额硬约束；生产 0 行违例纯因应用层未扣穿。

### 用户 4 项决策

| 决策 | 选择 |
|------|------|
| Apply 范围 | 全流程含 P7 ✅ |
| Dry-run 方式 | 我用 psql 直连 5434 跑 ✅ |
| CloudBase TZ env | 本 PR 同步补 TZ env ✅（含部署上推） |
| ESLint 规则范围 | 仅补 admin 端 ✅（cloudfunctions ESLint 留 follow-up） |

### SUMMARY 影响

- §2 Top10 #6 "L0 一次性 migration epic 剩余 8 项" → **0** ✅
- §3 "金额/比例 CHECK 剩 2 项" → **0** ✅
- §4 L0 P0 "剩 5 项" → **0** ✅
- §概览总表 E5 "🔶 5/13 关闭" → **✅ 13/13 关闭**

### 关联 ticket

- 并行落地：`notes/tickets/2026-05-17-toctou-partial-unique-indexes.md` → migration 0029（partial UNIQUE 10 项）
- Follow-up：cloudfunctions 三端 ESLint flat config 搭建（toISOString().slice 规则三端补齐）
- Follow-up：L11 P0 `audit-prepaid-balance.ts` cron 守护（与 S-CC2-11 配套）
- Follow-up：sale_orders.client_phone + stores.phone 是否纳入 phone CHECK 业务决策

