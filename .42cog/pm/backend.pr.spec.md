# 凤御双美容院 — 后端服务产品需求规格书

> **文档版本**: 2.0.0
> **范围**: 后端服务（CloudBase 云函数 + 双数据库）
> **约束文档**: `.42cog/real.md` v2.0.0 | `.42cog/cog.md` v2.0.0
> **端 spec 引用**: `client.pr.spec.md` v1.0.0 | `staff.pr.spec.md` v1.0.0
> **日期**: 2026-03-10
>
> **v2.0 重大架构变更**: **WorkFine 全部数据域建立 PG 实体，定期从 WorkFine 同步**。运行时业务查询 100% 走 PG，WorkFine SQL Server 仅作为同步源，不参与在线请求链路。

---

## 1. 概述

**定位**: 凤御双美容院微信小程序生态系统的统一后端服务层，为顾客端（C端）和员工端（B端）提供 API 网关、业务逻辑、数据持久化和跨端协调。

**技术栈**:

| 项 | 方案 |
|----|------|
| 前端 | 微信小程序（客户端 + 员工端，共两个小程序） |
| 后端 | CloudBase 云函数（Node.js 18） |
| 主数据同步源 | WorkFine SQL Server（只读，全部数据域定期同步至 PG；**运行时不参与在线请求**） |
| 小程序数据库 | PG 自托管数据库（读写，含同步实体） |
| SQL Server 驱动 | `mssql`（node-mssql）npm 包，仅同步模块使用 |
| 支付 | 微信支付多商户模式（特约商户）+ 线下付款标记 |
| 实时通信 | WebSocket 或小程序订阅消息 |
| 权限 | 基于角色的访问控制（店长/美容师），微信 openid 关联 |

---

## 2. 技术架构

```
小程序（客户端 + 员工端）
    ↓
CloudBase 云函数（Node.js）
    ├── PG 自托管数据库（业务数据 + 全部 WorkFine 同步实体）
    │     ↑ 运行时：所有业务查询 100% 走 PG
    └── WorkFine SQL Server DB（只读，仅同步模块连接，不参与在线请求链路）
```

**云函数网关模式**: 每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

| 云函数 | 端口 | envId |
|--------|------|-------|
| `clientApi` | 顾客端 | `cloud1-3gpht4b01ff88838` |
| `staffApi` | 员工端 | `cloud1-9g3ydpg512eecc99` |
| `payNotify` | 支付回调 | 同 clientApi |

---

## 3. 数据对接策略

### 3.1 WorkFine 连接信息

- **服务器**: `47.96.87.33:1433`
- **数据库**: `wkdb_20220804_86cd3292`
- **平台**: WorkFine 万应低代码平台
- **重要**: WorkFine 数据库所有表均为**只读**，小程序不直接写入 WorkFine

### 3.2 数据分布策略总览

| # | 数据域 | 存储位置 | 策略 | 说明 |
|---|--------|---------|------|------|
| 1 | **门店信息** | PG `stores` | **PG 实体 + WorkFine 同步** | 从 UDT_M_219 定期同步；所有业务查询走 PG |
| 2 | **部门/职位** | PG `departments` / `positions` | **PG 实体 + WorkFine 同步** | 从员工数据和 UDT_S_211/UDT_M_212 同步；角色判定、分配使用 PG |
| 3 | **员工信息** | PG `employees` | **PG 实体 + WorkFine 同步** | 从 UDT_S_287 定期同步；角色判定、营业额分配、服务单分配使用 PG |
| 4 | **顾客档案** | PG `customers` | **PG 实体 + WorkFine 同步** | 从 UDT_S_311 定期同步；顾客搜索、档案查看使用 PG |
| 5 | **品项分类** | PG `product_categories` | **PG 实体 + WorkFine 同步** | 从 UDT_M_229 同步；品项分类参考数据 |
| 6 | **可售项目** | PG `catalog_items` | **PG 实体 + WorkFine 同步** | 从 UDT_M_1281 + UDT_M_1383 统一同步；SKU 价格/次数从 PG 查询 |
| 7 | **院装产品** | PG `material_products` | **PG 实体 + WorkFine 同步** | 从 UDT_M_341 同步；SKU 价格从 PG 查询 |
| 8 | **促销方案** | PG `promotion_schemes` / `promotion_scheme_items` | **PG 实体 + WorkFine 同步** | 从 UDT_S_1459 + UDT_M_1460 同步 |
| 9 | **提成比例矩阵** | PG `commission_rate_matrix` | **PG 实体 + WorkFine 同步** | 从 UDT_S_1962 + UDT_M_1964 同步 |
| 10 | SPU 商品元数据 | PG `product_spu` / `product_spu_sku_map` | PG 读写 | 运营维护 |
| 11 | 订单/销售明细 | PG `orders` / `order_items` | PG 读写 | 参考 WorkFine UDT_S_209 结构 |
| 12 | 营业额分配 | PG `revenue_allocations` / `revenue_allocation_items` | PG 读写 | 参考 WorkFine UDT_M_217 结构 |
| 13 | 护理单/核销 | PG `service_orders` / `service_items` | PG 读写 | 参考 WorkFine UDT_S_259 结构 |
| 14 | 微信用户 | PG `client_wechat_users` / `staff_wechat_users` | PG 读写 | 两端独立 |
| 15 | 预约 | PG `appointments` | PG 读写 | — |

### 3.3 WorkFine → PG 同步策略

**同步方向**: WorkFine（上游权威源） → PG（本地工作副本），单向只读同步。

**同步范围**: **全部 WorkFine 数据域**（门店、部门/职位、员工、顾客、品项分类、可售项目、院装产品、促销方案、提成比例矩阵）。

**同步机制**:

| 触发方式 | 说明 |
|----------|------|
| 定时全量同步 | 每日凌晨自动执行一次全量同步（覆盖所有域） |
| 手动触发 | 员工端管理 API `sync.full`，店长权限，按需触发全量同步 |
| 冷启动预检 | 云函数冷启动时检查 `synced_at`，若超过 24 小时则触发增量同步 |

**同步顺序**（存在依赖）:
1. `stores`（门店）— 无依赖
2. `departments`（部门）— 无依赖
3. `positions`（职位）— 依赖 departments
4. `employees`（员工）— 依赖 stores、departments
5. `customers`（顾客档案）— 依赖 stores
6. `product_categories`（品项分类）— 无依赖
7. `catalog_items`（可售项目 + 门店自定义）— 依赖 product_categories
8. `material_products`（院装产品）— 无依赖
9. `promotion_schemes` + `promotion_scheme_items`（促销方案）— 依赖 catalog_items
10. `commission_rate_matrix`（提成比例）— 依赖 departments

**同步规则**:
- 以 WorkFine 主键（员工编号/顾客编号/门店名）为匹配键，存在则更新，不存在则插入（UPSERT）
- PG 侧不删除 WorkFine 中已不存在的记录（软标记：员工 `is_resigned = true`，门店 `is_closed = true`）
- 每条同步记录写入 `synced_at` 时间戳
- 同步操作在事务中执行，失败时回滚并记录错误日志
- 同步期间不影响业务读取（使用 UPSERT 而非 DELETE + INSERT）

