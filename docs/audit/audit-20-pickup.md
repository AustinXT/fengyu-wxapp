# 审计报告：家居产品提货 (20)

**审计时间**：2026-04-25
**域 ID**：20
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/pickup.ts:14-42` (pickup_records 主表) + `db/schema/order.ts:163-164` (sale_items.picked_up_quantity) + `db/schema/enums.ts:20` (itemDirectionEnum) | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/pickup-records.ts:57-365` (`getPickupRecordsPaginated` / `getPickupRecordById` / `getAvailablePickupItems` / `createPickupRecord`) | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2383-2444` (`createPickup`) + `fengyu-staff/cloudfunctions/staffApi/index.js:73` 路由注册 | — （**完全无 client 端入口**：clientApi 0 路由 / miniprogram 0 页面 0 调用） |
| 前端 | `fengyu-admin/src/app/(main)/pickup-records/page.tsx:1-42` + `_components/pickup-records-page.tsx:1-301` (列表) + `create/page.tsx:1-10` + `_components/pickup-record-create-page.tsx:1-343` (创建向导) | 仅由开单/转换/退款流程复用单点 `order.js` 内部逻辑（无独立提货页） | — |
| 权限 | `fengyu-admin/src/lib/permissions.ts:51,64`（`pickup_record:list/create` 仅授给 manager；finance 只读；**admin 角色未包含**） | `requireStaffBound()` + 隐式 manager（开单线 N=1，无 `requireManager()` 显式守卫） | — |
| 测试 | — （**0 个 vitest spec**：actions/pickup-records.ts 无单测） | `__tests__/routes/order.test.js:3559-3611` 4 用例（成功/超量/跨店/参数） | — |

> **PLAN 检查点**：admin 入口存在，staff 通过 `order.createPickup` 间接参与（PLAN 误标"不直接参与"），client 完全缺位。

## 2. 数据流图

```
admin createPickupRecord(saleItemId, qty, storeId, clientUserId)
  ├─ requirePermission('pickup_record:create')           # manager / 否则抛 PERMISSION_DENIED
  ├─ isInScope(session, storeId)                         # 提货门店 scope 校验
  ├─ tx BEGIN
  │   ├─ UPDATE sale_items SET picked_up_quantity += qty
  │   │   WHERE sale_item_id = $1
  │   │     AND product_type = '家居产品'
  │   │     AND item_direction = '购买'
  │   │     AND (COALESCE(picked_up_quantity,0) + qty) <= quantity      # CAS
  │   │   RETURNING ...                                                 # rowCount=0 → 回滚
  │   └─ INSERT INTO pickup_records (...)
  └─ logOperation('create', 'pickup_record', id, ...)    # 审计

staff order.createPickup(saleItemId, pickupQuantity, remark)
  ├─ requireStaffBound()                                 # **未 requireManager() — manager 角色未强制**
  ├─ UPDATE sale_items SET picked_up_quantity += $1
  │   WHERE sale_item_id = $2
  │     AND store_id = $3 (= ctx.auth.effectiveStoreId)  # 强制本店；管理层 effectiveStoreId=null 直接全部不命中
  │     AND product_type = '家居产品'                    # ← 漏 item_direction='购买' 守卫
  │     AND (COALESCE(picked_up_quantity,0) + $1) <= quantity
  │   RETURNING ...
  ├─ probe SELECT 用于错误分类（rowCount=0 时再发一条）
  ├─ SELECT sale_order_id, client_user_id from sale_items JOIN sale_orders   # **事务外**
  └─ INSERT INTO pickup_records (...)                                        # **事务外**

