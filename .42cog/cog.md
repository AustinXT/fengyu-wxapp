# fengyu-wxapp - 认知模型文档

<meta>
  <document-id>fengyu-wxapp-cog</document-id>
  <version>2.0.0</version>
  <project>fengyu-wxapp</project>
  <type>认知模型</type>
  <created>2026-02-25</created>
  <updated>2026-03-09</updated>
  <depends>real.md</depends>
</meta>

以"商品电商 + 后台管理"为主线描述凤御微信小程序的核心概念模型。实体按电商业务流排序：门店(组织) → 商品目录 → 订单交易 → 履约核销 → 用户身份 → 分账。

---

<cog>
本系统的核心业务流为：
  门店（组织归属）→ 商品目录（卖什么）→ 订单（交易记录）→ 履约/服务单（到店核销）→ 营业额分配（分账）
辅助流程：预约（到店时间协调）、门店解绑（组织变更）
核心角色：顾客（买方）、店长（卖方管理者）、美容师（卖方执行者）
</cog>

<门店>
- 组织架构的核心节点，所有业务数据以门店名为归属键
  - 唯一编码：门店名（WorkFine `UDT_M_219.UDF_M_438`），字符串外键贯穿所有业务表
  - 组织层级：品牌总部 → 市场（如南商市场）→ 门店
  - 部门：美容部、养生部、推广部、品项部（各有独立的营业额分配规则）
  - 数据源：WorkFine `UDT_M_219`（只读）；停业门店以 `UDF_M_11956 = '是'` 标识
  - 门店名在订单/服务单/预约中作为**快照字段**持久化（`store_name`），防止组织架构变更影响历史数据
  - 同时快照 `market_name`（市场名），用于区域级数据汇总
</门店>

<商品目录>
- **SPU（product_spu）**：商品概念层，如"蜜语生玑精华护理疗程"
  - 唯一编码：spu_id
  - 大分类（bigCategory）：`促销方案` | `护理项目` | `家居产品` | `充值卡`
  - 品项分类（category）：如"蜜语生玑"，作为商品列表左侧一级导航
  - 是否展示由关联 SKU 的 is_active 派生，无独立开关

- **SKU（product_spu_sku_map）**：规格 + WorkFine 映射层
  - 唯一编码：sku_id；WorkFine 侧 workfine_item_id + workfine_source 组合
  - workfine_source：`UDT_M_1281`（全国可售项目）| `UDT_M_1383`（门店自定义项目）| `UDT_M_1460`（促销方案项目）| `UDT_M_341`（院装产品）
  - 产品类型（productType）：`疗程卡`（session_count >= 2，多次核销）| `单品`（session_count = 1，一次核销）| `院装产品`（支付即完成，不走到店核销）
  - **价格不存 PG**：运行时从 WorkFine 实时读取，开单时快照到 order_items.unit_price
</商品目录>

<订单>
- **订单主表（orders）**：交易记录，一切后续流程的源头
  - 唯一编码：order_no，格式 `FY-XSD-WX-{YYMMDD}{4位序号}`（advisory lock 防并发）
  - 状态（orderStatus）：`待支付` → `待确认收款` → `已支付` → `已完成`；异常分支 `支付失败`（可由店长重置为 `待支付`）；终态 `已关闭`
  - 类型（orderType）：`正式`（WorkFine 价格）| `体验`（店长自定义价格）| `促销方案`（绑定方案 ID，项目自动填入不可增删）
  - 来源（orderSource）：`client`（顾客自助下单）| `staff`（员工开单 → 生成二维码 → 顾客扫码支付同一笔订单）
  - 支付方式（paymentMethod）：`wechat` | `alipay` | `offline`
  - 待支付订单唯一约束：已注册顾客全局唯一，未注册顾客按 (client_phone, store_name) 唯一

- **订单明细（order_items）**：SKU 维度的购买行，是核销锚点
  - 唯一编码：item_flow_no，格式 `XSLSH-WX-{YYYYMMDD}{4位序号}`
  - remaining_sessions：疗程卡的"库存"，原子递减防超卖
  - unit_price：下单时价格快照，不可变
  - 销售分类（salesCategory）：`自采自销` | `他销自耗` | `他销他耗` | `生态合作`

