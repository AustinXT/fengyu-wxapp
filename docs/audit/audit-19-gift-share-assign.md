# 审计报告：赠送 / 分享 / 客户分配 (19)

**审计时间**：2026-04-26
**域 ID**：19
**slug**：gift-share-assign
**审计员**：claude-sonnet-4-6
**审计时长**：~30 分钟（重新审计，代码为准，独立判断）
**关联 PR/Ticket**：notes/tickets/2026-04-24-share-gift-reward.md（PR-2 share-gift-reward）；audit-04 / audit-10 / audit-13 关联 P0
**规范版本**：`real.md` v3.1.0（命中 #5 后端鉴权 / #6 组织域数据隔离 / #3 支付幂等）

---

## 1. 三端入口对照

| 层 | admin | staff | client | payNotify |
|----|-------|-------|--------|-----------|
| Schema 顾客 | `db/schema/user.ts:32-47` clientWechatUsers（bound_employee_id/bound_employee_name/inviter_user_id） | ↑ | ↑ | ↑ |
| Schema 券模板 / 用户券 | `db/schema/coupon.ts` couponTemplates + userCoupons | ↑ | ↑ | ↑ |
| Schema 消息 | `db/schema/message.ts` | ↑ | ↑ | ↑ |
| Schema 操作日志 | `db/schema/operation-log.ts:16-41`（operator_employee_id, org_node_id NOT NULL 字段均可为空） | ↑ | ↑ | ↑ |
| Schema 系统配置 | `db/schema/system-config.ts:1-14` **已有显式定义**（key PK + value + updated_at）| ↑ | ↑ | ↑ |
| 分享礼配置页面 | `fengyu-admin/src/app/(main)/share-gift/_components/share-gift-page.tsx` | — | — | — |
| 分享礼配置 actions | `fengyu-admin/src/actions/settings.ts:128-357`（getShareGiftConfig / saveShareGiftConfig）—— **仍有 runtime `CREATE TABLE IF NOT EXISTS system_configs`（行 155、339）** | — | — | — |
| 分享礼发放 helper（3 副本字节级一致） | — | `staffApi/share-gift.js:20-161` | `clientApi/share-gift.js:20-161` | `payNotify/share-gift.js:20-161` |
| 分享礼发放调用站点 | — | `staffApi/routes/order.js:1029-1049` confirmOffline SAVEPOINT | **未挂载（dead code）**，clientApi index.js / routes/*.js 无 require('./share-gift') | `payNotify/index.js` SAVEPOINT |
| 邀请关系绑定 | — | — | `clientApi/routes/auth.js:260-278` bindStore 含 inviterUserId 一次性绑定 | — |
| 赠送记录查询（门店模式） | — | `staffApi/routes/customer.js:823-908` `customer.giftHistory`（仅 requireStaffBound，**零 store/scope 过滤**） | — | — |
| 赠送记录查询（管理层模式） | — | `staffApi/routes/mgmt-customer.js:692-790` `mgmtCustomer.giftHistory`（requireManagementLevel + validateScope + buildSaleScope，正例） | — | — |
| 客户分配 | — | `staffApi/routes/customer.js:967-995` `customer.assign`（requireManager + 员工同店，**不校验顾客 bound_store_id scope，无 operation_logs**） | — | — |
| 退款 cascade helper | `fengyu-admin/src/lib/refund-cascade.ts:119-133` 通道 3 user_coupons 恢复（仅 status='已使用' 的券，**不含 sg- 分享礼券**） | `staffApi/helpers/refund-cascade.js` 通道 3 同逻辑（**不含 sg- 分享礼券**） | — | — |
| 前端入口（员工端长按分配） | — | `miniprogram/pages/customer-list/customer-list.ts:200-240` onLongPressAssign / onAssignSelect | — | — |
| 前端入口（赠送记录 Tab） | — | `miniprogram/packageCustomer/customer-detail/customer-detail.ts` loadGiftHistory | — | — |
| 测试 | `src/actions/settings.test.ts` | — | `clientApi/__tests__/share-gift.test.js`（覆盖 dead-code 副本，未挂载） | — |

---

## 2. 数据流图

```
[配置侧]
admin (system:config) → settings.saveShareGiftConfig → system_configs.share_gift_config (JSON UPSERT)
                       ⚠ 同时 runtime CREATE TABLE IF NOT EXISTS（冗余，schema 已有定义）

[邀请关系绑定]
client.bindStore (inviterUserId='FYGK-XXX') ──────────────────────────────────────────────────────┐
  → 仅前缀校验 startsWith('FYGK-') + 不等于 self + EXISTS 子查询                                │
  → UPDATE inviter_user_id WHERE inviter_user_id IS NULL                                          │
  → try/catch 静默失败，无 operation_logs                                                         │
  ⚠ 攻击者可枚举他人 user_id 写入邀请关系（P0-19-05）                                            │

[分享礼发放侧]                                                                                    │
clientApi.order → payNotify.handleSuccess (SAVEPOINT sp_share_gift)                               │
                       → grantShareGift(client, {saleOrderId, clientUserId, paidAmount, source})  │
staffApi.order.confirmOffline (SAVEPOINT sp_share_gift)                                           │
                       → grantShareGift(client, {saleOrderId, clientUserId, paidAmount:'newReceived', source:'staffApi'})

grantShareGift 内部流程（share-gift.js）：
  0. paid_amount > 0 校验
  1. SELECT FROM system_configs WHERE key='share_gift_config'
  2. COUNT(sale_orders WHERE client_user_id=$1 AND status∈('已支付','已完成') AND saleOrderId<>$2) = 0（首单判定）
  3. SELECT inviter_user_id FROM client_wechat_users WHERE user_id=$1
  4. 可选：inviterMustHavePaidOrder 资格校验
  5. SELECT coupon_templates WHERE template_id=$1 AND is_active
  6. face_value = clamp(paid * percent, min, max)
  7. expireAt 计算
  8. INSERT user_coupons(coupon_id=sg-inviter/sg-invitee-{saleOrderId}) × 2，ON CONFLICT DO NOTHING
  9. INSERT messages × 2，ON CONFLICT idempotency_key DO NOTHING
  10. INSERT operation_logs(action='share.giftGranted')
      ⚠ INSERT 不含 operator_employee_id / org_node_id（P0-19-03）

[退款/取消侧] ← 关键缺口：sg- 分享礼券不在任何撤销路径内
staffApi.approveRefund → cascadeRefund 通道 3：
  UPDATE user_coupons SET status='未使用' WHERE used_sale_order_id=$1 AND status='已使用'
  ⚠ sg- 分享礼券 coupon_id = 'sg-{role}-{saleOrderId}'，从未写 used_sale_order_id
    且 status='未使用'（从未被"使用"），不在通道 3 范围内，永远不被撤销（P0-19-04）

[客户分配]
staff.customer-list onLongPressAssign → callStaffApi('customer.assign', {clientUserId, employeeId})
  → requireManager()                           ✅（店长角色已验证）
  → SELECT employee WHERE store_id = effectiveStoreId  ✅（员工同店校验）
  → UPDATE client_wechat_users SET bound_employee_id=$1 WHERE user_id=$2
    ⚠ 无顾客 bound_store_id ∈ scope 校验（P0-19-01）
    ⚠ 无 operation_logs（P0-19-01）
    ⚠ 不同步 bound_employee_name（P1-19-08）

[赠送记录读取]
staff.customer-detail loadGiftHistory → customer.giftHistory(clientUserId)
  → requireStaffBound() ✅
  → SELECT FROM sale_orders WHERE client_user_id=$1 AND status∈('已支付','已完成')
    ⚠ 完全不带 store_id 过滤，跨店全局可读（P0-19-02）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-19-01]** `customer.assign` 不校验顾客 bound_store_id scope + 无审计日志
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:967-995`
- 现象（代码已验证）：
  ```js
  // 仅校验员工同店
  const staffRows = await pg.query(
    'SELECT employee_id, name FROM staff_wechat_users WHERE employee_id = $1 AND store_id = $2',
    [employeeId, ctx.auth.effectiveStoreId]
  )
  // UPDATE 无 bound_store_id 守卫
  const result = await pg.query(
    'UPDATE client_wechat_users SET bound_employee_id = $1, updated_at = NOW() WHERE user_id = $2',
    [employeeId, clientUserId]
  )
  ```
  `requireManager()` 通过即可，UPDATE 仅 `WHERE user_id = $2`，不约束顾客 `bound_store_id ∈ ctx.auth.effectiveStoreId`。
  员工同店校验（行 975-981）只防"把顾客分给非本店员工"，不防"把别店顾客拉到本店员工名下"。
  攻击路径：多店店长 mgrA loginLevel='store' 切到 store-X，通过 `customer.search` 按手机号（行 41，仅 `bound_store_id IS NOT NULL` 约束，无 store_id 过滤）拿到属于 store-Y 顾客 B 的 `user_id`，调 `customer.assign` 传 `clientUserId=B, employeeId=storeX美容师`，UPDATE 成功 → B 的 `bound_employee_id` 被改写。
  operation_logs 未写（行 967-995 全部）。
- 风险：顾客归属错改（业绩资损）+ 无审计追溯，违反 real.md #5/#6 + v3.3 audit 要求。
- 复现：1) 多店店长 mgrA 有 store-X / store-Y 双绑定；2) loginLevel='store' 切到 store-X；3) `customer.search` 按手机号拿到 store-Y 顾客 B 的 `clientUserId`；4) 调 `customer.assign({clientUserId: B, employeeId: storeX员工})`；5) DB 查 `bound_employee_id` 已被改写，但 `bound_store_id` 仍是 store-Y → 数据脏。
- 修复：(L3 staffApi/routes/customer.js)
  ```js
  // 1) 读顾客门店并校验 scope
  const custRows = await pg.query(
    'SELECT bound_store_id FROM client_wechat_users WHERE user_id = $1',
    [clientUserId]
  )
  if (custRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const custStoreId = custRows[0].bound_store_id
  if (!custStoreId || custStoreId !== ctx.auth.effectiveStoreId) {
    throw new Error('PERMISSION_DENIED: 仅可分配本店顾客')
  }
  // 2) UPDATE 加 bound_store_id CAS 守卫
  const result = await pg.query(
    'UPDATE client_wechat_users SET bound_employee_id=$1, updated_at=NOW() WHERE user_id=$2 AND bound_store_id=$3',
    [employeeId, clientUserId, ctx.auth.effectiveStoreId]
  )
  // 3) 写 operation_logs
  await pg.query(
    `INSERT INTO operation_logs (operator_employee_id, action, target_type, target_id, detail, source, created_at)
     VALUES ($1,'customer.assign','client_wechat_users',$2,$3::jsonb,'staffApi',NOW())`,
    [ctx.auth.staffWfId, clientUserId, JSON.stringify({employeeId, storeId: ctx.auth.effectiveStoreId})]
  )
  ```

#### **[P0-19-02]** `customer.giftHistory` 完全无 store/scope 过滤（跨店数据泄露）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:823-908`
- 现象（代码已验证）：
  ```js
  // whereClause 仅按 client_user_id 或 client_phone 过滤
  if (clientUserId) {
    whereClause = "o.client_user_id = $1"
    params = [clientUserId]
  } else {
    whereClause = "o.client_phone = $1"
    params = [clientPhone]
  }
  // giftItems 查询：无任何 o.store_id 条件
  const giftItems = await pg.query(`
    SELECT ... FROM sale_items si JOIN sale_orders o ...
    WHERE ${whereClause} AND o.status IN ('已支付', '已完成') ...
  `, params)
  ```
  同模块 `paidOrders`（行 428-432）明确加 `AND o.store_id = $2`，形成同文件双轨；`mgmtCustomer.giftHistory`（行 712-742）通过 buildSaleScope 正确过滤（正例对比）。
- 风险：组织域数据隔离崩溃（real.md #6）；CC6 PII 泄漏——任意已绑店员工知道顾客 phone/user_id 即可拉到全国所有门店的赠品明细（总金额、SKU、剩余次数、paid_at）。
- 复现：1) 员工 emp-X 绑店 store-X；2) 拿到顾客 B（绑店 store-Y）的 user_id；3) 调 `customer.giftHistory({clientUserId: B.user_id})`；4) 返回 store-Y 的 giftItems 完整集合。
- 修复：(L3) 引入 `buildStoreScopeCondition(ctx.auth, 'o.store_id', $n)`——门店模式单值（`AND o.store_id = $n`），管理层模式 ANY(scopeStoreIds)；与 `paidOrders` 保持一致。或下线 `customer.giftHistory`，统一走 `mgmtCustomer.giftHistory`。

#### **[P0-19-03]** `grantShareGift` 写 operation_logs 不含 operator_employee_id / org_node_id（审计链路断裂）
- 文件：`fengyu-staff/cloudfunctions/staffApi/share-gift.js:139-156`、`fengyu-client/cloudfunctions/payNotify/share-gift.js:139-156`（三副本字节级一致，diff 0 行已验证）
- 现象（代码已验证）：
  ```js
  await client.query(
    `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
     VALUES ('share.giftGranted', 'sale_order', $1, $2::jsonb, $3, NOW())`,
    [order.saleOrderId, JSON.stringify({...}), order.source || 'payNotify']
  )
  ```
  INSERT 仅写 action / target_type / target_id / detail / source / created_at；
  `operator_employee_id`、`operator_role`、`org_node_id` 完全缺失。
  - payNotify 路径（系统级触发）：operator_employee_id=NULL 可接受。
  - staffApi 路径（`confirmOffline` 由店长触发）：调用站点传 `source: 'staffApi'`，但 grantShareGift 函数签名 `function grantShareGift(client, order)` 不接收 actor，导致审计无法追溯"哪位店长触发了该赠礼"。
- 风险：审计链路断裂——伪造 confirmOffline 触发分享礼时无从定位操作者，违反 v3.3 操作日志要求（domain 23 P0-23-01 同族）。
- 修复：(L3 helpers) 函数签名增 `actor` 参数：
  ```js
  async function grantShareGift(client, order, actor) { ... }
  // staffApi 调用站点传入 actor
  await grantShareGift(client, {...}, { employeeId: ctx.auth.staffWfId, role: 'manager' })
  // INSERT operation_logs 加 operator_employee_id=$4
  await client.query(
    `INSERT INTO operation_logs
      (action, target_type, target_id, operator_employee_id, detail, source, created_at)
     VALUES ('share.giftGranted','sale_order',$1,$2,$3::jsonb,$4,NOW())`,
    [order.saleOrderId, actor?.employeeId || null, JSON.stringify({...}), order.source || 'payNotify']
  )
  ```

#### **[P0-19-04]** 分享礼 sg- 券退款 / 取消时完全不撤销（资损向运营方）
- 文件：退款通道 `staffApi/helpers/refund-cascade.js`（行 119-133）；`fengyu-admin/src/lib/refund-cascade.ts`（行 119-133）；取消通道 `staffApi/routes/order.js close`（行 1124-1130）；`clientApi/routes/order.js cancel`（行 1139）；`payNotify/index.js closeExpiredOrder`（行 23-29）
- 现象（代码已验证）：
  - cascadeRefund 通道 3（两端均已验证）仅撤销 `status='已使用' AND used_sale_order_id=$saleOrderId` 的券；
  - sg- 分享礼券 `coupon_id = 'sg-inviter-{saleOrderId}'`，在发放时直接 `status='未使用'`，从未设置 `used_sale_order_id`；
  - 因此通道 3 的 WHERE 条件命中零行，退款时 sg- 券保持 `status='未使用'` 永久有效；
  - grep `sg-inviter\|sg-invitee` 在所有取消/关单/退款路径全 0 命中（代码已验证）。
  
  场景：顾客首单 ¥1000 → 触发 sg-inviter + sg-invitee 各 1 张（如 ¥150）→ 申请退款审批通过 → 两张券保持有效 → 邀请人 / 新客消费券 → 运营资损 ¥300/笔。
- 风险：单次资损 = faceValue × 2 × 退款订单数；faceValue 上限 cfg.maxFaceValue（默认 500）→ 最大 ¥1000/笔。
- 修复：(L3) 在 staffApi cascadeRefund + admin cascadeRefund + cancel + closeExpiredOrder 路径加撤销逻辑：
  ```sql
  UPDATE user_coupons
     SET status = '已过期', expire_at = NOW() - INTERVAL '1 second', updated_at = NOW()
   WHERE coupon_id IN ('sg-inviter-'||$1, 'sg-invitee-'||$1)
     AND status = '未使用'
  ```
  或新增 couponStatus='已撤销' 枚举值（详见 ENUM-AUDIT.md E19）。

#### **[P0-19-05]** `bindStore.inviterUserId` 仅前缀校验 + 静默吞错，可越权写邀请关系套利
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:260-278`
- 现象（代码已验证）：
  ```js
  if (
    inviterUserId && typeof inviterUserId === 'string' &&
    inviterUserId.startsWith('FYGK-') &&
    inviterUserId !== users[0].user_id
  ) {
    try {
      await pg.query(`UPDATE client_wechat_users SET inviter_user_id = $1 ...
        WHERE user_id = $2 AND inviter_user_id IS NULL
        AND EXISTS (SELECT 1 FROM client_wechat_users WHERE user_id = $1)`,
        [inviterUserId, users[0].user_id])
    } catch (err) { console.warn(...) }  // ← 静默失败
  }
  ```
  攻击者可枚举 FYGK- 前缀 + 任意序号写入自己的 inviter_user_id；与 P0-19-04 联合放大：退款不撤销分享礼券，使伪造邀请关系套利完全无风险（单注册可获 ¥500 等值券）。
- 风险：越权写邀请关系 + 分享礼资损可量化（face_value × inviter 端，上限 cfg.maxFaceValue）。
- 修复：(L3) 引入签名邀请码（HMAC token 含 inviter_user_id + expiry + nonce）；或在 grantShareGift 内补 inviter 资格深度校验（bound_store_id IS NOT NULL + 注册时间 > invitee 一定窗口）。

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-19-06]** `clientApi/share-gift.js` 是 dead code（永不执行）
- 文件：`fengyu-client/cloudfunctions/clientApi/share-gift.js:1-162`（161 行，与 payNotify/staffApi diff 0）
  `clientApi/__tests__/share-gift.test.js`（测试文件 require 它）
- 现象（代码已验证）：grep `clientApi/index.js` 与 `clientApi/routes/*.js` 全文无 `require('./share-gift')` 或 `require('../share-gift')`；clientApi 无任何路由调用 grantShareGift。
- 风险：CC9 测试与迁移残留；维护成本虚高（每次修改必改 3 份，clientApi 那份改了不生效）。
- 修复：(L3 二选一)
  - 选项 A：删 `clientApi/share-gift.js` + `__tests__/share-gift.test.js`；
  - 选项 B：抽 monorepo shared 包消除 3 副本维护成本（联动 cloudbase-deploy 改动）。

#### **[P1-19-07]** `customer.giftHistory` 中 promoOrders 分支 `AND FALSE` 永不命中（dead SQL）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:839-848`；同源 `mgmt-customer.js:717-726`
- 现象（代码已验证）：
  ```sql
  AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记
  ```
  promoOrders 查询永远返回空集；前端拿到 `promoOrders=[]` 且无错误提示。v2.1 商品域重构（catalog_items/promotion_schemes 已删）至今 TODO 未补。
- 风险：运营"赠送记录"看板缺失历史套餐数据；`mgmt-customer.js` 同样存在，双重残留。
- 修复：(L3) 移除 dead branch；若"组合套餐整单视为赠送"仍有业务价值，需在 sale_orders/sale_items 上加 is_bundle 标记（参考 SCHEMA-CHANGES S19）。

#### **[P1-19-08]** `customer.assign` 不同步 `bound_employee_name` 冗余字段（数据漂移）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:983-985`；`db/schema/user.ts:34`
- 现象（代码已验证）：
  ```js
  await pg.query(
    'UPDATE client_wechat_users SET bound_employee_id = $1, updated_at = NOW() WHERE user_id = $2',
    [employeeId, clientUserId]
  )
  // bound_employee_name 未同步写入
  ```
  schema 中 `bound_employee_name` 注释为"冗余，随 boundEmployeeId 同步写入"，但 assign 只写 ID 不写 name。
- 风险：直接读 `bound_employee_name` 字段的位置显示旧值或 null；UI 闪烁 / 错位。
- 修复：(L3) assign UPDATE 加 `bound_employee_name = (SELECT name FROM staff_wechat_users WHERE employee_id = $1)`；或全仓 DROP `bound_employee_name`（参考 SCHEMA-CHANGES S19）。

#### **[P1-19-09]** `confirmOffline` 分享礼 `paidAmount` 用累计已付总额而非"当次结清金额"
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1033-1038`
- 现象（代码已验证）：
  ```js
  const sgRes = await grantShareGift(client, {
    saleOrderId,
    clientUserId: order.client_user_id,
    paidAmount: newReceived,  // ← 累计已付总额（含之前回款）
    source: 'staffApi',
  })
  ```
  `newReceived` 是订单累计已收金额（多次回款之和），payNotify 路径传的是当次支付金额。多次回款场景下第二次触发时 paidAmount 可能偏高 → face_value = 总额 × percent 而非本次实付 × percent，语义漂移。
- 风险：面值计算口径与 payNotify 路径不一致（分两次回款 vs 一次支付 face_value 可能相同，但特殊场景下有差异）。
- 修复：(L3) 文档化"首单结清 = 订单首次进入 status='已支付' 的那次 confirmAmount"；grantShareGift 增 triggerType 参数便于追溯；或改传 `confirmAmount`（当次金额）。

#### **[P1-19-10]** `system_configs` 表在 admin settings.ts 仍有 runtime `CREATE TABLE IF NOT EXISTS`（冗余，schema 已有显式定义）
- 文件：`fengyu-admin/src/actions/settings.ts:155`、`:339`、`:402`（三处 CREATE TABLE IF NOT EXISTS）；`db/schema/system-config.ts:1-14`（已有显式定义）
- 现象（代码已验证）：`db/schema/system-config.ts` 已有 Drizzle table 定义（被 migration 管理），但 settings.ts 内还留着 runtime DDL 作为历史遗留保险。
- 风险：维护两套 schema 定义来源；若 migration 先于 admin 首次配置运行，runtime DDL 冗余执行但不影响功能；若 admin 先于 migration 启动，可能造成表结构不一致（缺 migration 约束）。CC9 代码质量问题。
- 修复：(L7 admin actions/settings.ts) 移除三处 `CREATE TABLE IF NOT EXISTS system_configs`，完全依赖 migration 管理表结构。

#### **[P1-19-11]** `customer.giftHistory` 与 `mgmtCustomer.giftHistory` 双轨实现（80% 重复 SQL）
- 文件：`staffApi/routes/customer.js:823-908`；`staffApi/routes/mgmt-customer.js:692-790`
- 现象（代码已验证）：两个实现差异仅在 scope 守卫层（customer.* 裸奔，mgmtCustomer.* 走 validateScope）。`AND FALSE` dead branch 也双份残留（P1-19-07 同族）。
- 风险：将来增字段必须同时改两处，已在 v2.1 重构后留下 dead branch 双份。CC9 重复实现。
- 修复：(L3) 合并 `customer.giftHistory` 内部 delegate 给 mgmtCustomer 的 SQL helper，仅 scope 构造函数不同；同 P0-19-02 最终修复方向对齐。

#### **[P1-19-12]** 分享礼券 `coupon_id='sg-{role}-{saleOrderId}'` 前缀键空间无注册表
- 文件：`staffApi/share-gift.js:109`（sg-inviter/sg-invitee 前缀）；同 admin cron-step grant-birthday-benefits（bday- 前缀）、grant-thanksgiving-benefits（thx- 前缀）、mgmt-customer（cpn-up- 前缀）
- 现象：coupon_id 自定义前缀约定散落 4+ 处，无全局注册表/文档。新增场景若前缀冲突 → ON CONFLICT DO NOTHING 静默跳过 → 用户看不到券。
- 修复：(L0 db/schema/coupon.ts) 注释中建立 coupon_id 前缀注册表（sg-/cpn-up-/bday-/thx-/ref-...），新增前缀必须修注释。

---

### 3.3 P2（代码质量 / 可维护）

- **[P2-19-13]** share-gift.js 三副本注释声明"字节级一致"但无 CI diff 守护。建议加 `scripts/check-share-gift-consistency.sh` 跑三份 diff，接入 pre-commit hook。
- **[P2-19-14]** `messageInviterTitle` 为空时跳过当条但另一条照发（行 127-130），admin UI 保存时不阻止（仅红字提示）。建议 admin 保存时校验两条消息标题均非空。
- **[P2-19-15]** `clientApi/routes/auth.js:276` `console.warn` 静默吞错，无法区分 SQL 报错 / 连接断 / CHECK 触发，运维定位困难。建议分级记录 + 写 operation_logs 预警。
- **[P2-19-16]** `customer.assign` 行 981 错误前缀 `INVALID_PARAMS: 员工不存在或不属于本门店` 混淆"不存在"与"不在 scope"，按约定 scope 拒绝应用 `PERMISSION_DENIED:` 前缀（CC5）。
- **[P2-19-17]** grantShareGift `clamp` 逻辑（行 84-86）：若 cfg.maxFaceValue=0 触发 fallback maxV=500，与 admin `normalizeShareGiftConfig` 保证 min<=max 形成冗余保险，建议统一在 normalizeShareGiftConfig 锁死后 share-gift.js 简化。
- **[P2-19-18]** 配置缺"单顾客累计领取分享礼上限"：同一顾客邀请 N 人均可获 N 张券，无封顶；admin UI 无 maxPerUserPerMonth 字段。可加配置 + cron 监控告警。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| share-gift 调用站点 | — | confirmOffline 调用 ✅ | **dead code（永不调用）** | handleSuccess 调用 ✅ | 维护负担 | P1（P1-19-06）|
| share-gift 三副本一致 | — | diff 0 ✅ | diff 0 ✅ | diff 0 ✅ | 三份漂移高危 | P2（P2-19-13）|
| inviter 校验严格度 | N/A | N/A | startsWith('FYGK-') + EXISTS only | 不校验 | 越权套利 | P0（P0-19-05）|
| 赠送记录 scope（门店） | — | **零 scope 过滤 ❌** | — | — | PII / 跨店读 | P0（P0-19-02）|
| 赠送记录 scope（管理层） | — | validateScope ✅ | — | — | 正例 | — |
| customer.assign scope | — | 员工同店 ✅，**顾客 scope ❌** | — | — | 业绩资损 | P0（P0-19-01）|
| 分享礼退款冲销 | cascadeRefund 不撤销 sg- 券 ❌ | cascadeRefund 不撤销 sg- 券 ❌ | cancel 不撤销 sg- 券 ❌ | — | 资损 | P0（P0-19-04）|
| operation_logs operator_employee_id | logUpdate 自带 actor ✅ | grantShareGift 不传 actor ❌ | 不调用 | NULL（系统级 OK）| 审计断裂 | P0（P0-19-03）|
| paidAmount 来源（首单结清） | N/A | newReceived（累计）| — | thisPayAmount（单次）| 面值漂移 | P1（P1-19-09）|
| system_configs schema 来源 | migration ✅ + runtime DDL ❌（冗余）| migration only ✅ | migration only ✅ | migration only ✅ | 双重定义 | P1（P1-19-10）|
| promoOrders AND FALSE dead branch | — | 双份（customer + mgmt）❌ | — | — | dead code | P1（P1-19-07）|
| bound_employee_name 同步 | N/A | assign 不写 ❌ | N/A | N/A | 字段漂移 | P1（P1-19-08）|

---

## 5. 横切检查（套用 §3 模板）

- [x] **CC1 数值精度**：face_value `Math.round(raw*100)/100` + clamp OK；`bound_employee_name` 同步丢失影响字段一致性 → P1-19-08
- [ ] **CC2 并发幂等**：
  - [x] 分享礼 user_coupons ON CONFLICT DO NOTHING ✅
  - [x] 分享礼 messages ON CONFLICT idempotency_key DO NOTHING ✅
  - [x] SAVEPOINT sp_share_gift 隔离 ✅
  - [ ] customer.assign 无顾客 scope CAS 守卫 → P0-19-01
  - [ ] inviter 绑定 try/catch 静默吞错 → P2-19-15
- [ ] **CC3 组织域数据隔离**：
  - [ ] customer.giftHistory 零 store_id 过滤 → P0-19-02（跨店全量暴露）
  - [ ] customer.assign 不校验顾客 bound_store_id ∈ scope → P0-19-01
  - [ ] customer.search 按 phone 查询无 store_id 过滤（行 41）→ 提供跨店 clientUserId 获取途径（放大 P0-19-01 攻击面）
- [ ] **CC4 后端鉴权**：
  - [x] requireManager / requireStaffBound / requirePermission('system:config') 均有 ✅
  - [ ] inviterUserId 仅前缀字符串校验，不验证被邀请人是否有权为该 inviter 背书 → P0-19-05
- [ ] **CC5 错误码**：
  - [x] 大部分使用 INVALID_PARAMS / PERMISSION_DENIED 规范前缀
  - [ ] customer.assign 行 981 `INVALID_PARAMS: 员工不存在或不属于本门店` 误用（scope 拒绝应用 PERMISSION_DENIED）→ P2-19-16
- [ ] **CC6 PII**：customer.giftHistory 跨店暴露顾客全国消费足迹（paid_at / total_amount / 剩余次数）→ P0-19-02 加重
- [x] **CC7 时间字段**：
  - created_at 由 DB DEFAULT ✅；invited_at = NOW() 由 SQL 写入 ✅；expire_at 应用层算（时区漂移在 audit-13 已记，本域不重复）
- [x] **CC8 WXML/Vant**：admin UI 仅 share-gift-page 单页；前端 customer-list.ts 分配 UI 逻辑清晰；无 WXML 分歧
- [ ] **CC9 测试与残留**：
  - [ ] clientApi/share-gift.js dead code（P1-19-06）
  - [ ] customer.giftHistory `AND FALSE` dead branch（P1-19-07，双份）
  - [ ] customer.giftHistory vs mgmtCustomer.giftHistory 重复实现（P1-19-11）
  - [ ] settings.ts runtime CREATE TABLE IF NOT EXISTS 冗余（P1-19-10，三处）
  - [x] system-config.ts 已有显式 schema 定义（P1-19-10 中"定义缺失"部分修正：已有定义，但 runtime DDL 冗余）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/coupon.ts` 注释加前缀注册表 | sg-/cpn-up-/bday-/thx- 命名空间文档化 | P1-19-12 |
| L0 schema | `db/schema/coupon.ts:~8` couponStatusEnum | 评估加 `已撤销` 值（替代 expire_at hack）| P0-19-04 |
| L0 schema | `db/schema/user.ts:34` bound_employee_name | 评估 DROP 冗余字段（从 staff_wechat_users JOIN 取）| P1-19-08 |
| L3 cloudfunctions | `staffApi/routes/customer.js:967-995 assign` | 加顾客 bound_store_id scope 校验 + CAS + operation_logs | P0-19-01 |
| L3 cloudfunctions | `staffApi/routes/customer.js:823-908 giftHistory` | 加 store_id scope 过滤（与 paidOrders 同模式）或下线 delegate 到 mgmtCustomer | P0-19-02 / P1-19-11 / P1-19-07 |
| L3 cloudfunctions | `share-gift.js × 3`（字节级同步修改） | 函数签名加 actor 参数 + INSERT operation_logs 携带 operator_employee_id | P0-19-03 |
| L3 cloudfunctions | `staffApi/helpers/refund-cascade.js` + `admin/src/lib/refund-cascade.ts` | 加通道 6：撤销 sg- 分享礼券 | P0-19-04 |
| L3 cloudfunctions | `staffApi/routes/order.js close` + `clientApi/routes/order.js cancel` + `payNotify closeExpiredOrder` | 关闭/取消时撤销 sg- 分享礼券 | P0-19-04 |
| L3 cloudfunctions | `clientApi/routes/auth.js:260-278 bindStore` | 引入邀请码 HMAC token 或 inviter 深度资格校验 | P0-19-05 |
| L3 cloudfunctions | 删 `clientApi/share-gift.js` + `__tests__/share-gift.test.js` 或抽 shared | 消除三副本维护成本 | P1-19-06 / P2-19-13 |
| L3 cloudfunctions | `customer.js:839`、`mgmt-customer.js:717` | 移除 `AND FALSE` dead branch | P1-19-07 |
| L7 admin | `actions/settings.ts:155 / 339 / 402` | 移除三处 runtime CREATE TABLE IF NOT EXISTS system_configs | P1-19-10 |
| L9 前端 | `miniprogram/pages/customer-list/customer-list.ts:227-239` | 分配后刷新列表 + loading 防重复 | P2 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (1) 验证 customer.assign 跨店分配漏洞：找出员工.store_id ≠ 顾客.bound_store_id 的脏数据
SELECT c.user_id, c.name, c.bound_store_id AS customer_store,
       sw.employee_id, sw.store_id AS employee_store,
       c.bound_employee_id, c.updated_at
FROM client_wechat_users c
JOIN staff_wechat_users sw ON sw.employee_id = c.bound_employee_id
WHERE c.bound_store_id IS NOT NULL
  AND sw.store_id IS NOT NULL
  AND c.bound_store_id <> sw.store_id
ORDER BY c.updated_at DESC
LIMIT 50;

-- (2) 验证分享礼券在原单退款/关闭后是否仍为未使用（应返回 0 行，若有则为资损漏洞）
SELECT uc.coupon_id, uc.user_id, uc.status, uc.expire_at, uc.face_value_override,
       so.sale_order_id, so.status AS order_status
FROM user_coupons uc
JOIN sale_orders so
  ON so.sale_order_id = SUBSTRING(uc.coupon_id FROM LENGTH('sg-inviter-')+1)
WHERE uc.coupon_id LIKE 'sg-%'
  AND uc.status = '未使用'
  AND so.status IN ('已关闭', '已退款', '已完成')  -- 已完成订单也可能退款后关联退款单
LIMIT 100;

-- (3) 验证 sg-inviter/sg-invitee 券数量（每个 saleOrderId 应有且仅有 2 张）
SELECT SUBSTRING(coupon_id FROM LENGTH('sg-inviter-')+1) AS sale_order_id,
       COUNT(*) AS coupon_count
FROM user_coupons
WHERE coupon_id LIKE 'sg-%'
GROUP BY SUBSTRING(coupon_id FROM LENGTH('sg-inviter-')+1)
HAVING COUNT(*) <> 2
LIMIT 50;

-- (4) 验证 share.giftGranted 操作日志中 staffApi 路径 operator_employee_id 是否为 NULL（应全部为 NULL，属漏洞）
SELECT id, action, target_id, operator_employee_id, source, created_at
FROM operation_logs
WHERE action = 'share.giftGranted'
  AND source = 'staffApi'
ORDER BY created_at DESC
LIMIT 20;

-- (5) 验证 customer.giftHistory 跨店暴露范围
SELECT c.user_id, c.bound_store_id AS home_store,
       array_agg(DISTINCT o.store_id) AS stores_with_gifts,
       count(DISTINCT o.store_id) AS store_count
FROM client_wechat_users c
JOIN sale_orders o ON o.client_user_id = c.user_id
JOIN sale_items si ON si.sale_order_id = o.sale_order_id
WHERE o.status IN ('已支付', '已完成')
  AND si.received::numeric = 0
  AND si.item_direction = '购买'
GROUP BY c.user_id, c.bound_store_id
HAVING count(DISTINCT o.store_id) > 1
LIMIT 50;

-- (6) 验证自邀保护（CHECK 约束应已存在，应返回 0 行）
SELECT user_id, inviter_user_id, invited_at
FROM client_wechat_users
WHERE inviter_user_id = user_id;
```

---

## 8. 回归测试用例（建议）

1. **assign cross-store guard**：多店店长 loginLevel='store' currentStore=store-X，传 clientUserId（属 store-Y）+ employeeId（属 store-X）→ 应返回 `PERMISSION_DENIED: 仅可分配本店顾客`。
2. **assign audit log**：正常分配成功后查 operation_logs WHERE action='customer.assign' 应有该条记录，operator_employee_id 不为 NULL。
3. **giftHistory store filter**：员工 emp-X 绑店 store-X，已知 store-Y 顾客 B 的 user_id → 调 `customer.giftHistory({clientUserId: B.user_id})` → 应返回空集（store-X 无其赠品记录）。
4. **share-gift refund revoke**：触发首单完成 → 校验 sg-inviter / sg-invitee 各 1 张 status='未使用'；审批退款 → 校验两张 user_coupons.status='已过期' 或 '已撤销'。
5. **share-gift cancel revoke**：顾客取消待支付订单（触发过 grantShareGift 的异常情况）→ 校验两张 sg- 券被撤销。
6. **operation_logs actor**：staffApi confirmOffline 触发 share.giftGranted → 校验 operation_logs 该行 operator_employee_id = ctx.auth.staffWfId（非 NULL）。
7. **inviter qualification**：inviterUserId='FYGK-NOTEXIST'（不存在）→ EXISTS 兜底保证 UPDATE 影响 0 行；inviterUserId = self → CHECK 拒绝；inviterUserId 已设 → WHERE inviter_user_id IS NULL 守卫拒绝二次写。
8. **bound_employee_name sync**：assign 成功后，查 client_wechat_users.bound_employee_name 应等于被分配员工的 name（当前会失败，验证修复效果）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB + 退款 cascade）：☑（admin 配置 + 三端 share-gift.js + 退款审批撤销 + clientApi cancel）
- 涉及历史数据：☑（已发放的无对价分享礼券需要回收；历史 cross-store 分配脏数据需要审计清洗）
- 修复成本：M（单 P0 1-2 天，5 个 P0 合集约 1 周；P0-19-04 需同步修改 4 条代码路径）

---

## 10. 后续待办

- [ ] P0-19-01 / P0-19-02 / P0-19-04 纳入统一 scope 守卫修复 ticket，与 audit-11 P0-11-03 / audit-13 P0-13-04 合并处理
- [ ] 对 inviter_user_id 历史数据审计（跑验证 SQL (6) 检查自邀；检查异常高频邀请关系）
- [ ] 与运营对齐"分享礼券随退款撤销"合规口径（用户已收到通知，撤销可能引起客诉）
- [ ] 抽 cloudfunctions-shared 共享模块消除三副本（联动 cloudbase-deploy skill）
- [ ] 评估 DROP `bound_employee_name` 冗余字段（需扫描全仓引用，参考 wx-change-propagation skill）
- [ ] 评估 couponStatusEnum 加 `已撤销` 值（需同步更新 admin/staff 前端文案）

---

## 附：本次重审与上一轮差异说明

| 项目 | 上一轮（claude-opus-4-7）| 本轮重审（claude-sonnet-4-6）| 结论 |
|------|--------------------------|------------------------------|------|
| P1-19-10 system_configs schema 缺失 | 判定为"无显式定义" | `db/schema/system-config.ts` 已存在（pgTable 定义完整） | 修正：定义已有，但 settings.ts 仍有 runtime CREATE TABLE IF NOT存 冗余（P1 保留，理由调整）|
| P0-19-01 assign 越权 | 正确 | 代码验证一致 | 保持 P0 |
| P0-19-02 giftHistory 无 scope | 正确 | 代码验证一致 | 保持 P0 |
| P0-19-03 operation_logs 缺 actor | 正确 | 代码验证一致 | 保持 P0 |
| P0-19-04 退款不冲销 sg- 券 | 正确 | 两端 cascadeRefund 均已验证，均无 sg- 处理 | 保持 P0 |
| P0-19-05 bindStore inviterUserId 弱校验 | P1 升 P0 | 代码验证一致 | 保持 P0（资损可量化）|
| 三副本字节级一致 | 断言一致 | diff 两两验证 0 行，161 行完全一致 | 确认 ✅ |
| customer.search 跨店 phone 查询 | 未单独提及 | 新发现：phone 查询仅 `bound_store_id IS NOT NULL`，无 store_id 过滤（放大 P0-19-01 攻击面）| 新补充（CC3）|
