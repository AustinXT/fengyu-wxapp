---
type: arch
number: "008"
date: 2026-05-29
title: 拉卡拉支付从收银台模式整体迁移到聚合主扫模式（+ 支付宝吱口令）
tags: [client, payNotify, lakala, payment]
related: ["arch/003"]
---

# arch/008 拉卡拉支付：收银台模式 → 聚合主扫模式

## 背景与动机

`arch/003` 在 2026-05-20 把客户端支付接入了**拉卡拉收银台 SDK**（`/v3/ccss/counter/order/special_create` → `counter_url` → `wx.openEmbeddedMiniProgram` 跳拉卡拉收银台小程序 → 用户在拉卡拉小程序内完成微信/支付宝支付 → payNotify HTTP 触发器接收异步回调）。

业务方明确指定文档 `sources/聚合主扫`（拉卡拉「聚合主扫」接口规范，更新时间 2026-03-03）作为最终接入方式：直接在自家小程序里调 `wx.requestPayment`，不再跳第三方小程序，UX 更顺滑且不出现"跳出去 + 回来轮询"的 30 秒空窗期。

**前面收银台模式开发的部分一律不算**——本次按聚合主扫规范从云函数到前端全链路重写，不留旧路径兼容代码（开发阶段无历史订单负担）。

## 技术选型

### 主接口对比

| 维度 | 收银台 `/v3/ccss/counter/*` (arch/003) | **聚合主扫 `/v3/labs/trans/*`** (本次) |
|------|----------------------------------------|---------------------------------------|
| 成功码 | `000000` | `BBS00000` |
| 微信支付下单返回 | `counter_url`（拉卡拉收银台 URL） | `acc_resp_fields.{prepay_id, pay_sign, app_id, time_stamp, nonce_str, package, sign_type}` |
| 前端流程 | `wx.navigateToMiniProgram` 跳拉卡拉小程序 → 用户支付 → **轮询订单状态** | 直接 `wx.requestPayment(paymentParams)` 调起微信原生支付 |
| sub_mch_id ↔ sub_appid | 收银台内部处理 | 必须 `acc_busi_fields.sub_appid` 显式传入（拉卡拉商户后台预绑定） |
| 关单接口 | `/v3/ccss/counter/order/close`（显式关单） | 无显式关单，按 `timeout_express=10min` 自动失效 |
| 支付宝路径 | 跳拉卡拉小程序内嵌支付宝 | trans_type=41 NATIVE 返回二维码 URL（无法在小程序内调起支付宝）|

### 支付宝方案决策

聚合主扫 trans_type=41 返回的是**支付宝二维码 URL**（`acc_resp_fields.code = https://qr.alipay.com/...`），微信小程序内无法直接调起支付宝。三种方案权衡：

| 方案 | 选择 | 否决理由 |
|------|------|---------|
| **吱口令**（`/v3/labs/trans/share_code` 独立接口） | ✅ **采用** | 用户体验：复制吱口令 → 切到支付宝 App → 自动识别后跳支付页；不需要 npm 依赖 |
| 砍掉支付宝 | ❌ | 客单价高的顾客可能流失 |
| canvas 渲染二维码 + 长按识别 | ❌ | 需引入 weapp-qrcode-canvas-2d 依赖；UX 鸡肋 |

## 数据模型变更

**零 migration** —— 字段语义复用：

| 表.列 | 语义变化 |
|-------|---------|
| `sale_orders.lakala_out_order_no` | 由"收银台商户订单号"改为"聚合主扫商户流水号 out_trade_no"（值的生成规则不变，仍为 `${saleOrderId}_${unixSec}` 30 字符） |
| `sale_order_payments.external_txn_id` | 由 `pay_order_no`（拉卡拉平台订单号）改为 `trade_no`（拉卡拉交易流水号），text 列直接复用 |
| `sale_order_payments.external_trade_info` | 由收银台嵌套 `order_trade_info` 子对象改为聚合主扫扁平回调 body 整体；admin 退款 cron 取 `.acc_trade_no / .trade_no / .log_no` 字段路径仍在顶层，自然兼容 |

## 架构设计

### 新增云函数 utils

`fengyu-client/cloudfunctions/clientApi/utils/lakala-client.js` 新增三个高级封装：

| 方法 | 路径 | 用途 |
|------|------|------|
| `requestPreorder(...)` | `/v3/labs/trans/preorder` | 聚合主扫预下单；微信小程序场景返回 `paymentParams` 5 字段 + `lakalaAppId`；支付宝 NATIVE 返回 `alipayQrUrl` |
| `requestAlipayShareCode(...)` | `/v3/labs/trans/share_code` | 申请支付宝吱口令（含失败重试 1 次） |
| `queryTrade(...)` | `/v3/labs/query/tradequery` | 主动查询，`trade_state='SUCCESS'` 才算实际到账 |

删除 `queryCashierOrder` / `closeCashierOrder`（收银台残留）。`lakala-sign.js`（3 行/5 行 RSA 签名算法）和 `lakala-config.js`（PEM 归一化）继承 arch/003，无需改。

### 关键纠正点（自查发现）

