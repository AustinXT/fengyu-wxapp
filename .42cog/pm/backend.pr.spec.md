# 凤御双美容院 — 后端服务产品需求规格书

> **文档版本**: 1.0.0
> **范围**: 后端服务（CloudBase 云函数 + 双数据库）
> **约束文档**: `.42cog/real.md` v2.0.0 | `.42cog/cog.md` v2.0.0
> **端 spec 引用**: `client.pr.spec.md` v1.0.0 | `staff.pr.spec.md` v1.0.0
> **日期**: 2026-03-09

---

## 1. 概述

**定位**: 凤御双美容院微信小程序生态系统的统一后端服务层，为顾客端（C端）和员工端（B端）提供 API 网关、业务逻辑、数据持久化和跨端协调。

**技术栈**:

| 项 | 方案 |
|----|------|
| 前端 | 微信小程序（客户端 + 员工端，共两个小程序） |
| 后端 | CloudBase 云函数（Node.js 18） |
| 业务数据库 | Workfine SQL Server（直连只读） |
| 小程序数据库 | PG 自托管数据库（读写） |
| SQL Server 驱动 | `mssql`（node-mssql）npm 包，云函数内直连 |
| 支付 | 微信支付多商户模式（特约商户）+ 线下付款标记 |
| 实时通信 | WebSocket 或小程序订阅消息 |
| 权限 | 基于角色的访问控制（店长/美容师），微信 openid 关联 |

---

## 2. 技术架构

```
小程序（客户端 + 员工端）
    ↓
CloudBase 云函数（Node.js）
    ├── PG 自托管数据库（小程序专属数据）
    └── Workfine SQL Server DB（直连只读，mssql 驱动）
```

**云函数网关模式**: 每个云函数是单入口 action 路由网关：`{ action: 'module.method', payload: {} }`。路由懒加载 `require('./routes/' + module)`。

| 云函数 | 端口 | envId |
|--------|------|-------|
| `clientApi` | 顾客端 | `cloud1-3gpht4b01ff88838` |
| `staffApi` | 员工端 | `cloud1-9g3ydpg512eecc99` |
| `payNotify` | 支付回调 | 同 clientApi |

---

## 3. Workfine 数据对接

### 3.1 连接信息

- **连接方式**: 云函数通过 `mssql`（node-mssql）驱动直连 Workfine SQL Server，**仅读取**
- **服务器地址**: `111.229.31.128:1433`，数据库 `wkdb_20220804_86cd3292`，用户名 `Sa`，密码 `oHx#+Q`
- **重要**: Workfine 数据库所有表均为**只读**，小程序不直接写入 Workfine

### 3.2 数据库分工

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

### 3.3 WorkFine 只读表索引

| 数据域 | WorkFine 表 | 关键字段 | 用途 |
|--------|------------|----------|------|
| 门店列表 | `UDT_M_219` | 门店名称、所属市场、状态 | 门店选择 |
| 员工档案 | `UDT_S_287` | 姓名、职位、门店、部门、是否可分配业绩 | 角色判定、营业额分配 |
| 顾客档案 | `UDT_S_311` | 姓名、手机号、会员等级、主美容师、顾客来源 | 顾客搜索、档案查看 |
| 可售项目（全国） | `UDT_M_1281` | 项目编号、名称、价格、次数、生美/非生美 | SKU 价格/次数实时读取 |
| 门店自定义项目 | `UDT_M_1383` | 同上 | 同上 |
| 院装产品 | `UDT_M_341` | 商品编号、名称、价格 | SKU 价格实时读取 |
| 促销方案 | `UDT_S_1459` + `UDT_M_1460` | 方案名称、项目列表、促销售价 | 促销方案开单 |
| 提成比例矩阵 | `UDT_S_1962` + `UDT_M_1964` | 市场、部门、销售分类、金额阶段、比例 | 营业额分配 |
| 品项分类 | `UDT_M_229` | 分类名称 | 参考（实际从 PG 派生） |

---

## 4. 数据模型

### 4.1 实体概览

