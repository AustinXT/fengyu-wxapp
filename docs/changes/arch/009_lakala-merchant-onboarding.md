---
type: arch
number: "009"
date: 2026-05-29
title: 拉卡拉商户入网模块（admin 14 步 OpenAPI 流程 + N:1 商户绑定 + 费率全 admin 不可见）
tags: [admin, lakala, onboarding, schema, payments]
related: ["arch/003", "arch/008"]
---

# arch/009 拉卡拉商户入网（admin）

## 背景与动机

`arch/003` 接入拉卡拉收银台支付（已被 `arch/008` 重写为聚合主扫），但**商户入网** 一直只能由人工去拉卡拉商户后台办：新店开通后需要客服手动拿 `merchant_no` / `term_no` / 微信子商户号 / 支付宝子商户号回填 stores 表，流程零自动化、零审计。

本次给 admin 新建顶级菜单「商户入网」，对接拉卡拉 OpenAPI 完整 14 步流程：
电子合同申请 → 附件上传 → 新增商户进件 → 进件回调 → 复议提交 → 进件信息查询 → 拿 merchant_no/term_no → 子商户号查询 → 微信/支付宝实名报备 → 实名修改/扫码授权 → 发起交易。
落地后新店可直接在 admin 内一次性走完入网，门店关联商户即可启用收款。

## 关键决策

### 数据模型：独立「拉卡拉商户」维度 + 门店 N:1 关联
新建 `lakala_merchants` 主表 + `lakala_merchant_attachments` + `lakala_merchant_logs` 三表。
- **门店与商户 N:1**：`stores.lakala_merchant_id text references lakala_merchants(id) ON DELETE SET NULL` — 一家门店至多绑一个商户，一个商户可被多家门店选用。不引入中间表。
- **stores 4 列语义分流**：
  - `lakala_merchant_no` / `lakala_sub_appid`：由商户派生的**快照**（admin UI 不再手填）
    > 后续修正：`lakala_sub_appid` 列已于 fix/001 移除，sub_appid 改由云函数 env `LAKALA_SUB_APPID` 全局供给（凤御主小程序跨门店一致，从无个性化需求）。stores 上仅剩 `lakala_merchant_no` 一列快照。
  - `lakala_term_no`：store 级独立维护（虚拟终端可空）
  - `lakala_enabled`：store 级"是否启用收款"开关
- **历史数据搬迁**：migration 0058 内嵌一次性 SQL — 扫描 `WHERE lakala_merchant_no IS NOT NULL` 的 stores 自动建 `lm_legacy_{store_id}` stub 商户行（status=`completed`、applicant_user_id=NULL）并回填 FK，避免"有快照无主表"。

### 状态机：13 状态 × 14 事件集中实现
`fengyu-admin/src/lib/lakala-onboarding-state.ts` 暴露 `nextState(current, event)` —— 所有 server action 写入 onboarding_status 必经此函数，非法转换抛 `TransitionError`（`code='INVALID_STATE: LAKALA_TRANSITION_BLOCKED'`）；含回退路径 `contract_signing → draft`（合同申请失败可重做）。单测覆盖 31 条合法 transition + 138 条非法转换。

### 费率信息全 admin 不可见（§0★ 硬安全约束）
**所有 admin 角色（含 super-admin）在 UI / 日志 / 复议 diff / 任意 server action 返回值中都看不到费率信息**。落地方式：
- 费率配置存 `system_configs.lakala.rate.*`（PG 单表），由用户本人通过 SQL 直接维护
- `fengyu-admin/src/lib/lakala-rate.ts` 仅 server-side helper（`loadRateConfig()`），**绝不**暴露 server action 或返回到任何 React Server Component 渲染流
- `submitMerchant` / `updateLakalaMerchantInfo` action 内部 `loadRateConfig()` 注入 `feeData` 给 client；action 公共类型签名**不含**费率字段
- `lakala-redact.ts` 的 `REDACT_RATE_FIELDS` 含 15 个费率字段名（feeRate / rateCode / rateType / feeData / serviceFee 等），日志写入前命中即替换为 `'***'`
- 表单为 6 分组（基本/法人/经营/结算/附件/实名报备），**无费率分组**
- CI 守护测试 `lakala-no-rate-leak.test.ts` 静态扫描 `app/(main)/lakala-onboarding/**/*.tsx` + `components/lakala/**/*.tsx` + stores 编辑页 18 个禁字 token，发现费率字段名即 fail

### 回调入口在 admin，不走 payNotify
新建 Next.js Route Handler：
- `/api/lakala/callback/incoming` — 进件回调（拿 merchant_no/term_no）
- `/api/lakala/callback/contract` — 电子合同人工复核异步通知

