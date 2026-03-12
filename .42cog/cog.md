# fengyu-wxapp - 认知模型文档

<meta>
  <document-id>fengyu-wxapp-cog</document-id>
  <version>3.1.0</version>
  <project>fengyu-wxapp</project>
  <type>认知模型</type>
  <created>2026-02-25</created>
  <updated>2026-03-13</updated>
  <depends>real.md</depends>
</meta>

以"商品电商 + 后台管理"为主线描述凤御微信小程序的核心概念模型。实体按电商业务流排序：门店(组织) → 商品目录 → 订单交易 → 履约核销 → 用户身份 → 分账。

---

<cog>
本系统的核心业务流为：
  门店（组织归属）→ 商品目录（卖什么）→ 订单（交易记录）→ 履约/服务单（到店核销）→ 营业额分配（分账）
辅助流程：预约（到店时间协调）、门店解绑（组织变更）、操作日志（审计追踪）
核心角色：顾客（买方）、manager（经营管理）、finance（财务只读）、hr（员工管理）、product（商品管理）、staff（一线执行）
四种单据统一模型：销售单、回款单、转换单、退款单通过 `sale_order_type` 区分，回款/转换/退款通过 `ref_sale_order_id` 引用原销售单
</cog>

<门店>
- 组织架构的核心节点，所有业务数据以 `store_id` FK 为归属键
  - 唯一编码：`store_id`（UUID），`store_name` 作展示用唯一索引
  - 组织层级：`org_nodes` 邻接表层级树，品牌总部（headquarters）→ 市场（market）→ 门店（store）；部门（department）可挂在任意层级
  - 部门：美容部、养生部、推广部、品项部（各有独立的营业额分配规则）
  - 数据源：PG `org_nodes`（层级树）+ `stores`（门店详情，1:1 扩展 org_nodes type='store' 节点）；初始数据同步自 WorkFine，运行时 100% PG
  - 业务表（sale_orders/service_orders/appointments）通过 `store_id` FK 关联 `stores`
  - 市场名通过 JOIN `org_nodes` 树获取（stores.org_node_id → org_nodes.parent_id → market 节点），`market_name` 快照用于区域级数据汇总
  - 门店解绑流程：顾客发起解绑申请（`store_unbind_requests`，状态 pending → approved/rejected/cancelled）→ 店长审批 → approved 后清除 `client_wechat_users.bound_store_id`
  - 门店详情扩展字段：封面图、环境图、地理坐标（经纬度）、营业时间、停车信息等（由员工端手动维护）
</门店>

<商品目录>
- **商品主表（products）**：商品概念层，如"蜜语生玑精华护理疗程"
  - 唯一编码：product_id（UUID）
  - 商品类型（product_kind 枚举）：`福利活动` | `护理项目` | `家居产品` | `充值卡`
  - 品项分类（product_categories）：如"蜜语生玑"，作为商品列表左侧一级导航
  - 上下架由 `valid_start` / `valid_end` 日期控制，无独立开关
  - is_bundle：是否套餐（套餐的 SKU 是其组成部分）

- **商品规格（product_skus）**：规格 + 价格层，PG 自包含
  - 唯一编码：sku_id
  - 产品类型（product_type 枚举）：`疗程卡`（session_count >= 2，多次核销）| `单品`（session_count = 1，一次核销流程）| `院装产品`（支付即完成，不走到店核销）
  - **价格/次数/服务费直接存 PG**：运行时 100% 走 PG，开单时快照到 sale_items.unit_price
</商品目录>

