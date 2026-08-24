# 凤御双美容院 — 后端服务产品需求规格书

> **文档版本**: 4.0.0
> **范围**: 后端服务
> **约束文档**: `.42cog/real.md` | `.42cog/cog.md`
> **日期**: 2026-03-13
>
> **运行时架构**: 所有业务查询 100% 走 PG，WorkFine SQL Server 不参与在线请求链路。WorkFine 迁移与同步方案见 `workfine-sync.spec.md`。

---

## 1. 技术架构

| 云函数 | 端口 | envId |
|--------|------|-------|
| `clientApi` | 顾客端 | `cloud1-3gpht4b01ff88838` |
| `staffApi` | 员工端 | `cloud1-9g3ydpg512eecc99` |
| `payNotify` | 支付回调 | 同 clientApi |
| `adminApi` | 管理后台 | 独立部署 |

---

## 2. 数据模型

### 2.1 org_nodes（组织架构树）

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | text | 节点名称，NOT NULL |
| `type` | org_node_type enum | `总部` / `市场` / `门店` / `部门`，NOT NULL |
| `parent_id` | text \| null | FK → `org_nodes.id`（NULL = 根节点） |
| `sort_order` | integer | 排序序号，NOT NULL DEFAULT 0 |
| `is_active` | boolean | 是否启用，NOT NULL DEFAULT true |

> **约束**:
> - `UNIQUE(parent_id, name)` — 同级不重名
> - `INDEX(type)` — 按类型筛选
> - `INDEX(parent_id)` — 子节点查询
>
> **层级约束**（应用层校验）:
>
> | 节点类型 | parent 必须是 |
> |----------|--------------|
> | 总部 | NULL（根节点，仅一个） |
> | 市场 | 总部 |
> | 门店 | 市场 |
> | 部门 | 总部 / 市场 / 门店（不能挂在 部门 下） |
>
> `permission_roles.scope_id` → FK `org_nodes.id`

### 2.2 stores（门店详情）

| 字段 | 类型 | 说明 |
|------|------|------|
| `store_id` | text | 主键，UUID |
| `store_name` | text | 门店名称（唯一索引） |
| `org_node_id` | text \| null | FK → `org_nodes.id`（关联 type='门店' 的节点） |
| `opening_date` | date \| null | 开业时间 |
| `bed_count` | integer \| null | 可用床位数 |
| `is_closed` | boolean | 是否停止营业，NOT NULL DEFAULT false |
| `cover_image` | text \| null | 门头封面图 URL |
| `images` | text[] \| null | 店内环境图 URL 数组 |
| `district` | text \| null | 省市区 |
| `street_address` | text \| null | 街道门牌号 |
| `latitude` / `longitude` | numeric(10,7) \| null | 经纬度 |
| `phone` | text \| null | 联系电话 |
| `business_hours` | text \| null | 营业时间 |
| `description` | text \| null | 门店简介 |
| `announcement` | text \| null | 门店公告 |
| `parking_info` | text \| null | 停车/交通信息 |

> **索引**: `INDEX(org_node_id)`。业务表通过 `store_id` FK 关联 stores，市场名称通过 JOIN `org_nodes` 树获取。
>
> **顾客向字段**（`cover_image` ~ `parking_info`）：员工端维护。图片指向 CloudBase 云存储。经纬度用于距离排序（Haversine，无需 PostGIS）。stores 是 org_nodes（type='门店'）的 1:1 扩展表。

### 2.3 staff_wechat_users（员工 / 员工端微信用户）

> **设计说明**: 微信身份与员工档案合一。行可由 (a) 微信登录创建，或 (b) WorkFine 同步创建。通过 `phone` 匹配合并行。

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | text | 主键，系统自生成；同步创建时格式 `emp_{employee_id}` |
| `openid` | varchar(64) \| null | 微信 openid（员工端 appid 下，唯一索引）；仅同步创建的行为 null |
| `session_key` | varchar(128) \| null | 微信 session_key |
| `phone` | varchar(30) \| null | 绑定手机号（唯一索引） |
| `employee_id` | varchar(30) \| null | 员工编号（唯一索引），同步匹配用，供其他表 FK 引用 |
| `name` | varchar(50) \| null | 姓名 |
| `gender` | varchar(20) \| null | 性别 |
| `id_card` | varchar(200) \| null | 身份证号码（AES-256-GCM 加密存储，密钥存环境变量） |
| `store_id` | text \| null | FK → `stores.store_id` |
| `org_node_id` | text \| null | FK → `org_nodes.id`（指向 type='部门' 的部门节点） |
| `position_name` | varchar(50) \| null | 工作职位 |
| `birthday` | date \| null | 出生日期 |
| `skills` | text[] \| null | 技能标签数组 |
| `is_resigned` | boolean | 是否离职，NOT NULL DEFAULT false |
| `last_login_at` | timestamp \| null | 最近登录时间 |

> **索引**: `UNIQUE(openid) WHERE openid IS NOT NULL`、`UNIQUE(phone) WHERE phone IS NOT NULL`、`UNIQUE(employee_id)`、`INDEX(store_id, is_resigned)`
>
> **行创建与合并**：微信登录创建（填 `openid`）、同步创建（填档案字段，`openid=null`）。绑定手机号时若 `phone` 匹配到同步行则合并，原行删除。
>
> **角色判定**: 查询 `permission_roles` 获取 `role` + `scope` 组合。无记录时降级为 `role=staff, scope=员工所在门店`。详见 §3.3。
>
> **FK 引用**: `sale_orders.opened_by/preferred_employee_id/offline_confirmed_by`、`service_orders.assigned_employee_id`、`sale_allocations.employee_id`、`service_items.employee_id`、`appointments.employee_id`、`permission_roles.employee_id`、`store_unbind_requests.reviewed_by`。

### 2.4 product_categories（品项分类）

| 字段 | 类型 | 说明 |
|------|------|------|
| `category_id` | text | 主键，UUID |
| `category_name` | text | 分类名（如"蜜语生玑"），**不唯一** |
| `product_kind` | text | 一级行 NULL；二级行 = 父级一级行的 `category_name`。**DB 驱动**：一级行集合由 admin 维护，无字面量枚举（`product_kind` PG enum 已 DROP，2026-04-24 ticket）|
| `sort_order` | integer | 排序序号 |
| `is_valid` | boolean | 是否有效，NOT NULL DEFAULT true |
| `display_color` | text | 一级行展示色（HEX），用于商品 tag / 购物车标签的视觉色；二级行 NULL 时由前端继承父级 |
| `display_icon` | text | 一级行展示图标（emoji 或 icon name），可空 |
| `requires_shengmei_flag` | boolean | 一级行 capability：该 kind 下 SKU 表单是否需要"是否生美"开关。NOT NULL DEFAULT false |

> `category_name` 不设唯一约束，允许不同 `product_kind` 下同名分类。
> 新增/拆分一级 kind（如 4/17 会议护理项目→招牌/王牌/明星）零代码变更，仅 admin "品项分类 → 一级品项管理"操作即可。
> "卡类"识别（充值卡 / 体验卡）已下沉到 SKU 级 capability 列 `product_skus.is_experience` / `is_recharge_card`，原 `is_card_kind` 一级 capability 列已于 2026-05-18 全仓清理 + DB DROP COLUMN（migration 0034）。

