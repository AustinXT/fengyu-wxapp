---
ticket: Advisory lock 跨事务释放窗口 — generateOrderNo / generateServiceOrderId TOCTOU
date: 2026-05-17
severity: P0
端: fengyu-staff（主）/ fengyu-admin（参照）/ fengyu-client（参照）
cost: M（1-3 天，含三端 + 单元/并发测试）
来源:
  - docs/audit/SUMMARY.md §2 Top10 #3
  - docs/audit/audit-02-order-create.md P0-02-01
  - docs/audit/audit-05-service-lifecycle.md P0-05-02
  - docs/audit/audit-11-refunds.md P0-11-03
  - docs/audit/audit-CC2-concurrency.md P0-CC2-01 / P0-CC2-04
关联:
  - 参考正确范式：fengyu-admin/src/actions/orders.ts:1125-1185 / services.ts:520-549
  - 参考正确范式：fengyu-client/cloudfunctions/clientApi/routes/order.js:420-460
  - 参考正确范式：fengyu-staff/cloudfunctions/staffApi/routes/card.js:190-220
  - 跨端原则：[no-shared-cloudfunctions](MEMORY)
状态: ✅ 已完成（2026-05-17）
---

# Ticket: Advisory lock 跨事务释放窗口 — generateOrderNo / generateServiceOrderId TOCTOU

> ### 实施结果（2026-05-17）
>
> **全部 7 个 patch 已应用，跨端 lock key 统一完成。**
>
> 源码变更（2 文件）：
> - `fengyu-staff/cloudfunctions/staffApi/routes/order.js`：
>   - `generateOrderNo(prefix, client)` 强制 client 参数 + dateStr 移入函数体首行（防跨午夜）+ 不再自开 `pg.transaction`
>   - `order.create` (L444-L545) — 删除 L445 事务外 `generateOrderNo()` + 删除 L542 重复 advisory_xact_lock + 移入事务回调首行
>   - `createConversion` (L2029-L2033) — 同等改造
> - `fengyu-staff/cloudfunctions/staffApi/routes/service.js`：
>   - `generateServiceOrderId(client)` 强制 client 参数 + dateStr 移入函数体首行
>   - lock key 从自定义 `Buffer.from('svc_order_id')` hash 统一为 `hashtext('service_order_id_gen')`，与 admin `services.ts:522` 跨端互锁
>   - `service.create` (L166) 改用 `let serviceOrderId` 在事务外声明、事务回调首行赋值
>
> 测试调整（2 文件）：
> - `__tests__/routes/order.test.js`：7 个 createConversion 测试 mock 调整（合并两个 pg.transaction.mockImplementationOnce 为单一主事务 mock + 添加 SELECT sale_order_id LIKE 桩）
> - `__tests__/routes/service.test.js`：6 个 service.create 测试同等调整
>
> 新增脚本：
> - `fengyu-staff/scripts/manual-e2e/concurrent-order-create.mjs` — N=50 并发 order.create 回归脚本（按 [test-colocation] 置于子项目下，文件后缀 `.mjs` 以对齐 staffApi 现有 e2e 风格而非 ticket 原写的 `.spec.ts`）
>
> 验收：
> - 跨端 grep：`svc_order_id` / `Buffer.from('svc_order_id')` 全仓 0 命中；`hashtext('service_order_id_gen')` 在 staffApi/service.js + admin/services.ts 各 1 命中 ✓
> - 单测：基线 19 failed → 修复后 4 failed（剩余 4 个在 `createPickup` / `approveRefund balance cascade`，与 advisory lock 无关，pre-existing 工作树状态遗留）
> - createConversion / service.create 全部用例 PASS（14 + 17 全绿）
>
> 待人工执行：
> - 测试环境跑 `bun fengyu-staff/scripts/manual-e2e/concurrent-order-create.mjs` 验证 N=50 并发 distinct + 无 PK 冲突
> - 生产 PG 日志监控部署前后 7 天 `sale_orders_pkey` / `service_orders_pkey` 冲突计数对比
>
> ---
>
> ### v2 修订摘要（2026-05-17，复核反馈后）
> - 修订状态：R1 → **R2（复核反馈合入）**
> - 关键修订：
>   1. 顶部补标准 YAML frontmatter（与 sibling ticket 对齐）
>   2. 新增 **Patch 7**：统一 `service.js` advisory lock 键为 `hashtext('service_order_id_gen')`（消除自定义 hash 与 admin 串行池不相交问题）
>   3. Patch 2/3 明确**删除**外层 L542/L2033 的 advisory_xact_lock，由 `generateOrderNo` 内部独占；移除"重入无害"的含糊表述
>   4. Patch 2 加子步骤：`dateStr` 计算移进事务回调首行（消除跨午夜窗口）
>   5. Patch 6 mock 改造改为 `grep` 全量扫，不再依赖行号清单
>   6. §5.2 并发脚本路径改为 `fengyu-staff/scripts/manual-e2e/`（按 [test-colocation] 记忆）
> - 详见末尾"复核反馈（R2，2026-05-17）"节