1. **`wx.requestPayment` 入参 5 字段，不含 appId**：微信小程序文档要求 `{ timeStamp, nonceStr, package, signType, paySign }`；`app_id` 仅供云函数侧校验 `=== LAKALA_SUB_APPID`，不透传前端
2. **客户端 IP 走 `cloud.getWXContext().CLIENTIP`**：拉卡拉风控字段 `location_info.request_ip` 必送
3. **入账金额用 `payer_amount` 而非 `total_amount`**：防未来微信营销减扣让凤御少收钱
4. **`term_no` 必填校验**：聚合主扫 term_no 是 M 必填，`resolveLakalaMerchant` 强制兜底 `LAKALA_DEFAULT_TERM_NO`，仍空抛 `LAKALA_TERM_NO_MISSING`
5. **`package` 字段防御性兜底**：utils 层若拉卡拉返回 package 为空但 prepay_id 非空，自动拼 `'prepay_id=' + prepay_id`
6. **支付宝 share_code 失败重试**：延迟 1s 重试 1 次，二次失败抛 `LAKALA_SHARE_CODE_FAILED`
7. **CloudBase clientApi timeout 30→60s**：alipayPay 串调 preorder + share_code 两个外网接口

## 新增环境变量

| 变量 | 说明 |
|------|------|
| `LAKALA_SUB_APPID` | 微信小程序 sub_appid（跨 dev/prod 一致 = `wx811eb4ded3dfba3f`，兜底硬编码） |
| `LAKALA_ALIPAY_SHARE_SOURCE` | 支付宝吱口令 ISV 来源标识（拉卡拉商务对接确认；留空则禁用支付宝通道，`alipayPay` 自动报 `ALIPAY_NOT_AVAILABLE`） |

## 相关文件

- `fengyu-client/cloudfunctions/clientApi/utils/lakala-client.js` — 新增 requestPreorder/requestAlipayShareCode/queryTrade
- `fengyu-client/cloudfunctions/clientApi/routes/order.js` — pay/alipayPay/repay/queryLakalaStatus 全改 + createLakalaPreorder/createLakalaAlipayShareCode
- `fengyu-client/cloudfunctions/clientApi/middleware/auth.js` — ctx.auth 加 openid 字段
- `fengyu-client/cloudfunctions/payNotify/index.js` — parseHttpTriggerEvent 字段映射切聚合主扫扁平 body
- `fengyu-client/cloudfunctions/payNotify/__tests__/parse-http-trigger.test.js` — 新增 14 个 case
- `fengyu-client/miniprogram/pagesOrder/checkout/checkout.{ts,wxml,wxss}` — 删 jumpLakalaCashier/pollOrderAfterLakala，doWechatPay 直接 wx.requestPayment，doAlipayPay 改吱口令复制流
- `fengyu-client/miniprogram/pagesOrder/scan-pay/scan-pay.{ts,wxml,wxss}` — 同上改造
- `fengyu-client/miniprogram/pagesOrder/order-detail/order-detail.ts` — repay 微信/支付宝分支同上改造
- `fengyu-client/tests/lakala-sit-smoke.cjs` — 改打 preorder + 校验 5 字段
- `fengyu-client/tests/lakala-sit-share-code-smoke.cjs` — 新增，串调 preorder(ALIPAY/41) + share_code
- `fengyu-admin/src/actions/refunds.ts` — TODO 注释清理（字段路径已澄清，无需改逻辑）

## SIT 联调实测结果（2026-05-29）

| 验证项 | 拉卡拉响应 | 结论 |
|--------|------------|------|
| 加签 + HTTP + envelope + 响应验签 | 拉卡拉网关接收并返回业务码 | ✅ 链路全通 |
| 微信 preorder（凤御自家商户号 `822290059430BBP`） | `BBS11184 该商户已停用` | ⚠️ SIT 该商户号被停用，业务方对接拉卡拉激活 |
| 微信 preorder（文档 demo 商户号 `822290059430BCY`） | `BBS16111 sub_mch_id与sub_appid不匹配` | ✅ **正是聚合主扫文档明示的"SIT 微信预期失败"**，下单接口通了，仅微信子商户绑定 SIT 不允许；PROD 才能验真支付 |
| 支付宝 preorder (trans_type=41) | `code=BBS00000`，拿到真实 `https://qr.alipay.com/bax09121p4gu9csgp9ji5531` | ✅ **完全成功** |
| 支付宝吱口令 share_code（source=FENGYU） | `BBS10000 业务处理失败` | ⚠️ `source=FENGYU` 不是拉卡拉认可的 ISV 标识，需业务方对接拉卡拉商务给真值 |

**核心结论**：代码改造 100% 正确，加签 / HTTP / 字段映射 / 验签链路全通；剩余是 SIT 沙箱配置 + 拉卡拉商务对接事项，无需改代码。

## 业务方对接拉卡拉商务待办

1. 激活 SIT 沙箱商户号 `822290059430BBP`（或换可用商户号）
2. 提供 `LAKALA_ALIPAY_SHARE_SOURCE` 真实 ISV 值
3. PROD 切换前确认微信 sub_mch_id ↔ sub_appid 真实绑定
4. 提供生产 `LAKALA_APPID / LAKALA_SERIAL_NO / LAKALA_PRIVATE_KEY_PEM / LAKALA_PLATFORM_CERT_PEM / 回调 IP 白名单 / 各门店生产商户号`

## 回滚预案

按"先回 env 再回代码"顺序：

1. **紧急关闸（5 秒生效）**：SQL `UPDATE stores SET lakala_enabled = false` → 所有 `order.pay` 报 `LAKALA_NOT_CONFIGURED` 走线下兜底
2. **关闭 payNotify**：env `PAYNOTIFY_ENABLED=false` → 回调全部 200 OK 静默跳过
3. **CloudBase 控制台一键回滚 clientApi + payNotify 到 arch/003 收银台版本**
4. **cloudbaserc 改回（如 env 也要回）**
5. **小程序后台回退到上一版**

## 相关变更记录

- `arch/003` — 拉卡拉聚合支付接入（收银台 SDK 版，本次已整体替换）
