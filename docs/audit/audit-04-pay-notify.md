# 审计报告：支付回调 / payNotify 幂等 (04)

**审计时间**：2026-04-25
**域 ID**：04
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：partial-payment foundation (PR-2/PR-3) + 多次回款 (Ticket 2026-04-24 PR-A/B/C) + share-gift-reward
**规范版本**：`real.md` v3.1.0（命中 #3 支付幂等、#4 状态单向、#5 后端鉴权）+ `enums.ts` 28 枚举

---

## 1. 三端入口对照

| 层 | admin | staff | payNotify (本域) |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:241-287` saleOrderPayments | ↑ | ↑ |
| 入口 | — | — | `fengyu-client/cloudfunctions/payNotify/index.js:38-510` `exports.main` |
| 路径 | — | — | wx.cloud → CloudBase 调用 (理论应为微信支付商户 NotifyURL) |
| 鉴权 | requirePermission | middleware.auth | **无任何鉴权 / 签名校验** |
| 幂等键 | `actions/orders.ts:1539-1545` 应用层校验 | `staffApi/routes/order.js:826` 事务外读 | `payNotify/index.js:160-184` `INSERT ... ON CONFLICT (sale_order_id, payment_method, external_txn_id)` (uq_sop_txn) |
| 配套 | — | — | `payNotify/config.js`（system_configs 缓存）+ `payNotify/points.js`（积分结算镜像）+ `payNotify/share-gift.js`（分享礼镜像）|
| 测试 | — | — | `payNotify/__tests__/index.test.js`（13 用例，含 PR-4.x 部分支付/回款/凭证单镜像）|
| 依赖 | — | — | `wx-server-sdk: latest`、`pg: ^8.11.3`（`payNotify/package.json:10-13`）— 无 `crypto`/`@wechatpay/openapi-tools`/任何签名库 |

---

## 2. 数据流图

```
微信支付商户后台 ──HTTPS POST──▶ NotifyURL
                                 │
                                 ▼ (理论上应有 wechat-api-gateway 前置签名校验+解密)
                          ┌──────────────────────────────────────┐
                          │ payNotify/index.js exports.main(event)│
                          │                                       │
                          │ ⚠️ event 直接信任，无签名校验/解密  │
                          │ event = { orderNo, transactionId,    │
                          │            payAmount?, paymentMethod? }│
                          └──────────────────────────────────────┘
                                 │
                                 ▼ (pg.query 入口幂等读)
   SELECT sale_orders WHERE sale_order_id = $1
   ├─ row 不存在 → return FAIL          (会触发微信无限重试 8 次)
   ├─ status='已支付'/'已完成' → return SUCCESS（短路）
   ├─ status≠'待支付' / '部分支付' → return FAIL  (同上)
   └─ status∈{'待支付','部分支付'}：
        │
        ▼ pg.connect() BEGIN
        ├─ 计算 thisPayAmount = event.payAmount ?? (payable - SUM(payments))
        ├─ 决定 changeType：
        │   - 凭证单 → 强制 '回款'
        │   - 普通 → SELECT WHERE change_type='首次支付' 在事务内（已修复 03 域 P0-03-03）
        ├─ INSERT INTO sale_order_payments ... ON CONFLICT (uq_sop_txn) DO NOTHING
        │   ├─ rowCount=0 → ROLLBACK + return SUCCESS（幂等命中）
        │   └─ rowCount=1 → 继续
        ├─ UPDATE sale_orders.status = '已支付'/'部分支付'
        │   + paid_amount = newPaidSum
        │   + wechat_transaction_id = COALESCE(... , txnId)  ⚠️ 第二个 txn 永远落不进
        ├─ if 凭证单：UPDATE 凭证单 status='已支付'
        ├─ if !fullyPaid：COMMIT + return SUCCESS
        ├─ UPDATE sale_items.expire_date += 1 year
        ├─ if 充值卡 product_kind 行：UPSERT prepaid_cards + INSERT card_transactions(充值)
        ├─ if order.prepaid_card_amount > 0：FOR UPDATE 卡 + 扣 + INSERT card_transactions(扣款)
        ├─ if preferred_employee_id：INSERT sale_allocations × items
        ├─ UPDATE client_wechat_users.spending_tier (按 SUM total_amount)
        ├─ UPDATE client_wechat_users.customer_type (只升不降)
        ├─ settlePointsSafe（积分发放/冲销）
        ├─ SAVEPOINT sp_share_gift → grantShareGift（首单礼券+消息）
        └─ COMMIT
              │
              ▼
       return { code: 'SUCCESS', message: '成功' }
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### [P0-04-01] 完全无微信支付签名校验，event 输入完全可信任 — 资损/伪造支付
- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:38-46`
- **现象**：
  ```js
  exports.main = async (event) => {
    const { orderNo, transactionId, payAmount, paymentMethod } = event
    if (!orderNo) return { code: 'FAIL', message: '缺少 orderNo' }
    // 直接进入业务逻辑，无 V2 MD5/HMAC-SHA256 也无 V3 SHA256-RSA + 平台证书校验
  ```
  整个文件 grep `signature` / `RSA` / `sha256` / `aes_256_gcm` / `APIv3` / `x-wechatpay` 均零命中。`package.json` 的 dependencies 仅 `wx-server-sdk` + `pg`，没有任何加解密 / 签名库。
- **风险**：任何拥有该云函数调用权限的人（微信开放平台 + 同 envId 内）都能伪造一笔支付：
  ```js
  // 攻击 PoC：在 fengyu-client 任意页面（同 envId）
  await wx.cloud.callFunction({
    name: 'payNotify',
    data: { orderNo: 'FY-XSD-WX-2604250001', transactionId: 'forged-' + Date.now(), payAmount: 1 }
  })
  ```
  → `sale_orders.status` 被翻成 `已支付`、写入 `sale_order_payments`、扣减储值卡（若 prepaid_card_amount>0）、自动建分配、跃迁 `customer_type`、发放积分与分享礼券。**资金 + 业绩 + 积分 + 营销品资损全链路命中**。
- **CloudBase 端调用边界**：默认 CloudBase 云函数对小程序内 `wx.cloud.callFunction` 默认开放（同 envId，无 RAM 调用方限制）。要确认是否设置了"非 HTTP 触发器拒绝"策略，但即使设置，仍需校验调用方 OPENID / 签名 — 当前完全没有。
- **风险等级**：资金 P0（违反 `real.md` #3 支付幂等 + #5 后端统一鉴权）
- **复现**：
  1. 在已绑定门店的客户端发起任意一笔订单（`待支付`）
  2. 调用 `wx.cloud.callFunction({ name: 'payNotify', data: { orderNo, transactionId, payAmount: 0.01 } })`
  3. 后台查询 `SELECT status, paid_amount FROM sale_orders WHERE sale_order_id = $orderNo` → 已支付 + paid_amount=0.01
  4. （扩展）若 `prepaid_card_amount > 0`，且无外部充值前置，会触发 `INSUFFICIENT_BALANCE`，但订单状态在事务内回滚不变；正常场景资金已落账
- **修复**：(L3 cloudfunctions) 接入真实微信支付时必须加：
  - V3：从 header 取 `Wechatpay-Signature` / `Wechatpay-Serial` / `Wechatpay-Timestamp` / `Wechatpay-Nonce`，加载平台证书 `wxpay_platform_cert.pem` 用 `crypto.createVerify('RSA-SHA256').verify(...)`
  - 解密 `resource.ciphertext`（AEAD_AES_256_GCM，`process.env.WXPAY_API_V3_KEY`）
  - 校验 `mchid === 配置`、`appid === 配置`
  - 短路前置：仅签名通过的事件才进入业务逻辑

#### [P0-04-02] event.payAmount / event.paymentMethod 完全信任输入，可任意改写款项金额与通道
- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:43, 104-105, 135-141`
- **现象**：
  ```js
  const { orderNo, transactionId, payAmount: payAmountInput, paymentMethod: paymentMethodInput } = event
  ...
  const paymentMethod = paymentMethodInput
    || (order.payment_method === '支付宝' ? '支付宝' : '微信')
  ...
  const thisPayAmount = (payAmountInput !== undefined && payAmountInput !== null)
    ? Math.round(Number(payAmountInput) * 100) / 100
    : remaining
  ```
  - `payAmount` 仅校验 `> 0`，无上限校验（`thisPayAmount > remaining` 不会被拒）
  - `paymentMethod` 直接覆盖订单内字段，调用方可把 `微信` 通道入账写成 `线下` / `储值卡` / `支付宝`
- **风险**：
  1. **超付不报错**：调用方 payAmount = 99999999 → INSERT payments，sale_orders.paid_amount 被刷成 99999999。`chk_sop_amount_sign` 正负性 OK 但金额无上限 → 报表 / 提成 / 积分 / 档位计算全部炸。`Math.floor(netSettled / 100)` 在 `points.js:43` 算积分 → 顾客得到天文数字积分。
  2. **支付宝伪报为线下**：实际微信回调被攻击者截获后改 `paymentMethod='线下'` 重发（同一 `external_txn_id` 不同 method 不会命中 `uq_sop_txn`，因为唯一键是 `(sale_order_id, payment_method, external_txn_id)`），可重复入账。
  3. **uq_sop_txn 复合键被绕过**：唯一键是 `(sale_order_id, payment_method, external_txn_id)` — 同一 external_txn_id + 不同 payment_method 仍是新行 → 重放不同 method 即可重入账。
- **CC2 并发幂等 + CC1 数值精度** 同时命中
- **风险等级**：P0
- **复现**：
  1. 订单 total=300 prepaid=0
  2. 调用 `payNotify({orderNo, transactionId: 'A', payAmount: 1, paymentMethod: '微信'})` → 部分支付 paid_amount=1
  3. 调用 `payNotify({orderNo, transactionId: 'A', payAmount: 1, paymentMethod: '支付宝'})` → ON CONFLICT 不命中（method 不同）→ 又 INSERT 一行 → paid_amount=2，但 `external_txn_id='A'` 重复
- **修复**：(L3) 真实接入后 `transactionId` 应为微信解密后的 `transaction_id`，不接受 event 入参。`payAmount`/`paymentMethod` 应完全从 `resource.ciphertext` 解出，不读 event 顶层。Mock 模式应仅在 `process.env.NODE_ENV !== 'production'` 下启用。

#### [P0-04-03] transactionId 缺省 fallback 为 `mock_txn_${Date.now()}`，每次重试都产生新幂等键
- **文件**：`payNotify/index.js:101`
- **现象**：
  ```js
  const txnId = transactionId || `mock_txn_${Date.now()}`
  ```
- **风险**：调用方不传 transactionId 时（mock 测试或微信回调前置丢字段），fallback 是 `mock_txn_<timestamp>`。同一笔订单 8 次重试 → 8 个不同 txnId → 全部命中 `uq_sop_txn` 唯一键检查为不同行 → **8 笔 payments 行写入 + 8 次 paid_amount 累加**。
  - 真实微信回调一定有 transaction_id，所以风险窗口主要在：
    - mock 测试期被打到生产 envId（CloudBase 单 envId，多端共用）
    - 调用方 forge 时漏传 transactionId（结合 P0-04-01 攻击）
- **风险等级**：P0（攻击后必命中）
- **复现**：调用 `payNotify({orderNo, payAmount: 1})` × 3 次（间隔 ≥1 ms） → 写入 3 行 payments / paid_amount += 3
- **修复**：(L3) 移除 fallback，缺 transactionId 应直接 return FAIL；或仅在 `mock_txn_` 前缀下复用同一占位符（但接入真实回调后此分支应整体删除）

#### [P0-04-04] event 全量 `JSON.stringify` 写入 console.log（含潜在 PII）
- **文件**：`payNotify/index.js:39`
- **现象**：
  ```js
  console.log('[payNotify] received event:', JSON.stringify(event))
  ```
- **风险**：真实微信 V3 回调 event 内含 `payer.openid` / 商户订单号 / 完整支付明细。CloudBase 控制台日志可被同账号成员查阅。命中 CC6 PII。
- **关联**：CROSS-CUTTING.md CC6 同类（auth域 P0-PII-06）
- **风险等级**：P0
- **修复**：(L3) 输出脱敏：`event.orderNo`、`event.transactionId.slice(0,8) + '***'`，禁止输出整个 event

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-04-05] 重大事务跨多业务子系统，触发逻辑可能超过微信回调 5s 时限
- **文件**：`payNotify/index.js:108-503` 整个 BEGIN-COMMIT 事务
- **现象**：单事务内串行触发：
  1. SUM payments → INSERT payments → UPDATE sale_orders → UPDATE 凭证单
  2. UPDATE sale_items expire_date
  3. 充值卡入账：SELECT product_kind + UPSERT prepaid_cards + INSERT card_transactions × N
  4. 消费扣款：FOR UPDATE prepaid_cards + UPDATE balance + INSERT card_transactions
  5. SELECT staff.skills + SELECT sale_items + INSERT sale_allocations × N
  6. UPDATE client_wechat_users.spending_tier (子查询 SUM sale_orders)
  7. SELECT customer_type + 复杂多 EXISTS 子查询 + UPDATE client_wechat_users.customer_type + UPDATE became_member_at
  8. settlePointsSafe（FOR UPDATE sale_orders + SUM + INSERT point_transactions + UPDATE points_balance）
  9. grantShareGift（COUNT sale_orders + SELECT inviter + SELECT coupon_templates + INSERT user_coupons × 2 + INSERT messages × 2 + INSERT operation_logs）