approveRefund (admin / staff 双副本)
  └─ ⚠ 仅扣减 remaining_sessions（疗程卡）；**不冲销 picked_up_quantity**（家居产品）
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### P0-20-01 退款审批不冲销/不锁定 picked_up_quantity，家居产品双消费资损 ⚠
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1547-1558` + `fengyu-admin/src/actions/refunds.ts:847-872`
- **现象**：`approveRefund` 仅在 `ref_sale_item_id && session_count` 分支扣减 `remaining_sessions`（疗程卡）；对家居产品的 "退出" 行**完全无任何扣减/标记动作**——既不增加 `picked_up_quantity`，也不写入耗尽锁。createRefund 写 `item_direction='退出'` 行后直接返回，原 `购买` 行的 `picked_up_quantity` 不变。
- **配套缺陷**：`fengyu-staff/cloudfunctions/staffApi/utils/refund.js:19-27` `calculateUnusedQuantity()` 用 `quantity - picked_up_quantity` 判定可退；createRefund 一次校验后请求金额已落地，approveRefund 不再复核。
- **风险**：双消费资损 + 等价物次数防超卖（real.md #1）违反
  1. 顾客买 5 件家居产品 → picked_up=0
  2. 申请退 5 件，待审批 → 退款单写入 5 个 "退出" 行
  3. 审批前店员 createPickup(qty=2) → CAS 成功（5-0 ≥ 2）→ picked_up=2
  4. approveRefund → 无 picked_up_quantity 守卫 → 退款照付 5 件全额
  5. 顾客拿到 5 件全额退款 + 已提走 2 件实物 → 资损 2× unit_real_price
- **复现**：1) 创建已支付家居产品订单 quantity=5；2) /pickup-records/create 提货 0 件（仅模拟，实际不动）；3) staff 申请全量退款，状态 = 待审批；4) 通过 admin 或 staff 调 createPickup(qty=2)；5) 通过 staff approveRefund；6) 检查 sale_items.picked_up_quantity = 2 且退款单已审批通过。
- **修复**：(L3 staff/order.js + L7 admin/refunds.ts)
  - approveRefund 中，对 product_type 非疗程卡的 退出 行加 CAS：`UPDATE sale_items SET picked_up_quantity = picked_up_quantity + $退出qty, updated_at=NOW() WHERE sale_item_id = $ref AND (quantity - COALESCE(picked_up_quantity,0)) >= $退出qty`，rowCount=0 时回滚（与转换单 line 2230-2242 单品分支同模式）
  - createRefund 在审批前须额外用 partial UNIQUE 锁住"退款进行中的购买行"，或在审批时复核可退量（calculateUnusedQuantity 重算）

#### P0-20-02 staff `order.createPickup` 缺 `item_direction='购买'` 守卫，"退出" / "转出" 行可被反向"提货"
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2392-2398`
- **现象**：UPDATE WHERE 子句仅含 `product_type='家居产品'` + `(COALESCE(picked_up_quantity,0)+$1) <= quantity`，**未约束 `item_direction='购买'`**。退款单/转换单也会写 `family product` 类型的 `退出` 行（`refund.js:11`），且 `picked_up_quantity` 列同样存在（虽然默认 0）。
- **对比**：admin `createPickupRecord` 已显式 `AND item_direction = '购买'`（`pickup-records.ts:317`）。
- **风险**：跨方向篡改 + 状态机崩坏。攻击路径：
  - "退出" 行 quantity 为正（虽 sale_amount 为负），picked_up_quantity 默认 0 → CAS 通过 → 误把"退款行"做"提货" → 表面 picked_up 变化但语义错乱（这行根本不该有提货语义）
  - "转出" 行同理（创建后 picked_up_quantity=quantity by line 2233，但创建前一刻有窗口）
- **修复**：(L3) 在 staff createPickup UPDATE WHERE 加 `AND item_direction = '购买'`；同时 probe SELECT 也应过滤再决定错误类型。

