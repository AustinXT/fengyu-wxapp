# 审计报告：家居产品提货 (20)

**审计时间**：2026-04-26
**域 ID**：20
**审计员**：claude-sonnet-4-6
**审计时长**：~30 分钟（重新独立审计）
**关联 PR/Ticket**：—

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/pickup.ts:14-42` (pickup_records 主表)<br>`db/schema/order.ts:171-172` (sale_items.pickedUpQuantity)<br>`db/schema/enums.ts:26` (itemDirectionEnum) | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/pickup-records.ts:57-365`<br>`getPickupRecordsPaginated` / `getPickupRecordById` / `getAvailablePickupItems` / `createPickupRecord` | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2416-2483` (`createPickup`) | **完全无 client 端入口**（clientApi 0 路由） |
| 前端 | `fengyu-admin/src/app/(main)/pickup-records/page.tsx`<br>`_components/pickup-records-page.tsx`<br>`create/page.tsx`<br>`_components/pickup-record-create-page.tsx` | 无独立提货页面（仅 staffApi 路由） | — |
| 权限 | `fengyu-admin/src/lib/permissions.ts:51,65`<br>manager: list+create; finance: list only | `requireStaffBound()` — 任何已绑手机员工均可调用 | — |
| 退款级联 cascade | `fengyu-admin/src/lib/refund-cascade.ts:178-199`<br>通道 5：按 sessionCount（默认 1）反向恢复 | `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js:135-149`<br>通道 5：**仅在 saleItemId 且 sessionCount > 0 时触发** | — |
| 测试 | 0 个 vitest spec（`pickup-records.ts` 无单测） | `__tests__/routes/order.test.js` 约 8 个用例（含 cascade 通道 5） | — |

---

## 2. 数据流图

```
=== 正向提货路径 ===

[admin] createPickupRecord(saleItemId, qty, storeId, clientUserId)
  ├─ requirePermission('pickup_record:create')          # P: manager 角色
  ├─ isInScope(session, storeId)                        # 提货门店在 scope 内
  ├─ 基础参数校验（isInteger && >0，storeId 非空）
  ├─ db.transaction(tx)
  │   ├─ UPDATE sale_items
  │   │     SET picked_up_quantity = COALESCE(picked_up_quantity,0) + $qty
  │   │   WHERE sale_item_id = $1
  │   │     AND product_type = '家居产品'
  │   │     AND item_direction = '购买'                # ✅ 明确守卫
  │   │     AND (COALESCE(picked_up_quantity,0) + $qty) <= quantity  # ✅ CAS
  │   │   RETURNING ...
  │   │   → rowCount=0 → throw OVER_QUANTITY → rollback
  │   └─ INSERT INTO pickup_records (...)
  └─ logOperation('create', 'pickup_record', ...)       # ✅ 审计

[staff] createPickup(saleItemId, pickupQuantity, remark)
  ├─ requireStaffBound()                                # ⚠ 非 requireManager()
  ├─ pg.query(UPDATE sale_items ...)                    # 注意：返回 rows 数组
  │     AND store_id = $3 (= effectiveStoreId)
  │     AND product_type = '家居产品'
  │     AND (COALESCE(picked_up_quantity,0) + $1) <= quantity
  │   ← 缺 item_direction='购买' 守卫                  # ⚠ P0-20-02
  ├─ if (result.rowCount === 0) ...                     # ⚠ result 是 rows 数组，rowCount=undefined，永为 false
  │     → 错误分支死代码                               # ⚠ P0-20-03（新发现）
  ├─ pg.query(SELECT client_user_id ...)                # 事务外独立连接
  └─ pg.query(INSERT INTO pickup_records ...)           # 事务外独立连接
     → UPDATE 成功 + INSERT 失败 = picked_up 增加但记录缺失  # ⚠ P1-20-01

=== 退款 cascade 路径 ===