- **风险**：
  - 微信支付回调严格要求 5s 内响应，否则视为失败重试（最多 8 次，间隔 15s/15s/30s/180s/1800s/1800s/1800s/1800s）。
  - 真实订单 + 充值 + 业绩分配 + 消费扣款 + 顾客升级 + 积分 + 分享礼 全套触发，加上 PG 远程网络（5434 在 47.113.202.7 阿里云）：单事务往返 30+ 次 query，估计 2-4s（连接池 max=3 共享时排队更久）。
  - 高峰期偶发超时 → 微信认为失败 → 8 次重试 → 由 uq_sop_txn 兜底幂等 → 但 customer_type / share_gift 等子动作可能在重试中放大错误
  - 风险路径：share-gift 失败仅 ROLLBACK SAVEPOINT 不阻塞主事务，OK；但 customer_type 重算抛错则全事务回滚。
- **风险等级**：P1（实际超时未必触发，但是支付链路稳定性隐患）
- **修复**：(L3) 拆分：
  - 同事务内仅做"必要写"：INSERT payments + UPDATE sale_orders.status / paid_amount + 储值卡扣减
  - 异步副作用（业绩分配、customer_type、积分、share-gift、单品到期日）走"事件队列"或"二次触发"（CronTask 拉 unprocessed）

