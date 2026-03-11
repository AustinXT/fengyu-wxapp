# 凤御双美容院 — 后端服务产品需求规格书

> **文档版本**: 3.0.0
> **范围**: 后端服务（CloudBase 云函数 + PostgreSQL 数据库）
> **约束文档**: `.42cog/real.md` v2.0.0 | `.42cog/cog.md` v2.0.0
> **端 spec 引用**: `client.pr.spec.md` v1.0.0 | `staff.pr.spec.md` v1.0.0
> **同步方案**: `workfine-sync.spec.md` v1.0.0
> **日期**: 2026-03-11
>
> **运行时架构**: 所有业务查询 100% 走 PG，WorkFine SQL Server 不参与在线请求链路。WorkFine 迁移与同步方案见 `workfine-sync.spec.md`。
>
> **商品表设计**: `product_categories` + `products` + `product_skus` 三张自包含表。枚举 `product_kind`（福利活动/护理项目/家居产品/充值卡）。商品数据初始导入后由员工手动维护。

---

## 1. 概述

**定位**: 凤御双美容院微信小程序生态系统的统一后端服务层，为顾客端（C端）和员工端（B端）提供 API 网关、业务逻辑、数据持久化和跨端协调。

**技术栈**:

| 项 | 方案 |
|----|------|
| 前端 | 微信小程序（客户端 + 员工端，共两个小程序） |
| 后端 | CloudBase 云函数（Node.js 18） |
| 数据库 | PostgreSQL 自托管（读写，全部业务数据） |
| 支付 | 微信支付多商户模式（特约商户）+ 线下付款标记 |
| 实时通信 | WebSocket 或小程序订阅消息 |
| 权限 | RBAC + Scope（3角色×3域），PG stores(scope_level) + permission_roles 表驱动，微信 openid 关联 |

---

## 2. 技术架构