### 3.4 架构收益

全部数据域同步到 PG 后的关键收益：
- **运行时零 MSSQL 依赖**: clientApi / staffApi 业务请求 100% 走 PG，不再运行时连接 SQL Server
- **WorkFine 故障不影响业务**: MSSQL 不可用时，仅同步模块受影响，所有在线查询正常
- **查询性能提升**: PG 本地查询取代远程 MSSQL 查询，可建索引优化
- **取消价格缓存**: 不再需要 5 分钟 TTL 模块级缓存（原为减轻 MSSQL 压力）
- **MSSQL 连接池仅限同步**: 同步时按需建立，业务函数不维护常驻连接

---

## 4. 数据模型

### 4.1 实体概览

| 实体 | PG 表 | 来源 | 关键字段 |
|------|-------|------|----------|
| **门店** | `stores` | WorkFine 同步 | store_name (UNIQUE), market_name, bed_count, is_closed |
| **部门** | `departments` | WorkFine 同步 | department_name (UNIQUE), department_code |
| **职位** | `positions` | WorkFine 同步 | position_name, department_name |
| **员工** | `employees` | WorkFine 同步 | employee_no (PK), name, phone, store_name, position_name, is_resigned |
| **顾客档案** | `customers` | WorkFine 同步 | customer_no (PK), name, phone, store_name, member_level |
| **品项分类** | `product_categories` | WorkFine 同步 | category_name (UNIQUE), big_category, sort_order |
| **可售项目** | `catalog_items` | WorkFine 同步 | item_no (PK), category, price, session_count, source |
| **院装产品** | `material_products` | WorkFine 同步 | product_no (PK), name, retail_price, spec |
| **促销方案** | `promotion_schemes` | WorkFine 同步 | scheme_no (PK), scheme_name, scheme_price |
| **促销方案明细** | `promotion_scheme_items` | WorkFine 同步 | id, scheme_no, item_no, promotion_price |
| **提成比例矩阵** | `commission_rate_matrix` | WorkFine 同步 | id, market_name, department_name, commission_rate |
| SPU 商品 | `product_spu` | PG 原生 | spu_id, name, category, big_category |
| SKU↔WorkFine 映射 | `product_spu_sku_map` | PG 原生 | sku_id, spu_id, workfine_item_id |
| 订单 | `orders` | PG 原生 | order_no, status, client_user_id, customer_no |
| 订单明细 | `order_items` | PG 原生 | item_flow_no, order_no, sku_id, remaining_sessions |
| 营业额分配 | `revenue_allocations` | PG 原生 | id, order_no, employee_id |
| 业绩分类明细 | `revenue_allocation_items` | PG 原生 | id, allocation_id, performance_category |
| 护理单 | `service_orders` | PG 原生 | service_order_no, status, assigned_staff_wf_id |
| 护理明细 | `service_items` | PG 原生 | service_item_id, item_flow_no, service_order_no |
| 客户端微信用户 | `client_wechat_users` | PG 原生 | user_id, openid, phone, customer_no |
| 员工端微信用户 | `staff_wechat_users` | PG 原生 | user_id, openid, phone, staff_wf_id |
| 预约 | `appointments` | PG 原生 | appointment_id, status, client_user_id |

### 4.2 stores（门店，同步自 WorkFine UDT_M_219）

| 字段 | 类型 | 说明 |
|------|------|------|
| `store_id` | string | 主键，UUID |
| `store_name` | string | 门店名称（唯一索引），业务主键，贯穿所有业务表 |
| `market_name` | string | 所属市场（如"南商市场"） |
| `opening_date` | date \| null | 开业时间 |
| `total_investment` | decimal \| null | 总投资款 |
| `bed_count` | integer \| null | 可用床位数 |
| `is_closed` | boolean | 是否停止营业，NOT NULL DEFAULT false |
| `closed_date` | date \| null | 关店日期 |
| `region` | string \| null | 门店所属区域（地理分类） |
| `wf_department_id` | string \| null | WorkFine 部门 ID 关联标识 |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **WorkFine 映射**: `store_name` ← `UDT_M_219.UDF_M_438`，`market_name` ← `UDT_M_219.UDF_M_437`，`is_closed` ← `UDF_M_11956 = '是'`。
>
> 现有业务表（orders、service_orders、appointments 等）的 `store_name` / `market_name` 字段保持文本存储（快照语义），不设 FK 约束。`stores` 表作为权威查找表，应用层通过 `store_name` 查询。

### 4.3 departments（部门，同步自 WorkFine 员工数据 + UDT_S_211）

| 字段 | 类型 | 说明 |
|------|------|------|
| `department_id` | string | 主键，UUID |
| `department_name` | string | 部门名称（唯一索引），如"美容部"、"推广部"、"养生部" |
| `department_code` | string \| null | 部门编码（来自 UDT_M_217.UDF_M_13714） |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **同步方式**: 初期从 `employees.department_name` 去重生成；后续 UDT_S_211/UDT_M_212 字段详情明确后改为直接同步。

### 4.4 positions（职位，同步自 WorkFine 员工数据 + UDT_M_212）

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
>
> **同步方式**: 初期从 `employees` 的 `(position_name, department_name)` 去重生成；后续 UDT_S_211/UDT_M_212 字段详情明确后改为直接同步。

### 4.5 employees（员工，同步自 WorkFine UDT_S_287）

| 字段 | 类型 | 说明 |
|------|------|------|
| `employee_no` | string | 主键，WorkFine 员工编号（格式 `FY-{YYMMDD}{序号}`） |
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

> **WorkFine 映射**: `employee_no` ← `UDF_S_1147`，`name` ← `UDF_S_1155`，`phone` ← `UDF_S_1152`，`store_name` ← `UDF_S_1163`，`position_name` ← `UDF_S_1161`，`department_name` ← `UDF_S_1513`，`is_resigned` ← `UDF_S_1624 = '是'`。
>
> **身份证号**（UDF_S_1154）为高敏 PII，不同步到 PG；需要时从 WorkFine 实时查询。
>
> **角色判定**: `position_name = '门店经理'` → 店长；其他 → 美容师。此判定现从 PG `employees` 表执行，不再实时查询 WorkFine。
>
> 现有业务表中引用员工编号的字段（`orders.preferred_staff_wf_id`、`orders.opened_by`、`service_orders.assigned_staff_wf_id`、`revenue_allocations.employee_id`、`service_items.employee_id`、`appointments.staff_wf_id`、`staff_wechat_users.staff_wf_id`）值即为 `employees.employee_no`。

### 4.6 customers（顾客档案，同步自 WorkFine UDT_S_311）

| 字段 | 类型 | 说明 |
|------|------|------|
| `customer_no` | string | 主键，WorkFine 顾客编号（格式 `FYGK-{YYYYMMDD}{序号}`） |
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

