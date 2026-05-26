# 01 — `order` 模块（验证模板用）

**Schema 文件**：`db/schema/order.ts`
**涉及 PG 表**：`sale_orders`, `sale_items`, `sale_allocations`, `sale_order_payments`
**WorkFine 源表**：
- `UDT_S_209` 销售单主表（81568 行）
- `UDT_M_213` 销售明细子表（118213 行，按 RID 关联 UDT_S_209）
- `UDT_M_217` 营业额分配子表（124649 行，按 RID 关联 UDT_S_209）
- `UDT_M_260` 售后护理明细（856791 行，仅用 CTE 聚合次数）
- `UDT_M_1259` 收款方式明细 — ⚠️ **当前未对接到 PG**

**主要迁移脚本**：
- `db/scripts/migrate-history-orders.js` — sale_orders + sale_items 主体（79513 / 115463 行）
- `db/scripts/migrate-allocations.js` — sale_allocations（按 sale_amount 比例拆分到 item 级）
- `db/scripts/migrate-prepaid-cards.js` — 充值卡相关订单（标 `WorkFine拓客卡导入`，24966 行）
- `db/scripts/migrate-phantom-items.js` — 流水号缺失订单（标 `WorkFine phantom流水号导入`，22784 行）
- `db/scripts/migrate-jclsh-items.js` — 结存项目（标 `WorkFine结存项目导入`，15517 行）

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 表 | 总行数 | WorkFine 来源行数 |
|----|-------|-----------------|
| sale_orders | 142811 | 142780（按 remark 标识） |
| sale_items | 208051 | 115463（仅 history 来源已确认，其他 3 个脚本未单独统计） |
| sale_allocations | 156715 | 全部（migrate-allocations.js 唯一写入入口） |
| sale_order_payments | 75258 | 75244（剩余 14 行非 WorkFine） |

> 本文档**重点 trace migrate-history-orders.js**（信号最强、79513/115463 行）。其他 3 个脚本（拓客卡 / phantom / 结存）的字段映射作为补充章节简要列出，待后续轮次单独深挖。

---

