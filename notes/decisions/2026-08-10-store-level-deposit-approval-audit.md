# 门店级寄存单审批权限排查

日期：2026-08-10

## 结论

门店级 `manager` 和 `finance` 已可在角色分配、权限矩阵与员工端管理功能中使用。Admin 寄存单审批另有一处遗留的总部/市场层级硬限制，导致拥有 `sale_order:deposit_approve` 的门店级经理或财务看不到审批入口，也无法通过 Server Action 审批。

## 命中项

- `fengyu-admin/src/lib/permissions.ts` 的 `isDepositOrderApprover()` 仅接受 `admin`，或总部/市场级 `manager` / `finance`。
- 订单详情页使用该 helper 决定是否显示寄存单“驳回 / 审批通过”按钮。
- `approveDepositOrder` 与 `rejectDepositOrder` 在服务端复用该 helper，因此不是单纯的前端显示问题。
- 对应单元测试将门店级经理判定为拒绝，未覆盖门店级财务。

## 未命中项

- `ROLE_SCOPE_TYPES` 已允许 `manager`、`finance` 绑定到总部、市场、门店。
- 员工端 `requireManager()` 已允许总部、市场、门店级店长。
- 客户端、员工云函数、数据库 schema 中未发现寄存单审批的同类层级限制。

## 修复边界

审批人扩展为绑定在总部、市场或门店节点的 `manager` / `finance`，仍要求拥有 `sale_order:deposit_approve`。审批通过和驳回继续使用 `isInScope(session, order.store_id)` 校验订单门店，门店级角色只能操作其授权范围内的订单；部门级异常绑定仍不得成为审批人。