> **WorkFine 映射**: `customer_no` ← `UDF_S_1475`，`name` ← `UDF_S_1476`，`phone` ← `UDF_S_1478`，`store_name` ← `UDF_S_6443`，`member_level` ← `UDF_S_1477`，`primary_beautician` ← `UDF_S_6444`。完整映射见附录 A.1。
>
> **与 client_wechat_users 的关系**: `client_wechat_users.customer_no` → `customers.customer_no`（通过手机号自动关联）。顾客绑定手机号时，系统查询 `customers.phone` 匹配，将 `customer_no` 写入 `client_wechat_users`。并非所有 WorkFine 顾客都会注册小程序，也非所有小程序用户都有 WorkFine 档案，两表为可选关联。
>
> **顾客消费明细子表**（UDT_M_312）和**护理明细子表**（UDT_M_331）为 WorkFine 内部汇总视图，不同步到 PG；小程序消费数据从 PG 订单/护理单表查询。

### 4.7 product_categories（品项分类，同步自 WorkFine UDT_M_229）

| 字段 | 类型 | 说明 |
|------|------|------|
| `category_id` | string | 主键，UUID |
| `category_name` | string | 品项类型名称（唯一索引），如"蜜语生玑"、"科颜美" |
| `big_category` | string | 一级分类：`生美` / `非生美` |
| `sort_order` | integer | 排序序号 |
| `is_active` | boolean | 是否可用，NOT NULL DEFAULT true |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **WorkFine 映射**: `category_name` ← `UDT_M_229.UDF_M_522`，`big_category` ← `UDF_M_17416`，`sort_order` ← `UDF_M_521`，`is_active` ← `UDF_M_15996 = '是'`。
>
> 当前可用品项分类 21 种（详见附录 A.3.5）。`product_spu.category` 字段值来源于此表。

### 4.8 catalog_items（可售项目，统一同步自 WorkFine UDT_M_1281 + UDT_M_1383）

| 字段 | 类型 | 说明 |
|------|------|------|
| `item_no` | string | 主键，疗程项目编号（WorkFine UDF_M_14503） |
| `source` | enum | `national`（全国可售，UDT_M_1281）/ `store_custom`（门店自定义，UDT_M_1383） |
| `product_type` | string | 产品库类型：`疗程卡` / `单品` / `自定义-疗程` / `自定义-单品` |
| `category` | string | 品项分类（如"蜜语生玑"），对应 `product_categories.category_name` |
| `item_name` | string | 项目名称 |
| `session_count` | integer \| null | 疗程服务次数 |
| `unit` | string \| null | 计量单位 |
| `price` | decimal | 原价（即开单价格），**开单时从此字段快照到 order_items.unit_price** |
| `sub_category` | string \| null | 品项细分（三级） |
| `is_beauty` | string \| null | 是否生美：`生美` / `非生美` |
| `signature_tag` | string \| null | 招牌定位（仅全国项目） |
| `is_active` | boolean | 是否可用/启用，NOT NULL DEFAULT true |
| `effective_start` | date \| null | 版本生效日期（从目录主表 UDT_S_1280/1382 继承） |
| `effective_end` | date \| null | 版本失效日期 |
| `applicable_scope` | string \| null | 适用市场/门店范围（仅门店自定义项目） |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **WorkFine 映射**: `item_no` ← `UDF_M_14503`，`item_name` ← `UDF_M_14505`，`price` ← `UDF_M_14508`，`session_count` ← `UDF_M_14506`，`is_beauty` ← `UDF_M_17783`（全国）/ `UDF_M_17784`（自定义）。
>
> 统一 UDT_M_1281 和 UDT_M_1383 到一张表，通过 `source` 字段区分。版本有效期从对应主表（UDT_S_1280 / UDT_S_1382）平铺到 item 行。
>
> `product_spu_sku_map.workfine_item_id`（source = UDT_M_1281 或 UDT_M_1383）引用此表 `item_no`。
>
> 产品库 = "疗程卡" / "自定义-疗程" → 进入核销流程；产品库 = "单品" / "自定义-单品" → 支付即结束。

### 4.9 material_products（院装产品，同步自 WorkFine UDT_M_341）

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_no` | string | 主键，商品编号（WorkFine UDF_M_1870） |
| `name` | string | 产品名称 |
| `spec` | string \| null | 规格（如"285ml/瓶"） |
| `brand` | string \| null | 品牌简称 |
| `series` | string \| null | 产品系列 |
| `supplier` | string \| null | 供货商 |
| `management_center` | string \| null | 所属管理中心 |
| `retail_price` | decimal \| null | 顾客零售价，**开单时快照到 order_items.unit_price** |
| `accounting_price` | decimal \| null | 内部核算基准价 |
| `store_discount` | decimal \| null | 分院进货折扣率 |
| `store_price` | decimal \| null | 分院实际采购价 |
| `market_discount` | decimal \| null | 市场进货折扣率 |
| `market_price` | decimal \| null | 市场进货价 |
| `employee_discount` | string \| null | 员工内购折扣描述 |
| `employee_price` | decimal \| null | 员工内购价格 |
| `company_price` | decimal \| null | 公司进货价 |
| `is_orderable` | boolean | 是否可报货，NOT NULL DEFAULT true |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **WorkFine 映射**: `product_no` ← `UDF_M_1870`，`name` ← `UDF_M_1871`，`retail_price` ← `UDF_M_1875`。完整映射见附录 A.3.1。
>
> `product_spu_sku_map.workfine_item_id`（source = UDT_M_341）引用此表 `product_no`。

### 4.10 promotion_schemes（促销方案，同步自 WorkFine UDT_S_1459）

| 字段 | 类型 | 说明 |
|------|------|------|
| `scheme_no` | string | 主键，促销单编号（WorkFine UDF_S_17159） |
| `scheme_name` | string | 促销方案名称 |
| `start_date` | date | 起始时间 |
| `end_date` | date | 结束时间 |
| `cash_coupon_amount` | decimal \| null | 附带现金券金额 |
| `scheme_price` | decimal | 促销方案售价 |
| `applicable_scope` | string \| null | 适用市场/门店范围 |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **WorkFine 映射**: `scheme_no` ← `UDF_S_17159`，`scheme_name` ← `UDF_S_17175`，`scheme_price` ← `UDF_S_17193`，`applicable_scope` ← `UDF_S_17793`。

### 4.11 promotion_scheme_items（促销方案明细，同步自 WorkFine UDT_M_1460）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `scheme_no` | string | 关联 `promotion_schemes.scheme_no` |
| `item_no` | string | 疗程项目编号，关联 `catalog_items.item_no` |
| `product_type` | string | 产品库类型：`疗程卡` / `单品` |
| `category` | string \| null | 品项分类 |
| `item_name` | string | 项目名称 |
| `unit` | string \| null | 计量单位 |
| `session_count` | integer \| null | 疗程服务次数 |
| `original_price` | decimal | 原始标准售价 |
| `discount_amount` | decimal | 折扣金额 |
| `promotion_price` | decimal | 促销后实际售价 |
| `is_gift` | boolean | 是否赠送，NOT NULL DEFAULT false |
| `synced_at` | timestamp | 最近一次同步时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **WorkFine 映射**: `item_no` ← `UDF_M_17163`，`promotion_price` ← `UDF_M_17171`，`is_gift` ← `UDF_M_17174 = '是'`。
>
> `product_spu_sku_map.workfine_item_id`（source = UDT_M_1460）引用此表中的 `item_no`。

### 4.12 commission_rate_matrix（提成比例矩阵，同步自 WorkFine UDT_S_1962 + UDT_M_1964）

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

> **WorkFine 字段详情待补充**: UDT_S_1962 + UDT_M_1964 的具体字段未记录，上述 PG 设计基于已知维度（市场、部门、销售分类、金额阶段、比例）。待 WorkFine 表结构补充后调整映射。
>
> UNIQUE 约束：`(market_name, department_name, sales_category, amount_tier_min)`

### 4.13 product_spu（SPU 商品概念表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `spu_id` | string | 主键，UUID |
| `name` | string | 商品名称（如"蜜语生玑精华护理疗程"） |
| `category` | string | 品项分类（如"蜜语生玑"），对应 UDT_M_229.UDF_M_522；作为左侧选择器的一级导航节点 |
| `big_category` | enum | `促销方案` / `护理项目` / `家居产品` / `充值卡` |
| `cover_image` | string | 封面图 URL |
| `description` | string | 商品描述（选填） |
| `sort_order` | integer | 排序权重 |

> SPU 是否展示由 SKU 的 `is_active` 派生。左侧品项分类从 `product_spu` 动态派生。

### 4.14 product_spu_sku_map（SPU↔产品映射表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sku_id` | string | 主键，UUID |
| `spu_id` | string | 关联 product_spu.spu_id |
| `workfine_item_id` | string | 产品编号：`catalog_items.item_no` 或 `material_products.product_no`（字段名保留 workfine 前缀以兼容已有代码） |
| `workfine_source` | enum | 标识产品来源表：`UDT_M_1281` / `UDT_M_1383` → 查 `catalog_items`；`UDT_M_1460` → 查 `promotion_scheme_items`；`UDT_M_341` → 查 `material_products` |
| `product_type` | enum | `疗程卡` / `单品` / `院装产品`；决定核销流程 |
| `sku_display_name` | string | 规格展示名（如"10次卡"、"285ml/瓶"） |
| `sort_order` | integer | 规格排序 |
| `is_active` | boolean | 该 SKU 是否上架 |

