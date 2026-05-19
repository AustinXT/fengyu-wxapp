---
type: arch
number: "003"
date: 2026-05-20
title: 拉卡拉聚合支付接入（收银台 SDK + payNotify 启用 + 统一退货预留）
tags: [client, admin, payNotify, db, lakala, payment]
related: []
---

# arch/003 拉卡拉聚合支付接入

## 背景与动机

`fengyu-client/cloudfunctions/clientApi/routes/order.js` 里的 `order.pay`（微信）和 `order.alipayPay`（支付宝）此前是 mock：返回伪造 `paymentParams` / `qrCodeUrl`，没有调用任何支付通道。`payNotify` 云函数被守卫常量 `PAYNOTIFY_DISABLED=true` 完全拦截，导致 6 项 P0 审计问题（`docs/audit/audit-04-pay-notify.md`）只能纸上记录。门店分账诉求（钱要直接进各门店账户）也一直没有落地路径。

业务上选定拉卡拉作为支付服务商，因为：
- 凤御小程序的 wx.requestPayment 单 appid 只能绑一个微信支付 mch_id；但通过拉卡拉「收银台 SDK」跳转拉卡拉收银台小程序，可以按 `merchant_no` 动态分发到任意门店账户，无需系统侧分账接口
- 拉卡拉收银台支持微信/支付宝两种通道（通过 `counter_param.pay_mode` 切换），不需要单独维护支付宝 SDK
- 拉卡拉新版统一退货接口 `/rfd/refund_front/refund` 支持异步退款 + 查询，可替代当前 `线下` 兜底

## 技术选型

| 维度 | 选择 | 否决项 |
|------|------|--------|
| **接入方式** | **收银台 SDK**（`special_create` + `wx.openEmbeddedMiniProgram` 半屏跳转）| 聚合扫码主扫（要管理 sub_mch_id 与 sub_appid 绑定）；自建支付页（不支持小程序内付款） |
| **分账模式** | **每店独立商户号**（stores 表 +4 列 lakala_merchant_no/term_no/sub_appid/enabled）| 总商户 + 拉卡拉分账通（需先开通分账通产品，本期不阻塞）|
| **退款接口** | **统一退货**（`/rfd/refund_front/refund`，code `000000`，异步 trade_state）| 旧版扫码-退款交易（已标记不再迭代，code `BBS00000`，同步无 trade_state） |
| **签名算法** | **SHA256withRSA**（RSA-2048）+ 自实现 Node crypto | Java SDK（项目是 Node.js 云函数） |
| **回调入口** | **HTTP 触发器**（CloudBase HTTP URL）+ 原始 body 字节验签 | wx.cloud.callFunction（拉卡拉只支持 HTTPS URL）|
| **支付宝路径** | **统一走收银台 SDK** counter_param=ALIPAY | 独立吱口令接口（UX 多一步复制粘贴）|

详见 `sources/documents/拉卡拉接口规范-补充.md`（12 段接口规格汇总）。

## 数据模型变更

`db/schema/org.ts` 的 `stores` 表新增 4 列（迁移 `0044_aspiring_serpent_society.sql`）：

| 列名 | 类型 | 用途 |
|---|---|---|
| `lakala_merchant_no` | text nullable | 门店在拉卡拉的商户号 |
| `lakala_term_no` | text nullable | 终端号 |
| `lakala_sub_appid` | text nullable | 子 appid 占位（本期不用）|
| `lakala_enabled` | boolean not null default false | 是否启用真实支付通道 |

未填 / `enabled=false` 时云函数 fallback 到 env `LAKALA_DEFAULT_MERCHANT_NO/TERM_NO`（测试号）或走 mock。

## 加签 / 验签算法（务必区分三种格式）

| 场景 | 行数 | 待签内容 | Header 字段 |
|---|---|---|---|
| 请求加签 | **5 行** | `appid\nserial_no\ntimestamp\nnonce_str\nbody\n` | `Authorization: LKLAPI-SHA256withRSA appid="..",serial_no="..",timestamp="..",nonce_str="..",signature=".."` |
| 同步响应验签 | **5 行** | 同请求格式 | `Lklapi-Appid/Serial/Timestamp/Nonce/Signature/Traceid` |
| 异步通知验签 | **3 行** | `timestamp\nnonce_str\nbody\n`（**body 必须用原始字节**）| `Authorization: LKLAPI-SHA256withRSA timestamp="..",nonce_str="..",signature=".."` |

每行末尾 `\n` 必须保留，包括最后一行（拉卡拉文档明确丢失换行符是 90% 验签错误来源）。

## 实施分阶段

