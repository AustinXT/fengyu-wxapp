# 凤御双美容院 — 后端服务产品需求规格书

> **文档版本**: 3.1.0
> **范围**: 后端服务
> **约束文档**: `.42cog/real.md` | `.42cog/cog.md`
> **日期**: 2026-03-11
>
> **运行时架构**: 所有业务查询 100% 走 PG，WorkFine SQL Server 不参与在线请求链路。WorkFine 迁移与同步方案见 `workfine-sync.spec.md`。

---

## 1. 概述

**定位**: 凤御双美容院微信小程序生态系统的统一后端服务层，为顾客端（C端）、员工端（B端）和管理后台提供 API 网关、业务逻辑、数据持久化和跨端协调。

**技术栈**:

| 项 | 方案 |
|----|------|
| 前端 | 微信小程序（客户端 + 员工端，共两个小程序） |
| 后端 | CloudBase 云函数（Node.js 18） |
| 数据库 | PostgreSQL 自托管（读写，全部业务数据） |
| 支付 | 微信支付多商户模式（特约商户）+ 线下付款标记 |
| 实时通信 | WebSocket 或小程序订阅消息 |
| 权限 | RBAC + Scope（5角色×3域×12模块），三层架构：employees（身份层）+ permission_roles（授权层）+ PERMISSION_MATRIX 代码常量（能力层），微信 openid 关联 |

---

## 2. 技术架构

```
小程序（客户端 + 员工端）
    ↓
CloudBase 云函数（Node.js）
    └── PG 自托管数据库（业务数据 + 全部实体）
```

**云函数网关模式**: 每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

| 云函数 | 端口 | envId |
|--------|------|-------|
| `clientApi` | 顾客端 | `cloud1-3gpht4b01ff88838` |
| `staffApi` | 员工端 | `cloud1-9g3ydpg512eecc99` |
| `payNotify` | 支付回调 | 同 clientApi |

---

## 3. 数据实体总览

| # | 数据域 | PG 表 | 数据来源 | 说明 |
|---|--------|-------|----------|------|
| 1 | 组织架构 | `org_nodes` | 同步自 WorkFine | 层级树（总部/市场/门店/部门），邻接表 |
| 2 | 门店详情 | `stores` | 同步自 WorkFine | 门店业务信息，1:1 扩展 org_nodes type='store' 节点 |
| 3 | 员工信息 | `employees` | 同步自 WorkFine | 角色判定、营业额分配使用 PG |
| 4 | 品项分类 | `product_categories` | PG 读写 | 初始导入后员工手动管理 |
| 5 | 商品 | `products` | PG 读写 | 初始导入后员工日常维护 |
| 6 | 商品规格 | `product_skus` | PG 读写 | 价格/次数自包含 |
| 7 | 提成比例矩阵 | `commission_rate_matrix` | 同步自 WorkFine | — |
| 8 | 订单/销售明细 | `sale_orders` / `sale_items` | PG 读写 | 覆盖销售单、回款单、转换单、退款单四种单据 |
| 9 | 营业额分配 | `sale_allocations` | PG 读写 | 退款业绩为负数，转换/回款保持正数 |
| 10 | 护理单/核销 | `service_orders` / `service_items` | PG 读写 | — |
| 11 | 顾客（含微信用户） | `client_wechat_users` | PG 读写 + 同步自 WorkFine | 微信身份 + 顾客档案合一 |
| 12 | 员工端微信用户 | `staff_wechat_users` | PG 读写 | 员工端独立 |
| 13 | 预约 | `appointments` | PG 读写 | — |
| 14 | 权限角色分配 | `permission_roles` | PG 读写 | — |
| 15 | 操作日志 | `operation_logs` | PG 写入 | 审计追踪，记录后台关键变更 |
| 16 | 门店解绑申请 | `store_unbind_requests` | PG 读写 | 顾客申请解绑门店，店长审批 |

> 同步机制详见 `workfine-sync.spec.md`。

---

## 4. 数据模型

### 4.1 org_nodes（组织架构树）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | text | 主键，UUID |
| `name` | text | 节点名称，NOT NULL |
| `type` | org_node_type enum | `headquarters` / `market` / `store` / `department`，NOT NULL |
| `parent_id` | text \| null | FK → `org_nodes.id`（NULL = 根节点） |
| `sort_order` | integer | 排序序号，NOT NULL DEFAULT 0 |
| `is_active` | boolean | 是否启用，NOT NULL DEFAULT true |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **约束**:
> - `UNIQUE(parent_id, name)` — 同级不重名
> - `INDEX(type)` — 按类型筛选
> - `INDEX(parent_id)` — 子节点查询
>
> **层级约束**（应用层校验）:
>
> | 节点类型 | parent 必须是 |
> |----------|--------------|
> | headquarters | NULL（根节点，仅一个） |
> | market | headquarters |
> | store | market |
> | department | headquarters / market / store（不能挂在 department 下） |
>
> **关键设计**:
> - 纯粹的组织架构树（邻接表），与门店业务详情分离
> - `department` 可挂在任意层级（总部/市场/门店），而非扁平关联
> - 父节点名称通过 JOIN `parent_id` 获取，不冗余存储
> - `permission_roles.scope_id` → FK `org_nodes.id`，替代原 `stores.scope_level` 方案

### 4.2 stores（门店详情）

| 字段 | 类型 | 说明 |
|------|------|------|
| `store_id` | text | 主键，UUID |
| `store_name` | text | 门店名称（唯一索引），展示用；业务表通过 `store_id` FK 关联 |
| `org_node_id` | text \| null | FK → `org_nodes.id`（关联 type='store' 的节点） |
| `opening_date` | date \| null | 开业时间 |
| `bed_count` | integer \| null | 可用床位数 |
| `is_closed` | boolean | 是否停止营业，NOT NULL DEFAULT false |
| `cover_image` | text \| null | 门头封面图 URL |
| `images` | text[] \| null | 店内环境图 URL 数组 |
| `district` | text \| null | 省市区（如"江西省南昌市青山湖区"） |
| `street_address` | text \| null | 街道门牌号（如"北京东路999号"） |
| `latitude` | numeric(10,7) \| null | 纬度 |
| `longitude` | numeric(10,7) \| null | 经度 |
| `phone` | text \| null | 联系电话 |
| `business_hours` | text \| null | 营业时间（如 "09:00-21:00"） |
| `description` | text \| null | 门店简介 |
| `announcement` | text \| null | 门店公告（临时通知） |
| `parking_info` | text \| null | 停车/交通信息 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `INDEX(org_node_id)`
>
> 业务表（sale_orders、service_orders、appointments 等）通过 `store_id` FK 关联 stores，市场名称通过 JOIN `org_nodes` 树获取（stores.org_node_id → org_nodes.parent_id → market 节点）。
>
> **顾客向字段**（`cover_image` ~ `parking_info`）：
> - 由员工端手动维护，不参与 WorkFine 同步
> - 图片 URL 指向 CloudBase 云存储（`cloud://` 协议或 CDN 地址）
> - 经纬度用于 `wx.openLocation` 地图展示和客户端距离排序（Haversine 公式，无需 PostGIS）
> - `district` + `street_address` 拼接为完整地址展示
>
> **与 org_nodes 的关系**: stores 是 org_nodes（type='store'）的 1:1 扩展表，stores 持有 FK 指向 org_nodes。org_nodes 表达层级关系，stores 存储门店业务详情。

### 4.3 employees（员工）

| 字段 | 类型 | 说明 |
|------|------|------|
| `employee_id` | varchar(30) | 主键，员工编号（格式 `FY-{YYMMDD}{序号}`） |
| `name` | varchar(50) | 姓名 |
| `gender` | varchar(20) \| null | 性别 |
| `phone` | varchar(20) \| null | 手机号码 |
| `id_card` | varchar(200) \| null | 身份证号码（AES-256-GCM 加密存储，密钥存环境变量，写入时加密，读取时解密） |
| `store_id` | text \| null | FK → `stores.store_id`（同步时通过 store_name 匹配写入） |
| `org_node_id` | text \| null | FK → `org_nodes.id`（指向 type='department' 的部门节点） |
| `position_name` | varchar(50) \| null | 工作职位（如"门店经理"、"美容师"） |
| `birthday` | date \| null | 出生日期 |
| `skills` | text[] \| null | 技能标签数组（如 ['美容师','推广', '养生师']） |
| `is_resigned` | boolean | 是否离职，NOT NULL DEFAULT false |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间（同步时更新，兼作新鲜度判断） |