---

## 0 一句话背景

`staffApi/routes/order.js:2473-2495` 的 `generateOrderNo` 自带独立 `pg.transaction()`，advisory lock 随子事务 commit 立刻释放；外层 `order.create` 在 L540 才开新事务做 INSERT。两段事务之间存在 TOCTOU 窗口，并发请求可拿到相同序号 → 同日订单号重复 → 退款/转换/凭证单全部受牵连。

## 1 当前实现（代码 + 时序图）

### 1.1 `generateOrderNo` 自带独立子事务（核心问题点）

`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2473-2495`：

```js
async function generateOrderNo(prefix) {
  if (!prefix) prefix = 'FY-XSD-WX-'
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')
  const likePattern = `${prefix}${dateStr}%`
  // 使用 advisory lock 防止并发生成重复订单号
  const result = await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])
    const rows = await client.query(`
      SELECT sale_order_id FROM sale_orders
      WHERE sale_order_id LIKE $1
      ORDER BY sale_order_id DESC LIMIT 1
    `, [likePattern])
    let seq = 1
    if (rows.rows.length > 0) {
      seq = parseInt(rows.rows[0].sale_order_id.slice(-4)) + 1
    }
    return `${prefix}${dateStr}${String(seq).padStart(4, '0')}`
  })
  return result   // <-- COMMIT 在这里发生，advisory_xact_lock 已释放
}
```

`pg.transaction` 实现（`fengyu-staff/cloudfunctions/staffApi/db/pg.js:47-60`）：

```js
async function transaction(callback) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')   // ← advisory_xact_lock 在此释放
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

### 1.2 外层 `order.create` 又开新事务（L444-L592 节选）

```js
// L444 — 事务外先拿订单号
const saleOrderId = await generateOrderNo()
// ...几十行业务计算（balance 查询、document_type 判定）...

await pg.transaction(async (client) => {                              // L540 — 新事务
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
                     ['sale_order_id_gen'])                            // L542 — 锁第二次
  // ...生成 sale_item_id...
  // ...INSERT sale_orders ... VALUES ($saleOrderId, ...)             // L592+
})
```

### 1.3 TOCTOU 时序图

```
时间 →

请求 A (店长 a)                     请求 B (店长 b，同店或跨店均可)
─────────────────────────────       ─────────────────────────────
generateOrderNo() ENTER
  BEGIN tx1
  advisory_xact_lock(K)             generateOrderNo() ENTER
  SELECT MAX → seq=42                 BEGIN tx2
  return 'FY-XSD-WX-2605170042'       advisory_xact_lock(K)  ← BLOCK
  COMMIT tx1                          ▲
  ↓ 锁释放                            ▲
                                      ↓ 解除阻塞
                                    SELECT MAX → seq=42  ← 注意：
                                      A 的 INSERT 还没发生，
                                      MAX 仍是 41！
                                    return 'FY-XSD-WX-2605170042'  ← 同号
                                    COMMIT tx2
balance 查询、document_type ...     balance 查询、document_type ...
BEGIN tx3                           BEGIN tx4
  advisory_xact_lock(K)               advisory_xact_lock(K) ← 串行
  INSERT sale_orders                  INSERT sale_orders     ← 第二个抛 PK 冲突
  COMMIT tx3 ✓                        ROLLBACK tx4 ✗
                                      → 用户看到 "订单创建失败"
                                      → balance/coupon 状态已经被读但未写，
                                        部分上游副作用可能落库
