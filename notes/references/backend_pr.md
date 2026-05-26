# 后端服务需求

> 技术栈：CloudBase 云函数（Node.js）+ Workfine SQL Server + PG 自托管数据库
> **术语备注**：本文档中的「院装产品」对应 PG `product_type` enum 的 `'家居产品'`（2026-04-25 重命名）。文档为历史规范快照，未逐行替换。

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
- **服务器地址**：`47.96.87.33:1433`，数据库 `wkdb_20220804_86cd3292`
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
| 服务核销记录（护理单） | PG 自托管数据库 | 读写 | 建立 PG 实体，参考 Workfine UDT_S_259 结构；Workfine 相关表仅供历史查阅 |
| 微信用户（openid、session、手机号绑定） | PG 自托管数据库 | 读写 | 客户端与员工端各一张表（`client_wechat_users` / `staff_wechat_users`），两端 appid 不同，openid 相互独立 |
| SPU 商品元数据（product_spu） | PG 自托管数据库 | 读写 | 名称、封面图、描述、排序，由运营在控制台维护 |
| SKU↔WorkFine 映射（product_spu_sku_map） | PG 自托管数据库 | 读写 | SPU 与 WorkFine 疗程项目编号/商品编号的对应关系 |

---

## 三、数据模型

| 实体 | 关键字段 |
|------|----------|
| 门店 | 名称、所属市场、地址、状态 |
| 员工 | 姓名、职位、所属门店、所属部门、是否可分配业绩 |
| 顾客（微信用户） | openid、绑定手机号、绑定门店（client_wechat_users） |
| SPU 商品 | spu_id、名称、品项分类（二级）、大分类（生美/非生美/院装产品）、产品类型（疗程卡/单品/院装产品）、封面图、描述、排序权重、是否上架 |
| SKU↔WorkFine 映射 | sku_id（主键）、spu_id、workfine_item_id（疗程项目编号或商品编号）、workfine_source（UDT_M_1281 / UDT_M_1383 / UDT_M_341）、规格展示名、排序；UNIQUE(spu_id, workfine_item_id, workfine_source) |
| 订单 | 订单号、顾客、项目、金额、支付方式、支付状态、下单端、下单人、美容师、支付时间、线下确认人、线下确认时间 |
| 营业额分配 | 订单ID、员工、部门、分配金额 |
| 预约 | 顾客、美容师、时间、状态 |
| 服务单 | 顾客、服务人、开始时间、完成时间、状态、扣减次数（无 order_no，通过明细 item_flow_no 关联订单） |

### 实体一：SPU 商品 & SKU 映射

#### product_spu（SPU 商品概念表，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `spu_id` | string | 主键，UUID |
| `name` | string | 商品名称（如"蜜语生玑精华护理疗程"） |
| `category` | string | 品项分类（如"蜜语生玑"），对应 UDT_M_229.UDF_M_522；作为左侧选择器的一级导航节点 |
| `big_category` | enum | `生美` / `非生美`：服务项目类 SPU 的商品标签，来自 UDT_M_1281.UDF_M_17783 / UDT_M_1383.UDF_M_17784，展示在商品卡和详情页；`院装产品`：标识院装产品类 SPU（对应 UDT_M_341 数据源），用于区分核销逻辑 |
| `cover_image` | string | 封面图 URL |
| `description` | string | 商品描述（选填） |
| `sort_order` | integer | 排序权重 |

> SPU 是否在商品列表中展示由其关联的 SKU 决定：若所有 SKU 均 `is_active = false`，该 SPU 不对外展示；存在至少一个 `is_active = true` 的 SKU 时显示该 SPU。
>
> **左侧品项分类选择器查询逻辑**：分类列表从 `product_spu` 动态派生，不直接查询 WorkFine UDT_M_229；仅显示存在至少一个 `is_active = true` SKU 的分类，院装产品作为固定末尾节点单独追加。
>
> ```sql
> -- 左侧分类列表（有效 SPU 的去重分类，按分类最小 sort_order 排序）
> SELECT p.category, MIN(p.sort_order) AS category_order
> FROM product_spu p
> WHERE p.big_category != '院装产品'
>   AND EXISTS (
>     SELECT 1 FROM product_spu_sku_map m
>     WHERE m.spu_id = p.spu_id AND m.is_active = true
>   )
> GROUP BY p.category
> ORDER BY category_order ASC;
> -- 院装产品节点：WHERE big_category = '院装产品'，固定追加在末尾
> ```
>
> 分类顺序由该分类下 `sort_order` 最小的 SPU 决定；调整分类显示顺序时，修改该分类第一个 SPU 的 `sort_order` 即可，无需维护独立的分类排序表。