| 实体 | PG 表 | 关键字段 |
|------|-------|----------|
| SPU 商品 | `product_spu` | spu_id, name, category, big_category, cover_image, sort_order |
| SKU↔WorkFine 映射 | `product_spu_sku_map` | sku_id, spu_id, workfine_item_id, workfine_source, product_type |
| 订单 | `orders` | order_no, status, order_type, client_user_id, payment_method |
| 订单明细 | `order_items` | item_flow_no, order_no, sku_id, remaining_sessions, unit_price |
| 营业额分配 | `revenue_allocations` | id, order_no, employee_id, total_amount |
| 业绩分类明细 | `revenue_allocation_items` | id, allocation_id, performance_category, amount |
| 护理单 | `service_orders` | service_order_no, status, assigned_staff_wf_id, appointment_id |
| 护理明细 | `service_items` | service_item_id, item_flow_no, service_order_no, session_used |
| 客户端微信用户 | `client_wechat_users` | user_id, openid, phone, bound_store_name |
| 员工端微信用户 | `staff_wechat_users` | user_id, openid, phone, staff_wf_id |
| 预约 | `appointments` | appointment_id, status, client_user_id, staff_wf_id, checkin_at |

### 4.2 product_spu（SPU 商品概念表）

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

> **左侧品项分类选择器查询逻辑**：分类列表从 `product_spu` 动态派生，不直接查询 WorkFine UDT_M_229；仅显示存在至少一个 `is_active = true` SKU 的分类，院装产品作为固定末尾节点单独追加。

```sql
-- 左侧分类列表（有效 SPU 的去重分类，按分类最小 sort_order 排序）
SELECT p.category, MIN(p.sort_order) AS category_order
FROM product_spu p
WHERE p.big_category != '院装产品'
  AND EXISTS (
    SELECT 1 FROM product_spu_sku_map m
    WHERE m.spu_id = p.spu_id AND m.is_active = true
  )
GROUP BY p.category
ORDER BY category_order ASC;
-- 院装产品节点：WHERE big_category = '院装产品'，固定追加在末尾
```

> 分类顺序由该分类下 `sort_order` 最小的 SPU 决定；调整分类显示顺序时，修改该分类第一个 SPU 的 `sort_order` 即可，无需维护独立的分类排序表。

### 4.3 product_spu_sku_map（SPU↔WorkFine 映射表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sku_id` | string | 主键，UUID |
| `spu_id` | string | 关联 product_spu.spu_id |
| `workfine_item_id` | string | WorkFine 中的疗程项目编号（UDT_M_1281/1383.UDF_M_14503）或商品编号（UDT_M_341.UDF_M_1870） |
| `workfine_source` | enum | `UDT_M_1281`（全国可售项目）/ `UDT_M_1383`（门店自定义）/ `UDT_M_1460`（促销方案项目子表）/ `UDT_M_341`（院装产品） |
| `product_type` | enum | `疗程卡` / `单品` / `院装产品`；决定核销流程：`疗程卡`：session_count 按合同次数（≥2），需多次到店核销，次数归零后完成；`单品`：session_count = 1，需一次到店核销，服务完成后该行完成；到期日为支付日起一年（expire_date = paid_at + 1 year，支付回调成功后由系统写入）；`院装产品`：支付后直接完成，不走到店服务流程（session_count = null） |
| `sku_display_name` | string | 规格展示名（如"10次卡"、"285ml/瓶"） |
| `sort_order` | integer | 规格排序 |
| `is_active` | boolean | 该 SKU 是否上架；SPU 展示状态由其所有 SKU 的 `is_active` 派生 |

> UNIQUE 约束：`(spu_id, workfine_item_id, workfine_source)`
>
> SKU 的价格、疗程服务次数等字段运行时从 WorkFine 实时读取，不存入 PG 自托管数据库。

### 4.4 orders（订单主表，对应 UDT_S_209）

> **设计说明：为何需要 `order_items`？**
> 一笔销售单可包含多个项目（疗程卡、单品、院装产品可混购），且疗程卡需要**独立追踪剩余次数与到期日**，并作为护理单核销的引用锚点（通过 `item_flow_no`）。因此明细必须以行级方式独立存储，不能压入主表字段。

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
| `payment_method` | enum | 收款方式：`wechat`（微信支付）/ `offline`（线下收款） |
| `order_source` | enum | 下单端：`client`（客户端自助）/ `staff`（员工端开单） |
| `opened_by` | string | 开单人员工编号（员工端开单时填入，客户端自助时为 null） |
| `preferred_staff_wf_id` | string | 顾客指定美容师员工编号，关联 WorkFine `UDT_S_287.UDF_S_1147`（未指定时为 null） |
| `paid_at` | timestamp | 支付完成时间 |
| `offline_confirmed_by` | string | 线下收款确认人员工编号 |
| `offline_confirmed_at` | timestamp | 线下收款确认时间 |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