#### P0-20-03 admin createPickupRecord pickupQuantity 整数边界 + 漏 product_type 一致性校验
- **文件**：`fengyu-admin/src/actions/pickup-records.ts:298-303` + `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2388`
- **现象**：admin 仅校验 `Number.isInteger(data.pickupQuantity) && >0`；staff 仅 `if (!pickupQuantity || pickupQuantity <= 0)`，**未限制上界**（依赖 CAS）。事务外 SELECT 拼装 client_user_id 时若客户端传 `Number.MAX_SAFE_INTEGER + 1`，CAS 必失败但日志 / probe 会被一次额外查询消耗。**无 pg_advisory_xact_lock**，`uq_pickup_records_*` 等去重 unique 索引不存在，可在同一事务并发同 saleItemId 写入两条。
- **风险**：CAS 防超卖虽然兜底，但缺幂等键 → 同一动作短时间内两次提交会写入两条 pickup_records 行（虽然 picked_up_quantity 只增一次，但 records 表多 1 行假数据）。
- **复现**：admin UI useState `submitting` 在网络异常未 finally 时可被绕过（错误未 toast 但 server action 已成功）→ 重试 click → 第二次 UPDATE 因 quantity 不足失败，但**第一次的 INSERT pickup_records 已成功**。如 admin 创建表单走 `Promise.all` 即可双发。
- **修复**：(L0 schema)
  - 新增 partial UNIQUE：`CREATE UNIQUE INDEX uq_pickup_records_dedup ON pickup_records(sale_item_id, confirmed_by, created_at)` 或更稳妥的应用层 idempotency key（payload 携 client UUID，DB 唯一）
  - admin server action 可加 advisory lock `SELECT pg_advisory_xact_lock(hashtext('pickup:'||$saleItemId))`

### 3.2 P1（数据一致 / 状态错乱）

#### P1-20-01 staff createPickup 事务边界缺失（CAS UPDATE / probe / INSERT 三段不在同事务内）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2391-2434`
- **现象**：UPDATE 走单条 `pg.query` (无 `pg.transaction`)；probe SELECT 单独连接；INSERT pickup_records 又一条。三步无原子性。
- **风险**：UPDATE 成功后 INSERT 失败（约束冲突 / 网络 / 连接抖动）→ `picked_up_quantity` 已加但 pickup_records 缺行 → 顾客实际未提货但系统认为已提，反查不出。
- **修复**：(L3) 包入 `pg.transaction(async (tx) => { ... })`，使 UPDATE / SELECT / INSERT 原子。

#### P1-20-02 staff createPickup 无 `requireManager()` 守卫，普通员工可代提
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2384`
- **现象**：仅 `requireStaffBound()`。spec 定义"由店长/前台代客提货"的业务，但代码侧任何已绑手机的员工（包括美容师 / 推广师）都能 createPickup。
- **对比**：admin 端 manager+finance 才有 `pickup_record:list`，仅 manager 有 `pickup_record:create`（`permissions.ts:51`）；admin 角色本身缺 `pickup_record:*` 是另一个 P2，但 manager 限定执行口径明确。
- **修复**：(L3) 改为 `await requireManager()(ctx, async () => {})` 与 admin 对齐。

#### P1-20-03 staff createPickup 不写 operation_logs，提货行为审计断裂
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2383-2444` 全函数
- **现象**：admin 端 `createPickupRecord` 走 `logOperation(session, 'create', 'pickup_record', ...)`（`pickup-records.ts:346-351`）；staff 副本完全无 operation_logs 写入。一旦顾客投诉"未提货也被记录"，仅 admin 路径有审计可查。
- **关联**：与 audit-12 / 19 同模式（staff 全程 0 operation_logs）
- **修复**：(L3) staff 端引入 `await writeOperationLog(...)` helper（如尚无可参考 admin/cron 的 SQL）。

#### P1-20-04 提货剩余次数 `quantity - picked_up_quantity` 在三端**重复实现 5 次** → 漂移高危
- **文件**：
  - admin `pickup-records.ts:256` (`SI quantity > COALESCE(si.picked_up_quantity,0)`)
  - admin `refunds.ts:200` 调 `calculateUnusedQuantity` (utils 共用)
  - staff `order.js:2085` (`Number(row.quantity) - Number(row.picked_up_quantity || 0)`) 转换单
  - staff `order.js:2335-2356` 转换单备选卡查询
  - staff `order.js:2397` createPickup CAS WHERE 子句
  - staff `utils/refund.js:25-26` calculateUnusedQuantity