> **索引**: `INDEX(store_id, is_resigned)`, `INDEX(phone)`
>
> **store_id**: 同步脚本读取 WorkFine UDF_S_1163（所属分院），通过 `store_name` 查找 PG stores 表得到 `store_id` 写入。`market_name` 不再冗余存储于 employees，需要时通过 JOIN stores 获取。
>
> **org_node_id**: 同步脚本读取 WorkFine UDF_S_1513（职能部门），查找 `org_nodes`（type='department'）匹配后写入 `org_node_id`。部门名称和父节点名称通过 JOIN `org_nodes` 获取，不冗余存储。
>
> **id_card**（UDF_S_1154）：高敏 PII 字段，AES-256-GCM 加密存储，密钥存环境变量，写入时加密，读取时解密。
>
> **角色判定**: 查询 `permission_roles` 表（JOIN `org_nodes` ON `scope_id`），获取所有 `role` + `scope` 组合（一人可有多条记录）。无 `permission_roles` 记录时降级为 `role=staff, scope=员工所在门店`（通过 `employees.store_id` 关联 `stores`）。详见 §6.7。
>
> **FK 引用汇总**: `sale_orders.opened_by`、`sale_orders.preferred_employee_id`、`service_orders.assigned_employee_id`、`sale_allocations.employee_id`、`service_items.employee_id`、`appointments.employee_id`、`staff_wechat_users.employee_id`、`store_unbind_requests.reviewed_by` 均引用 `employees.employee_id`。

### 4.4 product_categories（品项分类）

| 字段 | 类型 | 说明 |
|------|------|------|
| `category_id` | text | 主键，UUID |
| `category_name` | text | 分类名（如"蜜语生玑"、"科颜美"），**不唯一** |
| `product_kind` | product_kind enum | 所属商品类型：`福利活动` / `护理项目` / `家居产品` / `充值卡` |
| `sort_order` | integer | 排序序号 |
| `is_valid` | boolean | 是否有效，NOT NULL DEFAULT true |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> `category_name` 不设唯一约束，允许不同 `product_kind` 下同名分类。

### 4.5 products（商品主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_id` | text | 主键，UUID |
| `category_id` | text | FK → `product_categories.category_id` |
| `name` | text | 商品名称 |
| `cover_image` | text | 封面图 URL |
| `detail_images` | text[] | 详情图片 URL 列表（PostgreSQL 数组） |
| `description` | text | 商品描述 |
| `is_shengmei` | boolean \| null | 是否生美（护理项目使用，其他为 null） |
| `is_bundle` | boolean | 是否套餐（套餐的 SKU 是其组成部分），NOT NULL DEFAULT false |
| `price` | numeric(10,2) | 标价/原价（is_bundle=true 时 = Σ(product_skus.price)；否则 = min(product_skus.price)。展示用标价，交易以 SKU 价格为准） |
| `special_price` | numeric(10,2) \| null | 特价/促销价（null=无特价） |
| `sales_category` | sales_category enum | 销售分类（自采自销 / 他销自耗 / 他销他耗 / 生态合作） |
| `manage_scope` | text \| null | 管理范围（null=总部管理；值为门店/市场标识，限定谁可编辑此商品） |
| `market_scope` | text \| null | 可见范围（null=全部可见；值为门店/市场标识，限定谁可看到/购买此商品） |
| `sort_order` | integer | 排序权重 |
| `valid_start` | date \| null | 有效期开始（null=立即生效） |
| `valid_end` | date \| null | 有效期结束（null=永久有效） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **关键设计决策**:
> - `valid_start` + `valid_end` 替代 `is_active`，通过日期控制上下架
> - `is_bundle=true` 时，其关联的 `product_skus` 记录是套餐组成部分
> - `price` + `special_price` 在商品层提供标价和特价
> - `manage_scope` 表示谁可管理此商品
> - `market_scope` 门店/市场级可见性限制
> - `sales_category` 在商品层（非 SKU 层）
> - `detail_images` 用 PostgreSQL text 数组存储多张详情图
>
> **有效期叠加规则**: `products.valid_start/valid_end` 控制整个商品的上下架；`product_skus.valid_start/valid_end` 控制单个规格的上下架。查询时**两层同时校验**：商品有效 AND 规格有效才展示。任一层过期即不可购买。

### 4.6 product_skus（商品规格）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sku_id` | text | 主键，保留现有 sku_id 值确保 FK 连续 |
| `product_id` | text | FK → `products.product_id` |
| `product_type` | product_type enum | 疗程卡 / 单品 / 院装产品；决定核销流程 |
| `spec_name` | text | 规格名（如"10次卡"、"285ml/瓶"、"单次体验"） |
| `price` | numeric(10,2) | 标价/零售价（套餐组件中为 0 表示赠品），**开单时快照到 sale_items.unit_price** |
| `special_price` | numeric(10,2) \| null | 会员价（null=无会员价） |
| `session_count` | integer \| null | 疗程次数：疗程卡≥2，单品=1，院装产品=null |
| `is_bundle_sku` | boolean | 是否为套餐的组成部分，NOT NULL DEFAULT false |
| `sort_order` | integer | 排序序号 |
| `service_fee` | numeric(10,2) | 手工费，NOT NULL DEFAULT 0 |
| `valid_start` | date \| null | 有效期开始（null=立即生效） |
| `valid_end` | date \| null | 有效期结束（null=永久有效） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `(product_id)`
>
> **核心设计**:
> - 价格、次数、服务费、提成比例**直接存在 SKU 表中**，运行时无外部查询
> - `special_price` 支持 SKU 级别的促销/特价
> - 套餐赠品：`price = 0` 即为赠品
> - 套餐总价 = 所有 `is_bundle_sku=true` 的 SKU 的 `price` 之和
> - 产品类型 = `疗程卡` → 进入核销流程（session_count >= 2）；`单品` → 一次核销（session_count = 1）；`院装产品` → 支付即结束（session_count = null）
>
> **CHECK 约束**:
> - `CHECK(price >= 0)`
> - `CHECK(service_fee >= 0)`
> - `CHECK(session_count IS NULL OR session_count >= 1)`
>
> **FK 引用**: `sale_items.sku_id` → `product_skus.sku_id`
>
> **套餐示例**:
> ```
> products: { product_id: 'P001', name: '春季焕肤套餐', is_bundle: true }
>   └─ product_skus:
>        { sku_id: 'S001', spec_name: '蜜语生玑 10次卡', price: 1999, is_bundle_sku: true }
>        { sku_id: 'S002', spec_name: '科颜美精华 单次', price: 0, is_bundle_sku: true }  ← 赠品
> ```

### 4.7 commission_rate_matrix（提成比例矩阵）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial | 主键，自增 |
| `org_id` | text | FK → `org_nodes.id`（市场节点），市场名称通过 JOIN org_nodes 获取 |
| `order_type` | varchar(20) | 类型，"sale"、"service" |
| `role_type` | varchar(20) | 角色分类，"技师"、"推广" |
| `sales_category` | varchar(20) | 销售分类（如"自采自销"、"他销自耗"、"他销他耗"、"生态合作"） |
| `amount_tier_min` | numeric(10,2) | 金额阶段下限（含） |
| `amount_tier_max` | numeric(10,2) \| null | 金额阶段上限（不含；null 表示无上限） |
| `commission_rate` | numeric(5,4) | 提成比例（如 0.08 = 8%） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> UNIQUE 约束：`(org_id, order_type, role_type,sales_category, amount_tier_min)`

### 4.8 sale_orders（订单主表）

> **设计说明：为何需要 `sale_items`？**
> 一笔销售单可包含多个项目（疗程卡、单品、院装产品可混购），且疗程卡需要**独立追踪剩余次数与到期日**，并作为护理单核销的引用锚点。
>
> **四种单据统一模型**：sale_orders + sale_items + sale_allocations 覆盖**销售单、回款单、转换单、退款单**四种业务单据，通过 `sale_order_type` 区分。回款/转换/退款单通过 `ref_sale_order_id` 引用原销售单。