## 表 1：`sale_orders`

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| sale_order_id | varchar(30) | WorkFine 直拷 | `RTRIM(UDT_S_209.UDF_S_372)` | migrate-history-orders.js:L82, L256 | 销售单号 `FY-XSD{YYMMDD}{序号}`；脚本第 135 行跳过含 `-WX-` 的 PG 原生订单 |
| status | order_status enum | 默认值/NULL | 硬编码 `'已完成'`（历史订单） | migrate-history-orders.js:L256 | 历史订单全部视为已完成 |
| sale_order_type | sale_order_type enum | 默认值/NULL | 硬编码 `'普通'` → migration 0028-0031 重映射为 `'销售单'` | migrate-history-orders.js:L256 + migration 0028-0031 | 现状 PG 全为 `'销售单'`；新枚举 5 值（销售/内部/回款/转换/退款）历史导入只能进 `'销售单'` |
| document_type | document_type enum | WorkFine 派生（**不来自** UDF_S_371） | PG 端规则推导：① `client_wechat_users.customer_type = '会员客'` → `售后`；② total_amount ≥ system_configs `new_member_threshold`（默认 1990）→ `售后`；③ 否则 `售前`；④ 引用单（回款/转换/退款）继承原单；⑤ 兜底 NULL → `售前` | `_archive_pre_baseline_2026_04/sql/0023_document_type.sql` | ⚠️ **WorkFine UDF_S_371（业绩类型 5 值：售前一次/二次/老带新/线上美团首次/售后）的语义未保留**。PG 现在的 售前/售后 是基于"当前会员状态 + 金额阈值"重新分类的，与 WorkFine 原始业绩归类不一致。R1.5 调研发现 |
| ref_sale_order_id | varchar(30) | 默认值/NULL | NULL（销售单无引用） | schema:L49 | 仅退款/转换/回款单使用 |
| market_name | varchar(100) | WorkFine 直拷 | `RTRIM(UDT_S_209.UDF_S_348)` | migrate-history-orders.js:L84, L256 | 市场名快照 |
| store_id | text | WorkFine 派生 | `storeMap[RTRIM(UDT_S_209.UDF_S_349)]`（PG `stores.store_name` lookup） | migrate-history-orders.js:L143-145, L402-404 | 门店名 → store_id 转换；未匹配的订单跳过 |
| sale_order_datetime | timestamp | WorkFine 直拷 | `UDT_S_209.UDF_S_350`（datetime2 → timestamp） | migrate-history-orders.js:L83, L256 | 销售日期 |
| client_user_id | text | WorkFine 派生 | `customerMap[RTRIM(UDT_S_209.UDF_S_1485)]`（PG `client_wechat_users.customer_id` lookup） | migrate-history-orders.js:L138-140, L396-400 | 顾客编号 → user_id；未匹配的订单跳过（stats.skippedNoCustomer） |
| client_phone | varchar(30) | 默认值/NULL | NULL | — | 历史订单未抽取 phone；运行时新订单 staffApi.order.create 写入 |
| customer_name | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_209.UDF_S_370)` | migrate-history-orders.js:L86, L256 | 顾客名快照 |
| total_amount | numeric(10,2) | WorkFine 派生 | `Σ(item.UDT_M_213.UDF_M_395)` 按订单聚合 | migrate-history-orders.js:L252 | 注意：脚本用明细 `sale_amount` 之和而非主表 `UDT_S_209.UDF_S_507`。两者**应该相等**，但未交叉校验 |
| prepaid_card_amount | numeric(10,2) | 默认值/NULL | `0`（schema default） | schema:L62 | 历史订单不抽取储值卡抵扣；migration 0019 后才有此列 |
| payable_amount | numeric(10,2) | WorkFine 派生 | migration 0004:L38 `UPDATE sale_orders SET payable_amount = total_amount - prepaid_card_amount` 全量回填 | `0004_yellow_magma.sql:L38` | 等于 total_amount（因 prepaid_card_amount 全为 0）|
| paid_amount | numeric(10,2) | WorkFine 派生（多步） | ① migrate-history-orders.js 写 0 → ② migration 0003:L58 `UPDATE sale_orders SET paid_amount = total_amount WHERE paid_amount = 0` 全量回填 → 等于 sale_orders.total_amount（即 Σ UDT_M_213.UDF_M_395） | migrate-history-orders.js + `0003_abandoned_aqueduct.sql:L58` | R1.5 追溯：现在 75244 行 paid_amount > 0（剩余 4269 行 total_amount = 0 也被跳过保留为 0） |
| payment_method | payment_method enum | 默认值/NULL | 硬编码 `'线下'` | migrate-history-orders.js:L256 | 历史订单一律视为线下支付 |
| opened_by | varchar(30) | 默认值/NULL | NULL | — | 开单员工不可考；脚本未抽取 |
| preferred_employee_id | varchar(30) | 默认值/NULL | NULL | — | 偏好美容师不可考 |
| paid_at | timestamp | 默认值/NULL | NULL | — | 历史订单未抽取支付时间；理论上等于 sale_order_datetime |
| wechat_transaction_id | varchar(64) | 默认值/NULL | NULL | — | 线上支付字段，历史无 |
| alipay_transaction_id | varchar(64) | 默认值/NULL | NULL | — | 线上支付字段，历史无 |
| offline_confirmed_by | varchar(30) | 默认值/NULL | NULL | — | 线下确认人，历史无 |
| offline_confirmed_at | timestamp | 默认值/NULL | NULL | — | 线下确认时间，历史无 |
| allocation_status | allocation_status enum | WorkFine 派生 | `'已分配'`（migrate-history-orders.js 写入时；migrate-allocations.js 完成后再 UPDATE 确认 `'已分配'`） | migrate-history-orders.js:L256 + migrate-allocations.js:L315-324 | |
| coupon_id | text | 默认值/NULL | NULL | — | 历史订单不抽取券；UDT_S_209.UDF_S_17216(本单消耗现金券) 未对接 |
| coupon_discount | numeric(10,2) | 默认值/NULL | `0`（schema default） | schema:L83 | 同上 |
| remark | text | 默认值/NULL | 硬编码 `'WorkFine历史订单导入'`（用作来源标识） | migrate-history-orders.js:L256 | **重要：此值是后续 SQL 识别 WorkFine 来源行的唯一标识**，未来迁移脚本必须保留这个语义 |
| refund_reason | text | 默认值/NULL | NULL | — | 退款字段，销售单不用 |
| handling_fee | numeric(10,2) | 默认值/NULL | NULL | — | 退款字段 |
| approved_by | varchar(30) | 默认值/NULL | NULL | — | 退款字段 |
| approved_at | timestamp | 默认值/NULL | NULL | — | 退款字段 |
| rejected_reason | text | 默认值/NULL | NULL | — | 退款字段 |
| overdraft_deduction | numeric(10,2) | 默认值/NULL | `0`（schema default） | schema:L98 | 退款字段 |
| overdraft_deduction_detail | jsonb | 默认值/NULL | NULL | — | 退款字段 |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L101 | INSERT 时间，与 sale_order_datetime 不同 |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L102 | |

### 已被脚本抽取但 PG schema 未存的 WorkFine 列（业务信息流失）

UDT_S_209 共 37 列，migrate-history-orders.js 仅用了 7 列（UDF_S_348/349/350/370/372/507/1485）。下列 WorkFine 列**有业务含义但当前 PG 没存**（参考 `notes/research/workfine_database.md` 业务定义）：

| WorkFine 列 | 含义 | 现状 |
|-------------|------|------|
| UDF_S_371 | 业绩类型（售前一次/售后/...） | ⚠️ **可能间接被回填到 document_type**（见 _gaps.md） |
| UDF_S_523 | 收款核对（"正确"/"错误"） | 未对接 |
| UDF_S_844 | 本单业绩（与 UDF_S_507 收款合计可能不等） | 未对接 |
| UDF_S_3321 | 来源动作描述（"查询往期消费"等） | 未对接 |
| UDF_S_3323 | 美容部充公业绩 | 未对接 |
| UDF_S_4729 | 本单欠款合计 | 未对接，但 PG 现状无对应列（4937 已付款次数也未存） |
| UDF_S_13708 | 顾客来源（"自进"/"推广部拓客"等） | 未对接（理论上应进 client_wechat_users.source_channel） |
| UDF_S_13710 | 销售类型（全额销售/回单销售） | 未对接 |
| UDF_S_17178/17179 | 促销方案 ID / 名称 | 未对接 |
| UDF_S_17190 | 赠送现金券 | 未对接 |
| UDF_S_17194 | 现金券可用余额（下单时） | 未对接 |
| UDF_S_17216 | 本单消耗现金券 | 未对接（应进 coupon_discount） |
| UDF_S_17315 | 是否锁客 | 未对接 |
| UDF_S_17700 | 上传审批附件 | 未对接（文件类） |
| UDF_S_18162 | 是否纳客 | 未对接 |
| UDF_S_18619 | 会员等级（下单时） | 未对接（理论上是会员级别快照，可能进 client_wechat_users） |
| UDF_S_18706 | 是否审批 | 未对接 |

---

## 表 2：`sale_items`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| sale_item_id | varchar(30) | WorkFine 直拷 | `RTRIM(UDT_M_213.UDF_M_852)` | migrate-history-orders.js:L80, L275 | 销售流水号 `XSLSH-{YYYYMMDD}{序号}`；135 行跳过 `-WX-` 标识 PG 原生项 |
| sale_order_id | varchar(30) | WorkFine 直拷 | `RTRIM(UDT_S_209.UDF_S_372)`（按 RID 关联） | migrate-history-orders.js:L81, L275 | INNER JOIN 拿到主表订单号 |
| store_id | text | ⚠️ 未覆盖 | 应该 = `sale_orders.store_id`（schema 强制冗余） | — | **migrate-history-orders.js 未在 INSERT 列中包含 store_id**（脚本 L284-289 INSERT 列清单不含 store_id），但 schema 标记 `notNull`。需要核对：是否后续 migration 加列时被回填？ |
| item_direction | item_direction enum | 默认值/NULL | 硬编码 `'购买'` | migrate-history-orders.js:L275 | 历史订单全是购买行 |
| ref_sale_item_id | varchar(30) | 默认值/NULL | NULL | — | 仅 convert_out/refund_out 行用 |
| sku_id | text | ⚠️ 未覆盖 | NULL（迁移时商品 SKU 还未建立完整映射） | — | 历史明细的 sku_id 全部为 NULL，依赖 product_name/sku_spec_name 快照展示 |
| product_name | text | WorkFine 直拷 | `RTRIM(UDT_M_213.UDF_M_393)` | migrate-history-orders.js:L188, L275 | 项目名称 |
| sku_spec_name | text | ⚠️ 未覆盖 | NULL（脚本未填） | — | 历史无规格名，全部 NULL |
| product_type | product_type enum | WorkFine 派生 | `UDT_M_213.UDF_M_4728` 映射：疗程卡/自定义-疗程→`'疗程卡'`，单品/自定义-单品→`'单品'`，其他→`'单品'` | migrate-history-orders.js:L153-167 | |
| session_count | integer | WorkFine 派生 | 疗程卡：`Math.round(UDT_M_213.UDF_M_394)`；单品：固定 `1` | migrate-history-orders.js:L155, L160 | |
| remaining_sessions | integer | WorkFine 派生 | 疗程卡：`max(0, UDF_M_394 - Σ(UDT_M_260.UDF_M_836 WHERE UDF_M_4904 = sale_item_id))` 由 CTE `usage` 聚合；单品：`0` | migrate-history-orders.js:L71-78（CTE）, L156-167 | **本字段是历史核销次数的核心 derive，是 PG 卡数耗用判断依据** |
| unit_price | numeric(10,2) | WorkFine 直拷 | `max(0, UDT_M_213.UDF_M_4949)` | migrate-history-orders.js:L169, L275 | 原价标准价 |
| quantity | integer | 默认值/NULL | 硬编码 `1` | migrate-history-orders.js:L275 | **注意**：UDT_M_213.UDF_M_14494 是销售数量（决定卡数），但脚本未取，全部按 1 处理；schema 表里 sale_amount 已包含 quantity 因子，所以差异主要影响 UI 展示 |
| unit_real_price | numeric(10,2) | WorkFine 直拷 | `max(0, UDT_M_213.UDF_M_395)`（销售金额作单价） | migrate-history-orders.js:L170, L275 | 因 quantity=1，单价=总金额 |
| sale_amount | numeric(10,2) | WorkFine 直拷 | `max(0, UDT_M_213.UDF_M_395)` | migrate-history-orders.js:L170, L275 | 销售金额（优惠后标准价） |
| received | numeric(10,2) | WorkFine 直拷 | `UDT_M_213.UDF_M_399`（无 max 0） | migrate-history-orders.js:L171, L275 | 实收金额；理论上 ≤ sale_amount，差额 = UDT_M_213.UDF_M_400 顾客欠款 |
| expire_date | date | WorkFine 直拷 | `UDT_M_213.UDF_M_7122` → YYYY-MM-DD | migrate-history-orders.js:L196, L275 | 疗程卡到期日 |
| picked_up_quantity | integer | 默认值/NULL | `0`（schema default） | schema:L164 | 家居产品提货次数，历史无 |
| remark | text | WorkFine 直拷 | `RTRIM(UDT_M_213.UDF_M_16124)` | migrate-history-orders.js:L197, L275 | 项目备注 |
| sales_category | sales_category enum | 默认值/NULL | 硬编码 `'自销自耗'` | migrate-history-orders.js:L275 | 历史无销售类别区分 |
| service_fee | numeric(10,2) | 默认值/NULL | `0`（schema default） | schema:L168 | 固定手工费快照，历史无（运行时从 product_skus 拷贝） |
| is_shengmei | boolean | 默认值/NULL | NULL | — | 生美标志，历史无（migration 0014 才加） |
| created_at / updated_at | timestamp | 新系统独立 | `defaultNow()` | schema:L171-175 | |

### 已被脚本抽取但 PG schema 未存的 WorkFine 列

UDT_M_213 共 22 列，脚本仅用了 11 列。未对接的：

| WorkFine 列 | 含义 | 现状 |
|-------------|------|------|
| UDF_M_392 | 品项分类 | ⚠️ 脚本读了但只用作 `category_name` 别名，未写入 PG（参考 product_categories？） |
| UDF_M_396 | 单价优惠 | 未对接（运行时通过 unit_price - unit_real_price 推导） |
| UDF_M_397 | （decimal） | 未对接，含义不明 |
| UDF_M_398 | 应收金额 | 未对接（理论上 = sale_amount - 抵扣） |
| UDF_M_400 | 顾客欠款 | 未对接（应等于 sale_amount - received） |
| UDF_M_4937 | 已付款次数 | 未对接（分期付款字段） |
| UDF_M_4938 | 单次价格 | 未对接（衍生量，可计算） |
| UDF_M_4939 | 是否赠送 | ⚠️ **业务关键字段未对接**：脚本未抽，但赠送项的 received=0，PG 无法直接区分赠送/正常零金额 |
| UDF_M_14494 | 销售数量 | ⚠️ 脚本固定 quantity=1，**实际数量 ≥ 2 的历史订单数据失真** |
| UDF_M_14495 | 疗程项目编号 | 未对接（关联到 product_categories 的字段） |
| UDF_M_14496 | 单位 | 未对接 |

---

## 表 3：`sale_allocations`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial | 新系统独立 | DB autoincrement | schema:L199 | |
| sale_item_id | varchar(30) | WorkFine 派生 | 单 item 订单：直接映射；多 item 订单：按 sale_amount 比例拆分到每个 item | migrate-allocations.js:L170-235 | **核心派生逻辑**：WorkFine 一条 allocation 是订单级，PG 是 item 级 |
| employee_id | varchar(30) | WorkFine 直拷 | `RTRIM(UDT_M_217.UDF_M_2316)` | migrate-allocations.js:L59, L282 | |
| allocation_ratio | numeric(5,2) | WorkFine 派生 | `min(999.99, round(itemAlloc / item.sale_amount * 100) / 100)`（分配额 / 项目销售额） | migrate-allocations.js:L174, L221 | item.sale_amount=0 时回退 1.00 |
| role_type | varchar(20) | WorkFine 派生 | `staff_wechat_users.skills[0]`，缺省 `'美容师'` | migrate-allocations.js:L168 | **不来自 WorkFine**：从 PG 员工 skills 数组首位推导。⚠️ 准确性依赖 staff_wechat_users.skills 数据质量 |
| department_name | varchar(100) | WorkFine 直拷 | `RTRIM(UDT_M_217.UDF_M_13713)` | migrate-allocations.js:L62, L282 | |
| total_amount | numeric(10,2) | WorkFine 派生 | 单 item：`UDT_M_217.UDF_M_13715` 直接映射；多 item：按比例分配，最后一行承接舍入误差 | migrate-allocations.js:L181, L211 | 同一员工同一 item 多次出现时**合并金额**（dedup L442-451） |
| is_void | boolean | 默认值/NULL | `false` | schema:L213 | |
| voided_at | timestamp | 默认值/NULL | NULL | — | |
| created_at / updated_at | timestamp | 新系统独立 | `defaultNow()` | schema:L215-219 | |

### 已被脚本抽取但 PG schema 未存的 WorkFine 列

UDT_M_217 共 13 列，脚本用了 7 列（UDF_M_418/419/2315/2316/13713/13715）。未对接的：

| WorkFine 列 | 含义 | 现状 |
|-------------|------|------|
| UDF_M_418 | 职位（"代理经理"等） | ⚠️ 脚本读了但**未写入 PG**（PG 无 position_name 列于 sale_allocations） |
| UDF_M_419 | 员工姓名 | 同上，仅作 employee_name 别名读出未写 |
| UDF_M_420 | 个人业绩1眉眼 | 未对接（业绩拆分到品类的明细） |
| UDF_M_421 | 个人业绩2唇 | 未对接 |
| UDF_M_422 | 祛斑点痣业绩 | 未对接 |
| UDF_M_423 | 单品业绩 | 未对接 |
| UDF_M_2315 | 职位序列编码 | 同 UDF_M_418，未写入 |

---

## 表 4：`sale_order_payments`

**R1.5 已追溯到来源**：`db/migrations/0004_yellow_magma.sql:L41-110` migration 末尾 3 段 INSERT INTO ... SELECT FROM sale_orders。该 migration 在 2026-03-14 部署，全部 75244 行 WorkFine-linked payments 都集中在那一天创建。完整链路：

1. `migrate-history-orders.js` 写 sale_orders（paid_amount=0）
2. `0003_abandoned_aqueduct.sql:L58` 回填 paid_amount = total_amount（全量 UPDATE）
3. `0004_yellow_magma.sql:L41-62` 销售单 INSERT 一行 `'首次支付'` 流水（命中条件 paid_amount > 0 → 75244 行 + 14 行非 WorkFine 来源 = 75258 总）
4. `0004_yellow_magma.sql:L64-86` 回款单 INSERT `'回款'` 流水（指向 ref_sale_order_id）
5. `0004_yellow_magma.sql:L88-110` 退款单 INSERT `'退款'` 流水

### 列级血缘（确认）

| PG 列 | 类型 | 来源类别 | 来源 SQL | 备注 |
|------|------|---------|---------|------|
| id | bigserial | 新系统独立 | DB autoincrement | |
| sale_order_id | varchar(30) | WorkFine 派生 | 销售单：`sale_orders.sale_order_id`；引用单：`sale_orders.ref_sale_order_id` | 一对一关联到原销售单 |
| change_type | payment_change_type enum | 默认值/NULL | 硬编码 `'首次支付'` / `'回款'` / `'退款'` | 历史 75258 行全部为 `'首次支付'`（migrate-history-orders 时 sale_order_type='普通' 走销售单分支） |
| amount | numeric(10,2) | WorkFine 派生 | `sale_orders.paid_amount`（即 total_amount） | |
| payment_method | payment_method enum | WorkFine 派生 | `sale_orders.payment_method`（历史订单全为 `'线下'`） | |
| external_txn_id | text | WorkFine 直拷 | `COALESCE(wechat_transaction_id, alipay_transaction_id)` | 历史订单两者全 NULL，结果也是 NULL |
| status | payment_flow_status enum | 默认值/NULL | 硬编码 `'已支付'` | |
| source_end | payment_source_end enum | WorkFine 派生 | `CASE WHEN opened_by IS NOT NULL THEN 'staff' ELSE 'client' END` | 历史订单 opened_by 全 NULL → 全部 `'client'` |
| operator_employee_id | varchar(30) | WorkFine 直拷 | `sale_orders.opened_by`（历史全 NULL） | |
| note | text | 默认值/NULL | 硬编码 `'系统迁移回填'`（销售单）/ `'系统迁移回填（回款凭证）'`（回款）/ `'系统迁移回填（退款凭证）'`（退款） | |
| created_at | timestamp | WorkFine 派生 | `sale_orders.created_at`（即 INSERT migrate-history-orders 时刻） | |
| paid_at | timestamp | WorkFine 派生 | `COALESCE(sale_orders.paid_at, created_at)` | 历史 paid_at NULL → 全部等于 created_at |

> **过滤条件**：migration 0004 SELECT 同时要求 `payment_method NOT IN ('微信','支付宝') OR external_txn_id IS NOT NULL`，避免违反 chk_sop_method_txn 约束。历史订单全部 payment_method='线下' 满足前半条件全部命中。

---

## 其他 3 个 sale_orders 来源（待后续轮次深挖）

| remark 标识 | 行数 | 脚本 | 一句话说明 |
|-------------|-----|------|-----------|
| `WorkFine拓客卡导入` | 24966 | `migrate-prepaid-cards.js` + `migrate-active-cards.js` | 拓客卡（TKKLS-）作为 sale_orders 入库；与 prepaid_cards 表关联 |
| `WorkFine phantom流水号导入` | 22784 | `migrate-phantom-items.js` | UDT_M_260（核销）引用了某个 sale_item_id，但 UDT_M_213 中找不到该 item — 需要"凭空"生成 sale_orders/sale_items 行才能挂上服务记录 |
| `WorkFine结存项目导入` | 15517 | `migrate-jclsh-items.js` | "结存项目"专项处理（jclsh = 结存流水号）|

每个脚本的字段血缘留待 R1.5 / 后续轮次单独成文，避免本轮模板验证范围爆炸。

---

## 关键决策摘要

1. **来源标识**：sale_orders.remark 是识别 WorkFine 来源的**唯一标识**。新迁移脚本必须保留 4 种 remark 字面值之一，否则后续审计 SQL 会失效。
2. **量级裁剪**：脚本对 quantity 一律按 1 处理（UDF_M_14494 未抽取），影响多件订单展示；如最终迁移要修正，需要同步重算 unit_real_price = sale_amount / quantity。
3. **赠送标志缺失**：UDT_M_213.UDF_M_4939（赠送=是/否）未抽取，赠送行的 received=0 与正常零元订单无法区分；建议最终迁移把它进 `sale_items.remark` 或新增列。
4. **allocation 拆分有舍入误差**：migrate-allocations.js 的多 item 拆分把舍入误差堆到最后一个 item，理论 OK；但本轮未做"WF 端 sum vs PG 端 sum"交叉对账。
5. ~~**sale_order_payments 来源不明**~~ → **R1.5 已解决**：来自 migration 0003+0004 末尾的 backfill UPDATE/INSERT，整链路追溯完毕。
6. ~~**document_type 来源不明**~~ → **R1.5 已解决**：来自 archived migration 0023_document_type.sql；**关键发现：用 PG 自身规则重新推导，没有保留 WorkFine UDF_S_371 的"业绩类型"原始语义**（5 值压缩为 2 值且分类逻辑完全不同）。如果业务侧需要"业绩类型"原始 5 值（售前一次/二次/老带新/线上美团首次/售后），最终迁移要补一列 `legacy_perf_category` 抽 UDF_S_371 原值。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- ~~`sale_orders.document_type` 来源不明~~ → R1.5 已解决（archived 0023 用 PG 规则推导，**业绩类型原始语义已丢失**，可能需要补 legacy_perf_category 列保留 UDF_S_371）
- ~~`sale_orders.payable_amount / paid_amount` 与 sale_order_payments 不一致~~ → R1.5 已解决（migration 0003+0004 链式回填）
- `sale_orders.opened_by / preferred_employee_id` — UDT_S_209 是否有对应字段未确认；历史订单全 NULL
- `sale_orders.UDF_S_18619 (会员等级)` 未对接
- `sale_orders.UDF_S_4729 (本单欠款)` 未对接，PG 中也无承载列
- `sale_orders.UDF_S_17216 (本单消耗现金券)` 应进 coupon_discount，未对接
- `sale_orders.UDF_S_371 (业绩类型 5 值)` 原始语义已丢失（被 PG 规则压缩成 售前/售后 2 值）
- `sale_items.store_id` — 必填字段，但 INSERT 列清单不含；推测有后续 migration UPDATE，需找到补丁
- `sale_items.UDF_M_4939 (赠送)` 业务关键字段未对接
- `sale_items.UDF_M_14494 (销售数量)` 全部硬编码为 1
- `sale_items.sku_id` 全部为 NULL，无法关联 product_skus
- `sale_allocations.UDF_M_420-423 (业绩品类拆分)` 未对接（4 个金额列）
- ~~`sale_order_payments` 整表字段来源不明~~ → R1.5 已解决（migration 0004 末尾 3 段 INSERT FROM sale_orders）
- `UDT_M_1259` 收款方式明细整表未对接（运行时 PG 用一对多 payments，但历史订单的 WorkFine 端多支付方式拆分信息已丢失，全部归并为单行 `'线下/首次支付'`）

---

## Review 报告（2026-04-26）

独立调研流程：① 读 schema/order.ts；② 读 migrate-history-orders.js / migrate-allocations.js + db/migrations/*.sql + archive/*.sql；③ MSSQL probe（`db/.tmp-probe-01.js`，已删）；④ PG 5434 probe；⑤ 形成结论后再读 01-order.md 比对。

### 一致项（高质量，无需修订）

- **PG 行数四类 remark 标识**：history=79513 / 拓客卡=24966 / phantom=22784 / 结存=15517 ✅
- **sale_orders 总行 142811** ✅
- **sale_items 总行 208051**、**sale_allocations 156715**、**sale_order_payments 75258** ✅
- **document_type 5434 现状**（售前 138866 / 售后 3945）与"会员客 + ≥1990 阈值"派生规则**逻辑一致**
- **sku_id null 207984/208051** ✅（仅 67 行非 NULL，全是运行时新订单）
- **sale_items quantity 分布**确实 ≈ 100% = 1（仅 7 行 ≠1，运行时新数据），证实 UDF_M_14494 失真说法 ✅
- **UDF_S_371 5 值分布**实测：售后 51816 / 售前一次 22117 / 售前二次 5828 / 线上美团首次 1036 / 老带新 790 ✅
- **UDF_M_4939 赠送=是 26889/118234 ≈ 23%**，文档"业务关键"判断成立 ✅
- **UDT_M_213 22 列 / UDT_S_209 37 列 / UDT_M_217 13 列** 列数对得上 ✅
- **WorkFine 行数级别**与文档 snapshot 接近（自然增长 ~19~183 行 drift，可接受）

### 偏差明细

#### A. 缺漏（关键）

1. **sale_items.store_id 回填来源已可定位，文档未指出**
   - 文档（line 108、_gaps.md line 28）说 "推测有后续 migration UPDATE，需找到补丁"
   - 实际：post-baseline `db/migrations/0002_parched_marvel_boy.sql:L7-11` 显式 ADD COLUMN + `UPDATE sale_items si SET store_id = so.store_id FROM sale_orders so WHERE si.sale_order_id = so.sale_order_id` + ALTER NOT NULL + ADD FK
   - PG 验证：`sale_items WHERE store_id IS NULL` 行数 = **0**（已全量回填成功）
   - 修复建议：文档应直接列出 `db/migrations/0002_parched_marvel_boy.sql` 为 sale_items.store_id 的来源；_gaps.md 该条可结案

2. **未列出 db/migrations/0002 / 0003 / 0004 的实际部署时间和路径**
   - 文档仅说 "0003_abandoned_aqueduct.sql:L58 全量回填"，但**未说明在 db/migrations/ 还是 archive/**
   - 文件 mtime 表明这些是 post-baseline migrations（2026-04-24 落地），not pre-baseline archive

3. **sale_allocations dedup key 描述不精**
   - 文档 line 162 说 "同一员工同一 item 多次出现时合并金额（dedup L442-451）"
   - 实际：dedup key = `${saleItemId}|${employeeId}`（**不含 roleType**），schema unique 是 `(saleItemId, employeeId, roleType)`
   - 影响：若同员工对同 item 有不同 roleType 的 WF 行（极小概率），dedup 会错误压平。当前业务无此样本，但语义不准

#### B. 错配（路径/事实写错）

4. **migration 部署时间错** ⚠️
   - 文档 line 185 / 关键决策 line 232：`0004_yellow_magma.sql 在 2026-03-14 部署，全部 75244 行 WorkFine-linked payments 都集中在那一天创建`
   - 实际：post-baseline 0003 mtime = **2026-04-24 10:47**、0004 mtime = **2026-04-24 11:20**。整个 sale_order_payments 表 75258 行的实际 INSERT 时刻是 **2026-04-24**（baseline reset 是 2026-04-10）
   - 影响：审计/排查 sale_order_payments 来源时找错时间窗

5. **0004 INSERT WHERE 条件遗漏**
   - 文档 line 189 / 表 4 line 209："命中条件 paid_amount > 0 → 75244 行"
   - 实际 SQL（0004:L59-62、L82-86、L106-109）WHERE 完整条件：`sale_order_type='销售单' AND status IN ('已支付','已完成') AND paid_amount > 0 AND (payment_method NOT IN ('微信','支付宝') OR COALESCE(wechat_transaction_id, alipay_transaction_id) IS NOT NULL)`
   - 文档遗漏 status 过滤和 payment_method/external_txn_id 守卫；尤其后者是 chk_sop_method_txn 约束守卫，不可省略

6. **'回款' / '退款' 行实际命中 0**
   - 文档 line 191-192：`0004:L64-86 INSERT '回款' 流水 → 指向 ref_sale_order_id` 和 `L88-110 INSERT '退款' 流水`
   - PG 实测：`sale_order_payments` 100% 全部 `change_type='首次支付'`，**回款/退款 实际产出 0 行**（因 PG 现状 sale_order_type 仅 销售单 142805 / 转换单 4 / 内部单 2，无 回款单/退款单/转换单）
   - 文档 line 199 表 4 行已暗示这点（"全部为 '首次支付'"），但主体叙述 + 关键决策摘要没把"回款/退款 INSERT 0 行"写明
   - 修复建议：line 192-194 加一句"实际命中 0 行（PG 当前无回款/退款单）"

7. **history_orders + payments 数学不齐**
   - 文档 line 24-25：`sale_order_payments 75258 行（剩余 14 行非 WorkFine）`，line 51 `R1.5 追溯：现在 75244 行 paid_amount > 0`
   - 但 line 232 又说 `75244 + 14 行非 WorkFine = 75258`
   - 75244 这个数字未交叉验证；migrate-history-orders 写入 79513 sale_orders，全部 paid_amount=total_amount 后 paid_amount > 0 行数应 ≤ 79513。`79513 - 75244 = 4269`，文档 line 51 注脚说"剩余 4269 行 total_amount=0 也被跳过保留为 0"——这是**派生数字未实测**。建议 R2 直接 `SELECT COUNT(*) FROM sale_orders WHERE remark='WorkFine历史订单导入' AND total_amount > 0` 验证

#### C. 数据不一致

8. **行数 snapshot drift**（minor）
   - WF 实测：UDT_S_209=81587、UDT_M_213=118234、UDT_M_217=124676、UDT_M_260=856974、UDT_M_1259=74078
   - 文档静态：UDT_S_209=81568、UDT_M_213=118213、UDT_M_217=124649、UDT_M_260=856791
   - 差额 19~183 行，是 WorkFine 仍在写入产生的自然增长（probe 抓到 2026-04-26 当天新单），不是错误。建议在文档头加 "snapshot 日期：YYYY-MM-DD"

#### D. 过时事实

9. **sale_items.store_id 缺失"后续 migration UPDATE"已不再 unknown**（同 #1）
10. ~~`sale_order_payments` 整表字段来源不明~~ 标 R1.5 已解决，但 R1.5 描述里"2026-03-14 部署"日期错（同 #4）

### 未发现的问题

- 没有 P0（业务永久失效 / 数据资损 / 越权）。sale_items.store_id NOT NULL 已被 0002 migration 安全回填，FK 完整。
- payment_method 全 `'线下'` + 100% '首次支付' 与 PG schema CHECK 约束一致，无 chk_sop_method_txn 违规。
- migrate-allocations 分配比例 dedup 在当前数据下零冲突（PG `(sale_item_id, employee_id, role_type)` 唯一索引未发生过 ON CONFLICT 冲突插入）。

### Verdict

**minor-fix**

文档主体血缘描述（10 张表的列级映射）准确度高，UDF_S_371 5 值丢失、UDF_M_4939 赠送丢失、UDF_M_14494 数量失真、UDT_M_1259 整表丢失、document_type 派生规则等关键 5 项均与实测数据一致。

需要小修 6 处：
- ① 补 0002_parched_marvel_boy.sql 为 sale_items.store_id 的回填来源（结案 _gaps.md 该条）
- ② 把 0003/0004 migrations 的时间戳从"2026-03-14"改为 mtime "2026-04-24"
- ③ 把 0003/0004 标注为 db/migrations/（post-baseline）而非 archive
- ④ 补全 0004 INSERT WHERE 完整条件（status + payment_method 守卫）
- ⑤ 在 sale_order_payments 章节明示"回款/退款 行实际命中 0 行"
- ⑥ 补 dedup key 实际为 (saleItemId, employeeId) 不含 roleType
- ⑦ 加 snapshot 日期说明

---

## Edge Case 报告 R2（2026-04-26）

独立调研流程：① 重读 schema/order.ts + enums.ts；② grep cloudfunctions/staffApi/clientApi/payNotify + admin actions；③ PG 5434 跑 8 类探针 SQL（`db/.tmp-probe-r2-01.js` + `.tmp-probe-r2-01b.js`，已删）。WorkFine 抽样跳过：本轮关注 PG 端边缘事实，与 R1 调研已覆盖的 WF 端字段不重合。

### 8 类维度结论

| # | 维度 | 命中？ | 关键发现 |
|---|------|-------|---------|
| 1 | FK 孤立 / 引用完整性 | 未命中（核心 FK） | sale_orders/items/allocations/payments 的 14 个 declared FK 全 0 孤立行；coupon_id 无 FK 但当前只有 5 行 coupon_id 也都对得上 user_coupons |
| 2 | NULL / 空串 / 极值 | **重命中** | 5 项数据脏：①sale_items.expire_date 5130 行 = 1900-01-01（WF NULL 误转）；②unit_real_price > unit_price 31780 行（unit_price=29.80, urp=48.15）；③allocation_ratio > 1.00 共 73214 行（含 max=999.99 的 2 行，溢出 numeric(5,2) 上限 = 999.99）；④sale_orders.sale_order_datetime min=2005-03-13、max=2039-03-11（远未来 1 行 TKKLS-）；⑤sale_orders.updated_at < created_at 19 行（运行时新单时区错位 8h） |
| 3 | enum 漂移 | 未命中 | pg_enum 'sale_order_type' 已无 legacy `'普通'`；当前所有 enum 实测值都在 schema 定义集合内 |
| 4 | UNIQUE 约束 | 未命中 | 4 个 unique index 全 0 violation：(client_user_id where pending), (phone+store where pending), wechat_txn_id, alipay_txn_id, alloc(item,emp,role) where !void, sop(order,method,txn) |
| 5 | 跨模块一致性 | **重命中** | sale_orders.paid_amount vs Σ(sale_order_payments where 已支付) **15 行 mismatch**（paid_amount > 0 但 sop 0 行），全部是运行时新订单（FY-XSD-WX-260310 ~ 2604160003），打破 schema 注释"双写不变量"；sale_items.store_id vs sale_orders.store_id 0 mismatch（OK） |
| 6 | 死代码 / 永不命中 | **轻命中** | 11 个 enum 值零数据：sale_order_type {回款单, 退款单}（schema/code 都有路径 createRefund / createRepayment 但生产从未触发）；order_status {支付失败, 待审批, 部分支付}；payment_method {储值卡, 支付宝, 无}；item_direction {退出}；sales_category {他销他耗, 生态合作}；payment_change_type {回款, 退款, 储值卡抵扣}；payment_flow_status {待支付, 已作废, 已退款}；payment_source_end {admin, notify}。CHECK chk_sop_amount_sign 中"退款负"分支永远 false（截至 2026-04-26 退款单 0 行） |
| 7 | dump-restore 残留 / drift | **重命中（高危）** | sale_orders 第 13 列是 `........pg.dropped.13........`（`sale_order_source` 旧列 ghost）。2026-04-10 baseline reset 后该列本应消失（baseline.sql:238-272 只有 30 列定义），实测 PG 当前却有 30+1=31 个物理列。**意味着 baseline reset 时 sale_orders 表没被 DROP+CREATE，drizzle 把它视为 nochange 跳过了**，dropped 列继续在 142811 行的 row tuple 占用 4 字节空间（~558KB）。需追查是否 0000_baseline.sql 在生产 5434 上是 idempotent skip 的 |
| 8 | 运行时安全 | 未命中 | order.js 全部 SQL 用 $n 参数化；多步写入有 BEGIN/COMMIT；常用 FK 列都有索引 |

### 高危发现明细

#### 🔴 H1：`sale_orders.paid_amount` 与 `sale_order_payments` 双写不变量已破，15 行运行时数据资损风险

- **schema 注释（order.ts:65-69）** 明确声明：
  > paid_amount 是 sale_order_payments 中 change_type ∈ (首次支付/回款/退款) 且 status='已支付' 行的 amount 之和的冗余快照，由应用层每次 payments 变更后**同事务双写**维护
- **PG 实测**：
  ```
  WITH p AS (SELECT sale_order_id, SUM(amount) s FROM sale_order_payments
             WHERE status='已支付' AND change_type IN ('首次支付','回款','退款','储值卡抵扣') GROUP BY 1)
  SELECT COUNT(*) FROM sale_orders so LEFT JOIN p ON ...
  WHERE so.paid_amount <> COALESCE(p.s, 0)
  -- 结果：15 行
  ```
- **样本（运行时新订单）**：
  | sale_order_id | type | status | paid_amount | sop_sum |
  |---|---|---|---|---|
  | FY-XSD-WX-260310-0001 | 销售单 | 已支付 | 2299.00 | 0 |
  | FY-XSD-WX-260312-0004 | 销售单 | 已支付 | 3500.00 | 0 |
  | FY-XSD-WX-2603220003 | 内部单 | 已支付 | 600.00 | 0 |
  | FY-XSD-WX-2604160002 | 内部单 | 已支付 | 2500.00 | 0 |
  | FY-XSD-WX-2604160003 | 转换单 | 已支付 | 349.40 | 0 |
  | FY-XSD-WX-260313-0005 | 销售单 | 待支付 | 456.00 | 0 |
  | FY-XSD-WX-260313-0006 | 销售单 | 已关闭 | 259.00 | 0 |
  | FY-XSD-WX-2603210001 | 销售单 | 已关闭 | 778.00 | 0 |
- **疑因（按发生频率）**：
  1. 早期开发期（2026-03-10 ~ 2026-04-16）写 sale_orders 时漏插 sale_order_payments；payNotify、staffApi/order.confirmOffline、staffApi/order.createConversion 任一路径有缺写；样本恰好 5 个 已支付/已完成 销售单 + 2 内部单 + 2 转换单 + 6 已关闭/待支付有 paid_amount 残留 = 15 行
  2. 不是 0004 backfill 漏跑：0004 覆盖 sale_order_type IN (销售单/回款单/退款单)，**内部单/转换单 不在 backfill 集合里**（这是新发现的 0004 SQL 隐患——内部单和转换单后续才加入但 backfill 没补）
- **业务影响**：财务对账（payment 流水汇总）将看不到这 15 笔资金动作；如要做"已收/未收"统计，会和 sale_orders.paid_amount 矛盾
- **修复建议**：①补一次 backfill SQL，按 paid_amount 反推 INSERT 缺失 sale_order_payments；②单测加保护：staffApi/order.create/confirmOffline/createConversion 三处单测里强制断言"写完后 SUM(payments.amount) === paid_amount"

#### 🔴 H2：`sale_items.expire_date = 1900-01-01` 共 5130 行，疗程卡 active_expired 2125 行被前端误判为已失效

- **PG 实测**：
  - sale_items.expire_date < '2000-01-01' 共 **5130 行**（min=1900-01-01, max=1900-01-18）
  - 其中 product_type='疗程卡' AND remaining_sessions > 0 AND expire_date < CURRENT_DATE 共 **2125 行**（remaining_sessions 1~17 都有，肝胆净化、四季养生、肩颈头疗等核心项目）
  - 样本：
    ```
    XSLSH-20221012004 | 1899-12-31T15:54:17.000Z | 单品 | 6S
    XSLSH-20221117007 | 1899-12-31T15:54:17.000Z | 疗程卡 | 肩颈疏通
    ```
- **根因**：WorkFine SQL Server `UDT_M_213.UDF_M_7122 = NULL` 经 datetime2 → JS Date → date 转换链时，pg-node 把 `null` 误传成 `'1900-01-01'`（或 SQL Server `0` epoch = 1900-01-01）。migrate-history-orders.js:L196 `expireDate: row.UDF_M_7122` 没有 `if (!val) return null` 守护
- **业务影响**：staffApi/customer/clientApi 任何"剩余有效卡"列表（按 expire_date >= today 过滤）会把这 2125 行真实有剩余次数的卡误判为已过期 → 顾客无法预约 / 员工核销报"已过期"。这是**纯运行时业务永久失效**，已发生
- **修复**：
  - 短期：`UPDATE sale_items SET expire_date = NULL WHERE expire_date < '2000-01-01'`（5130 行批量回填）
  - 长期：migrate-history-orders.js 加 `expireDate: (row.UDF_M_7122 && new Date(row.UDF_M_7122).getFullYear() > 2000) ? row.UDF_M_7122 : null`

#### 🔴 H3：`sale_allocations.allocation_ratio` 73214 行 > 1.00（精度上限 999.99，已达到）

- **PG 实测**：
  - `allocation_ratio > 1.00` **73214 行**（约 47% 的所有 alloc 行）
  - max = `999.99`（精度 numeric(5,2) 上限，2 行触顶）
  - distribution: ratio∈[0,1] 156504 行 / ratio∈(1,100] 73211 行 / ratio>100 3 行
  - 样本：`XSLSH-20230418127, ratio=9.14, total=128.00, sale_amount=14.00`（128/14 = 9.14，比例确实 = 总 /sale）
- **根因（语义不一致）**：
  - **schema 注释（order.ts:206）** 暗示 ratio 是 0.00~1.00 的小数比例
  - **migrate-allocations.js:L174-221** 计算 `min(999.99, round(itemAlloc / item.sale_amount * 100) / 100)` —— 单 item 订单时 ratio=1.00；但**多 item 订单按 sale_amount 比例拆分**时，如果某个 item 拿到的 alloc 金额 > 该 item 自己的 sale_amount，比例就溢出（典型：员工提成是按"订单总额"算的，但分摊到 item 后单 item 的 alloc 可能远超该 item 售价）
  - PG 现状是 **migrate-allocations.js 真实输出**：业务语义其实是 `total_amount / sale_amount`（不是"百分比拆分系数"）
- **业务影响**：admin 仪表盘 / staffApi 提成展示如果按 ratio 当百分比展示，会看到 "999.99%" 之类荒谬数字；2 行已触顶，未来某个员工跨大单分配可能溢出 numeric(5,2) **CHECK 约束错位**（schema 没有 CHECK，只有列精度）
- **修复**：
  1. schema 增加 CHECK 或扩列精度到 numeric(8,4)
  2. 文档明确语义："ratio 是该员工分得金额 / 该 item 销售金额，可以 > 1 表示员工跨多 item 提成时单 item 占比超过 100%"
  3. admin 展示侧不要按 % 展示

#### 🟡 M1：sale_orders 留存 dropped column 鬼影（attnum=13 = `sale_order_source`）

- **PG pg_attribute 实测**：
  ```
  attname='........pg.dropped.13........' attnum=13 attisdropped=true attlen=4
  ```
- **背景**：`sale_order_source` 在 archive `0028_drop_sale_order_source.sql` 已 DROP；2026-04-10 baseline reset 后 `0000_baseline.sql:238-272` 重建定义不含此列
- **悖论**：baseline 是 `CREATE TABLE` 而非 `ALTER`，正常重建后 attnum 序列应连续。dropped 13 槽存在，意味着**5434 上 sale_orders 表跨越了 baseline reset 没被实际重建**（drizzle baseline reset 通过修改 `__drizzle_migrations` 表实现，DDL 不重跑），ALTER DROP 留下的 ghost 列继续占据每行 4 字节
- **影响**：142811 行 × 4 字节 ≈ 558KB 死空间；功能无影响但表元数据"不干净"
- **修复**（如果在意）：`VACUUM FULL sale_orders` 或 `pg_repack` 重建表，或 `CREATE TABLE ... AS SELECT * FROM sale_orders + DROP/RENAME` 手动重建

#### 🟡 M2：`sale_orders.allocation_status='已分配'` 但实际无 alloc 行 75313 行（远超历史导入数量）

- **实测**：allocation_status='已分配' 共 142782 行，其中 75313 行（约 53%）无 alloc 行
- **拆分**：拓客卡 24966、phantom 22784、结存 15517、history 12046（4 个 remark 加起来 = 75313）
- **现象解释**：4 个 migrate 脚本在 sale_orders INSERT 时硬编码 allocation_status='已分配'（migrate-history-orders.js:L256），但:
  - migrate-prepaid-cards / migrate-phantom-items / migrate-jclsh-items 都不写 sale_allocations（拓客卡、phantom、结存项目天然没有业绩分配数据）
  - 这 12046 行 history 也"已分配但无 alloc 行"——说明这部分订单 WF 端 UDT_M_217 也没有对应记录（可能是 sale_amount=0 的赠送行被 migrate-allocations.js 跳过了）
- **业务影响**：staffApi 显示为"已分配"但点开看 0 个分配人，前端如果做"已分配 → 锁定不可改"的守卫，这 75313 行无法补录分配人；如果做"未分配 → 提示分配"则 12046 history 行需要后台干预
- **修复**：
  - 三个非 history 脚本应改为 allocation_status='不适用'（或 NULL）—— 但当前 enum 仅 (待分配/已分配)，需要扩枚举
  - 或者最终迁移阶段对这 75313 行批量 UPDATE 把它们 → '待分配' 让前端逻辑统一

#### 🟡 M3：sale_items 31780 行 `unit_real_price > unit_price`（折扣异常 → 历史定价语义失真）

- **PG 实测**：31780 行 sale_items 满足 unit_price > 0 AND unit_real_price > unit_price，diff 范围 0.04 ~ 39760.11
- **根因（migrate-history-orders.js 字段映射倒置）**：
  - `unit_price` 拿 `UDT_M_213.UDF_M_4949` （schema 注释"原价标准价"）
  - `unit_real_price` / `sale_amount` 都拿 `UDF_M_395`（销售金额）
  - 实际 WF 端 UDF_M_4949 在很多商品里是"市场价"或"VIP 价"，UDF_M_395 在加套餐补差价场景里反而更高
  - 样本：肩颈疏通(单次) 标价 18 元，售价 108 元；全身排毒(MQ单次) 标价 28 元，售价 700 元 — 这种是真实的"加价销售"或"套餐差价"，不是错误
- **业务影响**：admin 仪表盘"折扣率"指标会出现 0% 折扣或负折扣率；前端"原价 ¥X 现价 ¥Y"展示会上下颠倒，让顾客以为"现价比原价贵"显得离谱
- **修复**：UI 层面对 unit_real_price > unit_price 的行做特殊展示（不显示原价线划线），或在 migrate 脚本里 max(unit_price, unit_real_price) 作为 unit_price 的兜底

#### 🟡 M4：sale_items.session_count='疗程卡' 但 `remaining_sessions IS NULL` 共 6 行（item_direction='转出'）

- **PG 实测**：6 行 product_type='疗程卡' AND remaining_sessions IS NULL，全部 item_direction='转出'
- **schema 注释（order.ts:184）** CHECK `remainingSessions IS NULL OR remainingSessions >= 0` 允许 NULL，但 product_type='疗程卡' 不应该 NULL（业务语义"剩余次数"对疗程卡是核心字段）
- **影响**：转出行（refund_out / convert_out）按业务定义应该 remaining_sessions=0（次数已转出归零）；当前 NULL 让 UI 判断"未知 vs 已耗尽"模糊
- **修复**：staffApi/order.createConversion 写 sale_items 时显式设 remaining_sessions=0；批量 UPDATE 修正现有 6 行

### 中低风险观察

- **`sale_allocations.department_name IS NULL` 共 286 行**（涉及 110 个不同 employee_id）— 部门快照丢失，归并到"未知部门"展示
- **`sale_orders.coupon_id` 累计仅 5 行使用**（券核销 5 次）；该列无 FK，如果 user_coupons 行被删，coupon_id 会变成 dangling pointer（运行时低概率但可能）
- **`sale_orders.sale_order_datetime` 极值**：min=2005-03-14（结存项目假数据）、max=2039-03-11（拓客卡 1 行）— 2039 这条 `TKKLS-ORDER-FYGK-202302100015` 是 2026 年录入的拓客卡有效期？需校验
- **`updated_at < created_at` 19 行**（差额恰好 -8h）：staff 端某次写入用了 `NOW() AT TIME ZONE 'UTC'` vs `created_at` 用的本地时区 — 不影响业务但触发 created<updated 不变量。涉及订单：FY-XSD-WX-2603220003、2604160001 ~ 2604160005
- **`sale_order_payments.paid_at < created_at` 14 行**：同样的时区错位（员工填了"前一日下午支付"凭证，paid_at 用前一日时间，created_at 用今日 INSERT 时间，差额 8h 也是时区相关，但语义合理）
- **`sale_orders.payment_method='微信'` 但 `wechat_transaction_id IS NULL`**：2 行（FY-XSD-WX-260310-0001、260312-0004）— 微信支付未拿到三方流水号，与 H1 那 15 行 paid_amount 失配重叠
- **enum `payment_change_type` 有 `储值卡抵扣` 但代码已实现且 0 数据**：staffApi/order.confirmOffline:881 INSERT '储值卡抵扣' 路径仅当 `prepaidAmount > 0` 触发，截至 2026-04-26 没有线下确认订单触发过储值卡抵扣
- **`sale_orders.zero_total = 67538`（47% 总订单 total_amount=0）**：拓客卡 / 结存项目 / phantom 系列 + 4269 history 0 元订单，业务上是"赠送/结存归零卡"，符合预期不算异常

### Verdict

**serious-edge-cases**

R2 主动挖出 4 类高危（H1-H3 + M1）和 4 类中危（M2-M4 + 中低风险中的多项）：

- **H1（双写不变量破，已发生 15 行资损）**：业务侧未来对账会矛盾，建议立即补 backfill SQL + 单测保护
- **H2（5130 expire_date='1900' 致 2125 张卡 UI 误判已过期）**：业务永久失效，顾客无法核销，立即批量回填
- **H3（73214 行 ratio>1，含 2 行触顶 999.99）**：schema 语义文档与代码实际不一致，admin 展示需修正
- **M1（dropped column ghost 表明 baseline reset 未真重建表）**：值得跟进 baseline reset 流程是否真的对所有表 DDL 重跑

文档主体血缘描述（R1.5 已校准）准确度仍然高，本轮发现是文档**未涉及的运行时数据脏 / schema 实际语义偏移**，与 R1 minor-fix 7 处独立。

