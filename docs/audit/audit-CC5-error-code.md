# 审计报告：错误码与错误前缀（CC5 横切收官）

**审计时间**：2026-04-25 初审 → 2026-04-26 v2 修订
**域 ID**：CC5
**审计员**：claude-opus-4-7（v1）→ claude（v2，batch agent）
**合并版**：最终版，v1 + v2 合并
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
| 响应外壳 | `{ success: boolean, message: string, data?: any }` | `{ code: 0|-1|-400|-401|-403|-404, message, errorType, data }` | `{ code: 0|-1|-400|-401|-403|-404, message, errorType, data }` | `{ code: 'SUCCESS'|'FAIL', message }` |
| 前端调用 helper | Next.js form action / hook | `fengyu-staff/miniprogram/utils/cloud.ts:39-52` `callStaffApi` | `fengyu-client/miniprogram/utils/cloud.ts:18-46` `callClientApi` | — |
| 前端是否保留 errorType | N/A | **❌ 丢弃**（仅 `throw new Error(message)`，未透出 errorType/code） | ✅ 保留（`ClientApiError.errorType / .code / .data`）| — |

**关键结论：四端共四种响应外壳，零端共享错误抛出 helper。**

---

## 2. 错误抛出量化（统计 2026-04-26，v2 实测）

排除 `__tests__` / `node_modules`，仅业务代码：

| 端 | 范围 | `throw` 总数 | 4 项规范前缀 | 扩展前缀（在 knownTypes 内）| 裸抛 | 规范率（4 项/总数）|
|----|------|-----------|----------|--------------------------|------|----------------|
| admin (`fengyu-admin/src`) | 26 actions，抽查 41 次 | **41** | 7 | **17**（CARD_*/ORDER_*/OVERPAY 等自定义前缀）| **9**（中文裸抛）| **17%**（7/41）|
| staff (`fengyu-staff/cloudfunctions/staffApi/routes/*.js`) | 15 个路由文件 | **275** | 254（INVALID_PARAMS + PERMISSION_DENIED）| 19（INVALID_STATE×7 + INSUFFICIENT_BALANCE×5 + NOT_FOUND×3 + CLIENT_NOT_REGISTERED×3 + CONFLICT×1）| **2**（service.js:367 全角冒号；order.js:988 方括号前缀）| **92.4%**（254/275）|
| client (`fengyu-client/cloudfunctions/clientApi/routes/*.js`) | 13 个路由文件 | **142** | 134（INVALID_PARAMS + PERMISSION_DENIED + UNAUTHORIZED）| 5（INSUFFICIENT_BALANCE×5）| **0** | **94.4%**（134/142）|
| payNotify | | 4 | 0 | 2（INVALID_PAY_AMOUNT / INSUFFICIENT_BALANCE）| 2 | 0% |

> **v1 数据勘误**：v1 报告称 client 端"约10处裸抛"，该数据有误。v2 grep 全量 client routes（142 次 throw），**client 端实际裸抛为 0 处**。特此更正，v1 该统计项不计入本版。

### 2.1 staff 路由文件明细

| 文件 | `throw` 数 | 文件 | `throw` 数 |
|------|-----------|------|-----------|
| order.js | 115 | service.js | 33 |
| allocation.js | 20 | customer.js | 16 |
| mgmt-customer.js | 15 | mgmt-dashboard.js | 13 |
| appointment.js | 12 | card.js | 11 |
| staff.js | 6 | store.js | 8 |
| auth.js | 6 | mgmt-product.js | 8 |
| mgmt-traffic.js | 6 | coupon.js | 2 |
| product.js | 4 | | |

### 2.2 client 路由文件明细

| 文件 | `throw` 数 | 文件 | `throw` 数 |
|------|-----------|------|-----------|
| order.js | 81 | auth.js | 18 |
| store.js | 12 | appointment.js | 12 |
| card.js | 8 | product.js | 4 |
| staff.js | 3 | service.js | 2 |
| coupon.js | 1 | message.js | 1 |
| points.js | 0 | config.js / _constants.js | 0 |

### 2.3 staff 裸抛清单（2 处，均属 P2）

| 文件:行 | 错误信息 | 问题 |
|---------|---------|------|
| `routes/service.js:367` | `` `次数不足：订单行 ${item.sale_item_id} 剩余次数不足 ${item.session_used}` `` | 使用全角中文冒号（U+FF1A），不被 `^[A-Z_]+:\s*` 正则识别，等同裸抛 |
| `routes/order.js:988` | `` `[confirmOffline] 充值订单 product_name 无法解析面值: ${row.product_name}` `` | 方括号前缀（`[confirmOffline]`），不被识别，等同裸抛 |