### 2.5 products（商品主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_id` | text | 主键，UUID |
| `category_id` | text | FK → `product_categories.category_id` |
| `name` | text | 商品名称 |
| `cover_image` | text \| null | 封面图 URL |
| `detail_images` | text[] \| null | 详情图片 URL 列表 |
| `description` | text \| null | 商品描述 |
| `is_shengmei` | boolean \| null | 是否生美（护理项目使用） |
| `is_bundle` | boolean | 是否套餐，NOT NULL DEFAULT false |
| `price` | numeric(10,2) | 标价/原价（套餐 = Σ(SKU.price)；否则 = min(SKU.price)。交易以 SKU 价格为准） |
| `special_price` | numeric(10,2) \| null | 会员价（仅会员享受；体验卡场景为体验价对所有人） |
| `sales_category` | sales_category enum \| null | 销售分类（自销自耗 / 他销自耗 / 他销他耗 / 生态合作） |
| `manage_scope` | text \| null | 管理范围（null=总部管理） |
| `market_scope` | text \| null | 可见范围（null=全部可见） |
| `sort_order` | integer | 排序权重 |
| `is_enabled` | boolean | 上下架开关（false=下架），NOT NULL DEFAULT true |

> **关键设计**: `is_enabled` 上下架开关替代 `is_active`（2026-04 schema reset 落地）；`sales_category` 在商品层（非 SKU 层）。
>
> **上下架叠加规则**: 商品和 SKU 各有 `is_enabled`，查询时**两层同时校验**，任一层 false 即不可购买。

### 2.6 product_skus（商品规格）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sku_id` | text | 主键 |
| `product_id` | text | FK → `products.product_id` |
| `product_type` | product_type enum | 疗程卡 / 家居产品；决定核销流程（"家居产品"原称"院装产品"，2026-04-25 重命名；2026-05-21 原"单品"并入疗程卡=1 次卡，枚举 3→2 值） |
| `spec_name` | text | 规格名（如"10次卡"、"单次体验"） |
| `price` | numeric(10,2) | 标价/零售价（套餐组件中 0 表示赠品），**开单时快照到 sale_items.unit_price** |
| `special_price` | numeric(10,2) \| null | 会员价 |
| `session_count` | integer \| null | 疗程次数：疗程卡≥1（含原单品=1），家居产品=null |
| `is_bundle_sku` | boolean | 是否为套餐组成部分，NOT NULL DEFAULT false |
| `sort_order` | integer | 排序序号 |
| `service_fee` | numeric(10,2) | 手工费，NOT NULL DEFAULT 0 |
| `is_enabled` | boolean | 上下架开关（false=下架），NOT NULL DEFAULT true |
| `is_experience` | boolean | **capability 列**：是否为体验卡 SKU（替代 `product_kind='体验卡'` 字面量判定），NOT NULL DEFAULT false |
| `is_recharge_card` | boolean | **capability 列**：是否为充值卡 SKU（替代 `product_kind='充值卡'` 字面量判定），NOT NULL DEFAULT false |

> **索引**: `(product_id)`、`(is_experience) WHERE is_experience = true`、`(is_recharge_card) WHERE is_recharge_card = true`。
>
> **CHECK**: `price >= 0`、`service_fee >= 0`、`session_count IS NULL OR >= 1`、`chk_sku_not_both_capabilities: NOT (is_experience AND is_recharge_card)`（互斥）。
>
> **FK 引用**: `sale_items.sku_id`。
>
> **capability 列 SSoT 原则**（2026-04-26 ticket，详见 §4 #23）：业务判定（跃迁 / 充值入账 / 入口过滤 / D4 严格独立校验）一律读 `is_experience` / `is_recharge_card`，不再读 `product_categories.product_kind` 字面量。`product_kind` 仅作为商品组织/分类标签，admin 可改名而不影响业务逻辑。新增卡类（如"季卡"）只需在 `product_categories` 加一行 + 加 capability 列即可零字面量散落。

### 2.7 commission_rate_matrix（提成比例矩阵）

| 字段 | 类型 | 说明 |
|------|------|------|
| `org_id` | text | FK → `org_nodes.id`（市场节点） |
| `order_type` | varchar(20) | 类型，"sale"、"service" |
| `role_type` | varchar(20) | 角色分类，"技师"、"推广" |
| `sales_category` | varchar(20) | 销售分类 |
| `amount_tier_min` | numeric(10,2) | 金额阶段下限（含） |
| `amount_tier_max` | numeric(10,2) \| null | 金额阶段上限（不含；null 表示无上限） |
| `commission_rate` | numeric(5,4) | 提成比例（如 0.08 = 8%） |

> UNIQUE 约束：`(org_id, order_type, role_type, sales_category, amount_tier_min)`

### 2.8 sale_orders（订单主表）

> **四种销售单据 + 支付流水模型**：sale_orders 承载**销售单 / 内部单 / 转换单 / 寄存单**四类，通过 `sale_order_type` 区分。回款 / 退款下沉至 `sale_order_payments`（sop）表，通过 `change_type='回款' / '退款'` 区分；转换单通过 `ref_sale_order_id` 引用原销售单。
>
> **寄存单（2026-05-18 B5 新增）**：WorkFine 剩余次数初始化专用，仅店长手动开（`order.createDeposit` / admin `createDepositOrder`）；不收钱（`received=0` / `payable=0` / `total=0` / `payment_method='无'` / `status='已支付'`）、禁所有抵扣（couponId / prepaidCardAmount / customPrice 任一存在即报 `INVALID_STATE: DEPOSIT_NO_DISCOUNT`）；sale_items 保留原价快照供审计但 `received=0`；金额维度统计天然排除（不动 `IN ('销售单','转换单')` 列表），次数维度持卡人数 `mgmt-product.cardHolders` 显式纳入。

| 字段 | 类型 | 说明 |
|------|------|------|
| `sale_order_id` | varchar(30) | 主键，单号格式见下表 |
| `status` | enum | `待支付` / `待确认收款` / `已支付` / `已完成` / `支付失败` / `已关闭` / `待审批` |
| `sale_order_type` | enum | `销售单` / `内部单` / `转换单` / `寄存单`（2026-05-18 B5 新增寄存单） |
| `ref_sale_order_id` | varchar(30) \| null | FK → `sale_orders.sale_order_id`；回款/转换/退款引用原单 |
| `market_name` | varchar(100) | 所属市场（快照） |
| `store_id` | text | FK → `stores.store_id`，NOT NULL |
| `sale_order_datetime` | timestamp | 销售日期时间 |
| `performance_attribution_date` | date | 首次业绩归属日，NOT NULL；默认取当前上海自然日，历史单按 `sale_order_datetime` 上海自然日回填 |
| `performance_attribution_adjusted_at` | timestamptz \| null | 归属日一次性调整时间；非空即永久禁止再改 |
| `performance_attribution_adjusted_by` | varchar(30) \| null | 调整人，FK → `staff_wechat_users.employee_id`，员工删除时置 null |
| `client_user_id` | text \| null | FK → `client_wechat_users.user_id` |
| `client_phone` | varchar(30) \| null | 顾客手机号快照；员工开单时必填 |
| `customer_name` | varchar(50) \| null | 顾客姓名快照 |
| `total_amount` | numeric(10,2) | 订单总金额（退款为负数），NOT NULL |
| `first_payment_amount` | numeric(10,2) \| null | 首次收款上限；普通转换/分期首次支付发起后清空 |
| `payment_method` | enum | `微信` / `支付宝` / `线下` |
| `is_experience_conversion` | boolean | 体验转换审计标记，DEFAULT false；仅转换单可置 true |
| `sale_order_source` | enum | `client` / `staff` / `admin`；回款/转换/退款仅 `staff` 或 `admin` |
| `opened_by` | varchar(30) \| null | 开单人，FK → `staff_wechat_users.employee_id` |
| `preferred_employee_id` | varchar(30) \| null | 顾客指定美容师，FK → `staff_wechat_users.employee_id` |
| `paid_at` | timestamp | 支付完成时间 |
| `wechat_transaction_id` | varchar(64) \| null | 微信支付流水号（唯一索引） |
| `alipay_transaction_id` | varchar(64) \| null | 支付宝交易号（唯一索引） |
| `offline_confirmed_by` | varchar(30) \| null | 线下确认人，FK → `staff_wechat_users.employee_id` |
| `offline_confirmed_at` | timestamp | 线下确认时间 |
| `allocation_status` | allocation_status enum \| null | null → `待分配` → `已分配` |
| `coupon_id` | text \| null | 使用的券实例ID |
| `coupon_discount` | numeric(10,2) | 券抵扣总金额，DEFAULT 0 |