| 字段 | 类型 | 说明 |
|------|------|------|
| `sale_order_id` | varchar(30) | 主键，单号格式见下表 |
| `status` | enum | 订单状态：`待支付` / `待确认收款` / `已支付` / `已完成` / `支付失败` / `已关闭` / `待审批`（退款审批用） |
| `sale_order_type` | enum | 订单类型：`普通` / `体验` / `内部` / `福利活动` / `回款` / `转换` / `退款` |
| `ref_sale_order_id` | varchar(30) \| null | FK → `sale_orders.sale_order_id`；回款/转换/退款引用的原销售单，销售单为 null |
| `market_name` | varchar(100) | 所属市场（快照） |
| `store_id` | text | FK → `stores.store_id`，NOT NULL |
| `sale_order_datetime` | timestamp | 销售日期时间 |
| `client_user_id` | text \| null | FK → `client_wechat_users.user_id`；员工开单时通过手机号匹配填入，顾客无记录则为 null |
| `client_phone` | varchar(20) \| null | 顾客手机号快照；员工开单时必填 |
| `customer_name` | varchar(50) \| null | 顾客姓名快照 |
| `total_amount` | numeric(10,2) | 订单总金额（= Σ sale_items.received）；**退款为负数**，转换=补差价，回款=本次回款金额，NOT NULL |
| `payment_method` | enum | `wechat` / `alipay` / `offline`（回款支付方式与销售单一致） |
| `sale_order_source` | enum | `client`（客户端自助）/ `staff`（员工端开单）；回款/转换/退款仅 `staff` |
| `opened_by` | varchar(30) \| null | 开单人员工编号，FK → `employees.employee_id` |
| `preferred_employee_id` | varchar(30) \| null | 顾客指定美容师，FK → `employees.employee_id` |
| `paid_at` | timestamp | 支付完成时间 |
| `wechat_transaction_id` | varchar(64) \| null | 微信支付流水号（唯一索引） |
| `alipay_transaction_id` | varchar(64) \| null | 支付宝交易号（唯一索引） |
| `offline_confirmed_by` | varchar(30) \| null | 线下收款确认人员工编号，FK → `employees.employee_id` |
| `offline_confirmed_at` | timestamp | 线下收款确认时间 |
| `allocation_status` | allocation_status enum \| null | 提成分配状态：null → `pending` → `allocated` |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **单号格式表**：
>
> | sale_order_type | 前缀 | 示例 |
> |-----------------|------|------|
> | 普通/体验/内部/福利活动 | `FY-XSD-WX-` | `FY-XSD-WX-260313-0001` |
> | 回款 | `FY-HKD-WX-` | `FY-HKD-WX-260313-0001` |
> | 转换 | `FY-ABZH-WX-` | `FY-ABZH-WX-260313-0001` |
> | 退款 | `FY-TKD-WX-` | `FY-TKD-WX-260313-0001` |
>
> **索引与约束**：
> - `UNIQUE (client_user_id) WHERE status = '待支付' AND client_user_id IS NOT NULL`
> - `UNIQUE (client_phone, store_id) WHERE status = '待支付' AND client_user_id IS NULL`
> - `INDEX(store_id, status)` — 按门店+状态查询
> - `INDEX(ref_sale_order_id)` — 回款/转换/退款关联查询

### 4.9 sale_items（销售明细）

> **复用说明**：sale_items 同时用于销售、回款、转换、退款四种单据的明细行。`item_direction` 标识行的方向语义：
> - `purchase`（默认）：正常购买行
> - `convert_out`：转换退出行，`quantity` = 退次数，`received` = 负退消耗金额
> - `convert_in`：转换转入行，创建新的 sale_item（新疗程卡/商品）
> - `refund_out`：退款退出行，`quantity` = 退次数，`received` = 负退消耗金额

| 字段 | 类型 | 说明 |
|------|------|------|
| `sale_item_id` | varchar(30) | 主键，销售流水号，格式 `XSLSH-WX-{YYYYMMDD}{序号}` |
| `sale_order_id` | varchar(30) | FK → `sale_orders.sale_order_id`，NOT NULL |
| `item_direction` | enum | 行方向：`purchase`（默认）/ `convert_out` / `convert_in` / `refund_out` |
| `ref_sale_item_id` | varchar(30) \| null | FK → `sale_items.sale_item_id`；convert_out/refund_out 引用原购买行，其他为 null |
| `sku_id` | text \| null | FK → `product_skus.sku_id` |
| `session_count` | integer \| null | 疗程总次数：疗程卡≥2，单品=1，院装产品=null |
| `remaining_sessions` | integer \| null | 剩余可用次数；原子递减防超卖 |
| `unit_price` | numeric(10,2) | 原价快照（开单时持久化） |
| `quantity` | integer | 销售数量（convert_out/refund_out 行为退次数） |
| `unit_real_price` | numeric(10,2) | 优惠后单价金额 |
| `sale_amount` | numeric(10,2) | 优惠后销售金额 |
| `received` | numeric(10,2) | 实收金额（convert_out/refund_out 行为负数） |
| `expire_date` | date \| null | 到期日（疗程卡/单品适用，院装产品为 null） |
| `remark` | text | 备注 |
| `sales_category` | enum \| null | 销售分类：`自采自销` / `他销自耗` / `他销他耗` / `生态合作` |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `INDEX(sale_order_id)`, `INDEX(sku_id)`, `INDEX(ref_sale_item_id)`
>
> **CHECK 约束**:
> - `CHECK(unit_price >= 0)`
> - `CHECK(unit_real_price >= 0)`
> - `CHECK(remaining_sessions IS NULL OR remaining_sessions >= 0)`
> - `CHECK(quantity > 0)`
> - 注：`sale_amount` 和 `received` 允许负值（退款/转换退出行）

### 4.10 sale_allocations（营业额分配）

> **多单据复用**：sale_allocations 同时用于销售、回款、转换、退款四种单据的业绩分配。**退款业绩 `total_amount` 为负数**，转换/回款业绩保持正数。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `sale_item_id` | varchar(30) | FK → `sale_items.sale_item_id`，NOT NULL |
| `employee_id` | varchar(30) | 员工编号，FK → `employees.employee_id` |
| `allocation_ratio` | numeric(5,2) | 提成比例快照 |
| `total_amount` | numeric(10,2) | 该员工最终分配金额（退款为负数） |
| `is_void` | boolean | 是否已作废，NOT NULL DEFAULT false |
| `voided_at` | timestamp | 作废时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **约束**: `UNIQUE(sale_item_id, employee_id) WHERE is_void = false`（部分唯一索引，作废后可重新分配）
>
> **索引**: `INDEX(employee_id)`

### 4.11 service_orders（护理单主表）

> 与订单的关联通过 `service_items.sale_item_id → sale_items.sale_item_id` 实现，主表不存 `sale_order_id`，支持同一次到店跨多笔订单核销。

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_order_id` | varchar(30) | 主键，格式 `HLD-WX-{YYMMDD}{序号}` |
| `status` | enum | `待服务` / `服务中` / `已完成` / `已取消` |
| `market_name` | varchar(100) | 所属市场（快照） |
| `store_id` | text | FK → `stores.store_id`，NOT NULL |
| `service_date` | date | 护理服务日期 |
| `assigned_employee_id` | varchar(30) | 主责服务人员，FK → `employees.employee_id` |
| `remark` | text | 备注 |
| `appointment_id` | text \| null | FK → `appointments.appointment_id` |
| `client_user_id` | text \| null | FK → `client_wechat_users.user_id` |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `INDEX(store_id, service_date)`, `INDEX(assigned_employee_id)`, `INDEX(client_user_id)`

### 4.12 service_items（护理明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_item_id` | text | 主键，UUID |
| `sale_item_id` | varchar(30) | FK → `sale_items.sale_item_id`（核销锚点），NOT NULL |
| `unit_real_price` | numeric(10,2) | sale_items.unit_real_price 快照 |
| `service_order_id` | varchar(30) | FK → `service_orders.service_order_id`，NOT NULL |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | varchar(30) | 服务美容师，FK → `employees.employee_id` |
| `service_duration` | integer | 服务时长（分钟） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `INDEX(service_order_id)`

### 4.13 client_wechat_users（顾客 / 客户端微信用户）

