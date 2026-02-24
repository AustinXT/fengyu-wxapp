# 后端服务需求

> 技术栈：CloudBase 云函数（Node.js）+ Workfine SQL Server + PG 自托管数据库

---

## 一、技术架构

```
小程序（客户端 + 员工端）
    ↓
CloudBase 云函数（Node.js）
    ├── PG 自托管数据库（小程序专属数据）
    └── Workfine SQL Server DB（直连只读，mssql 驱动）
```

| 项 | 方案 |
|----|------|
| 前端 | 微信小程序（客户端 + 员工端，共两个小程序） |
| 后端 | CloudBase 云函数（Node.js） |
| 业务数据库 | Workfine SQL Server（直连只读） |
| 小程序数据库 | PG 自托管数据库 |
| SQL Server 驱动 | `mssql`（node-mssql）npm 包，云函数内直连 |
| 支付 | 微信支付多商户模式（特约商户）+ 线下付款标记 |
| 实时通信 | WebSocket 或小程序订阅消息 |
| 权限 | 基于角色的访问控制（店长/美容师），微信 openid 关联 |

---

## 二、Workfine 数据对接

### 连接信息

- **连接方式**：云函数通过 `mssql`（node-mssql）驱动直连 Workfine SQL Server，**仅读取**
- **服务器地址**：`111.229.31.128:1433`，数据库 `wkdb_20220804_86cd3292`，用户名 `Sa`，密码 `oHx#+Q`
- **重要**：Workfine 数据库所有表均为**只读**，小程序不直接写入 Workfine

### 数据库分工

| 数据 | 存储位置 | 读/写 | 说明 |
|------|---------|-------|------|
| 员工（姓名、职位、门店、部门、是否可分配业绩） | Workfine DB | 读 | 业务主数据，由甲方在 Workfine 维护 |
| 服务项目/产品（名称、价格、分类） | Workfine DB | 读 | 含原价（即开单价格），运行时实时从 Workfine 读取 |
| 组织架构（市场、部门、门店） | Workfine DB | 读 | 人事架构以 Workfine 为准 |
| 顾客档案（姓名、手机号、会员等级、主美容师等） | Workfine DB | 读 | 不建立 PG 实体；小程序通过 client_wechat_users 识别顾客身份，历史档案数据实时从 Workfine UDT_S_311 只读查询 |
| 销售单/订单 | PG 自托管数据库 | 读写 | 建立 PG 实体，参考 Workfine UDT_S_209 结构优化设计；Workfine 相关表仅供历史查阅 |
| 营业额分配记录 | PG 自托管数据库 | 读写 | 建立 PG 实体，参考 Workfine UDT_M_217 结构；Workfine 相关表仅供历史查阅 |
| 服务核销记录（护理单） | PG 自托管数据库 | 读写 | 建立 PG 实体，参考 Workfine UDT_S_259/UDT_S_762 结构；Workfine 相关表仅供历史查阅 |
| 微信用户（openid、session、手机号绑定） | PG 自托管数据库 | 读写 | 客户端与员工端各一张表（`client_wechat_users` / `staff_wechat_users`），两端 appid 不同，openid 相互独立 |
| SPU 商品元数据（product_spu） | PG 自托管数据库 | 读写 | 名称、封面图、描述、排序，由运营在控制台维护 |
| SKU↔WorkFine 映射（product_spu_sku_map） | PG 自托管数据库 | 读写 | SPU 与 WorkFine 疗程项目编号/商品编号的对应关系 |
| 实时推送状态 | PG 自托管数据库 | 读写 | WebSocket 连接与消息队列 |
| 操作日志 | PG 自托管数据库 | 写 | 小程序侧操作留痕 |

---

## 三、数据模型