- **风险**：5 处副本任意一处遗漏 `COALESCE` / 类型 cast / NULL 处理即口径漂移。例如 admin 用 `> 0` 隐含 NULL 兼容 (`quantity > COALESCE(picked_up_quantity,0)`)，但 staff createPickup CAS 用 `(COALESCE(...,0) + $1) <= quantity` —— 现象一致但维护期破窗概率极高。
- **修复**：(L3) 提取 `db/helpers/sale-item-availability.ts`（admin）/ `staffApi/utils/sale-item.js`（staff）封装"剩余可提 / 剩余次数"统一函数，三端复用。

#### P1-20-05 admin pickup-records 列表 dateTo 仅按本地字符串 `+'T23:59:59'` 拼接，时区漂移
- **文件**：`fengyu-admin/src/actions/pickup-records.ts:90`
- **现象**：`new Date(filters.dateTo + 'T23:59:59')` 解析为 admin 容器本地时区；与 audit-02 / 06 / 17 / 18 同源（PG NOW()=Asia/Shanghai vs admin 容器 = UTC 漂移）
- **关联**：CC7 时间字段；S02-3 epic
- **修复**：与 S02-3 一同推进。

#### P1-20-06 admin available 查询不限 `o.store_id`，但 createPickupRecord scope 仅校验"提货门店"，跨店提货流不闭环
- **文件**：`fengyu-admin/src/actions/pickup-records.ts:247-258` 注释"不按原订单门店过滤：提货店可能与原销售店不同"+ `:304` `isInScope(session, data.storeId)` 仅校验提货 storeId。
- **现象**：admin 允许跨店提货。但 staff 端 `createPickup` 的 UPDATE WHERE 强制 `store_id = ctx.auth.effectiveStoreId`（销售门店 = 提货门店硬约束，line 2395）。**两端语义对立**：admin 跨店允许，staff 同店强制。
- **风险**：业务规则不一致 → 顾客在 storeA 买，去 storeB 由前台跨店提货可成功（admin），但若试图通过 staff 小程序提则失败 → UX 错乱 + 业绩归属不可对账（pickup_records.store_id ≠ sale_items.store_id 时，按哪个门店统计？）。
- **修复**：spec 决策：(a) 全局允许跨店 → staff 改 `WHERE store_id IN scope` 不限同店；(b) 全局禁止 → admin 加 `AND si.store_id = $提货门店`。建议 (a) 因家居产品物流可跨店发货。

#### P1-20-07 pickup_records 缺 (sale_item_id, sale_order_id) 完整审计字段；列表关联订单仅靠 saleItems JOIN
- **文件**：`db/schema/pickup.ts:14-42`
- **现象**：表无 `sale_order_id` 冗余列；admin 列表 / 详情靠 `sale_items` LEFT JOIN 取 saleOrderId（`pickup-records.ts:114, 174`）。如未来 sale_items 行被软删 / 归档，pickup_records 孤儿。
- **修复**：(L0 schema) 增加 `sale_order_id text NOT NULL REFERENCES sale_orders(sale_order_id)` 冗余列，开单时持久化。

#### P1-20-08 admin available 查询不返回订单付款时间 / 不显示按时间排序原因
- **文件**：`fengyu-admin/src/actions/pickup-records.ts:257` `ORDER BY o.paid_at DESC, si.sale_item_id`
- **现象**：返回字段中无 `paid_at`，UI 表格无排序键展示，员工无法判断"先买的 vs 后买的家居"应优先提哪个（影响临期商品用户体验）。
- **修复**：(L7) 返回 `paid_at`，UI 增加列。

### 3.3 P2（代码质量）

#### P2-20-01 admin available `unitRealPrice` 字段返回但 UI 不消费
- **文件**：`pickup-records.ts:270` 返回 + `pickup-record-create-page.tsx` 全文未引用
- **修复**：删除字段或在 UI 显示单价。