#### [P1-04-06] FAIL 响应直接暴露内部错误信息（INSUFFICIENT_BALANCE / INVALID_PAY_AMOUNT / SQL Error）
- **文件**：`payNotify/index.js:506-509`
- **现象**：
  ```js
  } catch (err) {
    console.error('[payNotify] Error:', err)
    return { code: 'FAIL', message: err.message }
  }
  ```
- **风险**：
  - 微信支付侧把 message 视为人类可读，但泄露内部约束名（`INSUFFICIENT_BALANCE: 储值卡余额不足`、`chk_sop_amount_sign violation`、PG SQL 错误堆栈）
  - 长 message 影响微信侧重试策略
- **风险等级**：P1
- **修复**：(L3) message 仅返回 `'FAIL'` 或不超过 32 字的稳定错误码；详情走 console.error / operation_logs

#### [P1-04-07] 响应格式只有 V3 风格 `{ code: 'SUCCESS', message }`，无 V2 XML 兼容；CloudBase 入参非 HTTP raw body
- **文件**：`payNotify/index.js:91, 183, 221, 505`
- **现象**：函数返回 `{ code: 'SUCCESS' | 'FAIL', message }` JSON。微信 V3 回调要求严格 JSON `{"code": "SUCCESS", "message": "OK"}`（无 message 也行）。
  - **真实接入路径未确定**：CloudBase 云函数对外通过 HTTP 触发器或微信支付直连；当前 mock 只能由 `wx.cloud.callFunction` 触发，**根本无法接入微信商户回调**（微信回调地址需公网 HTTPS POST，CloudBase 函数虽可用 `tcb fn http` 暴露，但需另配 HTTP 路由）。
  - 即使配置 HTTP 触发器，event 的 body / headers 解析逻辑当前完全缺失。