<订单>
- **订单主表（sale_orders）**：交易记录，一切后续流程的源头
  - 唯一编码：sale_order_id，销售单格式 `FY-XSD-WX-{YYMMDD}{4位序号}`（advisory lock 防并发）；回款/转换/退款有独立前缀
  - 状态（status）：`待支付` → `待确认收款` → `已支付` → `已完成`；异常分支 `支付失败`（可由店长重置为 `待支付`）；终态 `已关闭`；退款专用 `待审批`
  - 类型（sale_order_type）：`普通` | `体验` | `内部` | `福利活动` | `回款` | `转换` | `退款`
  - 来源（sale_order_source）：`client`（顾客自助下单）| `staff`（员工开单 → 生成二维码 → 顾客扫码支付同一笔订单）
  - 支付方式（payment_method）：`wechat` | `alipay` | `offline`
  - 待支付订单唯一约束：已注册顾客全局唯一，未注册顾客按 (client_phone, store_id) 唯一
  - 四种单据统一模型：销售单、回款单、转换单、退款单通过 `sale_order_type` 区分，回款/转换/退款通过 `ref_sale_order_id` 引用原销售单
  - 10 分钟订单超时：`expire_at = created_at + 10min`，过期订单在 `order.list`/`order.create`/`order.pay` 时懒清理
  - 单号格式按类型区分前缀：销售 `FY-XSD-WX-`、回款 `FY-HKD-WX-`、转换 `FY-ABZH-WX-`、退款 `FY-TKD-WX-`

- **销售明细（sale_items）**：SKU 维度的购买行，是核销锚点
  - 唯一编码：sale_item_id，格式 `XSLSH-WX-{YYYYMMDD}{4位序号}`
  - remaining_sessions：疗程卡的"库存"，原子递减防超卖
  - unit_price：下单时价格快照，不可变
  - 销售分类（sales_category）：`自采自销` | `他销自耗` | `他销他耗` | `生态合作`
  - item_direction：行方向 `purchase`（默认）/ `convert_out` / `convert_in` / `refund_out`

- **关键业务规则**：
  - 院装产品：支付即完成，无 session_count，不走服务单
  - 单品：一次核销流程（session_count = 1）
  - 单品到期日：支付成功时写入 paid_at + 1 年
</订单>

<服务单>
- **服务单（service_orders）**：到店履约/核销记录
  - 唯一编码：service_order_id，格式 `HLD-WX-{YYMMDD}{4位序号}`
  - 状态（status）：`待服务` → `服务中` → `已完成`；可取消（`已取消`）
  - 关键特性：**无 sale_order_id 字段**，与订单的关联完全通过 service_items.sale_item_id 实现
  - 跨订单核销：同一次到店服务可消费来自不同订单的项目（sale_orders ↔ service_orders = N:N）
  - 次数扣减仅在"服务中 → 已完成"时执行，取消不扣次数

- **服务明细（service_items）**：核销行
  - sale_item_id → 关联 sale_items（核销锚点）
  - session_used：本次划卡次数
  - 扣减后若 remaining_sessions = 0，自动关闭该 sale_item_id 关联的待确认/已确认预约
</服务单>

<用户>
- **顾客（client_wechat_users）**：
  - 唯一编码：user_id，格式 `FYGK-{YYYYMMDD}{序号}`；openid（客户端 appid 下唯一，仅 WorkFine 同步创建的行为 null）
  - phone：绑定手机号后与顾客档案关联（合并行）
  - bound_store_id：FK → stores，顾客端主动绑定的门店
  - primary_beautician：所属美容师姓名（文本字段，非 FK）
  - 手机号补全机制：员工以手机号开单 → 顾客后续注册绑定手机号 → 历史订单自动关联 client_user_id

- **员工（staff_wechat_users）**：
  - 唯一编码：user_id（UUID），openid（员工端 appid 下唯一）
  - employee_id：绑定手机号后自动关联 PG employees 员工档案
  - 角色由 RBAC `permission_roles` 表决定（`employee_id + role + scope_id`），无记录时降级为 `role=staff, scope=员工所在门店`
  - 登录时聚合所有角色→ `ctx.auth.roles[]` + `scopeStoreIds` + `permissions.actions[]`，前端存储 `permissions` 控制 UI 可见性
  - 两端 openid 完全独立（不同 appid），用户表不共享
</用户>