#### P2-20-02 staff createPickup 错误码不规范（多处用 `INVALID_PARAMS:` 描述跨店错误，应为 `PERMISSION_DENIED:`）
- **文件**：`order.js:2412` `INVALID_PARAMS: 该商品仅在 ${row.store_id} 可提货`
- **现象**：跨店越权属于权限错误，应抛 `PERMISSION_DENIED:`；现行用 `INVALID_PARAMS:` 与 audit-01 P1-01-04 同模式。
- **修复**：(L3) 错误前缀对齐。

#### P2-20-03 admin pickup_records 排序硬编码 `desc(createdAt)`，注释"流水型表无 updatedAt"但 schema 也无 updated_at
- **文件**：`pickup-records.ts:125-126`
- **观察**：注释合理，但 schema 注释未明确"流水型表"标记，下次 baseline reset 容易误加 updated_at 触发器。
- **修复**：(L0 schema) `db/schema/pickup.ts` 头部加注释明确"流水表，仅 created_at"。

#### P2-20-04 admin actions/pickup-records.ts 0 单元测试
- **文件**：`fengyu-admin/src/actions/__tests__/` 无 pickup-records.test.ts
- **现象**：列表 / 详情 / available / create 4 函数全无测试覆盖。pickupRecords 模块 customers.ts:812 reassign 路径也无测试。
- **修复**：(L7) 新增 `pickup-records.test.ts`，覆盖 scope 过滤 / 超量 CAS 失败 / 跨店权限等。

#### P2-20-05 admin permissions.ts admin 角色未含 `pickup_record:*` → admin 无法查看 / 创建
- **文件**：`fengyu-admin/src/lib/permissions.ts:5-37`
- **观察**：`admin` 角色不含 `pickup_record:list/create`；当前期望"admin 不碰业务数据"但实际 admin 角色会进入 `/pickup-records` 路由 → page.tsx 调 `getPickupRecordsPaginated` 中的 `requirePermission` 抛错 → UI 拿不到数据。
- **修复**：菜单层 `lib/menu.ts` 拦截或 admin 加 `pickup_record:list` 只读。

#### P2-20-06 staff createPickup 测试覆盖低于 admin
- **文件**：`__tests__/routes/order.test.js:3559-3611`
- **观察**：成功 / 超量 / 跨店 / 参数 4 用例；未测：(a) `item_direction='退出'` 行误命中（呼应 P0-20-02）；(b) 退款 + 提货并发；(c) 事务部分失败回滚。
- **修复**：补全测试集。

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 是否暴露提货能力 | ✅ 完整列表 + 创建向导 | ✅ 单点 createPickup | ❌ 完全缺位 | 顾客无自助查询"我还能提多少" | P1 |
| 跨店提货 | 默认允许（不限 sale_items.store_id） | 强制同店（`store_id = effectiveStoreId`） | — | 业务规则对立 | P1 |
| 鉴权 | manager / finance 限定（`pickup_record:list/create`） | 仅 `requireStaffBound()`（任何员工） | — | staff 越权代提 | P1 |
| 退款冲销 picked_up | 不做（refunds.ts:847-872 仅疗程卡） | 不做（order.js:1547-1558 仅疗程卡） | — | 双消费资损 | **P0** |
| 事务原子性 | tx 包裹 UPDATE+INSERT | 三步无 tx | — | INSERT 失败孤儿 picked_up | P1 |
| operation_logs | 写入 | 不写 | — | 审计断裂 | P1 |
| `item_direction='购买'` 守卫 | 显式 (line 317) | **缺失** | — | 退出/转出行被误提 | **P0** |
| 错误前缀 | 抛 PERMISSION_DENIED 失败返回 success=false | INVALID_PARAMS 跨店 | — | 错误码漂移 | P2 |

## 5. 横切检查（套用 §3 模板）

