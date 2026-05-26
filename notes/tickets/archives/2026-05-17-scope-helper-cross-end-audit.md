# Ticket: scope 隔离 helper 跨端审计 + 缺口补齐 [已归档]

> 生成日期：2026-05-17
> 归档日期：2026-05-17
> 实施状态：✅ **Phase 1 + 2 + 3 全部落地（已归档）**
> 实施日期：2026-05-17（Phase 1 + 3 + 2）
> PR：E7 + E6 收尾 PR（与 #11/#14/#15 合并）+ 后续 PR-2（Phase 2 路由替换）
> 严重级别：P0（衍生自 P0-CC3-x / P0-CC4-06；非阻塞但纵深防御缺失）
> 端：fengyu-staff / fengyu-client / fengyu-admin
> 来源：[SUMMARY v3 §2 #13](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-CC3-org-isolation.md](../../docs/audit/audit-CC3-org-isolation.md) / [audit-CC4-auth.md](../../docs/audit/audit-CC4-auth.md) / [audit-10](../../docs/audit/audit-10-customer-member-level.md)

---

## 0 一句话背景

2026-04-27 staff customer 6 路由 + performanceDetail scope 越权（SUMMARY Top 10 #9）已在路由层逐处加
`buildStoreScopeCondition` / `effectiveStoreId` WHERE / `requireManager` 修复，但 **集中化的
`assertCustomerInScope` / `assertOrderInScope` / `assertEmployeeInScope` helper 仍未抽出**。
当前 scope 守卫散落在各路由内联 SQL 中，新增路由仍需逐处复制粘贴模板 — 漏一处即越权。

用户已 veto `cloudfunctions-shared/` 共享目录（feedback `no-shared-cloudfunctions`），
所以方案不是"抽一个共享 helper"，而是 **三端各自落 helper + 跨端字面量 snapshot 守护**。

---

## 1 现状（2026-05-17 grep 实证）

| 端 | scope helper 文件 | 已暴露函数 | 缺口 |
|----|-------------------|-----------|------|
| staff | `fengyu-staff/cloudfunctions/staffApi/utils/scope.js` | `deriveStaffLevel` / `deriveAvailableLoginLevels` / `expandScopeStoreIds` / `buildStoreScopeCondition` | ❌ 无 `assertCustomerInScope` / `assertOrderInScope` / `assertEmployeeInScope` |
| client | — | — | ❌ 整个 scope helper 模块缺失（client 主要靠 OPENID 单用户，但 store_unbind/admin 工具入口仍需）|
| admin | `fengyu-admin/src/lib/permissions.ts`（含 `scopeCondition`, `isInScope`, `expandScopeStoreIds`） | scopeCondition / buildScopeWhere / isInScope / isAdminScope | ⚠️ 已有部分，但 `assertOrderInScope(orderId)` / `assertCustomerInScope(clientUserId)` 这种"读单实体后断言"的封装未抽 |

### 1.1 实际越权风险面（仍散落的内联模板）

| 路由 | 越权检查模式 | 问题 |
|------|-------------|------|
| `staffApi/routes/customer.js:296-300` (detail) | inline `if (loginLevel === 'management') scopeStoreIds.includes(...) else === effectiveStoreId` | 5 行手写 + 易复制错 |
| `staffApi/routes/customer.js:941-947` (updateNotes) | inline `UPDATE ... WHERE user_id = $2 AND bound_store_id = $3` + rowCount=0 抛权限错 | 散落 |
| `staffApi/routes/customer.js:1008-1014` (assign) | 同上 | 散落 |
| `staffApi/routes/staff.js:444-461` (performanceDetail) | 12 行 inline scope guard | 散落 |
| `staffApi/routes/order.js:*` createRefund / approveRefund | 多处 inline scope 检查 | 散落 |

---

## 2 目标 helper 接口（三端对齐）

### 2.1 staff（utils/scope.js 扩展）— ✅ 已落地

实际签名：返回 `{boundStoreId|storeId}` 供调用方复用（非 ticket 草案的 `Promise<void>`）。
含 `isStoreInScope` 纯函数（不查 DB 的内存判定）。

```js
// 现有保留：deriveStaffLevel / expandScopeStoreIds / buildStoreScopeCondition
function isStoreInScope(auth, storeId) { ... }  // 纯函数
async function assertCustomerInScope(client, auth, clientUserId) { ... }  // → {boundStoreId}
async function assertOrderInScope(client, auth, saleOrderId) { ... }      // → {storeId}
async function assertEmployeeInScope(client, auth, employeeId) { ... }    // → {storeId}；自查无需 DB
```

### 2.2 client（utils/scope.js 新建）— ✅ 已落地

```js
// fengyu-client/cloudfunctions/clientApi/utils/scope.js
async function assertUserStoreBound(client, userId) { ... }                  // → {boundStoreId}
async function assertUserOwnsOrder(client, userId, saleOrderId) { ... }      // → {storeId}
```

> 与 staff/admin 端语义差异：client 按 `client_user_id = userId` 自检归属（OPENID 单用户），
> 不参与 staff/admin 的 store_id 多店 scope。

### 2.3 admin（lib/scope-assert.ts 新建，与 permissions.ts 并排）— ✅ 已落地

实际签名同样返回 `{boundStoreId|storeId}`；admin 角色（`isAdminScope`）走快路径无 scope 检查。

```ts
// fengyu-admin/src/lib/scope-assert.ts
export async function assertCustomerInScope(session: AuthSession, clientUserId: string): Promise<{boundStoreId: string | null}>
export async function assertOrderInScope(session: AuthSession, saleOrderId: string): Promise<{storeId: string | null}>
export async function assertEmployeeInScope(session: AuthSession, employeeId: string): Promise<{storeId: string | null}>
```

---

## 3 跨端字面量 snapshot 守护（与 E7 模式一致）

参照 `cross-end-sql-snapshot.test.js`（settlePoints / applyRecharge 已守护）：

```js
// fengyu-staff/cloudfunctions/staffApi/__tests__/utils/cross-end-scope-snapshot.test.js
describe('scope helper 跨端语义一致性', () => {
  it('staff assertCustomerInScope vs admin assertCustomerInScope SQL 一致', () => {
    const staffSql = extractSql(read(STAFF_SCOPE_JS), 'assertCustomerInScope')
    const adminSql = extractSql(read(ADMIN_SCOPE_ASSERT_TS), 'assertCustomerInScope')
    expect(normalize(staffSql)).toBe(normalize(adminSql))
  })
  // ... assertOrderInScope / assertEmployeeInScope 同理
})
```

---

## 4 改造计划

### Phase 1 — helper 抽取（半天） — ✅ 全部落地

- [x] staff utils/scope.js 加 `isStoreInScope` + `assertCustomerInScope` / `assertOrderInScope` / `assertEmployeeInScope`
- [x] client utils/scope.js 新建（`assertUserStoreBound` + `assertUserOwnsOrder`）
- [x] admin lib/scope-assert.ts 新建（三个 assert，admin 角色走快路径）

### Phase 2 — 路由替换（1 天） — ✅ 全部落地（2026-05-17）

- [x] `staffApi/routes/customer.js`：
  - `detail` — 5 行 inline scope check 改为 `isStoreInScope(ctx.auth, pgUser.bound_store_id)`（已加载实体，无需额外查询）
  - `updateNotes` — `assertCustomerInScope` 前置守卫，UPDATE 删 `bound_store_id` WHERE 条件
  - `assign` — `assertCustomerInScope` + `assertEmployeeInScope` 双守卫
  - calendar / giftHistory / refundHistory — 既有 `buildStoreScopeCondition` 已 helper 化（无 inline 待改）
- [x] `staffApi/routes/staff.js` `performanceDetail` — 12 行 inline 改一行 `await assertEmployeeInScope(pg, ctx.auth, targetEmployeeId)`（自查路径 helper 内部短路）
- [x] `staffApi/routes/order.js`：
  - `close` — assertOrderInScope 前置，SELECT 去 `store_id = $2`
  - `createRefund` — assertOrderInScope 前置，原单查询去 store_id 过滤
  - `approveRefund` / `rejectRefund` — 已 JOIN 拿到 store_id，inline `!== effectiveStoreId` 改 `!isStoreInScope(ctx.auth, sopRow.store_id)`（无需额外查询）
  - cancel — order.js 无 cancel 路由（仅 close）
- [x] admin `actions/refunds.ts` approveRefund / rejectRefund — `try/await assertOrderInScope` + catch 转 `{success:false, error:{code:'PERMISSION_DENIED'}}`
  - 注：原 ticket 路径写 `actions/orders.ts`，实际位置在 `actions/refunds.ts`

测试同步：
- staff customer.test.js（10 测试）updateNotes/assign mock 链改为 array shape + 追加 assertXxxInScope SELECT
- staff order.test.js（19 测试）createRefund describe-level beforeEach 注入 `mockScopeAllow()`；close 各测试逐行加 `mockScopeOk()`；approve/reject 跨店期望值改 `订单不在当前门店范围内`
- staff Vitest 全套 1041/1041 通过 ✅
- admin refunds.test.ts 6/6 通过 ✅（其他 admin 测试失败均为 pre-existing 与本 ticket 无关）

### Phase 3 — 守护测试（半天） — ✅ 全部落地

- [x] `cross-end-sql-snapshot.test.js` 加 `'SUMMARY v3 §2 #13'` describe（staff vs admin 5 子组、13 用例 + client 端 5 用例 = 18 用例）
- [x] staff `scope.test.js` 新增 19 用例（isStoreInScope 5 + 3 assert × 4-6 分支）
- [x] client `__tests__/utils/scope.test.js` 新增 11 用例（2 assert × 5-6 分支）

---

## 5 验证 Checklist

- [x] 路由层 `bound_store_id = \$` inline 守卫已全部抽出至 helper（customer.detail/updateNotes/assign + staff.performanceDetail + order.close/createRefund/approveRefund/rejectRefund）
- [ ] e2e 跨店越权场景全部抛 `PERMISSION_DENIED:`（非 200 + 空 data）— **e2e 需 PG 起容器，本轮以单元测试 + 跨端 snapshot 替代验证**
- [x] snapshot 守护：故意改 staff helper SQL 后测试失败 + 错误信息提示同步 admin（cross-end-sql-snapshot.test.js 已覆盖）
- [x] 单元测试：staff 1041/1041 + admin refunds 6/6 全过

---

## 6 关联

- [SUMMARY v3 §2 #13](../../docs/audit/SUMMARY.md)
- [SUMMARY v3 §4 L1 helpers](../../docs/audit/SUMMARY.md#l1--helpers-层v3-更新) — "P0 剩 6 项" 之一
- audit-CC3-org-isolation.md（P0-CC3-x 系列）
- audit-CC4-auth.md P0-CC4-06（staff customer 6 路由 — 路由层已修，helper 集中化待）
- 同 epic 还有 #11 face_value_override / #14 refund-cascade snapshot 守护

## 7 排期建议

M（2 天），E4 scope 全覆盖 epic 收尾。
- **PR-1（E7+E6 收尾 PR，2026-05-17 ✅ 已合并）**：Phase 1（含 client）+ Phase 3 全部
- **PR-2（2026-05-17 ✅ 已落地）**：Phase 2 路由层 inline scope 替换 helper（staff customer.js/staff.js/order.js × 多处 + admin refunds.ts approveRefund/rejectRefund）