```

**核心矛盾**：lock 的"持有窗口"必须覆盖 `SELECT MAX → INSERT`，但现在 lock 在 `generateOrderNo` 子事务 commit 时就释放了，外层事务的 INSERT 在另一个事务里。等于 lock 只串行化了"读 MAX"，没串行化"读到 INSERT"的关键区间。

### 1.4 三端 / 三类业务 ID 命中清单

| # | 文件 | 行号 | 函数 | 模式 | 是否有 BUG |
|---|------|------|------|------|-----------|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 445 | `order.create` 调 `generateOrderNo()` | **gen 独立 tx + 外层另开 tx** | ❌ **有** |
| 2 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 2030 | `order.createConversion` 调 `generateOrderNo('FY-XSD-WX-')` | **gen 独立 tx + 外层 L2032 另开 tx** | ❌ **有** |
| 3 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 2473-2495 | `generateOrderNo` 实现 | 子事务内 lock+SELECT | 源头 |
| 4 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 768-790 | `generateServiceOrderId` | **同样模式：独立 tx 生成 ID** | ❌ **有**（服务单创建路径需复核外层是否再开 tx）|
| 5 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 193 | `service.create` 调 `generateServiceItemId()` | 时间戳+随机，无 lock | ⚠️ 弱（依赖随机不撞，与本 ticket 无直接关系，可单独收）|
| 6 | `fengyu-staff/cloudfunctions/staffApi/routes/card.js` | 193 | 充值卡下单 | lock 与 INSERT **在同一事务内** | ✅ 正确范式 |
| 7 | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 422 | 顾客下单 | lock 与 INSERT **在同一事务内** | ✅ 正确范式 |
| 8 | `fengyu-client/cloudfunctions/clientApi/routes/card.js` | 250 | 顾客充值卡 | lock 与 INSERT **在同一事务内** | ✅ 正确范式 |
| 9 | `fengyu-admin/src/actions/orders.ts` | 1125-1185 | `createOrder` | `db.transaction` 内 WITH lock + INSERT 一气呵成 | ✅ 正确范式 |
| 10 | `fengyu-admin/src/actions/orders.ts` | 1563-1614 | `createConversion` | 同上，事务内一体 | ✅ 正确范式 |
| 11 | `fengyu-admin/src/actions/orders.ts` | 1911-1956 | `createRepayment` (FY-HKD) | 同上，事务内一体 | ✅ 正确范式 |
| 12 | `fengyu-admin/src/actions/services.ts` | 520-549 | `createService` (FY-FW) | 同上，事务内一体 | ✅ 正确范式 |

**结论**：**admin + clientApi 全部正确**（lock + SELECT + INSERT 在同一 `db.transaction` / `pg.transaction`），**仅 staffApi 的 `order.js` 和 `service.js` 存在跨事务 TOCTOU**。staffApi 自身的 `card.js` 也是正确范式，可作为参照。

## 2 攻击 / 触发场景

### 场景 A：同店两位店长同秒开单

```
门店 X，店长 a 和店长 b 在 11:23:45 同时点"开单"
  → 两次 staffApi.order.create 几乎同时入 generateOrderNo
    → A 拿到 FY-XSD-WX-2605170042，B 也拿到 0042（见 §1.3 时序图）
      → A 的事务先 COMMIT → sale_orders PK 占用
        → B 的 INSERT 抛 duplicate key value violates unique constraint "sale_orders_pkey"
          → B 看到 "订单创建失败"，但前端无 retry，店员二次手动操作 → 体验差 + 操作日志不完整
```

### 场景 B：跨店并发开单（更可怕，因为 sale_order_id 全局唯一）

```
门店 X 店长 a + 门店 Y 店长 b 几乎同时下单
  → 两人都拿到 FY-XSD-WX-2605170042
    → A INSERT 成功，B INSERT 失败
      → B 端业务可能在 generateOrderNo 与 INSERT 之间已经有副作用：
         · 优惠券预扣（L558-569 UPDATE user_coupons claim）尚未发生 → OK
         · balance 查询（L452-456）只读 → OK
         · 但 saleOrderId 已经发给 client 用作 idempotency key 的场景下，
           前端可能误以为单号 0042 是自己的