```
小程序（客户端 + 员工端）
    ↓
CloudBase 云函数（Node.js）
    └── PG 自托管数据库（业务数据 + 全部实体）
          ↑ 运行时：所有业务查询 100% 走 PG
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
| 1 | 门店信息 | `stores` | 同步自 WorkFine | 所有业务查询走 PG |
| 2 | 部门/职位 | `departments` / `positions` | 同步自 WorkFine | 角色判定、分配使用 PG |
| 3 | 员工信息 | `employees` | 同步自 WorkFine | 角色判定、营业额分配使用 PG |
| 4 | 顾客档案 | `customers` | 同步自 WorkFine | 顾客搜索、档案查看使用 PG |
| 5 | 品项分类 | `product_categories` | PG 读写 | 初始导入后员工手动管理 |
| 6 | 商品 | `products` | PG 读写 | 初始导入后员工日常维护 |
| 7 | 商品规格 | `product_skus` | PG 读写 | 价格/次数自包含 |
| 8 | 提成比例矩阵 | `commission_rate_matrix` | 同步自 WorkFine | — |
| 9 | 订单/销售明细 | `orders` / `order_items` | PG 读写 | — |
| 10 | 营业额分配 | `revenue_allocations` / `revenue_allocation_items` | PG 读写 | — |
| 11 | 护理单/核销 | `service_orders` / `service_items` | PG 读写 | — |
| 12 | 微信用户 | `client_wechat_users` / `staff_wechat_users` | PG 读写 | 两端独立 |
| 13 | 预约 | `appointments` | PG 读写 | — |
| 14 | 权限角色分配 | `permission_roles` | PG 读写 | — |

> 同步机制详见 `workfine-sync.spec.md`。

---

## 4. 数据模型

### 4.1 stores（门店）

| 字段 | 类型 | 说明 |
|------|------|------|
| `store_id` | string | 主键，UUID |
| `store_name` | string | 门店名称（唯一索引），业务主键，贯穿所有业务表 |
| `market_name` | string | 所属市场（如"南商市场"） |
| `opening_date` | date \| null | 开业时间 |
| `total_investment` | decimal \| null | 总投资款 |
| `bed_count` | integer \| null | 可用床位数 |
| `scope_level` | text | 域级别：`global` / `market` / `store`，NOT NULL DEFAULT 'store' |
| `is_closed` | boolean | 是否停止营业，NOT NULL DEFAULT false |
| `closed_date` | date \| null | 关店日期 |
| `region` | string \| null | 门店所属区域（地理分类） |
| `wf_department_id` | string \| null | WorkFine 部门 ID 关联标识 |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> 现有业务表（orders、service_orders、appointments 等）的 `store_name` / `market_name` 字段保持文本存储（快照语义），不设 FK 约束。`stores` 表作为权威查找表，应用层通过 `store_name` 查询。
>
> **scope_level 虚拟条目**:
> - 1 条 **global** 行：`store_name='总部', market_name=NULL, scope_level='global'`
> - ~20 条 **market** 行：`store_name=市场名, market_name=市场名, scope_level='market'`（如 `store_name='南昌市场', market_name='南昌市场'`）
> - 现有 ~100 条门店行保持 `scope_level='store'`（默认值）
>
> 虚拟条目由同步脚本自动生成：遍历现有门店的 `market_name` 去重后插入 market 行；global 行固定一条。虚拟条目的 `is_closed = false`，不参与门店业务查询（业务查询只查 `scope_level = 'store'`），仅作为 `permission_roles.scope_id` 的 FK 目标。

### 4.2 departments（部门）

| 字段 | 类型 | 说明 |
|------|------|------|
| `department_id` | string | 主键，UUID |
| `department_name` | string | 部门名称（唯一索引），如"美容部"、"推广部"、"养生部" |
| `department_code` | string \| null | 部门编码 |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

### 4.3 positions（职位）

| 字段 | 类型 | 说明 |
|------|------|------|
| `position_id` | string | 主键，UUID |
| `position_name` | string | 职位名称，如"门店经理"、"美容师"、"督导" |
| `department_name` | string | 所属部门名称，关联 `departments.department_name` |
| `rank_order` | integer \| null | 排序序号（用于职级显示） |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> UNIQUE 约束：`(position_name, department_name)`

### 4.4 employees（员工）

| 字段 | 类型 | 说明 |
|------|------|------|
| `employee_no` | string | 主键，员工编号（格式 `FY-{YYMMDD}{序号}`） |
| `name` | string | 姓名 |
| `gender` | string \| null | 性别 |
| `phone` | string \| null | 手机号码 |
| `store_name` | string \| null | 所属分院（门店名称） |
| `market_name` | string \| null | 所属市场 |
| `position_name` | string \| null | 工作职位（如"门店经理"、"美容师"） |
| `department_name` | string \| null | 职能部门（如"美容部"、"推广部"） |
| `position2_name` | string \| null | 第二工作职位（兼任） |
| `department2_name` | string \| null | 第二部门（兼任） |
| `rank1` | string \| null | 主职级 |
| `rank2` | string \| null | 副职级 |
| `is_resigned` | boolean | 是否离职，NOT NULL DEFAULT false |
| `birth_date` | date \| null | 出生日期 |
| `probation_start_date` | date \| null | 试用期开始日 |
| `regular_date` | date \| null | 转正日期 |
| `resigned_date` | date \| null | 离职日期 |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **身份证号**为高敏 PII，不存储在 PG 中。
>
> **角色判定**: 查询 `permission_roles` 表（JOIN `stores` ON `scope_id`），获取 `role` 和 `scope_level`。无 `permission_roles` 记录时降级为 `role=staff, scope=员工所在门店`（通过 `employees.store_name` 匹配 `stores.store_id`）。
>
> 现有业务表中引用员工编号的字段（`orders.preferred_staff_wf_id`、`orders.opened_by`、`service_orders.assigned_staff_wf_id`、`revenue_allocations.employee_id`、`service_items.employee_id`、`appointments.staff_wf_id`、`staff_wechat_users.staff_wf_id`）值即为 `employees.employee_no`。

### 4.5 customers（顾客档案）

| 字段 | 类型 | 说明 |
|------|------|------|
| `customer_no` | string | 主键，顾客编号（格式 `FYGK-{YYYYMMDD}{序号}`） |
| `name` | string | 顾客姓名 |
| `phone` | string \| null | 手机号码（唯一索引） |
| `birthday` | date \| null | 生日 |
| `age` | integer \| null | 年龄 |
| `store_name` | string \| null | 所属分院（门店名称） |
| `market_name` | string \| null | 所属市场 |
| `member_level` | string \| null | 会员等级（普通 / VIP 等） |
| `member_tag` | string \| null | 会员分类标签 |
| `customer_source` | string \| null | 顾客来源（售前 / 拓客 / 推荐等） |
| `primary_beautician` | string \| null | 所属美容师姓名（营业额分配默认人员） |
| `skin_type` | string \| null | 肤质类型 |
| `improvement_focus` | string \| null | 改善重点 |
| `skin_issue` | string \| null | 皮肤问题 |
| `wellness_preference` | string \| null | 接受养生方式 |
| `occupation` | string \| null | 职业 |
| `is_married` | string \| null | 是否已婚 |
| `is_shared` | string \| null | 是否与其他分院共享 |
| `category` | string \| null | 顾客分类 |
| `wechat_name` | string \| null | 微信名 |
| `registered_at` | date \| null | 首次登记时间 |
| `total_consumption` | decimal \| null | 累计消费金额 |
| `max_single_consumption` | decimal \| null | 单笔最高金额 |
| `days_since_last_visit` | string \| null | 未到店时间间隔 |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **与 client_wechat_users 的关系**: `client_wechat_users.customer_no` → `customers.customer_no`（通过手机号自动关联）。顾客绑定手机号时，系统查询 `customers.phone` 匹配，将 `customer_no` 写入 `client_wechat_users`。并非所有顾客都会注册小程序，也非所有小程序用户都有档案，两表为可选关联。

### 4.6 product_categories（品项分类）

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

### 4.7 products（商品主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_id` | text | 主键，UUID |
| `product_kind` | product_kind enum | 福利活动 / 护理项目 / 家居产品 / 充值卡 |
| `category_id` | text | FK → `product_categories.category_id` |
| `name` | text | 商品名称 |
| `cover_image` | text | 封面图 URL |
| `detail_images` | text[] | 详情图片 URL 列表（PostgreSQL 数组） |
| `description` | text | 商品描述 |
| `is_shengmei` | boolean | 是否生美（护理项目使用，其他为 null） |
| `is_bundle` | boolean | 是否套餐（套餐的 SKU 是其组成部分），NOT NULL DEFAULT false |
| `price` | numeric(12,2) | 标价/原价 |
| `special_price` | numeric(12,2) \| null | 特价/促销价（null=无特价） |
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