[admin] approveRefund() → cascadeRefund(tx, { saleOrderId, saleItemId, sessionCount })
  └─ 通道 5（refund-cascade.ts:183）：
       qty = sessionCount ?? 1               # sessionCount=null 时默认 1
       UPDATE sale_items SET picked_up_quantity = GREATEST(0, picked_up_quantity - qty)
       → 家居产品 session_count 在 sale_items 是 NULL
       → 退 1 件家居，已提 3 件，只回退 qty=1（非退款数量）→ 数值漂移  # ⚠ P1-20-09（新）

[staff] approveRefund() → cascadeRefund(client, { saleOrderId, saleItemId, sessionCount })
  └─ 通道 5（refund-cascade.js:138）：
       if (saleItemId && sessionCount && sessionCount > 0)   # sessionCount=null → 条件假
       → 家居产品退款时通道 5 **完全跳过**              # ⚠ P0-20-01 确认
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### P0-20-01 staff 退款 cascade 通道 5 对家居产品完全跳过，导致退款后仍可超额提货

- **文件**：`fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js:135-149`
- **现象**：通道 5 判断条件为 `if (saleItemId && sessionCount && Number(sessionCount) > 0)`。家居产品的 `sale_items.session_count` 是 `NULL`（代码注释 `order.js:606-607` 明确"家居产品无 session_count"），故 `sessionCount = sopRow.session_count = NULL`，条件永远为假。staff 端退款审批通过后，`picked_up_quantity` **从不被冲销**。
- **对比**：admin `refund-cascade.ts:183` 用 `const qty = sessionCount && sessionCount > 0 ? sessionCount : 1`，sessionCount=null 时默认 qty=1，**每次至少回退 1 件**，但这同样有缺陷（见 P1-20-09）。
- **风险**：双消费资损（real.md §1 次数防超卖违反）。攻击路径：
  1. 顾客买 5 件家居产品，paid→picked_up=0
  2. 店长通过 staff `createRefund` 申请全额退款（待审批）
  3. 审批前员工 `createPickup(qty=2)` → CAS 成功（5-0≥2）→ picked_up=2
  4. 店长 `approveRefund` → cascade 通道 5 跳过（sessionCount=null）→ picked_up 仍=2
  5. 顾客拿到 5 件全额退款金额 + 已提走 2 件实物 → 资损 2×unit_real_price
- **复现**：1) 创建家居产品已支付订单 quantity=5；2) staff createPickup qty=2；3) staff createRefund 全量退款；4) staff approveRefund；5) 验证 sale_items.picked_up_quantity=2 但退款已通过。
- **修复**：（L3 staff helpers/refund-cascade.js:135-149）条件改为：
  ```js
  if (saleItemId) {
    // 从 sale_items 读真实 picked_up_quantity，按实际已提数量全量冲销，不依赖 sessionCount
    const pickRes = await client.query(
      `UPDATE sale_items
          SET picked_up_quantity = 0, updated_at = $1
        WHERE sale_item_id = $2
          AND product_type = '家居产品'
          AND COALESCE(picked_up_quantity, 0) > 0`,
      [now, saleItemId]
    )
    rolledBackPickups = pickRes.rowCount || 0
  }
  ```

---