- **风险**：当前实现是"半成品 mock"，离真实接入还差签名 + body 解析 + HTTP 触发器配置三层。生产接入时若直接复用，必导致回调静默失败（微信 5s 内未拿到合规响应 → 8 次重试都失败 → 订单卡在 '待支付'）。
- **风险等级**：P1
- **关联**：与 P0-04-01 同根，但单独列出以提醒接入工序
- **修复**：接入前完成 (1) HTTP 触发器配置 (2) `event.body` 解析（V2 XML / V3 JSON）(3) header 签名校验 (4) AEAD 解密 (5) 响应 Content-Type 设置

#### [P1-04-08] sale_orders.wechat_transaction_id COALESCE — 部分支付场景仅记录第一笔 txnId
- **文件**：`payNotify/index.js:197`
- **现象**：
  ```sql
  wechat_transaction_id = COALESCE(wechat_transaction_id, $4)
  ```
  + schema `db/schema/order.ts:75` 该列有 `.unique()`：`wechatTransactionId: varchar(...).unique()`
- **风险**：
  1. 部分支付场景一笔订单可能收到 N 个 transactionId（首次支付 + 多次回款）。当前代码只在第一笔时写入，后续 txnId 全部丢失。审计 / 财务 / 退款查证只能从 sale_order_payments.external_txn_id 取，sale_orders.wechat_transaction_id 误导。
  2. UNIQUE 约束跨订单：若同一 transactionId 被异常关联到多个订单（攻击场景），`COALESCE` 不会触发约束（只有第一次写）。
  3. 与 sale_order_payments.external_txn_id 数据冗余 / 一致性无强约束保证。
- **风险等级**：P1（数据完整性）
- **修复**：(L0) 删除 sale_orders.wechat_transaction_id（用 sale_order_payments JOIN 替代），或改语义为"首笔 txn"并加注释；(L3) payNotify UPDATE 改为只在 NULL 时写

#### [P1-04-09] 凭证单回调时凭证单状态翻转无 CAS 守卫
- **文件**：`payNotify/index.js:204-214`
- **现象**：
  ```sql
  UPDATE sale_orders
   SET status = '已支付'::order_status,
       paid_at = COALESCE(paid_at, $1),
       wechat_transaction_id = COALESCE(wechat_transaction_id, $2),
       updated_at = $1
   WHERE sale_order_id = $3   -- ⚠️ 无 AND status = $expected
  ```