| Phase | 状态 | 落地内容 |
|---|---|---|
| **Phase 1** 加签验签基础库 | ✅ | `cloudfunctions/clientApi/utils/lakala-{sign,client,config}.js` + 30 单测；`cloudfunctions/payNotify/utils/lakala-{sign,config}.js` 镜像副本 |
| **Phase 2** stores 表 + admin 录入 | ✅ | 迁移 0044；admin 门店编辑页加「拉卡拉聚合支付配置」区块 |
| **Phase 3** 客户端接入收银台 SDK | ✅ | `order.pay/alipayPay` 接 `special_create` 拿 counter_url；`checkout.ts` 用 `wx.openEmbeddedMiniProgram` 半屏跳；`app.json` 加 `wx889424d565967811` 跳转白名单；onShow 轮询 |
| **Phase 4** payNotify 启用 + 6 P0 | ✅ | 守卫切 env；HTTP 触发器入口 + IP 白名单 + 3 行验签；schema drift 修复（wechat_transaction_id 全删）；删 isRepaymentCredential 死代码；payAmount 上限；移除 mock_txn fallback；PII 日志精简；FAIL 响应脱敏 |
| **Phase 5** admin 退款 minimum | ✅ | `resolveRefundPaymentMethod` 不再 fallback 线下；新增 `admin/src/lib/lakala-client.ts`（requestRefund + queryRefund）；approveRefund 实际调拉卡拉 + cron 查询留作 follow-up |
| **Phase 6** 跨端 + 文档 | ✅ | 本 changedoc；audit-04 复核记录 |

## 环境变量

`fengyu-client/cloudfunctions/clientApi/.env.example` + payNotify 同步：

```
LAKALA_API_BASE=https://test.wsmsd.cn/sit/api    # 生产: https://s2.lakala.com/api
LAKALA_APPID=OP00000003                          # 测试号
LAKALA_SERIAL_NO=00dfba8194c41b84cf
LAKALA_PRIVATE_KEY_PEM=<RSA-2048 私钥 PEM>
LAKALA_PLATFORM_CERT_PEM=<拉卡拉平台公钥证书 PEM>
LAKALA_DEFAULT_MERCHANT_NO=822290059430BFA       # 门店未配置时的 fallback
LAKALA_DEFAULT_TERM_NO=D9261078
LAKALA_NOTIFY_URL=<CloudBase HTTP 触发器 URL>
LAKALA_CALLBACK_IP_WHITELIST=*                   # 生产替换为拉卡拉 10 个 IP（详见接口规范文档）
LAKALA_SM4_KEY=[REDACTED]          # 仅 special_create_encry 加密变体用
LAKALA_ENV=trial                                 # release / trial
PAYNOTIFY_ENABLED=true                           # 必须显式开启才生效
```

## 守卫机制（payNotify）

旧：`const PAYNOTIFY_DISABLED = true`（硬编码常量，code review 一改就生效）

新：`function isPayNotifyEnabled()` 双层校验：
1. `process.env.PAYNOTIFY_ENABLED === 'true'`
2. `lakalaConfig.isReady()`（7 项必填环境变量齐全）

任一不满足 → HTTP 入口返回 503，wx.cloud.callFunction 入口返回 -403。

## 已知 follow-up

1. **payNotify 8 个 fixture 测试**：mock SQL matcher 需对齐新的 SQL fingerprint（移除 wechat_transaction_id 后），逐 case 维护。基线 0/13 通过 → 当前 5/13（无回归）
2. **admin approveRefund 实际接入拉卡拉**：拉卡拉 client helper 已就位，但调用链路未挂到 approveRefund —— 涉及 27 个 admin pre-existing snapshot 失败的影响范围，需独立 ticket
3. **cron poll-lakala-refunds**：扫描 `sale_order_payments WHERE change_type='退款' AND status='待审批' AND external_txn_id IS NOT NULL`，用 refund_query 推进 PROCESSING/TIMEOUT → SUCCESS/FAIL
4. **运营回填正式商户号**：等拉卡拉给各门店进件完毕，admin 后台逐店勾选启用
5. **生产 IP 白名单**：当前 env 配 `*` 跳过校验；上线前替换为拉卡拉 10 个生产 IP
6. **special_create_encry 加密变体**：本期只接明文 special_create；生产环境如需更高安全等级，可切换到加密变体（SM4 报文加密），Phase 1 库已预留 sm4Key 字段
7. **拉卡拉小程序跳转白名单**：`wx889424d565967811` 已加到 app.json，但需要运营在微信开放平台「跳转小程序权限」也添加

## 验证清单

- [x] Phase 1 单测：30/30 通过
- [x] Phase 2 stores 单测：12/12 通过；admin tsc clean
- [x] Phase 3 order.pay/alipayPay 单测：72/72 通过（mock 分支保留）；miniprogram tsc clean
- [x] Phase 4 payNotify 单测：5/13 通过（基线 0/13，+5 改进，无回归）
- [x] Phase 5 admin refund 单测：6/6 通过；admin tsc clean
- [ ] 联调验证（拉卡拉测试环境）：待运营完成账号 / 证书 / IP 白名单配置后做端到端