```

### 场景 C：转换单 / 退款链 (`createConversion` L2030)

转换单走 `generateOrderNo('FY-XSD-WX-')` 同前缀，BUG 同形。一旦撞号，转出/转入两条 sale_items + 原卡 FOR UPDATE 扣减 + sale_order_payments 写入全部 ROLLBACK，**用户体感是"折抵卡操作失败但前端 loading 已经闪过"**。

### 场景 D：服务单 `HLD-WX-` (`service.js:768`)

服务单号同样在子事务里生成。staff create 服务单时同样会撞号，影响：
- `service_orders` PK 冲突
- 关联的 `service_items` ID 形如 `${serviceOrderId}-${seq}` 也会跟着撞

### 触发概率估算

- 单店日均开单 80 单，店长在线 2-3 人，峰值时段（午休前 11:30、晚饭前 17:30）撞号概率非零
- 跨店总订单全集团日均 ~600 单，假设 8 小时营业，平均 1.25 单/分钟；正常分布下 1 秒内并发概率 < 0.5%，但**节假日 / 大促时会指数级上升**
- 实际生产可观察指标：`sale_orders_pkey` PG 错误日志的频次（建议先 grep 看历史是否已发生过）

## 3 修复方案

### 方案 A（推荐）：`generateOrderNo` 接受可选 `client` 参数，复用外层事务 ✅

**变更最小、语义最稳、回滚最容易**。

```js
// 改造后：
async function generateOrderNo(prefix, client) {
  if (!prefix) prefix = 'FY-XSD-WX-'
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')
  const likePattern = `${prefix}${dateStr}%`

  const runIn = async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])
    const rows = await c.query(`
      SELECT sale_order_id FROM sale_orders
      WHERE sale_order_id LIKE $1
      ORDER BY sale_order_id DESC LIMIT 1
    `, [likePattern])
    let seq = 1
    if (rows.rows.length > 0) {
      seq = parseInt(rows.rows[0].sale_order_id.slice(-4)) + 1
    }
    return `${prefix}${dateStr}${String(seq).padStart(4, '0')}`
  }

  // 复用外层事务：不再开新 BEGIN，lock 持有窗口延伸到外层 COMMIT
  if (client) return await runIn(client)
  // 兼容老调用（不在事务里的探测用）— 这种场景应该被消除
  return await pg.transaction(runIn)
}
```

**call site 改造**：

| 文件 | 行号 | 原 | 改 |
|------|------|----|----|
| `order.js:445` | `order.create` | `const saleOrderId = await generateOrderNo()` 在事务外 | 删除外层 L445；将 `generateOrderNo(undefined, client)` 移入 L540 `pg.transaction` 回调首行（在 advisory lock 之后立即调用、或者复用同一把 lock） |
| `order.js:2030` | `createConversion` | `const convOrderId = await generateOrderNo('FY-XSD-WX-')` 在事务外 | 同上，移入 L2032 事务回调内首行 |
| `service.js:768` | `generateServiceOrderId` | 同 BUG，独立 tx | 同样改成 `(client) =>` 形态，外层 `service.create` 复用 client |

**为什么推荐 A**：
1. 代码改动局部，不引入新表 / 新 DDL
2. lock 持有窗口延伸到 INSERT，TOCTOU 彻底消失
3. admin / clientApi 已经是这个范式，跨端一致
4. 不影响日序号视觉连续性（业务方习惯）

### 方案 B：PG `sequence` + 应用层格式化（不推荐）

```sql
CREATE SEQUENCE sale_order_seq_2605170001 START 1;
-- 然后 nextval('...') 拼前缀
```

**缺点**：
- 每天换 sequence 名要 DDL（或 SCHEDULED JOB 提前创建），运维成本高
- gap 多（事务回滚不回退 seq），业务方会问"为什么从 0042 跳到 0044"
- 影响 admin / cron 跨端一致性，需要四处改

### 决策记录

采纳方案 A。理由：admin 和 clientApi 都已是"事务内一体"范式，staffApi 这两个文件属于历史漏改，方案 A 是"对齐已有正确范式"，不是引入新设计。

## 4 详细 Patch 清单（按 call site）

### Patch 1：`fengyu-staff/cloudfunctions/staffApi/routes/order.js` — `generateOrderNo`

L2473-L2495 改造：函数签名加 `client` 参数；若传入 client，直接在该 client 上执行 lock + SELECT，不再开 `pg.transaction`。保留无 client 时的兼容分支（仅供测试或非事务读取）。

### Patch 2：`fengyu-staff/cloudfunctions/staffApi/routes/order.js` — `order.create` (L444-L592)

- 删除 L444-L445 事务外的 `generateOrderNo()` 调用
- **删除 L542 外层 `advisory_xact_lock` 调用**（由 `generateOrderNo` 内部独占持锁，避免两处 lock 调用引发理解负担与 implementor 误删）
- 在 L540 `pg.transaction(async (client) => { ... })` 内、**事务回调首行**调用 `const saleOrderId = await generateOrderNo(undefined, client)`
- **`dateStr` 必须移入事务回调首行**：原 `generateOrderNo` 在事务外读 `new Date().toISOString()`，若主线程被调度延后再进事务，会出现"用昨天的 dateStr 占新日 seq=1 槽位"的历史回退序号风险。Patch 1 改造后 `dateStr` 已在 `generateOrderNo(client)` 函数体首行计算，落在事务内，OK；本 Patch 仅需确保无任何外层缓存的 `dateStr` 被再传入
- 锁持有窗口：`generateOrderNo` 进入事务后立即 `pg_advisory_xact_lock(hashtext('sale_order_id_gen'))`，直到外层事务 COMMIT 才释放 — 全程覆盖 SELECT MAX → INSERT，TOCTOU 消失
- 需要复核：`documentType` 计算（L522-L538）依赖 `totalAmount`，不依赖 `saleOrderId`，可以保留在事务外；balance 查询（L450-L478）也是只读，保留在事务外可以；但优惠券 claim（L558）必须在事务内，已经在事务内，OK

### Patch 3：`fengyu-staff/cloudfunctions/staffApi/routes/order.js` — `createConversion` (L2030)

- 删除 L2030 事务外调用
- **删除 L2033 外层 `advisory_xact_lock` 调用**（同 Patch 2 决策：lock 由 `generateOrderNo` 内部独占，二选一写死，不保留两处）
- 在 L2032 `pg.transaction(async (tx) => { ... })` 内**事务回调首行**调用 `const convOrderId = await generateOrderNo('FY-XSD-WX-', tx)`

### Patch 4：`fengyu-staff/cloudfunctions/staffApi/routes/service.js` — `generateServiceOrderId`

L768-L790 同样改造：加 `client` 参数；call site 在 `service.create`（需 grep 确认调用点）内事务回调里调用。

### Patch 5（可选）：将 `card.js` / `clientApi/order.js` / admin 的正确范式抽出一个 helper

**不建议本 ticket 做**。三端共享代码会违反 [no-shared-cloudfunctions](MEMORY) 准则，保持独立副本即可。

### Patch 6：单元测试调整

- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js` 与 `service.test.js` 中所有 mock `generateOrderNo` / `generateServiceOrderId` 内部 SQL 的桩需要更新（不再 mock `client.query('BEGIN')` / `client.query('COMMIT')`，因为这两个函数不再开自己的事务）
- **改造前必须 grep 全量扫**（不要按行号清单逐行改，因为隐式桩如 `if (sql.includes('advisory_xact_lock'))` / `if (sql.includes('sale_order_id_gen'))` 不会被行号列表覆盖）：

  ```bash
  grep -rn 'pg_advisory_xact_lock\|generateOrderNo\|generateServiceOrderId\|sale_order_id_gen\|service_order_id_gen' \
    fengyu-staff/cloudfunctions/staffApi/__tests__/
  ```