### 2.4 两端 index.js knownTypes 对比

| 端 | knownTypes 项数 | 超出 CLAUDE.md 4 项的扩展 |
|----|--------------|--------------------------|
| staffApi | 9 项 | NOT_FOUND / INSUFFICIENT_BALANCE / CLIENT_NOT_REGISTERED / CONFLICT / INVALID_STATE |
| clientApi | 6 项 | NOT_FOUND / INSUFFICIENT_BALANCE |

**差异**：`CLIENT_NOT_REGISTERED` / `CONFLICT` / `INVALID_STATE` 仅 staff 白名单内；client 若抛这三类（目前未出现），前端收到"服务器内部错误"。

---

## 3. 自身漏洞（P0/P1/P2）

### P0（阻断/资损/越权）

无（CC5 不直接造成资损或越权）。

### P1（数据一致 / UI 错乱）

#### [P1-CC5-01] staff `callStaffApi` 丢弃 errorType 与 code，UI 无法精准 dispatch（双重失效）

- **文件**：`fengyu-staff/miniprogram/utils/cloud.ts:51-53`
- **证据**：
  ```js
  // cloud.ts:51-53（staff 端）
  if (res.result?.code !== 0) {
    throw new Error(sanitizeErrorMessage(res.result?.message, '请求失败'))
  }
  // 相比 client 端（cloud.ts:17-21）：
  err.code = res.result?.code     // staff 端：丢弃
  err.errorType = res.result?.errorType  // staff 端：丢弃
  err.data = res.result?.data    // staff 端：丢弃
  ```
- **双重实效**：服务端 `index.js:173` 已将 `PERMISSION_DENIED:` 前缀剥除后才返回 message（`displayMessage = errorMessage.slice(errorTypeMatch[0].length)`）；且 staff 前端 `callStaffApi` 丢弃 `errorType`/`code` 字段，根本不往下传。
- **命中场景**：`mgmt-customer-detail.ts:248` `if (msg.indexOf('PERMISSION_DENIED') >= 0)`（永远为 false，服务端已剥前缀）→ 改为 `if ((err as any)?.errorType === 'PERMISSION_DENIED')` 仍不生效（callStaffApi 丢弃 errorType）。PERMISSION_DENIED 错误永远走 `customerError: true` 分支，"返回上一页"逻辑永远无法触达。
- **修复**：
  - (L9 staff) `callStaffApi` 改为透出 `StaffApiError { code, errorType, data }`，与 client 端对齐
  - (L9 staff) `mgmt-customer-detail.ts:248` 改 `if ((err as any)?.errorType === 'PERMISSION_DENIED')`
- **关联**：CC5 / 与 audit-01 P2-ERROR-12、audit-02 P2-02-17 同源

#### [P1-CC5-02] `PHONE_REQUIRED` 与 `PERMISSION_DENIED` 共用 code -403，前端无法区分（v2 新发现）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/index.js:175-176`、`fengyu-client/cloudfunctions/clientApi/index.js:130-131`
- **证据**：
  ```js
  // 两端 index.js 均如此
  const code = errorMessage.startsWith('UNAUTHORIZED') ? -401 :
                errorMessage.startsWith('PHONE_REQUIRED') ? -403 :   // ← -403
                errorMessage.startsWith('INVALID_PARAMS') ? -400 :
                errorMessage.startsWith('PERMISSION_DENIED') ? -403 : // ← 同 -403
  ```
- **影响**：若前端按 `err.code === -403` 做通用路由跳转（如"跳手机绑定页"），会把 `PERMISSION_DENIED` 错误误导为"未绑定手机号"。目前 staff 端无此问题（因 callStaffApi 丢弃 code），client 端 PERMISSION_DENIED 不会触发（client 无管理权限），但语义模糊是真实的设计缺陷。
- **修复**：`CLAUDE.md` 明确定义 `PHONE_REQUIRED → -403`，`PERMISSION_DENIED → -403`（两者共用），前端通过 `errorType` 而非 `code` 区分，并在两端 index.js 注释标注。

#### [P1-CC5-03] mgmt-customer-detail.ts errorType 双重失效（v2 新发现，精确到失效链路）