实现要点：
- `runtime='nodejs'` + `dynamic='force-dynamic'`；`request.text()` 取原始字节验签
- 复用 client.ts 的 `verifyResponseSignature`（首次 export）
- IP 白名单：`NODE_ENV=production` 且 `LAKALA_CALLBACK_IP_WHITELIST` 为空 → 启动 fail-fast
- **异常分级响应**（防数据丢失）：
  - 签名错 / IP 不在白名单 → `401`
  - DB 不可达 / 基础设施异常 → `503`（让拉卡拉重试）
  - 业务异常（out_org_code 找不到 / 非法状态转换）→ `200` + `{code:'SUCCESS'}` + 落 ERROR 日志（避免重试风暴）
- 并发保护：处理前 `SELECT FOR UPDATE` 锁行，防与 admin queryStatus 并发推进状态机

### 回调兜底：admin cron-worker
`fengyu-admin/src/cron/lakala-onboarding-poll.ts` 每 5 分钟主动查询 status in (submitted, callback_pending, appealing) 的商户调 `queryMerchant`、realname_pending 的商户调 `query{Wx/Alipay}Realname`，防御"未收到回调"场景。

### reqId 幂等
`lakala_merchants.last_req_ids jsonb` 按 endpoint 存上次未确认成功的 reqId。所有外发请求生成 reqId 前先复用历史值；成功后清除；失败保留。避免网络中断重试时拉卡拉端产生两笔进件。

### PEM 改懒加载
`lakala-client.ts` 的 PEM 校验从**模块加载期**改为**首次 `request()` 调用期**。防 admin docker build 阶段缺 `LAKALA_PRIVATE_KEY_PEM` 导致 `next build` 中断（同 `[admin-build-jwt-secret-placeholder]` 同款坑）。build 时只需占位 PEM 即可。

### 安全脱敏
`lakala-redact.ts` 暴露 `redact()` —— PII（手机/身份证/银行卡/各种 id 字段共 23 项）+ 费率（15 项）。手机 11 位 `138****1234`、身份证 18 位 `110101********1234`、银行卡 `6225****1234`、费率字段一律 `'***'`。所有 lakala_merchant_logs 写入前必经。

## 实现规模

| 模块 | 文件数 | 行数（净增） | 测试 |
|------|--------|--------------|------|
| db schema + migration | 4 (lakala.ts + 0058 SQL + enums/index/org 改) | ~370 | 224 单测（状态机 + 脱敏） |
| client 扩展 | 4 (client.ts + dicts + rate + 测试) | ~1850 | 34 单测 |
| 回调 + cron | 5 (incoming/contract route + poll + 测试) | ~1850 | 31 单测 |
| server actions | 4 (lakala-onboarding.ts + stores 改 + 测试 + e2e impl) | ~2200 | 13 单测 + 10 step e2e |
| UI | 13 (6 页 + StepProgress + stores edit 改 + menu/permissions + 守护测试) | ~1900 | 守护 28 断言 |
| 文档 | 2 (endpoints 契约 + 本 changedoc) | ~1500 | — |
| **合计** | **32** | **~9670** | **330 单测全绿 + e2e 10 step 全绿** |

回归：admin 全套 vitest 1789/1789 通过。tsc：本次工作树 26 个 pre-existing drizzle 0.45 跨表推断错误（比 baseline 44 个少 18，未引入新错误）。

## 跨端影响

- **fengyu-client / payNotify 零改动**：现有 `resolveLakalaMerchant`（[lakala-per-store-merchant]）仍读 stores 上的 4 列；admin 绑定时刷快照即可。
- **stores 编辑页**：手填 `lakala_merchant_no` + `lakala_sub_appid` 替换为「关联商户」单选下拉（admin 可改、hr 只读）；`lakala_term_no` + `lakala_enabled` 仍是 store 级独立编辑。（注：`lakala_sub_appid` 列已于 fix/001 移除，本句保留是为记录决策演化）
- **菜单**：新增顶级「商户入网」（仅 admin），独立 6 项权限 `lakala:onboarding:read/create/update/submit/realname/delete`，其他角色不开。

## 部署 checklist

1. `db:migrate` 5434/fengyu（业务主库，db/CLAUDE.md 明确单库）→ 应用 migration 0058 含 legacy 搬迁 SQL
2. admin `.env` 配齐：`LAKALA_API_BASE`（test=`https://test.wsmsd.cn/xx` / prod=`https://s2.lakala.com/xx`）+ `APPID` / `SERIAL_NO` / `PRIVATE_KEY_PEM` / `PLATFORM_CERT_PEM` / `INCOMING/CONTRACT_NOTIFY_URL` / `CALLBACK_IP_WHITELIST`
3. admin docker build：builder stage 必须给占位 `LAKALA_PRIVATE_KEY_PEM` / `PLATFORM_CERT_PEM`（懒加载兜底，但 ts 静态 import 校验不掉）
4. prod admin 域名 + 证书：当前 47.113.202.7:3000 走 https 需配域名；NOTIFY_URL 填到 .env 与拉卡拉商户后台
5. 拉卡拉商户后台填回调 URL + 白名单服务器出口 IP（阿里云安全组放行 → admin 443）
6. 重新部署 admin 才生效（含 cron-worker：[monthly-activity-no-cron] 同款规则）
7. 系统配置 `system_configs.lakala.rate.*` 由用户本人通过 SQL 直接维护（admin UI 不读不写费率）