> **合并说明**: 原 `customers`（WorkFine 同步顾客档案）与 `client_wechat_users`（微信用户身份）合并为单表。行可由 (a) 微信登录创建，或 (b) WorkFine 同步创建。通过 `phone` 匹配合并行。

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | text | 主键，格式 `FYGK-{YYYYMMDD}{序号}`；微信登录或 WorkFine 同步均按此格式生成 |
| `openid` | varchar(64) \| null | 微信 openid（客户端 appid 下，唯一索引）；仅 WorkFine 同步创建的行为 null |
| `session_key` | varchar(128) \| null | 微信 session_key |
| `phone` | varchar(20) \| null | 手机号码（唯一索引）；微信登录后绑定，或 WorkFine 同步写入 |
| `name` | varchar(50) \| null | 顾客姓名（同步写入或手动维护） |
| `store_id` | text \| null | FK → `stores.store_id`（同步时通过 store_name 匹配写入） |
| `bound_store_id` | text \| null | FK → `stores.store_id`（顾客端主动绑定的门店） |
| `primary_beautician` | varchar(50) \| null | 所属美容师姓名（营业额分配默认人员） |
| `member_level` | varchar(20) \| null | 会员等级（普通 / VIP 等） |
| `customer_source` | varchar(50) \| null | 顾客来源（售前 / 拓客 / 推荐等） |
| `category` | varchar(50) \| null | 顾客分类 |
| `birthday` | date \| null | 生日 |
| `occupation` | varchar(50) \| null | 职业 |
| `is_married` | boolean \| null | 是否已婚 |
| `wechat_name` | varchar(50) \| null | 微信名 |
| `registered_at` | date \| null | 首次登记时间（WorkFine 同步） |
| `skin_type` | varchar(50) \| null | 肤质类型 |
| `improvement_focus` | varchar(200) \| null | 改善重点 |
| `skin_issue` | varchar(200) \| null | 皮肤问题 |
| `wellness_preference` | varchar(200) \| null | 接受养生方式 |
| `last_login_at` | timestamp \| null | 最近登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间（同步时更新，兼作新鲜度判断） |

> **字段分层**:
> - **Layer 1 — 微信身份**: `user_id`, `openid`, `session_key`, `phone`, `last_login_at`
> - **Layer 2 — WorkFine 档案**: `name`, `registered_at`
> - **Layer 3 — 组织归属**: `store_id`（FK → stores），`bound_store_id`（FK → stores），`primary_beautician`
> - **Layer 4 — 会员与分类**: `member_level`, `customer_source`, `category`
> - **Layer 5 — 个人档案**: `birthday`, `occupation`, `is_married`, `wechat_name`
> - **Layer 6 — 美容档案**: `skin_type`, `improvement_focus`, `skin_issue`, `wellness_preference`
>
> **索引**: `UNIQUE(openid) WHERE openid IS NOT NULL`、`UNIQUE(phone) WHERE phone IS NOT NULL`、`INDEX(store_id)`、`INDEX(bound_store_id)`
>
> **store_id vs bound_store_id**: `store_id` 来自 WorkFine 同步（顾客归属门店），`bound_store_id` 是顾客在小程序中主动绑定的门店。两者可不同。市场名称通过 `bound_store_id` JOIN stores → org_nodes 树获取。
>
> **行创建与合并**:
> - **微信登录创建**：生成 `user_id`（格式 `FYGK-{YYYYMMDD}{序号}`），填充 `openid`，其余为 null
> - **WorkFine 同步创建**：生成 `user_id`（同格式），填充 `name`、`phone` 等档案字段，`openid = null`
> - **合并时机**：微信用户绑定手机号时，若 `phone` 匹配到已有同步行，则将微信身份字段（`openid`、`session_key`）写入该行，原微信登录行删除（或合并）
> - 并非所有顾客都会注册小程序（`openid = null`），也非所有小程序用户都有 WorkFine 档案（仅有微信登录创建的行无档案字段）

### 4.14 staff_wechat_users（员工端微信用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | text | 主键，系统自生成 |
| `openid` | varchar(64) | 微信 openid（员工端 appid 下，唯一索引） |
| `session_key` | varchar(128) | 微信 session_key |
| `phone` | varchar(20) \| null | 绑定手机号（绑定前为 null） |
| `employee_id` | varchar(30) \| null | FK → `employees.employee_id`（手机号自动匹配后填入） |
| `last_login_at` | timestamp | 最近登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `UNIQUE(openid)`, `INDEX(phone)`, `UNIQUE(employee_id) WHERE employee_id IS NOT NULL`

### 4.15 appointments（预约）

| 字段 | 类型 | 说明 |
|------|------|------|
| `appointment_id` | text | 主键，系统自生成 |
| `status` | enum | `待确认` / `已确认` / `已完成` / `已取消` / `已关闭` |
| `market_name` | varchar(100) | 所属市场（快照） |
| `store_id` | text | FK → `stores.store_id`，NOT NULL |
| `client_user_id` | text | FK → `client_wechat_users.user_id`，NOT NULL |
| `customer_name` | varchar(50) | 顾客姓名（冗余存储） |
| `employee_id` | varchar(30) | 预约美容师，FK → `employees.employee_id` |
| `employee_name` | varchar(50) | 美容师姓名（冗余存储） |
| `sale_item_id` | varchar(30) \| null | FK → `sale_items.sale_item_id`（可选） |
| `appointment_time` | timestamp | 预约到店时间 |
| `checkin_at` | timestamp \| null | 到店签到时间（不改状态） |
| `notes` | text | 备注 |
| `cancelled_reason` | text | 取消原因 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `INDEX(store_id)`, `INDEX(client_user_id)`, `INDEX(employee_id, appointment_time)`

### 4.16 permission_roles（权限角色分配）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial | 主键，自增 |
| `employee_id` | varchar(30) NOT NULL | 员工编号，FK → `employees.employee_id` |
| `role` | text NOT NULL | 角色：`manager` / `finance` / `hr` / `product` / `staff` |
| `scope_id` | text NOT NULL | FK → `org_nodes.id`（指向 headquarters/market/store 级别的节点） |
| `created_at` | timestamp | NOT NULL DEFAULT now() |
| `updated_at` | timestamp | NOT NULL DEFAULT now() |
| `is_void` | boolean | 软删除标记，NOT NULL DEFAULT false |
| `voided_at` | timestamp \| null | 作废时间 |
| `created_by` | text \| null | 创建者（同步脚本标记 `'sync'`，手动标记操作人员工编号） |
| `updated_by` | text \| null | 最后修改者 |

> **约束**:
> - `UNIQUE(employee_id, role, scope_id) WHERE is_void = false`（部分唯一索引，同人同角色同域不重复）
> - `FK(employee_id)` → `employees(employee_id)`
> - `FK(scope_id)` → `org_nodes(id)`
>
> **一人多角色 + 一角色多域**:
> - 同一员工可同时拥有多个角色（如 manager + hr），每个角色一条记录
> - 同一角色可分配到多个域（如 manager 同时管两家门店），每个 scope_id 一条记录
> - 示例：员工 E1 同时管理南昌A店和南昌B店 → 两条记录 `(E1, manager, store_A_id)` + `(E1, manager, store_B_id)`
>
> **数据量**: ~2000+ 行（在职员工各至少一行，多角色/多域员工有多行）
>
> **初始数据**: 同步脚本遍历 `employees`（`is_resigned = false`），根据 `org_node_id`（JOIN `org_nodes.name`）+ `position_name` 规则自动推导，详见 §6.10 同步推导规则。`hr` 和 `product` 角色不参与自动推导，仅通过管理后台手动分配。
>
> **默认降级**: 详见 §6.6。
>
> **软删除**: `is_void = true` 的记录不参与权限查询。手动撤销权限时标记 `is_void = true` + `voided_at` 而非物理删除，保留审计痕迹。同步脚本不覆盖 `created_by != 'sync'` 的手动分配记录。

### 4.17 operation_logs（操作日志）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial | 主键，自增 |
| `operator_user_id` | text | 操作人，FK → `staff_wechat_users.user_id`，NOT NULL |
| `operator_name` | text | 操作人姓名快照，NOT NULL |
| `operator_role` | text \| null | 操作人角色快照（`manager` / `finance` / `hr` / `product` / `staff`，多角色时取最高权限角色） |
| `org_node_id` | text \| null | 操作人所属组织节点，FK → `org_nodes.id` |
| `org_node_name` | text \| null | 操作人所属组织节点名称快照 |
| `action` | text | 操作动作，格式 `module.method`（如 `sale_order.create`、`service.complete`），NOT NULL |
| `target_type` | text | 目标实体类型（`sale_order` / `sale_item` / `appointment` / `service_order` 等），NOT NULL |
| `target_id` | text | 目标实体主键（如 sale_order_id、appointment_id），NOT NULL |
| `detail` | jsonb \| null | 操作详情，存放变更前后数据、备注等结构化信息 |
| `source` | text \| null | 来源云函数：`staffApi` / `clientApi` |
| `created_at` | timestamp | 记录创建时间，NOT NULL DEFAULT now() |