> **部分唯一索引**：`UNIQUE (client_user_id) WHERE status = '待支付' AND client_user_id IS NOT NULL`，同一顾客（已注册）同一时刻只能有一笔待支付订单。对于 `client_user_id` 为 null 的员工开单场景，在应用层按"同一门店 + 同一手机号"校验重复开单；建议同时在数据库层添加部分唯一索引作为兜底：`UNIQUE (client_phone, store_name) WHERE status = '待支付' AND client_user_id IS NULL`，防止并发下重复开单。

### 4.5 order_items（销售明细，对应 UDT_M_213）

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

### 4.6 revenue_allocations（营业额分配，对应 UDT_M_217）

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

### 4.7 revenue_allocation_items（业绩分类明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigint | 主键，自增 |
| `allocation_id` | bigint | 关联 `revenue_allocations.id` |
| `performance_category` | string | 业绩分类名称（如 `眉眼`、`唇`、`祛斑点痣`、`单品`；可按业务扩展） |
| `amount` | decimal | 该分类的分配金额 |

> 新增业绩分类时只需插入新行，无需变更表结构。

### 4.8 service_orders（护理单主表，对应 Workfine UDT_S_259）

> 与订单的关联通过 `service_items.item_flow_no → order_items.item_flow_no` 实现，主表不存 `order_no`，支持同一次到店跨多笔订单核销。

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_order_no` | string | 主键，护理单编号，格式 `HLD-WX-{YYMMDD}{序号}` |
| `status` | enum | 服务状态：`待服务` / `服务中` / `已完成` |
| `market_name` | string | 所属市场（快照，与 orders 一致） |
| `store_name` | string | 所属门店（快照，与 orders 一致） |
| `service_date` | date | 护理服务日期 |
| `service_duration` | integer | 服务时长（分钟） |
| `assigned_staff_wf_id` | string | 分配的主责服务人员编号，关联 WorkFine `UDT_S_287.UDF_S_1147`（用于服务单状态推进权限校验） |
| `remark` | string | 备注 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（服务顾客的微信用户 ID） |
| `appointment_id` | string \| null | 关联 `appointments.appointment_id`（可选，有预约时填入） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

### 4.9 service_items（护理明细，对应 Workfine UDT_M_260）

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_item_id` | string | 主键，UUID，系统自生成 |
| `item_flow_no` | string | 外键，关联 `order_items.item_flow_no`（指向具体疗程卡行） |
| `service_order_no` | string | 关联 `service_orders.service_order_no` |
| `sku_id` | string \| null | 关联 `product_spu_sku_map.sku_id` |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | string | 服务美容师编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |

### 4.10 client_wechat_users（客户端微信用户）

> 两个小程序 appid 不同，同一微信用户在客户端与员工端的 openid 互相独立，因此拆为两张表，各自独立管理。

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

### 4.11 staff_wechat_users（员工端微信用户）

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

### 4.12 appointments（预约）

| 字段 | 类型 | 说明 |
|------|------|------|
| `appointment_id` | string | 主键，系统自生成 |
| `status` | enum | 预约状态：`待确认` / `已确认` / `已完成` / `已取消` / `已关闭` |
| `market_name` | string | 所属市场 |
| `store_name` | string | 所属门店 |
| `client_user_id` | string | 关联 `client_wechat_users.user_id`（预约顾客的微信用户 ID） |
| `customer_name` | string | 顾客姓名（冗余存储） |
| `staff_wf_id` | string | 预约美容师编号，关联 WorkFine `UDT_S_287.UDF_S_1147` |
| `staff_name` | string | 预约美容师姓名（冗余存储） |
| `appointment_time` | datetime | 预约到店时间 |
| `checkin_at` | timestamp \| null | 到店签到时间（签到时填入，不改变预约状态） |
| `notes` | string | 备注 |
| `cancelled_reason` | string | 取消原因（已取消时填入） |
| `created_at` | timestamp | 记录创建时间 |
| `updated_at` | timestamp | 记录更新时间 |

