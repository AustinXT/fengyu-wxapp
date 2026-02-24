# fengyu-wxapp - 现实约束文档

<meta>
  <document-id>fengyu-wxapp-real</document-id>
  <version>1.0.0</version>
  <project>fengyu-wxapp</project>
  <type>现实约束</type>
  <created>2026-02-25</created>
</meta>

本文档定义凤御微信小程序（客户端 + 员工端）在开发过程中必须遵守的硬性约束，聚焦于 AI 容易忽略、违反后会造成真实损害的关键规则。

<real>
- **Workfine 只读**：所有云函数对 Workfine SQL Server（111.229.31.128:1433, wkdb_20220804_86cd3292）的操作仅限 SELECT，严禁任何写入；Workfine 是甲方生产核心库，误写将破坏真实业务数据。
- **角色越权拦截**：仅 `staff_wf_id` 对应岗位为"门店经理"的员工可执行开单、确认收款、创建体验单、查看顾客完整手机号；美容师只能操作分配给自己（`assigned_staff_wf_id`）的服务单；所有权限校验由云函数中间件统一执行，不依赖前端传参。
- **疗程次数原子扣减**：核销时必须使用 `UPDATE order_items SET remaining_sessions = remaining_sessions - n WHERE item_flow_no = $1 AND remaining_sessions >= n`，通过 `rowCount = 0` 判断次数不足；禁止先 SELECT 后 UPDATE，防止并发超扣。
- **数据归属验证**：所有 PG 写操作（订单、预约、服务单）必须以当前登录用户的 `user_id` / `staff_wf_id` 作为过滤条件，顾客不得访问或修改他人数据。
- **支付与服务幂等**：支付回调（微信支付/线下确认）和"服务完成"接口必须幂等；重复触发不得重复写入日历消费记录，不得重复扣减次数。
- **状态机单向性**：订单、服务单、预约状态只能单向推进；唯一例外：店长可将`支付失败`手动重置为`待支付`（允许重新付款）；禁止其他逆向修改。
</real>