> **设计说明**:
> - 只写不改：日志表仅 INSERT，不支持 UPDATE / DELETE
> - `action` 格式与云函数 action 路由一致，便于关联和检索
> - `detail` 使用 jsonb 存储，结构由各操作自行定义（如 `{ before: {...}, after: {...}, reason: "..." }`）
> - `operator_user_id` 关联 `staff_wechat_users`（而非 `employees`），因为操作发生时用户身份基于微信登录态
> - 无 `updated_at`，日志不可修改
>
> **索引**:
> - `idx_op_logs_operator` ON `(operator_user_id)` — 按操作人查询
> - `idx_op_logs_target` ON `(target_type, target_id)` — 按目标实体查询变更历史
> - `idx_op_logs_action` ON `(action)` — 按操作类型筛选
> - `idx_op_logs_created_at` ON `(created_at)` — 按时间范围查询
>
> **记录时机**（关键变更操作）:
> - 订单：创建、确认线下收款、关闭、重置支付失败
> - 营业额分配：保存、删除
> - 服务单：创建、开始服务、完成服务、取消
> - 预约：确认、签到
> - 权限：角色变更

### 4.18 store_unbind_requests（门店解绑申请）

| 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | text | 主键，系统自生成 |
| `user_id` | text | 申请人 `client_wechat_users.user_id`，NOT NULL |
| `from_store_id` | text | 原绑定门店，FK → `stores.store_id`，NOT NULL |
| `status` | enum | `pending` / `approved` / `rejected` / `cancelled`，NOT NULL DEFAULT `pending` |
| `note` | text \| null | 申请备注 |
| `reviewed_by` | varchar(30) \| null | 审批人，FK → `employees.employee_id` |
| `reviewed_at` | timestamp \| null | 审批时间 |
| `reject_reason` | text \| null | 拒绝原因 |
| `created_at` | timestamp | 记录创建时间，NOT NULL DEFAULT now() |
| `updated_at` | timestamp | 记录更新时间，NOT NULL DEFAULT now() |

> **业务说明**:
> - 顾客在客户端发起门店解绑申请，店长在员工端审批
> - `approved` 后由应用层清除 `client_wechat_users.bound_store_id`
> - `cancelled` 表示顾客主动撤销申请

---

## 5. 组织架构

组织架构为**矩阵结构**，每个员工同时归属两个维度：

### 5.1 地理线（org_nodes 树 + stores 扩展）

```
品牌总部 ──────────── org_nodes (type='headquarters', parent_id=NULL)
├── 南昌市场 ──────── org_nodes (type='market')
│   ├── 南昌A店 ──── org_nodes (type='store') ←→ stores (org_node_id)
│   ├── 南昌B店 ──── org_nodes (type='store') ←→ stores (org_node_id)
│   └── ...
├── 南商市场 ──────── org_nodes (type='market')
│   └── ...
└── ...（~20 个市场，~100 家门店）

部门可挂在任意层级：
├── 总部 → 财智部 ─── org_nodes (type='department', parent=总部)
├── 南昌市场 → 市场管理中心 ─── org_nodes (type='department', parent=南昌市场)
└── 南昌A店 → 美容部 ─── org_nodes (type='department', parent=南昌A店)
```

### 5.2 职能线（部门 × 职位）

```
部门（employees.org_node_id → org_nodes(type='department')）
├── 美容部 → 门店经理、美容师、实习美容师 …
├── 推广部 → 推广经理、推广师 …
├── 养生部 → 养生师 …
├── 财智部 → 财务主管、会计 …
├── 市场管理中心 → 市场总监、片区经理 …
└── ...
```

### 5.3 矩阵交叉

- 每个员工在 `employees` 表中有 `store_id`（地理归属，FK → stores）和 `org_node_id` + `position_name`（职能归属，org_node_id FK → org_nodes type='department'）
- 权限由 `permission_roles` 表决定：`role`（能做什么）× `scope_id`（看到哪些数据，FK → org_nodes）
- 域类型与 org_nodes 节点类型关系：
  - `headquarters`：总部人员 → 全局数据
  - `market`：市场管理中心人员 → 该市场下所有门店数据
  - `store`：门店人员 → 仅本门店数据
- 跨部门营业额分配时，各部门可各按实收金额分配

---

## 6. 权限与角色（RBAC + Scope）

### 6.1 核心模型（三层架构）

权限 = **Role**（功能角色）× **Scope**（物理域）× **Module**（功能模块）

三层架构（同 AWS IAM / K8s RBAC 行业最佳实践）：

| 层级 | 载体 | 职责 | 变更方式 |
|------|------|------|----------|
| **身份层** | `employees` 表 | "这人是谁" — WorkFine 同步 | 同步脚本 |
| **授权层** | `permission_roles` 表 | "谁有什么角色" — 应用管理 | API / 同步推导 |
| **能力层** | `PERMISSION_MATRIX` 代码常量 | "角色能做什么" — 5角色 × 12模块 | 代码发布 |

> FK 方向：`permission_roles.employee_id → employees.employee_id`（标准一对多，FK 在"多"侧）。一人可有多条 permission_roles 记录（一人多角色 + 一角色多域）。
>
> 顾客（客户端）不属于 RBAC 体系，其权限仍为：自助下单、发起微信支付/选择线下付款、查看自己的订单与预约。

### 6.2 角色定义

| 角色 | 标识 | 典型人员 | 核心能力 |
|------|------|----------|----------|
| 经理 | `manager` | 门店经理、市场总监、片区经理 | 开单、确认收款、营业额分配、服务单全流程、完整顾客数据、触发同步、scope 内权限分配 |
| 财务 | `finance` | 财智部人员 | 财务看板、订单只读、营业额查看、完整顾客数据；**不可**开单/操作服务单 |
| 人事 | `hr` | 人事行政人员 | 员工管理（增删改查）、scope 内权限分配、门店管理、完整顾客数据；**不可**开单/操作服务单 |
| 品项 | `product` | 品项管理人员 | 商品增删改查；**不可**开单/操作服务单/查看顾客 |
| 员工 | `staff` | 美容师、推广师等一线 | 自己相关的服务单和预约、脱敏顾客数据、本店员工/商品只读；**不可**开单 |

> **一人多角色**：同一员工可同时拥有多个角色（如既是 manager 又是 hr），每个 `(employee_id, role, scope_id)` 组合一条记录。
>
> **一角色多域**：同一员工的同一角色可分配到多个域（如 manager 同时管理两家门店），每个 scope_id 一条记录。示例：`(E1, manager, store_A_id)` + `(E1, manager, store_B_id)`。

### 6.3 域定义

| 域级别 | `org_nodes.type` | 数据边界 | 典型角色 |
|--------|------------------|----------|----------|
| 全局 | `headquarters` | 所有门店数据，无过滤 | 总部管理人员 |
| 市场 | `market` | 该市场下所有门店数据（通过 org_nodes 树查找市场节点下所有 store 节点对应的 `store_id`，`WHERE store_id IN (?)`） | 市场总监、片区经理、市场财务 |
| 门店 | `store` | 仅本门店数据（`WHERE store_id = ?`） | 门店经理、美容师、门店财务 |

域级别由 `org_nodes.type` 决定，`permission_roles.scope_id` FK → `org_nodes.id`。

### 6.4 功能模块定义

| 模块代码 | 模块名称 | 说明 |
|----------|----------|------|
| `workbench` | 工作台 | 今日分成、月度日历、待办/消息 |
| `sale_order` | 订单 | 开单、订单列表/详情、确认收款、关闭、重置 |
| `allocation` | 营业额分配 | 分配保存/删除、提成比例、待分配列表 |
| `service` | 护理服务 | 服务单创建/开始/完成/取消/列表 |
| `appointment` | 预约 | 预约列表/确认/签到 |
| `customer` | 顾客 | 顾客搜索/详情/日历/消费记录 |
| `product` | 商品 | 品项分类/商品/SKU 的增删改查 |
| `employee` | 员工 | 员工列表/详情/管理 |
| `finance` | 财务看板 | 营业额统计、财务报表 |
| `store` | 门店 | 门店列表/详情/管理 |
| `permission` | 权限 | 权限角色的查看/分配/撤销 |
| `sync` | 数据同步 | WorkFine → PG 全量/增量同步 |