#### product_spu_sku_map（SPU↔WorkFine 映射表，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sku_id` | string | 主键，UUID |
| `spu_id` | string | 关联 product_spu.spu_id |
| `workfine_item_id` | string | WorkFine 中的疗程项目编号（UDT_M_1281/1383.UDF_M_14503）或商品编号（UDT_M_341.UDF_M_1870） |
| `workfine_source` | enum | `UDT_M_1281`（全国可售项目）/ `UDT_M_1383`（门店自定义）/ `UDT_M_1460`（促销方案项目子表）/ `UDT_M_341`（院装产品） |
| `product_type` | enum | `疗程卡` / `单品` / `院装产品`；决定核销流程：<br>- `疗程卡`：session_count 按合同次数（≥2），需多次到店核销，次数归零后完成<br>- `单品`：session_count = 1，需一次到店核销，服务完成后该行完成；到期日为支付日起一年（expire_date = paid_at + 1 year，支付回调成功后由系统写入）<br>- `院装产品`：支付后直接完成，不走到店服务流程（session_count = null） |
| `sku_display_name` | string | 规格展示名（如"10次卡"、"285ml/瓶"） |
| `sort_order` | integer | 规格排序 |
| `is_active` | boolean | 该 SKU 是否上架；SPU 展示状态由其所有 SKU 的 `is_active` 派生 |

> UNIQUE 约束：`(spu_id, workfine_item_id, workfine_source)`
>
> SKU 的价格、疗程服务次数等字段运行时从 WorkFine 实时读取，不存入 PG 自托管数据库。

---

### 实体二：订单（销售单）

> **设计说明：为何需要 `order_items`？**
> 一笔销售单可包含多个项目（疗程卡、单品、院装产品可混购），且疗程卡需要**独立追踪剩余次数与到期日**，并作为护理单核销的引用锚点（通过 `item_flow_no`）。因此明细必须以行级方式独立存储，不能压入主表字段。

#### orders（订单主表，对应 UDT_S_209）

| 字段 | 类型 | 说明 |
|------|------|------|
| `order_no` | string | 主键，销售单号，格式 `FY-XSD-WX-{YYMMDD}{序号}` |
| `status` | enum | 订单状态：`待支付` / `待确认收款` / `已支付` / `已完成` / `支付失败` / `已关闭` |
| `order_type` | enum | 订单类型：`正式`（价格来自 WorkFine，默认）/ `体验`（员工代创建，价格由店长自定义，用于首次体验/引流场景，支付流程与正式订单相同） |
| `market_name` | string | 所属市场（快照，防止组织架构调整影响历史单） |
| `store_name` | string | 所属门店（快照，同上） |
| `order_datetime` | datetime | 销售日期时间 |
| `client_user_id` | string \| null | 关联 `client_wechat_users.user_id`（下单顾客的微信用户 ID）；员工开单时若顾客尚未注册客户端小程序则为 null |
| `client_phone` | string \| null | 顾客手机号快照（员工开单时必填，作为 `client_user_id` 为 null 时的替代标识；顾客后续注册小程序绑定手机号后，系统通过此字段匹配补全 `client_user_id`） |
| `payment_method` | enum | 收款方式：`wechat`（微信支付）/ `offline`（线下收款）|
| `order_source` | enum | 下单端：`client`（客户端自助）/ `staff`（员工端开单） |
| `opened_by` | string | 开单人员工编号（员工端开单时填入，客户端自助时为 null） |
| `preferred_employee_id` | string | 顾客指定美容师员工编号，关联 WorkFine `UDT_S_287.UDF_S_1147`（未指定时为 null） |
| `paid_at` | timestamp | 支付完成时间 |
| `offline_confirmed_by` | string | 线下收款确认人员工编号 |
| `offline_confirmed_at` | timestamp | 线下收款确认时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> 部分唯一索引：`UNIQUE (client_user_id) WHERE status = '待支付' AND client_user_id IS NOT NULL`，同一顾客（已注册）同一时刻只能有一笔待支付订单。对于 `client_user_id` 为 null 的员工开单场景，在应用层按"同一门店 + 同一手机号"校验重复开单；建议同时在数据库层添加部分唯一索引作为兜底：`UNIQUE (client_phone, store_name) WHERE status = '待支付' AND client_user_id IS NULL`，防止并发下重复开单。