| 实体 | 关键字段 |
|------|----------|
| 门店 | 名称、所属市场、地址、状态 |
| 员工 | 姓名、职位、所属门店、所属部门、是否可分配业绩 |
| 顾客（微信用户） | openid、绑定手机号、绑定门店（client_wechat_users） |
| SPU 商品 | spu_id、名称、品项分类（二级）、大分类（生美/非生美/院装产品）、产品类型（疗程卡/单品/院装产品）、封面图、描述、排序权重、是否上架 |
| SKU↔WorkFine 映射 | spu_id、workfine_item_id（疗程项目编号或商品编号）、workfine_source（UDT_M_1281 / UDT_M_1383 / UDT_M_341）、规格展示名、排序 |
| 订单 | 订单号、顾客、项目、金额、支付方式、支付状态、下单端、下单人、美容师、支付时间、线下确认人、线下确认时间 |
| 营业额分配 | 订单ID、员工、部门、分配金额 |
| 预约 | 顾客、美容师、时间、状态 |
| 服务单 | 订单ID、顾客、服务人、开始时间、完成时间、状态、扣减次数 |
| 操作日志 | 业务类型、业务ID、操作人、操作动作、时间、变更前后值 |
| 市场 | 名称、编号 |
| 部门 | 名称、所属市场/门店、类型 |

### 实体一：SPU 商品 & SKU 映射

#### product_spu（SPU 商品概念表，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `spu_id` | string | 主键，自生成 |
| `name` | string | 商品名称（如"蜜语生玑精华护理疗程"） |
| `category` | string | 品项分类（如"蜜语生玑"），对应 UDT_M_229.UDF_M_522；作为左侧选择器的一级导航节点 |
| `big_category` | enum | `生美` / `非生美`：服务项目类 SPU 的商品标签，来自 UDT_M_1281.UDF_M_17783 / UDT_M_1383.UDF_M_17784，展示在商品卡和详情页；`院装产品`：标识院装产品类 SPU（对应 UDT_M_341 数据源），用于区分核销逻辑 |
| `product_type` | enum | `疗程卡` / `单品` / `院装产品` |
| `cover_image` | string | 封面图 URL |
| `description` | string | 商品描述（选填） |
| `sort_order` | integer | 排序权重 |
| `is_active` | boolean | 是否上架 |

#### product_spu_sku_map（SPU↔WorkFine 映射表，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `spu_id` | string | 关联 product_spu.spu_id |
| `workfine_item_id` | string | WorkFine 中的疗程项目编号（UDT_M_1281/1383.UDF_M_14503）或商品编号（UDT_M_341.UDF_M_1870） |
| `workfine_source` | enum | `UDT_M_1281`（全国可售项目）/ `UDT_M_1383`（门店自定义）/ `UDT_M_341`（院装产品） |
| `sku_display_name` | string | 规格展示名（如"10次卡"、"285ml/瓶"） |
| `sort_order` | integer | 规格排序 |

> SKU 的价格、疗程服务次数等字段运行时从 WorkFine 实时读取，不存入 PG 自托管数据库。

---

### 实体二：订单（销售单）

#### orders（订单主表，对应 UDT_S_209）

