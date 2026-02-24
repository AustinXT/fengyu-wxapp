# fengyu-wxapp - 认知模型文档

<meta>
  <document-id>fengyu-wxapp-cog</document-id>
  <version>1.0.0</version>
  <project>fengyu-wxapp</project>
  <type>认知模型</type>
  <created>2026-02-25</created>
  <depends>real.md</depends>
</meta>

基于"智能体 + 信息 + 上下文"框架描述凤御微信小程序的核心概念模型。

---

<cog>
本系统包括以下关键实体：
- 微信用户：通过 openid 区分两端身份
  - 顾客（client_wechat_users）：客户端 appid，可自助下单/预约/查看服务进度
  - 员工（staff_wechat_users）：员工端 appid，角色分店长/美容师
- 订单：销售行为的完整记录，含主表（orders）和明细（order_items）
- 服务单：到店核销记录，含主表（service_orders）和明细（service_items）
- 预约：顾客提前预约到店时间，关联订单明细（order_items）
- SPU/SKU：商品概念层（product_spu）与 WorkFine 映射层（product_spu_sku_map）
- 营业额分配：订单级业绩归属记录（revenue_allocations + revenue_allocation_items）
- 员工档案（WorkFine 只读）：人事主数据，含职位/门店/是否可分配业绩
- 顾客档案（WorkFine 只读）：顾客历史数据，含主美容师字段
</cog>

<微信用户>
- 唯一编码：openid（各 appid 独立，同一微信在两端 openid 不同）；系统内部 user_id（UUID）
- 常见分类（by 角色）：顾客；店长；美容师
- 说明：两端用户表完全独立（client_wechat_users / staff_wechat_users），不共享 openid；员工通过手机号绑定 WorkFine staff_wf_id
</微信用户>

<订单>
- 唯一编码：order_no，格式 `FY-XSD-WX-{YYMMDD}{序号}`；订单明细 item_flow_no，格式 `XSLSH-WX-{YYYYMMDD}{序号}`（是核销锚点，被服务单和预约引用）
- 常见分类（by 类型）：正式；体验
- 常见分类（by 下单端）：client（顾客自助）；staff（员工开单）
- 常见分类（by 支付）：wechat；offline
- 常见分类（by 状态）：待支付；待确认收款；已支付；已完成；支付失败；已关闭
- 说明：员工开单时订单即写库（待支付），顾客扫码后使用同一笔订单付款，不重复创建
</订单>

<服务单>
- 唯一编码：service_order_no，格式 `HLD-WX-{YYMMDD}{序号}`
- 常见分类（by 状态）：待服务；服务中；已完成
- 说明：无 order_no 字段，与订单的关联完全通过 service_items.item_flow_no 实现；同一次到店可核销来自不同订单的项目；appointment_id 为可选关联
</服务单>

<预约>
- 唯一编码：appointment_id（UUID）
- 常见分类（by 状态）：待确认；已确认；已完成；已取消；已关闭
- 说明：每条预约绑定一个 item_flow_no（已购买的服务项），表示"预约核销哪一项"；次数归零时系统自动将待确认/已确认预约批量置为已关闭
</预约>

<SPU-SKU>
- 唯一编码：spu_id（UUID）；sku_id（UUID）；WorkFine 侧 workfine_item_id（疗程项目编号或商品编号）；workfine_source 枚举：UDT_M_1281（全国可售）/ UDT_M_1383（门店自定义）/ UDT_M_1460（促销方案项目子表）/ UDT_M_341（院装产品）
- 常见分类（by 产品类型）：疗程卡（session_count≥2，多次核销）；单品（session_count=1，一次核销）；院装产品（支付即完成，无核销）
- 常见分类（by 大分类）：生美；非生美；院装产品
- 说明：SKU 价格/次数运行时从 WorkFine 实时读取，不存 PG；SPU 展示状态由关联 SKU 的 is_active 派生
</SPU-SKU>

<营业额分配>
- 唯一编码：(order_no, employee_id) 联合唯一
- 常见分类（by 分配场景）：同部门（总额 ≤ 实收）；跨部门（各按实收，总额可达实收 2 倍）；自动分配（顾客指定美容师时支付成功自动创建）
- 说明：分配方案在顾客扫码后立即锁定，不可修改；订单关闭/失败时 is_void 置 true
</营业额分配>

<rel>
- 顾客-订单：1:N（一位顾客多笔订单，UNIQUE 约束限制同时只有一笔待支付）
- 订单-订单明细：1:N（一笔订单多个 SKU 明细）
- 订单明细-服务单明细：1:N（一个订单明细可被多次核销，每次对应一条 service_items）
- 订单-服务单：N:N（通过 service_items.item_flow_no 明细层关联；一张服务单可跨多笔订单核销，一笔订单可产生多张服务单）
- 订单明细-预约：1:N（通过 item_flow_no 关联，同一订单明细同时只能有一条有效预约）
- 服务单-预约：N:0..1（service_orders.appointment_id 可选，服务单可不依赖预约产生）
- 订单-营业额分配：1:N（一笔订单可分配给多名员工，但 order_no+employee_id 唯一）
- 员工-服务单：1:N（assigned_staff_wf_id，一名员工被分配多张服务单）
- SPU-SKU映射：1:N（一个 SPU 多个规格，UNIQUE (spu_id, workfine_item_id, workfine_source)）
</rel>
