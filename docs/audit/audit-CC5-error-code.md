# 审计报告：错误码与错误前缀（CC5 横切收官）

**审计时间**：2026-04-25 16:30
**域 ID**：CC5
**审计员**：claude-opus-4-7
**审计时长**：~15 分钟
**关联 PR/Ticket**：—
**前置归集**：[CROSS-CUTTING.md §CC5](./CROSS-CUTTING.md#cc5-错误码与错误前缀)

> **域定义**：横切收官审计——三端"错误前缀规范化 + 响应外壳一致性"全栈健康专项。CC5 不属于单业务域，本报告统一收口 25 个业务域报告内 CC5 节的散点命中。

---

## 1. 三端错误抛出 helper 入口对照

| 层 | admin | staff | client | payNotify |
|----|-------|-------|--------|-----------|
| 错误抛出 helper | **无**（裸 `throw new Error(msg)`，无统一 ApiError 类） | **无**（裸 `throw new Error('PREFIX: msg')`） | **无**（裸 `throw new Error('PREFIX: msg')`） | **无**（裸 `throw new Error(...)` + `return {code:'FAIL',message}`） |
| 错误捕获 / 响应外壳 | Server Action 各 action 内 `try/catch`，返回 `{ success: false, message }`（48 个 catch 块）| `staffApi/index.js:164-192` 全局 catch + 前缀解析 | `clientApi/index.js:115-142` 全局 catch + 前缀解析 | `payNotify/index.js:507-509` 全局 catch + `{code:'FAIL',message:err.message}` |
| 已知前缀白名单 | 无统一定义 | `['UNAUTHORIZED','PHONE_REQUIRED','INVALID_PARAMS','PERMISSION_DENIED','NOT_FOUND','INSUFFICIENT_BALANCE','CLIENT_NOT_REGISTERED','CONFLICT','INVALID_STATE']`（**9 项**）| `['UNAUTHORIZED','PHONE_REQUIRED','INVALID_PARAMS','PERMISSION_DENIED','NOT_FOUND','INSUFFICIENT_BALANCE']`（**6 项**） | 不解析前缀，直接透传 message |
| 响应外壳 | `{ success: boolean, message: string, data?: any }` | `{ code: 0\|-1\|-400\|-401\|-403\|-404, message, errorType, data }` | `{ code: 0\|-1\|-400\|-401\|-403\|-404, message, errorType, data }` | `{ code: 'SUCCESS'\|'FAIL', message }` |
| 前端调用 helper | Next.js form action / hook | `fengyu-staff/miniprogram/utils/cloud.ts:39-52` `callStaffApi` | `fengyu-client/miniprogram/utils/cloud.ts:18-46` `callClientApi` | — |
| 前端是否保留 errorType | N/A | **❌ 丢弃**（仅 `throw new Error(message)`，未透出 errorType/code） | ✅ 保留（`ClientApiError.errorType / .code / .data`）| — |

**关键结论：四端共四种响应外壳，零端共享错误抛出 helper。**

---

## 2. 错误抛出量化（统计 2026-04-25）

排除 `__tests__` / `node_modules`，仅业务代码：

| 端 | `throw new Error(...)` 总数 | 4 项规范前缀 | 自定义前缀 / 中文裸抛 | 规范率 |
|----|-----|-----|-----|------|
| admin (`fengyu-admin/src`) | **51** | 4 | **47**（自定义前缀 / 中文裸抛 / 无前缀） | **7.8%** |
| staff (`fengyu-staff/cloudfunctions`) | **294** | 241 | **53** | 82.0% |
| client (`fengyu-client/cloudfunctions`) | **146** | 131 | **15** | 89.7% |
| payNotify | 4（含 1 含 `INVALID_PAY_AMOUNT:` / 1 含 `INSUFFICIENT_BALANCE:`） | 0 | 4 | 0% |

### 2.1 admin 自定义/无前缀汇总

| 类别 | 计数 | 例子（文件:行） |
|------|------|----|
| 自定义业务前缀（5 类，9 个子值）| 28 | `CARD_NOT_FOUND`/`CARD_STORE_MISMATCH`/`CARD_OWNER_MISMATCH`/`CARD_DIRECTION_INVALID`/`CARD_ORDER_STATUS_INVALID`/`CARD_EXHAUSTED`/`CARD_TYPE_INVALID`/`CARD_CONCURRENT_CHANGED`/`CARD_UPSERT_FAILED`/`PREPAID_CARD_UPSERT_FAILED`/`SKU_NOT_FOUND`/`ORDER_ID_GEN_FAILED`/`ORDER_ID_CONFLICT`/`REF_ORDER_NOT_FOUND`/`INVALID_STATE`/`CLIENT_NOT_REGISTERED`/`OVERPAY`/`INSUFFICIENT_BALANCE`/`INSUFFICIENT_SESSIONS`/`OVER_QUANTITY`/`CONCURRENT_CHANGED`（`actions/orders.ts:1175-1752`、`refunds.ts:170-1020`、`pickup-records.ts:327`、`employees.ts:316`）|
| 中文裸抛（无前缀）| 8 | `'员工编号生成失败'`（employees.ts:316）/`'订单号生成失败'`（orders.ts:895）/`'优惠券已被使用，请刷新后重试'`（orders.ts:971）/`'未配置 WX_CLIENT_SECRET 环境变量'`（orders.ts:1833）/`'获取 access_token 失败...'`（orders.ts:1842）/`'上传失败'`（cloudbase.ts:29）/`'服务单号生成失败'`（services.ts:515）/`该顾客已有待支付订单 ${...}` 等模板字符串（orders.ts:910）|
| 含 `INVALID_PARAMS:` ✓ | 11 | `coupons.ts:118`、`refunds.ts:170`、`recharge.ts:43-53`、`refund.ts:84-94`(lib) — 仅 `lib/` 子目录有较好规范 |
| 含 `PERMISSION_DENIED:` ✓ | 1 | `permissions.ts:218`（被全局 `requirePermission` helper 调用，整个 admin 全局共享）|

**admin 唯一统一约定的是 `requirePermission()` 的 `PERMISSION_DENIED:` 前缀**，其他错误前缀完全开发者自由发挥。

### 2.2 staff 自定义前缀

| 自定义前缀 | 出现次数 | 来源 |
|-------------|----------|----|
| `INSUFFICIENT_BALANCE:` | 5 | `routes/order.js:432, 858, 862, 1815, 1819` |
| `CLIENT_NOT_REGISTERED:` | 3 | `routes/order.js:241, 1774, 2014` |
| `INVALID_STATE:` | 2 | `routes/order.js:1372, 1926` |
| `CONFLICT:` | 1 | `routes/order.js:1357` |
| `NOT_FOUND:` | 1 | `routes/order.js:2536` |
| 中文裸抛 / 拼音前缀 | ~41 | 例如 `service.js:367` 等已在 audit-05 P2-05-17 命中 |

### 2.3 client 自定义前缀

| 自定义前缀 | 出现次数 | 来源 |
|-------------|----------|----|
| `INSUFFICIENT_BALANCE:` | 5 | `routes/order.js:389, 1331, 1421, 1426, 1607` |
| 中文裸抛 / 其他 | ~10 | 散落 |

### 2.4 staff index.js 把 9 项前缀都加入了 knownTypes 白名单（违反 4 项约定）

`fengyu-staff/cloudfunctions/staffApi/index.js:171`：
```js
const knownTypes = ['UNAUTHORIZED', 'PHONE_REQUIRED', 'INVALID_PARAMS', 'PERMISSION_DENIED',
  'NOT_FOUND', 'INSUFFICIENT_BALANCE', 'CLIENT_NOT_REGISTERED', 'CONFLICT', 'INVALID_STATE']
```
而 client `clientApi/index.js:122-125` 仅 6 项：`UNAUTHORIZED / PHONE_REQUIRED / INVALID_PARAMS / PERMISSION_DENIED / NOT_FOUND / INSUFFICIENT_BALANCE`。

**相同的错误（如 `CONFLICT:`）由 staff 抛会保留前缀，由 client 抛会被吞成"服务器内部错误"**——同样的业务条件、不同的 UI 文案。

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

无（CC5 不直接造成资损或越权）。

### 3.2 P1（数据一致 / UI 错乱）

#### **[P1-CC5-01]** staff `callStaffApi` 丢弃 errorType 与 code，UI 无法精准 dispatch
- 文件：`fengyu-staff/miniprogram/utils/cloud.ts:39-52`
- 现象：相比 client `ClientApiError {code, errorType, data}`（cloud.ts:17-21）保留服务端 errorType，staff 仅 `throw new Error(sanitizeErrorMessage(res.result?.message, '请求失败'))`，丢弃 `code`/`errorType`。
- 风险：所有需要按 errorType 分流的场景（如"PHONE_REQUIRED 跳到绑手机页"）staff 端只能用 `msg.indexOf(...)` 子串匹配，且因服务端 `displayMessage` 已**剥除前缀**（index.js:173），子串匹配永远不命中。
- 复现：`packageMgmt/mgmt-customer-detail/mgmt-customer-detail.ts:248` `if (msg.indexOf('PERMISSION_DENIED') >= 0)` 永远为 false（服务端把 `PERMISSION_DENIED:` 前缀剥除后才返回 message）→ Toast 显示"加载失败"或剥除后的中文，永远不进入"顾客不在当前数据范围"分支。
- 修复：(L9) 把 `callStaffApi` 改为与 client 对齐的 `StaffApiError` 类，把 `errorType / code / data` 都挂到 err 对象上。
- 关联：CC5 / CC4 / 与 audit-01 P2-ERROR-12、audit-02 P2-02-17 同源根因
- 命中场景：staff 1 处直接受影响（mgmt-customer-detail），潜在影响 43 处 `wx.showToast` 调用点

#### **[P1-CC5-02]** 三端响应外壳分裂为四种格式（admin / staff / client / payNotify）
- 文件：
  - admin Server Actions: `{ success: boolean, message: string, data?: any }` × 372 处
  - staff cloud function: `{ code: 0|-1|-400|-401|-403|-404, message, errorType, data }`
  - client cloud function: 同 staff
  - payNotify: `{ code: 'SUCCESS'|'FAIL', message }`
- 现象：相同的"错误"在不同入口转译规则不一致——admin 不区分 4xx/5xx，client/staff 区分但语义粒度不同（staff 多 `-409 CONFLICT`），payNotify 完全独立体系。
- 风险：跨端共享 lib（如 `lib/refund.ts` 同时被 admin server action 和...理论上其他端调用？）抛同一类 `INVALID_PARAMS:` 错误，admin 落到 `{success:false}`、staff 落到 `{code:-400}`，前端调用方需写两套 dispatch。
- 修复：(L7) 三端统一抽 `lib/api-error.ts`：`class ApiError extends Error { code, errorType, prefix }`；admin / staff / client / payNotify 全部 `throw new ApiError('INVALID_PARAMS', '...', { ... })` + 顶层捕获按相同规则映射 `{ code, message, data }` 或 `{ success, message }`（保留各自外壳，但内部错误对象统一）。
- 关联：CC5 / 全栈最终统一 epic
- 命中场景：所有 25 业务域

#### **[P1-CC5-03]** staff index.js knownTypes 白名单偏离 4 项约定 + client 偏离不同程度
- 文件：`fengyu-staff/cloudfunctions/staffApi/index.js:171`、`fengyu-client/cloudfunctions/clientApi/index.js:122-125`
- 现象：约定的 4 项前缀（`UNAUTHORIZED / PHONE_REQUIRED / INVALID_PARAMS / PERMISSION_DENIED`）在两端都被扩展：staff = 9 项，client = 6 项。`CONFLICT:` `INVALID_STATE:` `CLIENT_NOT_REGISTERED:` 仅 staff 知，client 不知；同条业务路径若由 client 调（如顾客自助退款触发 `CLIENT_NOT_REGISTERED:`，理论上不会发生但若发生）则被吞成"服务器内部错误"。
- 风险：CLAUDE.md 项目规范 "错误前缀约定：UNAUTHORIZED: / PHONE_REQUIRED: / INVALID_PARAMS: / PERMISSION_DENIED:"（共 4 种）作为"权威约定"已被代码实践打破。新人按 CLAUDE.md 改 client 端，会把现有 6 项 staff 通用前缀视为"非法"而抛 INVALID_PARAMS，后续 staff index 解析失败。
- 修复：(L0) 在 db/schema 或 cloudfunctions 共享 `helpers/error-codes.js` 单点声明权威白名单（统一 8 项或回退 4 项）；CLAUDE.md 同步更新；admin 同步约定 `success:false` 时 message 也带前缀。
- 关联：CC5 主线
- 决策项：业务上是否扩展约定为 8 项（含 `NOT_FOUND / INSUFFICIENT_BALANCE / CONFLICT / INVALID_STATE`）？审计建议**扩展**，因 staff 现有代码已成事实标准。

#### **[P1-CC5-04]** admin 错误响应 `{success:false, message}` 与 staff/client `{code:-N, message}` 无法跨端对齐
- 文件：admin 全部 `actions/*.ts`
- 现象：admin 错误从不返回 `code:-401/-403/-400`，前端 hook 无法通过 status code 做"未登录跳登录页"等通用拦截，仅靠 message 字符串匹配。
- 风险：（资损/越权风险低，主要影响 UI 灵活性 + 后续接 OpenAPI / API gateway 时需重写）。
- 修复：(L7) admin 统一封装 `withApiResponse(action)` HOF，输出 `{ code: 0 | -N, message, data }`，与 staff/client 对齐；或保留 `{success}` 但补 `code` 字段。
- 关联：CC5 / 与 P0-AUTH-01（admin 缺鉴权 wrapper）一并改造
- 命中场景：admin 全部 47 个 server action

### 3.3 P2

#### **[P2-CC5-05]** admin 自定义业务前缀膨胀至 28 处（CARD_*、SKU_*、ORDER_*、CONCURRENT_*）
- 文件：`fengyu-admin/src/actions/orders.ts:1175-1752`、`refunds.ts:844-1020`、`pickup-records.ts:327`
- 现象：随着业务扩展，admin 内部产生 9 个 `CARD_*` 子前缀、3 个 `ORDER_ID_*`、`OVERPAY:` `INSUFFICIENT_BALANCE:` `INSUFFICIENT_SESSIONS:` `CONCURRENT_CHANGED` `OVER_QUANTITY:`，全部不在约定 4 项内，且 admin 自身 catch 处也不区分这些前缀（仅 `if (err?.code === '23503') return ...`），相当于**写了前缀但无人消费**。
- 风险：纯代码质量问题，无功能影响，但维护成本随业务增加而线性增长。
- 修复：(L7) 全部归并到 `INVALID_STATE:` / `INVALID_PARAMS:` / `CONFLICT:`（如扩展约定到 8 项）；保留细分 reason 在 message 后半段（如 `'INVALID_STATE: 储值卡余额不足'`）。
- 关联：CC5

#### **[P2-CC5-06]** payNotify 响应外壳完全独立（`{code:'SUCCESS'/'FAIL'}`）
- 文件：`fengyu-client/cloudfunctions/payNotify/index.js:45,62,82,91,97,183,221,505,508`
- 现象：payNotify 是微信支付平台回调，其响应 spec 由微信定义（`SUCCESS / FAIL`），不能改成 `{code:0,...}`。但**内部异常 message** 直接透出（`{code:'FAIL', message: err.message}` line 508）会暴露 `INVALID_PAY_AMOUNT: 1234.56` 给微信回调，记录在微信侧异常日志中。
- 风险：微信支付重试逻辑：FAIL 会触发重试，每次重试都暴露内部错误明细。
- 修复：(L3) `return { code: 'FAIL', message: '处理失败' }`（不透出明细），明细仅写云函数 console.log。
- 关联：CC5 / CC6（PII 弱命中）

#### **[P2-CC5-07]** 前端 0 处使用 errorType 做 PERMISSION_DENIED 分流
- 文件：扫描 `fengyu-{staff,client}/miniprogram --include="*.ts"`
- 现象：仅 client 3 处分流 `errorType === 'PHONE_REQUIRED'`（`pagesProfile/card-recharge`、`pagesOrder/checkout`、`pagesAppointment/appointment-create`），其他 6 项 errorType（含 `INSUFFICIENT_BALANCE` / `CLIENT_NOT_REGISTERED` 等）**0 处使用**。staff 端因 `callStaffApi` 不透出 errorType 字段，0 处使用。
- 风险：服务端 white-list 9/6 项的能力**几乎闲置**——本可用于 UX 体验（如"余额不足→引导充值"），实际未被消费。
- 修复：(L9) Top 5 errorType（`PHONE_REQUIRED / UNAUTHORIZED / PERMISSION_DENIED / INSUFFICIENT_BALANCE / CONFLICT`）补 UI dispatch；或减小服务端白名单回归 4 项。
- 关联：CC5 / 与 [P1-CC5-01] 同源

#### **[P2-CC5-08]** sanitizeErrorMessage 长度阈值 60 字符与 i18n 不友好
- 文件：`fengyu-{staff,client}/miniprogram/utils/cloud.ts:9` `if (msg.length > 60) return fallback`
- 现象：`INVALID_PARAMS: 顾客手机号格式不正确，请输入 11 位中国大陆手机号` 长度 47 字符尚 OK；但更详细的中文提示（包含订单号、SKU 名）经常超 60 → 全部退化为"请求失败"，丢失有效信息。
- 风险：UX 信息丢失，运维难以从客诉中定位问题。
- 修复：(L9) 阈值改 100；或仅检测技术性 pattern 不卡长度。
- 关联：CC5

#### **[P2-CC5-09]** admin Server Action 无统一 `withErrorBoundary` HOF
- 文件：`fengyu-admin/src/actions/*.ts`
- 现象：48 个 catch 块各自处理，模式分裂：`allocations.ts:303` 仅处理 23503；`coupons.ts:334` 处理 INVALID_PARAMS prefix；`employees.ts:337` 处理通用 message。新增 server action 时容易漏 catch 任何 PG 错误。
- 修复：(L7) `lib/server-action.ts` 引入 `withApiResponse(handler)` HOF，集中处理 PG 错误码（23503/23505/22P02）转 `{success:false, message:'...'}`、抛 ApiError 时按前缀映射。
- 关联：CC5 / CC4

#### **[P2-CC5-10]** sanitizeErrorMessage 拦截规则三端轻微差异
- 文件：staff `utils/cloud.ts:9` 与 client `utils/cloud.ts:9`
- 现象：staff regex 有 12 项关键字，client 多 1 项 `cloud\.\w+:fail`（line 9 末尾）
- 修复：(L9) 三端 sanitize 规则收口到共享文件
- 关联：CC5 / CC9

---

## 4. 跨端不一致（核心）

| 维度 | admin | staff | client | payNotify | 不一致风险 | 优先级 |
|------|-------|-------|--------|-----------|-----------|--------|
| 错误抛出 helper | 无 | 无 | 无 | 无 | 无中央定义 | P1 |
| 已知前缀白名单 | 无定义 | 9 项 | 6 项 | 不解析 | staff/client 同条业务可能不同响应（同 `CONFLICT:`，client 吞成 500）| P1-CC5-03 |
| 响应外壳 | `{success, message, data}` | `{code, message, errorType, data}` | 同 staff | `{code:'SUCCESS'/'FAIL', message}` | 4 套外壳，前端跨端复用 lib 几乎不可能 | P1-CC5-02 |
| 错误 code | 无 | -1/-400/-401/-403/-404 | 同 staff | SUCCESS/FAIL | admin 无 code，无法做通用 401 拦截 | P1-CC5-04 |
| 4 项约定遵守 | 7.8% | 82.0% | 89.7% | 0% | admin **绝大多数错误无前缀**——前端无法规则化 | P1 |
| `PERMISSION_DENIED:` | 1 处（permissions.ts:218）覆盖全部 admin requirePermission | 散写 4 处 | 散写 0 处（client 无管理权限）| 不抛 | admin ✅ helper 模式正确 | — |
| 自定义业务前缀 | 28 处（CARD_*、ORDER_*、INSUFFICIENT_*）| 12 处（INSUFFICIENT_BALANCE / CLIENT_NOT_REGISTERED / CONFLICT / NOT_FOUND / INVALID_STATE）| 5 处（仅 INSUFFICIENT_BALANCE）| 2 处（INVALID_PAY_AMOUNT / INSUFFICIENT_BALANCE）| 同前缀语义但 admin/staff 实现路径不互通 | P2-CC5-05 |
| 前端 errorType 透出 | N/A | ❌（callStaffApi 丢） | ✅ | N/A | staff 永远走"按 message 子串匹配"反模式 | P1-CC5-01 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [ ] CC1 数值精度：N/A（CC5 不涉及金额）
- [ ] CC2 并发幂等：N/A
- [ ] CC3 组织隔离：N/A
- [ ] CC4 鉴权：交集 — `requirePermission` 抛 `PERMISSION_DENIED:` 是 admin 唯一统一前缀（[P2-CC5-05]）；客户端 `requirePhone` 抛 `PHONE_REQUIRED:` ✓
- [x] **CC5 错误码（本域）**：见 §3 全节
- [ ] CC6 PII：[P2-CC5-06] payNotify FAIL 响应透出 `INVALID_PAY_AMOUNT: 1234.56` 含金额回到微信平台日志
- [ ] CC7 时间字段：N/A
- [ ] CC8 WXML/Vant：弱关联——staff `wx.showToast({ title: msg })` 在 msg 含未剥除前缀时（实际不会）会显示 `INVALID_PARAMS: xxx`
- [ ] CC9 测试：staff `__tests__/utils/cloud.test.ts:117` 测试断言 "PERMISSION_DENIED 前缀原样返回"，但实际 callStaffApi 调用 sanitizeErrorMessage 后服务端已剥前缀——测试覆盖错位

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `cloudfunctions/_shared/error-codes.js`（新建）| 单点声明 8 项官方约定前缀（4 + NOT_FOUND/INSUFFICIENT_BALANCE/CONFLICT/INVALID_STATE）| P1-CC5-03 |
| L0 docs | `CLAUDE.md` 全局规范 | 错误前缀约定从 4 项扩展到 8 项；明示 admin 必须 throw 带前缀；`PERMISSION_DENIED` 由 `requirePermission` helper 统一抛 | P1-CC5-03/04 |
| L0 docs | `.42cog/dev/sys.spec.md` | 三端响应外壳合约：客户端/员工端 `{code,message,errorType,data}`；管理后台 server action `{code, success, message, data}`（兼容当前但加 code）| P1-CC5-02/04 |
| L3 staff | `staffApi/index.js:171` | knownTypes 改为从 `_shared/error-codes.js` 导入；message 不再剥前缀（前端剥）| P1-CC5-03 |
| L3 client | `clientApi/index.js:122-125` | 同 staff，knownTypes 9 项与 staff 对齐 | P1-CC5-03 |
| L3 payNotify | `payNotify/index.js:508` | message 改为通用 `'处理失败，已记录'`；不透出 err.message | P2-CC5-06 |
| L7 admin | `lib/api-error.ts`（新建）| `class ApiError extends Error` + `withApiResponse(action)` HOF 包裹所有 server action | P1-CC5-04, P2-CC5-09 |
| L7 admin | 全部 `actions/*.ts:throw new Error(...)` | 改为 `throw new ApiError('INVALID_PARAMS' \| 'INVALID_STATE' \| ...)`；中文裸抛全部加前缀 | 47 处（admin）+ 28 自定义合并 / P2-CC5-05 |
| L9 staff | `miniprogram/utils/cloud.ts:39-52` | 改 `callStaffApi` 透出 `StaffApiError` 含 errorType/code/data，对齐 client | P1-CC5-01 |
| L9 staff | `packageMgmt/mgmt-customer-detail/mgmt-customer-detail.ts:248` | 改 `if (err?.errorType === 'PERMISSION_DENIED')` | P1-CC5-01 |
| L9 三端 | `utils/cloud.ts` sanitize 长度 60→100 | 长 message 不丢失语义 | P2-CC5-08 |
| L9 三端 | `_shared/sanitize.js` | sanitize 规则收口共享 | P2-CC5-10 |

---

## 7. 验证 SQL（CC5 不涉及 DB，无 SQL 验证）

CC5 是错误处理代码层问题，无 schema / data 维度可校验。仅可在代码层 grep 校验：

```bash
# 验证 4 项约定外的前缀是否归 0
grep -rEn "throw new Error\(['\"]" fengyu-admin/src --include="*.ts" \
  | grep -vE "throw new Error\(['\"]?(UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE):" \
  | grep -v __tests__ \
  | wc -l   # 期望：0（修复后）

# 验证三端 sanitizeErrorMessage 长度阈值一致
grep -n "msg.length >" fengyu-{staff,client}/miniprogram/utils/cloud.ts
```

---

## 8. 回归测试用例（建议）

1. admin Server Action 抛 `INVALID_PARAMS:` 前缀错误，verify 返回 `{ success: false, message, code: -400 }`
2. staff cloud function 抛任意约定外前缀（如 `FOO:`），verify message 为"服务器内部错误" + errorType=null
3. staff `callStaffApi` 接收 `{code:-403, message:'未授权', errorType:'PERMISSION_DENIED'}`，verify `err.errorType === 'PERMISSION_DENIED'`（修复 P1-CC5-01）
4. payNotify 抛 `INSUFFICIENT_BALANCE: 余额不足 100`，verify `{code:'FAIL', message:'处理失败，已记录'}`（不透 100）
5. 测试 sanitizeErrorMessage 长 message（>60 字符但合法中文）保留原文（修复 P2-CC5-08）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（4 端 + 0 DB）**：☑ admin/staff/client/payNotify
- 涉及历史数据：☐（仅代码层）
- 修复成本：**M** — admin 47 处 throw 改 ApiError + staff callStaffApi 重构 + 三端共享 lib 抽取 + CLAUDE.md 同步；建议作为 epic 一次推完

---

## 10. 后续待办

- [ ] 与团队对齐：错误前缀约定从 4 项扩展到 8 项（建议）vs 回归 4 项（保守）
- [ ] L0 创建 `cloudfunctions/_shared/error-codes.js` + `lib/api-error.ts`
- [ ] L7 admin 47 处 throw 全部归并到 ApiError + withApiResponse HOF
- [ ] L9 staff `callStaffApi` 重构透出 errorType
- [ ] CLAUDE.md / `.42cog/dev/sys.spec.md` 同步更新错误码合约
- [ ] CROSS-CUTTING.md §CC5 段标记 ✅ done，链接本报告

---

## 附录 A. 现有报告 §5 CC5 节命中索引

| 域 | 命中类型 | 严重度 | 文件:行 |
|----|---------|-------|---------|
| 01 auth | admin throw 中文裸抛无前缀 | P2-ERROR-12 | audit-01-auth.md |
| 02 order-creation | staff/client 自定义前缀（CLIENT_NOT_REGISTERED/INSUFFICIENT_BALANCE/MIXED_PAYMENT_NOT_SUPPORTED）+ admin 中文裸抛 | P2-02-17 | audit-02-order-creation.md |
| 03 payment-flow | admin recordPayment 自定义前缀（OVERPAY/INSUFFICIENT_BALANCE/CONCURRENT_CHANGED/REF_ORDER_NOT_FOUND）| P2-03-14 | audit-03-payment-flow.md |
| 04 pay-notify | INVALID_PAY_AMOUNT/INSUFFICIENT_BALANCE + FAIL 响应透出明细 | P2-04-14, P1-04-06 | audit-04-pay-notify.md |
| 05 service-order | INVALID_PARAMS 滥用 + 中文裸抛（"次数不足:"）| P2-05-17, P2-05-20 | audit-05-service-order.md |
| 06 appointment-checkin | NOT_FOUND/CONFLICT 缺失 + INVALID_PARAMS 滥用 | P2-06-17 | audit-06-appointment-checkin.md |
| 07 sales-allocation | admin saveAllocation 23505 误判为"员工不存在" | — | audit-07-sales-allocation.md |
| 08 service-commission | admin 全中文裸抛 | — | audit-08-service-commission.md |
| 09 product-sku | admin {success:false,message} 无前缀 | — | audit-09-product-sku.md |
| 10 customer-member-level | INVALID_PARAMS 不属约定语义之一 | P2-10-17 | audit-10-customer-member-level.md |
| 11 refunds | staff CONFLICT 不在 4 约定 | — | audit-11-refunds.md |
| 12 store-binding | INVALID_PARAMS 与 4 约定语义偏离 | P2-12-14 | audit-12-store-binding.md |
| 13 coupons | admin {success:false,message} 与 CC5 全局违规 | — | audit-13-coupons.md |
| 14 prepaid-card | INSUFFICIENT_BALANCE 不在 4 约定 | P2-14-15 | audit-14-prepaid-card.md |
| 15 points-member-level | 无错误前缀（settle 静默吞错）| — | audit-15-points-member-level.md |
| 16 message-center | client read 缺 NOT_FOUND/PERMISSION_DENIED | P2-16-12 | audit-16-message-center.md |
| 17 dashboard | 全部 4 约定 ✅ | — | audit-17-dashboard.md |
| 18 employee-performance | filterType/salesCategory 无白名单 | P1-18-05 | audit-18-employee-performance.md |
| 19 gift-share-assign | customer.assign 误用 INVALID_PARAMS | P2-19-16 | audit-19-gift-share-assign.md |
| 20 pickup | staff 跨店错误用 INVALID_PARAMS | P2-20-02 | audit-20-pickup.md |
| 21 org-structure | admin {success,message} + staff/client 4 约定 ✅ | — | audit-21-org-structure.md |
| 22 permission-matrix | requirePermission 抛 PERMISSION_DENIED ✅ | — | audit-22-permission-matrix.md |
| 23 operation-logs | 日志域无错误返回 | — | audit-23-operation-logs.md |
| 24 product-category-dynamic | admin INVALID_PRODUCT_KIND 自定义前缀 | — | audit-24-product-category-dynamic.md |
| 25 traffic-promoter | bindStore promoter/inviter 静默吞错无前缀 | P1-25-07, P2-25-15 | audit-25-traffic-promoter.md |

总命中：**25/25 域全部命中**（17 域 P2 / 1 域 P1 / 7 域归类未升级）。CC5 是覆盖率最高的横切问题。

---

## 附录 B. 决策建议

CC5 不涉及资损/越权/状态崩坏，所以无 P0；但因覆盖 25/25 业务域且 admin 规范率仅 7.8%，建议作为**第二批 epic**（在 CC2 并发与幂等、CC4 鉴权两个 P0 epic 之后）启动统一改造，与 CC9 测试残留同批清理。
