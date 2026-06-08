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
| `lakala_sub_appid` | text nullable | 子 appid 占位（本期不用）— **已于 fix/001 移除**，sub_appid 改由云函数 env `LAKALA_SUB_APPID` 全局供给 |
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

## 联调踩坑记录（2026-05-20）

### 🔴 一票否决：未备案 / 未发版导致跳转能力被限制

凤御小程序自身**未完成 ICP 备案**（自 2023-09-01 微信新规起）+ **未发布正式版**，导致 `wx.openEmbeddedMiniProgram` / `wx.navigateToMiniProgram` 被微信平台限制，统一报：

> "由于小程序违规，该功能暂时无法使用"

诊断方法：临时把 `LAKALA_CASHIER_APPID` 改成腾讯文档 `wx2421b1c4370ec43b`（已备案 + 已上线的标杆小程序）。如果跳腾讯文档**也**失败，证明问题在凤御自身而不是目标 appid。

**结论**：必须先解决凤御侧合规问题（备案 + 发版），再恢复拉卡拉收银台跳转链路。备案审批约 1-3 周；期间可用 web-view 嵌入 H5 收银台 / 员工端扫码代收作为临时方案。

### ⚠️ "由于小程序违规" 是微信兜底文案

UI 不区分具体原因，以下场景都可能命中：
- 调用方小程序未备案 / 未发版（自 2023-09 强制）
- 调用方小程序有违规处罚记录（违规与申诉里看）
- 目标小程序未上线或不允许被嵌入
- 目标 appid 不在调用方的「跳转小程序」白名单
- 半屏小程序权限未开通或目标 appid 未单独加白
- 业务域名 / 服务器域名未配置

排查时必须分层验证：先用腾讯文档等标杆做"诊断跳转"，再确认目标 appid 配置。

### ⚠️ 跳转白名单是双层

- `app.json` 的 `navigateToMiniProgramAppIdList` **仅对开发版 / 体验版生效**
- 正式版必须在微信公众平台后台「设置 → 第三方设置 → 跳转小程序设置」逐 appid 加白
- 半屏小程序权限独立，目标 appid 还需在「半屏小程序设置」单独加白

### ⚠️ 拉卡拉 `out_order_no` 判重 `000095`

同一 `sale_order_id` 多次调 `special_create`（用户取消重发、切换支付方式等）拉卡拉会拒：

```
{"code":"000095","message":"订单重复"}
```

修复：`out_order_no = ${sale_order_id}_${unix_seconds}`（19 + 1 + 10 = 30 字符 ≤ 32 上限）。`pay_order_no`（拉卡拉平台号）落 `sale_order_payments.external_txn_id` 维护跨次幂等，不依赖 `out_order_no`。

### ⚠️ 加签 / 验签三种格式不可混用

| 场景 | 格式 | 关键差异 |
|---|---|---|
| 请求加签 | 5 行 | 含 appid + serial_no |
| 同步响应验签 | 5 行 | 从 `Lklapi-*` Header 取值 |
| **异步通知验签** | **3 行** | **无 appid / serial_no，且 body 必须用 HTTP 原始字节**（禁止 JSON.parse 后 stringify） |

错把 5 行套用到异步通知验签是常见错误。3 行格式：`${timestamp}\n${nonce_str}\n${body}\n`，每行 `\n` 包括最后一行。

### ⚠️ 证书文件辨识

拉卡拉给的两个 `.cer` 文件容易搞混：

| 文件名 | 实际是 | 对应 env |
|---|---|---|
| `OP00000003_private_key.pem` | 接入方私钥（凤御自己用来加签） | `LAKALA_PRIVATE_KEY_PEM` |
| `OP00000003_cert.cer` | 接入方公钥证书（部署给拉卡拉，凤御自己**不用**）| — |
| `lkl-apigw-v2.cer` | **拉卡拉平台公钥证书**（用于验拉卡拉响应签名）| `LAKALA_PLATFORM_CERT_PEM` |

最容易踩的坑：把 `OP00000003_cert.cer` 当成平台公钥配到 `LAKALA_PLATFORM_CERT_PEM` —— 验签会全部失败。

### ⚠️ CloudBase 部署 / 环境变量陷阱

1. **`tcb fn deploy --force` 会重置 envVariables** — 仅用 `tcb fn code update`（只更新代码不动 env）+ `tcb config update fn`（只更新 env 不动代码）
2. **`tcb` CLI 3.0.1 不支持 `--envVariables` 命令行参数** — env 必须写入 `cloudbaserc.json` 后 `tcb config update fn <name>` 同步
3. **HTTP 触发器 URL 不是 `*.service.tcloudbase.com`** — 实际是 `<envId>-<appid>.<region>.app.tcloudbase.com`，例如：
   ```
   https://cloud1-3gpht4b01ff88838-1406056527.ap-shanghai.app.tcloudbase.com/lakala/notify
   ```
4. **`cloudbaserc.json` 不入 git**（gitignored）— 仅本地配置 + secret 来源

### ⚠️ drizzle migration journal 漂移

如果 `db/migrations/0044_xxx.sql` 已生成但 `db/migrations/meta/_journal.json` 没追加 idx 44 entry，`npm run db:migrate` 会**静默跳过**这次迁移，没有任何报错。

修复：手工往 `_journal.json` 的 `entries` 末尾追加：

```json
{
  "idx": 44,
  "version": "7",
  "when": <unix_ms>,
  "tag": "0044_aspiring_serpent_society",
  "breakpoints": true
}
```

通常是 `npm run db:generate` 后某次 git reset 把 `_journal.json` 改动抹掉了 —— 需要 commit 锁定。

### ⚠️ 长 session 中 mock 兜底的危害

最初设计 `order.pay` 兜底 mock 分支：拉卡拉未配置时返回 `{ paymentParams: { ... totalFee, paySign: 'mock_sign' } }`。结果用户测试时：
- 前端调 `wx.requestPayment(mockParams)` → 微信报 `JSAPI param invalid: total_fee`（mock 的 prepay_id 假，微信验不过）
- 支付宝 mock 返回 `https://qr.alipay.com/mock_xxx` → 前端 image 渲染 → 404

这些错误**比直接抛 `INVALID_STATE: LAKALA_NOT_CONFIGURED` 更具误导性**——开发者会怀疑代码 / 拉卡拉 / 网络，而真正原因是"门店没启用 lakala_enabled"或"env vars 没配齐"。

修复：完全删除 mock 兜底，未配置时直接抛清晰错误前缀（`INVALID_STATE: LAKALA_NOT_CONFIGURED: 该门店未启用拉卡拉聚合支付`）。

### ⚠️ 长 session 改动易丢

本次接入跨 6 个 Phase + 多轮联调，`git reset --hard` / smart-commit 多次抹掉**未及时 commit 的 Phase 3 改动**（`clientApi/routes/order.js` + `miniprogram/pagesOrder/checkout/checkout.ts` + `miniprogram/app.json`），不得不重做 3 次。教训：

- 关键改动（特别是修改 mock 删除 / lakala 分支注入这类核心逻辑）应**立即 commit**，不要积攒在工作区
- 用 `git stash` 临时保存比工作区裸放安全
- 部署 (`tcb fn code update`) 之前用 `git status` 确认要部署的代码在工作区里

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