#### order_items（销售明细，对应 UDT_M_213）

| 字段 | 类型 | 说明 |
|------|------|------|
| `item_flow_no` | string | 主键，销售流水号，格式 `XSLSH-WX-{YYYYMMDD}{序号}`，被护理单 `service_items.item_flow_no` 引用作为核销锚点 |
| `order_no` | string | 关联 `orders.order_no` |
| `sku_id` | string \| null | 关联 `product_spu_sku_map.sku_id` |
| `session_count` | integer \| null | 疗程总次数：疗程卡按合同次数（≥2）；单品固定为 1；院装产品为 null |
| `remaining_sessions` | integer \| null | 剩余可用次数：疗程卡/单品适用（初始值等于 session_count）；院装产品为 null；每次护理核销时原子更新，不得低于 0 |
| `unit_price` | decimal | 原价（开单时从 WorkFine 读取并快照，防止后续价格变更影响历史单） |
| `quantity` | integer | 销售数量 |
| `unit_discount` | decimal | 单价优惠金额（无优惠时为 0） |
| `sale_amount` | decimal | 销售金额（优惠后；持久化原因：存在多种折扣组合，应用层计算后写入） |
| `receivable` | decimal | 应收金额 |
| `received` | decimal | 实收金额 |
| `expire_date` | date \| null | 到期日（**疗程卡及单品适用**，院装产品为 null；疗程卡：开单时写入合同约定到期日；单品：支付回调成功时由系统写入 paid_at + 1 year） |
| `remark` | string | 备注 |

#### revenue_allocations（营业额分配，对应 UDT_M_217）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `order_no` | string | 关联 `orders.order_no` |
| `employee_id` | string | 员工编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |
| `allocation_ratio` | decimal | 占比（同部门多人时如 0.3；跨部门或单人时为 1.0） |
| `total_amount` | decimal | 该员工最终分配金额（等于 `revenue_allocation_items` 的 amount 之和） |
| `is_void` | boolean | 是否已作废（订单关闭/支付失败时置 true），NOT NULL DEFAULT false |
| `voided_at` | timestamp | 作废时间（`is_void` 为 true 时填入） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间（重新分配时更新） |

> UNIQUE 约束：`(order_no, employee_id)`

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

#### service_orders（护理单主表，对应 Workfine UDT_S_259）

> 与订单的关联通过 `service_items.item_flow_no → order_items.item_flow_no` 实现，主表不存 `order_no`，支持同一次到店跨多笔订单核销。

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_order_no` | string | 主键，护理单编号，格式 `HLD-WX-{YYMMDD}{序号}` |
| `status` | enum | 服务状态：`待服务` / `服务中` / `已完成` |
| `market_name` | string | 所属市场（快照，与 orders 一致） |
| `store_name` | string | 所属门店（快照，与 orders 一致） |
| `service_date` | date | 护理服务日期 |
| `service_duration` | integer | 服务时长（分钟） |
| `assigned_employee_id` | string | 分配的主责服务人员编号，关联 WorkFine `UDT_S_287.UDF_S_1147`（用于服务单状态推进权限校验） |
| `remark` | string | 备注 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（服务顾客的微信用户 ID） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

#### service_items（护理明细，对应 Workfine UDT_M_260（统一护理明细））

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_item_id` | string | 主键，UUID，系统自生成 |
| `item_flow_no` | string | 外键，关联 `order_items.item_flow_no`（指向具体疗程卡行） |
| `service_order_no` | string | 关联 `service_orders.service_order_no` |
| `sku_id` | string | null | 关联 `product_spu_sku_map.sku_id` |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | string | 服务美容师编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |

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
| `employee_id` | string | 关联 WorkFine `UDT_S_287.UDF_S_1147`（根据手机号自动绑定员工档案后，可为 null） |
| `last_login_at` | timestamp | 最近一次登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