---

## 5. 组织架构

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

## 6. 权限与角色

| 角色 | 权限范围 |
|------|----------|
| 店长（门店经理） | 开单、确认线下收款、重置支付失败订单、查看/分配营业额、推进服务单状态、查看完整顾客手机号、创建体验单 |
| 美容师 | 查看自己负责的服务单、推进被分配给自己的服务单状态；**不可开单**、**不可查看完整手机号** |
| 顾客（客户端） | 自助下单、发起微信支付/选择线下付款、查看自己的订单与预约 |

- 权限校验以登录用户的 `staff_wf_id` 在 WorkFine 中的职位/部门数据为依据，由云函数中间件统一拦截
- 服务单状态推进：仅**店长**或**`service_orders.assigned_staff_wf_id` 匹配的服务人员**可操作
- 角色判定：`UDT_S_287.UDF_S_1161 = '门店经理'` → 店长；其他职位 → 美容师
- 门店数据隔离：所有 PG 查询以 `store_name` 过滤，禁止跨门店访问

---

## 7. 核心业务规则

1. 只有**店长（门店经理）**可开单，普通美容师无开单权限
2. **营业额分配**：同部门总额 ≤ 实收；跨部门各按实收金额分配（总额可达实收 2 倍）；**MVP 阶段不支持优惠/折扣，应收金额 = 实收金额**
3. **美容师选择非必须**：顾客下单时可不指定美容师
4. **日历入账口径**：仅 `已支付` 订单计入当日消费
5. **混购完成规则**：订单包含多类项目时，`已完成` 以**所有疗程卡行与单品行的 remaining_sessions 全部归零**为触发条件；院装产品行支付即视为该行已交付，不参与完成条件判断
6. **幂等要求**：支付回调、服务完成两类接口必须幂等；重复开单通过 `orders` 表部分唯一索引（`UNIQUE (client_user_id) WHERE status = '待支付'`）在数据库层拦截
7. **线下付款口径**（仅 MVP）：顾客端选择线下付款先进入 `待确认收款`，店长确认后才计为 `已支付`
8. 支付成功触发条件统一为**订单进入已支付**，而不是"仅创建订单成功"
9. 订单在员工端开单时即写入数据库（状态 `待支付`），客户扫码后无需重复创建
10. 订单关闭/支付失败时，对应的营业额分配记录一并标记为无效（`is_void = true`，记录 `voided_at`）；重新付款不重新分配，由店长手动操作
11. **疗程卡并发扣减**：使用原子 UPDATE 而非显式行锁，格式为 `UPDATE order_items SET remaining_sessions = remaining_sessions - {n} WHERE item_flow_no = $1 AND remaining_sessions >= {n}`，通过检查 `rowCount` 是否为 1 判断扣减是否成功；`rowCount = 0` 时返回次数不足错误，不得在应用层先 SELECT 再 UPDATE
12. **护理单来源约束**：护理单明细（`service_items`）中每条 `item_flow_no` 必须关联一条已支付订单的 `order_items` 行；约束在明细层执行，主表（`service_orders`）不存 `order_no`，允许同一次到店跨多笔订单核销
13. **体验/引流服务**需先由店长创建体验单（`order_type = 体验`，价格由店长自定义），支付确认后再从该体验单创建护理单；体验单走与正式订单相同的支付流程和状态机。**先服务后付款不在 MVP 范围**：护理单必须在订单进入已支付后才可创建，不支持先到店服务后补单付款的场景
14. **顾客端自助下单的营业额分配**：
    - 已指定美容师（`preferred_staff_wf_id` 不为 null）：订单进入已支付时，系统自动以该美容师为唯一被分配人创建分配记录（`allocation_ratio = 1.0`，`total_amount = received`），无需店长手动操作；店长可在订单详情页查看分配结果
    - 未指定美容师（`preferred_staff_wf_id` 为 null）：不创建分配记录，订单详情页不出现营业额分配入口