- **风险**：凭证单可能已被其他通道（admin.confirmOfflinePayment 处理凭证单 / staff.close 等）改成 '已关闭'。当前 UPDATE 直接覆盖回 '已支付'，破坏状态机单向推进。
  - 实际触发条件较窄（凭证单仅在 client.repay 创建后立即回调），但理论存在状态污染。
- **关联**：CROSS-CUTTING.md CC2 "状态机 UPDATE 缺 CAS 守卫"
- **风险等级**：P1
- **修复**：(L3) `WHERE sale_order_id = $3 AND status IN ('待支付', '部分支付')`

#### [P1-04-10] 充值入账幂等检查范围过宽，可能漏掉同订单多商品的部分入账失败
- **文件**：`payNotify/index.js:254-258`
- **现象**：
  ```js
  const dupCheck = await client.query(
    `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 LIMIT 1`,
    [targetOrderNo]
  )
  if (dupCheck.rows.length === 0) {
    for (const row of rechargeRows.rows) { /* INSERT */ }
  }
  ```
- **风险**：dupCheck 不限 type（可能是 type='扣款'）；订单同时含充值卡商品 + 消费抵扣（理论上 prepaid_card_amount=0 才允许充值，业务保证不混），但若上一次回调走到一半失败（INSERT 充值成功，扣款失败 ROLLBACK），重发时整笔回滚后的事务里 dupCheck 看不到充值行（已 ROLLBACK）。OK，rollback 安全。但若 type='扣款' 已存在（消费扣款先于充值入账），dupCheck 会误判跳过充值。**实际订单语义不会同时是充值订单 + 含 prepaid_card_amount，所以业务上排除互斥**，是 dead branch；但代码层面 contract 不显式。
- **风险等级**：P1（防御性）
- **修复**：(L3) `WHERE ref_order_id = $1 AND type = '充值'`

#### [P1-04-11] settlePointsSafe / grantShareGift 异常吞掉，但 customer_type 重算异常会回滚整个事务
- **文件**：`payNotify/index.js:475-494` (share-gift 用 SAVEPOINT 隔离) vs `:384-462` customer_type / spending_tier 重算（无 SAVEPOINT）
- **现象**：
  - share-gift 用 SAVEPOINT，错误不阻塞主事务 ✓
  - settlePointsSafe 内部 try/catch 自吞 ✓（但 INSERT operation_logs 的吞错也用 try { ... } catch (_) {}）
  - **customer_type / spending_tier 部分**：直接在主事务里跑，无 try/catch。若 SQL 发生约束冲突（例如 `customer_type` 枚举边界、UNIQUE 冲突等），整个事务回滚 → 退回 INSERT payments → 微信视为 FAIL → 重试。最终幂等可保（uq_sop_txn 第二次会跳过），但中间状态污染 client_wechat_users。
- **风险等级**：P1
- **修复**：(L3) 把 customer_type / spending_tier 重算也用 SAVEPOINT 包裹，与 share-gift 一致策略

### 3.3 P2（代码质量 / 可维护）

#### [P2-04-12] config.js 用独立 Pool（共享 PG 但开两套连接池）
- **文件**：`payNotify/config.js:24-37`
- **现象**：payNotify 同进程已有 `index.js:21-30 getPg()`（max=3）+ `config.js:24-37 getConfigPool()`（max=2）。同 PG_CONNECTION_STRING 但两个独立 Pool。
- **风险**：连接池共占 5 连接（生产 PG max_connections 默认 100，5434/fengyu 估计 100-200），高并发回调时可能拖累其他云函数。
- **修复**：合并为单 Pool 透传给 config

#### [P2-04-13] settlePointsSafe / grantShareGift / config 跨函数代码三份镜像
- **文件**：注释明确说明 `payNotify/share-gift.js:8-12`、`payNotify/points.js:5-7` 三端镜像，需手动同步
- **风险**：staffApi、clientApi、payNotify 三份副本，任一处修复漏同步会引起业务漂移
- **关联**：CROSS-CUTTING.md CC9（迁移残留 + 跨端镜像维护）
- **修复**：（中长期）抽 npm package 共享 / 或通过云函数层依赖共用模块

#### [P2-04-14] 错误前缀不符合 4 项约定（`INSUFFICIENT_BALANCE:` / `INVALID_PAY_AMOUNT:`）
- **文件**：`payNotify/index.js:140, 311`
- **现象**：抛 `INVALID_PAY_AMOUNT: ...` / `INSUFFICIENT_BALANCE: ...`，不在 `UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:` 内
- **关联**：CROSS-CUTTING.md CC5（已在 audit-02 / audit-03 命中）
- **风险等级**：P2
- **修复**：用 `INVALID_PARAMS:` 前缀