> **单号格式表**：
>
> | sale_order_type | 前缀 | 示例 |
> |-----------------|------|------|
> | 普通/体验/内部/福利活动 | `FY-XSD-WX-` | `FY-XSD-WX-260313-0001` |
> | 回款 | `FY-HKD-WX-` | `FY-HKD-WX-260313-0001` |
> | 转换 | `FY-ABZH-WX-` | `FY-ABZH-WX-260313-0001` |
> | 退款 | `FY-TKD-WX-` | `FY-TKD-WX-260313-0001` |
>
> **约束**: `UNIQUE(client_user_id) WHERE status='待支付' AND client_user_id IS NOT NULL`、`UNIQUE(client_phone, store_id) WHERE status='待支付' AND client_user_id IS NULL`。**索引**: `(store_id, status)`、`(ref_sale_order_id)`。
>
> **expire_at**：应用层计算（`created_at + 10min`），不存储，通过 SQL 条件懒清理。

**业绩归属规则（2026-08-17 已决）**：

- 原始 `sale_order_datetime` / `paid_at` 不允许因报表需求改写。
- admin 动作 `sale_order:performance_attribution_update` 仅默认授予系统管理员、店长、财务；必须通过 scope 校验。
- 操作时间不限；目标日期必须在原始订单上海自然日前后 7 天内（含边界）。同日提交不消耗机会。
- 更新使用 `FOR UPDATE` + `performance_attribution_adjusted_at IS NULL` + `updated_at` CAS，保证并发下仅一次成功，并在同一事务写 `operation_logs`。
- `sale_order_performance_events`：首次支付，或没有更早成功正向款项的首笔纯储值卡抵扣，使用订单归属日；其他回款/退款使用流水 `paid_at` 的上海自然日。
- `sale_item_performance_events`：将已支付 receipt 按上述事件日期展开；旧数据无完整 receipt 时用订单归属日补齐 `sale_items.received` 差额。

### 2.9 sale_items（销售明细）

> **复用说明**：sale_items 用于**销售单 / 内部单 / 转换单**三类的明细行；退款 / 回款已下沉至 `sale_order_payments`，部分退款时通过 `sale_order_payments.ref_sale_item_id` 关联原明细行。`item_direction` 标识行的方向语义：

家居产品购买/转入行使用 `inventory_composition_snapshot`（JSONB）冻结下单时的库存组成，格式为 `{ version: 1, components: [{ inventorySkuId, productCode, productName, specName, quantityPerSaleUnit }] }`。新订单的家居行必须有非空有效快照；疗程卡为 NULL。历史空快照不回填，提货时读取最新有效组成。
> - `购买`（默认）：正常购买行
> - `转出`：转换退出行，`quantity` = 退次数，`received` = 负数
> - `转入`：转换转入行，创建新的 sale_item
> - `退出`：退款退出行，`quantity` = 退次数，`received` = 负数

| 字段 | 类型 | 说明 |
|------|------|------|
| `sale_item_id` | varchar(30) | 主键，格式 `XSLSH-WX-{YYYYMMDD}{序号}` |
| `sale_order_id` | varchar(30) | FK → `sale_orders.sale_order_id`，NOT NULL |
| `item_direction` | enum | `购买` / `转出` / `转入` / `退出` |
| `ref_sale_item_id` | varchar(30) \| null | FK → `sale_items.sale_item_id`；转出/退出 引用原购买行 |
| `sku_id` | text \| null | FK → `product_skus.sku_id` |
| `session_count` | integer \| null | 疗程总次数 |
| `remaining_sessions` | integer \| null | 剩余可用次数；原子递减防超卖 |
| `unit_price` | numeric(10,2) | 原价快照 |
| `quantity` | integer | 销售数量 |
| `unit_real_price` | numeric(10,2) | 优惠后单价 |
| `sale_amount` | numeric(10,2) | 优惠后销售金额 |
| `received` | numeric(10,2) | 实收金额（退出行为负数） |
| `prepaid_card_received` | numeric(10,2) | 储值卡实付分摊：订单 `prepaid_card_amount` 按所有明细的有符号 `received` 分摊；按 `sale_item_id` 排序的最后非零行用减法吸收分币尾差，分母为 0 时全部为 0 |
| `cash_received` | numeric(10,2) generated | 现金实付分摊，数据库生成列，恒等于 `received - prepaid_card_received` |
| `expire_date` | date \| null | 到期日（家居产品为 null） |
| `remark` | text | 备注 |
| `sales_category` | enum \| null | 销售分类：`自销自耗` / `他销自耗` / `他销他耗` / `生态合作` |
| `is_experience` | boolean | **capability 快照**：开单时从 `product_skus.is_experience` 拷贝；customer_type 跃迁判据，行级不可变，NOT NULL DEFAULT false |
| `is_recharge_card` | boolean | **capability 快照**：开单时从 `product_skus.is_recharge_card` 拷贝；payNotify 充值入账触发判据 + D4 严格独立校验，NOT NULL DEFAULT false |

> **索引**: `(sale_order_id)`, `(sku_id)`, `(ref_sale_item_id)`、`(sale_order_id) WHERE is_recharge_card = true`
>
> **CHECK**: `unit_price >= 0`、`unit_real_price >= 0`、`remaining_sessions IS NULL OR >= 0`、`quantity > 0`。`sale_amount` 和 `received` 允许负值（退款/转换退出行）。
>
> **DB 兜底触发器** `trg_check_no_mixed_recharge`（CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED）：同一 `sale_order_id` 的 sale_items 不能混合 `is_recharge_card = true / false`，COMMIT 时拒绝。应用层（admin / staff / client）已加显式 `MIXED_RECHARGE_NOT_ALLOWED` 双层守卫，DB trigger 是跨实现兜底。

### 2.10 sale_allocations（营业额分配）

> **多单据复用**：退款业绩 `total_amount` 为负数，转换/回款保持正数。

| 字段 | 类型 | 说明 |
|------|------|------|
| `sale_item_id` | varchar(30) | FK → `sale_items.sale_item_id`，NOT NULL |
| `employee_id` | varchar(30) | FK → `staff_wechat_users.employee_id` |
| `allocation_ratio` | numeric(5,2) | 提成比例快照 |
| `total_amount` | numeric(10,2) | 分配金额（退款为负数） |
| `is_void` | boolean | 是否已作废，NOT NULL DEFAULT false |
| `voided_at` | timestamp | 作废时间 |