- [ ] **CC1 数值精度**：pickup_quantity = integer ✅；admin 不直接处理金额；staff 返回 `remaining = updated.quantity - updated.picked_up_quantity` 已是整数 ✅
- [ ] **CC2 并发幂等**：
  - admin CAS 实现 ✅，但缺幂等键 (P0-20-03)
  - staff CAS 实现 ✅，但**不在事务内** (P1-20-01) + 缺 advisory lock
  - 退款链路对家居产品 picked_up 完全不并发安全 (**P0-20-01**)
- [ ] **CC3 组织隔离**：
  - admin scopeCondition + isInScope 双重 ✅
  - staff effectiveStoreId 强制 ✅，但**管理层 effectiveStoreId=null 时静默全部不命中**（CAS rowCount=0）→ 只是错误而非数据泄露，可接受
- [ ] **CC4 后端鉴权**：
  - admin `requirePermission('pickup_record:create')` ✅
  - staff 仅 `requireStaffBound()` ❌ (P1-20-02) — 应 `requireManager()`
  - admin 角色本身无 pickup 权限 (P2-20-05)
- [ ] **CC5 错误码**：staff 跨店错误用 INVALID_PARAMS 不符约定 (P2-20-02)
- [ ] **CC6 PII**：
  - admin 列表展示 `formatPhone(row.clientPhone)` 已脱敏 ✅（`pickup-records-page.tsx:129`）
  - admin 详情 Dialog 同样 formatPhone ✅（line 273）
  - logOperation 内不包含 PII（仅 saleItemId/storeId/clientUserId 内部 ID） ✅
- [ ] **CC7 时间字段**：dateTo 时区漂移 (P1-20-05)，与 audit-02/06/17/18 同 epic
- [ ] **CC8 WXML/Vant**：staff 端无独立提货页（无 WXML），N/A
- [ ] **CC9 测试与残留**：
  - admin actions/pickup-records.ts **0 单测** (P2-20-04)
  - staff createPickup 4 用例不覆盖退出行 / 退款并发 (P2-20-06)
  - 已废弃残留检查：`pickup_records` 表无任何 v3.x 之前的字段；schema 干净 ✅

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/pickup.ts` | (a) 增加 `sale_order_id` 冗余列 + FK；(b) 头部注释"流水表无 updated_at" | P1-20-07 / P2-20-03 |
| L0 schema | `db/migrations/00NN_*.sql` | 创建 `uq_pickup_records_idempotent` partial UNIQUE 防重 | P0-20-03 |
| L3 staff routes | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:2197-2243` | approveRefund 中对 `productType IN ('单品','家居产品')` 的 退出 行 CAS 增 `picked_up_quantity += quantity`，rowCount=0 回滚 | **P0-20-01** |
| L3 staff routes | 同上 :2392-2398 | UPDATE WHERE 加 `AND item_direction = '购买'` | **P0-20-02** |
| L3 staff routes | 同上 :2383 | `requireStaffBound` → `requireManager` | P1-20-02 |
| L3 staff routes | 同上 :2391-2434 | 包入 `pg.transaction(async tx => {...})`；写 operation_logs | P1-20-01 / P1-20-03 |
| L3 staff utils | `staffApi/utils/sale-item-availability.js` (新建) | 抽 `calcRemainingQuantity(item)` 三端共用 | P1-20-04 |
| L7 admin actions | `fengyu-admin/src/actions/refunds.ts:847-872` | 同步 P0-20-01 修复（家居产品退出行 picked_up CAS） | **P0-20-01** |
| L7 admin actions | `fengyu-admin/src/actions/pickup-records.ts:90` | dateTo 改用 `sql\`(created_at AT TIME ZONE 'Asia/Shanghai')::date <= ${filters.dateTo}\`` | P1-20-05 |
| L7 admin actions | 同上 :247-258 | 决策：跨店允许 → 文档化；同店强制 → 加 `AND si.store_id = $1` | P1-20-06 |
| L7 admin actions | 同上 :298-303 | 加 advisory lock + 整数上限校验 | P0-20-03 |
| L7 admin actions | `__tests__/pickup-records.test.ts` (新建) | scope/CAS/跨店/错误分支单测 | P2-20-04 |
| L7 admin lib | `fengyu-admin/src/lib/permissions.ts:5-37` | admin 角色加 `pickup_record:list` (只读) | P2-20-05 |
| L9 client (新增能力) | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 新增 `pickup.list / pickup.detail` 顾客自查路由 | （能力空缺） |
| L10 docs | `.42cog/pm/admin.pr.spec.md` | 新增"家居产品提货"章节，明确跨店 / 退款联动 | spec 缺章节 |