#### [P2-04-15] FY-CARD-{Date.now()}{rand3} 充值卡 ID 生成不参与 advisory lock，理论可重号
- **文件**：`payNotify/index.js:272`
- **现象**：`FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}` — 单进程并发可重号（同毫秒 + 1/1000 随机概率）
- **风险**：UPSERT 入口是 `ON CONFLICT (user_id) DO UPDATE`，会复用现有卡，所以 newCardId 仅在该 user 第一次充值时落库。落库时 PRIMARY KEY (card_id) 冲突会抛错，单事务 ROLLBACK → 微信重试。概率极低但存在。
- **风险等级**：P2
- **修复**：用 `gen_random_uuid()` 或 `uuid` npm 包

#### [P2-04-16] 注释不准 — "Mock 模式：手动触发测试" 仍是当前实际行为
- **文件**：`payNotify/index.js:42`
- **现象**：注释 `// ========== Mock 模式：手动触发测试 ==========` 表明当前是 mock 模式，但生产 envId 上仍可被任何人调用 — 这是 P0-04-01 的根因。
- **修复**：注释升级为 WARNING + 添加 NODE_ENV 守卫

#### [P2-04-17] 测试覆盖率高但不覆盖签名/解密缺失场景
- **文件**：`payNotify/__tests__/index.test.js`（13 用例覆盖充值/扣款/幂等/部分支付/凭证单）
- **现象**：测试只验证业务逻辑，零安全测试（伪造签名、改写 payAmount、改写 paymentMethod）
- **风险等级**：P2（未来安全回归无保障）
- **修复**：(L3) 加入安全测试用例

---

## 4. 跨端不一致

| 维度 | clientApi | staffApi | payNotify | 风险 | 优先级 |
|------|-----------|----------|-----------|------|--------|
| 事务外读 changeType ('首次支付' vs '回款') | — | `routes/order.js:826-838` 事务外读（已知 P0-03-03） | `index.js:150-156` **事务内读**（修复模式）| 同业务三端策略不一致；payNotify 实现优于 staffApi | P1 |
| `wechat_transaction_id` 列写入 | `clientApi/routes/order.js` 不写 | `staffApi/routes/order.js` 不写 | `payNotify/index.js:197` 写入但 COALESCE | 部分支付场景历史 txn 丢失 | P1 |
| 鉴权 | middleware OPENID + `requirePhone` | middleware roles + scope_id | **无** | payNotify 完全裸奔 | P0 |
| 幂等键 | client.repay 用 ref_sale_order_id 防同时多回款 | confirmOffline 用事务内 SELECT | uq_sop_txn (DB unique index) | payNotify 最严格 | — |
| 储值卡扣款 | `client.create / confirmPrepaidFull` 不写 '储值卡抵扣' payments（P0-03-02）| `confirmOffline` 写 + `createRepayment` 写 | **不写 '储值卡抵扣' payments**，但写 card_transactions(type='扣款')；依赖 sale_orders.prepaid_card_amount 列直推 | invariant 三端漂移：`prepaid_card_amount = Σ(amount where change_type='储值卡抵扣')` 在 client / payNotify 两处不成立 | P0（同 03 域 P0-03-02）|
| 充值入账 | client.create 自助充值订单经 payNotify 入账 | staff.create 替充经 confirmOffline 同事务入账 | payNotify 入账（仅 fullyPaid 路径）| 部分支付的充值订单，到账后才入账 — 业务约束未在代码 enforce | P2 |
| 错误前缀 | `INVALID_PARAMS:` ✓ + `PERMISSION_DENIED:` ✓ | 同 ✓ | `INVALID_PAY_AMOUNT:` / `INSUFFICIENT_BALANCE:` ✗ | 命中 CC5 | P2 |
| 失败响应 | `{ code: -1, message }` | 同 | `{ code: 'FAIL', message }` | 不一致（V3 风格 vs 内部约定）| P2 |

---

## 5. 横切检查（套用 §3 模板）

- [x] **CC1 数值精度**：金额都用 NUMERIC + Math.round * 100 / 100 ✓；但 P0-04-02 payAmount 无上限 → CC1 失分
- [ ] **CC2 并发幂等**：
  - [x] uq_sop_txn 唯一索引 ✓
  - [ ] event.payAmount/paymentMethod 可绕过 uq_sop_txn（P0-04-02）
  - [ ] transactionId fallback 制造新键（P0-04-03）
  - [ ] 凭证单 UPDATE 无 CAS（P1-04-09）
  - [ ] 充值卡 dupCheck 不限 type（P1-04-10）