### 4.8 product_skus（商品规格）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sku_id` | text | 主键，保留现有 sku_id 值确保 FK 连续 |
| `product_id` | text | FK → `products.product_id` |
| `product_type` | product_type enum | 疗程卡 / 单品 / 院装产品；决定核销流程 |
| `spec_name` | text | 规格名（如"10次卡"、"285ml/瓶"、"单次体验"） |
| `price` | numeric(12,2) | 标价/零售价（套餐组件中为 0 表示赠品），**开单时快照到 order_items.unit_price** |
| `special_price` | numeric(12,2) \| null | 特价/促销价（null=无特价） |
| `session_count` | integer \| null | 疗程次数：疗程卡≥2，单品=1，院装产品=null |
| `is_bundle_sku` | boolean | 是否为套餐的组成部分，NOT NULL DEFAULT false |
| `sort_order` | integer | 排序序号 |
| `is_active` | boolean | 是否上架，NOT NULL DEFAULT true |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **索引**: `(product_id)`
>
> **核心设计**:
> - 价格、次数**直接存在 SKU 表中**，运行时无外部查询
> - `special_price` 支持 SKU 级别的促销/特价
> - 套餐赠品：`price = 0` 即为赠品
> - 套餐总价 = 所有 `is_bundle_sku=true` 的 SKU 的 `price` 之和
> - 产品类型 = `疗程卡` → 进入核销流程；`单品` → 支付即结束；`院装产品` → 支付即结束
>
> **FK 引用**: `order_items.sku_id` → `product_skus.sku_id`；`service_items.sku_id` → `product_skus.sku_id`
>
> **套餐示例**:
> ```
> products: { product_id: 'P001', name: '春季焕肤套餐', is_bundle: true, product_kind: '福利活动' }
>   └─ product_skus:
>        { sku_id: 'S001', spec_name: '蜜语生玑 10次卡', price: 1999, is_bundle_sku: true }
>        { sku_id: 'S002', spec_name: '科颜美精华 单次', price: 0, is_bundle_sku: true }  ← 赠品
> ```

### 4.9 commission_rate_matrix（提成比例矩阵）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `market_name` | string | 适用市场 |
| `department_name` | string | 适用部门 |
| `sales_category` | string | 销售分类（如"自采自销"、"他销自耗"） |
| `amount_tier_min` | decimal | 金额阶段下限（含） |
| `amount_tier_max` | decimal \| null | 金额阶段上限（不含；null 表示无上限） |
| `commission_rate` | decimal | 提成比例（如 0.08 = 8%） |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> UNIQUE 约束：`(market_name, department_name, sales_category, amount_tier_min)`

### 4.10 orders（订单主表）

> **设计说明：为何需要 `order_items`？**
> 一笔销售单可包含多个项目（疗程卡、单品、院装产品可混购），且疗程卡需要**独立追踪剩余次数与到期日**，并作为护理单核销的引用锚点。

| 字段 | 类型 | 说明 |
|------|------|------|
| `order_no` | string | 主键，销售单号，格式 `FY-XSD-WX-{YYMMDD}{序号}` |
| `status` | enum | 订单状态：`待支付` / `待确认收款` / `已支付` / `已完成` / `支付失败` / `已关闭` |
| `order_type` | enum | 订单类型：`正式` / `体验` / `促销方案` |
| `market_name` | string | 所属市场（快照） |
| `store_name` | string | 所属门店（快照） |
| `order_datetime` | datetime | 销售日期时间 |
| `client_user_id` | string \| null | 关联 `client_wechat_users.user_id`；员工开单时顾客未注册则为 null |
| `client_phone` | string \| null | 顾客手机号快照；员工开单时必填 |
| `customer_name` | string \| null | 顾客姓名快照 |
| `customer_no` | string \| null | 关联 `customers.customer_no`；开单时通过手机号匹配自动填入 |
| `payment_method` | enum | `wechat` / `alipay` / `offline` |
| `order_source` | enum | `client`（客户端自助）/ `staff`（员工端开单） |
| `opened_by` | string \| null | 开单人员工编号，关联 `employees.employee_no` |
| `preferred_staff_wf_id` | string \| null | 顾客指定美容师，关联 `employees.employee_no` |
| `paid_at` | timestamp | 支付完成时间 |
| `wechat_transaction_id` | string \| null | 微信支付流水号（唯一索引） |
| `alipay_transaction_id` | string \| null | 支付宝交易号（唯一索引） |
| `offline_confirmed_by` | string \| null | 线下收款确认人员工编号 |
| `offline_confirmed_at` | timestamp | 线下收款确认时间 |
| `allocation_status` | string \| null | 提成分配状态：null → 'pending' → 'allocated' |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **部分唯一索引**：
> - `UNIQUE (client_user_id) WHERE status = '待支付' AND client_user_id IS NOT NULL`
> - `UNIQUE (client_phone, store_name) WHERE status = '待支付' AND client_user_id IS NULL`