| 字段 | 类型 | 说明 |
|------|------|------|
| `order_id` | string | 主键，系统自生成 |
| `order_no` | string | 销售单号，格式 `FY-XSD{YYMMDD}{序号}` |
| `status` | enum | 订单状态：`待支付` / `待确认收款` / `已支付` / `已完成` / `支付失败` / `已关闭` |
| `market_name` | string | 所属市场 |
| `store_name` | string | 所属门店 |
| `order_date` | date | 销售日期 |
| `performance_type` | string | 业绩类型（售后 / 售前一次 / 售前二次 / 老带新 / 线上美团首次） |
| `customer_source` | string | 顾客来源渠道 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（下单顾客的微信用户 ID） |
| `customer_name` | string | 顾客姓名（冗余存储） |
| `sale_type` | string | 销售类型（全额销售 / 回单销售） |
| `total_payment` | decimal | 收款合计 |
| `payment_method` | enum | 收款方式：`wechat`（微信支付）/ `offline`（线下收款）|
| `total_performance` | decimal | 本单业绩 |
| `dept_undistributed` | decimal | 美容部充公业绩（未分配给个人） |
| `debt_amount` | decimal | 本单欠款合计 |
| `promo_id` | string | 促销方案编号，关联 WorkFine `UDT_S_1459.UDF_S_17159` |
| `promo_name` | string | 促销方案名称（冗余） |
| `gift_coupon` | decimal | 本单赠送现金券金额 |
| `coupon_balance_snapshot` | decimal | 下单时顾客现金券余额快照 |
| `coupon_used` | decimal | 本单消耗现金券金额 |
| `is_locked` | string | 是否锁客 |
| `is_new_customer` | string | 是否为新客纳客 |
| `member_level_snapshot` | string | 下单时顾客会员等级快照 |
| `is_approved` | string | 是否需要审批 |
| `order_source` | enum | 下单端：`client`（客户端自助）/ `staff`（员工端开单） |
| `opened_by` | string | 开单人员工编号（员工端开单时填入，客户端自助下单时为 null） |
| `preferred_staff_wf_id` | string | 顾客指定美容师员工编号，关联 WorkFine `UDT_S_287.UDF_S_1147`（顾客未指定时为 null） |
| `paid_at` | timestamp | 支付完成时间 |
| `offline_confirmed_by` | string | 线下收款确认人员工编号 |
| `offline_confirmed_at` | timestamp | 线下收款确认时间 |
| `idempotency_key` | string | 幂等键，防重复开单 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

#### order_items（销售明细，对应 UDT_M_213）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `order_id` | string | 关联 `orders.order_id` |
| `item_flow_no` | string | 销售流水号，格式 `XSLSH-{YYYYMMDD}{序号}`（被护理单核销引用） |
| `product_type` | string | 产品类型（疗程卡 / 单品 / 自定义-疗程 / 自定义-单品） |
| `wf_item_id` | string | 疗程项目编号（UDT_M_1281/1383.UDF_M_14503）或商品编号（UDT_M_341.UDF_M_1870） |
| `category` | string | 品项分类 |
| `item_name` | string | 项目名称 |
| `unit` | string | 计量单位 |
| `session_count` | integer | 疗程服务次数（总次数） |
| `remaining_sessions` | integer | 剩余可用次数（每次护理核销后更新） |
| `unit_price` | decimal | 原价（标准售价） |
| `quantity` | decimal | 销售数量 |
| `unit_discount` | decimal | 单价优惠金额 |
| `sale_amount` | decimal | 销售金额（优惠后） |
| `receivable` | decimal | 应收金额 |
| `received` | decimal | 实收金额 |
| `paid_count` | integer | 已付款次数（分期） |
| `is_gift` | string | 是否赠送（是 / 否） |
| `expire_date` | date | 疗程卡到期日 |
| `unit_price_per_session` | decimal | 单次价格（实收 ÷ 服务次数） |
| `debt` | decimal | 顾客欠款（应收 - 实收） |
| `remark` | string | 备注 |

#### revenue_allocations（营业额分配，对应 UDT_M_217）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `order_id` | string | 关联 `orders.order_id` |
| `employee_id` | string | 员工编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |
| `employee_name` | string | 员工姓名 |
| `position_series` | string | 职位序列编码 |
| `position` | string | 职位名称 |
| `dept_name` | string | 职位所属部门（美容部 / 推广部等） |
| `dept_code` | string | 部门编码 |
| `allocation_ratio` | decimal | 占比（同部门多人时如 0.3；跨部门或单人时为 1.0） |
| `total_amount` | decimal | 该员工最终分配金额（等于 `revenue_allocation_items` 的 amount 之和） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间（重新分配时更新） |

> UNIQUE 约束：`(order_id, employee_id)`

#### revenue_allocation_items（业绩分类明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `allocation_id` | bigint | 关联 `revenue_allocations.id` |
| `performance_category` | string | 业绩分类名称（如 `眉眼`、`唇`、`祛斑点痣`、`单品`；可按业务扩展） |
| `amount` | decimal | 该分类的分配金额 |