## 7. 验证 SQL（在 5434/fengyu，仅 SELECT / EXPLAIN）

```sql
-- 1) 检查"退款已审批 + 家居产品 + picked_up 未冲销"的资损嫌疑数据（P0-20-01 验证）
WITH refund_out AS (
  SELECT ri.ref_sale_item_id, SUM(ri.quantity)::int AS refunded_qty
  FROM sale_items ri
  JOIN sale_orders ro ON ro.sale_order_id = ri.sale_order_id
  WHERE ri.item_direction = '退出'
    AND ri.product_type = '家居产品'
    AND ro.sale_order_type = '退款单'
    AND ro.status = '已支付'   -- approveRefund 通过
  GROUP BY ri.ref_sale_item_id
)
SELECT
  si.sale_item_id,
  si.product_name,
  si.quantity AS bought,
  COALESCE(si.picked_up_quantity, 0) AS picked,
  ro.refunded_qty,
  (si.quantity - COALESCE(si.picked_up_quantity, 0) - ro.refunded_qty) AS theoretical_unused,
  (si.quantity - COALESCE(si.picked_up_quantity, 0)) AS displayed_remaining
FROM sale_items si
JOIN refund_out ro ON ro.ref_sale_item_id = si.sale_item_id
WHERE si.product_type = '家居产品'
  AND si.item_direction = '购买'
  AND (si.quantity - COALESCE(si.picked_up_quantity, 0)) > 0   -- 仍可被提货
ORDER BY ro.refunded_qty DESC;
-- 期望 0 行；非 0 行即"已退款但仍可被再次提货"的资损实例

-- 2) 检查"退出 / 转出行 picked_up_quantity ≠ 0"的脏数据（P0-20-02 验证）
SELECT sale_item_id, sale_order_id, item_direction, product_type, quantity, picked_up_quantity
FROM sale_items
WHERE item_direction IN ('退出','转出')
  AND product_type = '家居产品'
  AND COALESCE(picked_up_quantity, 0) > 0;
-- 期望 0 行（除非 staff createPickup 缺购买守卫已被触发过）

-- 3) 检查 pickup_records 与 sale_items.picked_up_quantity 一致性（CC9）
WITH pr_sum AS (
  SELECT sale_item_id, SUM(pickup_quantity)::int AS total_picked
  FROM pickup_records
  GROUP BY sale_item_id
)
SELECT
  si.sale_item_id,
  COALESCE(si.picked_up_quantity, 0) AS si_picked,
  pr.total_picked AS pr_sum,
  (COALESCE(si.picked_up_quantity, 0) - pr.total_picked) AS diff
FROM sale_items si
JOIN pr_sum pr ON pr.sale_item_id = si.sale_item_id
WHERE COALESCE(si.picked_up_quantity, 0) <> pr.total_picked;
-- 期望 0 行；diff>0 提示 sale_items.picked_up 加了但没写入 pickup_records（孤儿）；
-- diff<0 提示 pickup_records 多写了（重复提交）

-- 4) 检查跨店提货实例（P1-20-06 数量化）
SELECT
  pr.id,
  pr.store_id AS pickup_store,
  si.store_id AS purchase_store,
  pr.created_at,
  pr.pickup_quantity
FROM pickup_records pr
JOIN sale_items si ON si.sale_item_id = pr.sale_item_id
WHERE pr.store_id <> si.store_id
ORDER BY pr.created_at DESC
LIMIT 50;

-- 5) EXPLAIN admin available 查询索引命中
EXPLAIN ANALYZE
SELECT si.sale_item_id, si.sale_order_id, si.product_name, si.sku_spec_name, si.quantity,
       COALESCE(si.picked_up_quantity, 0) AS picked_up_quantity, si.unit_real_price,
       o.store_id, s.store_name
FROM sale_items si
INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
LEFT JOIN stores s ON s.store_id = o.store_id
WHERE o.client_user_id = 'wf-12345'
  AND o.status = '已支付'
  AND si.item_direction = '购买'
  AND si.product_type = '家居产品'
  AND si.quantity > COALESCE(si.picked_up_quantity, 0)
ORDER BY o.paid_at DESC, si.sale_item_id;
-- 验证是否走 idx_sale_orders_client + idx_sale_items_order_id
```