### 6.5 权限矩阵

> 矩阵定义为代码常量 `PERMISSION_MATRIX`，规模为 5 角色 × 12 模块，变更需代码审查和发布，不入数据库。

#### 6.5.1 完整矩阵

| 模块 | 操作 | manager | finance | hr | product | staff |
|------|------|---------|---------|-----|---------|-------|
| **workbench** | dashboard | ✅ scope 内 | ✅ scope 内 | ✅ scope 内 | - | ✅ 本门店 |
| **sale_order** | create | ✅ | - | - | - | - |
| **sale_order** | list, detail | ✅ scope 内 | ✅ scope 内 | - | - | ✅ 本门店（自己相关） |
| **sale_order** | confirmOffline | ✅ scope 内 | - | - | - | - |
| **sale_order** | close, resetFailed | ✅ scope 内 | - | - | - | - |
| **allocation** | save, delete | ✅ scope 内 | - | - | - | - |
| **allocation** | list, detail | ✅ scope 内 | ✅ scope 内 | - | - | - |
| **service** | create, start, complete, cancel | ✅ scope 内 | - | - | - | ✅ 仅 assigned_staff |
| **service** | list, detail | ✅ scope 内 | - | - | - | ✅ 仅 assigned_staff |
| **appointment** | list, detail | ✅ scope 内 | - | - | - | ✅ 本门店（自己相关） |
| **appointment** | confirm, checkin | ✅ scope 内 | - | - | - | ✅ 本门店（自己相关） |
| **customer** | search, detail | ✅ scope 内（完整数据） | ✅ scope 内（完整数据） | ✅ scope 内（完整数据） | - | ✅ 本门店（脱敏手机号） |
| **customer** | calendar, paidOrders | ✅ scope 内 | ✅ scope 内 | ✅ scope 内 | - | ✅ 本门店 |
| **product** | read（categories, list, detail） | ✅ | - | - | ✅ | ✅ |
| **product** | write（create, update, delete） | - | - | - | ✅ | - |
| **employee** | list, detail | ✅ scope 内 | - | ✅ scope 内 | - | ✅ 本门店 |
| **employee** | create, update, delete | - | - | ✅ scope 内 | - | - |
| **finance** | dashboard, reports | ✅ scope 内 | ✅ scope 内 | - | - | - |
| **store** | list | ✅ scope 内 | ✅ scope 内 | ✅ scope 内 | - | ✅ 本门店 |
| **store** | manage（update, config） | ✅ 本门店 | - | ✅ scope 内 | - | - |
| **permission** | list | ✅ scope 内 | - | ✅ scope 内 | - | - |
| **permission** | assign, revoke | ✅ scope 内 | - | ✅ scope 内 | - | - |
| **sync** | trigger | ✅ | - | ✅ | - | - |

> **`-`** 表示无权限（API 返回 -403）。
>
> **scope 内**：数据范围受 `permission_roles.scope_id` 限定。一人多域时取所有域的并集（如同时管理 store_A 和 store_B，则可查看两家门店的数据）。
>
> **本门店**：staff 角色固定为其 `employees.store_id` 对应的门店，不可跨门店。
>
> **自己相关**：staff 角色仅能查看/操作 `assigned_employee_id` / `employee_id` / `preferred_employee_id` 指向自己的记录。
>
> **脱敏手机号**：staff 角色查看顾客时，手机号中间 4 位替换为 `****`（如 `138****5678`）。

> 实现时按上表生成代码常量 `PERMISSION_MATRIX`（`staffApi/config/permissions.js`），键为 `module.action`，值为允许的角色数组。

### 6.6 角色+域查询

登录时从 `permission_roles` JOIN `org_nodes` 查询所有角色和域：

```sql
SELECT pr.role, o.type AS scope_type, o.id AS scope_id, o.name AS scope_name,
       p.name AS parent_name
FROM permission_roles pr
JOIN org_nodes o ON pr.scope_id = o.id
LEFT JOIN org_nodes p ON o.parent_id = p.id
WHERE pr.employee_id = $1 AND pr.is_void = false
```

**无记录时降级**：查询 `employees` 获取 `store_id`，降级为 `role=staff, scope_type=store`。

### 6.7 auth 上下文结构

`ctx.auth` 保留现有字段，新增多角色权限结构：

```js
ctx.auth = {
  // 现有字段（保留兼容）
  userId,           // staff_wechat_users.user_id
  openid,           // 微信 openid
  phone,            // 绑定手机号
  employeeId,        // employees.employee_id
  position,         // employees.position_name（保留兼容）
  storeName,        // employees.store_id → JOIN stores 获取
  marketName,       // employees.store_id → JOIN stores 获取
  departmentNodeId, // employees.org_node_id
  departmentName,   // employees.org_node_id → JOIN org_nodes.name 获取

  // 新增：多角色权限
  roles: [
    // 一人可有多条记录（多角色 + 一角色多域）
    {
      role,          // 'manager' | 'finance' | 'hr' | 'product' | 'staff'
      scope: {
        type,        // 'headquarters' | 'market' | 'store'
        nodeId,      // org_nodes.id
        nodeName,    // org_nodes.name
        marketName,  // store 时通过 JOIN 父节点获取，headquarters 时为 null
      },
    },
    // ...可能多条
  ],

  // 便捷字段（从 roles[] 聚合）
  scopeStoreIds: [], // 所有可访问门店的 store_id（登录时预解析：store 类型直接取，market 类型展开其下所有门店）
  permissions: {
    actions: [],     // 扁平数组，如 ['sale_order:create', 'sale_order:list', 'customer:search', ...]
  },

  // 便捷方法
  hasPermission(module, action),  // 检查 actions[] 是否包含 `${module}:${action}`
  getMaxScope(),                  // 返回最高级别的 scope（headquarters > market > store）
  getScopeNodes(role),            // 返回指定角色的所有 scope 节点（一角色多域场景）
  isManager(),                    // roles 中是否包含 manager 角色（保留兼容）
};
```

> **登录时权限聚合逻辑**：
> 1. 查询 `permission_roles`（`WHERE employee_id = ? AND is_void = false`）
> 2. 对每条记录，从 `PERMISSION_MATRIX` 查找该 role 允许的所有 `module:action`
> 3. 合并去重得到 `permissions.actions[]`
> 4. 无记录时降级（详见 §6.6）
>
> **一角色多域的 scope 聚合**：`getMaxScope()` 返回最高级别（headquarters > market > store）。如果同级别有多个节点（如两家门店），域过滤使用 `IN` 条件而非 `=`。

### 6.8 域过滤与行级过滤

#### 6.8.1 域过滤（buildScopeWhere）

所有涉及门店数据的查询统一通过 `buildScopeWhere()` 生成过滤条件：

```js
function buildScopeWhere(auth, alias = '') {
  const prefix = alias ? `${alias}.` : '';

  // headquarters 级别无过滤
  if (auth.roles.some(r => r.scope.type === 'headquarters')) {
    return { where: '', params: [] };
  }

  // 使用登录时预解析的 scopeStoreIds（含 market 展开 + store 直接取）
  const storeIds = auth.scopeStoreIds;
  if (!storeIds.length) {
    return { where: 'AND FALSE', params: [] };
  }

  const placeholders = storeIds.map((_, i) => `$${i + 1}`).join(',');
  return {
    where: `AND ${prefix}store_id IN (${placeholders})`,
    params: storeIds,
  };
}
```

> **scopeStoreIds 预解析**（登录时一次性计算）：
> - `store` 类型 scope：通过 `org_nodes.id` 查找 `stores.org_node_id` 得到 `store_id`
> - `market` 类型 scope：查找该 market 节点下所有 `type='store'` 子节点，再查找对应的 `stores.store_id`
> - 结果去重后存入 `auth.scopeStoreIds`
>
> 参数占位符序号由调用方动态替换（示例中 `$1, $2...` 为简化写法）。