> **约束**: `UNIQUE(sale_item_id, employee_id) WHERE is_void = false`
>
> **索引**: `INDEX(employee_id)`

### 2.11 service_orders（服务单主表）

> 与订单的关联通过 `service_items.sale_item_id → sale_items` 实现，主表不存 `sale_order_id`，支持跨订单核销。

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_order_id` | varchar(30) | 主键，格式 `HLD-WX-{YYMMDD}{序号}` |
| `status` | enum | `待服务` / `服务中` / `待客户确认` / `已完成` / `已取消` |
| `service_order_type` | enum | `售前` / `售后`（由顾客 customer_type 自动判定：会员客→售后，其他→售前） |
| `market_name` | varchar(100) | 所属市场（快照） |
| `store_id` | text | FK → `stores.store_id`，NOT NULL |
| `service_date` | date | 护理服务日期 |
| `assigned_employee_id` | varchar(30) | 主责服务人员，FK → `staff_wechat_users.employee_id` |
| `remark` | text | 备注 |
| `appointment_id` | text \| null | FK → `appointments.appointment_id` |
| `client_user_id` | text \| null | FK → `client_wechat_users.user_id` |

> **索引**: `INDEX(store_id, service_date)`, `INDEX(assigned_employee_id)`, `INDEX(client_user_id)`

### 2.12 service_items（护理明细）

| 字段 | 类型 | 说明 |
|------|------|------|
| `service_item_id` | text | 主键，UUID |
| `sale_item_id` | varchar(30) | FK → `sale_items.sale_item_id`（核销锚点），NOT NULL |
| `unit_real_price` | numeric(10,2) | sale_items.unit_real_price 快照 |
| `service_order_id` | varchar(30) | FK → `service_orders.service_order_id`，NOT NULL |
| `session_used` | integer | 本次划卡次数 |
| `employee_id` | varchar(30) | 服务美容师，FK → `staff_wechat_users.employee_id` |
| `service_duration` | integer | 服务时长（分钟） |

> **索引**: `INDEX(service_order_id)`

### 2.13 client_wechat_users（顾客 / 客户端微信用户）

> **合并说明**: 微信身份与顾客档案合一。通过 `phone` 匹配合并行。

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | text | 主键，格式 `FYGK-{YYYYMMDD}{序号}` |
| `openid` | varchar(64) \| null | 微信 openid（唯一索引） |
| `session_key` | varchar(128) \| null | 微信 session_key |
| `phone` | varchar(30) \| null | 手机号码（唯一索引） |
| `customer_id` | varchar(30) \| null | 顾客编号（唯一索引），同步匹配用 |
| `name` | varchar(50) \| null | 顾客姓名 |
| `bound_store_id` | text \| null | FK → `stores.store_id`（顾客端主动绑定的门店） |
| `bound_employee_id` | varchar(50) \| null | 所属美容师 |
| *档案字段* | *各类型* | `gender`、`member_level`、`customer_source`、`category`、`birthday`、`occupation`、`is_married`、`wechat_name`、`skin_type`、`improvement_focus`、`skin_issue`、`wellness_preference`、`notes`（均 nullable） |
| `last_login_at` | timestamp \| null | 最近登录时间 |

> **索引**: `UNIQUE(openid) WHERE openid IS NOT NULL`、`UNIQUE(phone) WHERE phone IS NOT NULL`、`UNIQUE(customer_id) WHERE customer_id IS NOT NULL`、`INDEX(bound_store_id)`
>
> **行创建与合并**：微信登录创建（填 `openid`）、同步创建（填档案字段，`openid=null`）。绑定手机号时若 `phone` 匹配到同步行则合并，原行删除。

### 2.14 appointments（预约）

| 字段 | 类型 | 说明 |
|------|------|------|
| `appointment_id` | text | 主键 |
| `status` | enum | `待确认` / `已确认` / `已完成` / `已取消` / `已关闭` |
| `store_id` | text | FK → `stores.store_id`，NOT NULL |
| `client_user_id` | text | FK → `client_wechat_users.user_id`，NOT NULL |
| `client_name` | varchar(50) | 顾客姓名（冗余存储） |
| `employee_id` | varchar(30) | 预约美容师，FK → `staff_wechat_users.employee_id` |
| `employee_name` | varchar(50) | 美容师姓名（冗余存储） |
| `sale_item_id` | varchar(30) \| null | FK → `sale_items.sale_item_id`（可选） |
| `appointment_time` | timestamp | 预约到店时间 |
| `checkin_at` | timestamp \| null | 到店签到时间（不改状态） |
| `notes` | text | 备注 |
| `cancelled_reason` | text | 取消原因 |

> **索引**: `INDEX(store_id)`, `INDEX(client_user_id)`, `INDEX(employee_id, appointment_time)`

### 2.15 permission_roles（权限角色分配）

| 字段 | 类型 | 说明 |
|------|------|------|
| `employee_id` | varchar(30) NOT NULL | FK → `staff_wechat_users.employee_id` |
| `role` | text NOT NULL | `admin` / `manager` / `finance` / `hr` / `product` / `staff` / `customer_mgr` |
| `scope_id` | text NOT NULL | FK → `org_nodes.id`（总部/市场/门店 级别） |
| `is_void` | boolean | 软删除标记，NOT NULL DEFAULT false |
| `voided_at` | timestamp \| null | 作废时间 |
| `created_by` | text \| null | 创建者（同步脚本标记 `'sync'`，手动标记操作人员工编号） |
| `updated_by` | text \| null | 最后修改者 |

> **约束**:
> - `UNIQUE(employee_id, role, scope_id) WHERE is_void = false`
> - `FK(employee_id)` → `staff_wechat_users(employee_id)`
> - `FK(scope_id)` → `org_nodes(id)`
>
> **一人多角色 + 一角色多域**：每个 `(employee_id, role, scope_id)` 组合一条记录。`is_void = true` 软删除，不参与权限查询。

### 2.16 operation_logs（操作日志）

| 字段 | 类型 | 说明 |
|------|------|------|
| `operator_user_id` | text | FK → `staff_wechat_users.user_id`，NOT NULL |
| `operator_name` | text | 操作人姓名快照，NOT NULL |
| `operator_role` | text \| null | 操作人角色快照（多角色时取最高权限角色） |
| `org_node_id` | text \| null | FK → `org_nodes.id` |
| `org_node_name` | text \| null | 组织节点名称快照 |
| `action` | text | 格式 `module.method`，NOT NULL |
| `target_type` | text | 目标实体类型，NOT NULL |
| `target_id` | text | 目标实体主键，NOT NULL |
| `detail` | jsonb \| null | 变更前后数据等结构化信息 |
| `source` | text \| null | 来源：`staffApi` / `clientApi` / `adminApi` |

> 只写不改（仅 INSERT）。**索引**: `(operator_user_id)`、`(target_type, target_id)`、`(action)`、`(created_at)`。
> **记录时机**：订单创建/确认/关闭/重置、分配保存/删除、服务单全流程、预约确认/签到、权限变更。

### 2.17 store_unbind_requests（门店解绑申请）

| 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | text | 主键 |
| `user_id` | text | FK → `client_wechat_users.user_id`，NOT NULL |
| `from_store_id` | text | FK → `stores.store_id`，NOT NULL |
| `status` | enum | `待处理` / `已通过` / `已拒绝` / `已取消`，NOT NULL DEFAULT `待处理` |
| `note` | text \| null | 申请备注 |
| `reviewed_by` | varchar(30) \| null | FK → `staff_wechat_users.employee_id` |
| `reviewed_at` | timestamp \| null | 审批时间 |
| `reject_reason` | text \| null | 拒绝原因 |

> `已通过` 后清除 `client_wechat_users.bound_store_id`；`已取消` = 顾客主动撤销。

### 2.18 coupon_templates（券模板）

> 定义券的规则（类型、面额、适用范围、有效期、发放总量等）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `template_id` | text | 主键 |
| `name` | text | 券名称，NOT NULL |
| `coupon_type` | coupon_type enum | `现金券` / `项目券` / `折扣券`，NOT NULL |
| `discount_value` | numeric(10,2) | 现金券/项目券=抵扣金额；折扣券=折扣率（0.85=85折），NOT NULL |
| `min_spend` | numeric(10,2) | 满减门槛（0=无门槛），DEFAULT 0。**基数口径见下方说明** |
| `max_discount` | numeric(10,2) \| null | 折扣券封顶金额 |
| `total_count` | integer \| null | 发放总量限制（null=不限量） |
| `applicable_product_ids` | text[] \| null | 适用商品ID数组（→ products.product_id），NULL=全部 |
| `applicable_category_ids` | text[] \| null | 适用品项分类ID数组，NULL=全部 |
| `applicable_store_ids` | text[] \| null | 适用门店ID数组，NULL=全部 |
| `validity_mode` | text | `fixed`（固定区间）/ `days`（领取后N天），DEFAULT 'fixed' |
| `valid_from` / `valid_to` | timestamp \| null | fixed 模式：生效/到期日期 |
| `valid_days` | integer \| null | days 模式：领取后有效天数 |
| `description` | text \| null | 券描述 |
| `is_active` | boolean | DEFAULT true |

**满减门槛口径（2026-04-10 审计确认）**：`min_spend` 判据基数为"**符合 `applicable_category_ids` 的商品行小计**"，**非订单全单总额**。若券无品类限制（`applicable_category_ids` 为 NULL 或 `[]`），则退化为全单小计。比较时需做分单位归一化（`Math.round(x * 100) / 100`）+ `eligibleTotal + 0.001 < minSpend` 浮点兜底，避免 JS 浮点 + PG numeric 边界抖动（如 499.99 / 500.00 / 99.9×5 = 499.4999...）。四端实现必须口径一致：`clientApi/routes/coupon.js` available、`staffApi/routes/coupon.js` available、`clientApi/routes/order.js` create、`staffApi/routes/order.js` create。

### 2.19 user_coupons（用户券实例）

> 每张实际发给用户的券。下单时通过原子 UPDATE + rowCount 校验防止重用。

| 字段 | 类型 | 说明 |
|------|------|------|
| `coupon_id` | text | 主键 |
| `template_id` | text | FK → `coupon_templates.template_id`，NOT NULL |
| `user_id` | text | FK → `client_wechat_users.user_id`，NOT NULL |
| `status` | coupon_status enum | `未使用` / `已使用` / `已过期`，NOT NULL DEFAULT '未使用' |
| `expire_at` | timestamp | 到期时间（发放时根据 validity_mode 计算），NOT NULL |
| `used_sale_order_id` | varchar(30) \| null | FK → `sale_orders.sale_order_id` |
| `used_at` | timestamp \| null | 使用时间 |

> **索引**: `INDEX(user_id, status)`、`INDEX(used_sale_order_id)`、`INDEX(expire_at)`

### 2.20 admin_passwords（管理后台登录密码）

> 仅持有此表记录的员工可通过手机号+密码登录管理后台。staff 不可登录。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial | 主键 |
| `employee_id` | varchar(30) | FK → `staff_wechat_users.employee_id`，UNIQUE，NOT NULL |
| `password_hash` | text | bcrypt（cost ≥ 12），NOT NULL |
| `must_change` | boolean | 首次登录强制改密，NOT NULL DEFAULT true |
| `last_changed_at` | timestamp \| null | 最近修改密码时间 |
| `created_at` / `updated_at` | timestamp | 时间戳 |

> **约束**: `UNIQUE(employee_id)`。认证流程详见 `admin.pr.spec.md` §2.3。

### 2.21 积分域（point_transactions + client_wechat_users.points_balance）

#### 2.21.1 数据模型

**权威流水表** `point_transactions`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | bigserial PK | — |
| `user_id` | text | FK → `client_wechat_users.user_id` |
| `type` | text（自由文本，非枚举） | 变动分类（见 §2.21.4） |
| `amount` | integer | 正负均可，累加即余额 |
| `ref_order_id` | varchar(30) \| null | FK → `sale_orders.sale_order_id`；冲销/发放以原销售单 id 聚合 |
| `external_ref` | text \| null | 外部幂等键；到店积分使用 `visit-points:{userId}:{serviceDate}` |
| `created_at` | timestamp | — |

**余额缓存** `client_wechat_users.points_balance` + `points_updated_at`
- 缓存语义：`SUM(point_transactions.amount WHERE user_id = u.user_id)`
- 运行时由业务触发点同事务双写维护；`cronTask` 夜间做一致性校验（仅告警，不自动修）

#### 2.21.1.1 消费积分抵扣

- 仅普通销售单可用；内部单、转换单、充值单不参与。
- 金额顺序固定为：成交价/店长特价 → 优惠券 → 积分 → 商品行最终应付 → 充值卡/现金支付。
- 积分抵扣上限按优惠券、积分使用前的订单金额 × `points_deduction_max_rate` 计算，同时不得超过扣券后剩余应付。
- 积分金额以扣券后各行 `sale_amount` 为权重按比例分摊，分精度四舍五入，末行吸收尾差，保证行合计与 `sale_orders.points_discount` 守恒。
- 分摊后的行 `sale_amount` 是营业额、提成和行实付上限的权威口径；部分实付不参与积分分摊权重。

#### 2.21.2 发放规则（订单链净额差值法）

发放不对单笔 `sale_order_payments` 逐笔计算（会产生累积舍入误差），改为对"原销售单"维度：

```
expected = floor( max(0, net_settled) / 100 )
其中 net_settled = SUM(sale_orders.paid_amount
                        WHERE sale_order_id = X OR ref_sale_order_id = X)