---

### 实体五：预约

#### appointments（预约，PG 自托管数据库）

| 字段 | 类型 | 说明 |
|------|------|------|
| `appointment_id` | string | 主键，系统自生成 |
| `status` | enum | 预约状态：`待确认` / `已确认` / `已完成` / `已取消` / `已关闭` |
| `market_name` | string | 所属市场 |
| `store_name` | string | 所属门店 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（预约顾客的微信用户 ID） |
| `customer_name` | string | 顾客姓名（冗余存储） |
| `employee_id` | string | 预约美容师编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |
| `staff_name` | string | 预约美容师姓名（冗余存储） |
| `appointment_time` | datetime | 预约到店时间 |
| `notes` | string | 备注 |
| `cancelled_reason` | string | 取消原因（已取消时填入） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

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

## 五、组织架构

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

## 六、权限与角色

| 角色 | 权限范围 |
|------|----------|
| 店长（门店经理） | 开单、确认线下收款、重置支付失败订单、查看/分配营业额、推进服务单状态、查看完整顾客手机号、创建体验单 |
| 美容师 | 查看自己负责的服务单、推进被分配给自己的服务单状态；**不可开单**、**不可查看完整手机号** |
| 顾客（客户端） | 自助下单、发起微信支付/选择线下付款、查看自己的订单与预约 |

- 权限校验以登录用户的 `employee_id` 在 WorkFine 中的职位/部门数据为依据，由云函数中间件统一拦截
- 服务单状态推进：仅**店长**或**`service_orders.assigned_employee_id` 匹配的服务人员**可操作

---

## 七、关键业务规则

1. 只有**店长（门店经理）**可开单，普通美容师无开单权限
2. **营业额分配**：同部门总额 ≤ 实收；跨部门各按实收金额分配（总额可达实收 2 倍）；**MVP 阶段不支持优惠/折扣，应收金额 = 实收金额**
3. **美容师选择非必须**：顾客下单时可不指定美容师
4. **日历入账口径**：仅 `已支付` 订单计入当日消费

> **混购完成规则**：订单包含多类项目时，`已完成` 以**所有疗程卡行与单品行的 remaining_sessions 全部归零**为触发条件；院装产品行支付即视为该行已交付，不参与完成条件判断。

5. **幂等要求**：支付回调、服务完成两类接口必须幂等；重复开单通过 `orders` 表部分唯一索引（`UNIQUE (client_user_id) WHERE status = '待支付'`）在数据库层拦截
6. **线下付款口径**（仅 MVP）：顾客端选择线下付款先进入 `待确认收款`，店长确认后才计为 `已支付`
7. 支付成功触发条件统一为**订单进入已支付**，而不是"仅创建订单成功"
8. 订单在员工端开单时即写入数据库（状态 `待支付`），客户扫码后无需重复创建
9. 订单关闭/支付失败时，对应的营业额分配记录一并标记为无效（`is_void = true`，记录 `voided_at`）；重新付款不重新分配，由店长手动操作。
10. **疗程卡并发扣减**：使用原子 UPDATE 而非显式行锁，格式为 `UPDATE order_items SET remaining_sessions = remaining_sessions - {n} WHERE item_flow_no = $1 AND remaining_sessions >= {n}`，通过检查 `rowCount` 是否为 1 判断扣减是否成功；`rowCount = 0` 时返回次数不足错误，不得在应用层先 SELECT 再 UPDATE。
11. **护理单来源约束**：护理单明细（`service_items`）中每条 `item_flow_no` 必须关联一条已支付订单的 `order_items` 行；约束在明细层执行，主表（`service_orders`）不存 `order_no`，允许同一次到店跨多笔订单核销。
12. **体验/引流服务**需先由店长创建体验单（`order_type = 体验`，价格由店长自定义），支付确认后再从该体验单创建护理单；体验单走与正式订单相同的支付流程和状态机。**先服务后付款不在 MVP 范围**：护理单必须在订单进入已支付后才可创建，不支持先到店服务后补单付款的场景。
13. **顾客端自助下单的营业额分配**：
   - 已指定美容师（`preferred_employee_id` 不为 null）：订单进入已支付时，系统自动以该美容师为唯一被分配人创建分配记录（`allocation_ratio = 1.0`，`total_amount = received`），无需店长手动操作；店长可在订单详情页查看分配结果
   - 未指定美容师（`preferred_employee_id` 为 null）：不创建分配记录，订单详情页不出现营业额分配入口