- **文件**：`fengyu-staff/miniprogram/packageMgmt/mgmt-customer-detail/mgmt-customer-detail.ts:248`
- **失效链路**：
  1. 服务端 `index.js` 剥除 `PERMISSION_DENIED:` 前缀后才返回 `message`
  2. staff `callStaffApi` 丢弃 `errorType`/`code` 字段
  3. 页面代码 `msg.indexOf('PERMISSION_DENIED')` 永远不命中（msg 已无前缀）
  4. 即使改用 `err.errorType` 也仍然不生效（callStaffApi 丢弃了该字段）
- **影响**：整个 PERMISSION_DENIED 分支（展示 Toast "顾客不在当前数据范围" + 返回上一页）永远无法触达，用户看到的是通用的 customerError toast，体验与真实错误不符。
- **修复**：见 [P1-CC5-01] 修复方案。

### P2（代码质量 / UX 信息丢失）

#### [P2-CC5-04] `service.js:367` 全角中文冒号（U+FF1A）导致裸抛

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:367`
- **证据**：`throw new Error(`次数不足：订单行 ${item.sale_item_id} ...`)` — 使用 U+FF1A 全角冒号，不被 `^[A-Z_]+:\s*` 匹配，等同裸抛。
- **影响**：`service.complete` 时次数不足返回"服务器内部错误"而非"次数不足"提示；与同文件 `service.js:115` 用 `INVALID_PARAMS:` 的另一处形成同一业务条件两种 UI 文案。
- **修复**：`throw new Error('INVALID_PARAMS: 次数不足，订单行 ... 剩余次数不足')`

#### [P2-CC5-05] `order.js:988` 方括号技术标签前缀导致裸抛

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:988`
- **证据**：`throw new Error(`[confirmOffline] 充值订单 product_name 无法解析面值: ${row.product_name}`)`
- **影响**：充值卡面值解析失败时前端收到"服务器内部错误"；详细信息已在 console.error（已有），但 index.js 不透出。
- **修复**：`throw new Error('INVALID_PARAMS: 充值卡面值解析异常，请重新录入')`

#### [P2-CC5-06] admin 规范率 17%（9 处中文裸抛 + 17 处自定义前缀）

- **文件**：`fengyu-admin/src/actions/orders.ts`（~26 处违规）、`refunds.ts`（~8 处）、`services.ts`、`employees.ts`、`pickup-records.ts` 等
- **9 处中文裸抛**：`'员工编号生成失败'`、`'订单号生成失败'`、`'优惠券已被使用，请刷新后重试'`、`'服务单号生成失败'`、`'未配置 WX_CLIENT_SECRET 环境变量'`、`'获取 access_token 失败...'`、`` `该顾客已有待支付订单 ${...}` `` 等
- **17 处自定义前缀**：CARD_NOT_FOUND / CARD_STORE_MISMATCH / CARD_OWNER_MISMATCH / CARD_DIRECTION_INVALID / CARD_ORDER_STATUS_INVALID / CARD_EXHAUSTED / CARD_TYPE_INVALID / CARD_CONCURRENT_CHANGED / PREPAID_CARD_UPSERT_FAILED / SKU_NOT_FOUND / ORDER_ID_GEN_FAILED / ORDER_ID_CONFLICT / REF_ORDER_NOT_FOUND / OVERPAY / INSUFFICIENT_SESSIONS / CONCURRENT_CHANGED / OVER_QUANTITY 等
- **admin 唯一统一约定**：`requirePermission()` 的 `PERMISSION_DENIED:` 前缀（1 处，全局共享）
- **修复**：建立 `lib/api-error.ts` + `withApiResponse(action)` HOF，中文裸抛加前缀，自定义前缀归并到 `INVALID_STATE:` / `INVALID_PARAMS:` / `CONFLICT:`

#### [P2-CC5-07] `sanitizeErrorMessage` 60 字符截断导致合法长消息丢失

- **文件**：`fengyu-staff/miniprogram/utils/cloud.ts:14`、`fengyu-client/miniprogram/utils/cloud.ts:11`
- **证据**：`if (msg.length > 60) return fallback`
- **影响**：`service.js:111` 抛 `"INVALID_PARAMS: 订单行 X 仅在 STORE_A 可核销，当前门店 STORE_B 无法创建服务单"` 剥前缀后仍可能 > 60，退化为"请求失败"。
- **修复**：阈值改 100 或改为仅检测技术 pattern（不卡长度）。

