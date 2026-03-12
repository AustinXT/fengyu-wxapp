# fengyu-wxapp - 现实约束文档

<meta>
  <document-id>fengyu-wxapp-real</document-id>
  <version>2.0.0</version>
  <project>fengyu-wxapp</project>
  <type>现实约束</type>
  <created>2026-02-25</created>
  <updated>2026-03-09</updated>
</meta>

本文档定义凤御微信小程序在开发过程中必须遵守的硬性约束。按电商核心风险排序：违反后果越严重的排越前。

<real>
- **疗程次数原子扣减（防超卖）**：核销时必须使用 `UPDATE order_items SET remaining_sessions = remaining_sessions - n WHERE item_flow_no = $1 AND remaining_sessions >= n`，通过 `rowCount = 0` 判断次数不足；禁止先 SELECT 后 UPDATE。这是本系统等价于"库存防超卖"的核心约束。
- **价格快照不可变**：开单时从 WorkFine 实时读取 SKU 价格并写入 `order_items.unit_price`；订单创建后任何后续价格变动不得影响已有订单金额。体验单由店长指定价格，同样写入后不可变。
- **支付幂等**：微信支付回调（payNotify）和线下确认收款（confirmOffline）必须幂等——已支付/已完成的订单重复触发时直接返回成功，不得重复入账、不得重复扣减次数、不得重复创建营业额分配。服务完成（service.complete）同理。
- **订单状态单向推进**：订单、服务单、预约的状态只能沿状态机单向流转；唯一例外：店长可将 `支付失败` 重置为 `待支付`（`requireManager` 权限）。禁止其他逆向修改。
- **角色权限中间件**：仅 `position === '门店经理'` 的员工可执行开单、确认收款、营业额分配、关闭订单等管理操作；美容师只能操作 `assigned_employee_id` 匹配自己的服务单和 `preferred_employee_id` 匹配自己的订单。所有权限由云函数中间件（`requireManager`/`requireStaffBound`）统一校验，不依赖前端传参。
- **门店数据隔离**：所有 PG 查询（订单/服务单/预约/分配）必须以 `ctx.auth.storeName` 作为过滤条件，顾客端以 `ctx.auth.userId` 过滤。禁止跨门店/跨用户访问数据。
- **待支付订单唯一**：同一顾客同一时间只能有一笔待支付订单，由部分唯一索引（`uq_orders_client_pending`、`uq_orders_phone_pending`）和应用层检查双重保障。
</real>