> 新增业绩分类时只需插入新行，无需变更表结构。

---

### 实体三：护理单

#### service_orders（护理单主表，合并 UDT_S_762 售前 + UDT_S_259 售后）

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_order_id` | string | 主键，系统自生成 |
| `service_order_no` | string | 护理单编号，格式 `HLD-{YYMMDD}{序号}` |
| `service_type` | enum | 护理单类型：`售前` / `售后` |
| `status` | enum | 服务状态：`待服务` / `服务中` / `已完成` |
| `market_name` | string | 所属市场 |
| `store_name` | string | 所属门店 |
| `service_date` | date | 护理服务日期 |
| `customer_name` | string | 顾客姓名 |
| `customer_type` | string | 顾客类型（售前一次 / 售后 / 老带新 / 售前二次 / 线上/美团首次） |
| `service_duration` | string | 服务时长（分钟） |
| `is_card_counted` | string | 是否核算卡数（是 / 否） |
| `outreach_type` | string | 拓客类型 |
| `promoter` | string | 推广员 |
| `appointment_time` | datetime | 预约/到店时间（**售前专有**，售后为 null） |
| `remark` | string | 备注 |
| `category` | string | 护理分类 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（服务顾客的微信用户 ID） |
| `appointment_id` | string | 关联预约记录 `appointments.appointment_id`（无预约直接到店时为 null） |
| `customer_phone` | string | 顾客联系电话 |
| `staff_id` | string | 主服务人员编号 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

#### service_items（护理明细，合并 UDT_M_763 售前 + UDT_M_260 售后）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `service_order_id` | string | 关联 `service_orders.service_order_id` |
| `wf_item_id` | string | WorkFine 项目编号（仅作参考），核销关联通过 `flow_no` → `order_items.item_flow_no` 建立 |
| `item_name` | string | 护理项目名称 |
| `category` | string | 品项分类 |
| `flow_no` | string | 流水号（售后: `XSLSH-` 核销 `order_items.item_flow_no`；售前: `TKKLS-` 拓客卡体系） |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | string | 服务美容师编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |
| `employee_name` | string | 服务美容师姓名 |
| `position_series` | string | 职位序列（**售前专有**） |
| `employee_position` | string | 美容师职位 |
| `service_fee` | decimal | 服务费金额 |
| `item_count` | decimal | 项目数量 |
| `satisfaction` | string | 顾客满意度 |
| `consumption` | decimal | 本次消耗金额 |
| `unit_price` | decimal | 单次服务价格 |
| `is_gift` | string | 是否赠送（是 / 否） |
| `remaining_count` | decimal | 当前剩余可用次数 |
| `count_change` | decimal | 次数变化（**售前专有**，如 -2） |
| `expire_date` | date | 到期日 |

---

### 实体四：微信用户

> 两个小程序 appid 不同，同一微信用户在客户端与员工端的 openid 互相独立，因此拆为两张表，各自独立管理。

#### client_wechat_users（客户端微信用户，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 主键，系统自生成 |
| `openid` | string | 微信 openid（客户端 appid 下，唯一索引） |
| `session_key` | string | 微信 session_key（加密存储） |
| `phone` | string | 绑定手机号（明文，与 `customers.phone` 核对） |
| `bound_store_name` | string | 顾客端绑定的门店名（来自 UDT_M_219.UDF_M_438），初始 null，门店选择后填入 |
| `last_login_at` | timestamp | 最近一次登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

#### staff_wechat_users（员工端微信用户，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 主键，系统自生成 |
| `openid` | string | 微信 openid（员工端 appid 下，唯一索引） |
| `session_key` | string | 微信 session_key（加密存储） |
| `phone` | string | 绑定手机号（明文，与 WorkFine 员工手机核对） |
| `staff_wf_id` | string | 关联 WorkFine `UDT_S_287.UDF_S_1147`（根据手机号自动绑定员工档案后，可为 null） |
| `last_login_at` | timestamp | 最近一次登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

---

### 实体五：预约

#### appointments（预约，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `appointment_id` | string | 主键，系统自生成 |
| `status` | enum | 预约状态：`待确认` / `已确认` / `已完成` / `已取消` |
| `market_name` | string | 所属市场 |
| `store_name` | string | 所属门店 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（预约顾客的微信用户 ID） |
| `customer_name` | string | 顾客姓名（冗余存储） |
| `staff_wf_id` | string | 预约美容师编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |
| `staff_name` | string | 预约美容师姓名（冗余存储） |
| `appointment_time` | datetime | 预约到店时间 |
| `order_id` | string | 来源订单，关联 `orders.order_id` |
| `item_flow_no` | string | 销售流水号，关联 `order_items.item_flow_no`，指向具体疗程卡行 |
| `service_item` | string | 预约项目描述（自由文本） |
| `notes` | string | 备注 |
| `cancelled_reason` | string | 取消原因（已取消时填入） |
| `created_by` | string | 创建人员工编号（员工端创建）或 `customer`（顾客端自助） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

---

### 实体六：实时推送状态

#### push_events（实时推送事件队列，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `event_type` | string | 事件类型（`order_paid` / `service_started` / `service_completed` 等） |
| `biz_id` | string | 关联业务主键（如 `orders.order_id`） |
| `target_store` | string | 目标推送门店（员工端按门店订阅） |
| `payload` | jsonb | 推送负载（订单号、顾客名、金额等关键字段快照） |
| `status` | enum | 推送状态：`pending` / `sent` / `failed` |
| `retry_count` | integer | 已重试次数（失败后最多重试 3 次） |
| `sent_at` | timestamp | 成功推送时间（null 表示未送达） |
| `created_at` | timestamp | 事件创建时间 |

> 员工端 WebSocket 断开时，轮询兜底每 30 秒查询 `status = 'pending'` 事件，不依赖 WebSocket 连接状态。

---

### 实体七：操作日志

#### audit_logs（操作日志，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `biz_type` | string | 业务类型（`order` / `service_order` / `appointment` / `payment` / `customer` 等） |
| `biz_id` | string | 业务主键（如 `order_id` / `service_order_id`） |
| `operator_id` | string | 操作人员工编号，关联 WorkFine `UDT_S_287.UDF_S_1147`（顾客端操作记为 `customer:{openid}`） |
| `operator_name` | string | 操作人姓名（冗余存储） |
| `action` | string | 操作动作（`create` / `pay` / `confirm` / `cancel` / `complete` / `allocate` 等） |
| `before_value` | jsonb | 变更前值（首次创建时为 null） |
| `after_value` | jsonb | 变更后值（删除时为 null） |
| `ip_address` | string | 客户端 IP（可选，安全审计用） |
| `created_at` | timestamp | 操作时间 |

---

## 四、核心接口

| 接口 | 说明 |
|------|------|
| 用户认证 | 微信小程序登录、手机号绑定 |
| 门店 | 门店列表、门店详情、门店绑定 |
| 服务浏览 | 分类列表、项目列表、项目详情 |
| 美容师 | 列表、预约状态查询 |
| 下单 | 客户端下单、员工端开单、二维码生成 |
| 支付 | 微信支付、线下付款提交、店长确认线下收款 |
| 订单 | 订单列表、订单详情、订单状态更新 |
| 营业额分配 | 部门查询、可分配员工查询、分配提交 |
| 顾客档案 | 顾客信息、消费记录、日历数据 |
| 预约 | 创建预约、预约状态更新 |
| 服务单 | 创建服务单、开始服务、完成服务、核销次数 |
| 幂等控制 | 下单、支付回调、服务完成接口幂等校验 |
| 实时推送 | 订单进入已支付后即时通知员工端 |

---

## 五、实时通信

- 订单进入 `已支付` 后，员工端需**即时感知**并更新日历视图
- **技术方案**：WebSocket 或小程序消息订阅
- **兜底机制**：WebSocket 断开时，员工端每 30 秒轮询一次顾客日历数据；恢复连接后回到实时推送

---

## 六、组织架构

```
品牌总部
└── 市场（如南商市场）
    ├── 部门（美容部、推广部等）→ 直属于市场
    └── 门店
        ├── 门店经理（店长）→ 直属美容部
        └── 美容师
