# 审计报告：赠送 / 分享 / 客户分配 (19)

**审计时间**：2026-04-25
**域 ID**：19
**slug**：gift-share-assign
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：notes/tickets/2026-04-24-share-gift-reward.md（PR-2 share-gift-reward）；retain audit-04 / audit-10 / audit-13 关联 P0
**规范版本**：`real.md` v3.1.0（命中 #5 后端鉴权 / #6 组织域数据隔离 / #3 支付幂等）

---

## 1. 三端入口对照

| 层 | admin | staff | client | payNotify |
|----|-------|-------|--------|-----------|
| Schema 顾客 / 邀请关系 | `db/schema/user.ts:12-87` clientWechatUsers | ↑ | ↑ | ↑ |
| Schema 券模板 / 用户券 | `db/schema/coupon.ts:11-77` couponTemplates + userCoupons (`face_value_override` 行 65) | ↑ | ↑ | ↑ |
| Schema 消息 | `db/schema/message.ts:11-37`（partial unique on `idempotency_key`） | ↑ | ↑ | ↑ |
| Schema 操作日志 | `db/schema/operation-log.ts:12-43` | ↑ | ↑ | ↑ |
| 系统配置 | `db/schema/system-config.ts` `system_configs.share_gift_config` | ↑ | ↑ | ↑ |
| 分享礼配置页面 | `fengyu-admin/src/app/(main)/share-gift/page.tsx:1-12` + `_components/share-gift-page.tsx:1-316` | — | — | — |
| 分享礼配置 actions | `src/actions/settings.ts:296-369`（getShareGiftConfig / saveShareGiftConfig，`system:config` 权限）+ `:243-257` listActiveCouponTemplates | — | — | — |
| 配置归一化 | `src/lib/share-gift-config.ts:1-100` (DEFAULT_SHARE_GIFT_CONFIG / normalizeShareGiftConfig) | — | — | — |
| 分享礼发放 helper（**3 副本字节级一致**） | — | `staffApi/share-gift.js:20-161` | `clientApi/share-gift.js:20-161` | `payNotify/share-gift.js:20-161` |
| 分享礼发放调用站点 | — | `staffApi/routes/order.js:994-1017` confirmOffline `targetStatus∈{已支付,已完成}`，SAVEPOINT 隔离 | **未挂载（dead code）** —— `clientApi/index.js` 路由表 + `clientApi/routes/order.js` 全文 grep 无 `require('./share-gift')` | `payNotify/index.js:472-494` SAVEPOINT 隔离 |
| 邀请关系绑定 | — | — | `clientApi/routes/auth.js:201-290` `bindStore` 含 `inviterUserId` 一次性绑定 | — |
| 赠送记录查询（门店模式） | — | `staffApi/routes/customer.js:748-834` `customer.giftHistory`（**仅 requireStaffBound，零 store/scope 过滤**） | — | — |
| 赠送记录查询（管理层模式） | — | `staffApi/routes/mgmt-customer.js:692-781` `mgmtCustomer.giftHistory`（requireManagementLevel + validateScope + buildSaleScope，正例参考） | — | — |
| 客户分配 | — | `staffApi/routes/customer.js:892-920` `customer.assign`（requireManager + 员工同店，**不校验顾客 scope，无审计**） | — | — |
| 前端入口（员工端长按分配） | — | `miniprogram/pages/customer-list/customer-list.ts:200-240` onLongPressAssign / onAssignSelect | — | — |
| 前端入口（赠送记录 Tab） | — | `miniprogram/packageCustomer/customer-detail/customer-detail.ts:438-448` loadGiftHistory | — | — |
| 测试 | `src/actions/settings.test.ts` 覆盖 saveShareGiftConfig | — | `clientApi/__tests__/share-gift.test.js`（覆盖唯一 dead-code 副本，与 payNotify/staffApi 行为一致但未挂载） | — |

---

## 2. 数据流图

