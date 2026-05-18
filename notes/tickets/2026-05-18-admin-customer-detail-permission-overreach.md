# Ticket: admin /customers/[id] 顾客详情页权限越权（CSM 角色 ErrorBoundary）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（阻塞 customer_mgr 角色全部顾客详情操作；link-16 / 18 / 3 / 12 多条 e2e 被牵连）|
| 端 | fengyu-admin |
| 修复成本 | **S**（要么补权限、要么改 page.tsx 数据获取条件）|
| 来源 | 2026-05-17 README §1.B link-16 / 18 标注 "🔴 admin bug"；2026-05-18 e2e-chains 跑批复现 |
| 关联文件 | `src/app/(main)/customers/[id]/page.tsx`、`src/lib/permissions.ts`（PERMISSION_MATRIX）|

---

## 0 一句话

`customer_mgr` 角色（FY-TEST-CSM）进 `/customers/[id]` 时，page.tsx 无条件 fetch employees + stores，但 customer_mgr 没有 `employee:list` / `store:list` 权限 → `requirePermission` 抛错 → ErrorBoundary 顶替页面 → "顾客详情" 标题不可见。

---

## 1 复现证据

### 1.1 e2e log（5433 跑批，2026-05-18）

```
[browser-error] %s Error: PERMISSION_DENIED: 无权执行 employee:list
    at requirePermission (src/lib/permissions.ts:334:15)
    at eval (src/lib/with-permission.ts:33:76)
    at Page (src/app/(main)/customers/[id]/page.tsx)
[browser-error] [ErrorBoundary] Error: PERMISSION_DENIED: ...
```

下一秒：

```
%s Error: PERMISSION_DENIED: 无权执行 store:list
    at Page (src/app/(main)/customers/[id]/page.tsx)
```

### 1.2 涉及的 spec

| spec | 失败步骤 | 角色 |
|------|---------|------|
| link-16 | `/customers/[id]/edit` 前的顾客详情页找不到 "顾客详情" heading | FY-TEST-CSM |
| link-18 | 编辑顾客备注前的顾客详情页 ErrorBoundary | FY-TEST-CSM |
| link-3 B2 | `/services/create` 选预约后 employeeSelect 空值（同根因待确认）| FY-TEST-MGR（待复核）|
| link-12 | `/services/create` 顾客搜索找不到（同根因待确认）| FY-TEST-MGR（待复核）|

---

## 2 嫌疑根因（待你定）

### 方案 A：admin /customers/[id]/page.tsx 不该无条件 fetch employees + stores

→ 改成"如果当前 session 有 employee:list / store:list 就 fetch；没有就传空数组给 client 组件"。

**代价**：page.tsx 改 ~15 行，引入条件分支，client 组件需处理空数组 fallback。

**好处**：customer_mgr 角色不需要新权限；维持职责最小化原则。

### 方案 B：给 customer_mgr 角色加 employee:list + store:list

→ `src/lib/permissions.ts` PERMISSION_MATRIX 表更新 + cross-end 测试同步。

**代价**：扩大 customer_mgr 视野；可能违反"职责隔离"原则；要看产品同学是否同意 CSM 看到全员工列表。

**好处**：page.tsx 不动；其他依赖 employees / stores 的 customer 子页同享受。

### 方案 C：分两个权限——"employee:list" vs "employee:list_for_customer_assign"

→ 新增细粒度权限，CSM 只拿后者。

**代价**：权限粒度膨胀；ticket 复杂度上升。

**好处**：长期清爽。

---

## 3 决策点

请选一条（A / B / C），我按方案实施。

**我的建议**：**A** — 因为 customer_mgr 在顾客详情页只需要"顾客信息 + 操作历史"，员工 / 门店列表只在 "重新分配" 子弹窗才用得着；可以延迟加载或按需打开。最小爆炸半径。

---

## 4 关联引用

- `src/app/(main)/customers/[id]/page.tsx`
- `src/lib/permissions.ts`（PERMISSION_MATRIX）
- `src/lib/with-permission.ts`（HOF 入口拦截）
- `tests/e2e-chains/link-16-customer-promoter-snapshot.spec.ts`
- `tests/e2e-chains/link-18-operation-log-integrity.spec.ts`