## 后续 follow-up

- 端到端联调（test 环境）走通 14 步：需拉卡拉测试 APPID / 私钥 / 平台证书 + 测试商户后台
- 字典数据（地区码 / MCC / 业务类型等）首版静态硬编码，迭代时再接拉卡拉「数据字典表」接口同步
- 实名子页扫码 `receOrgNo` / `channelId` 当前要 admin 手填，可后续加 `queryRealnameContext` action 自动填
- drizzle 0.45 跨表推断的 26 处 pre-existing tsc error 与本次无关，独立 follow-up

## 联调记录（2026-05-30，v3 修订）

### 角色定位确认
凤御作为「接入服务商」角色接入拉卡拉：
- **接入应用机构（服务商）**：分公司-本牛信息 lsy，编号 `31318393` = OpenAPI `org_id` / `org_code`
- **合作方**：邵冬，合作方编号 `24583784`（部分接口可能用 `partnerNo`）
- **法人**：邵冬，身份证 3301**********621X，手机 158****4551
- env：`LAKALA_ORG_CODE=31318393` / `LAKALA_PARTNER_NO=24583784`

### v2 包络解析 fallback bug 修复（lakala-client.ts L292-308）
拉卡拉网关层异常（GW0004 / GW0001 等）不论 envType 都返回 v3 风格 `{ code, message }` 顶层，
原 v2 envelope 仅读 `parsedRaw.retCode` / `retMsg` 把网关错误吃成空字符串，掩盖真错误。
修复：v2/v3 都对顶层 `code` / `message` 字段兜底解析。新增 2 个单测守护（v2/v3 各 1），36 单测全绿。

### SIT 联调链路验证
- HTTP 通讯、签名 SHA256withRSA、平台证书验签、PEM 字面量 `\n` 还原 — 全部已验证 ✅
- 4 个只读接口（querySubMerchantId / queryWxRealname / queryAlipayRealname / queryWxConfig）实际打到 SIT，
  返回 `HTTP 403 + {"code":"GW0004","message":"访问授权不通过！【禁止外网访问！】"}`
- 这证实：代码层、签名层、网络层全通；阻塞 100% 在拉卡拉 SIT 网关 IP 白名单

### 联调阻塞清单（业务侧任务）
1. **SIT IP 白名单**（最阻塞，跟 ORG_CODE 无关）：当前开发出口 IP 不在拉卡拉 SIT 网关白名单内 → 业务方
   联系拉卡拉客户经理把开发出口 IP 加白名单（SIT + prod 是两套独立白名单）
2. **真实附件文件**：18 类企业证件（营业执照 / 法人身份证正反 / 结算卡 / 门头照 等）
3. **法人手机验证码**：step 13 法人扫码授权环节需邵冬本人手机配合
4. **prod 域名 + https 证书**：当前 admin 47.113.202.7:3000，回调 NOTIFY_URL 需 https 域名

### 误判与撤回（用于后续团队避坑）
联调期间基于不完整证据一度判定"凤御是普通商户"，提议**简化方案删除 20+ 文件**，并已动手改
`db/schema/lakala.ts` 与 `enums.ts`。用户提供商户后台截图（服务商编号 31318393 / 合作方编号 24583784）
证实**凤御实际是接入服务商角色**，简化方向错误。
撤回路径：`git restore db/schema/lakala.ts db/schema/enums.ts`，**未污染生产数据**（5434/5433 migration 0058
已成功上线、未生成 0059）。整套 32 文件 / ~9670 行代码 / 330 单测保留不变。

## 相关项目记忆

- [lakala-per-store-merchant] — 现有"一店一商户·按门店路由"逻辑保留不变
- [lakala-integration-202605] — 拉卡拉支付/退款链路（arch/003 → arch/008）
- [admin-build-jwt-secret-placeholder] — docker build 期占位 env 模式
- [db-live-db-is-5433] / [db-dual-env] — db/CLAUDE.md 实际已统一 5434 单业务库
- [no-legacy-compat] — 开发阶段无历史兼容，但 prod 已存的 stores 手填值仍由 migration 0058 自动搬迁
