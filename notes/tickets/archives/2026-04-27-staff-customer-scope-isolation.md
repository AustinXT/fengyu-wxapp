# Ticket: staffApi customer 6 路由 + performanceDetail 跨店越权修复

> 生成日期：2026-04-27
> 实施状态：🟡 代码已修改（待测试 + 待部署）
> 严重级别：**P0**（越权 + PII 泄露 — SUMMARY Top10 #9）
> 端：fengyu-staff
> 来源：[SUMMARY §2 #9](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-10 顾客+会员](../../docs/audit/audit-10-customer-member-level.md)、[audit-11 退款](../../docs/audit/audit-11-refunds.md)、[audit-19 赠送/分享](../../docs/audit/audit-19-gift-share-assign.md)、[CC3 组织域隔离](../../docs/audit/audit-CC3-org-isolation.md)、[CC4 后端鉴权](../../docs/audit/audit-CC4-auth.md)

---

## 0 一句话背景

`staffApi/routes/customer.js` 的 `detail` / `calendar` / `giftHistory` / `refundHistory` / `updateNotes` / `assign` 共 6 个路由**完全无 store_id scope 过滤**，加上 `staff.performanceDetail` 跨店读取他店员工业绩（含顾客 PII），任意绑店员工可越权读取/修改全集团任意门店的顾客数据。

## 1 受影响路由矩阵

| 路由 | Audit ID | 文件行号 | 问题 | 只读/写 | PII 风险 |
|------|----------|---------|------|---------|---------|
| `customer.detail` | P0-10-01 | L242-342 | SELECT 无 bound_store_id 过滤 | 读 | 姓名/肤质/备注/消费额 |
| `customer.calendar` | P0-10-02 | L146-237 | 两个 SQL 均无 store_id 过滤 | 读 | 全门店消费日历 |
| `customer.giftHistory` | P0-19-02 | L823-908 | giftItems 查询无 store_id | 读 | 赠送详情/SKU/金额 |
| `customer.refundHistory` | P0-11-05 | L675-741 | 无 store_id 过滤 | 读 | 退款金额/原因/原单号 |
| `customer.updateNotes` | P0-10-03 | L914-933 | UPDATE 无 bound_store_id，无 requireManager，无审计日志 | **写** | 备注篡改 |
| `customer.assign` | P0-10-04 / P0-19-01 | L967-995 | UPDATE 无 bound_store_id 守卫，无审计日志 | **写** | 顾客归属篡改 |
| `staff.performanceDetail` | P0-CC3-06 | staff.js | 无 store 过滤，跨店读他店员工业绩 | 读 | 他店顾客 PII |

## 2 越权攻击路径

### 场景 A：跨店读取顾客 PII（detail/calendar/giftHistory/refundHistory）

```
员工 emp-X 绑定门店 A
  → 通过 customer.search(phone) 获取门店 B 顾客 user_id
    → customer.detail / calendar / giftHistory / refundHistory 传入 clientUserId
      → 返回门店 B 顾客完整档案/消费日历/赠送/退款记录（无 scope 过滤）
```

### 场景 B：跨店篡改顾客备注（updateNotes）

```
任意绑店员工（含前台美容师）
  → UPDATE client_wechat_users SET notes = $1 WHERE user_id = $2
    → 无 bound_store_id 守卫，无 requireManager，无 operation_logs
      → 任意顾客备注被篡改，无审计追踪
```

### 场景 C：跨店分配顾客归属（assign）

```
多店店长 mgrA，loginLevel='store'，切换至门店 X
  → customer.search(phone) 获取门店 Y 顾客 B 的 user_id
    → customer.assign({ clientUserId: B, employeeId: empX })
      → UPDATE 仅 WHERE user_id = $1，无 bound_store_id 校验
        → 顾客 B 的 bound_employee_id 被覆写为门店 X 员工
          → bound_store_id 仍为门店 Y → 脏数据
          → 无 operation_logs → 无法追查
```

### 场景 D：跨店读取员工业绩 + 顾客 PII（performanceDetail）

```
任意绑店员工
  → staff.performanceDetail({ employeeId: 他店员工ID })
    → 返回他店员工业绩明细（含服务过的顾客信息）
      → 顾客 PII 泄露 + 业绩数据越权读取
```

## 3 关键代码路径

### 3.1 customer.detail（L242-342）

```js
// 仅 requireStaffBound()，无 scope 过滤
// SELECT 按 id/clientUserId/phone 查询，返回完整档案
// 对比：mgmt-customer.js:222-244 有 assertCustomerInScope
```

### 3.2 customer.calendar（L146-237）

```js
// 两个 SQL（dailySummary + orderRows）仅按 client_user_id/client_phone 过滤
// 对比：同文件 paidOrders L428-432 正确使用 AND o.store_id = $2
```

### 3.3 customer.giftHistory（L823-908）

```js
// giftItems 查询 WHERE 仅按 client_user_id/client_phone，无 o.store_id
// promoOrders 分支用 AND FALSE（始终空），giftItems 是真实泄露路径
// 对比：同文件 paidOrders 正确；mgmtCustomer.giftHistory 用 buildSaleScope
```

### 3.4 customer.refundHistory（L675-741）

```js
// 仅 requireStaffBound() + 字段校验，无 store_id / bound_store_id 过滤
// 暴露退款金额、原因、原单号、SKU 明细等敏感财务数据
```

### 3.5 customer.updateNotes（L914-933）

```js
// UPDATE client_wechat_users SET notes = $1 WHERE user_id = $2
// 缺陷：① 无 bound_store_id 守卫 ② 无 requireManager() ③ 无 operation_logs
```

### 3.6 customer.assign（L967-995）

```js
// 员工侧验证正确：SELECT WHERE employee_id = $1 AND store_id = $2
// 顾客侧无守卫：UPDATE SET bound_employee_id = $1 WHERE user_id = $2
// 缺陷：① 顾客 bound_store_id 未校验 ② 无 operation_logs
```

## 4 修复计划

### Phase 1：只读路由 scope 过滤（P0，M 量级）

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js`

1. 引入已有的 `buildStoreScopeCondition`（来自 `utils/scope.js`）

2. **detail**（L242-342）：SELECT 追加 scope 过滤
   - 门店模式：`AND bound_store_id = ${effectiveStoreId}`
   - 管理层模式：`AND bound_store_id = ANY(${scopeStoreIds})`
   - rowCount=0 返回 `PERMISSION_DENIED: 顾客不在当前门店范围内`

3. **calendar**（L146-237）：两个 SQL 均追加
   - `AND o.store_id = ${effectiveStoreId}`（门店模式）
   - `AND o.store_id = ANY(${scopeStoreIds})`（管理层模式）

4. **giftHistory**（L823-908）：giftItems 查询追加
   - `AND o.store_id` scope 条件，与 paidOrders 一致

5. **refundHistory**（L675-741）：追加
   - `AND o.store_id` scope 条件

### Phase 2：写入路由 scope 守卫 + 审计日志（P0，S 量级）

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js`

1. **updateNotes**（L914-933）：
   - UPDATE 追加 `AND bound_store_id = $3`（effectiveStoreId）
   - 添加 `requireManager()` 中间件
   - 写入 `operation_logs`（action='customer.updateNotes'）

2. **assign**（L967-995）：
   - UPDATE 前先查顾客 `bound_store_id`，校验 `IN scopeStoreIds`
   - UPDATE 追加 `AND bound_store_id = $3` 作为 CAS 守卫
   - rowCount=0 返回 `PERMISSION_DENIED: 顾客不在当前门店范围内`
   - 写入 `operation_logs`（action='customer.assign', detail 含原/新 employeeId）

### Phase 3：staff.performanceDetail scope 过滤（P0，S 量级）

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js`

1. 查询前校验目标员工 `store_id IN scopeStoreIds`
2. 或在查询 SQL 内追加 store scope 条件
3. 门店模式下仅能查看本门店员工业绩

### Phase 4：scope helper 抽取（P1，与 E4 epic 协同）

**目标**：统一 `assertCustomerInScope(ctx, boundStoreId)` / `assertEmployeeInScope(ctx, employeeId)` / `assertSaleOrderInScope(ctx, saleOrderId)` 到 `staffApi/utils/scope.js`，所有路由复用。

## 5 验收标准

- [ ] `customer.detail`：非 scope 内顾客返回 PERMISSION_DENIED，不返回 PII
- [ ] `customer.calendar`：仅返回 scope 内门店的消费日历
- [ ] `customer.giftHistory`：仅返回 scope 内门店的赠送记录
- [ ] `customer.refundHistory`：仅返回 scope 内门店的退款记录
- [ ] `customer.updateNotes`：仅 scope 内顾客可修改 + requireManager + 审计日志
- [ ] `customer.assign`：仅 scope 内顾客可分配 + bound_store_id CAS 守卫 + 审计日志
- [ ] `staff.performanceDetail`：仅返回 scope 内员工业绩，不泄露他店顾客 PII
- [ ] 管理层模式（loginLevel='management'）使用 scopeStoreIds ANY 过滤，功能正常
- [ ] 门店模式（loginLevel='store'）使用 effectiveStoreId 单值过滤，功能正常
- [ ] SQL 参数化查询（$1, $2），无拼接
- [ ] 无新增 operation_logs 写入异常

## 6 前置 / 关联

| 项 | 说明 |
|----|------|
| 前置 | 无 schema 变更（bound_store_id / store_id 列已存在） |
| 前置 | `utils/scope.js` 的 `buildStoreScopeCondition` 已存在，可直接复用 |
| 关联 | E4 scope 全覆盖 epic（SUMMARY §4.4） |
| 关联 | L1 helpers 层 `db/helpers/scope.ts`（admin 端 assertCustomerInScope 已有） |
| 关联 | P0-CC4-06 admin 撤销 admin 无保护（独立 ticket） |
| 参考 | `mgmt-customer.js` 已实现 assertCustomerInScope，可作为参照 |