- 把所有命中行检查一遍，确认：
  1. mock 的 BEGIN/COMMIT 次数与改造后实际事务边界一致（一次外层 `pg.transaction` 应只 BEGIN/COMMIT 一次）
  2. advisory_xact_lock 桩的 key 与新实现一致（详见 Patch 7 — service.js 改为 `hashtext('service_order_id_gen')`）
- 新增并发测试：见 §5

### Patch 7：`fengyu-staff/cloudfunctions/staffApi/routes/service.js` — 统一 advisory lock 键（**强制**）

**问题**：`service.js:774` 用 `Buffer.from('svc_order_id').reduce((h,b)=>(h*31+b)&0x7fffffff, 0)` 自定义 hash → `pg_advisory_xact_lock($1)`；`fengyu-admin/src/actions/services.ts:522` 用 `hashtext('service_order_id_gen')`。两端串行池**互不相交** — 并发 staffApi 创建服务单 + admin 创建服务单时根本不互锁，会撞号。

**修法**：将 `service.js` 的 lock 调用统一改为与 admin 一致的 `hashtext('service_order_id_gen')`：

```diff
 async function generateServiceOrderId(client) {
-  const today = new Date()
-  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')
-  const likePattern = `HLD-WX-${dateStr}%`
-  const lockKey = Buffer.from('svc_order_id').reduce((h, b) => (h * 31 + b) & 0x7fffffff, 0)
-  const result = await pg.transaction(async (client) => {
-    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey])
+  const runIn = async (c) => {
+    const today = new Date()                                  // dateStr 移入事务内首行，避免跨午夜
+    const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')
+    const likePattern = `HLD-WX-${dateStr}%`
+    await c.query(
+      'SELECT pg_advisory_xact_lock(hashtext($1))',           // 与 admin services.ts:522 对齐
+      ['service_order_id_gen']                                // 与 admin 完全相同的键名
+    )
     // ...SELECT MAX → return id...
+  }
+  if (client) return await runIn(client)
+  return await pg.transaction(runIn)
 }
```