```
[配置侧]
admin (system:config) → settings.saveShareGiftConfig → system_configs.share_gift_config (JSON)
                       → revalidatePath('/share-gift') + logUpdate('system.saveShareGiftConfig')

[发放侧]
client.bindStore (inviterUserId) → client_wechat_users.inviter_user_id (一次性写入，FYGK- 前缀校验)
                                  ⚠ try/catch 静默失败，无审计

clientApi.order.create + offlinePay (微信/支付宝)            ┐
   │                                                         │
   ▼ (回调由微信侧 POST 触发)                                │
payNotify.handleSuccess (UPDATE sale_orders='已支付')         ├─→ SAVEPOINT sp_share_gift
   ├─ payments INSERT                                         │      grantShareGift(client, order)
   ├─ allocations / spending_tier / customer_type            │      ┌────────────────────────────┐
   ├─ settlePointsSafe                                        │      │ 0. paid_amount > 0 校验    │
   └─ grantShareGift ───────────────────────────────────────┤      │ 1. 读 system_configs       │
                                                              │      │ 2. 首单判定（COUNT=0）     │
staffApi.order.confirmOffline (targetStatus∈{已支付,已完成}) ─┤      │ 3. 读 inviter_user_id      │
   ├─ payments INSERT                                         │      │ 4. inviter qualified?      │
   ├─ refreshSpendingTier / recalcCustomerType                │      │ 5. 读 coupon_templates     │
   ├─ settlePointsSafe                                        │      │ 6. 算面值 (clamp)          │
   └─ grantShareGift ───────────────────────────────────────┘      │ 7. 算 expireAt             │
                                                                     │ 8. INSERT user_coupons × 2  │
                                                                     │    coupon_id = sg-{role}-   │
                                                                     │    {saleOrderId}            │
                                                                     │    face_value_override=val  │
                                                                     │    ON CONFLICT DO NOTHING   │
                                                                     │ 9. INSERT messages × 2      │
                                                                     │    idempotency_key =        │
                                                                     │    sg-msg-{role}-{orderId}  │
                                                                     │ 10.INSERT operation_logs    │
                                                                     │    action='share.giftGranted│
                                                                     │    operator_employee_id=NULL│
                                                                     └────────────────────────────┘

[客户分配]
staff.customer-list onLongPressAssign → callStaffApi('customer.assign', {clientUserId, employeeId})
   → requireManager()
   → SELECT employee WHERE store_id = ctx.auth.effectiveStoreId  (员工同店校验)
   → UPDATE client_wechat_users SET bound_employee_id=$1 WHERE user_id=$2  (无顾客 scope 校验)
   → 返回成功
   ⚠ 无 operation_logs，无 last_assign_at，无 history 表

[赠送记录读取]
staff.customer-detail loadGiftHistory → callStaffApi('customer.giftHistory', clientUserId)
   → requireStaffBound （仅"已绑店"，零 manager / 零 scope）
   → SELECT FROM sale_orders WHERE client_user_id=$1 AND status IN (...)
   ⚠ 完全不带 store_id 过滤，跨店全局可读
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-19-01]** `customer.assign` 跨店分配漏洞 + 不写审计日志（retain & 加固 P0-10-04）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:892-920`
- 现象：`requireManager()` 通过即可，UPDATE 仅 `WHERE user_id = $2`，**不约束顾客 `bound_store_id` ∈ scope**：
  ```js
  const result = await pg.query(
    'UPDATE client_wechat_users SET bound_employee_id = $1, updated_at = NOW() WHERE user_id = $2',
    [employeeId, clientUserId]
  )
  ```
  员工同店校验（行 900-906）只防"把顾客分给非本店员工"，不防"把别店顾客拉到本店员工名下"。多店店长身份（`requireManager` 兼容旧 bindings 含 `legacyFallback` 行 263-268）下漏洞放大：店长 A 在 store-X 模式登录，知道顾客 B 的 `clientUserId`（来自 `customer.search` keyword 模糊匹配，行 50 模糊匹配本店；或 `customer.detail` 全局可读 — P0-10-01），即可把 store-Y 的 B 分配给 store-X 美容师 → B 的下次开单提成默认归错店。
- 风险：业绩资损 + 顾客归属乱跳 + 无审计追溯（违反 v3.3 后审计要求 — operation_logs 必写）。
- 复现：1) 多店店长 mgrA 拥有 store-X / store-Y 双绑定；2) loginLevel='store' 切到 store-X；3) 通过 `customer.detail` 拿到属于 store-Y 的顾客 B 的 clientUserId（P0-10-01 漏洞前提）；4) 调 `customer.assign` 传 `clientUserId=B, employeeId=storeX 美容师`；5) 后台查 `client_wechat_users.bound_employee_id` 已被改写，但 `bound_store_id` 仍是 store-Y → 数据脏。
- 修复：(L3 staffApi/routes/customer.js)
  ```js
  // 1) 校验顾客在 scope 内
  const customerRow = await pg.query(
    'SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1',
    [clientUserId]
  )
  if (!customerRow.length) throw new Error('INVALID_PARAMS: 顾客不存在')
  const targetStoreId = customerRow[0].bound_store_id
  if (!ctx.auth.scopeStoreIds.includes(targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 顾客不在管辖范围内')
  }
  // 2) 门店模式必须等于 effectiveStoreId
  if (ctx.auth.loginLevel === 'store' && targetStoreId !== ctx.auth.effectiveStoreId) {
    throw new Error('PERMISSION_DENIED: 仅可分配本店顾客')
  }
  // 3) UPDATE 加 bound_store_id 守卫（CAS）
  const r = await pg.query(
    'UPDATE client_wechat_users SET bound_employee_id=$1, updated_at=NOW() WHERE user_id=$2 AND bound_store_id=$3',
    [employeeId, clientUserId, targetStoreId]
  )
  // 4) 写 operation_logs
  await pg.query(
    `INSERT INTO operation_logs (operator_employee_id, operator_role, org_node_id, action, target_type, target_id, detail, source, created_at)
     VALUES ($1,'manager',$2,'customer.assign','client_wechat_users',$3,$4::jsonb,'staffApi',NOW())`,
    [ctx.auth.staffWfId, /*orgNodeId*/, clientUserId, JSON.stringify({oldEmployeeId, newEmployeeId: employeeId, storeId: targetStoreId})]
  )
  ```