<权限>
- **权限角色分配（permission_roles）**：RBAC + Scope 模型
  - 唯一编码：`(employee_id, role, scope_id) WHERE is_void = false`（部分唯一索引）
  - 5 角色：`manager`（经营管理）| `finance`（财务只读）| `hr`（员工管理）| `product`（商品管理）| `staff`（一线执行）
  - 3 域级别（scope_id FK → org_nodes）：`headquarters`（全局无过滤）| `market`（市场区域）| `store`（单门店）
  - 12 功能模块（`PERMISSION_MATRIX` 代码常量）：workbench / sale_order / allocation / service / appointment / customer / product / employee / finance / store / permission / sync
  - 一人多角色 + 一角色多域：同一员工可有多条记录
  - 软删除：`is_void = true` + `voided_at`，保留审计痕迹
  - 初始数据由同步脚本从 `employees.org_node_id` + `position_name` 自动推导；`hr`/`product` 角色仅手动分配
  - 提成比例矩阵（`commission_rate_matrix`）：org_id × order_type × role_type × sales_category × 金额阶段 → commission_rate
</权限>

<操作日志>
- **操作日志（operation_logs）**：审计追踪，只写不改
  - 记录关键变更：订单创建/收款/关闭、营业额分配、服务单全流程、预约确认/签到、权限变更
  - `action` 格式与云函数 action 路由一致（如 `sale_order.create`）
  - `detail` jsonb 存储变更前后数据
  - `operator_user_id` FK → `staff_wechat_users`（基于微信登录态）
</操作日志>

<营业额分配>
- **分配表（sale_allocations）**：sale_item 级业绩归属（单表，无明细子表）
  - 唯一约束：`UNIQUE(sale_item_id, employee_id) WHERE is_void = false`
  - 时机：订单状态为"已支付"且 allocation_status = 'pending' 时，由店长操作分配
  - 可重新分配（覆盖式更新），allocation_status 从 'pending' → 'allocated'
  - 订单关闭/支付失败时 is_void = true
  - 退款业绩 total_amount 为负数，转换/回款保持正数

- **部门分配规则**：
  - 同部门：分配总额 <= 实收金额
  - 跨部门：各部门独立计算，总额可达实收 N 倍
  - 指定美容师自动分配：支付回调时自动创建 100% 分配给 preferred_employee_id
</营业额分配>

<预约>
（辅助流程，类似电商的"预约送货时间"）
- 唯一编码：appointment_id（UUID）
- 状态：`待确认` → `已确认` → `已完成`；可取消（`已取消`）；超时/次数归零自动 `已关闭`
- 可选关联 sale_item_id（指定消费哪个订单行）
- checkin_at：到店签到时间（记录用，不改状态）
- 一条预约最多关联一张服务单
</预约>

<rel>
- org_nodes → stores：1:1（org_nodes type='store' ↔ stores.org_node_id）
- 门店 → 员工：1:N（employees.store_id FK → stores）
- 门店 → 订单：1:N（sale_orders.store_id FK → stores）
- 门店 → 服务单：1:N（service_orders.store_id FK → stores）
- 商品 → 规格：1:N（products.product_id ← product_skus.product_id）
- 顾客 → 订单：1:N（UNIQUE 约束限制同时只有一笔待支付）
- 订单 → 销售明细：1:N（一笔订单多个 SKU 行，sale_items.sale_order_id FK）
- 订单 → 订单：N:1（ref_sale_order_id，回款/转换/退款 → 原销售单）
- 销售明细 → 销售明细：N:1（ref_sale_item_id，convert_out/refund_out → 原购买行）
- 销售明细 → 服务明细：1:N（一个 sale_item_id 可被多次核销，每次对应一条 service_items）
- 订单 ↔ 服务单：N:N（通过 service_items.sale_item_id 间接关联）
- 销售明细 → 营业额分配：1:N（sale_allocations.sale_item_id FK，UNIQUE(sale_item_id, employee_id) WHERE is_void = false）
- 员工 → 权限角色：1:N（permission_roles.employee_id FK → employees）
- 权限角色 → 组织节点：N:1（permission_roles.scope_id FK → org_nodes.id）
- 员工 → 服务单：1:N（assigned_employee_id）
- 预约 → 服务单：1:1（可选关联，service_orders.appointment_id）
- 预约 → 销售明细：N:1（可选，appointments.sale_item_id FK → sale_items）
- 顾客 → 门店解绑申请：1:N（store_unbind_requests.user_id FK → client_wechat_users）
- 门店 → 门店解绑申请：1:N（store_unbind_requests.from_store_id FK → stores）
- 提成矩阵 → 组织节点：N:1（commission_rate_matrix.org_id FK → org_nodes.id，市场级别）
</rel>