> UNIQUE 约束：`(spu_id, workfine_item_id, workfine_source)`
>
> **v2.0 变更**: SKU 的价格、疗程服务次数等字段现从 PG 同步实体查询（`catalog_items.price` / `catalog_items.session_count` / `material_products.retail_price`），不再运行时连接 WorkFine。`workfine_source` 值保留原枚举名以兼容，运行时映射到对应 PG 表。

### 4.15 orders（订单主表，对应 WorkFine UDT_S_209）

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
| `customer_no` | string \| null | 关联 `customers.customer_no`；开单时通过手机号匹配自动填入（**v2.0 新增**） |
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
>
> **v2.0 变更**: 新增 `customer_no` 字段，开单时系统通过 `client_phone` 查询 `customers.phone` 自动匹配填入；顾客端自助下单时通过 `client_wechat_users.customer_no` 获取。

### 4.16 order_items（销售明细，对应 WorkFine UDT_M_213）

| 字段 | 类型 | 说明 |
|------|------|------|
| `item_flow_no` | string | 主键，销售流水号，格式 `XSLSH-WX-{YYYYMMDD}{序号}` |
| `order_no` | string | 关联 `orders.order_no` |
| `sku_id` | string \| null | 关联 `product_spu_sku_map.sku_id` |
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

### 4.17 revenue_allocations（营业额分配，对应 WorkFine UDT_M_217）

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

### 4.18 revenue_allocation_items（业绩分类明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `allocation_id` | bigint | 关联 `revenue_allocations.id` |
| `item_flow_no` | string \| null | 关联 `order_items.item_flow_no` |
| `performance_category` | string | 业绩分类（销售分类） |
| `amount` | decimal | 该分类的分配金额 |
| `commission_rate` | decimal \| null | 提成比例快照 |

### 4.19 service_orders（护理单主表，对应 WorkFine UDT_S_259）

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

### 4.20 service_items（护理明细，对应 WorkFine UDT_M_260）

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_item_id` | string | 主键，UUID |
| `item_flow_no` | string | 关联 `order_items.item_flow_no`（核销锚点） |
| `service_order_no` | string | 关联 `service_orders.service_order_no` |
| `sku_id` | string \| null | 关联 `product_spu_sku_map.sku_id` |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | string | 服务美容师，关联 `employees.employee_no` |

### 4.21 client_wechat_users（客户端微信用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | string | 主键，系统自生成 |
| `openid` | string | 微信 openid（客户端 appid 下，唯一索引） |
| `session_key` | string | 微信 session_key |
| `phone` | string | 绑定手机号（唯一索引） |
| `customer_no` | string \| null | 关联 `customers.customer_no`，手机号匹配后自动填入（**v2.0 新增**） |
| `bound_store_name` | string | 绑定门店名 |
| `bound_market_name` | string | 绑定市场名 |
| `last_login_at` | timestamp | 最近登录时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **v2.0 变更**: 新增 `customer_no` 字段。绑定手机号时系统查询 `customers.phone` 匹配，将 `customer_no` 写入。后续可通过此字段直接获取顾客档案详情，无需实时查询 WorkFine。

### 4.22 staff_wechat_users（员工端微信用户）

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

### 4.23 appointments（预约）

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

---

## 5. 组织架构

```
品牌总部
└── 市场（如南商市场）
    ├── 部门（美容部、推广部等）→ PG departments 表
    └── 门店 → PG stores 表
        ├── 门店经理（店长）→ PG employees 表，position_name = '门店经理'
        └── 美容师 → PG employees 表