- [x] **CC3 组织域隔离**：payNotify 不涉及多店列表查询，仅按 sale_order_id 操作单订单 ✓
- [ ] **CC4 后端鉴权**：完全无（P0-04-01）→ 域 04 是 CC4 最严重命中
- [ ] **CC5 错误码**：`INVALID_PAY_AMOUNT:` / `INSUFFICIENT_BALANCE:` 不在 4 项约定（P2-04-14），FAIL 响应泄露内部细节（P1-04-06）
- [ ] **CC6 PII**：event 全量 stringify（P0-04-04）
- [x] **CC7 时间字段**：`now = new Date()` 用 JS UTC，paid_at/created_at/updated_at 都用同一个 now，时区与其他三端 03 域 P0-02-02 命中点保持一致（暂未在 04 重提）
- [—] **CC8 WXML/Vant**：N/A（云函数无 UI）
- [ ] **CC9 测试与残留**：13 用例业务覆盖好，但零安全测试 / 零跨函数 e2e（P2-04-17）；点积分/分享礼/config 三份镜像（P2-04-13）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/order.ts:75` | 评估删除 `wechat_transaction_id` UNIQUE 列（与 sale_order_payments.external_txn_id 重叠）| P1-04-08 |
| L0 schema | `db/schema/order.ts:269` 加 `WHERE change_type IN ('首次支付','回款')` 到 uq_sop_txn 条件 | 限定回调幂等键作用域，避免与 '储值卡抵扣' / '退款' 行冲突 | — (审计 03 已涉) |
| L0 migration | 新 0030 | `ALTER ROLE` / 限制 payNotify 函数仅特定 RAM 主体调用（如 `tcb fn config update payNotify --triggers ...` 限定 HTTP 来源 IP whitelist 微信支付平台 IP 段）| P0-04-01 安全网外层兜底 |
| L3 cloudfunctions | `payNotify/index.js:38-46` | 接入真实微信支付前置：1) HTTP 触发器配置 2) `event.headers['Wechatpay-Signature']` 校验 3) AEAD 解密 4) NODE_ENV 守卫 mock 入口 | P0-04-01 / P0-04-02 / P0-04-03 / P1-04-07 |
| L3 cloudfunctions | `payNotify/index.js:39` | 移除 `JSON.stringify(event)`，输出 `{ orderNo, txnId.slice(0,8) }` | P0-04-04 |
| L3 cloudfunctions | `payNotify/index.js:101` | 移除 mock_txn fallback，缺 transactionId 直接 FAIL | P0-04-03 |
| L3 cloudfunctions | `payNotify/index.js:104-105` | paymentMethod 不再读 event 入参，从微信解密结果取（V3 trade_type） | P0-04-02 |
| L3 cloudfunctions | `payNotify/index.js:135-141` | payAmount 上限校验 `<= remaining + 0.001` | P0-04-02 |
| L3 cloudfunctions | `payNotify/index.js:204-214` | 凭证单 UPDATE 加 CAS：`AND status IN ('待支付','部分支付')` | P1-04-09 |
| L3 cloudfunctions | `payNotify/index.js:255` | 充值 dupCheck 加 `AND type = '充值'` | P1-04-10 |
| L3 cloudfunctions | `payNotify/index.js:362-462` | customer_type / spending_tier 重算用 SAVEPOINT 隔离 | P1-04-11 |
| L3 cloudfunctions | `payNotify/index.js:506-509` | FAIL 响应 message 仅 `'内部错误'`，详情走 console.error | P1-04-06 |
| L3 cloudfunctions | 整个事务 | 拆分主事务（核心写）vs 异步副作用（业绩/积分/分享礼） | P1-04-05 |
| L3 cloudfunctions | `payNotify/index.js:140, 311` | 错误前缀改为 `INVALID_PARAMS:` | P2-04-14 |
| L7 admin | — | admin 不涉及 | — |
| L9 前端 | — | 前端不调用 payNotify | — |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- #1 当前 sale_order_payments 表是否已存在 mock_txn_ 前缀的行（说明生产环境已被 mock 调用过）
SELECT COUNT(*) AS mock_count, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
FROM sale_order_payments
WHERE external_txn_id LIKE 'mock_txn_%';

-- #2 同一订单同一 method 但不同 external_txn_id 的多支付行（partial-payment 正常 OR 攻击痕迹）
SELECT sale_order_id, payment_method, COUNT(DISTINCT external_txn_id) AS distinct_txn_count
FROM sale_order_payments
WHERE external_txn_id IS NOT NULL
GROUP BY sale_order_id, payment_method
HAVING COUNT(DISTINCT external_txn_id) > 1
ORDER BY distinct_txn_count DESC LIMIT 20;

-- #3 sale_orders.wechat_transaction_id 与 sale_order_payments 第一笔 external_txn_id 一致性
SELECT o.sale_order_id, o.wechat_transaction_id, p.external_txn_id AS first_pay_txn
FROM sale_orders o
LEFT JOIN LATERAL (
  SELECT external_txn_id FROM sale_order_payments
  WHERE sale_order_id = o.sale_order_id AND change_type = '首次支付' AND status = '已支付'
  ORDER BY created_at LIMIT 1
) p ON TRUE
WHERE o.wechat_transaction_id IS NOT NULL
  AND (p.external_txn_id IS NULL OR p.external_txn_id <> o.wechat_transaction_id)
LIMIT 20;

-- #4 验证 INSUFFICIENT_BALANCE 实际发生过（事务回滚但 console.error 留存，DB 看不出来；改查 share-gift 失败痕迹）
SELECT action, target_id, detail, created_at
FROM operation_logs
WHERE action = 'points.settleFailed'
ORDER BY created_at DESC LIMIT 10;

-- #5 重复回调命中 uq_sop_txn 的"未触发"率（payNotify 测试报"幂等"消息）—— 通过日志检索更直观
-- DB 层面无法检测，仅可作为修复后回归测试参考

-- #6 凭证单（'回款单'）当前是否存在 status<>'已支付' 但原单已 '已支付' 的（潜在的回调到达后业务断裂）
SELECT c.sale_order_id AS credential_id, c.status AS credential_status,
       o.sale_order_id AS orig_id, o.status AS orig_status
FROM sale_orders c
JOIN sale_orders o ON o.sale_order_id = c.ref_sale_order_id
WHERE c.sale_order_type = '回款单'
  AND c.status NOT IN ('已支付', '已完成', '已关闭')
  AND o.status IN ('已支付', '已完成')
LIMIT 20;

-- #7 wechat_transaction_id UNIQUE 约束当前命中（应零）
SELECT wechat_transaction_id, COUNT(*) FROM sale_orders
WHERE wechat_transaction_id IS NOT NULL
GROUP BY wechat_transaction_id HAVING COUNT(*) > 1;
```