```

- 门店经理（店长）直属**美容部**
- 其他部门（推广部等）从门店所属**市场**查询
- 跨部门营业额分配时，各部门可各按实收金额分配

---

## 七、关键业务规则

1. 只有**店长（门店经理）**可开单，普通美容师无开单权限
2. **营业额分配**：同部门总额 ≤ 实收；跨部门各按实收金额分配（总额可达实收 2 倍）
3. **美容师选择非必须**：顾客下单时可不指定美容师
4. **技师不可见**客户真实电话号码
5. **日历入账口径**：仅 `已支付` 订单计入当日消费
6. **幂等要求**：下单、支付回调、服务完成三类接口必须幂等
7. **线下付款口径**（仅 MVP）：顾客端选择线下付款先进入 `待确认收款`，店长确认后才计为 `已支付`
8. 支付成功触发条件统一为**订单进入已支付**，而不是"仅创建订单成功"
9. 订单在员工端开单时即写入数据库（状态 `待支付`），客户扫码后无需重复创建
10. 订单关闭/支付失败时，对应的营业额分配记录一并标记为无效（可物理删除或加 `is_void` 标记）；重新付款不重新分配，由店长手动操作。

---

## 八、状态机

### 订单状态机

```text
待支付 -> 已支付 -> 已完成
待支付 -> 支付失败
待支付 -> 已关闭
待支付 -> 待确认收款 -> 已支付
```

- `已支付` 触发：微信支付回调成功，或店长确认线下收款成功
- `待确认收款`：仅用于顾客端选择线下付款后的中间状态
- 疗程卡订单：进入 `已支付` 后状态为"待服务"，每次服务核销后更新剩余次数
- 院装产品订单：进入 `已支付` 后可直接置为 `已完成`

### 服务单状态机

```text
待服务 -> 服务中 -> 已完成
```

- 只有店长或被分配的服务人员可推进状态
- 仅在 `服务中 -> 已完成` 时扣减 1 次，且剩余次数不得小于 0
- 重复点击"完成服务"时，后端按同一服务单 ID 幂等处理，不得重复扣次

### 预约状态机

```text
待确认 -> 已确认 -> 已完成（到店核销完成后自动流转）
待确认 -> 已取消
已确认 -> 已取消
```

---

## 九、异常场景最小闭环

| 场景 | 处理方式 |
|------|----------|
| 重复下单 | 返回同一订单号，不重复创建订单 |
| 重复支付回调 | 仅第一次成功回调生效，不重复入账日历 |
| 重复线下确认收款 | 仅第一次确认生效，不重复入账日历 |
| 网络抖动导致实时推送失败 | 轮询兜底后保证最终一致 |
| 并发核销 | 通过事务或行级锁保证同一疗程卡不会被超扣 |

---

## 十、MVP 验收标准

1. 订单进入 `已支付` 后，员工端顾客日历在 **5 秒内**出现当日消费标记
2. WebSocket 断开情况下，员工端在 **30 秒内**通过轮询看到同一笔消费
3. 同一笔订单无论重复提交多少次，在日历中仅计入一次
4. 同一服务单重复点击"完成服务"不产生重复扣次
5. 角色越权操作应被拒绝（美容师不可开单、技师不可查看完整手机号）
6. 小程序读取的员工、产品、组织架构数据与 Workfine 设计端一致
7. 小程序中完成开单后，PG 自托管数据库订单表中能查到同一笔记录
8. 小程序中完成营业额分配后，PG 自托管数据库营业额分配表中能查到分配明细