#### P0-20-02 staff `createPickup` 缺 `item_direction='购买'` 守卫，退出/转出行可被误提货

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2431-2437`
- **现象**：UPDATE WHERE 子句仅包含 `product_type='家居产品'`，**未约束 `item_direction='购买'`**。退款行（`退出`）、转换行（`转出`）的 sale_items 同样可能有 `product_type='家居产品'` 且 `picked_up_quantity` 默认 0，CAS 条件可通过。
- **对比**：admin `createPickupRecord` UPDATE WHERE 已显式加 `AND item_direction = '购买'`（`pickup-records.ts:317`）。
- **风险**：越权操作退出/转出行，状态机崩坏；退款行被二次提货语义混乱。
- **复现**：1) 为家居产品创建退款单（`退出` 行 quantity=5 picked=0）；2) staff createPickup 传退出行的 saleItemId，qty=1；3) 若退出行满足 CAS 条件，UPDATE 命中。
- **修复**：（L3）在 UPDATE WHERE 加 `AND item_direction = '购买'`；probe SELECT 同步加过滤：
  ```sql
  AND item_direction = '购买'
  ```

---

#### P0-20-03 staff `createPickup` 超量防护失效——`result.rowCount` 永远是 `undefined`

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2430-2457`，`db/pg.js:33-41`
- **现象**：`pg.query()` 包装器返回的是 `result.rows`（数组），不含 `.rowCount` 属性（`pg.js:37`）。但 `createPickup` 在第 2441 行判断 `if (result.rowCount === 0)` — 由于 `result` 是数组，`result.rowCount` 为 `undefined`，条件永远为 `false`。
  - 若 UPDATE 成功（CAS 命中）：`result` = 1-row 数组 → `result[0]` 有数据 → 功能正常
  - 若 UPDATE 失败（CAS 未命中）：`result` = 空数组 → `result.rowCount === 0` 为 false → **错误分支不触发** → 后续 `result[0]` 为 `undefined` → `updated.picked_up_quantity` 抛 TypeError（或更糟：若 `result.rows` 被访问）
  - **实际效果**：CAS 失败时函数不会返回友好错误消息，而是抛出 `TypeError: Cannot read properties of undefined`，变成内部错误而非业务错误。防超提的应用层错误诊断逻辑完全失效（虽然 CAS 本身仍生效，不会真正超提）。
- **对比**：事务内的 `client.query` 返回原始 PG result（带 `.rowCount`），正确使用见 `order.js:1568`。
- **风险**：CAS 防超提的 DB 层仍有效（WHERE 条件兜底），但错误路径抛出不可预期异常，掩盖真实错误原因；同时影响错误码规范（CC5）。
- **修复**：（L3）改用事务或从数组长度判断：
  ```js
  // 方式 1：改用 pg.transaction
  const rows = await tx.query(`UPDATE ... RETURNING ...`, [...])
  if (rows.rowCount === 0) { ... }

  // 方式 2（最小改动）：
  if (result.length === 0) { ... }
  const updated = result[0]
  ```

---

### 3.2 P1（数据一致 / 状态错乱）

#### P1-20-01 staff `createPickup` 三步无事务：UPDATE 成功后 INSERT 失败导致 picked_up 孤儿

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2429-2473`
- **现象**：三条 `pg.query` 各自独立连接（UPDATE sale_items / SELECT client_user_id / INSERT pickup_records），无 `pg.transaction` 包裹。任意步骤网络抖动：
  - UPDATE 成功、SELECT 成功、INSERT 失败 → `picked_up_quantity` 已增加但 `pickup_records` 缺行
  - 顾客实际未提货但系统记 picked_up，导致可提数量减少，后续提货被误拒
- **修复**：（L3）用 `pg.transaction(async (tx) => { ... })` 包裹全部三步。

---

#### P1-20-02 staff `createPickup` 仅 `requireStaffBound()`，任何员工可代提（应限 manager）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2423`
- **现象**：任何已绑手机员工（美容师/推广师）均可调用。admin 端明确 `pickup_record:create` 仅授予 manager 角色（`permissions.ts:51`）。
- **修复**：（L3）改为 `await requireManager()(ctx, async () => {})`。

---

#### P1-20-03 staff `createPickup` 不写 `operation_logs`，提货行为审计断裂

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2416-2483`
- **现象**：admin `createPickupRecord` 调 `logOperation(session, 'create', 'pickup_record', ...)`（`pickup-records.ts:346`），staff 副本无任何审计写入。
- **修复**：（L3）在 INSERT pickup_records 后写 operation_logs。

---

#### P1-20-04 剩余次数 `quantity - picked_up_quantity` 计算逻辑散布 5+ 处副本

- **文件**：
  - `fengyu-admin/src/actions/pickup-records.ts:256`（SQL WHERE 内联）
  - `fengyu-staff/cloudfunctions/staffApi/utils/refund.js:19-27`（`calculateUnusedQuantity`）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2124,2374-2380,2436`（转换单 + 提货 CAS）