---

## 8. 回归测试用例（建议）

1. **P0-04-01 安全测试**：在 staging 环境调 payNotify 伪造一笔 → 期望签名校验失败拒绝
2. **P0-04-02 上限校验**：传 payAmount 超过 remaining → 期望 INVALID_PARAMS
3. **P0-04-03 fallback 移除**：不传 transactionId → 期望 FAIL
4. **P1-04-09 凭证单 CAS**：手工把凭证单状态改为 '已关闭' → 触发 payNotify → 期望保持 '已关闭'
5. **PR-4.x 已覆盖**：首次支付 / 部分支付 / 重复回调 / 凭证单 ✓
6. **缺：超时 robustness**：mock PG 延迟到 6s 模拟 → 检查事务是否能正确终止
7. **缺：share-gift 失败回归**：grantShareGift 抛错 → 主事务 COMMIT 应仍生效（SAVEPOINT）
8. **缺：customer_type 重算抛错回归**：故意造 client_wechat_users 数据非法 → 整个事务 ROLLBACK 期望验证微信侧重试 + uq_sop_txn 兜底

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（payNotify 的 P0-04-01 命中后，攻击面覆盖 client / staff / admin 全链路：状态机 / 业绩 / 积分 / 储值卡 / 顾客等级 / 营销品发放）
- 涉及历史数据：☑（若已被攻击 / 误调，需查 #1 #2 #3 SQL 回溯）
- 修复成本：**L**（需接入真实微信支付 V3 OpenAPI、配置 HTTP 触发器、加密钥管理 / 平台证书自动滚动 / Body 解析 + 签名 + 解密链路；预计 3-5 人日）

---

## 10. 后续待办

- [ ] 与基础设施 / DevOps 对齐：CloudBase HTTP 触发器配置 + 微信商户号 NotifyURL 注册流程
- [ ] 接入 `@wechatpay/openapi-tools` 或自实现签名校验 + AEAD 解密
- [ ] APIv3 KEY / 平台证书 / 商户证书的环境变量管理（注意 `tcb fn deploy --force` 重置环境变量风险，参考 [project_cloudbase_envvar_risk](../../memory/project_cloudbase_envvar_risk.md)）
- [ ] 消除 mock 触发路径：`if (process.env.NODE_ENV === 'production' && !signedEvent) return FAIL`
- [ ] 拆分主事务，把异步副作用迁移到独立 cron / 事件驱动模块
- [ ] 移除 sale_orders.wechat_transaction_id 列或刷新语义注释
- [ ] 与域 03 P0-03-02 / P0-03-03 合并 epic：sale_order_payments 不变量 + 多端入口齐写 '储值卡抵扣' 行
- [ ] 加 e2e 安全回归测试：自动化伪造 + payAmount 上限 + transactionId 缺省

---

## 计数汇总

- **P0**：4（P0-04-01 无签名校验、P0-04-02 event 信任、P0-04-03 transactionId fallback、P0-04-04 PII 全量日志）
- **P1**：7（事务超时、错误信息泄露、响应格式半成品、wechat_transaction_id COALESCE、凭证单无 CAS、充值幂等过宽、customer_type 无 SAVEPOINT）
- **P2**：6（双 Pool、三份镜像、错误前缀、card_id 生成、注释、安全测试空白）