### 4.11 order_items（销售明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `item_flow_no` | string | 主键，销售流水号，格式 `XSLSH-WX-{YYYYMMDD}{序号}` |
| `order_no` | string | 关联 `orders.order_no` |
| `sku_id` | string \| null | 关联 `product_skus.sku_id` |
| `session_count` | integer \| null | 疗程总次数：疗程卡≥2，单品=1，院装产品=null |
| `remaining_sessions` | integer \| null | 剩余可用次数；原子递减防超卖 |
| `unit_price` | decimal | 原价快照（开单时持久化） |
| `quantity` | integer | 销售数量 |
| `unit_discount` | decimal | 单价优惠金额 |
| `sale_amount` | decimal | 优惠后销售金额 |
| `receivable` | decimal | 应收金额 |
| `received` | decimal | 实收金额 |
| `expire_date` | date \| null | 到期日（疗程卡/单品适用，院装产品为 null） |
| `remark` | string | 备注 |
| `promotion_scheme_id` | string \| null | 促销方案编号 |
| `sales_category` | enum \| null | 销售分类：`自采自销` / `他销自耗` / `他销他耗` / `生态合作` |

### 4.12 revenue_allocations（营业额分配）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `order_no` | string | 关联 `orders.order_no` |
| `employee_id` | string | 员工编号，关联 `employees.employee_no` |
| `department` | string \| null | 员工所属部门快照 |
| `allocation_ratio` | decimal | 占比 |
| `total_amount` | decimal | 该员工最终分配金额 |
| `is_void` | boolean | 是否已作废，NOT NULL DEFAULT false |
| `voided_at` | timestamp | 作废时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> UNIQUE 约束：`(order_no, employee_id)`

### 4.13 revenue_allocation_items（业绩分类明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `allocation_id` | bigint | 关联 `revenue_allocations.id` |
| `item_flow_no` | string \| null | 关联 `order_items.item_flow_no` |
| `performance_category` | string | 业绩分类（销售分类） |
| `amount` | decimal | 该分类的分配金额 |
| `commission_rate` | decimal \| null | 提成比例快照 |

### 4.14 service_orders（护理单主表）

> 与订单的关联通过 `service_items.item_flow_no → order_items.item_flow_no` 实现，主表不存 `order_no`，支持同一次到店跨多笔订单核销。

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_order_no` | string | 主键，格式 `HLD-WX-{YYMMDD}{序号}` |
| `status` | enum | `待服务` / `服务中` / `已完成` / `已取消` |
| `market_name` | string | 所属市场（快照） |
| `store_name` | string | 所属门店（快照） |
| `service_date` | date | 护理服务日期 |
| `service_duration` | integer | 服务时长（分钟） |
| `assigned_staff_wf_id` | string | 主责服务人员，关联 `employees.employee_no` |
| `remark` | string | 备注 |
| `appointment_id` | string \| null | 关联 `appointments.appointment_id` |
| `client_user_id` | string \| null | 关联 `client_wechat_users.user_id` |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

### 4.15 service_items（护理明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_item_id` | string | 主键，UUID |
| `item_flow_no` | string | 关联 `order_items.item_flow_no`（核销锚点） |
| `service_order_no` | string | 关联 `service_orders.service_order_no` |
| `sku_id` | string \| null | 关联 `product_skus.sku_id` |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | string | 服务美容师，关联 `employees.employee_no` |

### 4.16 client_wechat_users（客户端微信用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 主键，系统自生成 |
| `openid` | string | 微信 openid（客户端 appid 下，唯一索引） |
| `session_key` | string | 微信 session_key |
| `phone` | string | 绑定手机号（唯一索引） |
| `customer_no` | string \| null | 关联 `customers.customer_no`，手机号匹配后自动填入 |
| `bound_store_name` | string | 绑定门店名 |
| `bound_market_name` | string | 绑定市场名 |
| `last_login_at` | timestamp | 最近登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> 绑定手机号时系统查询 `customers.phone` 匹配，将 `customer_no` 写入。后续可通过此字段直接获取顾客档案详情。