#### 6.8.2 行级过滤（buildStaffFilter）

staff 角色需要额外的行级过滤，仅查看/操作自己相关的记录：

```js
function buildStaffFilter(auth, staffColumn, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  // 有管理角色（manager/finance/hr）的员工不限制行级
  if (auth.roles.some(r => ['manager', 'finance', 'hr'].includes(r.role))) {
    return { where: '', params: [] };
  }
  return { where: `AND ${prefix}${staffColumn} = $N`, params: [auth.employeeId] };
}
```

> **典型组合用法**：
> - 服务单列表：`buildScopeWhere(auth) + buildStaffFilter(auth, 'assigned_employee_id')`
> - 预约列表：`buildScopeWhere(auth) + buildStaffFilter(auth, 'employee_id')`
> - 订单列表：`buildScopeWhere(auth) + buildStaffFilter(auth, 'preferred_employee_id')`

### 6.9 前端权限下发

#### 6.9.1 login 返回结构

auth.login 返回中新增 `permissions` 字段：

```js
{
  code: 0,
  data: {
    // ...现有字段
    permissions: {
      roles: [
        { role: 'manager', scopeType: 'store', scopeName: '南昌A店' },
        { role: 'manager', scopeType: 'store', scopeName: '南昌B店' },
        { role: 'hr', scopeType: 'market', scopeName: '南昌市场' },
      ],
      actions: [
        'sale_order:create', 'sale_order:list', 'sale_order:detail', 'sale_order:confirmOffline',
        'sale_order:close', 'sale_order:resetFailed',
        'allocation:save', 'allocation:delete', 'allocation:list',
        'service:create', 'service:start', 'service:complete',
        'customer:search', 'customer:detail',
        'employee:list', 'employee:create', 'employee:update',
        'permission:list', 'permission:assign', 'permission:revoke',
        // ...
      ],
    },
  }
}
```

> §6.9.2 前端权限存储与检查、§6.10 staffApi 路由权限声明，详见 `staff.pr.spec.md` §11.6/§11.7。

### 6.10 同步推导规则（原 §6.11）

同步脚本遍历 `employees`（`is_resigned = false`），根据 `org_node_id`（JOIN `org_nodes.name` 获取部门名称）+ `position_name` 自动推导 `permission_roles` 记录，`created_by = 'sync'`：

| # | 条件 | 推导结果 | 说明 |
|---|------|----------|------|
| 1 | `position_name = '门店经理'` | `role=manager, scope=员工所在门店` | 门店级管理者 |
| 2 | `position_name IN ('市场总监', '片区经理')` | `role=manager, scope=员工所属市场` | 市场级管理者 |
| 3 | `org_node_name = '财智部'` | `role=finance, scope=员工所在门店`（如部门挂在市场级则 `scope=该市场`） | 财务人员 |
| 4 | `position_name LIKE '%代理%'` 或 `LIKE '%实习%'` | `role=staff, scope=员工所在门店` | 代理/实习经理默认不授管理权限 |
| 5 | 其他 | `role=staff, scope=员工所在门店` | 默认降级为一线员工 |

> **hr 和 product 角色不参与自动推导**：WorkFine 中无对应部门/职位标识，仅通过管理后台手动分配。
>
> **手动分配保护**：同步时跳过 `created_by != 'sync'` 的记录，确保手动分配的权限不被覆盖。
>
> **默认降级**：详见 §6.6。
>
> **代理经理/实习经理**：同步脚本默认推导为 `role=staff`；如需赋予经理权限，由上级通过管理后台手动升级。

### 6.11 权限管理 API

| 接口 | 权限要求 | 说明 |
|------|----------|------|
| `permission.list` | manager / hr（scope 内） | 查看 scope 内员工的权限角色列表 |
| `permission.assign` | manager / hr（scope 内） | 为员工分配角色，被分配的 scope_id 必须在操作者 scope 范围内 |
| `permission.revoke` | manager / hr（scope 内） | 撤销员工角色（软删除，`is_void = true` + `voided_at` 标记） |

> **scope 传递约束**：分配权限时，被分配的 `scope_id` 必须在操作者 scope 范围内。门店经理只能分配本门店权限，市场总监可分配该市场下所有门店的权限。一角色多域场景下，操作者的所有 scope 节点均为有效范围。

---

## 7. 核心业务规则

1. 只有 **role=manager** 可开单，其他角色（finance/hr/product/staff）均无开单权限
2. **营业额分配**：同部门总额 ≤ 实收；跨部门各按实收金额分配（总额可达实收 2 倍）；**MVP 阶段不支持优惠/折扣，应收金额 = 实收金额**
3. **美容师选择非必须**：顾客下单时可不指定美容师
4. **日历入账口径**：仅 `已支付` 订单计入当日消费
5. **混购完成规则**：订单包含多类项目时，`已完成` 以**所有疗程卡行与单品行的 remaining_sessions 全部归零**为触发条件；院装产品行支付即视为该行已交付
6. **幂等要求**：详见 §11 "支付幂等"
7. **线下付款口径**（仅 MVP）：顾客端选择线下付款先进入 `待确认收款`，店长确认后才计为 `已支付`
8. 支付成功触发条件统一为**订单进入已支付**
9. 订单在员工端开单时即写入数据库（状态 `待支付`），客户扫码后无需重复创建
10. 订单关闭/支付失败时，对应的营业额分配记录一并标记为无效（`is_void = true`）
11. **疗程卡并发扣减**：使用原子 UPDATE（`rowCount` 校验），禁止先 SELECT 后 UPDATE
12. **护理单来源约束**：`service_items.sale_item_id` 必须关联已支付订单的 `sale_items` 行
13. **体验/引流服务**需先创建体验单（`sale_order_type = '体验'`），支付确认后再创建护理单；体验单仅可选择体验卡商品（`product_kind = '福利活动'` 中的体验类项目），不计入普通业绩统计，需在报表中打标记区分；体验单面向潜在客户（散客到店），由店长创建并指定归属美容师；**先服务后付款不在 MVP 范围**
14. **开单流程分级选择**：开单时先选大类（销售单 / 回款单 / 转换单），选销售单后再选子类型（普通单 / 体验单 / 内部单）；大类决定单据模板和流程差异，子类型决定商品范围和统计口径
15. **内部单规则**：`sale_order_type = '内部'`，员工/家属消费统一按半价计算（`unit_price = product_skus.price × 0.5`），需打标记以便数据分析时剔除；内部单不算顾客数（客流/客量统计排除）、不计入会员等级升级消费额；走与普通订单相同的支付和营业额分配流程
16. **顾客端自助下单的营业额分配**：
    - 已指定美容师：系统自动以该美容师为唯一被分配人创建分配记录
    - 未指定美容师：不创建分配记录
17. **营业额分配锁定规则**：待支付且顾客未扫码时可修改；扫码后锁定
18. **手机号补全机制**：顾客绑定手机号时，批量补全 `sale_orders.client_user_id`（匹配到的 `client_wechat_users.user_id`）
19. **员工开单顾客身份验证**：通过手机号查询 `client_wechat_users.phone`，填入 `client_user_id`（= `user_id`）
20. **预约取消后可重新发起**：`已取消` 可重新发起；`已关闭` 不可
21. **数据同步不影响业务**：WorkFine → PG 同步使用 UPSERT，不锁表不中断在线查询
22. **回款规则**：
    - `ref_sale_order_id` 必填，指向原销售单
    - 回款时原子累加原 `sale_item.received`（`UPDATE sale_items SET received = received + $amount WHERE sale_item_id = $ref RETURNING received`）
    - 支持分多次回款（N:1 关系，同一原单可被多次回款）
    - 支付方式与销售单一致（wechat/alipay/offline）
    - 仅员工端操作（`sale_order_source = 'staff'`）
23. **转换规则**：
    - `ref_sale_order_id` 必填，指向原销售单
    - 转换单内包含 `convert_out` 行（原项目退出）和 `convert_in` 行（新项目转入），单事务内完成
    - `convert_out` 行原子扣减原 sale_item 的 `remaining_sessions`
    - `convert_in` 行创建新的 sale_item（新疗程卡/商品），`item_direction = 'convert_in'`
    - `total_amount` = 补差价金额（转入 - 转出）