#### [P2-CC5-08] 两端 sanitizeErrorMessage 规则差异

- **文件**：staff `cloud.ts:11` vs client `cloud.ts:9`
- **差异**：staff techPatterns 无 `cloud\.\w+:fail`，client 有（line 9 末尾）
- **影响**：微信 SDK `cloud.callFunction:fail` 类错误在 staff 端不被过滤，直接返回 fallback；但实际影响有限（staff 不处理 SDK 层异常）。

---

## 4. 跨端不一致（核心）

| 维度 | admin | staff | client | payNotify | 不一致风险 | 优先级 |
|------|-------|-------|--------|-----------|-----------|--------|
| 错误抛出 helper | 无 | 无 | 无 | 无 | 无中央定义 | P1 |
| 已知前缀白名单 | 无定义 | 9 项 | 6 项 | 不解析 | staff/client 同条业务可能不同响应（同 `CONFLICT:`，client 吞成 500）| P1 |
| 响应外壳 | `{success, message, data}` | `{code, message, errorType, data}` | 同 staff | `{code:'SUCCESS'/'FAIL', message}` | 4 套外壳，前端跨端复用 lib 几乎不可能 | P1 |
| 错误 code | 无 | -1/-400/-401/-403/-404 | 同 staff | SUCCESS/FAIL | admin 无 code，无法做通用 401 拦截 | P1 |
| 4 项约定规范率 | **17%**（v2 实测，9/41 裸抛 + 17/41 自定义前缀）| **92.4%**（routes，254/275）| **94.4%**（routes，134/142）| 0% | admin **绝大多数错误无规范前缀**——前端无法规则化 | P1 |
| `PERMISSION_DENIED:` | 1 处（permissions.ts:218，覆盖全部 admin requirePermission）| 散写 35 处 | 散写 8 处（client 无管理权限）| 不抛 | admin helper 模式正确 | — |
| 自定义业务前缀 | 17 处（CARD_*、ORDER_*、OVERPAY 等）| 19 处（INVALID_STATE/INSUFFICIENT_BALANCE 等，均在 knownTypes 内）| 5 处（仅 INSUFFICIENT_BALANCE）| 2 处 | 同前缀语义但 admin/staff 实现路径不互通 | P2-CC5-06 |
| 前端 errorType 透出 | N/A | **双重失效**（服务端剥前缀 + callStaffApi 丢字段）| ✅ | N/A | staff PERMISSION_DENIED 分支永远无法触达 | P1-CC5-01/03 |
| PHONE_REQUIRED vs PERMISSION_DENIED code | N/A | 共用 -403 | 共用 -403 | N/A | 前端若按 code 路由会混淆两者 | P1-CC5-02 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [ ] CC1 数值精度：N/A（CC5 不涉及金额）
- [ ] CC2 并发幂等：N/A
- [ ] CC3 组织隔离：N/A
- [ ] CC4 鉴权：`requirePermission` 抛 `PERMISSION_DENIED:` 是 admin 唯一统一前缀；客户端 `requirePhone` 抛 `PHONE_REQUIRED:`
- [x] **CC5 错误码（本域）**：见 §3 全节
- [ ] CC6 PII：payNotify FAIL 响应透出 `INVALID_PAY_AMOUNT: 1234.56` 含金额回到微信平台日志
- [ ] CC7 时间字段：N/A
- [ ] CC8 WXML/Vant：弱关联——staff `wx.showToast({ title: msg })` 在 msg 含未剥除前缀时（实际不会，因服务端已剥）会显示原始中文
- [ ] CC9 测试：staff `__tests__/utils/cloud.test.ts:117` 测试断言 "PERMISSION_DENIED 前缀原样返回"，但实际 callStaffApi 调用 sanitizeErrorMessage 后服务端已剥前缀——测试覆盖错位

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `cloudfunctions/_shared/error-codes.js`（新建）| 单点声明 8 项官方约定前缀（4 + NOT_FOUND/INSUFFICIENT_BALANCE/CONFLICT/INVALID_STATE）| P1-CC5-02/03 |
| L0 docs | `CLAUDE.md` 全局规范 | 错误前缀约定从 4 项扩展到 8 项；明示 admin 必须 throw 带前缀；`PHONE_REQUIRED → -403` 与 `PERMISSION_DENIED → -403` 共用，前端通过 errorType 区分 | P1-CC5-02/03 |
| L0 docs | `.42cog/dev/sys.spec.md` | 三端响应外壳合约 | P1 |
| L3 staff | `staffApi/index.js:171` | knownTypes 改为从 `_shared/error-codes.js` 导入 | P1-CC5-03 |
| L3 client | `clientApi/index.js:122-125` | knownTypes 9 项与 staff 对齐 | P1-CC5-03 |
| L3 payNotify | `payNotify/index.js:508` | message 改为 `'处理失败'`（不透出明细）| P2 |
| L7 admin | `lib/api-error.ts`（新建）| `class ApiError extends Error` + `withApiResponse(action)` HOF | P2-CC5-06 |
| L7 admin | 全部 `actions/*.ts:throw new Error(...)` | 改为 `throw new ApiError(...)`；9 处中文裸抛全部加前缀；17 处自定义前缀归并 | P2-CC5-06 |
| L9 staff | `miniprogram/utils/cloud.ts:51-54` | `callStaffApi` 透出 `StaffApiError { code, errorType, data }`，对齐 client | **P1-CC5-01 + P1-CC5-03** |
| L9 staff | `packageMgmt/mgmt-customer-detail/mgmt-customer-detail.ts:248` | 改 `if ((err as any)?.errorType === 'PERMISSION_DENIED')` | **P1-CC5-01 + P1-CC5-03** |
| L9 staff | `routes/service.js:367` | 全角冒号 → `INVALID_PARAMS:` 前缀 | P2-CC5-04 |
| L9 staff | `routes/order.js:988` | 方括号标签 → `INVALID_PARAMS:` 前缀 | P2-CC5-05 |
| L9 三端 | `utils/cloud.ts` sanitize 长度 60→100 | 长 message 不丢失语义 | P2-CC5-07 |
| L9 三端 | `_shared/sanitize.js` | sanitize 规则收口共享 | P2-CC5-08 |