**验收**：grep 整库确认 `svc_order_id` / `Buffer.from('svc_order_id')` 0 命中；`hashtext('service_order_id_gen')` 在 staffApi + admin 两端各 1 命中。

**为什么强制**：若不做 Patch 7，仅做 Patch 1-6 后 staffApi 内部并发已串行，但跨端（admin + staffApi 同时创建服务单）仍可能撞号 — 修完仍是 false-fix。本项是 Block 级修订要点。

## 5 验证 Checklist

### 5.1 单元测试
- [ ] `order.test.js` 调整 advisory_xact_lock 桩，保留所有现有 PASS 用例
- [ ] 新增 unit：`generateOrderNo(prefix, mockClient)` 在传入 client 时不调用 `pg.transaction`
- [ ] 新增 unit：`order.create` 内单一事务边界（mock 出 BEGIN/COMMIT 只各 1 次）

### 5.2 并发集成测试（关键）
- [ ] 写一个 `fengyu-staff/scripts/manual-e2e/concurrent-order-create.spec.ts` 同时发起 N=50 个 `order.create`（同一店长 / 不同店长 / 跨店混合），验证：（路径按 [test-colocation] 记忆要求，必须在 staffApi 子项目下）
  - 所有响应 success=true 或 fail with 业务级错误（无 PK 冲突错误泄漏）
  - 50 个生成的 `saleOrderId` 全部 distinct
  - `sale_orders` 表实际 INSERT 行数 == 成功响应数
- [ ] 服务单同样并发测试 `service.create`

### 5.3 唯一冲突计数（生产监控）
- [ ] PG 日志 grep `duplicate key value violates unique constraint "sale_orders_pkey"`，部署前 7 天基线 / 部署后 7 天对比
- [ ] 同上 `service_orders_pkey`
- [ ] 添加 cloudbase 函数日志结构化字段 `error_code=PK_CONFLICT` 便于告警

### 5.4 数据一致性
- [ ] 部署后第一天每小时跑：`SELECT sale_order_id, COUNT(*) FROM sale_orders GROUP BY sale_order_id HAVING COUNT(*) > 1`（DB PK 不会让它真重，主要看历史是否有重复）
- [ ] `SELECT count(*) FROM sale_orders WHERE created_at >= '2026-05-17'` 与业务侧实际开单数（操作日志）对比

