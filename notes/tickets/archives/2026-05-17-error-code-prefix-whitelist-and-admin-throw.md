# Ticket: 错误前缀 4→9 项白名单统一 + admin 裸 throw 收敛到 ApiError + 各端独立副本 + 跨端字面量 snapshot 守护 [已归档]

> 生成日期：2026-05-17
> 归档日期：2026-05-17
> 实施状态：✅ **已完成（已归档）**
> 实施日期：2026-05-17
> 严重级别：**P0**（SUMMARY v3 Top10 #10 — UX 实效失效 + admin 越权可达不可识别）
> 端：fengyu-admin / fengyu-staff (staffApi) / fengyu-client (clientApi + payNotify)
> 修复成本：**S**（实际：1 天，含三端云函数 + admin + snapshot 守护 + 33 处野生前缀全量收敛）
> 来源：[SUMMARY v3 §2 Top10 #10](../../docs/audit/SUMMARY.md) + [SUMMARY §3 横切热点（错误前缀偏离 4 项约定 + admin 裸 throw）](../../docs/audit/SUMMARY.md) + [audit-CC5](../../docs/audit/audit-CC5-error-code.md)
> 关联 audit：audit-01 / audit-02 / audit-03 / audit-04 / audit-24 / audit-CC5（25/25 业务域全部命中，admin 规范率 17%）
> 用户决策约束：
> - **不抽取 `cloudfunctions-shared/`**（feedback `no-shared-cloudfunctions`，2026-04-26）— 改为各端各自 `error-codes.js` 独立副本 + 跨端字面量 snapshot 守护
> - 参考已落地同模式：[`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`](../../fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js)（守护 settlePoints 四端 + applyRecharge 三端 SQL 字面量）

---

## 实施小结（2026-05-17）

**4 处 error-codes 单源 + 1 处 admin TS（4 端字节同义）** — commit `711d7cc`
- `fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js`
- `fengyu-client/cloudfunctions/clientApi/utils/error-codes.js`
- `fengyu-client/cloudfunctions/payNotify/error-codes.js`
- `fengyu-admin/src/lib/api-error.ts`（含 `ApiError` class + `runWithApiResponse` HOF + 9 项白名单 `ERROR_PREFIXES`）

**9 项白名单**（含且仅含）：`UNAUTHORIZED` / `PHONE_REQUIRED` / `INVALID_PARAMS` / `PERMISSION_DENIED` / `NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CONFLICT` / `INVALID_STATE` / `CLIENT_NOT_REGISTERED`。`PHONE_REQUIRED` 与 `PERMISSION_DENIED` 共用 -403、`INVALID_PARAMS`/`INVALID_STATE`/`INSUFFICIENT_BALANCE`/`CLIENT_NOT_REGISTERED` 共用 -400 → 前端按 `errorType` 区分。

**二级前缀语法** `<一级>: <子标签>: <消息>`（如 `INVALID_STATE: STATE_TRANSITION_BLOCKED: ...`）已文档化，子标签仅供日志归类。

**三端 index.js 全局 catch** 改用 `buildErrorResponse(err)` 替代原内联 knownTypes 映射 — commit `711d7cc`

**staff 路由 2 处裸抛规范化** — commit `711d7cc`：service.js（全角冒号→`INVALID_PARAMS:`）、order.js confirmOffline（`[confirmOffline]`→`INVALID_PARAMS:`）

**L9 staff cloud.ts** 改 `throw new Error(message)` 为 `new StaffApiError({code, errorType, data, message})`，把 `code/errorType/data` 挂 Error 实例 → `mgmt-customer-detail.ts` 的 PERMISSION_DENIED 分支真实可达（P1-CC5-02 修复达成）

**admin 33 处野生前缀全量收敛到 ApiError** — 由 follow-up [ticket-10c](archives/2026-05-17-admin-actions-throw-batch-migration.md) 在 commit `41ea65f` / `8269452` / `5ec823f` / `efa3218` 完成（orders 25 + refunds 5 + services 1 + service-commissions 1 + pickup-records 1）

**admin lib/* 2 处 cloudbase 裸抛** — 由 follow-up [ticket-10b](archives/2026-05-17-admin-lib-throw-to-apierror.md) 完成

**跨端 snapshot 双份守护**（test-colocation feedback 对齐）：
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`（staff 侧 vitest 13 用例 + actions/ 反向断言 violationCount = 0）— commit `ca4780c` + `2b1c32f`
- `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts`（admin 侧 vitest 14 用例，含 ApiError/runWithApiResponse 行为测试）

**文档同步**（5 处）：root `CLAUDE.md`、`.42cog/dev/client.sys.spec.md`、`.42cog/dev/staff.sys.spec.md`、`fengyu-staff/CLAUDE.md`、`fengyu-client/CLAUDE.md`、`staffApi/CLAUDE.md` 全部从 "4 项白名单" 同步到 9 项 + 二级前缀语法说明

**配套前端 callClientApi 对称**：客户端 `cloud.ts` 已含 `err.errorType` 挂载，本 ticket 把 staff `cloud.ts` 拉齐

**验证全绿**：
- `cd fengyu-admin && bun run test src/actions/orders.test.ts` → 108/108 全绿
- `cd fengyu-staff/cloudfunctions/staffApi && vitest run __tests__/routes/cross-end-error-codes-snapshot.test.js` → 13/13 全绿
- `cd fengyu-admin && vitest run src/lib/__tests__/error-codes-cross-end.test.ts` → 14/14 全绿
- `npx tsc --noEmit`（admin）→ 静默通过
- snapshot 反向断言基线 34 → 33 → **0**（ticket-10c 全量收敛后）

**剩余技术债**（非本 ticket 责任，独立 ticket 跟踪）：
- [ticket-10d: admin actions/* withPermission HOF 迁移补齐](2026-05-17-admin-with-permission-completion.md) — 7 文件 ~93 处 `getSession()/requirePermission(session)` 旧模式待迁；当前 `tsc` 通过、build 不阻塞，纯技术债

---

## v2 修订摘要（2026-05-17，回应 R2 复核）

| 关键变化 | 原（v1） | 修订后（v2） | 触发的复核反馈 |
|---------|---------|-------------|--------------|
| 白名单项数 | 4 → **8** | 4 → **9**（保留 `CLIENT_NOT_REGISTERED`） | Block-1 — staff knownTypes 已含 9 项 + admin orders.test.ts 5 处断言依赖；若收成 8 项必伤现网 |
| staffApi `utils/cloud.ts` 修复 | §5 L9 一行带过，未约束 PR 边界 | **升为本 ticket 必做 + 强制与 §3 snapshot 同 PR 落地**；明确必须传出 `errorType/code/data` 才能让 `mgmt-customer-detail.ts` 的 PERMISSION_DENIED 分支真实可达（P1-CC5-02） | Block-2 |
| snapshot 测试解析方式 | 字符串正则 `extractPrefixArray`（单引号 + 数组括号匹配） | **`require()` 直接读取 ERROR_PREFIXES 导出**（admin TS 用 ts-node 或预编译产物），删除脆性正则 | Block-3 |
| admin `withApiResponse` 改造 | §5 L7 与 snapshot 同 PR 全量替换 | **拆独立 follow-up PR**；本 ticket 先在 1 个示范文件验 `bun run build` 通过 + 老测试全绿 | Warn-3 |
| 行号引用方式 | 硬编码行号（如 `permissions.ts:218` / `order.js:988`） | **文件路径 + 函数名 + 关键代码片段**，移除所有硬编码行号 | Warn-2 |
| §1 范围声明 | 仅 `actions/` 34 处 | **扩到 `src/lib/`**（含 `lib/refund.ts`、`lib/cloudbase.ts` 等 11 处），或显式标 out-of-scope + 新建 ticket-10b 跟踪 | Warn-1 |
| §2.1 二级前缀语法 | 未定义 | **新增"前缀:子标签:消息"二级前缀文档化**（与 ticket #8 `INVALID_STATE: STATE_TRANSITION_BLOCKED:...` 对齐） | Warn-5 |
| payNotify `PAYNOTIFY_DISABLED` | 未明确处置 | **显式保留**（feature flag 语义 + 日志归类目的） | Warn-4 |
| §5 L0 docs 范围 | `CLAUDE.md` + `sys.spec.md` | **补 fengyu-staff/CLAUDE.md、fengyu-client/CLAUDE.md、staffApi/CLAUDE.md** 三处子项目文档 | Warn-6 |
| snapshot 测试落点 | 仅 staffApi `__tests__/` 单边 | **admin vitest + staff jest 各落一份对称测试**（避免 admin CI 不守护自家文件） | Warn-7（test-colocation feedback） |
| §6 验证 checklist | 未含 admin build/test 门禁 | **新增 `cd fengyu-admin && bun run build` 通过 + admin 现有 orders.test.ts 全绿** | 改进-6 |

---

## 0 一句话背景

`CLAUDE.md` 全局规范只列出 4 项错误前缀（`UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`），但 staff index.js 已扩到 9 项、client index.js 扩到 6 项、admin 在 actions 内散播 ~17 种自定义业务前缀 + 9 处中文裸 throw，四端零共享、白名单无单源、admin 完全没有响应外壳 wrapper —— 前端无法稳定按 `errorType` 路由，PERMISSION_DENIED 的"返回上一页"分支永远走不到。

**v2 修订**：白名单收敛为 **9 项**（保留 `CLIENT_NOT_REGISTERED`），与 staff index.js `knownTypes` 既有现状一致，确保 admin orders.test.ts 5 处 `message.toContain('CLIENT_NOT_REGISTERED')` 断言 0 修改即可全绿。

## 1 现状（grep 实证 2026-05-17）

### 1.1 三端实际使用的错误前缀清单

**4 项官方白名单（CLAUDE.md "错误前缀约定"段）**：
- `UNAUTHORIZED:`
- `PHONE_REQUIRED:`
- `INVALID_PARAMS:`
- `PERMISSION_DENIED:`

**staffApi/clientApi index.js knownTypes 实际值（已偏离 CLAUDE.md）**：

| 端 | knownTypes 项数 | 超出 4 项的"野生白名单"扩展 |
|----|--------------|----------------------|
| `fengyu-staff/cloudfunctions/staffApi/index.js`（全局 catch 内 `knownTypes` 数组） | 9 项 | `NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CLIENT_NOT_REGISTERED` / `CONFLICT` / `INVALID_STATE` |
| `fengyu-client/cloudfunctions/clientApi/index.js`（同位置 `knownTypes`） | 6 项 | `NOT_FOUND` / `INSUFFICIENT_BALANCE` |
| `fengyu-client/cloudfunctions/payNotify/index.js` | 不解析前缀 | 直接 `{code:'FAIL', message:err.message}` 透传 |

**staffApi/clientApi routes 内实际抛出的前缀（grep `throw new Error('PREFIX:`，单引号）**：

```
CLIENT_NOT_REGISTERED:     ← staff 抛，client knownTypes 未含 → client 端会吞为 500
CONFLICT:                  ← staff 抛，client knownTypes 未含 → 同上
INSUFFICIENT_BALANCE:      ← 三端都抛
INVALID_PARAMS:            ← 三端都抛（占比最大）
INVALID_STATE:             ← staff 抛，client knownTypes 未含 → 同上
NOT_FOUND:                 ← 三端都抛
PERMISSION_DENIED:         ← 三端都抛
UNAUTHORIZED:              ← 三端都抛
```

**结论**：三端 routes 实际野生抛出 **8 个唯一前缀**（即 4 项官方 + 5 项野生：`NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CLIENT_NOT_REGISTERED` / `CONFLICT` / `INVALID_STATE`），加上 staff `index.js knownTypes` 当前真实在用的 9 项，**白名单目标定为 9 项**（**v2 修订**：保留 `CLIENT_NOT_REGISTERED` 避免 admin orders.test.ts 5 处 `message.toContain('CLIENT_NOT_REGISTERED')` 红灯 + staff 前端按 `errorType==='CLIENT_NOT_REGISTERED'` UI 分支退化为通用 -400 toast）。**client/payNotify 解析逻辑滞后**仍是核心修复点。

### 1.2 admin 裸 throw 统计（不带 9 项前缀，excluding `__tests__`）

```bash
grep -rn "throw new Error" fengyu-admin/src/actions/ \
  | grep -vE "__tests__|\.test\.ts" \
  | grep -vE "throw new Error\(['\"\`]?(UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE|CLIENT_NOT_REGISTERED):"
# 结果：34 处违规（actions/ 范围）
```

**v2 修订 — 范围扩展声明**：

| 范围 | 违规处数（grep 实证） | 本 ticket 处置 |
|------|---------------------|---------------|
| `fengyu-admin/src/actions/**` | 34 | **本 ticket 必做**（见 §4.3 + §5 L7） |
| `fengyu-admin/src/lib/**` | 11（含 `lib/refund.ts` `lib/cloudbase.ts` 等，Server Action 调用时原样冒泡到 `withApiResponse` 命中"野生前缀→服务器内部错误"兜底，吞掉退款/上传真实业务文案） | **out-of-scope，新建 ticket-10b 跟踪**（理由：lib 多被多端共用，迁移面更大，先把 actions/ 收口落地） |

ticket-10b 标题草案：`admin lib/* 11 处裸 throw 收敛 + withApiResponse 全 lib 覆盖`。

**admin actions 业务前缀分类（去重，34 处违规分布）**：

| 类别 | 前缀示例 | 处数 | 文件 |
|------|---------|-----|------|
| **CARD_*** 充值卡专属自定义前缀 | `CARD_NOT_FOUND` / `CARD_STORE_MISMATCH` / `CARD_OWNER_MISMATCH` / `CARD_DIRECTION_INVALID` / `CARD_ORDER_STATUS_INVALID` / `CARD_EXHAUSTED` / `CARD_TYPE_INVALID` / `CARD_CONCURRENT_CHANGED` / `CARD_UPSERT_FAILED` | 11 | orders.ts / refunds.ts |
| **ORDER_*** 订单 ID 生成 | `ORDER_ID_GEN_FAILED` / `REF_ORDER_NOT_FOUND` | 3 | orders.ts |
| **业务状态/并发** | `CONCURRENT_CHANGED` / `OVERPAY:${...}` / `INSUFFICIENT_SESSIONS` / `OVER_QUANTITY` / `PREPAID_CARD_UPSERT_FAILED` / `PAYMENT_INSERT_FAILED` / `SKU_NOT_FOUND:${...}` / `CLIENT_NOT_REGISTERED` | 11 | orders.ts / refunds.ts / pickup-records.ts |
| **9 处中文裸抛**（无前缀） | `'员工编号生成失败'` / `'订单号生成失败'` / `'服务单号生成失败'` / `'优惠券已被使用，请刷新后重试'` / `'未配置 WX_CLIENT_SECRET 环境变量'` / `` `获取 access_token 失败...` `` / `` `该顾客已有待支付订单 ${id}` `` / `'[applyRechargeOnOrderPaid] prepaid_cards UPSERT 失败'` / `` `[payNotify] 充值订单 ... 无法解析面值` `` | 9 | employees.ts / orders.ts / services.ts / orders.ts |

**admin 唯一统一的前缀约定**：`fengyu-admin/src/lib/permissions.ts` 中 `requirePermission()` / `requireAnyPermission()` 两处抛 `PERMISSION_DENIED:`（覆盖所有 admin Server Action 调用，171 处 — 行号会随重构漂移，识别靠函数名）。其余 34 处 throw 完全无 wrapper。

### 1.3 admin 是否已有 `lib/api-error.ts` / withApiResponse HOF

**❌ 不存在**。`fengyu-admin/src/lib/` 现有清单：
```
auth.ts / card-kinds.ts / cloudbase.ts / hooks/ / member-threshold.ts / menu.ts /
operation-log.ts / permissions.ts / points-settle.ts / product-kind.ts /
recharge.ts / refund-cascade.ts / refund.ts / schemas.ts / share-gift-config.ts /
types.ts / utils.ts
```
无 `api-error.ts`、无 `withApiResponse` HOF；所有 Server Action 各自显式 `try/catch` 返回 `{success:false, message}` 或直接 `throw`。

### 1.4 现有跨端 snapshot 守护测试（参考样板）

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`（200 行）已落地：
- `extractBacktickStringContaining(src, marker)` — 文件内按关键字提取 backtick 字符串
- `normalizeSql()` — `$1` / `${var}` → `?`、空白压缩、括号清理
- 跨 4 端文件路径配置 + `expect(client).toBe(staff)` 镜像比对 + `toMatchSnapshot()` 兜底
- 错误信息引导维护者"同步另外三端"

→ 本 ticket 的 `cross-end-error-codes-snapshot.test.js` 直接照此样板写。

---

## 2 设计目标

### 2.1 9 项官方白名单定义（v2 修订：8 → 9，保留 `CLIENT_NOT_REGISTERED`）

| 前缀 | HTTP-like code | 语义 | 抛出端 |
|------|---------------|------|-------|
| `UNAUTHORIZED:` | -401 | 未登录 / openid 失效 | 三端 + admin |
| `PHONE_REQUIRED:` | -403 | 未绑定手机号（需引导绑定页）| client / staff |
| `INVALID_PARAMS:` | -400 | 入参不合法（含字段缺失/类型错/范围错）| 三端 + admin |
| `PERMISSION_DENIED:` | -403 | 鉴权失败（角色/scope 不足）| 三端 + admin |
| `NOT_FOUND:` | -404 | 资源不存在 / 不可见 | 三端 + admin |
| `INSUFFICIENT_BALANCE:` | -400 | 储值卡余额不足 / 次数不足 | 三端 + admin |
| `CONFLICT:` | -409 | 并发冲突 / 唯一约束 / 状态被改 | 三端 + admin |
| `INVALID_STATE:` | -400 | 状态机不允许该操作 | 三端 + admin |
| `CLIENT_NOT_REGISTERED:` | -400 | 顾客未注册（未绑定门店 / 未导入档案）| staff + admin（client 不抛）|

**code 复用说明**（写入 CLAUDE.md 与各端 index.js 注释）：
- `PHONE_REQUIRED` 与 `PERMISSION_DENIED` 都映射 **-403**，前端**必须按 `errorType` 区分**，不要按 code（P1-CC5-02 修复）
- `INVALID_PARAMS` / `INSUFFICIENT_BALANCE` / `CLIENT_NOT_REGISTERED` / `INVALID_STATE` 都映射 **-400**，同理按 `errorType` 区分

### 2.1.1 二级前缀语法（v2 新增，对齐 ticket #8 CAS-guard）

允许在 9 项一级前缀后嵌套**子标签**作为机器可读细分，格式：

```
<一级前缀>: <子标签>: <用户消息>
```

示例（ticket #8 CAS-guard 实抛）：

```js
throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED: 订单 ${id} 状态已被其他操作变更`)
```

约束：
- 子标签全大写下划线（与一级前缀同字符集，`[A-Z_]+`）
- 一级前缀必须在 9 项白名单内（snapshot 守护仍只校验一级）
- 子标签**不计入白名单**，但需在抛出处通过 code review 确保语义清晰
- 前端按 `errorType` 路由时仍只取一级前缀，子标签仅用于日志归类 / 监控分组 / 跨端 cross-end SQL snapshot 字面量守护（如未来加 message 字面量守护，按 `<一级>:<子标签>` 二段散列存档）

### 2.2 各端独立副本布局（**对齐 no-shared-cloudfunctions 决策**）

```
fengyu-admin/src/lib/
  ├── api-error.ts            # class ApiError + withApiResponse HOF + ERROR_PREFIXES 数组（9 项）
  └── error-codes.ts          # 9 项前缀常量（与下方三端 .js 字节同义）

fengyu-staff/cloudfunctions/staffApi/utils/
  └── error-codes.js          # 9 项前缀常量 + parseErrorPrefix(msg) + buildResponse(error) helper

fengyu-client/cloudfunctions/clientApi/utils/
  └── error-codes.js          # 同上（独立副本）

fengyu-client/cloudfunctions/payNotify/
  └── error-codes.js          # 同上（独立副本，payNotify 仍走 SUCCESS/FAIL 外壳，仅借用 parseErrorPrefix 做日志归类）
```

**不创建 `cloudfunctions-shared/` 目录、不引入 workspace、不加 symlink**。一致性靠 §3 的 snapshot 测试守护。

**payNotify `PERMISSION_DENIED: PAYNOTIFY_DISABLED` 显式保留**（v2 新增澄清，回应 Warn-4）：
- `fengyu-client/cloudfunctions/payNotify/index.js` 内 feature flag 关闭时抛 `PERMISSION_DENIED: PAYNOTIFY_DISABLED`，语义不是"鉴权失败"而是"通道临时停服"
- 保留理由：(a) 前缀仍在 9 项白名单内，snapshot 守护不报错；(b) 子标签 `PAYNOTIFY_DISABLED` 是合法二级前缀（见 §2.1.1）；(c) 主要用途是 ops 日志按 `errorType=PERMISSION_DENIED` 与子标签 `PAYNOTIFY_DISABLED` 二段归类，便于监控告警。
- **不迁到 `INVALID_STATE`**：避免与"用户操作触发的状态机阻塞"语义混淆。

### 2.3 admin lib/api-error.ts + withApiResponse HOF

```ts
// fengyu-admin/src/lib/api-error.ts
export const ERROR_PREFIXES = [
  'UNAUTHORIZED', 'PHONE_REQUIRED', 'INVALID_PARAMS', 'PERMISSION_DENIED',
  'NOT_FOUND', 'INSUFFICIENT_BALANCE', 'CONFLICT', 'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
] as const

export type ErrorPrefix = typeof ERROR_PREFIXES[number]

export class ApiError extends Error {
  constructor(public prefix: ErrorPrefix, message: string, public data?: unknown) {
    super(`${prefix}: ${message}`)
    this.name = 'ApiError'
  }
}

export type ApiResponse<T> = { success: true; data: T } | { success: false; code: number; errorType: ErrorPrefix | null; message: string; data?: unknown }

export function withApiResponse<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: { name: string }
): (...args: TArgs) => Promise<ApiResponse<TResult>> {
  return async (...args) => {
    try {
      return { success: true, data: await action(...args) }
    } catch (e) {
      // 把任意 throw 收敛到 8 项前缀 + 数值 code（与三端云函数对齐）
      // ApiError → 透出 prefix + 对应 code
      // 4 项官方前缀字符串 → 兼容老代码
      // 中文裸抛 → INVALID_STATE: 服务器内部错误（生产环境）
      ...
    }
  }
}
```

所有 Server Action 改成：

```ts
export const createOrder = withApiResponse(async (input) => {
  await requirePermission('sale_order:create')
  if (!input.skuId) throw new ApiError('INVALID_PARAMS', 'skuId 必填')
  if (!sku) throw new ApiError('NOT_FOUND', `SKU 不存在: ${input.skuId}`)
  // ... 业务逻辑
}, { name: 'createOrder' })
```

---

## 3 跨端一致性守护方案（snapshot 测试，**对齐 no-shared-cloudfunctions 决策**）

**v2 修订**：
1. **解析方式从字符串正则改为 `require()` 直接读取 ERROR_PREFIXES 导出**（admin TS 用 ts-node 或预编译产物），消除原 `extractPrefixArray` 正则在 `as const` / 双引号 / 类型注释括号下的脆性
2. **测试两份对称落地**（admin vitest + staff jest 各一份），不再单边塞 staff `__tests__/` — 否则 admin CI 不守护自家文件，违反 test-colocation feedback

### 3.1 staff 侧（jest）

**新建文件**：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`

```js
/**
 * 跨端错误前缀白名单一致性守护（staff 侧，配合 admin 侧 vitest 同名测试形成对称守护）
 *
 * 守护对象：9 项官方错误前缀字面量，四端必须字节同义
 *   ├── fengyu-admin/src/lib/api-error.ts       (TS, ERROR_PREFIXES 导出)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js (CJS)
 *   ├── fengyu-client/cloudfunctions/clientApi/utils/error-codes.js (CJS)
 *   └── fengyu-client/cloudfunctions/payNotify/error-codes.js (CJS)
 *
 * 任一端漂移 → 测试失败 → 错误信息提醒维护者"同步另外三端 error-codes 文件"
 *
 * 解析策略（v2 修订）：用 require() 直接执行各端 error-codes 文件读取 ERROR_PREFIXES
 * 数组，admin TS 端预编译到 dist/ 或用 ts-node 注册 hook。
 */
const path = require('node:path')

const EXPECTED_PREFIXES = [
  'UNAUTHORIZED', 'PHONE_REQUIRED', 'INVALID_PARAMS', 'PERMISSION_DENIED',
  'NOT_FOUND', 'INSUFFICIENT_BALANCE', 'CONFLICT', 'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
]

function loadPrefixes(modulePath) {
  // 清缓存避免 jest 复用旧 snapshot
  delete require.cache[require.resolve(modulePath)]
  const mod = require(modulePath)
  return [...mod.ERROR_PREFIXES].sort()
}

describe('audit-CC5 P0 协同：四端 ERROR_PREFIXES 白名单一致性守护（staff 侧）', () => {
  let prefixes
  beforeAll(() => {
    // admin TS 端需先 `cd fengyu-admin && bun run build:lib`（或专门导出 dist/api-error.cjs）
    require('ts-node/register/transpile-only') // staff jest 已含此 dev dep；若无，CI 会装
    prefixes = {
      staff: loadPrefixes(path.resolve(__dirname, '../../utils/error-codes.js')),
      client: loadPrefixes(path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/utils/error-codes.js')),
      payNotify: loadPrefixes(path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/error-codes.js')),
      adminTs: loadPrefixes(path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/api-error.ts')),
    }
  })

  test('四端 ERROR_PREFIXES 必须含且仅含 9 项官方前缀', () => {
    const sorted = [...EXPECTED_PREFIXES].sort()
    expect(prefixes.staff).toEqual(sorted)
    expect(prefixes.client).toEqual(sorted)
    expect(prefixes.payNotify).toEqual(sorted)
    expect(prefixes.adminTs).toEqual(sorted)
  })

  test('staff vs client（任一漂移 → 同步另外三端 error-codes 文件）', () => {
    expect(prefixes.client).toEqual(prefixes.staff)
  })
  test('staff vs payNotify', () => {
    expect(prefixes.payNotify).toEqual(prefixes.staff)
  })
  test('staff vs admin TS', () => {
    expect(prefixes.adminTs).toEqual(prefixes.staff)
  })

  test('Snapshot 兜底：9 项前缀文本快照', () => {
    expect(prefixes.staff).toMatchSnapshot()
  })
})
```

### 3.2 admin 侧（vitest）

**新建文件**：`fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts`

```ts
/**
 * 跨端错误前缀白名单一致性守护（admin 侧，配合 staff 侧 jest 同名测试形成对称守护）
 *
 * 守护目标同 staff 侧。admin CI 跑 vitest 时触发本测试，确保 admin 自家
 * fengyu-admin/src/lib/api-error.ts ERROR_PREFIXES 与其他三端不漂移。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const EXPECTED_PREFIXES = [
  'UNAUTHORIZED', 'PHONE_REQUIRED', 'INVALID_PARAMS', 'PERMISSION_DENIED',
  'NOT_FOUND', 'INSUFFICIENT_BALANCE', 'CONFLICT', 'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
]

function loadCjsPrefixes(p: string): string[] {
  delete require.cache[require.resolve(p)]
  const mod = require(p)
  return [...mod.ERROR_PREFIXES].sort()
}

describe('cross-end ERROR_PREFIXES（admin 侧 vitest 镜像）', () => {
  let prefixes: Record<string, string[]>
  beforeAll(async () => {
    const adminMod = await import('@/lib/api-error')
    prefixes = {
      adminTs: [...adminMod.ERROR_PREFIXES].sort(),
      staff: loadCjsPrefixes(path.resolve(__dirname, '../../../../fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js')),
      client: loadCjsPrefixes(path.resolve(__dirname, '../../../../fengyu-client/cloudfunctions/clientApi/utils/error-codes.js')),
      payNotify: loadCjsPrefixes(path.resolve(__dirname, '../../../../fengyu-client/cloudfunctions/payNotify/error-codes.js')),
    }
  })

  test('admin TS == 9 项 == 其他三端', () => {
    const sorted = [...EXPECTED_PREFIXES].sort()
    expect(prefixes.adminTs).toEqual(sorted)
    expect(prefixes.staff).toEqual(prefixes.adminTs)
    expect(prefixes.client).toEqual(prefixes.adminTs)
    expect(prefixes.payNotify).toEqual(prefixes.adminTs)
  })
})
```

### 3.3 admin 裸 throw 零回归守护（grep）

放在 staff 侧 jest（执行环境已稳定）+ admin 侧 vitest 各一份，命令同义：

```bash
grep -rn "throw new Error" fengyu-admin/src/actions/ \
  | grep -vE "__tests__|\\.test\\.ts" \
  | grep -vE "throw new Error\\([\\'\\\"\`]?(UNAUTHORIZED|PHONE_REQUIRED|INVALID_PARAMS|PERMISSION_DENIED|NOT_FOUND|INSUFFICIENT_BALANCE|CONFLICT|INVALID_STATE|CLIENT_NOT_REGISTERED):"
```

期望 stdout 为空（admin actions/ 范围内 0 处违规）。`lib/` 内 11 处明确 out-of-scope（见 §1.2），grep 不包含 `lib/`。

---

## 4 admin withApiResponse HOF 设计细节

### 4.1 错误归类规则

| throw 源 | 转换结果 |
|---------|---------|
| `throw new ApiError('NOT_FOUND', msg)` | `{success:false, code:-404, errorType:'NOT_FOUND', message:msg}` |
| `throw new Error('INVALID_PARAMS: 缺 xx')`（老代码兼容） | 解析前缀 → `{success:false, code:-400, errorType:'INVALID_PARAMS', message:'缺 xx'}` |
| `throw new Error('INVALID_STATE: STATE_TRANSITION_BLOCKED: 订单状态变更')`（二级前缀，见 §2.1.1） | 解析一级前缀 → `{success:false, code:-400, errorType:'INVALID_STATE', message:'STATE_TRANSITION_BLOCKED: 订单状态变更'}` |
| `throw new Error('CARD_NOT_FOUND')`（野生前缀） | 不在 9 项白名单 → `{success:false, code:-1, errorType:null, message:'服务器内部错误'}` + console.error 原始 message |
| `throw new Error('员工编号生成失败')`（中文裸抛） | 同上：`{code:-1, errorType:null, message:'服务器内部错误'}` |
| `throw new Error('DB 连接超时')`（系统错误） | 同上 |

### 4.2 与三端云函数 index.js 对齐

admin `withApiResponse` 的输出 shape 必须与 staffApi/clientApi `index.js` 全局 catch 返回的 `{code, message, errorType, data}` **同构**（admin 额外加 `success: boolean` 字段以兼容现有 Server Action useFormState）：

```ts
// 三端云函数对齐口径（v2: 9 项含 CLIENT_NOT_REGISTERED）
const CODE_MAP: Record<ErrorPrefix, number> = {
  UNAUTHORIZED: -401,
  PHONE_REQUIRED: -403,
  PERMISSION_DENIED: -403,    // 与 PHONE_REQUIRED 共用，前端按 errorType 区分
  INVALID_PARAMS: -400,
  INSUFFICIENT_BALANCE: -400,
  INVALID_STATE: -400,
  CLIENT_NOT_REGISTERED: -400, // 与 INVALID_PARAMS 共用 -400，按 errorType 区分（admin orders.test.ts 已有断言依赖）
  NOT_FOUND: -404,
  CONFLICT: -409,
}
```

### 4.3 admin 老代码迁移策略（34 处违规批量处理，v2 修订：保留 CLIENT_NOT_REGISTERED）

| 类别 | 数量 | 处理 |
|------|------|------|
| `CARD_*` 系列（11 处）| 11 | 全部归并到 `INVALID_STATE: 充值卡 ...`（带详细中文 message）或 `NOT_FOUND: 充值卡不存在` |
| `ORDER_ID_GEN_FAILED` / `REF_ORDER_NOT_FOUND` | 3 | `INVALID_STATE: 订单号生成失败` / `NOT_FOUND: 原订单不存在` |
| `CONCURRENT_CHANGED` / `CARD_CONCURRENT_CHANGED` | 5 | `CONFLICT: 数据已被其他操作修改，请刷新` |
| `INSUFFICIENT_SESSIONS` / `INSUFFICIENT_BALANCE:${...}` | 3 | `INSUFFICIENT_BALANCE: 次数不足` / `INSUFFICIENT_BALANCE: 余额不足 ${amount}` |
| `OVERPAY:${...}` / `OVER_QUANTITY` | 2 | `INVALID_STATE: 超额支付 ${amount}` / `INVALID_STATE: 超出可提数量` |
| `SKU_NOT_FOUND:${...}` | 1 | `NOT_FOUND: SKU 不存在` |
| `CLIENT_NOT_REGISTERED` | 1 | **保留原前缀**（v2 修订）— 一级白名单已含，admin orders.test.ts 5 处 `message.toContain('CLIENT_NOT_REGISTERED')` 0 修改通过 |
| `PREPAID_CARD_UPSERT_FAILED` / `PAYMENT_INSERT_FAILED` / `CARD_UPSERT_FAILED` | 3 | `CONFLICT: 数据写入冲突，请重试` |
| 9 处中文裸抛 | 9 | 全部加 `INVALID_STATE:` 前缀（业务可恢复）或 `INVALID_PARAMS:`（参数性问题）|

→ 总计 **34 处全部归并到 9 项白名单**。**v2 修订：拆独立 follow-up PR**，本 ticket 仅在 1 个示范文件（推荐 `fengyu-admin/src/actions/employees.ts` 中"员工编号生成失败"一处）验 `bun run build` 通过 + 现有 orders.test.ts 全绿，再开 ticket-10c 全量替换。

---

## 5 详细 patch（按 L0→L10 传播层）

**v2 修订**：
- 所有具体行号引用 → 改为「文件路径 + 函数名 + 关键代码片段」（避免漂移）
- §5 L9 staffApi cloud.ts 修复**升为本 ticket 必做 + 强制与 §3 snapshot 同 PR 落地**
- §5 L7 admin 34 处批量替换**拆独立 follow-up PR**（ticket-10c），本 ticket 仅含 1 个示范文件验证
- §5 L0 docs **补 3 处子项目 CLAUDE.md**

### L0 - 创建各端 error-codes 副本

| 文件 | 内容要点 |
|------|---------|
| **新建** `fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js` | `module.exports = { ERROR_PREFIXES: [...9项], CODE_MAP: {...}, parseErrorPrefix(msg), buildErrorResponse(err) }` |
| **新建** `fengyu-client/cloudfunctions/clientApi/utils/error-codes.js` | 字节同义 |
| **新建** `fengyu-client/cloudfunctions/payNotify/error-codes.js` | 字节同义（payNotify 仅用 parseErrorPrefix 做日志归类，响应仍 `{code:'SUCCESS'/'FAIL'}`，保留 `PERMISSION_DENIED: PAYNOTIFY_DISABLED` feature flag 子标签）|
| **新建** `fengyu-admin/src/lib/api-error.ts` | `ApiError class` + `ERROR_PREFIXES`（9 项）+ `CODE_MAP` + `withApiResponse(action, {name})` HOF |

### L3 - 三端 index.js 改用 buildErrorResponse

| 文件 | 改动（按函数名定位，不靠行号） |
|------|------|
| `fengyu-staff/cloudfunctions/staffApi/index.js` 的 `exports.main` 顶层 try/catch 块（内含 `knownTypes` 数组与 `code` 映射） | 删除内联 knownTypes/code 映射，改为 `return require('./utils/error-codes').buildErrorResponse(error)` |
| `fengyu-client/cloudfunctions/clientApi/index.js` 同位置 | 同上 |
| `fengyu-client/cloudfunctions/payNotify/index.js` 顶层 catch（返回 `{code:'FAIL', message:err.message}` 处） | 引入 parseErrorPrefix 做日志归类（前缀打到 ops 监控），响应仍 `{code:'SUCCESS'/'FAIL'}` 不变 |

### L3 - staff routes 两处裸抛修复（P2-CC5-04/05，按代码片段定位）

| 文件 + 关键片段 | 改动 |
|---------------|------|
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` 内 `completeService` / `applyServiceItem` 含全角冒号 `次数不足：` 的抛错处 | 改为 `throw new Error('INVALID_PARAMS: 次数不足，订单行 ... 剩余次数不足')` |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 内 `confirmOffline` 中 `[confirmOffline] ...` 充值卡面值解析异常裸抛处 | 改为 `throw new Error('INVALID_PARAMS: 充值卡面值解析异常，请重新录入')` |

### L7 - admin 示范文件验证（v2 修订：仅 1 处验 build，其余拆 ticket-10c）

| 文件 + 函数名 | 操作 |
|------|------|
| `fengyu-admin/src/actions/employees.ts` 中 `generateEmployeeId()`（含 `throw new Error('员工编号生成失败')`） | 改为 `throw new ApiError('INVALID_STATE', '员工编号生成失败')` + 把上一层 Server Action 出口包 `withApiResponse(async (...) => {...}, { name: 'createEmployee' })`，验证 `cd fengyu-admin && bun run build` 通过 + `vitest run actions/employees` 全绿 |

> **拆独立 PR 理由**：Next.js 15 要求 Server Action 是顶层 async 函数 export，`withApiResponse(async (...) => {...})` 在某些 SWC 版本会被拒绝（"server action must be async function declaration"）。先在 1 个示范文件证明 build OK 再开 ticket-10c 全量替换其余 33 处。

### L9 - 前端 cloud.ts 同步（P1-CC5-01 协同修复，**v2 修订：强制本 ticket 必做 + 与 snapshot 同 PR**）

| 文件 + 函数名 | 改动 |
|------|------|
| `fengyu-staff/miniprogram/utils/cloud.ts` 中 `callStaffApi` 函数（含 `throw new Error(message)` 一行） | 改为 `throw new StaffApiError({ code, errorType, data, message })` 或在 Error 实例上挂 `err.errorType / err.code / err.data` 字段（与 `fengyu-client/miniprogram/utils/cloud.ts` 内 `callClientApi` 已有的 `err.errorType` 对称） |
| `fengyu-staff/miniprogram/packageMgmt/mgmt-customer-detail/mgmt-customer-detail.ts` 中处理 `assign` 调用错误的 catch（原按 `err.message.indexOf('PERMISSION_DENIED')` 判断的位置） | 改 `if ((err as any)?.errorType === 'PERMISSION_DENIED')` |

> **强约束**：若不与 §3 snapshot 同 PR 落地，则 `mgmt-customer-detail.ts` 的 `PERMISSION_DENIED` 分支不可达（ticket §0 自陈的 P1-CC5-02 修复目标）**不会随本 ticket 真正达成**。两者**必须捆绑发车**。

### L0 docs（v2 修订：补 3 处子项目 CLAUDE.md）

| 文件 | 改动 |
|------|------|
| `CLAUDE.md`（root 全局规范）"错误前缀约定"段 | 4 项 → 9 项（含 `NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CONFLICT` / `INVALID_STATE` / `CLIENT_NOT_REGISTERED`）+ 注明"PHONE_REQUIRED 与 PERMISSION_DENIED 共用 -403，前端按 errorType 区分" + 二级前缀语法说明 |
| `.42cog/dev/sys.spec.md` | 同步白名单 + 各端独立副本说明 + snapshot 守护测试位置 |
| `fengyu-staff/CLAUDE.md` 错误前缀章节 | 4 项 → 9 项同步（旧文写"错误前缀约定 4 项"）|
| `fengyu-client/CLAUDE.md` 错误前缀章节 | 同上 |
| `fengyu-staff/cloudfunctions/staffApi/CLAUDE.md` 错误前缀章节 | 同上 |

### L11 - snapshot 守护测试（v2 修订：对称双份）

| 文件 | 操作 |
|------|------|
| **新建** `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` | 见 §3.1 完整代码（jest，含 require() 解析 + 9 项断言）|
| **新建** `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` | 见 §3.2 完整代码（vitest，含 require() 解析 + 9 项断言）|

---

## 6 验证 Checklist（v2 修订：含 admin build / orders.test.ts 门禁）

- [ ] 四端 `error-codes` 文件存在且 ERROR_PREFIXES 恰好 **9 项**（snapshot 测试断言）
- [ ] `cross-end-error-codes-snapshot.test.js`（staff 侧 jest）全绿
- [ ] `error-codes-cross-end.test.ts`（admin 侧 vitest）全绿
- [ ] admin `grep -rn "throw new Error" fengyu-admin/src/actions/ | grep -vE "9项白名单" | wc -l` = **0**（仅在 follow-up ticket-10c 后达成；本 ticket 期望 33，仅示范文件 employees.ts 减 1）
- [ ] staff `grep -n "throw new Error" fengyu-staff/cloudfunctions/staffApi/routes/service.js routes/order.js` 无全角冒号 / 方括号前缀
- [ ] staffApi/clientApi 单元测试：每个前缀对应 code 映射正确（9 个 case）
- [ ] payNotify 仍返回 `{code:'SUCCESS'/'FAIL'}`，但日志能解析前缀（grep `[CC5]` 关键字）；`PERMISSION_DENIED: PAYNOTIFY_DISABLED` feature flag 路径手测有日志归类
- [ ] staff `mgmt-customer-detail.ts` 的 PERMISSION_DENIED 分支真实可达（手测：用越权 openid 触发后看到 toast + 返回上一页 — **依赖 §5 L9 cloud.ts 修复同 PR 落地**）
- [ ] **`cd fengyu-admin && bun run build` 通过**（v2 新增 — 验证 withApiResponse HOF 在 Next.js 15 Server Action 下编译 OK）
- [ ] **admin 现有 `bun run test orders.test.ts` 全绿**（v2 新增 — 含 5 处 `message.toContain('CLIENT_NOT_REGISTERED')` 断言）
- [ ] CLAUDE.md（root）+ .42cog/dev/sys.spec.md + fengyu-staff/CLAUDE.md + fengyu-client/CLAUDE.md + staffApi/CLAUDE.md **5 处**已更新 4→9 项前缀清单

---

## 7 风险与回滚

### 7.1 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 前端硬编码 `err.message.indexOf('CARD_NOT_FOUND')` 之类老前缀 | UI 分支失效 | 全仓 grep `indexOf\(['"](CARD_\|ORDER_\|OVERPAY\|...)`，修复前端识别逻辑（admin packageMgmt/前端两侧）|
| admin 老 action 已被前端依赖 `{success:false, message}` shape | 现有页面 break | `withApiResponse` 保持 `success` 字段；新增 `code/errorType/data` 字段，老前端忽略不报错 |
| 测试本地 grep 在 Windows / CI 环境差异 | snapshot 测试假阳 | 用 `node:child_process.execSync` 标准化命令；CI 已用 Linux runner，与本地 macOS grep 行为一致 |
| INVALID_STATE 语义被滥用（兜底容易过宽）| 错误码失去鉴别力 | 在 ApiError 文档注明"INVALID_STATE 仅用于状态机不允许的操作；CONFLICT 仅用于并发冲突；二者不互换" |

### 7.2 回滚

- 各端 `error-codes` 文件独立创建 → 单端 revert 不影响其他端
- admin `withApiResponse` 是 wrapper，未包裹的 action 仍照原 `{success:false, message}` 返回 → 灰度替换可行
- snapshot 测试 fail 不阻塞部署（仅警示）→ 可在测试稳定后加 CI required check

---

## 8 关联

| 项 | 说明 |
|----|------|
| **SUMMARY 来源** | [v3 §2 Top10 #10](../../docs/audit/SUMMARY.md) + [§3 横切热点](../../docs/audit/SUMMARY.md)（错误前缀偏离 4 项约定 + admin 裸 throw）|
| **audit 主报告** | [audit-CC5 错误码](../../docs/audit/audit-CC5-error-code.md) — §3 P1-CC5-01/02/03 + P2-CC5-04/05/06/07/08 全部纳入本 ticket |
| **audit 衍生命中** | 01/02/03/04/05/06/09/10/11/12/13/14/16/18/19/20/24/25 共 18 个业务域报告 §5 CC5 节（参见 audit-CC5 附录 A）|
| **用户决策** | feedback `no-shared-cloudfunctions`（2026-04-26） — 不抽 `cloudfunctions-shared/`；改各端独立副本 + snapshot 守护 |
| **参考样板** | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`（已落地，守护 settlePoints 4 端 + applyRecharge 3 端 SQL 字面量）|
| **L7 admin 协同 epic** | SUMMARY §4 L7 P0 6 项中的 "`lib/api-error.ts` 新建" — 本 ticket 落地 1/6；其余（withPermission HOF / PERMISSION_MATRIX DB 化 / formatPhoneSafe / sanitizeDetail）独立排期 |
| **未在本 ticket 处理** | P2-CC5-07（sanitizeErrorMessage 60→100 长度阈值）+ P2-CC5-08（两端 sanitize 规则差异）作为 follow-up，与本 ticket 并行可独立做 |
| **后置 epic 候选** | E10 admin permission 收尾（SUMMARY §5.4）— withPermission HOF 与本 ticket 的 withApiResponse HOF 可共用 wrapper 模式 |
| **拆出 follow-up（v2 新增）** | ticket-10b: `admin lib/* 11 处裸 throw 收敛 + withApiResponse 全 lib 覆盖`；ticket-10c: `admin actions/* 33 处违规批量替换为 ApiError + withApiResponse 全 Server Action 覆盖` |

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**：
1. **白名单缺 `CLIENT_NOT_REGISTERED`（实证 9 而非 8）**。staffApi index.js:171 已含此前缀，routes/order.js 三处（235/1819/2026）实抛，admin orders.test.ts 5 处断言 `message.toContain('CLIENT_NOT_REGISTERED')`。ticket §1.1 明知 staff knownTypes 9 项，却在 §2.1 强制收成 8 项 + §4.3 把 `CLIENT_NOT_REGISTERED → INVALID_PARAMS:顾客未注册` —— 这会让 admin 测试集体红，且 staff 前端任何按 `errorType==='CLIENT_NOT_REGISTERED'` 的 UI 分支静默退化为通用 -400 toast。**必须二选一**：白名单做 9 项，或先列 admin/前端硬编码迁移清单再降级。
2. **staffApi cloud.ts:52 抛 `new Error(message)` 完全丢 errorType/code/data**（与 client cloud.ts:42 已带 `err.errorType` 不对称）。ticket §5 L9 仅一行带过，但若不与 §3 snapshot 同 PR 落地，员工端 `mgmt-customer-detail.ts:248` 的 `PERMISSION_DENIED` 分支不可达（ticket §0 自陈的 P1-CC5-02 修复目标）将不会随本 ticket 真正达成。
3. **snapshot 测试正则只解析单引号 `'XXX'`**（`extractPrefixArray` 用 `/'([A-Z_]+)'/g`），但 admin TS 习惯双引号 + `as const` 或末尾逗号变体；同时正则 `/ERROR_PREFIXES[^=]*=\s*\[([\s\S]*?)\]/` 在 TS 文件碰到 `ERROR_PREFIXES = [...] as const` 嵌套数组或类型注释括号时会截断错位。需用 AST 或 require 实际执行解析，否则 admin/payNotify 两端易产生假绿。

**Warn 级问题**：
1. **34 处计数仅覆盖 `actions/`**。`fengyu-admin/src/lib/` 还有 11 处裸 throw（如 `lib/refund.ts:93`、`lib/cloudbase.ts:29/56`）。Server Action 调 lib 时这些原样冒泡到 withApiResponse，命中"野生前缀 → 服务器内部错误"兜底，意味着退款/上传失败的真实业务文案被吞。ticket 范围声明需要扩到 `src/lib/` 或显式排除。
2. **行号漂移**：ticket 称 `lib/permissions.ts:218`，实为 234/254（两处不是一处）；称 `order.js:988`，实为 1008；称 `service.js:367` 全角冒号已 verified。补丁脚本若用行号定位会失败。
3. **`'use server'` 与高阶函数兼容性**：Next.js 15 要求 Server Action 是顶层 async 函数 export，`withApiResponse(async (...) => {...})` 在某些 Next 版本会被 SWC 拒绝（"server action must be async function declaration"）。需先在 1 个示范文件验证 build 通过，否则 §4.3 全量替换会编译炸。
4. **`payNotify` `PERMISSION_DENIED: PAYNOTIFY_DISABLED`（index.js:107）** 是白名单前缀 + 非业务真实语义（实际是 feature flag 关停），snapshot 守护 + grep 不会报错，但语义噪声混入监控 —— ticket §2.2 提到 payNotify 仅借 parseErrorPrefix 做日志归类，未澄清这条响应该保留还是迁到 `INVALID_STATE`。
5. **CAS-guard ticket-8 用 `INVALID_STATE: STATE_TRANSITION_BLOCKED:...` 嵌套二级前缀**，本 ticket §2.1 未为这种"前缀:子标签:..."形式留约定，未来 cross-end snapshot 若加 message 字面量守护会需要再开规则。
6. **CLAUDE.md / staff CLAUDE.md / client CLAUDE.md / staffApi CLAUDE.md 共 4 处** 都写"错误前缀约定 4 项"，ticket §5 L0 docs 只列 CLAUDE.md + sys.spec.md，子项目 CLAUDE.md 漏更。
7. **测试位置违反 `test-colocation` feedback**：ticket §3 把跨端测试塞进 staff `__tests__/`，但守护对象包含 admin TS / client / payNotify —— admin 端跑 vitest 时不会触发这个 jest 测试，admin CI 不守护自家文件。更符合 feedback 的做法是 admin 端 vitest + staff 端 jest 各跑一份对称测试，或显式声明"跨端守护测试豁免 colocation"。

**OK**：
- 34 处违规计数（actions/ 范围内）grep 实证准确。
- `admin lib/api-error.ts` 确不存在；`permissions.ts` 是唯一统一前缀来源（仅两处 `requirePermission/requireAnyPermission`，171 处调用收口正确）。
- knownTypes staff 9 项 / client 6 项 / payNotify 透传 描述准确。
- 参考样板 `cross-end-sql-snapshot.test.js` 真实存在且模式可复用。
- HTTP code 映射表（PHONE_REQUIRED 与 PERMISSION_DENIED 共用 -403、前端按 errorType 区分）与 client index.js:132 实测一致。
- 不抽 cloudfunctions-shared / 各端独立副本方案与 feedback `no-shared-cloudfunctions` 对齐。

**改进建议**：
1. 白名单改 9 项保留 `CLIENT_NOT_REGISTERED`（或新增 ticket-10b 单独处理收敛），admin 测试零修改先落地白名单。
2. §5 L9 与 §5 L7 拆分 PR：先 L0 + L3（云函数侧）+ snapshot 测试 + cloud.ts 对称（**必须同 PR**），再 L7 admin withApiResponse（独立 PR + 1 个示范模块验 build）。
3. snapshot 正则升级为 `require()` 直接读取 ERROR_PREFIXES 导出（admin TS 可用 ts-node 或预编译产物），消除字符串匹配脆性。
4. §5 L0 docs 补 fengyu-staff/CLAUDE.md、fengyu-client/CLAUDE.md、staffApi/CLAUDE.md 三处子项目文档。
5. 将 lib/ 11 处裸 throw 加入清单或显式声明 out-of-scope；并把 ticket-8 二级前缀（`INVALID_STATE: STATE_TRANSITION_BLOCKED:`）在 §2.1 文档化为允许子语法。
6. §6 验证 checklist 增加：`cd fengyu-admin && bun run build` 通过 + admin 现有 orders.test.ts 全绿，作为合并门禁。