---

## 7. 验证 SQL（CC5 不涉及 DB，无 SQL 验证）

CC5 是错误处理代码层问题，无 schema / data 维度可校验。仅可在代码层 grep 校验：

```bash
# 验证 staff routes 裸抛（期望：0）
grep -n "throw new Error" fengyu-staff/cloudfunctions/staffApi/routes/service.js
grep -n "throw new Error" fengyu-staff/cloudfunctions/staffApi/routes/order.js

# 验证 admin 4 项规范前缀（期望：7 处符合，其余归并后为 0）
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
3. staff `callStaffApi` 接收 `{code:-403, message:'...', errorType:'PERMISSION_DENIED'}`，verify `err.errorType === 'PERMISSION_DENIED'`（修复 P1-CC5-01）
4. payNotify 抛 `INSUFFICIENT_BALANCE: 余额不足`，verify `{code:'FAIL', message:'处理失败'}`（不透金额）
5. 测试 sanitizeErrorMessage 长 message（>60 字符但合法中文）保留原文（修复 P2-CC5-07）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（4 端 + 0 DB）**：☑ admin/staff/client/payNotify
- 涉及历史数据：☐（仅代码层）
- 修复成本：**M** — admin 41 处 throw 改 ApiError + staff callStaffApi 重构 + 三端共享 lib 抽取 + CLAUDE.md 同步；建议作为 epic 一次推完

---

## 10. 后续待办

- [ ] 与团队对齐：错误前缀约定从 4 项扩展到 8 项（建议）vs 回归 4 项（保守）
- [ ] L0 创建 `cloudfunctions/_shared/error-codes.js` + `lib/api-error.ts`
- [ ] L7 admin 41 处 throw 全部归并到 ApiError + withApiResponse HOF
- [ ] L9 staff `callStaffApi` 重构透出 errorType + `mgmt-customer-detail.ts:248` 修复
- [ ] L9 修复 service.js:367 全角冒号 + order.js:988 方括号前缀
- [ ] CLAUDE.md / `.42cog/dev/sys.spec.md` 同步更新错误码合约
- [ ] CROSS-CUTTING.md §CC5 段标记 ✅ done，链接本报告

---

## 附录 A. 现有报告 §5 CC5 节命中索引

| 域 | 命中类型 | 严重度 | 文件:行 |
|----|---------|-------|--------|
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

CC5 不涉及资损/越权/状态崩坏，所以无 P0；但因覆盖 25/25 业务域且 admin 规范率仅 17%，建议作为**第二批 epic**（在 CC2 并发与幂等、CC4 鉴权两个 P0 epic 之后）启动统一改造，与 CC9 测试残留同批清理。