### 4.17 staff_wechat_users（员工端微信用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 主键，系统自生成 |
| `openid` | string | 微信 openid（员工端 appid 下，唯一索引） |
| `session_key` | string | 微信 session_key |
| `phone` | string | 绑定手机号 |
| `staff_wf_id` | string | 关联 `employees.employee_no`（手机号自动匹配后填入，可为 null） |
| `last_login_at` | timestamp | 最近登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

### 4.18 appointments（预约）

| 字段 | 类型 | 说明 |
|------|------|------|
| `appointment_id` | string | 主键，系统自生成 |
| `status` | enum | `待确认` / `已确认` / `已完成` / `已取消` / `已关闭` |
| `market_name` | string | 所属市场 |
| `store_name` | string | 所属门店 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id` |
| `customer_name` | string | 顾客姓名（冗余存储） |
| `staff_wf_id` | string | 预约美容师，关联 `employees.employee_no` |
| `staff_name` | string | 美容师姓名（冗余存储） |
| `item_flow_no` | string \| null | 关联 `order_items.item_flow_no`（可选） |
| `appointment_time` | datetime | 预约到店时间 |
| `checkin_at` | timestamp \| null | 到店签到时间（不改状态） |
| `notes` | string | 备注 |
| `cancelled_reason` | string | 取消原因 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

### 4.19 permission_roles（权限角色分配）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | serial | 主键，自增 |
| `staff_id` | text NOT NULL | 员工编号，FK → `employees.employee_no` |
| `role` | text NOT NULL | 角色：`manager` / `finance` / `staff` |
| `scope_id` | text NOT NULL | FK → `stores.store_id`（指向 global/market/store 级别的条目） |
| `created_at` | timestamp | NOT NULL DEFAULT now() |
| `updated_at` | timestamp | NOT NULL DEFAULT now() |
| `deleted_at` | timestamp \| null | 软删除标记 |
| `created_by` | text \| null | 创建者（同步脚本标记 `'sync'`，手动标记操作人员工编号） |
| `updated_by` | text \| null | 最后修改者 |

> **约束**:
> - `UNIQUE(staff_id) WHERE deleted_at IS NULL`（部分唯一索引，一人一角色）
> - `FK(staff_id)` → `employees(employee_no)`
> - `FK(scope_id)` → `stores(store_id)`
>
> **数据量**: ~2000 行（在职员工各一行）
>
> **初始数据**: 同步脚本遍历 `employees`（`is_resigned = false`），根据 `department_name` + `position_name` 规则自动推导 `role` + `scope_id`，`created_by = 'sync'`。推导规则示例：
> - `position_name = '门店经理'` → `role=manager, scope_id=员工所在门店`
> - `department_name = '财智部'` → `role=finance, scope_id=员工所在门店`
> - `position_name = '市场总监'` 或 `position_name = '片区经理'` → `role=manager, scope_id=员工所属市场`
> - 其他 → `role=staff, scope_id=员工所在门店`
>
> **默认降级**: 未匹配规则或无 `permission_roles` 记录的员工 → `role=staff, scope=其所在门店`
>
> **软删除**: `deleted_at IS NOT NULL` 的记录不参与权限查询。手动撤销权限时标记 `deleted_at` 而非物理删除，保留审计痕迹。

---

## 5. 组织架构

组织架构为**矩阵结构**，每个员工同时归属两个维度：

### 5.1 地理线（scope 域来源）

```
品牌总部 ──────────── stores (scope_level='global', store_name='总部')
├── 南昌市场 ──────── stores (scope_level='market', store_name='南昌市场')
│   ├── 南昌A店 ──── stores (scope_level='store')
│   ├── 南昌B店 ──── stores (scope_level='store')
│   └── ...
├── 南商市场 ──────── stores (scope_level='market', store_name='南商市场')
│   └── ...
└── ...（~20 个市场，~100 家门店）
```

### 5.2 职能线（部门 × 职位）

```
部门（PG departments 表）
├── 美容部 → 门店经理、美容师、实习美容师 …
├── 推广部 → 推广经理、推广师 …
├── 养生部 → 养生师 …
├── 财智部 → 财务主管、会计 …
├── 市场管理中心 → 市场总监、片区经理 …
└── ...
```

### 5.3 矩阵交叉

- 每个员工在 `employees` 表中有 `store_name`（地理归属）和 `department_name` + `position_name`（职能归属）
- 权限由 `permission_roles` 表决定：`role`（能做什么）× `scope_id`（看到哪些数据）
- 域类型与组织层级关系：
  - `global`：总部人员 → 全局数据
  - `market`：市场管理中心人员 → 该市场下所有门店数据
  - `store`：门店人员 → 仅本门店数据
- 跨部门营业额分配时，各部门可各按实收金额分配

---

## 6. 权限与角色（RBAC + Scope）

### 6.1 核心模型

权限 = **Role**（角色，能做什么）× **Scope**（域，看到哪些数据）× **Resource**（资源，操作对象）

- **Role** 存储在 `permission_roles.role`
- **Scope** 存储在 `permission_roles.scope_id` → `stores.store_id`（通过 `stores.scope_level` 区分域级别）
- **Resource** 由各 API 路由硬编码声明

### 6.2 角色定义

| 角色 | 标识 | 说明 | 能力 |
|------|------|------|------|
| 经理 | `manager` | 门店经理/市场总监/片区经理 | 开单、确认线下收款、重置支付失败订单、查看/分配营业额、推进服务单状态、查看完整顾客手机号、创建体验单、触发数据同步 |
| 财务 | `finance` | 财智部人员 | 查看营业额、查看订单列表/详情、查看顾客消费汇总；**不可开单**、**不可操作服务单** |
| 员工 | `staff` | 美容师、推广师等一线员工 | 查看自己负责的服务单、推进被分配给自己的服务单状态；**不可开单**、**不可查看完整手机号** |

> 顾客（客户端）不属于 RBAC 体系，其权限仍为：自助下单、发起微信支付/选择线下付款、查看自己的订单与预约。

### 6.3 域定义

| 域级别 | `scope_level` | 数据边界 | 典型角色 |
|--------|---------------|----------|----------|
| 全局 | `global` | 所有门店数据，无过滤 | 总部管理人员 |
| 市场 | `market` | 该市场下所有门店数据（`WHERE market_name = ?`） | 市场总监、片区经理、市场财务 |
| 门店 | `store` | 仅本门店数据（`WHERE store_name = ?`） | 门店经理、美容师、门店财务 |

域级别存储在 `stores.scope_level` 字段中，与 `permission_roles.scope_id` 通过 FK 关联。

### 6.4 权限矩阵

| Resource | Action | manager | finance | staff |
|----------|--------|---------|---------|-------|
| 订单 | create（开单） | ✅ | ❌ | ❌ |
| 订单 | list / detail | ✅ scope 内 | ✅ scope 内 | ✅ scope 内（仅本门店） |
| 订单 | confirmOffline | ✅ scope 内 | ❌ | ❌ |
| 订单 | close / resetFailed | ✅ scope 内 | ❌ | ❌ |
| 营业额分配 | save / delete | ✅ scope 内 | ❌ | ❌ |
| 营业额分配 | view（查看） | ✅ scope 内 | ✅ scope 内 | ❌ |
| 服务单 | create / start / complete | ✅ scope 内 | ❌ | ✅ 仅 assigned_staff |
| 服务单 | list / detail | ✅ scope 内 | ❌ | ✅ 仅 assigned_staff |
| 预约 | list / confirm / checkin | ✅ scope 内 | ❌ | ✅ scope 内（仅本门店） |
| 顾客 | search / detail | ✅ scope 内（完整手机号） | ✅ scope 内（完整手机号） | ✅ scope 内（脱敏手机号） |
| 顾客 | calendar（消费日历） | ✅ scope 内 | ✅ scope 内 | ✅ scope 内（仅本门店） |
| 员工 | list / departments | ✅ scope 内 | ✅ scope 内 | ✅ scope 内（仅本门店） |
| 同步 | full（触发全量同步） | ✅ | ❌ | ❌ |

### 6.5 角色+域查询

登录时从 `permission_roles` JOIN `stores` 查询角色和域：

```sql
SELECT pr.role, s.scope_level, s.store_id, s.store_name, s.market_name
FROM permission_roles pr
JOIN stores s ON pr.scope_id = s.store_id
WHERE pr.staff_id = $1 AND pr.deleted_at IS NULL
```

**无记录时降级**：查询 `employees` 获取 `store_name`，匹配 `stores.store_id`，降级为 `role=staff, scope_level=store`。

### 6.6 auth 上下文结构

`ctx.auth` 保留现有字段，新增 `role` + `scope`：

```js
ctx.auth = {
  // 现有字段（保留）
  userId,        // staff_wechat_users.user_id
  openid,        // 微信 openid
  phone,         // 绑定手机号
  staffWfId,     // employees.employee_no
  position,      // employees.position_name（保留兼容）
  storeName,     // employees.store_name
  marketName,    // employees.market_name
  department,    // employees.department_name
  // 新增
  role,          // 'manager' | 'finance' | 'staff'
  scope: {
    level,       // 'global' | 'market' | 'store'
    storeId,     // stores.store_id（scope 指向的条目）
    storeName,   // scope 条目的 store_name
    marketName,  // scope 条目的 market_name（global 时为 null）
  }
}
```

### 6.7 域过滤 SQL 模式

所有涉及门店数据的查询统一通过 `buildScopeWhere()` 生成过滤条件：

```js
function buildScopeWhere(scope, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  switch (scope.level) {
    case 'global':
      return { where: '', params: [] }; // 无过滤
    case 'market':
      return { where: `AND ${prefix}market_name = $N`, params: [scope.marketName] };
    case 'store':
      return { where: `AND ${prefix}store_name = $N`, params: [scope.storeName] };
  }
}
```

> `$N` 为参数占位符序号，由调用方动态替换。

### 6.8 代理经理/实习经理处理

- 代理经理（position_name 包含"代理"）、实习经理：同步脚本默认推导为 `role=staff`
- 如需赋予经理权限，由上级通过 `permission_roles` 表手动升级为 `role=manager`
- 手动分配的记录 `created_by` 标记为操作人员工编号（区别于同步脚本的 `'sync'`）

---

## 7. 核心业务规则

1. 只有 **role=manager** 可开单，finance 和 staff 无开单权限
2. **营业额分配**：同部门总额 ≤ 实收；跨部门各按实收金额分配（总额可达实收 2 倍）；**MVP 阶段不支持优惠/折扣，应收金额 = 实收金额**
3. **美容师选择非必须**：顾客下单时可不指定美容师
4. **日历入账口径**：仅 `已支付` 订单计入当日消费
5. **混购完成规则**：订单包含多类项目时，`已完成` 以**所有疗程卡行与单品行的 remaining_sessions 全部归零**为触发条件；院装产品行支付即视为该行已交付
6. **幂等要求**：支付回调、服务完成两类接口必须幂等
7. **线下付款口径**（仅 MVP）：顾客端选择线下付款先进入 `待确认收款`，店长确认后才计为 `已支付`
8. 支付成功触发条件统一为**订单进入已支付**
9. 订单在员工端开单时即写入数据库（状态 `待支付`），客户扫码后无需重复创建
10. 订单关闭/支付失败时，对应的营业额分配记录一并标记为无效（`is_void = true`）
11. **疗程卡并发扣减**：使用原子 UPDATE（`rowCount` 校验），禁止先 SELECT 后 UPDATE
12. **护理单来源约束**：`service_items.item_flow_no` 必须关联已支付订单的 `order_items` 行
13. **体验/引流服务**需先创建体验单（`order_type = 体验`），支付确认后再创建护理单；**先服务后付款不在 MVP 范围**
14. **顾客端自助下单的营业额分配**：
    - 已指定美容师：系统自动以该美容师为唯一被分配人创建分配记录
    - 未指定美容师：不创建分配记录
15. **营业额分配锁定规则**：待支付且顾客未扫码时可修改；扫码后锁定
16. **手机号补全机制**：顾客绑定手机号时，批量补全 `orders.client_user_id`；同时查询 `customers.phone` 自动关联 `customer_no`
17. **员工开单顾客身份验证**：通过手机号查询 `client_wechat_users.phone` 和 `customers.phone`，填入 `client_user_id` 和 `customer_no`
18. **预约取消后可重新发起**：`已取消` 可重新发起；`已关闭` 不可
19. **数据同步不影响业务**：WorkFine → PG 同步使用 UPSERT，不锁表不中断在线查询

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

## 10. 实时通信

**需求**:
- 订单进入已支付后即时通知员工端
- 员工端日历在 **5 秒内**出现消费标记

**兜底机制**:
- WebSocket 断开时，员工端在 **30 秒内**通过轮询同步

> MVP 阶段通知技术方案待定，但 5 秒实时性和 30 秒轮询兜底为硬指标。

---

## 11. 核心接口列表

### 11.1 clientApi（顾客端）

| 模块 | 接口 | 说明 | 实现状态 |
|------|------|------|---------|
| auth | login, bindPhone, bindStore | 微信登录、手机号绑定（含 customer_no 自动关联）、门店绑定 | 已实现（需补 customer_no） |
| store | list, detail, requestUnbind, getUnbindRequest, cancelUnbindRequest, geocode | 门店 CRUD + 解绑 + 定位 | 需适配 |
| product | categories, spuList, skuDetail, spuDetail, hotList, shopInit | 商品浏览 | 已实现 |
| staff | list, default | 美容师列表 | 需适配 |
| order | create, pay, alipayPay, offlinePay, list, detail, cancel, appointableItems, scanDetail | 订单全流程（含 customer_no 写入） | 已实现（需补 customer_no） |
| appointment | create, list, cancel | 预约管理 | 已实现 |
| service | detail | 服务单只读 | 已实现 |

### 11.2 staffApi（员工端）

| 模块 | 接口 | 说明 | 实现状态 |
|------|------|------|---------|
| auth | login, bindPhone | 员工登录、手机号绑定 | 需适配 |
| store | list, unbindRequests, approveUnbind, rejectUnbind | 门店 | 需适配 |
| staff | list, departments, todayCommission, monthlyCalendar, todoList, bindStore | 员工 | 需适配 |
| product | shopInit, categories, spuList, skuDetail, spuDetail, promotionList, promotionPlans | 商品浏览 | 需适配 |
| customer | search, calendar, detail, paidOrders | 顾客档案 | 需适配 |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail | 订单全流程（含 customer_no 写入） | 已实现（需补 customer_no） |
| allocation | save, deleteAllocation, getCommissionRates, pendingList, suggest | 营业额分配 | 需适配 |
| appointment | list, detail, confirm, checkin | 预约管理 | 已实现 |
| service | create, start, complete, cancel, list, detail | 服务单全流程 | 已实现 |
| **sync** | **full** | **WorkFine → PG 全量同步（店长权限）** | 待实现 |

### 11.3 跨端接口

| 接口 | 说明 |
|------|------|
| 用户认证 | 微信小程序登录、手机号绑定 |
| 幂等控制 | 下单、支付回调、服务完成接口幂等校验 |
| 实时推送 | 订单进入已支付后即时通知员工端 |

---

## 12. 环境约束

| 约束 | 描述 |
|------|------|
| 疗程次数原子扣减 | `UPDATE ... SET remaining_sessions = remaining_sessions - n WHERE remaining_sessions >= n`，禁止先 SELECT 后 UPDATE |
| 价格快照不可变 | 开单时写入 `unit_price`，后续价格变动不影响历史订单 |
| 支付幂等 | 微信回调、线下确认、服务完成接口均需幂等 |
| 状态单向推进 | 唯一例外：店长可重置 `支付失败` → `待支付` |
| 域数据隔离 | 所有 PG 查询以 scope 过滤（global 无过滤 / market 按 `market_name` / store 按 `store_name`），由 `buildScopeWhere()` 统一生成 |
| 订单号唯一生成 | advisory lock 防流水号并发冲突 |
| 待支付订单唯一 | 部分唯一索引 + 应用层校验 |
| 事务处理 | 服务单完成、订单创建、分配保存均使用 PostgreSQL transaction |
| 连接池限制 | PG max 5（业务查询） |
| 响应格式 | `{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403 |
| 运行时零 MSSQL | 业务请求链路不连接 WorkFine SQL Server |

---

## 13. MVP 验收标准

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-01 | 订单进入 `已支付` 后，员工端顾客日历在 **5 秒内**出现当日消费标记 | 支付 → 5 秒内刷新日历 |
| AC-02 | WebSocket 断开情况下，员工端在 **30 秒内**通过轮询看到同一笔消费 | 断网恢复后 30 秒内数据同步 |
| AC-03 | 同一笔订单无论重复提交多少次，在日历中仅计入一次 | 重复确认 → 日历不重复标记 |
| AC-04 | 同一服务单重复点击"完成服务"不产生重复扣次 | 连续点击完成 → 仅扣一次 |
| AC-05 | 角色越权操作应被拒绝 | 越权操作 → 返回 -403 |
| AC-06 | PG stores/employees/customers 表数据与 WorkFine 源数据一致 | 同步后对比关键字段 |
| AC-07 | 员工端门店列表、员工列表、顾客搜索均从 PG 查询，响应时间 < 500ms | 接口计时 |
| AC-08 | WorkFine 连接断开时，门店/员工/顾客查询不受影响（使用 PG 已同步数据） | 断开 MSSQL → 验证查询正常 |
| AC-09 | 手动触发全量同步后，新增/变更的门店/员工/顾客数据在 PG 中更新 | 在 WorkFine 修改 → 触发同步 → 验证 PG |
| AC-10 | 小程序中完成开单后，PG orders 表中 customer_no 正确关联 | 开单 → 查询 orders.customer_no |

---

## 附录 A: 全局关联图

```
PG 实体（同步实体以 ★ 标注）

★ stores (门店, scope_level: global/market/store) ←── store_name ──→ 被 orders/service_orders/appointments 等引用（快照）
│   └── store_id ←── permission_roles.scope_id（域目标）
★ departments (部门) ←── department_name ──→ 被 employees/revenue_allocations 引用
★ positions (职位) ←── (position_name, department_name) ──→ 被 employees 引用
★ employees (员工) ←── employee_no ──→ 被以下字段引用：
│   ├── staff_wechat_users.staff_wf_id
│   ├── orders.preferred_staff_wf_id / opened_by
│   ├── service_orders.assigned_staff_wf_id
│   ├── service_items.employee_id
│   ├── revenue_allocations.employee_id
│   └── appointments.staff_wf_id
permission_roles (权限角色分配)
│   ├── staff_id ──→ employees.employee_no
│   └── scope_id ──→ stores.store_id（global/market/store 级别条目）
★ customers (顾客档案) ←── customer_no ──→ 被以下字段引用：
│   ├── client_wechat_users.customer_no
│   └── orders.customer_no

client_wechat_users (客户端微信用户)
│   ├── user_id ──→ orders.client_user_id
│   ├── user_id ──→ appointments.client_user_id
│   ├── user_id ──→ service_orders.client_user_id
│   └── customer_no ──→ customers.customer_no（手机号匹配）

product_categories ──→ products (1:N, via category_id)
products ──→ product_skus (1:N, via product_id)
                    │
                    └── sku_id ──→ order_items.sku_id / service_items.sku_id

orders ──→ order_items (1:N)
│   ├── order_no ──→ revenue_allocations (1:N)
│   └── customer_no ──→ customers
order_items ──→ service_items (1:N, 通过 item_flow_no)

service_orders ──→ service_items (1:N)
│   └── appointment_id ──→ appointments (1:1, 可选)

revenue_allocations ──→ revenue_allocation_items (1:N)
```