## 8. 回归测试用例（建议）

1. **P0-20-01 双消费资损**：fixture（5 单家居 / picked=0 / refund qty=5 待审批） → createPickup(2) 成功 → approveRefund → 断言 `picked_up_quantity = 5` 且 retrieving available 返回空
2. **P0-20-02 退出行守卫**：fixture（家居产品退款 退出 行 quantity=3 picked=0） → staff createPickup(saleItemId=退出行id, qty=1) 应抛 INVALID_PARAMS / PERMISSION_DENIED
3. **P0-20-03 重提防重**：admin 端并发两次 createPickupRecord(same saleItemId, qty=1) → 一次成功一次失败；pickup_records 仅 1 行
4. **P1-20-01 事务原子性**：mock pg.query INSERT pickup_records 抛错 → 期望 picked_up_quantity 不变（rollback）
5. **P1-20-02 manager 守卫**：beautician（仅 `staff` 角色）调 staff `order.createPickup` 应抛 PERMISSION_DENIED
6. **P1-20-04 剩余次数 helper**：参数化覆盖 (qty=5/picked=0)、(qty=5/picked=5)、(qty=5/picked=null) 三处 source；断言 helper 输出对齐
7. **P1-20-06 跨店决策**：admin 跨店 vs staff 同店两种期望对应不同测试用例；锁定决策后单端断言一致
8. **P1-20-08 时间排序**：fixture 跨午夜 paid_at（北京 UTC+8 vs 容器 UTC）→ 列表筛选 dateTo='2026-04-25' 应包含北京 25 日全天
9. **CC9 一致性 SQL**：`SELECT 1` 上述 4 条验证 SQL 接入 cron STEP 5（积分对账同模式），任一返回非 0 行即告警

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☑（admin + staff，client 缺位但不影响修复）
- 全栈（3 端 + DB）：☐（client 端能力空缺，建议补但非阻塞）
- 涉及历史数据：☑（P0-20-01 历史 5434 数据可能已存在双消费资损嫌疑数据，需用 §7 SQL 1) 普查）
- 修复成本：M（schema 加列 / 退款链路改 / 三端 helper 抽取）

## 10. 后续待办

- [ ] 与 audit-11 退款域共审：refunds.ts approveRefund 退出行处理对所有 product_type 一致化（疗程卡 remaining_sessions / 单品 + 家居产品 picked_up_quantity 双轨）
- [ ] 与 audit-09 商品域同步：体验类单品卡（`parent.is_card_kind=true`）的 picked_up_quantity 在转换 / 退款的双轨已被覆盖，但 spec 未文档化"体验卡 vs 家居 vs 疗程卡 = 三种次数等价物"
- [ ] 与 audit-19 客户分配域共审：customers.ts:812-834 顾客合并时 reassign pickup_records 的 clientUserId 是否还需同步 sale_items 关系
- [ ] 文档化跨店提货决策（admin 允许 / staff 限同店当前对立），更新 admin.pr.spec.md 新增"家居产品提货"章节
- [ ] CROSS-CUTTING.md 新增条目：CC2/CC4 退款不冲销次数等价物（联合 audit-11 / 20）
- [ ] 与 SUMMARY.md（最终）汇总 P0-20-01 资损金额量化（依赖 §7 SQL 1 实际行数）