- **风险**：5 处实现各自处理 NULL / 类型转换，漂移概率高；新增业务类型（如体验卡）需同步修改所有处。
- **修复**：（L3/L7）抽取 `sale-item-availability.js`（staff）/ `saleItemAvailability.ts`（admin）统一函数，三端复用。

---

#### P1-20-05 admin `getPickupRecordsPaginated` 的 dateTo 筛选存在时区漂移

- **文件**：`fengyu-admin/src/actions/pickup-records.ts:90`
- **现象**：`new Date(filters.dateTo + 'T23:59:59')` 按 admin 容器本地时区（UTC）解析，而业务时区是 Asia/Shanghai（UTC+8）。北京时间 2026-04-26 23:59:59 = UTC 2026-04-26 15:59:59，容器按 UTC 算 → 少算 8 小时记录。
- **关联**：CC7 / S02-3 时区统一 epic。
- **修复**：改用 `dateTo::date AT TIME ZONE 'Asia/Shanghai'` 或在输入时转换时区。

---

#### P1-20-06 admin / staff 跨店提货语义对立（admin 允许跨店，staff 强制同店）

- **文件**：
  - admin `pickup-records.ts:247-271`（注释明确"不按原订单门店过滤，提货店可能不同"）
  - staff `order.js:2434`（`AND store_id = $3`，强制 `effectiveStoreId`）
- **现象**：admin 允许跨店提货（提货门店 ≠ 原销售门店），staff 禁止。业务规则对立，顾客在 A 店购买但 B 店提货时：admin 路径成功，staff 路径失败。
- **修复**：spec 决策后统一。建议允许跨店（家居产品可跨门店取），staff 改为 `WHERE store_id IN ($scopeStoreIds)` 而非仅 `effectiveStoreId`。

---

#### P1-20-07 `pickup_records` 无 `sale_order_id` 冗余列，JOIN 链路依赖 sale_items 不可归档

- **文件**：`db/schema/pickup.ts:14-42`
- **现象**：列表/详情 `saleOrderId` 靠 LEFT JOIN sale_items 获取（`pickup-records.ts:114`）。若 sale_items 未来软删/归档，pickup_records 孤行。
- **修复**：（L0 schema）增加 `sale_order_id text NOT NULL REFERENCES sale_orders(sale_order_id)` 冗余列。

---

#### P1-20-08 admin `createPickupRecord` 缺 `product_type='家居产品'` 覆盖校验，仅靠 CAS WHERE 兜底

- **文件**：`fengyu-admin/src/actions/pickup-records.ts:284-364`
- **现象**：`getAvailablePickupItems` 中 SQL 已过滤 `product_type='家居产品'`，但 `createPickupRecord` 本身无显式类型校验，完全靠 CAS WHERE 的 `AND product_type = '家居产品'` 条件兜底。admin 直接调 API 跳过向导时（绕过 `getAvailablePickupItems`），可尝试对非家居产品 saleItemId 创建提货记录——CAS 兜底，但错误消息含糊。
- **修复**：（L7）增加预查：`if (item.productType !== '家居产品') return { success: false, message: '仅家居产品支持提货' }`。

---

#### P1-20-09 admin cascade 通道 5 家居产品 sessionCount=null 时回退量错误（默认 1 而非退款数量）