- **关键业务规则**：
  - 院装产品：支付即完成，无 session_count，不走服务单
  - 单品到期日：支付成功时写入 paid_at + 1 年
</订单>

<服务单>
- **服务单（service_orders）**：到店履约/核销记录
  - 唯一编码：service_order_no，格式 `HLD-WX-{YYMMDD}{4位序号}`
  - 状态（serviceOrderStatus）：`待服务` → `服务中` → `已完成`；可取消（`已取消`）
  - 关键特性：**无 order_no 字段**，与订单的关联完全通过 service_items.item_flow_no 实现
  - 跨订单核销：同一次到店服务可消费来自不同订单的项目（orders ↔ service_orders = N:N）
  - 次数扣减仅在"服务中 → 已完成"时执行，取消不扣次数

- **服务明细（service_items）**：核销行
  - item_flow_no → 关联 order_items（核销锚点）
  - session_used：本次划卡次数
  - 扣减后若 remaining_sessions = 0，自动关闭该 item_flow_no 关联的待确认/已确认预约
</服务单>

<用户>
- **顾客（client_wechat_users）**：
  - 唯一编码：user_id（UUID），openid（客户端 appid 下唯一）
  - phone：绑定手机号后与 WorkFine 顾客档案关联
  - bound_store_name：绑定门店
  - 手机号补全机制：员工以手机号开单 → 顾客后续注册绑定手机号 → 历史订单自动关联 client_user_id

- **员工（staff_wechat_users）**：
  - 唯一编码：user_id（UUID），openid（员工端 appid 下唯一）
  - staff_wf_id：绑定手机号后自动关联 WorkFine 员工档案
  - 角色从 WorkFine 实时查询：`门店经理`（店长）| 其他（美容师）
  - 两端 openid 完全独立（不同 appid），用户表不共享
</用户>

<营业额分配>
- **分配主表（revenue_allocations）**：订单级业绩归属
  - 唯一约束：(order_no, employee_id)
  - 时机：订单状态为"已支付"且 allocation_status = 'pending' 时，由店长操作分配
  - 可重新分配（覆盖式更新），allocation_status 从 'pending' → 'allocated'
  - 订单关闭/支付失败时 is_void = true

- **分配明细（revenue_allocation_items）**：按订单行 + 销售分类拆分
  - performance_category：销售分类（自采自销/他销自耗等）
  - commission_rate：提成比例快照

- **部门分配规则**：
  - 同部门：分配总额 <= 实收金额
  - 跨部门：各部门独立计算，总额可达实收 2 倍
  - 指定美容师自动分配：支付回调时自动创建 100% 分配给 preferred_staff_wf_id
</营业额分配>

<预约>
（辅助流程，类似电商的"预约送货时间"）
- 唯一编码：appointment_id（UUID）
- 状态：`待确认` → `已确认` → `已完成`；可取消（`已取消`）；超时/次数归零自动 `已关闭`
- 可选关联 item_flow_no（指定消费哪个订单行）
- checkin_at：到店签到时间（记录用，不改状态）
- 一条预约最多关联一张服务单
</预约>

<rel>
- 门店 → 员工：1:N（WorkFine UDF_S_1163 门店名关联）
- 门店 → 订单：1:N（orders.store_name 快照）
- 门店 → 服务单：1:N（service_orders.store_name 快照）
- SPU → SKU：1:N（一个商品多个规格，UNIQUE (spu_id, workfine_item_id, workfine_source)）
- 顾客 → 订单：1:N（UNIQUE 约束限制同时只有一笔待支付）
- 订单 → 订单明细：1:N（一笔订单多个 SKU 行）
- 订单明细 → 服务明细：1:N（一个 item_flow_no 可被多次核销，每次对应一条 service_items）
- 订单 ↔ 服务单：N:N（通过 service_items.item_flow_no 间接关联）
- 订单 → 营业额分配：1:N（order_no + employee_id 唯一）
- 分配 → 分配明细：1:N（按销售分类拆分）
- 员工 → 服务单：1:N（assigned_staff_wf_id）
- 预约 → 服务单：1:1（可选关联，appointment_id）
</rel>