24. **退款规则**：
    - `ref_sale_order_id` 必填，指向原销售单
    - 创建时状态为 `待审批`，需店长审批后才执行退款操作
    - 店长审批通过后原子扣减原 sale_item 的 `remaining_sessions`
    - `total_amount` 为负数
    - `refund_out` 行中 `quantity` = 退次数，`received` = 负退消耗金额
    - handling_fee（仅个别退款单有值）存入 `remark` 字段
25. **回款/转换/退款仅员工端操作**，不支持顾客端发起

---

## 8. 状态机

### 8.1 订单状态机

```text
待支付 → 已支付          （微信支付回调成功）
待支付 → 待确认收款      （顾客选择线下付款提交）
待支付 → 支付失败        （微信支付超时/失败）
待支付 → 已关闭          （手动关闭）
待确认收款 → 已支付      （店长确认线下收款）
支付失败 → 待支付        （店长手动重置，允许重新付款）
已支付 → 已完成          （全部 remaining_sessions 归零；院装产品支付即完成）
```

### 8.2 服务单状态机

```text
待服务 → 服务中          （开始服务）
服务中 → 已完成          （完成服务，原子扣减次数）
待服务 → 已取消          （取消服务单，不扣次）
服务中 → 已取消          （取消服务单，不扣次）
```

### 8.3 预约状态机

```text
待确认 → 已确认          （员工确认预约）
待确认 → 已取消          （顾客取消）
已确认 → 已取消          （顾客取消）
已确认 → 已完成          （关联服务单完成后自动流转）
待确认 → 已关闭          （超期 / 次数归零）
已确认 → 已关闭          （超期 / 次数归零）
```

### 8.4 营业额分配状态机

```text
null → pending               （订单支付成功）
pending → allocated          （店长完成分配）
allocated → pending          （店长删除重新分配）
```

### 8.5 退款审批状态机

```text
待审批 → 已审批（已支付）     （店长审批通过，触发 remaining_sessions 原子扣减 + 退款业绩记录）
待审批 → 已关闭              （店长驳回退款申请）
```

> 退款单创建时 `status = '待审批'`，审批通过后流转为 `已支付`（复用已有状态表示退款已生效），同时原子扣减原 sale_item 的 remaining_sessions。

---

## 9. 异常场景处理

| 场景 | 处理方式 |
|------|----------|
| 重复下单 | 部分唯一索引拦截 |
| 重复支付回调 | 仅第一次成功回调生效 |
| 重复线下确认收款 | 仅第一次确认生效 |
| 网络抖动导致推送失败 | 轮询兜底保证最终一致 |
| 并发核销 | 原子 UPDATE + rowCount 校验 |

---

## 10. 核心接口列表

> clientApi 接口详见 `client.pr.spec.md` §10。
> staffApi 接口详见 `staff.pr.spec.md` §10。
> adminApi 接口详见 `admin.pr.spec.md` §9.4。

### 10.1 跨端接口

| 接口 | 说明 |
|------|------|
| 用户认证 | 微信小程序登录、手机号绑定 |
| 幂等控制 | 下单、支付回调、服务完成接口幂等校验 |
| 实时推送 | 订单进入已支付后即时通知员工端 |

---

## 11. 环境约束

| 约束 | 描述 |
|------|------|
| 疗程次数原子扣减 | `UPDATE ... SET remaining_sessions = remaining_sessions - n WHERE remaining_sessions >= n`，禁止先 SELECT 后 UPDATE |
| 价格快照不可变 | 开单时写入 `unit_price`，后续价格变动不影响历史订单 |
| 支付幂等 | 微信回调、线下确认、服务完成接口均需幂等 |
| 状态单向推进 | 唯一例外：店长可重置 `支付失败` → `待支付` |
| 域数据隔离 | 所有 PG 查询以 scope 过滤（headquarters 无过滤 / market 和 store 均通过 `store_id IN (scopeStoreIds)` 过滤），由 `buildScopeWhere()` 统一生成；一角色多域时取并集；staff 角色额外叠加 `buildStaffFilter()` 行级过滤 |
| 订单号唯一生成 | advisory lock 防流水号并发冲突 |
| 待支付订单唯一 | 部分唯一索引 + 应用层校验 |
| 事务处理 | 服务单完成、订单创建、分配保存均使用 PostgreSQL transaction |
| 连接池限制 | PG max 5（业务查询） |
| 响应格式 | `{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403 |
| 运行时零 MSSQL | 业务请求链路不连接 WorkFine SQL Server |

---

## 12. MVP 验收标准

> 员工端日历相关验收标准（AC-01~AC-03）已移至 `staff.pr.spec.md` §8。

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-01 | 同一服务单重复点击"完成服务"不产生重复扣次 | 连续点击完成 → 仅扣一次 |
| AC-02 | 角色越权操作应被拒绝 | 越权操作 → 返回 -403 |
| AC-03 | PG stores/employees/client_wechat_users 表数据与 WorkFine 源数据一致 | 同步后对比关键字段 |
| AC-04 | 各端门店列表、员工列表、顾客搜索均从 PG 查询，响应时间 < 500ms | 接口计时 |
| AC-05 | WorkFine 连接断开时，门店/员工/顾客查询不受影响（使用 PG 已同步数据） | 断开 MSSQL → 验证查询正常 |
| AC-06 | 手动触发全量同步后，新增/变更的门店/员工/顾客数据在 PG 中更新 | 在 WorkFine 修改 → 触发同步 → 验证 PG |
| AC-07 | 小程序中完成开单后，PG sale_orders 表中 client_user_id 正确填入（关联 client_wechat_users.user_id） | 开单 → 查询 sale_orders.client_user_id |

---

## 附录 A: 全局关联图

```
PG 实体（同步实体以 ★ 标注）

★ org_nodes (组织架构树, type: headquarters/market/store/department)
│   ├── parent_id ──→ org_nodes.id（自引用，邻接表）
│   └── id ←── permission_roles.scope_id（域目标）
│              ←── stores.org_node_id（1:1 扩展）
★ stores (门店详情) ←── store_id ──→ 被 sale_orders/service_orders/appointments 等 FK 引用
│   └── org_node_id ──→ org_nodes.id（关联 type='store' 节点）
★ employees (员工) ←── employee_id ──→ 被以下字段引用：
│   ├── org_node_id ──→ org_nodes.id（关联 type='department' 部门节点）
│   ├── staff_wechat_users.employee_id
│   ├── sale_orders.preferred_employee_id / opened_by
│   ├── service_orders.assigned_employee_id
│   ├── service_items.employee_id
│   ├── sale_allocations.employee_id
│   └── appointments.employee_id
permission_roles (权限角色分配，一人多角色+一角色多域)
│   ├── employee_id ──→ employees.employee_id
│   ├── role ──→ manager / finance / hr / product / staff
│   └── scope_id ──→ org_nodes.id（headquarters/market/store 级别节点）
client_wechat_users (顾客 / 客户端微信用户，含 WorkFine 同步档案)
│   ├── user_id ──→ sale_orders.client_user_id
│   ├── user_id ──→ appointments.client_user_id
│   ├── user_id ──→ service_orders.client_user_id
│   ├── store_id ──→ stores.store_id（同步归属门店）
│   └── bound_store_id ──→ stores.store_id（顾客主动绑定门店）

product_categories ──→ products (1:N, via category_id)
products ──→ product_skus (1:N, via product_id)
                    │
                    └── sku_id ──→ sale_items.sku_id

sale_orders ──→ sale_items (1:N)
│   ├── client_user_id ──→ client_wechat_users.user_id
│   └── ref_sale_order_id ──→ sale_orders.sale_order_id（回款/转换/退款引用原单，自引用）
sale_items ──→ sale_allocations (1:N, 通过 sale_item_id)
sale_items ──→ service_items (1:N, 通过 sale_item_id)
sale_items.ref_sale_item_id ──→ sale_items.sale_item_id（convert_out/refund_out 引用原购买行，自引用）

service_orders ──→ service_items (1:N)
│   └── appointment_id ──→ appointments (1:1, 可选)

operation_logs (操作日志，只写)
│   ├── operator_user_id ──→ staff_wechat_users.user_id
│   ├── org_node_id ──→ org_nodes.id
│   └── target_type + target_id ──→ 任意实体主键（sale_orders/appointments/service_orders 等）

store_unbind_requests (门店解绑申请)
│   └── user_id ──→ client_wechat_users.user_id
```
