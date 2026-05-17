# 审计报告：服务单 + 扣次原子性 (05) — v3

**审计时间**：2026-04-26
**域 ID**：05
**审计员**：claude-sonnet-4-6
**审计时长**：~50 分钟（三轮合并）
**前序报告**：
  - v1：`docs/audit/audit-05-service-order.md`（claude-opus-4-7，2026-04-25）
  - v2：`docs/audit/audit-05-service-order-v2.md`（claude-sonnet-4-6，2026-04-26）
**关联 PR/Ticket**：—
**v3 合并说明**：v1 + v2 独立三轮源码审计合并，同问题以 v2 为准；v1 P0 已在 v2 验证为真时标注 `[CLOSED from v1]`；新增全局 grep 实证节（影响半径扩展至全仓 5 处）。

---

> ### 🔥 2026-05-17 复核状态
>
> | 问题 ID | v3 原状态 | 2026-05-17 复核 |
> |---------|---------|-----------------|
> | **P0-05-01** staff service.create 写 `service_items.sku_id` 不存在列 | 未修复 | **❌ 仍未修复** — `fengyu-staff/cloudfunctions/staffApi/routes/service.js:208-211` 仍 INSERT INTO service_items 含 `sku_id` 列；e2e `smoke-service-lifecycle.mjs:3-8` 明确标注"当前生产 bug，绕过 service.create"。**SUMMARY v3 Top 10 #2** |
> | **P0-05-02** 服务单号前缀 + advisory lock key 分裂（generateOrderNo 跨事务） | 未修复 | **❌ 仍未修复** — `routes/order.js:2473-2495` 仍内嵌独立 `pg.transaction()`。**SUMMARY v3 Top 10 #3** |
> | 其余 P0-05-03 至 P0-05-08 + V2-01/02 | 未修复 | 未复核（与 v3 排期一致，留待下轮）|
>
> 详情见 [SUMMARY v3 §2 Top 10](SUMMARY.md#2-top-10-p0v3--按资损越权严重度排序2026-05-17-重置)。

---

## v1 vs v2 摘要对照

| 问题 ID | v1 编号 | v2 验证 | v3 最终状态 |
|---------|---------|---------|-----------|
| staff.create INSERT sku_id 列不存在 | P0-05-01 | ✅ 真 | P0-05-01（未修复）|
| service_order_id 前缀 + lock key 分裂 | P0-05-02 | ✅ 真 | P0-05-02（未修复）|
| create 事务外校验 TOCTOU | P0-05-03 | ✅ 真 | P0-05-03（未修复）|
| cancel 允许"服务中"状态 | P0-05-04 | ✅ 真 | P0-05-04（未修复）|
| rate=0 静默写 0 提成 | P0-05-05 | ✅ 真 | P0-05-05（未修复）|
| admin complete 不写提成 | P0-05-06 | ✅ 真 | P0-05-06（未修复）|
| 扣次归零关闭预约范围过大 | P0-05-07 | ✅ 真 | P0-05-07（未修复）|
| 提成逻辑跨端不可对齐 | P0-05-08 | ✅ 真 | P0-05-08（重复跨端问题，归并到 P0-05-06）|
| pg.query 吞 rowCount，start/cancel CAS 失效 | — | ⭐ 新 P0 | **P0-V2-01** |
| admin complete items_deducted 不校验 | — | ⭐ 新 P0 | **P0-V2-02** |
| complete 读 sale_items.sales_category live | — | ⭐ 新 P1 | P1-V2-03 |
| admin create 未快照 is_shengmei/sales_category | — | ⭐ 新 P1 | P1-V2-04 |
| deduct CTE 缺 store_id 过滤 | — | ⭐ 新 P2 | P2-V2-22 |

**最终 P0 数量：10**

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/service.ts:15-80`（service_orders / service_items）<br>`db/schema/service-commission.ts:16-62` | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/services.ts:285-582` (start/complete/cancel/create/list/detail) | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:21-827` (create/start/complete/cancel/list/detail/counts) | `fengyu-client/cloudfunctions/clientApi/routes/service.js:1-138` (detail/list 只读) |
| 前端 | `fengyu-admin/src/app/(main)/services/` | `fengyu-staff/miniprogram/pages/service/*` | `fengyu-client/miniprogram/pages/service/*` |
| 测试 | `fengyu-admin/src/actions/services.test.ts`（573行） | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js` | — |

---

## 2. 数据流图

```
staff.create (or admin.createServiceOrder)
  ├─ [事务外] 校验预约/活动服务单/sale_items 次数 ← TOCTOU 窗口 (P0-05-03)
  ├─ generateServiceOrderId()：pg.transaction + advisory_xact_lock (HLD-WX- prefix)
  │   vs admin: hashtext('service_order_id_gen') lock + FY-FW- prefix  ← lock key 不一致 (P0-05-02)
  └─ [事务内] INSERT service_orders + INSERT service_items
       service_items 含 sku_id 列引用 → PG 42703 error (P0-05-01)

staff.start
  └─ pg.query("UPDATE ... WHERE status='待服务'")  ← pg.query 返回 rows[], rowCount=undefined
     result.rowCount === 0 永远为 false → CAS 保护失效 (P0-V2-01)

staff.complete
  └─ pg.transaction:
       ├─ FOR each item: client.query UPDATE sale_items WHERE remaining_sessions >= n AND store_id = so.store_id
       │    updateResult.rowCount === 0 → 抛错（client.query 正确返回 rowCount）✓
       │    + 二次 SELECT remaining_sessions → 若 == 0 关闭预约 (关闭范围含他人 P0-05-07)
       ├─ FOR each item: commission 计算
       │    service_fee, sales_category 读 sale_items live (非 snapshot) ← (P1-V2-03)
       │    rate 查 commission_rate_matrix（N次，per-item）
       │    rate=0 + consumeBase>0 → 写 operation_logs + 仍写 rate=0 提成 (P0-05-05)
       │    INSERT service_commissions ON CONFLICT DO NOTHING (幂等) ✓
       └─ client.query UPDATE service_orders WHERE status='服务中'  ← CAS 正确 ✓
            soUpdateResult.rowCount === 0 → 抛错 ✓
       └─ 关联预约 UPDATE appointments SET status='已完成' ✓

admin.completeServiceOrder
  └─ db.execute(CTE: status_check UPDATE + deduct UPDATE)
       status_updated == 0 → 返回失败 ✓
       items_deducted 计算但从不检查 → deduction 静默失败 (P0-V2-02)
       deduct CTE 无 store_id 过滤 (P2-V2-22)
       commission 写入：无 ← (P0-05-06)

staff.cancel
  └─ pg.query("UPDATE ... WHERE status=$3")  ← pg.query 返回 rows[], rowCount=undefined
     result.rowCount === 0 永远为 false → CAS 保护失效 (P0-V2-01)
```

---

## 3. 自身漏洞

### 3.1 P0（10 个，阻断/资损/越权）

#### [P0-05-01] staff.create INSERT service_items 含不存在列 sku_id，staff 服务单创建 100% 失败

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:207-224`
- **现象**：INSERT 列清单第 5 列为 `sku_id`（line 210），但 `db/schema/service.ts` 的 serviceItems 表定义（line 52-80）无此列。所有 baseline + 增量 migration 均未对 `service_items` 增加 `sku_id`（已验证 0000_baseline.sql:292-303、0008_aspiring_pride.sql、0011_misty_nebula.sql）。
- **风险**：PG 抛 `42703 column "sku_id" of relation "service_items" does not exist`，员工端"护理 Tab → FAB 新建"功能 100% 阻塞，完整扣次链路无法启动。real.md #1 在 staff 端完全失效。
- **修复**：(L3) 删除 service.js:210 INSERT 列清单中的 `sku_id` 及对应 `$5` 占位符（第 5 位），同步删除 line 202 的 `const skuId` 变量引用和 line 217 的 `skuId` 实参；或 (L0) 通过新 migration 对 service_items 增加 `sku_id text REFERENCES product_skus(sku_id)` 并同步 schema.ts。

---

#### [P0-05-02] service_order_id 前缀分裂 + advisory lock key 不同，跨端 create 并发不互斥

- **文件**：`service.js:773-786`（staff `HLD-WX-`，lockKey=Buffer.reduce hash）vs `services.ts:520-536`（admin `FY-FW-`，lockKey=hashtext('service_order_id_gen')）
- **现象**：两端生成 ID 时使用不同 advisory lock key，两端并发 create 无法互斥。当前号段不冲突（前缀不同），但若业务对齐前缀后将直接产生重号（23505 unique violation）；跨端搜索/统计需 OR 两个 LIKE 前缀；real.md 全局规范订单号格式 `FY-XSD-WX-{YYMMDD}NNNN` 两端均未遵守。
- **风险**：服务单号乱序，客服/对账混乱；前缀统一后立刻出现并发重号 P0。
- **修复**：(L3/L7) 统一前缀 `FY-FW-{YYMMDD}NNNN`，advisory lock key 收敛到同一常量（推荐 `hashtext('svc_order_id_gen')`）。

---

#### [P0-05-03] create 关键校验在事务外（TOCTOU），同预约/同顾客可重复创建

- **文件**：`service.js:55-151`
- **现象**：appointment 关联检查（line 63-69）、sale_item 次数检查（line 81-116）、顾客活动服务单检查（line 143-151）均在事务外以 `pg.query` 读，事务（line 169）仅包含 INSERT。两次并发调用可同时通过所有事务外校验并同时 INSERT，产生重复服务单。无 DB unique 约束（appointment_id 无 UNIQUE index，client_user_id+status 无 partial unique）。
- **风险**：重复服务单 → complete 时同一 sale_item 被两次 UPDATE，第一次成功扣次，第二次 CAS 失败（若 P0-V2-01 修复后 rowCount 正确）；但 service_commissions 可能已插入两条（ON CONFLICT DO NOTHING 幂等仅按 service_item_id，两条不同服务单的 service_items 有不同 service_item_id）→ 提成重复入账，资损。
- **修复**：(L0) DB 侧补 partial unique：`CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL;` + `CREATE UNIQUE INDEX uq_so_client_active ON service_orders(client_user_id) WHERE status IN ('待服务','服务中');` (L3) 将所有校验移入 pg.transaction 内。

---

#### [P0-05-04] cancel 允许"服务中"取消，admin 仅允许"待服务"，状态机两端分歧

- **文件**：`service.js:746`（`['待服务','服务中'].includes(so.status)`）vs `services.ts:415-421`（`eq(serviceOrders.status, '待服务')`）
- **现象**：staff 端可取消"服务中"的服务单；admin 端只允许取消"待服务"。两端状态机不一致。当前服务中→取消不会造成次数资损（complete 才扣次），但未来若 start 时即扣次则有资损风险；commission_status 在取消时不置为'已取消'，留 null 残留。
- **风险**：状态机分歧导致跨端查询、报表、历史追溯混乱；未来扩展会产生资损。
- **修复**：(L3) staff cancel 限定仅 `status === '待服务'`，对齐 admin。

---

#### [P0-05-05] rate=0 静默写入 0 提成，无回扫机制，员工绩效永久少计

- **文件**：`service.js:412-449`
- **现象**：commission_rate_matrix 查询无匹配时 rate=0，写 operation_logs 但仍以 rate=0 INSERT service_commissions 并将 commission_status 置 '已分配'。运营补矩阵后无自动回扫；唯一索引 `uq_svc_comm_item_emp_role WHERE is_void=false` 阻止后续重写。
- **风险**：员工提成永久按 0 入账，绩效报表与实际不符，属资损 P0。
- **修复**：(L3) rate=0 且 consumeBase>0 时改为：不写 service_commissions，不置 commission_status='已分配'；仅写 operation_logs；service_orders.commission_status 留 NULL 或置 '待分配'；admin 侧补"补提成"批跑 UI。

---

#### [P0-05-06] admin.completeServiceOrder 完全不写 service_commissions

- **文件**：`fengyu-admin/src/actions/services.ts:334-397`
- **现象**：admin 完成服务单仅 CTE 原子扣减 + 状态推进 + revalidatePath，无任何提成计算/写入逻辑，commission_status 永远不更新。staff.complete 写完整提成 + 置 '已分配'。
- **风险**：admin 后台完成的服务单，员工提成报表永久为 0，与 staff 路径口径完全不一致，资损。
- **修复**：(L7) admin completeServiceOrder 补提成计算逻辑，或抽共享 DB helper 供两端复用。

---

#### [P0-05-07] complete 次数归零关闭预约范围过大，含他人/他店预约

- **文件**：`service.js:377-385`
- **现象**：`remaining_sessions == 0` 后 UPDATE appointments SET status='已关闭' WHERE `sale_item_id = $2 AND status IN ('待确认','已确认')`，未过滤 `client_user_id`。同一张卡（如家庭卡/赠送场景）其他顾客的待确认预约也会被错误关闭。
- **风险**：合法预约被错误关闭，无 cancelled_reason 记录，用户体验事故，状态机边缘崩坏。
- **修复**：(L3) 加 `AND client_user_id = so.client_user_id` + 写 `cancelled_reason='次数耗尽'`。

---

#### [P0-V2-01] `pg.query` 包装器返回 `result.rows`（数组）丢弃 `rowCount`，`start` / `cancel` CAS 保护完全失效

> **全仓穿透 bug，影响 5 处。** 本域只记录 service.js 的 2 处，另 3 处见 §3.4 扩展影响半径。

- **根因文件**：`staffApi/db/pg.js:33-41`

  ```js
  async function query(sql, params = []) {
    const client = await getPool().connect()
    try {
      const result = await client.query(sql, params)
      return result.rows   // ← 仅返回 rows 数组，丢弃 rowCount
    } finally { client.release() }
  }
  ```

- **本域涉及**：
  - `service.js:267-272`（`start`）：`const result = await pg.query("UPDATE ... WHERE status='待服务'")` → `if (result.rowCount === 0)` → `undefined === 0` 为 `false`，CAS 永远不触发。
  - `service.js:751-756`（`cancel`）：同上，`status='服务中' + result.rowCount=0` 时前端显示"已取消"成功但 DB 实际已为'已完成'。

- **对比**：`complete` 函数内的 CAS 均使用 `client.query()`（事务回调中的原始 PG client），正确返回 rowCount，逻辑正确。

- **风险**：
  1. `start` CAS 失效：两次并发 start 均可将服务单推至"服务中"，第二次 UPDATE 影响 0 行但 JS 侧以为成功。
  2. `cancel` CAS 失效：cancel 与 complete 并发时，cancel 的 CAS 无法检测 complete 已先发生，DB status='已完成'，cancel UPDATE 影响 0 行，但 JS 返回 `{status:'已取消'}` → 前端状态机显示"已取消"但 DB 为"已完成"。
  3. 违反 real.md #3（支付幂等等同于重复 cancel 不产生重复效果）、#4（状态单向推进保护机制失效）。

- **全仓影响范围**（grep 实证）：

  | 文件 | 行 | 操作 | pg.query 调用上下文 | 风险 |
  |------|----|------|---------------------|------|
  | `routes/service.js` | 271 | `start` CAS UPDATE | `pg.query` 非事务 | 本域 P0 |
  | `routes/service.js` | 755 | `cancel` CAS UPDATE | `pg.query` 非事务 | 本域 P0 |
  | `routes/customer.js` | 928 | 顾客分配 UPDATE | `pg.query` 非事务 | 分配不幂等 |
  | `routes/customer.js` | 987 | 顾客备注 UPDATE | `pg.query` 非事务 | 备注更新不幂等 |
  | `routes/appointment.js` | 209 | 预约确认 UPDATE | `pg.query` 非事务 | 确认不幂等 |

  **注**：`order.js` 内所有 `.rowCount` 检查均包裹在 `pg.transaction(callback)` 内使用 `client.query()` — 这些不受影响。

- **修复**：(L3)
  - 方案 A（推荐）：在 `staffApi/db/pg.js` 增加 `queryWithCount(sql, params)` 返回 `{ rows, rowCount }`，调用方改为 `const { rows, rowCount } = await pg.queryWithCount(...)`。
  - 方案 B：将上述 5 处 UPDATE 移入 `pg.transaction()` 内使用 `client.query()`。
  - 方案 C（激进）：修改 `pg.query()` 直接返回完整 `result` 对象（破坏性变更，需全仓回归）。

---

#### [P0-V2-02] `admin.completeServiceOrder` 不校验 `items_deducted`，次数扣减静默失败但服务单变"已完成"

- **文件**：`fengyu-admin/src/actions/services.ts:360-397`
- **现象**：admin 使用 CTE 原子完成：
  ```sql
  WITH status_check AS (
    UPDATE service_orders SET status='已完成', completed_at=NOW()
    WHERE service_order_id=$1 AND status='服务中' RETURNING service_order_id
  ),
  deduct AS (
    UPDATE sale_items SET remaining_sessions = remaining_sessions - si.session_used
    FROM service_items si
    WHERE sale_items.sale_item_id = si.sale_item_id
      AND si.service_order_id = $1
      AND sale_items.remaining_sessions >= si.session_used
      AND EXISTS (SELECT 1 FROM status_check)
    RETURNING sale_items.sale_item_id
  )
  SELECT
    (SELECT COUNT(*) FROM status_check) AS status_updated,
    (SELECT COUNT(*) FROM deduct) AS items_deducted
  ```
  JS 侧（line 386-388）：
  ```ts
  if (!row || Number(row.status_updated) === 0) {
    return { success: false, message: '服务单状态已变更，无法完成' }
  }
  ```
  `items_deducted` 被 SELECT 出来但**从未被检查**。若 `deduct` CTE 因 `remaining_sessions < session_used` 匹配 0 行，`status_check` 仍成功提交（服务单状态已变为"已完成"），但 `sale_items.remaining_sessions` **未扣减**。

- **风险**：
  1. 服务单标记"已完成"但次数未扣，违反 real.md #1（次数防超卖）。
  2. 并发 admin.complete + staff.complete 竞争时，若 admin 先赢：status_check 成功，deduct 因 remaining_sessions 已被抢先扣减而影响 0 行 → `items_deducted=0`，次数未扣，日志返回成功 ← **数据不一致 bug**。
  3. 此场景可被人为触发（同一服务单同时发起 admin 和 staff complete），"单扣次 vs 零扣次"结果完全取决于竞争顺序。

- **修复**：(L7)
  ```ts
  const row = (result as any[])[0]
  if (!row || Number(row.status_updated) === 0) {
    return { success: false, message: '服务单状态已变更，无法完成' }
  }
  // 新增：检查扣次是否完整
  const itemsDeducted = Number(row.items_deducted)
  const expectedItems = /* SELECT COUNT(*) FROM service_items WHERE service_order_id=$1 */
  if (itemsDeducted < expectedItems) {
    await logOperation(session, 'service.complete.deduct_partial', ...)
    return { success: false, message: '次数扣减失败，请检查剩余次数后重试' }
  }
  ```
  根本修复：CTE 内加 CHECK，或改为显式事务 per-item 原子 UPDATE + rowCount 检查（与 staff 路径一致）。

---

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-05-09] ✅ v1 已记 — is_shengmei/sales_category/unit_real_price 退款后快照未回写

#### [P1-05-10] ✅ v1 已记 — staff.list 缺 buildStoreScopeCondition，管理层模式服务单空白

#### [P1-05-11] ✅ v1 已记 — complete 提成计算 N+1 查询（per-item rate SELECT in transaction）

#### [P1-05-12] ✅ v1 已记 — client.service.detail 暴露 assigned_employee_id（内部 PK）

#### [P1-05-13] ✅ v1 已记 — client.service.list 不过滤已取消服务单（也含 detail：无 status 条件）

#### [P1-05-14] ✅ v1 已记 — generateServiceOrderId 用 toISOString().slice(2,10) UTC，跨午夜号段错乱

#### [P1-05-15] ✅ v1 已记 — generateServiceItemId 用 Math.random()，有碰撞概率

#### [P1-05-16] ✅ v1 已记 — start 无幂等分支，网络抖动重试立即抛错（P0-V2-01 修复后此问题更严重：双次请求均返回成功）

#### [P1-V2-03] `complete` 提成计算读 `sale_items.sales_category`（live）而非 `service_items.sales_category`（snapshot），快照设计形同虚设

- **文件**：`service.js:326-335`
- **现象**：complete 的联查：
  ```sql
  SELECT sit.service_item_id, sit.sale_item_id, sit.session_used, sit.employee_id,
         sit.unit_real_price,             -- ← 从 service_items snapshot 读（正确）
         si.service_fee, si.sales_category -- ← 从 sale_items live 读（错误！）
  FROM service_items sit
  JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
  ```
  create 时正确地将 `sale_items.sales_category` 拷贝到 `service_items.sales_category`，但 complete 时跳过 snapshot，直接取 live 值。同理 `si.service_fee` 也是 live 读（service_items 表无 service_fee 快照列）。
- **风险**：退款/订单修正后，提成计算使用新 sales_category，与快照语义不符。
- **修复**：(L3) 改查询为 `sit.sales_category`；(L0) 补 schema migration 为 service_items 增加 `service_fee` 快照列。

#### [P1-V2-04] `admin.createServiceOrder` 未快照 `is_shengmei` / `sales_category`

- **文件**：`fengyu-admin/src/actions/services.ts:551-563`
- **现象**：admin create 只传 `unitRealPrice`，未传 `isShengmei` / `salesCategory`：
  ```ts
  await tx.insert(serviceItems).values({
    serviceItemId, serviceOrderId: id,
    saleItemId: item.saleItemId,
    sessionUsed: item.sessionUsed,
    unitRealPrice: snapshot.unitRealPrice || '0',
    employeeId: data.assignedEmployeeId,
    // isShengmei 缺失 → DB DEFAULT NULL
    // salesCategory 缺失 → DB DEFAULT NULL
  })
  ```
- **风险**：
  1. `is_shengmei` NULL → admin 创建的服务单"是否生美项目"统计报表出错。
  2. 若未来修复 P1-V2-03（complete 改用 `sit.sales_category`），admin 创建的服务单在 complete 时取到 NULL → 无 rate 匹配 → rate=0 → P0-05-05 再次触发。
- **修复**：(L7) admin createServiceOrder 在事务内为每个 item 查 `sale_items.is_shengmei, sale_items.sales_category`，写入 serviceItems.values。

---

### 3.3 P2（代码质量 / 可维护）

#### [P2-05-17] ✅ v1 已记 — 错误前缀滥用 INVALID_PARAMS，状态相关/资源类错误应细分

#### [P2-05-18] ✅ v1 已记 — complete 内 SELECT remaining_sessions 二次查询冗余，可改 RETURNING

#### [P2-05-19] ✅ v1 已记 — list 顾客名兜底从 sale_orders 取（v3.1 后死代码）

#### [P2-05-20] ✅ v1 已记 — operation_logs source='staffApi' 命名不规范

#### [P2-05-21] ✅ v1 已记 — start/complete/cancel detail 查询用 SELECT *

#### [P2-V2-22] `admin.completeServiceOrder` 的 `deduct` CTE 缺 `sale_items.store_id` 过滤

- **文件**：`services.ts:367-376`
- **现象**：staff complete（line 347-351）明确加 `AND store_id = $3`（服务单所属门店），防止跨店核销。admin complete 的 deduct CTE 无此约束。
- **风险**：理论上若 service_items 中存在跨店 sale_item 引用，admin complete 可在不同门店的 sale_item 上扣次。属 P2 低风险。
- **修复**：(L7) deduct CTE 增加 `AND sale_items.store_id = (SELECT store_id FROM service_orders WHERE service_order_id = $1)`。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| service_order_id 前缀 | `FY-FW-` | `HLD-WX-` | 不生成 | 号段分裂，无法跨端搜索 | P0 |
| advisory lock key | `hashtext('service_order_id_gen')` | `Buffer.reduce` 私有 hash | — | 并发 create 不互斥 | P0 |
| service_items.sku_id INSERT | 不写（schema 无） | **写**（PG 报列不存在） | — | staff create 100% 失败 | P0 |
| service_items 快照完整性 | `unitRealPrice` only；`is_shengmei`/`salesCategory` 缺失 | `unitRealPrice`/`is_shengmei`/`salesCategory` 均写 | — | admin 创建的 items 快照不完整 | P1 |
| commission 写入 | 无 | 有（per-item） | — | admin 完成路径无提成 | P0 |
| complete 读 sales_category | 不涉及 | live（si.sales_category）非 snapshot | — | 快照机制被绕过 | P1 |
| CAS UPDATE rowCount 检查 | 正确（CTE COUNT 检查 status_updated）| start/cancel 失效（pg.query 包装器吞 rowCount） | — | 并发状态机保护失效 | P0 |
| cancel 允许状态范围 | 仅"待服务" | 待服务+服务中 | — | 状态机分歧 | P1 |
| deduct 无 store_id 过滤 | 无过滤 | 有过滤 | — | admin 理论跨店核销 | P2 |
| 服务记录可见状态 | 全部 | store 内 | 全部含已取消 | client 看到无意义已取消 | P1 |
| serviceItemId 生成 | `${orderId}-${idx}` | `Math.random()` | — | staff 端理论碰撞 | P1 |
| 时区基准 | PG `to_char(NOW())` | UTC `toISOString()` | — | 跨午夜号段错乱 | P1 |

---

## 5. 横切检查（§3 CC 清单）

- [x] **CC1 数值精度**：
  - NUMERIC(10,2) 列定义合规（service_commissions.commission_amount 等）。
  - `Math.round(x * 100) / 100` 在提成计算中正确使用。
  - `remaining_sessions` 是 integer 类型，`pg` 库返回 JS number，`=== 0` 比较正确。
  - **CC1 OK**。

- [ ] **CC2 并发幂等**：
  - `start` CAS 完全失效（P0-V2-01）← 全仓 2 处（本域 service.js）+ 3 处（customer.js ×2, appointment.js ×1）
  - `cancel` CAS 完全失效（P0-V2-01）
  - `create` 事务外校验 TOCTOU（P0-05-03）
  - admin/staff lock key 不同（P0-05-02）
  - `complete` CAS 正确（`client.query()` 返回 rowCount）
  - admin `completeServiceOrder` deduct 无 rowCount 校验（P0-V2-02）
  - `generateServiceOrderId` UTC 时区（P1-05-14）

- [ ] **CC3 组织隔离**：
  - `staff.list/detail/counts` 仅用 `effectiveStoreId = $1`，管理层模式下为 null → 查不到任何记录（P1-05-10）
  - `client.service.list` 仅用 `client_user_id = $1` 过滤，无 status 过滤（P1-05-13）
  - `admin.completeServiceOrder` deduct 无 store_id 过滤（P2-V2-22）

- [x] **CC4 后端鉴权**：
  - 所有 staff 路由入口调用 `requireStaffBound()`（line 22、239、287、481、611、723）✓
  - `start/complete/cancel` 额外校验 `assigned_employee_id` 或 `roles.includes('manager')` ✓
  - admin 路由使用 `requirePermission(session, 'service:...')` + `scopeCondition` ✓
  - client 路由通过 ctx.auth.userId 隔离 ✓
  - **CC4 OK**（未发现未鉴权路由）。

- [ ] **CC5 错误码**：
  - `service.js:367`：`throw new Error('次数不足：...')` 无任何标准前缀，直接中文。
  - `service.js:103,107,111,114,150,263,321,360,458` 等多处 `INVALID_PARAMS:` 用于状态机失败（应区分）。
  - **CC5 P2**（与 v1 P2-05-17 一致）。

- [ ] **CC6 PII**：
  - `client.service.detail` 返回 `assigned_employee_id`（内部 PK），见 P1-05-12。
  - `client.service.list` 返回 `assigned_employee_id` 和 `employee_name`。
  - **CC6 P1**。

- [ ] **CC7 时间字段**：
  - `started_at`/`completed_at` 由对应 action 写入，责任清晰 ✓。
  - `generateServiceOrderId` 用 `new Date().toISOString().slice(2,10)` UTC 时区，跨午夜漂移（P1-05-14）。
  - `created_at/updated_at` DB DEFAULT 写入 ✓。
  - `service_commission.ts:47-48`：`voidedAt / voidedReason` 新字段（2026-04-26）未在 staff complete 的 commission 写入中体现。
  - **CC7 P1**（时区问题）。

- [ ] **CC8 WXML/Vant**：未深入前端验证，继承 v1 结论。

- [ ] **CC9 测试与残留**：
  - `service.test.js` 的 create 测试用 mock transaction，不检查 INSERT 列清单是否含非法 sku_id，P0-05-01 仍是测试盲区。
  - `services.test.ts` 的 completeServiceOrder 测试（line 259-298）不覆盖 `items_deducted=0 && status_updated=1` 场景（P0-V2-02 测试盲区）。
  - `service.js:578-589`：list 中顾客名从 `sale_orders.customer_name` 兜底取，v3.1 后已是死代码（P2-05-19）。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| **L0 schema/migrations** | 新 migration | 补 `service_items.service_fee` 快照列 | P1-V2-03 |
| **L0 schema/migrations** | 新 migration | `CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL` | P0-05-03 |
| **L0 schema/migrations** | 新 migration | `CREATE UNIQUE INDEX uq_so_client_active ON service_orders(client_user_id) WHERE status IN ('待服务','服务中')` | P0-05-03 |
| **L3 staff db/pg.js** | `staffApi/db/pg.js` | 增加 `queryWithCount(sql,params)` 返回 `{rows, rowCount}` 的方法；或修改 `query()` 返回完整 result（破坏性，需全仓回归） | **P0-V2-01（根因）** |
| **L3 staff routes** | `service.js:267-272` | 改 `start` UPDATE 为 `pg.queryWithCount(...)` 或移入 transaction 内 `client.query()` | P0-V2-01 |
| **L3 staff routes** | `service.js:751-756` | 改 `cancel` UPDATE 同上 | P0-V2-01 |
| **L3 staff routes** | `service.js:928`（customer.js）| 改 `customer.assign` UPDATE → 同上 | P0-V2-01 扩展 |
| **L3 staff routes** | `service.js:987`（customer.js）| 改 `customer.updateNotes` UPDATE → 同上 | P0-V2-01 扩展 |
| **L3 staff routes** | `service.js:209`（appointment.js）| 改 `appointment.confirm` UPDATE → 同上 | P0-V2-01 扩展 |
| **L3 staff routes** | `service.js:207-224` | 删除 sku_id 列引用及 $5 占位符 | P0-05-01 |
| **L3 staff routes** | `service.js:55-151` | 将 appointment/saleItem/activeSo 校验整体移入 pg.transaction | P0-05-03 |
| **L3 staff routes** | `service.js:746` | cancel 允许状态改为仅 `['待服务']` | P0-05-04 |
| **L3 staff routes** | `service.js:377-385` | 关闭预约加 `AND client_user_id = so.client_user_id` + `cancelled_reason` | P0-05-07 |
| **L3 staff routes** | `service.js:329` | `si.sales_category` 改 `sit.sales_category` | P1-V2-03 |
| **L3 staff routes** | `service.js:329` | 增加 `sit.service_fee`（需先 L0 补列） | P1-V2-03 |
| **L3 staff routes** | `service.js:480-518,619-636,801-816` | 接入 buildStoreScopeCondition | P1-05-10 |
| **L3 staff routes** | `service.js:266-273` | start 加幂等分支（status==='服务中' 直接返回成功） | P1-05-16 |
| **L3 staff routes** | `service.js:769-770` | dateStr 改 PG 时区 `to_char(NOW() AT TIME ZONE 'Asia/Shanghai', 'YYMMDD')` | P1-05-14 |
| **L3 staff routes** | `service.js:792-794` | serviceItemId 改 `${orderId}-${idx}` 模式 | P1-05-15 |
| **L3 client routes** | `clientApi/routes/service.js:83-101` | list 加 `AND so.status != '已取消'`；detail 同步校验 | P1-05-13 |
| **L3 client routes** | `clientApi/routes/service.js:23-65` | detail/list 不返回 employee_id | P1-05-12 |
| **L7 admin actions** | `services.ts:386-388` | completeServiceOrder 增加 `items_deducted` 校验；改为显式事务 per-item 原子 UPDATE 与 staff 对齐 | P0-V2-02 |
| **L7 admin actions** | `services.ts:551-563` | createServiceOrder 补快照 is_shengmei / sales_category / service_fee | P1-V2-04 |
| **L7 admin actions** | `services.ts:333-397` | completeServiceOrder 补提成计算（或调共享 helper） | P0-05-06 |
| **L7 admin actions** | `services.ts:520-536` | 前缀对齐 staff（或反之），lock key 收敛至同一常量 | P0-05-02 |
| **L7 admin actions** | `services.ts:368-376` | deduct CTE 增加 store_id 过滤 | P2-V2-22 |
| **L9 staff frontend** | `pages/service/*` | "开始服务"按钮增加 loading 状态防重 | P1-05-16 |

---

## 7. 验证 SQL（在 5434/fengyu EXPLAIN，禁止写入）

```sql
-- (V2-1) 确认 service_items 确无 sku_id 列（P0-05-01 实证）
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='service_items'
  AND column_name='sku_id';
-- 预期：0 行

-- (V2-2) 确认 service_items 的 is_shengmei / sales_category 列存在（migration 0008/0011）
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='service_items'
  AND column_name IN ('is_shengmei','sales_category');
-- 预期：2 行

-- (V2-3) 检查 service_items.sales_category 是否有 NULL（admin 创建路径遗留，P1-V2-04 实证）
SELECT COUNT(*) AS null_count
FROM service_items
WHERE sales_category IS NULL;

-- (V2-4) 检查 service_items.is_shengmei 是否有 NULL（admin 创建路径遗留，P1-V2-04 实证）
SELECT COUNT(*) AS null_count
FROM service_items
WHERE is_shengmei IS NULL;

-- (V2-5) 服务单 ID 前缀分布（P0-05-02 实证）
SELECT
  CASE
    WHEN service_order_id LIKE 'HLD-WX-%' THEN 'HLD-WX (staff)'
    WHEN service_order_id LIKE 'FY-FW-%'  THEN 'FY-FW (admin)'
    ELSE 'OTHER'
  END AS prefix,
  COUNT(*)
FROM service_orders
GROUP BY 1;

-- (V2-6) 检查 appointment_id 是否有重复关联（TOCTOU 产物，P0-05-03 实证）
SELECT appointment_id, COUNT(*)
FROM service_orders WHERE appointment_id IS NOT NULL
GROUP BY appointment_id HAVING COUNT(*) > 1;

-- (V2-7) 检查同顾客多条进行中服务单（TOCTOU 产物，P0-05-03 实证）
SELECT client_user_id, COUNT(*)
FROM service_orders WHERE status IN ('待服务','服务中')
GROUP BY client_user_id HAVING COUNT(*) > 1;

-- (V2-8) 检查 admin 完成服务单 commission_status 分布（P0-05-06 + P0-V2-02）
SELECT
  CASE WHEN commission_status IS NULL THEN 'admin路径(无commission)' ELSE commission_status END AS path,
  COUNT(*)
FROM service_orders
WHERE status = '已完成'
GROUP BY 1;

-- (V2-9) 检查已完成服务单中 commission_rate=0 但 consume_amount>0 的提成行（P0-05-05 实证）
SELECT COUNT(*) AS zero_rate_with_consume
FROM service_commissions
WHERE commission_rate = 0 AND consume_amount > 0 AND is_void = false;

-- (V2-10) 确认 service_commissions 唯一索引定义（P0-05-05 幂等保障验证）
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'service_commissions'
  AND indexname = 'uq_svc_comm_item_emp_role';

-- (V2-11) 检查 sale_item 次数为 0 但仍有 '已确认'/'待确认' 预约（P0-05-07 产物）
SELECT a.appointment_id, a.client_user_id, a.sale_item_id, a.status, si.remaining_sessions
FROM appointments a
JOIN sale_items si ON si.sale_item_id = a.sale_item_id
WHERE a.status IN ('待确认','已确认')
  AND si.remaining_sessions IS NOT NULL
  AND si.remaining_sessions = 0;

-- (V2-12) 检查 admin 完成但 items_deducted 可能为 0 的历史服务单（P0-V2-02 实证，需补充）
-- 当前 admin 实现无法从 DB 直接区分"部分扣次成功"与"完全扣次成功"，
-- 需通过 service_items.session_used vs sale_items.remaining_sessions 变化量回推。
SELECT so.service_order_id, so.status, so.completed_at,
  (SELECT COUNT(*) FROM service_items si WHERE si.service_order_id = so.service_order_id) AS total_items,
  COALESCE(sc.completed_count, 0) AS deducted_items
FROM service_orders so
LEFT JOIN (
  SELECT service_order_id, COUNT(*) AS completed_count
  FROM service_commissions WHERE is_void = false
  GROUP BY service_order_id
) sc ON sc.service_order_id = so.service_order_id
WHERE so.status = '已完成'
  AND so.completed_at > '2026-04-10'
  AND (SELECT COUNT(*) FROM service_items si WHERE si.service_order_id = so.service_order_id)
      > COALESCE(sc.completed_count, 0);
```

---

## 8. 回归测试用例（建议）

1. **P0-05-01** `service.create` sku_id 列不存在：在本地 5434 执行 `INSERT INTO service_items (service_item_id, sale_item_id, service_order_id, session_used, employee_id, sku_id) VALUES (...)` 确认 PG 42703；写集成测试 mock pg.transaction 后断言 client.query 被调用参数中不含 `sku_id`。

2. **P0-05-02** advisory lock key 不同：grep 两端 lock key 表达式，断言不一致。

3. **P0-05-03** TOCTOU：Promise.all 5 次并发 staff.create 同 appointmentId，断言 DB 仅 1 条 service_orders；再断言 partial unique 索引存在。

4. **P0-05-04** cancel 状态范围：staff cancel 一条 '服务中' 的服务单，断言成功；admin cancel 同一 '服务中' 服务单，断言失败。

5. **P0-05-05** rate=0 路径：清空 commission_rate_matrix 后执行 staff.complete，断言 service_commissions 中无新写入行（commission_status 应留 null/待分配）；断言 operation_logs 有 'rate_missing' 记录。

6. **P0-V2-01** pg.query 包装器吞 rowCount（全仓 5 处）：
   - 单元测试：模拟 pg.query("UPDATE") 返回 `[]`，`cancel(ctx)` 不抛错 → 确认 bug 存在
   - 修复后：模拟 pg.queryWithCount 返回 `{ rows:[], rowCount:0 }`，`cancel(ctx)` 应抛错
   - 同步验证 customer.assign、customer.updateNotes、appointment.confirm 的 CAS UPDATE

7. **P0-V2-02** admin complete items_deducted 不检查：
   - 模拟 `db.execute` 返回 `[{ status_updated: '1', items_deducted: '0' }]`
   - 当前行为：返回 success:true（bug）
   - 修复后：返回 success:false（预期）

8. **P1-V2-03** sales_category snapshot vs live：
   - 创建服务单时 sale_items.sales_category='自销自耗'
   - 更新 sale_items.sales_category='他销自耗'
   - staff.complete 后断言 service_commissions.role_type 对应的 commission_rate 来自 '自销自耗' 矩阵（snapshot）

9. **P1-V2-04** admin create 快照完整性：admin createServiceOrder 后查 service_items，断言 `is_shengmei IS NOT NULL` 且 `sales_category IS NOT NULL`（修复后）。

10. **P0-05-06** admin complete 不写提成：admin completeServiceOrder 后查 service_commissions，断言 count > 0（修复后）。

---

## 9. 影响半径

- **单端**：☐
- **跨端（任意 2 端）**：☐
- **全栈（3 端 + DB）**：☑
- **涉及历史数据**：☑（P0-05-05 历史 rate=0 提成需回扫；P0-05-06 admin 路径完成的服务单需补提成；P0-05-07 需回扫被错误关闭的预约；P0-V2-02 需检查 admin 完成但 items_deducted=0 的历史服务单；P1-V2-04 需更新 admin 创建的 NULL 快照字段）
- **修复成本**：**XL**（8 个 v1 P0 + 2 个 v2 P0 + 4 个 v2 P1/P2，跨端协调，含 schema 变更 + pg.js 根因修复）

### P0-V2-01 全仓穿透影响明细

| 文件 | 行 | 方法 | 现状 | 修复后 |
|------|----|------|------|--------|
| `staffApi/routes/service.js` | 271 | `start` CAS UPDATE | `result.rowCount` → `undefined` | 正确判断 0 行 |
| `staffApi/routes/service.js` | 755 | `cancel` CAS UPDATE | `result.rowCount` → `undefined` | 正确判断 0 行 |
| `staffApi/routes/customer.js` | 928 | `assign` UPDATE | `result.rowCount` → `undefined` | 正确判断 0 行 |
| `staffApi/routes/customer.js` | 987 | `updateNotes` UPDATE | `result.rowCount` → `undefined` | 正确判断 0 行 |
| `staffApi/routes/appointment.js` | 209 | `confirm` UPDATE | `result.rowCount` → `undefined` | 正确判断 0 行 |

**注**：`order.js` 内所有 `.rowCount` 检查均使用 `client.query()`（在 `pg.transaction` 内），不受此 bug 影响。

---

## 10. 后续待办

- [ ] **最高优先** 修复 `staffApi/db/pg.js` 包装器增加 `queryWithCount` 返回 `{rows, rowCount}`（P0-V2-01 根因修复），随后逐处修改上述 5 处调用点
- [ ] **最高优先** admin completeServiceOrder 补 `items_deducted` 检查（P0-V2-02），并统一与 staff 的扣次保护策略
- [ ] 与域 06 确认：service.create 关联预约的 partial unique 建立后，domain 06 的 appointment → service 流转是否受影响
- [ ] 与域 07/08 提成域确认：rate=0 处理策略（P0-05-05 选项 B/C），及 service_commissions.voided_at/voided_reason 新字段联动
- [ ] 与域 11 退款确认：退款后 sale_items.sales_category 是否变更（若变更则影响 P1-V2-03 快照漂移范围）
- [ ] schema 新 migration：为 service_items 补 `service_fee` 快照列（P1-V2-03）；补 appointment_id partial unique（P0-05-03）；补 client_user_id+status partial unique（P0-05-03）
- [ ] admin 历史数据修复：更新 admin 创建的 service_items.is_shengmei=NULL 和 sales_category=NULL 行（P1-V2-04）
- [ ] admin 历史数据修复：检查 status='已完成' 且 commission_status IS NULL 的服务单，补足 service_commissions（P0-05-06）
- [ ] 全仓回归：P0-V2-01 修复后，对 customer.assign、customer.updateNotes、appointment.confirm 进行并发幂等测试