- **文件**：`fengyu-admin/src/lib/refund-cascade.ts:183-198`
- **现象**：`const qty = sessionCount && sessionCount > 0 ? sessionCount : 1`。家居产品退款时 `sessionCount = sale_items.session_count = NULL`（家居无疗程数），故 qty=1，**不论退款数量是多少都只回退 1 件**。若退 5 件家居，picked_up=3，应回退 3；实际回退 1，picked_up 变 2，仍可被再次提货 2 次。
- **对比**：staff refund-cascade.js 通道 5 在 sessionCount=null 时直接跳过（P0-20-01），admin 此处部分回退比 staff "稍好"但数值仍错误。
- **根因**：`sessionCount` 字段在退款流程中被复用于"疗程卡退次数"和"家居产品退数量"两种语义，但家居产品的退款数量没有写入 `session_count` 列（见 `refunds.ts:807`：`const sessionCount = pre.details?.sessionCount ?? null`，而 `createRefund` 只在疗程卡时写 session_count）。
- **修复**：（L7 admin refund-cascade.ts + L3 staff refund-cascade.js）通道 5 对非疗程卡（家居/单品）的处理应直接按 `saleItemId` 全量清零 `picked_up_quantity`（已提的全部视为已退款），而非依赖 sessionCount：
  ```ts
  // 家居产品：清零 picked_up_quantity（退款后不再可提）
  await tx.execute(sql`
    UPDATE sale_items
       SET picked_up_quantity = 0, updated_at = NOW()
     WHERE sale_item_id = ${saleItemId}
       AND product_type IN ('家居产品', '单品')
       AND COALESCE(picked_up_quantity, 0) > 0
  `)
  ```

---

### 3.3 P2（代码质量）

#### P2-20-01 admin `unitRealPrice` 字段在 `getAvailablePickupItems` 中返回但 UI 未消费

- **文件**：`pickup-records.ts:270` + `pickup-record-create-page.tsx` 全文
- **修复**：删除字段或在 UI 表格增加单价列。

#### P2-20-02 staff createPickup 跨店错误使用 `INVALID_PARAMS:` 而非 `PERMISSION_DENIED:`

- **文件**：`order.js:2451`：`INVALID_PARAMS: 该商品仅在 ${row.store_id} 可提货`
- **现象**：跨店提货属于权限错误，应抛 `PERMISSION_DENIED:`。
- **修复**：（L3）更正错误前缀。

#### P2-20-03 admin `permissions.ts` admin 角色未含 `pickup_record:*`，admin 登录进 /pickup-records 报错

- **文件**：`fengyu-admin/src/lib/permissions.ts:15-35`
- **现象**：admin 角色数组不含 `pickup_record:list`，访问 `/pickup-records` 时 `requirePermission` 抛错。
- **修复**：（L7）为 admin 角色加 `pickup_record:list`（只读）；或在 menu.ts 对 admin 角色隐藏该菜单项。

#### P2-20-04 admin `actions/pickup-records.ts` 0 单元测试

- **文件**：`fengyu-admin/src/actions/` 无 `pickup-records.test.ts`
- **修复**：（L7）新增测试覆盖：scope 过滤、超量 CAS 失败、跨店权限、有效明细筛选。

#### P2-20-05 staff `createPickup` 并发双提：无幂等键，pickup_records 可多写

- **文件**：`order.js:2469-2473`（INSERT pickup_records）
- **现象**：同一员工在网络抖动时双击 → 第一次 UPDATE picked_up_quantity 成功（CAS 命中），再次发起同 payload：CAS 可能仍命中（若 qty 很小）→ 两次 INSERT pickup_records → 记录重复，picked_up 多计。
- **修复**：（L0 schema）增加 pickup_records 防重 UNIQUE 索引：`UNIQUE (sale_item_id, confirmed_by, created_at)` 时间精度需足够或加应用层 idempotency-key。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 提货能力 | ✅ 完整列表 + 创建向导 | ✅ 单点 createPickup | ❌ 完全缺位 | 顾客无法自查剩余可提量 | P1 |
| 跨店提货 | 允许（注释明确） | 禁止（`store_id=effectiveStoreId`） | — | 规则对立 | P1-20-06 |
| 鉴权 | manager / finance 分级 | 任意员工（requireStaffBound） | — | 普通员工越权代提 | P1-20-02 |
| `item_direction` 守卫 | ✅ `AND item_direction='购买'` | ❌ 缺失 | — | 退出/转出行误提货 | **P0-20-02** |
| 退款 cascade 通道 5 | ✅ 执行（但数量计算错误 qty 默认 1） | ❌ sessionCount=null 直接跳过 | — | 家居产品退款后超提不被阻止 | **P0-20-01** |
| 事务原子性 | ✅ db.transaction | ❌ 三步无事务 | — | INSERT 失败导致 picked_up 孤儿 | P1-20-01 |
| operation_logs | ✅ logOperation 写入 | ❌ 不写 | — | 审计断裂 | P1-20-03 |
| rowCount 判断 | ✅（Drizzle tx.execute 有 rowCount） | ❌（pg.query 返回 rows 数组，无 rowCount） | — | 错误分支死代码（P0-20-03） |