#### **[P0-19-02]** `customer.giftHistory` 完全无 store/scope 过滤（retain & 量化 P0-10-02）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:748-834`
- 现象：仅 `requireStaffBound()`，按 `client_user_id` 或 `client_phone` 过滤 `sale_orders`，整段 SQL 中 `whereClause` 不含任何 `o.store_id` 条件（行 768-772、781-786、794-797）。同模块 `paidOrders`（行 425-433）已显式 `o.store_id = $effectiveStoreId`，形成同模块双轨实现；同模块 `mgmt-customer.giftHistory`（mgmt-customer.js:692-781）走 `requireManagementLevel + validateScope + buildSaleScope`，是正例。
- 风险：组织域数据隔离崩溃（real.md #6）；任意已绑店员工拿到顾客 `client_user_id`/`phone` 即可拉到该顾客全国所有门店的赠品/组合套餐流水（含 `total_amount`、`paid_at`、SKU 详情、剩余次数）。CC6 PII 泄漏：列出顾客在竞品门店的消费足迹。
- 复现：1) 员工 emp-X 绑店 store-X；2) 拿到顾客 B（绑店 store-Y）的 clientUserId；3) `callStaffApi('customer.giftHistory', clientUserId)`；4) 返回 store-Y 的 `giftItems` 全集。
- 修复：(L3) 同 P0-10-02 的修复模板，引入 `buildStoreScopeCondition(ctx.auth, 'o.store_id', $n)` —— 门店模式单值，管理层模式 ANY(scopeStoreIds)。或：要求调用方走 `mgmtCustomer.giftHistory`，下线门店模式 `customer.giftHistory`。

#### **[P0-19-03]** 分享礼 `operation_logs` 缺失 `operator_employee_id` 与 `org_node_id`（v3.3 审计断裂）
- 文件：`fengyu-staff/cloudfunctions/staffApi/share-gift.js:140-156`、`fengyu-client/cloudfunctions/payNotify/share-gift.js:140-156`、`fengyu-client/cloudfunctions/clientApi/share-gift.js:140-156`（**3 副本字节级一致，bug 也一致**）
- 现象：INSERT 仅写 `(action, target_type, target_id, detail, source, created_at)`，三个 NOT-NULL 字段达成（target_type='sale_order', target_id=saleOrderId, action='share.giftGranted'），但**完全不写 `operator_employee_id` / `operator_role` / `org_node_id` / `org_node_name`**。
  - payNotify 路径：调用方是支付回调，`operator_employee_id=NULL` 合理（与 cronTask 同等系统级），但 `source='payNotify'` 由 share-gift.js 行 154 默认值兜底是 OK 的。
  - **staffApi 路径**：调用站点 `staffApi/routes/order.js:1001-1006` 传 `source: 'staffApi'`，但 `grantShareGift` 内部 INSERT 时**不携带店长身份**（`ctx.auth.staffWfId / staffName / scopeStoreIds`），即使审计需要追溯"是哪位店长 confirmOffline 触发的赠礼"也查不到。
- 风险：审计链路断裂 —— 真实攻击场景下（如店长拿黑客版小程序伪造 confirmOffline → 资损为目的促成不合规赠礼），日志只记录 share.giftGranted + saleOrderId，无法定位到操作员工，违反 audit-23 v3.3 要求。
- 修复：(L3 helpers) `grantShareGift` 函数签名增 `actor` 参数：
  ```js
  async function grantShareGift(client, order, actor) { ... }
  // 调用方
  await grantShareGift(client, order, { employeeId: ctx.auth.staffWfId, role: 'manager', orgNodeId: ctx.auth.orgNodeId })
  ```
  INSERT 改为含 `operator_employee_id=$5, operator_role=$6, org_node_id=$7`（payNotify 路径传 NULL）。

#### **[P0-19-04]** 分享礼券退款不冲销 / 取消订单不撤销（资损向运营方）
- 文件：取消路径 `staffApi/routes/order.js close`（行 1091-1097）+ `clientApi/routes/order.js cancel`（行 1049-1055）、`closeExpiredOrder`（行 22-27）；退款审批 `staffApi/routes/order.js:1488-1636 approveRefund` + `fengyu-admin/src/actions/refunds.ts:778 approveRefund`
- 现象：grep `sg-inviter` / `sg-invitee` / `sg-msg-` 在所有取消 / 关单 / 退款路径**全 0 命中**。这意味着：
  1. 顾客 A 首单 ¥1000 实付 → 触发 sg-inviter-{orderA}=¥150 + sg-invitee-{orderA}=¥150 发出。
  2. 顾客 A 申请退款，店长审批通过 → 原单 paid 翻回款，但**两张分享礼券保持 `status='未使用'` 永久有效**。
  3. 邀请人 / 新客实际拿到了无对价的优惠券 → 二次下单时被使用 → 运营方资损。