15. **营业额分配锁定规则**：分配记录在订单处于 `待支付` 且顾客尚未扫码（二维码显示状态为"待扫码"）时可被删除并重建（即"修改"）；顾客扫码后（二维码显示状态变为"已扫码待付款"或之后）分配方案立即锁定，不得修改；如需变更，须将订单置为 `已关闭` 并由店长重新开单
16. **手机号补全机制**：顾客端小程序首次登录并完成手机号绑定时，系统查询 `orders` 表中 `client_phone = 绑定手机号 AND client_user_id IS NULL` 的记录，批量将 `client_user_id` 更新为当前用户的 `user_id`，使历史体验单（及正式订单）在顾客端可见。此操作在绑定手机号的云函数中同步执行
17. **员工开单顾客身份验证**：员工端开单时，顾客手机号为**必填项**。系统在提交开单时通过手机号查询 `client_wechat_users.phone`：若已注册客户端，将对应 `user_id` 直接写入 `orders.client_user_id`，订单在顾客端立即可见；若未注册，`client_user_id` 为 null，待顾客完成手机号绑定后通过第 16 条补全机制自动关联
18. **预约取消后可重新发起**：处于 `已取消` 状态的预约（顾客主动取消），顾客可重新发起新预约；`已关闭` 状态的预约（超期系统自动关闭或次数归零）不可重新发起

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
已支付 → 已完成          （疗程卡/单品：全部相关 order_items remaining_sessions 归零；院装产品：支付即完成）
```

- `已支付` 触发：微信支付回调成功，或店长确认线下收款成功
- `待确认收款`：仅用于顾客端选择线下付款后的中间状态
- `支付失败 → 待支付`：店长手动重置，使顾客可重新发起付款，对应第七节第 10 条
- 体验单（`order_type = 体验`）与正式订单走相同的支付流程和状态机
- 促销方案订单（`order_type = 促销方案`）走相同状态机
- 订单关闭时，对应营业额分配记录标记为无效（`is_void = true`）

### 8.2 服务单状态机

```text
待服务 → 服务中          （开始服务）
服务中 → 已完成          （完成服务，原子扣减次数）
待服务 → 已取消          （取消服务单，不扣次）
服务中 → 已取消          （取消服务单，不扣次）
```

- 只有店长或被分配的服务人员可推进状态
- 仅在 `服务中 → 已完成` 时扣减 session_used 次（疗程卡/单品均适用），且剩余次数不得小于 0
- 重复点击"完成服务"时，后端按同一服务单 ID 幂等处理，不得重复扣次

### 8.3 预约状态机

```text
待确认 → 已确认          （员工确认预约）
待确认 → 已取消          （顾客取消）
已确认 → 已取消          （顾客取消）
已确认 → 已完成          （关联服务单完成后自动流转）
待确认 → 已关闭          （超期未到店 或 该订单行剩余次数归零）
已确认 → 已关闭          （超期未到店 或 该订单行剩余次数归零）
```

> `已关闭` 触发：定时任务每日检查 `appointment_time < NOW() - INTERVAL '1 day'` 且状态为 `待确认` 或 `已确认` 的预约，批量置为 `已关闭`。`已关闭` 预约不可重新发起；`已取消` 预约（顾客主动取消）可重新发起。

**到店签到**: 仅记录 `checkin_at` 时间，不改变预约状态。

### 8.4 营业额分配状态机

```text
null → pending               （订单支付成功，allocation_status 初始化）
pending → allocated          （店长完成分配）
allocated → pending          （店长删除分配记录，重新分配）
```

---

## 9. 异常场景处理

| 场景 | 处理方式 |
|------|----------|
| 重复下单 | 部分唯一索引拦截，返回错误提示，不重复创建订单 |
| 重复支付回调 | 仅第一次成功回调生效，不重复入账日历 |
| 重复线下确认收款 | 仅第一次确认生效，不重复入账日历 |
| 网络抖动导致实时推送失败 | 轮询兜底后保证最终一致 |
| 并发核销 | 通过原子 UPDATE（`rowCount` 校验）保证同一疗程卡不会被超扣 |

---

## 10. 实时通信

**需求**:
- 订单进入已支付后即时通知员工端（跨端通知）
- 员工端日历在 **5 秒内**出现消费标记

**技术方案选项**:
- WebSocket（小程序端 `wx.connectSocket`）
- 小程序订阅消息

**兜底机制**:
- WebSocket 断开情况下，员工端在 **30 秒内**通过轮询看到同一笔消费
- 轮询兜底后保证最终一致

> MVP 阶段通知技术方案待定，但 5 秒实时性要求和 30 秒轮询兜底为硬指标。

---

## 11. 核心接口列表

### 11.1 clientApi（顾客端）

> 详细定义参见 `client.pr.spec.md` Section 10

| 模块 | 接口 | 说明 | 实现状态 |
|------|------|------|---------|
| auth | login, bindPhone, bindStore | 微信登录、手机号绑定、门店绑定 | 已实现 |
| store | list, detail, requestUnbind, getUnbindRequest, cancelUnbindRequest, geocode | 门店 CRUD + 解绑 + 定位 | 已实现 |
| product | categories, spuList, skuDetail, spuDetail, hotList, shopInit | 商品浏览 | 已实现 |
| staff | list, default | 美容师列表 + 默认美容师 | 已实现 |
| order | create, pay, alipayPay, offlinePay, list, detail, cancel, appointableItems, scanDetail | 订单全流程 | 已实现 |
| appointment | create, list, cancel | 预约管理 | 已实现 |
| service | detail | 服务单只读 | 已实现 |

### 11.2 staffApi（员工端）

> 详细定义参见 `staff.pr.spec.md` Section 10

| 模块 | 接口 | 说明 | 实现状态 |
|------|------|------|---------|
| auth | login, bindPhone | 员工登录、手机号绑定 | 已实现 |
| store | list, unbindRequests, approveUnbind, rejectUnbind | 门店 + 解绑审批 | 已实现 |
| staff | list, departments, todayCommission, monthlyCalendar, todoList, bindStore | 员工 + 工作台 | 已实现 |
| product | shopInit, categories, spuList, skuDetail, spuDetail, promotionList, promotionPlans | 商品浏览（含促销方案） | 已实现 |
| customer | search, calendar, detail, paidOrders | 顾客档案 + 消费日历 | 已实现 |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail | 订单全流程 | 已实现 |
| allocation | save, deleteAllocation, getCommissionRates, pendingList, suggest | 营业额分配 | 已实现 |
| appointment | list, detail, confirm, checkin | 预约管理 | 已实现 |
| service | create, start, complete, cancel, list, detail | 服务单全流程 | 已实现 |

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
| 支付幂等 | 微信回调、线下确认、服务完成接口均需幂等，不得重复入账或扣次 |
| 状态单向推进 | 订单/服务单/预约状态只能沿状态机正向流转；唯一例外：店长可重置 `支付失败` → `待支付` |
| 门店数据隔离 | 所有 PG 查询以 `store_name` 过滤，禁止跨门店访问 |
| 订单号唯一生成 | advisory lock 防流水号并发冲突 |
| 待支付订单唯一 | 同一顾客同时只能有一笔待支付订单（数据库部分唯一索引 + 应用层校验） |
| 事务处理 | 服务单完成、订单创建、分配保存均使用 PostgreSQL transaction |
| 价格缓存 | WorkFine 价格查询 5 分钟 TTL 模块级缓存，减少 SQL Server 压力 |
| 连接池限制 | PG max 5, MSSQL max 5 min 1，均为懒初始化 |
| 响应格式 | `{ code: 0, message: "success", data: {} }`，错误码 -1/-400/-401/-403 |

---

## 13. MVP 验收标准

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-01 | 订单进入 `已支付` 后，员工端顾客日历在 **5 秒内**出现当日消费标记 | 支付 → 5 秒内刷新日历 |
| AC-02 | WebSocket 断开情况下，员工端在 **30 秒内**通过轮询看到同一笔消费 | 断网恢复后 30 秒内数据同步 |
| AC-03 | 同一笔订单无论重复提交多少次，在日历中仅计入一次 | 重复确认 → 日历不重复标记 |
| AC-04 | 同一服务单重复点击"完成服务"不产生重复扣次 | 连续点击完成 → 仅扣一次 |
| AC-05 | 角色越权操作应被拒绝（美容师不可开单、技师不可查看完整手机号） | 越权操作 → 返回 -403 |
| AC-06 | 小程序读取的员工、产品、组织架构数据与 Workfine 设计端一致 | 对比 WorkFine 数据 |
| AC-07 | 小程序中完成开单后，PG 自托管数据库订单表中能查到同一笔记录 | 开单 → 查询 orders 表 |
| AC-08 | 小程序中完成营业额分配后，PG 自托管数据库营业额分配表中能查到分配明细 | 分配 → 查询 revenue_allocations |