---

## 5. 横切检查

- [x] **CC1 数值精度**：`pickup_quantity` / `picked_up_quantity` 均为 INTEGER，整数运算无精度问题；admin 不处理金额 ✅
- [ ] **CC2 并发幂等**：
  - admin CAS UPDATE + 事务 ✅；staff CAS UPDATE ✅（DB 层兜底），但无事务（P1-20-01）
  - 退款 cascade 通道 5：staff 完全跳过（**P0-20-01**）；admin 数量计算错误（P1-20-09）
  - 双击防重：admin `submitting` 状态 ✅；staff 无 idempotency key（P2-20-05）
- [x] **CC3 组织隔离**：
  - admin `scopeCondition(session, pickupRecords.storeId)` + `isInScope(session, data.storeId)` 双重 ✅
  - staff `effectiveStoreId` 强制（管理层 effectiveStoreId=null 时静默全部不命中，非数据泄露）✅
- [ ] **CC4 后端鉴权**：
  - admin `requirePermission('pickup_record:create')` ✅
  - staff 仅 `requireStaffBound()`，应为 `requireManager()`（P1-20-02）❌
  - admin 角色本身无 `pickup_record:*`（P2-20-03）❌
- [ ] **CC5 错误码**：staff 跨店错误 `INVALID_PARAMS:` 应为 `PERMISSION_DENIED:`（P2-20-02）❌；错误路径因 rowCount bug 实际抛 TypeError（P0-20-03）❌
- [x] **CC6 PII**：
  - admin 列表 `formatPhone(row.clientPhone)` 脱敏 ✅
  - admin 详情 Dialog 同样脱敏 ✅
  - logOperation 仅含内部 ID ✅