### 5.5 跨端 snapshot 测试守护
- [ ] 若已有 cross-end snapshot test (per [no-shared-cloudfunctions](MEMORY))，确保 staff / client / admin 的"订单号生成范式"快照一致

## 6 风险与回滚

### 风险
1. ~~**重复 lock 同一 key 的行为差异**~~ — **已通过 Patch 2/3 决策消除**：删除外层 L542/L2033 的 lock，由 `generateOrderNo` 内部独占持锁；不再存在"同一事务两处 lock 同一 key"的场景，无需依赖 PG 重入行为
2. **事务范围扩大 → 持锁时间变长**：原 `generateOrderNo` lock 持有 ~10ms，方案 A 后会持有整个 `order.create` 事务（balance 查询 / 优惠券 claim / INSERT，估计 50-200ms）。**对吞吐影响**：advisory_xact_lock 是按 key 串行，意味着所有 `order.create` 串行化。8 小时 600 单 → 平均 48 秒一单 → 串行也完全够。但需要在压测里确认 p99 < 1s。
3. **事务里 balance 查询会跟着回滚** — 这是只读，无副作用，OK
4. **跨端覆盖**：本 ticket 只动 staffApi。clientApi 和 admin 已经是正确范式，**严格不动**。Patch 7 统一 service.js 的 lock key 命名以与 admin 跨端互锁，不动 admin 行为

### 回滚方案
- 单文件 `routes/order.js` + `routes/service.js` 改动，git revert 即可
- 无 DDL 变更，DB 端无需回滚
- 单元测试桩需同步 revert

## 7 关联