```

- 门店经理（店长）直属**美容部**
- 其他部门（推广部等）从门店所属**市场**的 `employees` 表查询
- 跨部门营业额分配时，各部门可各按实收金额分配
- 组织架构数据（门店、部门、员工）全部从 PG 查询，不再实时读取 WorkFine

---

## 6. 权限与角色

| 角色 | 权限范围 |
|------|----------|
| 店长（门店经理） | 开单、确认线下收款、重置支付失败订单、查看/分配营业额、推进服务单状态、查看完整顾客手机号、创建体验单、触发数据同步 |
| 美容师 | 查看自己负责的服务单、推进被分配给自己的服务单状态；**不可开单**、**不可查看完整手机号** |
| 顾客（客户端） | 自助下单、发起微信支付/选择线下付款、查看自己的订单与预约 |

- 权限校验以登录用户的 `staff_wf_id` 在 PG `employees` 表中的 `position_name` 为依据，由云函数中间件统一拦截
- 角色判定：`employees.position_name = '门店经理'` → 店长；其他 → 美容师
- 服务单状态推进：仅**店长**或 `service_orders.assigned_staff_wf_id` 匹配的服务人员可操作
- 门店数据隔离：所有 PG 查询以 `store_name` 过滤，禁止跨门店访问

---

## 7. 核心业务规则

1. 只有**店长（门店经理）**可开单，普通美容师无开单权限
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
17. **员工开单顾客身份验证**：通过手机号查询 `client_wechat_users.phone` 和 `customers.phone`（**v2.0 变更**），填入 `client_user_id` 和 `customer_no`
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
| WorkFine 同步失败 | 回滚事务，记录错误日志；业务查询使用 PG 已有数据（可能有延迟），不阻塞业务流程 |
| WorkFine 连接不可用 | 仅同步模块受影响；**所有业务查询（含产品/促销/提成）正常运行**，使用 PG 已同步数据 |

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
| store | list, detail, requestUnbind, getUnbindRequest, cancelUnbindRequest, geocode | 门店 CRUD + 解绑 + 定位（**v2.0: 改为查 PG stores 表**） | 需适配 |
| product | categories, spuList, skuDetail, spuDetail, hotList, shopInit | 商品浏览 | 已实现 |
| staff | list, default | 美容师列表（**v2.0: 改为查 PG employees 表**） | 需适配 |
| order | create, pay, alipayPay, offlinePay, list, detail, cancel, appointableItems, scanDetail | 订单全流程（含 customer_no 写入） | 已实现（需补 customer_no） |
| appointment | create, list, cancel | 预约管理 | 已实现 |
| service | detail | 服务单只读 | 已实现 |

### 11.2 staffApi（员工端）

| 模块 | 接口 | 说明 | 实现状态 |
|------|------|------|---------|
| auth | login, bindPhone | 员工登录、手机号绑定（**v2.0: 改为匹配 PG employees 表**） | 需适配 |
| store | list, unbindRequests, approveUnbind, rejectUnbind | 门店（**v2.0: 改为查 PG stores 表**） | 需适配 |
| staff | list, departments, todayCommission, monthlyCalendar, todoList, bindStore | 员工（**v2.0: 改为查 PG employees/departments 表**） | 需适配 |
| product | shopInit, categories, spuList, skuDetail, spuDetail, promotionList, promotionPlans | 商品浏览（**v2.0: 改为查 PG catalog_items/material_products/promotion_schemes**） | 需适配 |
| customer | search, calendar, detail, paidOrders | 顾客档案（**v2.0: 改为查 PG customers 表**） | 需适配 |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail | 订单全流程（含 customer_no 写入） | 已实现（需补 customer_no） |
| allocation | save, deleteAllocation, getCommissionRates, pendingList, suggest | 营业额分配（**v2.0: 员工查 PG，提成比例查 PG commission_rate_matrix**） | 需适配 |
| appointment | list, detail, confirm, checkin | 预约管理 | 已实现 |
| service | create, start, complete, cancel, list, detail | 服务单全流程 | 已实现 |
| **sync** | **full** | **WorkFine → PG 全量同步（店长权限）**（**v2.0 新增**） | 待实现 |

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
| 门店数据隔离 | 所有 PG 查询以 `store_name` 过滤，禁止跨门店访问 |
| 订单号唯一生成 | advisory lock 防流水号并发冲突 |
| 待支付订单唯一 | 部分唯一索引 + 应用层校验 |
| 事务处理 | 服务单完成、订单创建、分配保存均使用 PostgreSQL transaction |
| ~~价格缓存~~ | ~~WorkFine 价格查询 5 分钟 TTL~~ → **v2.0 废弃**：价格从 PG 查询，无需缓存 |
| 连接池限制 | PG max 5（业务查询）；MSSQL 仅同步时按需建立连接，业务函数不维护常驻 MSSQL 连接池 |
| 响应格式 | `{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403 |
| **同步 UPSERT** | WorkFine → PG 同步使用 UPSERT（INSERT ... ON CONFLICT UPDATE），不使用 DELETE + INSERT（**v2.0 新增**） |
| **同步事务** | 每个域（门店/部门/员工/顾客）的同步在独立事务中执行，单域失败不影响其他域（**v2.0 新增**） |
| **同步频率** | 全量同步每日一次；手动触发不限；不设实时增量同步（**v2.0 新增**） |
| **运行时零 MSSQL** | 业务请求链路不连接 WorkFine SQL Server；MSSQL 仅在同步模块中使用（**v2.0 新增**） |

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

## 附录 A: WorkFine 数据库表结构参考

> 以下为 WorkFine 数据库（SQL Server）中与小程序对接的核心表结构，作为 PG 实体设计和同步实现的参考。
> **数据库**: `wkdb_20220804_86cd3292`，**所有表均为只读**。

### A.1 顾客档案（同步至 PG `customers` 表）

**WorkFine 表单 ID**: 295 | **数据量**: 51,117 条

#### 表间关联

```
UDT_S_311（顾客档案主表）
  ├── RID ──→ UDT_M_312（消费明细，一对多）— 不同步
  └── RID ──→ UDT_M_331（护理明细，一对多）— 不同步
```

#### A.1.1 顾客档案主表 — UDT_S_311

| WorkFine 字段 | 含义 | 类型 | → PG `customers` 字段 |
|---------------|------|------|----------------------|
| UDF_S_1475 | **顾客编号** | 文本 | `customer_no` (PK) |
| UDF_S_1476 | 顾客姓名 | 文本 | `name` |
| UDF_S_1478 | 手机号码 | 手机 | `phone` |
| UDF_S_1479 | 生日 | 日期 | `birthday` |
| UDF_S_1480 | 年龄 | 整数 | `age` |
| UDF_S_6443 | 所属分院 | 文本 | `store_name` |
| UDF_S_6486 | 所属市场 | 文本 | `market_name` |
| UDF_S_1477 | 会员等级 | 文本 | `member_level` |
| UDF_S_18105 | 会员分类标签 | 文本 | `member_tag` |
| UDF_S_6446 | 顾客来源 | 文本 | `customer_source` |
| UDF_S_6444 | 所属美容师 | 文本 | `primary_beautician` |
| UDF_S_6447 | 肤质类型 | 文本 | `skin_type` |
| UDF_S_6448 | 改善重点 | 文本 | `improvement_focus` |
| UDF_S_19093 | 皮肤问题 | 文本 | `skin_issue` |
| UDF_S_19094 | 接受养生方式 | 文本 | `wellness_preference` |
| UDF_S_1481 | 职业 | 文本 | `occupation` |
| UDF_S_1482 | 是否已婚 | 文本 | `is_married` |
| UDF_S_1486 | 是否共享 | 文本 | `is_shared` |
| UDF_S_1712 | 顾客分类 | 文本 | `category` |
| UDF_S_6445 | 微信名 | 文本 | `wechat_name` |
| UDF_S_1474 | 登记时间 | 日期 | `registered_at` |
| UDF_S_1717 | 累计消费金额 | 金额 | `total_consumption` |
| UDF_S_1718 | 单笔最高金额 | 金额 | `max_single_consumption` |
| UDF_S_17850 | 未到店时间间隔 | 文本 | `days_since_last_visit` |
| UDF_S_17758 | 本年度总消费档位 | 文本 | — 不同步 |
| UDF_S_17759 | 本年度生美消费档位 | 文本 | — 不同步 |
| UDF_S_18104 | 2022年累计消费 | 金额 | — 不同步 |
| UDF_S_17856 | 2023年累计消费 | 金额 | — 不同步 |
| UDF_S_17857 | 2024年累计消费 | 金额 | — 不同步 |
| UDF_S_17858 | 2025年累计消费 | 金额 | — 不同步 |

#### A.1.2 顾客消费明细子表 — UDT_M_312（不同步）

每位顾客的购买记录明细，通过 `RID` 关联主表 UDT_S_311。关联 `UDF_M_1499`（销售流水号）= `UDT_M_213.UDF_M_852`。

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_1494 | 所属市场 | 文本 | — |
| UDF_M_1495 | 所属门店 | 文本 | — |
| UDF_M_1496 | 销售日期 | 日期 | — |
| UDF_M_1497 | 业绩类型 | 文本 | 售前一次 / 售后 / 老带新等 |
| UDF_M_1498 | 销售单号 | 文本 | 关联 UDT_S_209.UDF_S_372 |
| UDF_M_1499 | 销售流水号 | 文本 | 关联 UDT_M_213.UDF_M_852 |
| UDF_M_1500 | 品项分类 | 文本 | — |
| UDF_M_1501 | 项目名称 | 文本 | — |
| UDF_M_1502 | 疗程服务次数 | 金额 | — |
| UDF_M_1503 | 销售金额 | 金额 | — |
| UDF_M_1504 | 单价优惠 | 金额 | — |

#### A.1.3 顾客护理明细子表 — UDT_M_331（不同步）

每位顾客的到店护理记录，通过 `RID` 关联主表 UDT_S_311。关联 `UDF_M_1752`（护理单编号）。

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_1748 | 所属市场 | 文本 | — |
| UDF_M_1749 | 所属门店 | 文本 | — |
| UDF_M_1750 | 服务日期 | 日期 | — |
| UDF_M_1751 | 顾客类型 | 文本 | — |
| UDF_M_1752 | 护理单编号 | 文本 | 关联 UDT_S_259/UDT_S_762 |
| UDF_M_1753 | 项目名称 | 文本 | — |
| UDF_M_1754 | 划卡次数 | 金额 | — |
| UDF_M_1755 | 员工职位 | 文本 | — |
| UDF_M_1756 | 员工姓名 | 文本 | — |
| UDF_M_1757 | 服务费 | 金额 | — |

### A.2 员工信息（同步至 PG `employees` 表）

#### A.2.1 人事档案 — UDT_S_287（Form 264）

**数据量**: 2,846 条（含在职 + 离职）

| WorkFine 字段 | 含义 | 类型 | → PG `employees` 字段 |
|---------------|------|------|----------------------|
| UDF_S_1147 | **员工编号** | 文本 | `employee_no` (PK) |
| UDF_S_1155 | 姓名 | 文本 | `name` |
| UDF_S_1148 | 性别 | 文本 | `gender` |
| UDF_S_1152 | 手机号码 | 手机 | `phone` |
| UDF_S_1163 | 所属分院 | 文本 | `store_name` |
| UDF_S_1160 | 所属市场 | 文本 | `market_name` |
| UDF_S_1161 | 工作职位 | 文本 | `position_name` |
| UDF_S_1513 | 职能部门 | 文本 | `department_name` |
| UDF_S_1164 | 第二工作职位 | 文本 | `position2_name` |
| UDF_S_12921 | 第二部门 | 文本 | `department2_name` |
| UDF_S_10085 | 职级1 | 文本 | `rank1` |
| UDF_S_10086 | 职级2 | 文本 | `rank2` |
| UDF_S_1624 | 是否离职 | 文本 | `is_resigned`（'是' → true） |
| UDF_S_1149 | 出生日期 | 日期 | `birth_date` |
| UDF_S_1159 | 试用开始时间 | 日期 | `probation_start_date` |
| UDF_S_1162 | 转正日期 | 日期 | `regular_date` |
| UDF_S_1626 | 离职日期 | 日期 | `resigned_date` |
| UDF_S_1154 | 身份证号码 | 身份证 | — **不同步**（高敏 PII） |
| UDF_S_1150 | 年龄 | 整数 | — 不同步（可从 birth_date 计算） |

**常用查询条件**:
- 在职员工: `WHERE UDF_S_1624 = '否'` → PG: `WHERE is_resigned = false`
- 门店经理: `WHERE UDF_S_1161 = '门店经理'` → PG: `WHERE position_name = '门店经理'`

#### A.2.2 职位部门对应表 — UDT_S_211 / UDT_M_212（Form 211）

> **字段详情待补充**：现有文档未记录具体字段，需查询 WorkFine 实际表结构后补充。初期从员工数据派生部门和职位。

### A.3 产品与服务（同步至 PG，运行时从 PG 查询）

#### A.3.1 院装产品（UDT_S_340 主表 + UDT_M_341 子表）→ PG `material_products`

院装产品供应商档案（19 条），子表为产品明细（1,940 条）。

**UDT_M_341 关键字段**:

| 字段名 | 含义 | 类型 | → PG `material_products` 字段 |
|--------|------|------|------|
| UDF_M_1870 | **商品编号** | 文本 | `product_no` (UNIQUE) |
| UDF_M_1871 | 名称 | 文本 | `name` |
| UDF_M_1872 | 规格 | 文本 | `spec` |
| UDF_M_12636 | 品牌 | 文本 | `brand` |
| UDF_M_1874 | 产品系列 | 文本 | `series` |
| UDF_M_1875 | 顾客零售价 | 金额 | `retail_price` |
| UDF_M_1876 | 核算价 | 金额 | `cost_price` |
| UDF_M_7494 | 是否可报货 | 文本 | `is_orderable`（'是' → true） |

#### A.3.2 可售项目（UDT_S_1280 主表 + UDT_M_1281 子表）→ PG `catalog_items` (source='national')

面向顾客的服务项目/疗程卡目录，按有效期版本管理。主表 16 条，子表 481 条。

**UDT_M_1281 关键字段**:

| 字段名 | 含义 | 类型 | → PG `catalog_items` 字段 |
|--------|------|------|------|
| UDF_M_14503 | **疗程项目编号** | 文本 | `item_no` (UNIQUE per source) |
| UDF_M_14502 | 产品库 | 文本 | `product_type`（疗程卡/单品） |
| UDF_M_14504 | 品项分类 | 文本 | `category_name` |
| UDF_M_14505 | 项目名称 | 文本 | `name` |
| UDF_M_14506 | 疗程服务次数 | 整数 | `session_count` |
| UDF_M_14508 | 原价 | 金额 | `price` |
| UDF_M_17783 | 是否生美 | 文本 | `is_beauty`（'生美' → true） |
| UDF_M_17477 | 招牌定位 | 文本 | `position_tag` |

> 产品库 = "疗程卡" → 核销流程；产品库 = "单品" → 支付即结束。

#### A.3.3 门店自定义项目（UDT_S_1382 主表 + UDT_M_1383 子表）→ PG `catalog_items` (source='store_custom')

主表 35 条，子表 401 条。字段与 UDT_M_1281 高度一致，增加市场/门店范围字段。同步至 `catalog_items` 表，`source = 'store_custom'`，额外写入 `store_name` / `market_name` 范围字段。

#### A.3.4 促销方案（UDT_S_1459 主表 + UDT_M_1460 子表）→ PG `promotion_schemes` / `promotion_scheme_items`

主表 56 条，子表 285 条。

**UDT_S_1459 关键字段** → PG `promotion_schemes`:

| WorkFine 字段 | 含义 | → PG 字段 |
|---------------|------|-----------|
| UDF_S_17159 | 促销单编号 | `scheme_no` (UNIQUE) |
| UDF_S_17175 | 方案名 | `name` |
| UDF_S_17193 | 方案售价 | `total_price` |
| UDF_S_17793 | 促销范围 | `scope` |

**UDT_M_1460 关键字段** → PG `promotion_scheme_items`:

| WorkFine 字段 | 含义 | → PG 字段 |
|---------------|------|-----------|
| UDF_M_17163 | 疗程项目编号（关联 UDT_M_1281） | `item_no` |
| UDF_M_17171 | 促销售价 | `promo_price` |
| UDF_M_17174 | 是否赠送 | `is_gift`（'是' → true） |

#### A.3.5 品项分类（UDT_S_228 主表 + UDT_M_229 子表）→ PG `product_categories`

子表 38 条（21 种当前可用）。

| 字段名 | 含义 | → PG `product_categories` 字段 |
|--------|------|------|
| UDF_M_521 | 序号 | `sort_order` |
| UDF_M_522 | 项目类型 | `category_name` (UNIQUE) |
| UDF_M_15996 | 是否可用 | `is_active`（'是' → true） |
| UDF_M_17416 | 大分类 | `big_category` |

**当前可用品项分类（21 种）**: 缦之羽、蜜语生玑、中华神灸、歆笙泰妍、圣源养心、悠妃曼、美芯、安吉丽美颜之爱、科颜美、诺纤金、自定义-生美、自定义-单品、自定义-KS、自定义-SM、自定义-YM、娇莉芙-生美、娇莉芙-家居产品、娇莉芙-招牌、娇莉芙-王牌、娇莉芙-改变、娇莉芙-对外合作。

### A.4 门店信息（同步至 PG `stores` 表）

**Form ID**: 216

#### 表间关联

```
UDT_S_218（市场门店对应表主表）— 字段待补充
  └── RID ──→ UDT_M_219（门店列表，一对多）
```

#### UDT_M_219 门店列表子表

| WorkFine 字段 | 含义 | 类型 | → PG `stores` 字段 |
|---------------|------|------|-------------------|
| UDF_M_437 | 市场 | 文本 | `market_name` |
| UDF_M_438 | **门店** | 文本 | `store_name` (UNIQUE) |
| UDF_M_1777 | 开业时间 | 日期 | `opening_date` |
| UDF_M_1778 | 总投资款 | 金额 | `total_investment` |
| UDF_M_3683 | 部门ID | 文本 | `wf_department_id` |
| UDF_M_8590 | 可用床位 | 整数 | `bed_count` |
| UDF_M_11956 | 是否停止营业 | 文本 | `is_closed`（'是' → true） |
| UDF_M_11957 | 关闭日期 | 日期 | `closed_date` |
| UDF_M_12033 | 门店所属区域 | 文本 | `region` |

**常用查询条件**: `WHERE UDF_M_11956 != '是'` → PG: `WHERE is_closed = false`

### A.5 订单参考结构（PG 实体已建立，WorkFine 仅历史查阅）

#### A.5.1 分院销售单主表 — UDT_S_209（Form 210，62,119 条）

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_S_372 | **销售单号** | 文本 | 主键，格式 FY-XSD{YYMMDD}{序号} |
| UDF_S_348 | 市场 | 文本 | — |
| UDF_S_349 | 门店 | 文本 | — |
| UDF_S_350 | 日期 | 日期 | — |
| UDF_S_371 | 业绩类型 | 文本 | 售后 / 售前一次等 |
| UDF_S_1485 | 顾客编号 | 文本 | 关联 UDT_S_311.UDF_S_1475 |
| UDF_S_370 | 顾客姓名 | 文本 | 冗余存储 |
| UDF_S_507 | 收款合计 | 金额 | — |
| UDF_S_17178 | 促销方案选取 | 文本 | 关联 UDT_S_1459.UDF_S_17159 |
| UDF_S_844 | 本单业绩 | 金额 | — |
| UDF_S_4729 | 本单欠款合计 | 金额 | — |
| UDF_S_13710 | 销售类型 | 文本 | 全额销售 / 回单销售 |
| UDF_S_17315 | 是否锁客 | 文本 | — |
| UDF_S_18162 | 是否纳客 | 文本 | — |

#### A.5.2 销售明细子表 — UDT_M_213

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_852 | **销售流水号** | 文本 | 主键，格式 XSLSH-{YYYYMMDD}{序号} |
| UDF_M_4728 | 产品类型 | 文本 | 疗程卡 / 单品 / 自定义-疗程 / 自定义-单品 |
| UDF_M_14495 | 疗程项目编号 | 文本 | 关联 UDT_M_1281 |
| UDF_M_392 | 品项分类 | 文本 | — |
| UDF_M_393 | 项目名称 | 文本 | — |
| UDF_M_394 | 疗程服务次数 | 整数 | — |
| UDF_M_4949 | 原价 | 金额 | — |
| UDF_M_14494 | 销售数量 | 金额 | — |
| UDF_M_396 | 单价优惠 | 金额 | — |
| UDF_M_395 | 销售金额 | 金额 | 优惠后 |
| UDF_M_398 | 应收金额 | 金额 | — |
| UDF_M_399 | 实收金额 | 金额 | — |
| UDF_M_4939 | 赠送 | 文本 | 是 / 否 |
| UDF_M_7122 | 有效日期 | 日期 | — |
| UDF_M_4938 | 单次价格 | 金额 | — |
| UDF_M_400 | 顾客欠款 | 金额 | — |

#### A.5.3 营业额分配明细子表 — UDT_M_217

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_2316 | 员工编号 | 文本 | 关联 UDT_S_287.UDF_S_1147 |
| UDF_M_419 | 员工姓名 | 文本 | — |
| UDF_M_418 | 职位 | 文本 | — |
| UDF_M_13713 | 职位所属部门 | 文本 | — |
| UDF_M_13714 | 部门代码 | 文本 | — |
| UDF_M_420 | 个人业绩1眉眼 | 金额 | — |
| UDF_M_421 | 个人业绩2唇 | 金额 | — |
| UDF_M_422 | 祛斑点痣业绩 | 金额 | — |
| UDF_M_423 | 单品业绩 | 金额 | — |
| UDF_M_13715 | 核算金额 | 金额 | — |

#### A.5.4 收款方式明细子表 — UDT_M_1259

| 字段名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| UDF_M_14335 | 收款方式 | 文本 | 现金 / 扫码 / 刷卡 / 抖音收款 / 美团收款 / 第三方收款 |
| UDF_M_14336 | 金额 | 金额 | — |
| UDF_M_14337 | 说明 | 文本 | — |

### A.6 护理单参考结构（PG 实体已建立，WorkFine 仅历史查阅）

#### A.6.1 售前护理单（Form 763，84,096 条）

记录顾客**购买前**的体验/引流服务。

**主表 UDT_S_762 关键字段**: `UDF_S_821`（护理单编号）、`UDF_S_822`（服务日期）、`UDF_S_1491`（顾客编号）、`UDF_S_843`（预约/到店时间，售前独有）。

**子表 UDT_M_763 关键字段**: `UDF_M_835`（项目名称）、`UDF_M_4904`（拓客卡流水号，`TKKLS-` 前缀）、`UDF_M_836`（划卡次数）、`UDF_M_2472`（员工编号）。

#### A.6.2 售后护理单（Form 246，463,841 条）

记录顾客**购买疗程卡后**的每次到店消耗。

**主表 UDT_S_259 关键字段**: `UDF_S_821`（护理单编号）、`UDF_S_822`（服务日期）、`UDF_S_1491`（顾客编号）。

**子表 UDT_M_260 关键字段**: `UDF_M_835`（项目名称）、`UDF_M_4904`（销售流水号，`XSLSH-` 前缀，关联 UDT_M_213 核销疗程卡）、`UDF_M_836`（划卡次数）、`UDF_M_2472`（员工编号）。

#### A.6.3 售前 vs 售后护理单对比

| 维度 | 售前 (UDT_S_762) | 售后 (UDT_S_259) |
|------|-----------------|-----------------|
| 业务含义 | 购买前体验/引流 | 购买后疗程卡消耗 |
| 主要顾客类型 | 售前一次（87%） | 售后（96%） |
| 明细流水号前缀 | `TKKLS-`（拓客卡） | `XSLSH-`（销售流水号） |
| 是否关联销售单 | 否 | 是（核销疗程卡） |

---

## 附录 B: 全局关联图

```
PG 实体（v2.0 新增同步实体以 ★ 标注）

★ stores (门店) ←── store_name ──→ 被 orders/service_orders/appointments 等引用（快照）
★ departments (部门) ←── department_name ──→ 被 employees/revenue_allocations 引用
★ positions (职位) ←── (position_name, department_name) ──→ 被 employees 引用
★ employees (员工) ←── employee_no ──→ 被以下字段引用：
│   ├── staff_wechat_users.staff_wf_id
│   ├── orders.preferred_staff_wf_id / opened_by
│   ├── service_orders.assigned_staff_wf_id
│   ├── service_items.employee_id
│   ├── revenue_allocations.employee_id
│   └── appointments.staff_wf_id
★ customers (顾客档案) ←── customer_no ──→ 被以下字段引用：
│   ├── client_wechat_users.customer_no
│   └── orders.customer_no

client_wechat_users (客户端微信用户)
│   ├── user_id ──→ orders.client_user_id
│   ├── user_id ──→ appointments.client_user_id
│   ├── user_id ──→ service_orders.client_user_id
│   └── customer_no ──→ customers.customer_no（手机号匹配）

product_spu ──→ product_spu_sku_map (1:N)
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

### WorkFine → PG 同步交叉引用（运行时 100% PG，WorkFine 仅同步源）

```
WorkFine → PG 同步（全部数据域）:
  UDT_M_219 (门店)            ──sync──→ PG stores
  UDT_S_287 (员工)            ──sync──→ PG employees
  UDT_S_311 (顾客)            ──sync──→ PG customers
  UDT_S_211/UDT_M_212 (职位部门)──sync──→ PG departments / positions
  UDT_M_229 (品项分类)         ──sync──→ PG product_categories
  UDT_M_1281 (可售项目)        ──sync──→ PG catalog_items (source='national')
  UDT_M_1383 (门店自定义)       ──sync──→ PG catalog_items (source='store_custom')
  UDT_M_341 (院装产品)         ──sync──→ PG material_products
  UDT_S_1459/UDT_M_1460 (促销) ──sync──→ PG promotion_schemes / promotion_scheme_items
  UDT_S_1962/UDT_M_1964 (提成) ──sync──→ PG commission_rate_matrix

PG 内部引用:
  product_spu_sku_map.workfine_item_id → catalog_items.item_no / material_products.product_no
  promotion_scheme_items.item_no → catalog_items.item_no
```

---

## 附录 C: 数据量参考

| 表 | 记录数 | 说明 |
|----|--------|------|
| UDT_S_259 售后护理单 | 463,841 | 疗程卡消耗记录 |
| UDT_S_762 售前护理单 | 84,096 | 引流体验记录 |
| UDT_S_209 分院销售单 | 62,119 | 所有历史销售单 |
| UDT_S_311 顾客档案 | 51,117 | 全部顾客（→ PG customers 同步量） |
| UDT_S_287 人事档案 | 2,846 | 含在职 + 离职（→ PG employees 同步量） |
| UDT_M_341 产品明细 | 1,940 | → PG material_products 同步量 |
| UDT_M_1281 可售项目 | 481 | → PG catalog_items (source='national') 同步量 |
| UDT_M_1383 门店自定义项目 | 401 | → PG catalog_items (source='store_custom') 同步量 |
| UDT_S_1459 促销方案主表 | 56 | → PG promotion_schemes 同步量 |
| UDT_M_1460 促销方案明细 | 285 | → PG promotion_scheme_items 同步量 |
| UDT_M_229 品项分类 | 38 | → PG product_categories 同步量（21 种当前可用） |
| UDT_M_219 门店列表 | ~100 | → PG stores 同步量（估计） |
| UDT_S_1962 + UDT_M_1964 提成比例矩阵 | 待查 | → PG commission_rate_matrix 同步量 |

---

## 附录 D: 字段待补充清单

以下 WorkFine 表的字段详情未记录，需查询实际表结构后补充：

| 表 | Form ID | 说明 | 影响 |
|----|---------|------|------|
| UDT_S_211 | 211 | 职位部门对应表主表 | departments / positions 表同步 |
| UDT_M_212 | 211 | 职位部门对应表子表 | 同上 |
| UDT_S_218 | 216 | 市场门店对应表主表 | stores 表同步（市场级字段） |
| UDT_S_228 | 222 | 品相类型主表 | product_categories 同步（主表关系） |
| UDT_S_1962 | — | 提成比例矩阵主表 | commission_rate_matrix 同步 |
| UDT_M_1964 | — | 提成比例矩阵子表 | 同上，具体字段待查询 WorkFine |