- [ ] **CC7 时间字段**：`dateTo + 'T23:59:59'` 时区漂移（P1-20-05）❌；CC7 / S02-3 epic
- [x] **CC8 WXML/Vant**：staff 端无独立提货页面，N/A；admin 端为 Next.js，不适用
- [ ] **CC9 测试与残留**：
  - admin `pickup-records.ts` 0 单测（P2-20-04）❌
  - staff createPickup 测试未覆盖 rowCount bug / 退出行误提 / 退款并发
  - 废弃字段残留：pickup_records schema 干净，无 v3.x 前字段 ✅

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/pickup.ts` | 增加 `sale_order_id text NOT NULL REFERENCES sale_orders` 冗余列；头部注释"流水表无 updated_at" | P1-20-07 |
| L0 schema | `db/migrations/00NN_*.sql` | 新增 `UNIQUE (sale_item_id, confirmed_by, created_at)` 防重索引 | P2-20-05 |
| L3 staff helpers | `staffApi/helpers/refund-cascade.js:135-149` | 通道 5 改为：若 saleItemId 且 product_type='家居产品'，直接 `SET picked_up_quantity=0`，不依赖 sessionCount | **P0-20-01** |
| L3 staff routes | `routes/order.js:2431-2437` | UPDATE WHERE 加 `AND item_direction = '购买'` | **P0-20-02** |
| L3 staff routes | `routes/order.js:2441` | `result.rowCount === 0` → `result.length === 0`；`result[0]` → `result[0]` | **P0-20-03** |
| L3 staff routes | `routes/order.js:2423` | `requireStaffBound()` → `requireManager()` | P1-20-02 |
| L3 staff routes | `routes/order.js:2429-2473` | 三步包入 `pg.transaction(async tx => {...})`；INSERT 后写 operation_logs | P1-20-01 / P1-20-03 |
| L3 staff utils | `staffApi/utils/sale-item-availability.js`（新建） | 抽取 `calcRemainingQty(item)` 统一函数 | P1-20-04 |
| L7 admin lib | `src/lib/refund-cascade.ts:183-198` | 通道 5 家居/单品退款改为 SET picked_up_quantity=0（不依赖 sessionCount） | P1-20-09 |
| L7 admin actions | `src/actions/pickup-records.ts:90` | dateTo 时区改用 `AT TIME ZONE 'Asia/Shanghai'` | P1-20-05 |
| L7 admin actions | `src/actions/pickup-records.ts:308-319` | 增加预查 `product_type='家居产品'` 校验 | P1-20-08 |
| L7 admin lib | `src/lib/permissions.ts:15-35` | admin 角色加 `pickup_record:list` 只读权限 | P2-20-03 |
| L7 admin actions | `src/__tests__/pickup-records.test.ts`（新建） | 覆盖：scope/CAS/跨店/错误分支 | P2-20-04 |
| L10 docs | `.42cog/pm/admin.pr.spec.md` | 新增"家居产品提货"章节，明确跨店策略 / 退款联动规则 | P1-20-06 |

---

## 7. 验证 SQL（仅 SELECT / EXPLAIN，在 5434/fengyu 执行）

```sql
-- 1) 家居产品：退款已审批通过但 picked_up 未归零（P0-20-01 资损嫌疑）
--    注：新版退款不创建退款单，退款行在 sale_order_payments[change_type='退款',status='已支付']
SELECT
  si.sale_item_id,
  si.product_name,
  si.quantity           AS bought,
  COALESCE(si.picked_up_quantity, 0) AS picked,
  pr.total_picked,
  sop.amount            AS refund_amount
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
JOIN sale_order_payments sop
  ON sop.sale_order_id = si.sale_order_id
  AND sop.change_type = '退款'
  AND sop.status = '已支付'
LEFT JOIN (
  SELECT sale_item_id, SUM(pickup_quantity)::int AS total_picked
  FROM pickup_records
  GROUP BY sale_item_id
) pr ON pr.sale_item_id = si.sale_item_id
WHERE si.product_type = '家居产品'
  AND si.item_direction = '购买'
  AND COALESCE(si.picked_up_quantity, 0) > 0
ORDER BY sop.amount ASC
LIMIT 50;
-- 期望 0 行；非 0 行即"退款通过后仍有 picked_up"的资损实例

-- 2) 退出/转出行中 picked_up_quantity > 0（P0-20-02 验证）
SELECT sale_item_id, item_direction, product_type, quantity, picked_up_quantity
FROM sale_items
WHERE item_direction IN ('退出','转出')
  AND product_type = '家居产品'
  AND COALESCE(picked_up_quantity, 0) > 0;
-- 期望 0 行

-- 3) pickup_records 与 sale_items.picked_up_quantity 一致性（CC9）
WITH pr_sum AS (
  SELECT sale_item_id, SUM(pickup_quantity)::int AS total_picked
  FROM pickup_records
  GROUP BY sale_item_id
)
SELECT
  si.sale_item_id,
  COALESCE(si.picked_up_quantity, 0) AS si_picked,
  pr.total_picked,
  (COALESCE(si.picked_up_quantity, 0) - pr.total_picked) AS diff