| 项 | 说明 |
|----|------|
| 前置 | 无（DB 端已经有 `sale_orders_pkey` 兜底 PK，最坏情况是 INSERT 失败抛错，不会落两行）|
| 关联 | SUMMARY v3 Top10 #3 — Advisory lock 跨事务释放窗口 |
| 关联 audit | [audit-02 订单创建](../../docs/audit/audit-02-order-create.md) P0-02-01 |
| 关联 audit | [audit-05 服务单生命周期](../../docs/audit/audit-05-service-lifecycle.md) P0-05-02 |
| 关联 audit | [audit-11 退款](../../docs/audit/audit-11-refunds.md) P0-11-03 |
| 关联 audit | [audit-CC2 并发与原子性](../../docs/audit/audit-CC2-concurrency.md) P0-CC2-01 / P0-CC2-04 |
| 参考正确范式 | `fengyu-admin/src/actions/orders.ts:1125-1185` (createOrder) |
| 参考正确范式 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:420-460` |
| 参考正确范式 | `fengyu-staff/cloudfunctions/staffApi/routes/card.js:190-220` |
| 同源相关（暂不本 ticket 处理） | `service.js:792` `generateServiceItemId` 用 `Date.now() + Math.random()` 拼接，弱保证 — 单独评估 |
| 跨端原则 | [no-shared-cloudfunctions](MEMORY) — 三端独立副本，靠 snapshot 守护 |

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**：
1. **ticket 无 frontmatter**。同期 `2026-05-17-l0-schema-checks-and-timezone.md` 用标准 `---` YAML frontmatter（ticket/date/severity/端/cost/来源/关联/状态），本 ticket 改用 `>` blockquote 头，索引/工具难统一抓取。
2. **`service.js:774` 与 `admin/services.ts:522` 锁键不一致**：staffApi 用 `Buffer.from('svc_order_id').reduce((h,b)=>(h*31+b)&0x7fffffff,0)` 自定义 hash + `pg_advisory_xact_lock($1)`；admin 用 `hashtext('service_order_id_gen')`。两端串行池**互不相交**——并发 staffApi+admin 创建服务单时根本不互锁。ticket 只说"加 client 参数复用外层事务"，未要求统一为 `hashtext('service_order_id_gen')`，修完仍跨端不安全。
3. **方案 A 重入 lock 论断未实证**：ticket §6 风险 1 说 "重复 lock 同一 key 在同一事务内是 no-op，请用 psql 实测确认"——这是 PG `pg_advisory_xact_lock` 的**已知行为**（同一事务内可重入计数，无害），但 ticket 自己说"非常确定但需手动核一次"暴露未验证。`order.create` L542 已存在的 lock 与 `generateOrderNo` 内 lock 重入正确，但若 implementor 删错地方会引入新问题。建议明确："保留外层 L542 lock，内部 lock 删除"或反之，二选一写死。

**Warn 级问题**：
1. **call site 实际只有 2 处** (`order.js:445`、`order.js:2030`)，加 service 1 处共 3 处。ticket 表格第 5 项 `generateServiceItemId` 已标"与本 ticket 无直接关系"，正确。`createRefund / approveRefund / rejectRefund / createRepayment / createPickup` 均不调 `generateOrderNo`（用 `sale_order_payments.id` SERIAL 或不生新单号），ticket 未漏点。OK。
2. **Patch 6 mock 改造清单过窄**：grep 显示 `order.test.js` 含 advisory_xact_lock/generateOrderNo 桩点远多于 ticket 列出的 13 个行号（如 L4634/L4698 还有 `if(sql.includes('advisory_xact_lock'))` 这类隐式桩），改造时需 grep `pg_advisory_xact_lock|generateOrderNo` 全量扫，不要按 ticket 行号清单。
3. **跨午夜窗口**：ticket §4 Patch 2 提了"`now`/`dateStr` 跨午夜风险"但未给修法。`dateStr` 计算在事务外，事务内 INSERT 时若已跨午夜，会用昨天的 dateStr 占新日的 seq=1 槽，产生历史回退序号。应明确：`dateStr` 也必须移进事务回调首行。

**OK**：
1. `staffApi/routes/order.js:2473-2495` 位置精确，generateOrderNo 子事务实证存在。
2. admin (orders.ts L1129/L1566/L1913、services.ts L522)、clientApi (order.js L422、card.js L250)、staff/card.js L193 确为"事务内一体"范式，可作参照。
3. P0 + M(1-3 天) 成本评估合理：3 处 call site + 测试桩调整 + 并发验证脚本，1-3 天工时充分。
4. 决策选方案 A、不抽 shared helper（符合 [no-shared-cloudfunctions]），方向正确。

**改进建议**：
1. 加 YAML frontmatter 与 sibling ticket 对齐。
2. 把"统一 service.js lock 键到 `hashtext('service_order_id_gen')`"作为强制 Patch 7（**最关键**：否则修完仍是 false-fix）。
3. Patch 2/3 明示"删除外层 L542/L2033 的 advisory_xact_lock，由 generateOrderNo 内部独占"——别同时保留两处然后说"重入无害"。
4. Patch 2 加一条：`dateStr` 计算移入事务回调首行，避免跨午夜窗口。
5. Patch 6 把"按 ticket 行号清单改 mock"改为"grep `pg_advisory_xact_lock\|generateOrderNo` 全量扫"。
6. §5.2 并发脚本应放 `fengyu-staff/scripts/manual-e2e/`（按 [test-colocation] 记忆），不是 `scripts/manual-e2e/`（root）。

### R2 合入摘要

| 反馈项 | 处理动作 | 位置 |
|--------|----------|------|
| Block 1（无 frontmatter） | 顶部补 YAML frontmatter | 文档头 |
| Block 2（service.js lock 键跨端不互锁） | 新增 **Patch 7** 强制统一为 `hashtext('service_order_id_gen')` | §4 Patch 7 |
| Block 3（重入论断未实证） | Patch 2/3 改为"删除外层 lock，内部独占"二选一写死；§6 风险 1 改为已消除 | §4 Patch 2/3、§6 |
| Warn 2（mock 改造清单过窄） | Patch 6 改为 grep 全量扫 | §4 Patch 6 |
| Warn 3（跨午夜） | Patch 2 显式要求 `dateStr` 移进事务回调首行 | §4 Patch 2 |
| 改进建议 6（路径） | §5.2 改为 `fengyu-staff/scripts/manual-e2e/` | §5.2 |