14. **营业额分配锁定规则**：分配记录在订单处于 `待支付` 且顾客尚未扫码（二维码显示状态为"待扫码"）时可被删除并重建（即"修改"）；顾客扫码后（二维码显示状态变为"已扫码待付款"或之后）分配方案立即锁定，不得修改；如需变更，须将订单置为 `已关闭` 并由店长重新开单。
15. **手机号补全机制**：顾客端小程序首次登录并完成手机号绑定时，系统查询 `orders` 表中 `client_phone = 绑定手机号 AND client_user_id IS NULL` 的记录，批量将 `client_user_id` 更新为当前用户的 `user_id`，使历史体验单（及正式订单）在顾客端可见。此操作在绑定手机号的云函数中同步执行。
16. **员工开单顾客身份验证**：员工端开单时，顾客手机号为**必填项**。系统在提交开单时通过手机号查询 `client_wechat_users.phone`：若已注册客户端，将对应 `user_id` 直接写入 `orders.client_user_id`，订单在顾客端立即可见；若未注册，`client_user_id` 为 null，待顾客完成手机号绑定后通过第 15 条补全机制自动关联。
17. **预约取消后可重新发起**：处于 `已取消` 状态的预约（顾客主动取消），顾客可重新发起新预约；`已关闭` 状态的预约（超期系统自动关闭）不可重新发起。

---

## 八、状态机

### 订单状态机

```text
待支付 → 已支付          （微信支付回调成功）
待支付 → 待确认收款      （顾客选择线下付款提交）
待支付 → 支付失败        （微信支付超时/失败）
待支付 → 已关闭          （手动关闭）
待确认收款 → 已支付      （店长确认线下收款）
支付失败 → 待支付        （店长手动重置，允许重新付款）
已支付 → 已完成          （疗程卡/单品：全部相关 order_items remaining_sessions 归零；院装产品：支付即完成）
```

- `已支付` 触发：微信支付回调成功，或店长确认线下收款成功
- `待确认收款`：仅用于顾客端选择线下付款后的中间状态
- `支付失败 → 待支付`：店长手动重置，使顾客可重新发起付款，对应第七节第 9 条
- 体验单（`order_type = 体验`）与正式订单走相同的支付流程和状态机

### 服务单状态机

```text
待服务 -> 服务中 -> 已完成
```

- 只有店长或被分配的服务人员可推进状态
- 仅在 `服务中 -> 已完成` 时扣减 session_used 次（疗程卡/单品均适用），且剩余次数不得小于 0
- 重复点击"完成服务"时，后端按同一服务单 ID 幂等处理，不得重复扣次

### 预约状态机

```text
待确认 -> 已确认 -> 已完成（到店核销完成后自动流转）
待确认 -> 已取消（顾客取消）
已确认 -> 已取消（顾客取消）
待确认 -> 已关闭（超过预约时间一天未到店，系统自动流转）
已确认 -> 已关闭（超过预约时间一天未到店，系统自动流转）
```

> `已关闭` 触发：定时任务每日检查 `appointment_time < NOW() - INTERVAL '1 day'` 且状态为 `待确认` 或 `已确认` 的预约，批量置为 `已关闭`。`已关闭` 预约不可重新发起；`已取消` 预约（顾客主动取消）可重新发起。

---

## 九、异常场景最小闭环

| 场景 | 处理方式 |
|------|----------|
| 重复下单 | 部分唯一索引拦截，返回错误提示，不重复创建订单 |
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