delta    = expected - SUM(point_transactions.amount WHERE ref_order_id = X)
```

`delta ≠ 0` 时写入一条流水 + 更新余额；`delta = 0` 天然幂等，无副作用。

#### 2.21.3 发放矩阵（按 sale_order_type）

| sale_order_type | 调用 settle | 使用的 originalOrderId |
|-----------------|:-----------:|-----------------------|
| 销售单          | ✅          | 自身 `sale_order_id` |
| 内部单          | ❌          | — |
| 转换单          | ✅          | `ref_sale_order_id`（补现金差价时有 delta） |

> 回款 / 退款不再独立单据，统一以 `sale_order_payments.change_type='回款' / '退款'` 表达。积分重算入口由 admin `recordPayment`（回款）/ admin `/refunds` 审批通过（退款）触发，仍按对应支付流水所属的 `sale_order_id`（部分退款时为 `sale_order_payments.ref_sale_item_id` 反查的原销售单）合并重算。

#### 2.21.4 type 取值约定

| type 值 | 使用场景 | amount 符号 |
|---------|---------|-------------|
| `等级升级奖励` | `cronTask` 每日重算会员等级时升级发放 | + |
| `消费赠送`     | 订单链净额增加，`delta > 0` | + |
| `消费冲销`     | 订单链净额下降，`delta < 0` | − |
| `到店赠送`     | 会员完成符合条件的真实到店服务 | + |

未来兑换/过期等分类扩展时追加新值（type 是自由文本，无 DB 枚举约束）。

#### 2.21.5 触发点清单

所有触发点在资金状态写入之后、事务 COMMIT 之前调用 `settlePointsSafe(client, originalSaleOrderId, source)`：

| 云函数 | 位置 | 场景 |
|--------|------|------|
| `payNotify` | 回调成功 COMMIT 前 | 微信/支付宝首次支付 / 线上回款 |
| `clientApi.order.confirmPrepaidFull` | tx 末尾 | 全额储值卡抵扣支付（paid=0 → delta=0 无写入） |
| `clientApi.order.repay`（纯卡分支） | 重算原单 paid_amount 之后 | 顾客用储值卡回款 |
| `staffApi.order.confirmOffline` | recalcCustomerType 之后 | 店长二次确认线下收款 |
| `staffApi.order.approveRefund` | recalcCustomerType 之后 | 店长审批退款单，传 `ref_sale_order_id` 作为 originalId |

**决策**：`staffApi.order.create` 阶段订单最多为 `'待确认收款'`（而非 `'已支付'`），遵循"积分在店长确认时发放"的业务约束，不在 create 调用 settle；等 `confirmOffline` 触发。

#### 2.21.6 不变量与幂等

1. `FOR UPDATE` 原销售单行锁：串行化并发回款/退款，避免双写
2. `delta = 0` 天然幂等：同一原单任意次重复调用不写流水
3. `expected = floor(max(0, net_settled) / 100)`：链净额 ≤ 0 时积分回 0，不允许负余额
4. 流水 `SUM(amount WHERE ref_order_id = X)` 恒等于 `floor(max(0, net_settled) / 100)`
5. 失败隔离：`settlePointsSafe` 捕获异常写 `operation_logs('points.settleFailed')`，**不回滚主事务**（资金正确优先）
6. Feature flag：环境变量 `POINTS_ACCRUAL_ENABLED='false'` 可一键停止所有触发点的写入

#### 2.21.7 一致性兜底

`cronTask` 每日凌晨 3 点执行一致性校验（STEP 3）：
- 扫描 `client_wechat_users.points_balance ≠ SUM(point_transactions.amount)` 的行
- 偏差写入 `operation_logs('points.balanceMismatch')`，供人工排查上游触发点 bug
- **不自动修复**（决策 D7：自动修会掩盖触发点 bug）

#### 2.21.8 会员到店积分

- 与按订单实收金额计算的“消费赠送”叠加，默认每次 20 分；配置键为 `system_configs.visit_points_reward`，0 表示关闭。
- 触发点仅为服务单最终确认：`待客户确认 → 已完成`。员工 `service.complete` 仅标记待确认，不发积分。
- 资格按服务单创建时快照判断：`service_order_type='售后'`、`client_user_id` 非空、至少一个 `service_items.unit_real_price > 0`，并排除备注为“寄存单退款专用”的假消耗。
- 粒度为同一顾客、同一 `service_date` 每天最多一次；`external_ref='visit-points:{userId}:{serviceDate}'` + 唯一索引保证三端并发幂等。
- staffApi、clientApi、admin 三个 finalize 入口独立维护副本，并在流水插入成功时同步增加 `points_balance`。
- 发放失败通过 SAVEPOINT 隔离，不回滚服务完成；写 `points.visitGrantFailed` 后由夜间 `visitPointsRetry` 仅重试失败日志，成功写 `points.visitGrantRecovered`。不扫描、不补发上线前历史服务单。
- `POINTS_ACCRUAL_ENABLED='false'` 或到店积分配置为 0 时，实时发放与夜间补偿均暂停。

#### 2.21.9 储值卡抵扣启用范围（2026-05-18 补）

| 端 | 入口 | 支持范围 | 备注 |
|----|------|----------|------|
| client | `clientApi.order.confirmPrepaidFull` | 全额抵扣（paid=0） | 适用"待支付"订单一次性走完 |
| client | `clientApi.order.repay`（纯卡分支） | 回款抵扣 | 已支付订单二次回款 |
| staff  | `staffApi.order.confirmOffline` | 全额或部分抵扣 | 店长二次确认时可勾选 |
| admin  | — | **不支持** | admin 录单仅写 received（手工录票据，不动余额）|

**业务约束**：
- 卡余额扣减走 `prepaid_cards.balance` + 写 `card_transactions` 流水（一笔抵扣 = 一行流水）
- 不允许跨顾客抵扣（`prepaid_cards.user_id` 必须 = 订单的 `client_user_id`）
- 不允许跨门店：储值卡按 `bound_store_id` 维度结算（详见 `notes/tickets/archives/2026-04-23-prepaid-card-deduction-by-store.md`）
- 退款时按比例回冲：5 通道之 #5 反向 GREATEST + insert reverse card_transaction（已在 `lib/refund-cascade.ts` 落地）

---

## 3. 权限与角色（RBAC + Scope）

### 3.1 权限矩阵

> 矩阵定义为代码常量 `PERMISSION_MATRIX`，规模为 6 角色 × 11 模块，变更需代码审查和发布，不入数据库。

#### 3.1.1 完整矩阵

| 模块 | 操作 | manager | finance | hr | product | staff | customer_mgr |
|------|------|---------|---------|-----|---------|-------|-------------|
| **workbench** | dashboard | ✅ scope 内 | ✅ scope 内 | ✅ scope 内 | - | ✅ 本门店 | - |
| **sale_order** | create | ✅ | - | - | - | - | - |
| **sale_order** | list, detail | ✅ scope 内 | ✅ scope 内 | - | - | ✅ 本门店（自己相关） | - |
| **sale_order** | confirmOffline | ✅ scope 内 | - | - | - | - | - |
| **sale_order** | close, resetFailed | ✅ scope 内 | - | - | - | - | - |
| **allocation** | save, delete | ✅ scope 内 | - | - | - | - | - |
| **allocation** | list, detail | ✅ scope 内 | ✅ scope 内 | - | - | - | - |
| **service** | create, start, complete, cancel | ✅ scope 内 | - | - | - | ✅ 仅 assigned_staff | - |
| **service** | list, detail | ✅ scope 内 | - | - | - | ✅ 仅 assigned_staff | - |
| **appointment** | list, detail | ✅ scope 内 | - | - | - | ✅ 本门店（自己相关） | - |
| **appointment** | confirm, checkin | ✅ scope 内 | - | - | - | ✅ 本门店（自己相关） | - |
| **customer** | search, detail | ✅ scope 内（完整数据） | ✅ scope 内（完整数据） | - | - | ✅ 本门店（脱敏手机号） | ✅ scope 内（完整数据） |
| **customer** | calendar, paidOrders | ✅ scope 内 | ✅ scope 内 | - | - | ✅ 本门店 | ✅ scope 内 |
| **customer** | update, create | ✅ scope 内 | - | - | - | - | ✅ scope 内 |
| **product** | read（categories, list, detail） | ✅ | - | - | ✅ | ✅ | - |
| **product** | write（create, update, delete） | - | - | - | ✅ | - | - |
| **employee** | list, detail | ✅ scope 内 | - | ✅ scope 内 | - | ✅ 本门店 | - |
| **employee** | create, update, delete | - | - | ✅ scope 内 | - | - | - |
| **finance** | dashboard, reports | ✅ scope 内 | ✅ scope 内 | - | - | - | - |
| **store** | list | ✅ scope 内 | ✅ scope 内 | ✅ scope 内 | - | ✅ 本门店 | - |
| **store** | manage（update, config） | - | - | ✅ scope 内 | - | - | - |
| **permission** | list | - | - | ✅ scope 内 | - | - | - |
| **permission** | assign, revoke | - | - | ✅ scope 内 | - | - | - |

> **`-`** = 无权限（API 返回 -403）。**scope 内** = 受 `permission_roles.scope_id` 限定，多域取并集。**本门店** = staff 固定为其 `store_id` 门店。**自己相关** = staff 仅能操作 `assigned_employee_id`/`employee_id`/`preferred_employee_id` 指向自己的记录。**脱敏手机号** = staff 查看顾客时中间 4 位为 `****`。**customer_mgr** 需叠加基础角色使用。

> 实现时按上表生成代码常量 `PERMISSION_MATRIX`（`staffApi/config/permissions.js`），键为 `module.action`，值为允许的角色数组。

### 3.2 角色+域查询

**无记录时降级**：查询 `permission_roles`（`WHERE employee_id = ? AND is_void = false`）。无记录时查 `staff_wechat_users.store_id`，降级为 `role=staff, scope_type=store`。

### 3.3 auth 上下文结构

`ctx.auth` 保留现有字段，新增多角色权限结构：

```js
ctx.auth = {
  // 现有字段（保留兼容）
  userId,           // staff_wechat_users.user_id
  openid,           // 微信 openid
  phone,            // 绑定手机号
  employeeId,        // staff_wechat_users.employee_id
  position,         // staff_wechat_users.position_name（保留兼容）
  storeName,        // staff_wechat_users.store_id → JOIN stores 获取
  marketName,       // staff_wechat_users.store_id → JOIN stores 获取
  departmentNodeId, // staff_wechat_users.org_node_id
  departmentName,   // staff_wechat_users.org_node_id → JOIN org_nodes.name 获取

  // 新增：多角色权限
  roles: [
    // 一人可有多条记录（多角色 + 一角色多域）
    {
      role,          // 'manager' | 'finance' | 'hr' | 'product' | 'staff' | 'customer_mgr'
      scope: {
        type,        // '总部' | '市场' | '门店'
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

> **聚合逻辑**：查 `permission_roles` → 每条从 `PERMISSION_MATRIX` 查该 role 的 `module:action` → 合并去重。无记录时降级（§3.2）。多域同级别时域过滤使用 `IN`。

### 3.4 域过滤与行级过滤

**域过滤（buildScopeWhere）**：所有查询统一通过此函数生成 `store_id` 过滤。headquarters 无过滤；market 展开子门店 `WHERE store_id IN (?)`；store 直接匹配。`scopeStoreIds` 登录时预解析，多域取并集。

**行级过滤（buildStaffFilter）**：管理角色（manager/finance/hr/customer_mgr）不限制行级；仅 staff 时追加 `AND {staffColumn} = employeeId`。典型组合：服务单 `+ buildStaffFilter('assigned_employee_id')`、预约 `+ ('employee_id')`、订单 `+ ('preferred_employee_id')`。

### 3.5 前端权限下发

login 返回中包含 `permissions` 字段：
- `permissions.roles[]`：每条含 `role`、`scopeType`、`scopeName`
- `permissions.actions[]`：扁平数组，如 `['sale_order:create', 'customer:search', ...]`
- 前端据此控制 UI 可见性，详见 `staff.pr.spec.md` §3.11

> 同步推导规则详见 `workfine-sync.spec.md` §4.6。

### 3.6 权限管理 API

| 接口 | 权限要求 | 说明 |
|------|----------|------|
| `permission.list` | hr（scope 内） | 查看 scope 内员工的权限角色列表 |
| `permission.assign` | hr（scope 内） | 为员工分配角色，被分配的 scope_id 必须在操作者 scope 范围内 |
| `permission.revoke` | hr（scope 内） | 撤销员工角色（软删除） |

> 被分配的 `scope_id` 必须在操作者 scope 范围内。权限分配由 hr（员工端）或 admin（管理后台）负责。

---

## 4. 核心业务规则

1. 只有 **role=manager** 可开单
2. **营业额分配**：同部门总额 ≤ 实收；跨部门各按实收金额分配（总额可达实收 N 倍）；**MVP 阶段不支持优惠/折扣，应收金额 = 实收金额**
3. **美容师选择非必须**：顾客下单时可不指定美容师
4. **日历入账口径**：仅 `已支付` 订单计入当日消费
5. **混购完成规则**：`已完成` 以**所有疗程卡行（含原单品=1 次卡）的 remaining_sessions 全部归零**为触发条件；家居产品支付即视为已交付
6. **线下付款口径**（仅 MVP）：顾客端选择线下付款先进入 `待确认收款`，店长确认后才计为 `已支付`
7. 支付成功触发条件统一为**订单进入已支付**
8. 订单在员工端开单时即写入数据库（状态 `待支付`），客户扫码后无需重复创建
9. 订单关闭/支付失败时，对应的营业额分配记录一并标记为无效（`is_void = true`）
10. **服务单来源约束**：`service_items.sale_item_id` 必须关联已支付订单的 `sale_items` 行
11. **体验/引流服务**需先创建体验单（`sale_order_type = '体验'`），支付确认后再创建服务单；体验单仅可选择体验卡商品（`product_kind = '福利活动'` 中的体验类项目），不计入普通业绩统计；体验单面向潜在客户（散客到店），由店长创建并指定归属美容师；**先服务后付款不在 MVP 范围**
12. **开单流程分级选择**：先选大类（销售单 / 内部单 / 转换单），不再支持开"回款单" / "退款单"——回款走 admin `recordPayment` / 客户端在线支付，退款走 admin `/refunds` 审批流程
13. **内部单规则**：`sale_order_type = '内部'`，员工/家属消费按半价（`unit_price = product_skus.price × 0.5`）；不算顾客数、不计入会员等级升级消费额；走正常支付和营业额分配流程
14. **顾客端自助下单的营业额分配**：已指定美容师→系统自动创建分配记录；未指定→不创建
15. **营业额分配锁定规则**：待支付且顾客未扫码时可修改；扫码后锁定
16. **手机号补全机制**：顾客绑定手机号时，批量补全 `sale_orders.client_user_id`
17. **员工开单顾客身份验证**：通过手机号查询 `client_wechat_users.phone`，填入 `client_user_id`
18. **预约取消后可重新发起**：`已取消` 可重新发起；`已关闭` 不可
19. **回款规则**：`ref_sale_order_id` 必填；回款时原子累加原 `sale_item.received`；支持多次回款（N:1）；支付方式与销售单一致；仅员工端操作
20. **转换规则**：转换单包含 `转出` 行和 `转入` 行，单事务完成；`转出` 原子扣减 `remaining_sessions`。普通转换 `total_amount` = 正补差价，负差额以 `card_transactions(type='充值', ref_order_id=转换单号)` 转入储值金；正补差允许 `receivedAmount ∈ [0,payable]`，部分收款用 `first_payment_amount` 限制首笔支付，该上限只能在真实支付回调或线下确认入账后清空，后续按订单级欠款回款。体验转换以旧卡划卡价值强制重定价转入行，订单金额/应付/实收均为 0、直接已支付、不得补退差额或形成任何支付流水，并以 `is_experience_conversion=true` 审计。
    - **疗程卡累计梯度计价**：员工端和管理后台创建销售单或转换单时，将非体验、非店长特价、非套餐的疗程卡按 `category_id + spec_name` 分组，累计次数为各行 `session_count × quantity` 之和；在同组启用且未删除的普通疗程卡 SKU 中，选择 `session_count > 1`、不超过累计次数的最高档位（同次数档取顾客适用每次价最低者），并按“档位适用总价 ÷ 档位次数 × 行次数”重算每行金额。会员适用 `special_price`，否则适用 `price`。前端仅负责预览，服务端必须以 SKU 数据权威重算；内部单、寄存单、套餐、体验卡、店长特价不参与，体验转换最终由旧卡划卡价值覆盖。
21. **退款规则**：创建时状态为 `待审批`；店长审批后原子扣减 `remaining_sessions`；`total_amount` 为负数；handling_fee 存入 `remark`
22. **回款/转换/退款仅员工端操作**
23. **capability 列 SSoT**（2026-04-26 ticket 落地）：体验卡 / 充值卡 等"特殊 SKU 行为"判定一律读 `product_skus.is_experience` / `is_recharge_card`，**禁止**写 `WHERE product_kind = '体验卡'` / `'充值卡'` 字面量。两列互斥（`chk_sku_not_both_capabilities` CHECK 保护）。`product_kind` 仅作组织/分类标签。开单时 `sale_items` 自动快照同名列，行级不可变（admin 后续修改 SKU capability 不影响历史订单）。
24. **D4 充值卡严格独立**：同一订单 `sale_items.is_recharge_card` 必须全 true 或全 false；混合下单抛 `INVALID_PARAMS: MIXED_RECHARGE_NOT_ALLOWED`。三端应用层（admin / staff / client）已加显式守卫，DB trigger `trg_check_no_mixed_recharge` 在 COMMIT 兜底。
25. **customer_type 跃迁（event-driven）**：在三处收款触发点同步重算 — `payNotify`（线上支付回调）/ `staffApi.order.confirmOffline`（线下确认）/ `admin.recordPayment`（后台补录）。跃迁 SQL **三端独立副本**（admin `actions/orders.ts` + staffApi `routes/order.js` + payNotify `index.js`），由 `staffApi/__tests__/routes/recalc-customer-type-sql.test.js` 字节守卫一致性。判定逻辑：
    - `EXISTS(销售单 total_amount ≥ threshold)` → `会员客`
    - `EXISTS(销售单 sale_items.is_experience = false)` → `小美客`（充值卡的 `is_experience = false`，自动计入此通道，D1=A 决策）
    - `EXISTS(销售单 sale_items.is_experience = true)` → `体验客`
    - 否则 `流量客`
    - 客户分类**只升不降**（取 max(current, computed)）
    - `customer_type='会员客'` 早退出，无需重算

---

## 5. 状态机

### 5.1 订单状态机

```text
待支付 → 已支付          （微信支付回调成功）
待支付 → 待确认收款      （顾客选择线下付款提交）
待支付 → 支付失败        （微信支付超时/失败）
待支付 → 已关闭          （手动关闭）
待确认收款 → 已支付      （店长确认线下收款）
支付失败 → 待支付        （店长手动重置，允许重新付款）
已支付 → 已完成          （全部 remaining_sessions 归零；家居产品支付即完成）
```

### 5.2 服务单状态机

```text
待服务 → 服务中            （开始服务）
服务中 → 待客户确认        （员工标记完成，仅记 staff_completed_at，无副作用）
待客户确认 → 已完成        （顾客 / 店长 / 后台代确认，原子扣次数 + 计提成 + 关预约）
待服务 → 已取消            （取消服务单，不扣次）
服务中 → 已取消            （取消服务单，不扣次）
待客户确认 → 已取消        （确认前店长可撤，不扣次）
```

> **顾客确认才算完成**：员工点「完成」只把状态推进到 `待客户确认`，不产生任何不可逆副作用；
> 扣减卡剩余次数、计算美容师提成、关闭关联预约这三件事统一推迟到「确认」那一步原子执行。
> 确认入口三个：顾客本人（clientApi `service.confirm`）、店长代确认（staffApi `service.confirm`）、
> 后台代确认（admin `confirmServiceOrder`）；并发由 `WHERE status='待客户确认'` 锁定保证幂等。
> finalize 副作用 SQL 在 staffApi / clientApi 双端各持独立副本，由 `cross-end-sql-snapshot.test.js` 守护。

### 5.3 预约状态机

```text
待确认 → 已确认          （员工确认预约）
待确认 → 已取消          （顾客取消）
已确认 → 已取消          （顾客取消）
已确认 → 已完成          （关联服务单完成后自动流转）
待确认 → 已关闭          （超期 / 次数归零）
已确认 → 已关闭          （超期 / 次数归零）
```

### 5.4 营业额分配状态机

```text
null → 待分配               （订单支付成功）
待分配 → 已分配              （店长完成分配）
已分配 → 待分配              （店长删除重新分配）
```

### 5.5 退款审批状态机

```text
待审批 → 已审批（已支付）     （审批人审批通过，触发 remaining_sessions 原子扣减 + 退款业绩记录）
待审批 → 已关闭              （审批人驳回退款申请）
```

> 退款单创建时 `status = '待审批'`，审批通过后流转为 `已支付`（复用已有状态表示退款已生效）。

**审批权限**（2026-05-17 PR-Z2）：
- admin 后台（Next.js）：`sale_order:refund_approve` 由 **admin + manager** 双角色持有；admin 在 manager 缺位时可代理审批。manager 在本店内可自审自批（接受其同时持 `refund_create`+`refund_approve`）
- staff 端（员工端小程序，`staffApi.order.approveRefund`）：仍由 **店长（manager）** 独审，与现有移动场景一致

---

## 6. 异常场景处理

| 场景 | 处理方式 |
|------|----------|
| 重复下单 | 部分唯一索引拦截 |
| 重复支付回调 | 仅第一次成功回调生效 |
| 重复线下确认收款 | 仅第一次确认生效 |
| 网络抖动导致推送失败 | 轮询兜底保证最终一致 |
| 并发核销 | 原子 UPDATE + rowCount 校验 |

---

## 7. MVP 验收标准

> 员工端日历相关验收标准（AC-01~AC-03）已移至 `staff.pr.spec.md` §7。

| ID | 标准 | 验证方式 |
|----|------|----------|
| AC-01 | 同一服务单重复点击"完成服务"不产生重复扣次 | 连续点击完成 → 仅扣一次 |
| AC-02 | 角色越权操作应被拒绝 | 越权操作 → 返回 -403 |
| AC-03 | PG stores/staff_wechat_users/client_wechat_users 表数据完整且关键字段一致 | 查询 PG 验证数据完整性 |
| AC-04 | 各端门店列表、员工列表、顾客搜索均从 PG 查询，响应时间 < 500ms | 接口计时 |
| AC-05 | 外部数据源不可用时，门店/员工/顾客查询不受影响 | 断开外部连接 → 验证查询正常 |
| AC-06 | 数据同步后，新增/变更的门店/员工/顾客数据在 PG 中正确更新 | 修改源数据 → 触发同步 → 验证 PG |
| AC-07 | 小程序中完成开单后，PG sale_orders 表中 client_user_id 正确填入 | 开单 → 查询 sale_orders.client_user_id |