FROM sale_items si
JOIN pr_sum pr ON pr.sale_item_id = si.sale_item_id
WHERE COALESCE(si.picked_up_quantity, 0) <> pr.total_picked;
-- 期望 0 行；diff>0 = picked_up 加了但 pickup_records 缺行（孤儿 P1-20-01 产物）

-- 4) staff createPickup 的 rowCount bug 验证：查 sale_items 中退出/转出行 picked_up > 0（P0-20-02 history）
SELECT si.sale_item_id, si.item_direction, so.sale_order_type, si.picked_up_quantity
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE si.item_direction IN ('退出','转出')
  AND si.product_type = '家居产品'
LIMIT 20;

-- 5) 跨店提货记录数量化（P1-20-06）
SELECT COUNT(*)
FROM pickup_records pr
JOIN sale_items si ON si.sale_item_id = pr.sale_item_id
WHERE pr.store_id <> si.store_id;
-- 非 0 即有跨店提货历史
```

---

## 8. 回归测试用例（建议）

1. **P0-20-01 退款后超提阻断**：fixture（量=5 已支付家居），createPickup(qty=2)，createRefund 全量，approveRefund → 验证 picked_up_quantity=0 且 getAvailablePickupItems 返回空
2. **P0-20-02 退出行守卫**：fixture（退款退出行 quantity=3 picked=0 product_type='家居产品'），staff createPickup(退出行saleItemId, qty=1) → 期望 INVALID_PARAMS: 非购买行
3. **P0-20-03 rowCount bug**：mock 场景 UPDATE 返回 0 行 → 验证函数抛正确业务错误而非 TypeError
4. **P1-20-01 事务回滚**：mock INSERT pickup_records 失败 → 验证 picked_up_quantity 不变
5. **P1-20-02 manager 守卫**：美容师角色调 staff createPickup → 期望 PERMISSION_DENIED
6. **P1-20-09 admin cascade 家居退款数量**：退款 3 件家居，picked_up=3，approveRefund → 验证 picked_up_quantity=0（非 picked_up_quantity=2）
7. **P2-20-05 幂等重提**：同 saleItemId + confirmed_by 并发两次 → 仅 1 条 pickup_records 行
8. **CC3 组织隔离**：非 scope 门店的 saleItemId → admin createPickupRecord 返回权限错误

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☑（admin + staff 双端均有缺陷，逻辑不一致）
- 全栈（3 端 + DB）：☐（client 端完全无提货能力，非缺陷只是功能缺位）
- 涉及历史数据：☑（P0-20-01 历史 5434 数据可能存在退款通过但 picked_up 未归零的记录，用 §7 SQL 1 普查）
- 修复成本：M（cascade 修复 + 事务包裹 + rowCount 修复各自独立，可分批次）

---

## 10. 后续待办

- [ ] **P0-20-01 优先修复**：staff `refund-cascade.js` 通道 5 + admin `refund-cascade.ts` 通道 5 同步修正，对齐"家居产品退款一律清零 picked_up_quantity"语义
- [ ] **P0-20-02 优先修复**：staff `createPickup` UPDATE WHERE 加 `item_direction='购买'` 守卫
- [ ] **P0-20-03 优先修复**：staff `createPickup` `result.rowCount` → `result.length` 且包入事务
- [ ] 与 audit-11 退款域共审：确认 admin `refunds.ts approveRefund` 通道 4（steps 805-818）对家居产品的处理是否同样依赖 sessionCount
- [ ] 与 audit-CC2 并发域共审：pickup 通道缺幂等键（P2-20-05），归入 CC2 横切热点
- [ ] 与 audit-CC7 时间域共审：dateTo 漂移（P1-20-05），归入 S02-3 epic
- [ ] 决策 P1-20-06 跨店政策：admin 允许 vs staff 禁止——确认后统一实现
- [ ] 用 §7 SQL 1 在 5434 生产库普查 P0-20-01 历史损失规模
- [ ] 更新 `CROSS-CUTTING.md`：CC2 退款 cascade 通道 5 家居产品 bug（P0-20-01 + P1-20-09）