- 同模式：与 audit-13 P0-13-04 / audit-11 P0-11-03（退款不释放 user_coupons）同源 + 进一步加重 —— 不仅"已使用券不释放"，分享礼场景"奖励券不撤销"。
- 风险：单次资损 = 面值 × 2（inviter+invitee）× 退款订单数。若运营把 face_value_override 设到 ¥500 上限，单订单资损 ¥1000。
- 修复：(L3) 在 approveRefund 全额退款分支 + cancel 路径加：
  ```js
  // 撤销分享礼（仅在订单状态允许时）
  await client.query(
    `UPDATE user_coupons SET status='已过期', expire_at=NOW() - INTERVAL '1 second'
     WHERE coupon_id IN ($1, $2) AND status='未使用'`,
    [`sg-inviter-${refSaleOrderId}`, `sg-invitee-${refSaleOrderId}`]
  )
  ```
  或新增 couponStatus='已撤销' 枚举值（参考 ENUM-AUDIT.md E19）。

#### **[P0-19-05]** `bindStore.inviterUserId` 校验仅前缀 + 静默吞错，可越权写邀请关系套利（retain P1-10-09 升级）
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:260-278`
- 现象：仅 `inviterUserId.startsWith('FYGK-')` + 不等于自己 + EXISTS 兜底；`try/catch` 包裹的 `console.warn` 行 275-277 静默失败。攻击者枚举其他真实顾客 user_id（FYGK- 前缀公开，序号可暴力推测）写入自己 `inviter_user_id`。
- 与 P0-19-04 联合放大资损：攻击者用伪造的邀请关系，触发"邀请人"获得 ¥500 上限券；之后可重复提交退款（视 audit-11 退款门控如何）或仅消化券面值 = 单次注册即可获 ¥500 现金等价。
- 升级原因：audit-10 P1-10-09 仅指出"可越权写"，本域报告将其重评 P0 因为：1) 邀请人福利从原来的"软分享激励"变成了 audit-04 后**自动发放 face_value_override 券**，资损可量化；2) 攻击门槛极低（任意客户端登录即可发起）；3) 没有任何冲销路径（P0-19-04）。
- 修复：(L3) 引入"邀请码"机制：
  - 邀请人在分享时由后端签发短期 HMAC token（含 `inviter_user_id + expires_at + nonce`），客户端只能在 bindStore 时回传 token，后端解码验证。
  - 或：在 grantShareGift 内补一道 inviter 校验 —— `inviter` 必须 `bound_store_id IS NOT NULL`（已是有效顾客）+ `created_at` 早于 invitee 一定窗口（如 7 天，防 burst 注册套利）。

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-19-06]** `clientApi/share-gift.js` 是 dead code（永不执行）
- 文件：`fengyu-client/cloudfunctions/clientApi/share-gift.js:1-162` + `clientApi/__tests__/share-gift.test.js:13`（测试文件 require 它）
- 现象：grep `clientApi/index.js` 与 `clientApi/routes/*.js` 全文，无 `require('./share-gift')` 或 `require('../share-gift')`。clientApi 没有任何路由调用 grantShareGift（顾客自付场景由 payNotify 触发；全额抵扣 confirmPrepaidFull 走 paid_amount=0 → grantShareGift 内部 reason='no_paid_amount' 直接 skip 也不需要调用）。
- 设计意图：share-gift.js 三副本注释明确写"必须保持字节级一致"（已验证三份 diff 0 行），但 clientApi 副本留作"未来可能调用"。当前仍是死代码 + 单元测试覆盖，给人"已挂载"的错觉。
- 风险：CC9 测试与迁移残留；维护负担虚高（每次修分享礼必改 3 份，clientApi 那份改了不生效）。
- 修复：(L3 二选一)
  - 选项 A：删 `clientApi/share-gift.js` + 测试文件 + clientApi `package.json` 部署体积减少。
  - 选项 B：把三副本抽成 `cloudfunctions-shared/share-gift.js` symlink 或 monorepo 子包，从根本上消除"3 份字节级一致"维护成本。

#### **[P1-19-07]** `customer.giftHistory` 死 SQL 分支：组合套餐订单永不命中
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:764-772` + 同源 `mgmt-customer.js:717-726`
- 现象：
  ```sql
  SELECT ... FROM sale_orders o
  WHERE ${whereClause}
    AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记
    AND o.status IN ('已支付', '已完成')
  ```
  显式 `AND FALSE` 写死永远不返回，TODO 注释从 v2.1 商品域重构（catalog_items / promotion_schemes 已删）至今未补。前端 `packageCustomer/customer-detail.ts:443` 拿到 `promoOrders=[]` 一律空集，而 `giftItems` 仅取 `received=0` 行不能完整覆盖"组合套餐整单视为赠送"语义。
- 风险：业务漏字段 —— 历史用 `promotion_schemes` 标记的套餐订单展示不到；运营按"赠送记录"做活动核销决策可能漏掉部分订单。
- 修复：(L3) 移除 dead branch + 在 sale_orders 上加 is_bundle 列或在 sale_items.is_bundle_sku=true 行直接展示。或者 (L0) 重新设计组合套餐数据模型（参考 schema-changes S19）。

#### **[P1-19-08]** `customer.assign` 不写 `bound_employee_name` 冗余字段（数据漂移）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:908-911` vs `db/schema/user.ts:33-34`
- 现象：schema 设计 `bound_employee_id` + `bound_employee_name`（"冗余，随 boundEmployeeId 同步写入"），但 assign UPDATE 只写 ID 不写 name：
  ```js
  'UPDATE client_wechat_users SET bound_employee_id = $1, updated_at = NOW() WHERE user_id = $2'
  ```
  分配后 `bound_employee_name` 保留旧值（或 null）→ admin 顾客详情页 / staff customer.detail 行 305-310 通过 ID 反查 staff_wechat_users.name 兜底（OK），但其他直接读 `bound_employee_name` 的位置（grep `bound_employee_name`）会显示错位。
- 风险：CC1 字段同步契约破坏 + UI 闪烁 / 错误提示。
- 修复：(L3) `customer.assign` UPDATE 加 `bound_employee_name = (SELECT name FROM staff_wechat_users WHERE employee_id = $1)`；或全仓改为单字段（DROP `bound_employee_name`，参考 SCHEMA-CHANGES S19）。

#### **[P1-19-09]** `face_value_override` 计算 paid_amount 来源在 `confirmOffline` 多次回款下取 `newPaidAmount` 而非"首单结清当次"
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1001-1006` 调用 `paidAmount: newPaidAmount`
- 现象：`newPaidAmount` 是部分支付链上**累计已付总额**，而 share-gift 设计本意是"首单结清那一笔实付"。当顾客分两次回款（PR-C 多次回款支持）：
  1. 首次回款 ¥300，confirmOffline → status='部分支付'，targetStatus='部分支付' → if 分支不进入（行 997 条件 `targetStatus === '已支付' || '已完成'` 不命中）。
  2. 第二次回款 ¥700，confirmOffline → status='已支付'，targetStatus='已支付' → 进入 grantShareGift，`paidAmount=newPaidAmount=1000`。
  
  结果：算出的 face_value=1000×0.15=¥150，看似 OK。但若顾客在第一次回款后自行去 client.repay 或 staff 补回款，**触发条件可能错位**（依赖 confirmOffline 路径单一性）。
- 同时：share-gift.js 的"首单判定"在第二次回款触发时仍然有效（行 43-49 SELECT COUNT WHERE status IN ('已支付','已完成') AND sale_order_id<>$2 = 0），是因为该订单本身 sale_order_id 被排除；多次回款不破坏首单语义，but 概念上"分批回款"是否仍属"新客首单"的运营定义未被代码捕获。
- 风险：边界场景 face_value 漂移（特别是部分付清时 `confirmOffline` 多次进入 SAVEPOINT，第一次 reason='no_paid_amount' 跳过，第二次成功；幂等由 ON CONFLICT 兜底但 paidAmount 语义已偏移）。
- 修复：(L3) 文档化"首单结清=订单首次进入 status='已支付'"；或在 grantShareGift 入参增 `triggerType: 'final_payment'` 由调用方判断（payNotify / staff / 多次回款 PR-C 各自传值）。

#### **[P1-19-10]** `system_configs` 表无 schema 定义（隐式存在）
- 文件：`fengyu-admin/src/actions/settings.ts:338-344` 包含 `CREATE TABLE IF NOT EXISTS system_configs (...)`，**说明 settings.ts 在 runtime 自建表**；`db/schema/system-config.ts` 是否存在？
- 现象：admin 侧 `saveShareGiftConfig` 每次调用都 `CREATE TABLE IF NOT EXISTS` 兜底；3 个云函数 share-gift.js 直接 `SELECT FROM system_configs WHERE key=...`。表存在与否的契约依赖 admin 先于云函数执行 saveShareGiftConfig 至少一次。
- 风险：CC9 schema 定义缺位 —— 若 admin 从未配置过分享礼，云函数读 system_configs 抛"relation not found"错误，被 SAVEPOINT 吞掉，结果 `granted=false reason='no_config'`（OK）但日志无解释；若团队改 system_configs 列定义（如加 `value_type` 字段），cron / 云函数 / admin 三处皆需手改。
- 修复：(L0 db/schema) 在 `db/schema/system-config.ts` 显式定义 system_configs 表 + 加入 schema/index.ts。或 (L7) admin settings.ts 移除 runtime CREATE，让 schema 迁移负责。

#### **[P1-19-11]** `mgmtCustomer.giftHistory` vs `customer.giftHistory` 双轨实现，配置散落
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:692-781` + `routes/customer.js:748-834`
- 现象：两个 route 几乎是 80% 重复 SQL，差异仅在 scope 守卫层（mgmt 走 management+validateScope，customer 裸奔）。维护双份，将来增字段（如商品图片 cover_url）必须同时改两处，已经在 v2.1 重构后留下 dead `AND FALSE` 分支（P1-19-07）的双份残留。
- 风险：CC9 重复实现导致漂移；audit-10 已建议 customer.* 收口到 mgmtCustomer.* 同方向。
- 修复：(L3 重构) 合并 `customer.giftHistory` → 内部 delegate 给 `mgmtCustomer.giftHistory` 同源 SQL，仅 scope 构造函数不同；同 P0-19-02 的最终修复方向。

#### **[P1-19-12]** 分享礼券 `coupon_id='sg-{role}-{saleOrderId}'` 与 `user_coupons.coupon_id` 主键键空间不规范
- 文件：`fengyu-staff/cloudfunctions/staffApi/share-gift.js:108-110` `INSERT INTO user_coupons (coupon_id, ...) VALUES ($1, ...) ON CONFLICT (coupon_id) DO NOTHING`，$1 = `sg-${role}-${order.saleOrderId}`
- 现象：分享礼券走自定义键空间（`sg-` 前缀 + saleOrderId）；admin issueCoupon / cron 升级权益（`cpn-up-` 前缀）/ 生日（`bday-` 前缀）/ 感恩节（`thx-` 前缀）也各自前缀化。键空间约定散落 4 处，无注册表 / 文档。
- 风险：将来新增运营场景（如转介绍激励 `ref-`）若与已有前缀冲突 → ON CONFLICT 静默 DO NOTHING 跳过 → 用户看不到券。CC1 命名约定缺位。
- 修复：(L0/L3) 在 `db/schema/coupon.ts` 注释里建立 `coupon_id` 前缀注册表（sg-/cpn-up-/bday-/thx-/ref-...），新增前缀必修注释。

---

### 3.3 P2（代码质量 / 可维护）

- **[P2-19-13]** share-gift.js 三副本注释（行 7-10）声明"必须保持字节级一致"但无 lint/CI 守护：未来某一份漂移半行就会被发现得很晚。建议加 `db/scripts/check-share-gift-consistency.sh` 跑 diff。
- **[P2-19-14]** `messageInviterTitle` 为空时 `console.warn` 单独跳过该条但另一条照发（行 127-130），UX 上邀请人没收到通知顾客可能困惑；admin UI 仅红字"标题为空，不发送"占位（行 296-310）但保存时不阻止保存（仅 `if (!config.couponTemplateId)` 阻止保存，行 73-76）。
- **[P2-19-15]** `clientApi/routes/auth.js:275-277` `console.warn('bind inviter failed (non-fatal):', err.message)` 静默吞错，无法区分 SQL 报错 / 数据库连接断 / 自邀 CHECK 触发，运维难以定位。建议至少分级 + 写 operation_logs 预警通道。
- **[P2-19-16]** `customer.assign` 错误前缀 `INVALID_PARAMS: 员工不存在或不属于本门店`（行 905）混淆了"不存在"与"不在 scope"，按约定应为 `PERMISSION_DENIED`（CC5）。
- **[P2-19-17]** share-gift `face_value_override` 在 `clamp` 时若 `cfg.maxFaceValue` 配置成 0 会触发"max=500 兜底"（行 85），与 admin UI normalizeShareGiftConfig 保证 min<=max（lib/share-gift-config.ts:73-79 自动交换）形成冗余 —— 任一处可信即可，但保留 fallback OK；建议在配置归一化层（lib/share-gift-config.ts）锁死 0<min<max≤MAX_LIMIT 后 share-gift.js 简化。
- **[P2-19-18]** 配置缺"单顾客累计领取上限"字段：当前以 sale_order_id 幂等，同一顾客邀请 N 个新客即可获 N 张券，无封顶；ticket §5.2 未覆盖该场景，admin UI 也无字段。建议加 `maxPerUserPerMonth` 配置 + cron 监控。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| share-gift 调用站点 | — | confirmOffline 调用 ✅ | **dead code（永不调用）** | handleSuccess 调用 ✅ | 维护负担 | P1（P1-19-06）|
| share-gift 函数版本一致 | — | byte-identical ✅ | byte-identical ✅ | byte-identical ✅ | 三份漂移高危 | P2（P2-19-13）|
| inviter 校验严格度 | N/A | N/A | startsWith('FYGK-') + EXISTS only | 不校验 inviter 自身真实性 | 越权 + 资损 | P0（P0-19-05）|
| 赠送记录 scope | — | giftHistory 零 scope ❌ | — | — | PII / 跨店读 | P0（P0-19-02）|
| 赠送记录 scope（管理层） | — | mgmtCustomer.giftHistory 走 validateScope ✅ | — | — | 正例 | — |
| customer.assign scope | — | requireManager + 同店员工 ✅，**不查顾客 scope ❌** | — | — | 业绩资损 | P0（P0-19-01）|
| share-gift 退款冲销 | approveRefund 不撤销券 ❌ | approveRefund 不撤销券 ❌ | — | — | 资损 | P0（P0-19-04）|
| operation_logs operator_employee_id | logUpdate 自带 actor ✅ | grantShareGift 不传 actor ❌ | grantShareGift 不传 actor ❌ | grantShareGift 不传 actor ✅（系统级合理）| 审计断裂 | P0（P0-19-03）|
| paid_amount 来源（首单结清判定）| N/A | newPaidAmount（累计）| — | thisPayAmount（单次）| 多次回款语义漂移 | P1（P1-19-09）|
| 分享礼配置面板 | 启用 + 文案 ✅ | — | — | — | 单端配置 OK | — |
| 分享礼券前缀注册 | 无文档 | sg- 前缀 | sg- 前缀 | sg- 前缀 | 命名空间冲突隐患 | P1（P1-19-12）|

---

## 5. 横切检查（套用 §3 模板）

- [x] **CC1 数值精度**：face_value `Math.round(raw*100)/100`（行 83），clamp 到 [minFaceValue, maxFaceValue]（行 86）OK。`bound_employee_name` 同步丢失影响命名一致性 → P1-19-08。
- [ ] **CC2 并发幂等**：
  - [x] 分享礼 user_coupons ON CONFLICT (coupon_id) DO NOTHING ✅
  - [x] 分享礼 messages ON CONFLICT (idempotency_key) DO NOTHING ✅
  - [x] SAVEPOINT sp_share_gift 隔离失败 ✅
  - [ ] customer.assign 无 CAS 守卫，UPDATE WHERE user_id=$2 不带 bound_store_id 守卫 → P0-19-01
  - [ ] inviter 绑定 try/catch 静默吞错 → P2-19-15
- [ ] **CC3 组织域数据隔离**：
  - [ ] customer.giftHistory 零 store/scope 过滤 → P0-19-02
  - [ ] customer.assign 不校验顾客 bound_store ∈ scope → P0-19-01
- [ ] **CC4 后端鉴权**：
  - [x] requireManager / requireStaffBound / requirePermission('system:config') 都有
  - [ ] inviterUserId 仅信任前端前缀字符串 → P0-19-05
- [x] **CC5 错误码**：四种前缀基本规范，customer.assign 误用 INVALID_PARAMS → P2-19-16
- [ ] **CC6 PII**：customer.giftHistory 跨店暴露顾客全国消费足迹 → P0-19-02 加重
- [x] **CC7 时间字段**：created_at 由 DB DEFAULT；invited_at = NOW() 由 SQL 写入；expire_at 由应用层算（Date.now()+days*86400000，UTC 与 PG `valid_to` 时区不一致漂移在 audit-13 已记，本域不重复）
- [x] **CC8 WXML/Vant**：admin UI 仅 share-gift-page 单页，前端无 WXML 分歧
- [ ] **CC9 测试与残留**：
  - [ ] clientApi/share-gift.js dead code（P1-19-06）
  - [ ] customer.giftHistory `AND FALSE` dead branch（P1-19-07）
  - [ ] customer.giftHistory vs mgmtCustomer.giftHistory 重复实现（P1-19-11）
  - [ ] system_configs 缺 schema 定义（P1-19-10）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/system-config.ts` 新建 | 显式定义 system_configs 表 | P1-19-10 |
| L0 schema | `db/schema/coupon.ts` 注释加前缀注册表 | sg-/cpn-up-/bday-/thx- 命名空间 | P1-19-12 |
| L0 schema | `db/schema/coupon.ts:8` couponStatusEnum | 加 `已撤销` 值（替代 expire_at hack）| P0-19-04 |
| L0 schema | `db/schema/user.ts:33-34` | 评估 DROP `bound_employee_name`（冗余，从 staff_wechat_users JOIN 取） | P1-19-08 |
| L0 schema | `db/schema/operation-log.ts` 加 partial unique on (action, target_id) where action='share.giftGranted' | 防止重发幂等突破 | P0-19-03 |
| L3 cloudfunctions | `staffApi/routes/customer.js:892-920 assign` | 加顾客 scope 校验 + bound_store_id CAS + operation_logs | P0-19-01 |
| L3 cloudfunctions | `staffApi/routes/customer.js:748-834 giftHistory` | 收口到 mgmtCustomer.giftHistory 或加 store_id 过滤 | P0-19-02 / P1-19-11 / P1-19-07 |
| L3 cloudfunctions | `share-gift.js × 3` 函数签名加 actor 参数 | INSERT operation_logs 携带 employee_id + role + org_node_id | P0-19-03 |
| L3 cloudfunctions | `staffApi/order.js approveRefund` + `clientApi/order.js cancel` + `closeExpiredOrder` | 撤销分享礼 sg- 前缀券 | P0-19-04 |
| L3 cloudfunctions | `clientApi/routes/auth.js:260-278 bindStore` | 引入邀请码 token 或 inviter 资格深度校验 | P0-19-05 |
| L3 cloudfunctions | 删 `clientApi/share-gift.js` + `__tests__/share-gift.test.js` 或抽 monorepo shared | 消除三副本维护 | P1-19-06 / P2-19-13 |
| L7 admin | `actions/settings.ts:296-369` | 加 `maxPerUserPerMonth` 字段 + 移除 runtime CREATE TABLE | P2-19-18 / P1-19-10 |
| L9 前端 | `miniprogram/pages/customer-list/customer-list.ts:200-240` | UI loading 防重复 onAssignSelect | P2-19-15 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (1) 验证 customer.assign 跨店分配漏洞 — 找出 bound_employee_id.store_id ≠ bound_store_id 的脏数据
SELECT c.user_id, c.phone, c.name,
       c.bound_store_id AS customer_store,
       sw.employee_id, sw.store_id AS employee_store,
       c.bound_employee_id, c.updated_at
FROM client_wechat_users c
JOIN staff_wechat_users sw ON sw.employee_id = c.bound_employee_id
WHERE c.bound_store_id IS NOT NULL
  AND sw.store_id IS NOT NULL
  AND c.bound_store_id <> sw.store_id
ORDER BY c.updated_at DESC
LIMIT 50;

-- (2) 验证分享礼券发放后退款是否冲销
SELECT uc.coupon_id, uc.user_id, uc.status, uc.expire_at, uc.face_value_override,
       so.sale_order_id AS ref_order_status
FROM user_coupons uc
LEFT JOIN sale_orders so ON so.sale_order_id = REPLACE(REPLACE(uc.coupon_id, 'sg-inviter-', ''), 'sg-invitee-', '')
WHERE uc.coupon_id LIKE 'sg-%'
  AND uc.status = '未使用'
  AND so.status NOT IN ('已支付', '已完成')   -- 原单已退款 / 已关闭仍有未使用券
LIMIT 100;

-- (3) 验证 inviter 关系自邀绕过（CHECK 是否生效）
SELECT user_id, inviter_user_id, invited_at
FROM client_wechat_users
WHERE inviter_user_id = user_id;  -- 应该 0 行（chk_inviter_not_self）

-- (4) 验证 share.giftGranted operation_logs 缺 operator_employee_id
SELECT id, action, target_id, operator_employee_id, source, created_at
FROM operation_logs
WHERE action = 'share.giftGranted'
ORDER BY created_at DESC
LIMIT 20;
-- 预期：staffApi 来源全部 operator_employee_id=NULL（应有但缺失）

-- (5) 验证 customer.giftHistory 跨店暴露范围（顾客在多少个不同 store 有 gift items）
SELECT c.user_id, c.phone, c.bound_store_id AS home_store,
       array_agg(DISTINCT o.store_id) AS stores_with_gifts,
       count(DISTINCT o.store_id) AS store_count
FROM client_wechat_users c
JOIN sale_orders o ON o.client_user_id = c.user_id
JOIN sale_items si ON si.sale_order_id = o.sale_order_id
WHERE o.status IN ('已支付', '已完成')
  AND si.received::numeric = 0
  AND si.item_direction = '购买'
GROUP BY c.user_id, c.phone, c.bound_store_id
HAVING count(DISTINCT o.store_id) > 1
LIMIT 50;
```

---

## 8. 回归测试用例（建议）

1. **assign cross-store guard**：mgrA 拥有 store-X+store-Y 双绑定，loginLevel='store' currentStoreId=store-X，调用 assign 传 clientUserId（属 store-Y）+ employeeId（属 store-X）→ 应返回 PERMISSION_DENIED；切到 mgmt loginLevel='management' 应允许（如果 storeY ∈ scope）。
2. **giftHistory store filter**：员工 emp-X 绑店 store-X，手机号 phone-Y 属于 store-Y 顾客 → 调用 customer.giftHistory(phone=phone-Y) 应返回空集（store-X 内顾客无该 phone）。
3. **share-gift refund revoke**：触发首单完成 → 校验 sg-inviter / sg-invitee 各 1 张未使用；审批退款 → 校验两张 user_coupons.status='已撤销'。
4. **inviter qualification**：构造 inviter 注册 < 1 小时即被设为邀请人 → 配置 `inviterMustHavePaidOrder=true` → grantShareGift 返回 reason='inviter_not_qualified'；inviter 自身 bound_store_id IS NULL → 返回 reason 含拒绝。
5. **operation_logs operator_employee_id**：staffApi.confirmOffline 触发 share.giftGranted → 校验 operation_logs 该行 operator_employee_id 非 NULL，等于 ctx.auth.staffWfId。
6. **bindStore inviter**：传 inviterUserId='FYGK-XXXX'（不存在）→ EXISTS 兜底应使 UPDATE 影响 0 行；传 inviterUserId 等于 self → CHECK 阻止；传 inviterUserId 已设过 → WHERE inviter_user_id IS NULL 守卫拒绝二次写。
7. **share-gift idempotency**：两次连续 confirmOffline 同一 saleOrderId → user_coupons 行数 = 2（不增加），messages 行数 = 2，operation_logs 行数 = 2（每次都写一条审计）→ 警告：是否 operation_logs 也应幂等？

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB + cron）：☑（admin 改配置 + 三端 share-gift.js + 退款审批冲销 + cron 守护）
- 涉及历史数据：☑（已发放的"无对价分享礼券"需要回收 / 历史 cross-store 分配脏数据需要清洗）
- 修复成本：M（单 P0 1-2 天，5 个 P0 集合需要 1 周）

---

## 10. 后续待办

- [ ] 把 P0-19-01 / P0-19-02 / P0-19-04 与 P0-10-04 / P0-13-04 合并到统一退款 / scope 守卫修复 ticket
- [ ] 对 inviter_user_id 历史数据做一次审计（grep 自邀 / 跨店异常邀请关系）
- [ ] 与运营对齐"分享礼券是否随退款撤销"的合规口径（用户已收到通知再撤销可能引起客诉）
- [ ] 评估 system_configs 表是否纳入 baseline reset（migration 0xxx 新增显式表定义）
- [ ] 抽 cloudfunctions-shared 共享模块消除三副本（涉及 cloudbase-deploy 改动）
