# 05 — `service` 模块

**Schema 文件**：`db/schema/service.ts`
**涉及 PG 表**：`service_orders`, `service_items`
**WorkFine 源表**：
- `UDT_S_259` 售后护理单主表（630,819 行；含义：护理服务订单，HLD- 编号）
- `UDT_M_260` 售后护理明细子表（按 RID 关联 UDT_S_259；销售流水号 `XSLSH-` 前缀，关联 UDT_M_213 核销疗程卡）
- `UDT_S_762` 售前护理单主表（109,390 行；含义：拓客卡体验服务，HLD- 编号但与 259 编号段共用）
- `UDT_M_763` 售前护理明细子表（按 RID 关联 UDT_S_762；拓客卡流水 `TKKLS-` 前缀，独立体系不关联销售单）

**主要写入入口**：
- `db/scripts/migrate-service-records.js` — 售后护理（年份过滤 ≥ 2025）→ service_orders/service_items + service_commissions
- `db/scripts/migrate-presale-services.js` — 售前护理（年份过滤 ≥ 2023）→ Phase 1 合成 TKKLS sale_orders + sale_items（仅作 FK 锚点），Phase 2 → service_orders/service_items
- 运行时 `staffApi/routes/service.js create()` — 员工端开服务单，INSERT 进 service_orders/service_items（仅 7 行，绝大多数是开发期 E2E 数据）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0024_service_order_type_rename.sql` — 历史 `普通/体验` 枚举一次性重写为 `售前/售后`（基于 `client_wechat_users.customer_type='会员客'` 推导，**未读取 UDT_S_259.UDF_S_1417 真实标签**）
- `db/migrations/0008_aspiring_pride.sql` / `0011_misty_nebula.sql` — service_items 加 is_shengmei / sales_category 列 + 从 sale_items 回填

> **sync-workfine.js 不处理 service 表**。服务记录全部走一次性 migrate 脚本，不在定期同步范围。

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | 备注 |
|----|-------|------|
| service_orders | 607,847 | HLD- 前缀 607,845（migrate 来源）+ FY- 前缀 2（运行时） |
| service_items | 851,624 | SVCI-HLD- 前缀 851,617（migrate）+ svc-/FY-FW- 前缀 7（运行时/E2E） |

**关键现状指标**：

| 维度 | 值 | 说明 |
|------|-----|------|
| service_order_type='售前' | 607,847 / 607,847 = **100%** | ⚠️ **严重失真**：UDT_S_259 实际 96% 是 `售后`（UDF_S_1417 分布 250303/8621 = 售后/售前），但 PG 全部为 `售前` |
| status='已完成' | 607,845 / 607,847 = 99.999% | 历史导入硬编码；2 行运行时数据为 待服务/服务中 |
| commission_status='待分配' | 607,844 / 607,847 = 99.999% | migrate-service-records 写入时未给 commission_status，依赖 schema enum 默认 NULL；3 行 NULL 是运行时未完成单 |
| remark 非空 | 1 行 | 历史导入未填，仅 1 行运行时数据有值 |
| appointment_id 非空 | 3 行 | 历史无；仅运行时有 |
| started_at 非空 | 2 行 | 历史无；仅运行时填 |
| completed_at 非空 | 607,843 / 607,847 | 历史导入硬编码 = service_date；4 行运行时为空 |
| client_user_id 非空 | 606,506 / 607,847 = 99.78% | 1341 行 customer_id 在 PG 无映射（历史顾客已建档前的服务） |
| service_date 异常年份 | 7 行（2028/2039/2043/2055/2099）| WorkFine 原始数据脏值，脚本未做范围校验 |

> **migrate-service-records.js 行为**：脚本判断 `serviceType: trim(row.service_type) === '售前' ? '售前' : '售后'`（L157），按 UDF_S_1417 应导出 96% `售后`。但 PG 现状全部 `售前` — 推测 `migrate-service-records.js 跑在 0024 重命名 migration 之前`，0024 migration 把当时 `普通/体验` 的所有行重新派生为 `售前/售后`，**派生规则只看顾客 customer_type='会员客'，没有用 UDF_S_1417**，最终所有匹配不上会员客的都坍缩为 `售前`。**最终迁移要从 UDT_S_259.UDF_S_1417 重做**。

> **migrate-presale-services.js 行为**：Phase 1 创建合成 TKKLS sale_orders（remark `'WorkFine拓客卡导入'`）+ TKKLS sale_items 作为 service_items.sale_item_id 的 FK 锚点；Phase 2 INSERT service_orders.service_order_type='售前'（硬编码 L290）。这个脚本路径写出来的 service_orders 才是真"售前"，但同样落 `售前` 枚举值，与上面来自 UDT_S_259 的失真行混在一起 — **`售前` enum 当前同时承载真售前 + 失真售后两批数据**。

---

## 表 1：`service_orders`

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| service_order_id | varchar(30) | WorkFine 直拷 | `RTRIM(UDT_S_259.UDF_S_821)` 或 `RTRIM(UDT_S_762.UDF_S_821)` | migrate-service-records.js:L67, L237; migrate-presale-services.js:L226, L337 | HLD- 前缀，两表编号段共用；运行时由 staffApi `generateServiceOrderId` 生成 FY- 前缀 |
| status | service_order_status enum | 默认值/NULL | 硬编码 `'已完成'`（migrate）；运行时默认 `'待服务'` | migrate-service-records.js:L238; migrate-presale-services.js:L337 | 历史全部已完成；schema default `'待服务'`（service.ts:L19） |
| service_order_type | service_order_type enum | ⚠️ 派生失真 | ① migrate-service-records.js:L157 按 `UDF_S_1417 === '售前' ? '售前' : '售后'`；② migrate-presale-services.js:L290 硬编码 `'售前'`；③ archive `0024_service_order_type_rename.sql:L11-20` 一次性重写：基于 `client_wechat_users.customer_type='会员客'` 推导 `售前/售后`，**未读 WorkFine UDF_S_1417**；④ schema default `'售前'`（service.ts:L20） | migrate scripts + archive 0024 | ⚠️ **PG 现状 100% 全是 `售前`**（607847/607847），与 WorkFine UDF_S_1417 真实分布（96% 售后）严重不一致。最终迁移必须从 UDF_S_1417 直接抽 |
| market_name | varchar(100) | WorkFine 直拷 | `RTRIM(UDT_S_259.UDF_S_818)` / `RTRIM(UDT_S_762.UDF_S_818)`，缺省 `'未知市场'` | migrate-service-records.js:L70, L153; migrate-presale-services.js:L229, L286 | 市场名快照 |
| store_id | text (FK→stores) | WorkFine 派生 | `storeMap[RTRIM(UDT_S_259.UDF_S_820)]`（PG `stores.store_name` lookup）；缺省回退到 `RTRIM(item_store_name)` (UDF_M_14831) | migrate-service-records.js:L117-119; migrate-presale-services.js:L266-268 | 门店名 → store_id 转换；未匹配的护理单跳过（stats.skippedNoStore） |
| service_date | date | WorkFine 直拷 | `toDateStr(UDT_S_259.UDF_S_822)` / `toDateStr(UDT_S_762.UDF_S_822)` | migrate-service-records.js:L68, L152; migrate-presale-services.js:L227, L285 | ⚠️ 脚本未校验范围；PG 有 7 行年份在 2028-2099 区间（脏值） |
| assigned_employee_id | varchar(30) (FK→staff_wechat_users) | WorkFine 派生 | 取该 service_order 第一条明细的 `RTRIM(UDT_M_260.UDF_M_2472)` 或 `RTRIM(UDT_M_763.UDF_M_2472)`；要求该员工已在 PG `staff_wechat_users.employee_id` 存在 | migrate-service-records.js:L122-127, L156; migrate-presale-services.js:L270-271, L289 | "第一条明细的员工"是个简化派生 — 多明细多员工的护理单只记一个；未匹配的护理单跳过（stats.skippedNoEmployee） |
| remark | text | 默认值/NULL | NULL（脚本未填） | — | UDT_S_259/762 没有 remark 字段；运行时由 staffApi.service.create 写入；PG 现状 1/607847 行非空 |
| appointment_id | text (FK→appointments) | 默认值/NULL | NULL | — | 历史无；仅运行时使用（PG 现状 3/607847 行非空） |
| client_user_id | text (FK→client_wechat_users) | WorkFine 派生 | `customerMap[RTRIM(UDT_S_259.UDF_S_1491)]` / `customerMap[RTRIM(UDT_S_762.UDF_S_1491)]`（PG `client_wechat_users.customer_id` lookup） | migrate-service-records.js:L136-137, L155; migrate-presale-services.js:L279-280, L288 | 顾客编号 → user_id；未匹配的允许 NULL（不同于 store/employee 跳过逻辑）；PG 现状 1341/607847 NULL |
| started_at | timestamp | 默认值/NULL | NULL（migrate 脚本不写） | — | 仅运行时 staffApi.service.start 写入（service.js:L268）；PG 现状 2/607847 行非空 |
| completed_at | timestamp | WorkFine 派生 | `toDateStr(UDT_S_259.UDF_S_822)` cast → timestamp（与 service_date 同值） | migrate-service-records.js:L240; migrate-presale-services.js:L339 | ⚠️ **历史 completed_at 实际只是日期，不是真实完成时刻**。WorkFine 没有完成时刻字段，脚本用 service_date 当 completed_at；运行时 staffApi.service.complete 写真实 timestamp（service.js:L454） |
| commission_status | allocation_status enum | 默认值/NULL | NULL（migrate 脚本未填）→ schema 列允许 NULL | migrate-service-records.js + schema:L38 | ⚠️ migrate 脚本写 service_orders 时**没传 commission_status**，所以 PG 现状 99.999% 行 commission_status=`待分配`（schema enum 默认值是 NULL，但实际 PG 现状是 `'待分配'` — 推测 archive 0010 加列后某次 backfill UPDATE 把 NULL 全改成 `待分配`，已无法在 git history 找到）；运行时 staffApi.service.complete 写 `'已分配'` |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L39 | INSERT 时刻，与 service_date 不同 |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L40 | |

### 已被脚本读但未对接到 PG 的 WorkFine 列

UDT_S_259 共 30 列（去掉 11 个 WorkFine 内部 RID/FILL/LOCK/WORKFLOW 列后剩 19 个 UDF），migrate-service-records.js 仅用了 6 个（UDF_S_818/820/822/823/1491/1417 + 子表 UDF_M_4904/2472/...）。下列 WorkFine 列**有业务含义但当前 PG 没存**：

| WorkFine 列 | 类型 | 含义（参考 workfine_database.md） | 现状 |
|-------------|------|----------------------------------|------|
| UDF_S_823 | nvarchar | 顾客姓名 | 脚本读了但**未写入 PG**（仅作 `customer_name` 别名读出）。PG schema 也无 customer_name 列于 service_orders（与 sale_orders 不一致） |
| UDF_S_819 | nvarchar | 顾客类型（售前 / 售后等） | 未对接，与 UDF_S_1417 含义可能重复 |
| UDF_S_1417 | nvarchar | 服务分类（售前/售后真实标签） | ⚠️ **业务关键字段未生效**：脚本读取并参与 serviceType 派生，但被 archive 0024 一次性重写覆盖（参见上文）。最终迁移要直接抽 |
| UDF_S_826 | nvarchar | 服务时长描述（文本，如"1小时30分钟"）| 未对接，与子表 UDF_M_840（数值分钟）含义重复但粒度不同 |
| UDF_S_829 | nvarchar | 是否核算卡数（是/否） | 未对接 |
| UDF_S_830 | nvarchar | 拓客类型 | 未对接 |
| UDF_S_831 | nvarchar | 推广员 | 未对接（与 sale_orders 顾客来源链路相关） |
| UDF_S_2126 | nvarchar | 顾客电话 | 未对接（service_orders 无 client_phone 列；可作为顾客 phone 的补充来源） |
| UDF_S_2127 | nvarchar | 含义不明 | 未对接 |
| UDF_S_2599 | nvarchar | 主表员工编号（与子表 UDT_M_260.UDF_M_2472 关系？）| 脚本未抽，使用子表第一行；UDF_S_2599 可能是"该单负责人"语义 |
| UDF_S_2600 | nvarchar | 含义不明 | 未对接 |
| UDF_S_2601 | nvarchar | 主表员工职位 | 未对接 |
| UDF_S_982 | nvarchar | 含义不明 | 未对接 |
| UDF_S_17143 | decimal | 售后独有字段，用途待确认（参考 workfine_database.md L673）| 未对接 |

UDT_S_762 独有列：
| WorkFine 列 | 类型 | 含义 | 现状 |
|-------------|------|------|------|
| UDF_S_843 | datetime | 预约/到店时间（**售前独有**，UDT_S_259 无）| ⚠️ 未对接，本可以作为 appointment_id 关联或 started_at 来源 |

---

## 表 2：`service_items`

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| service_item_id | text | 新系统派生 | `'SVCI-' + service_order_id + '-' + UDT_M_260.OBYID` 或 `'SVCI-' + service_order_id + '-' + UDT_M_763.OBYID` | migrate-service-records.js:L140; migrate-presale-services.js:L276 | **不来自 WorkFine 子表 ID**：纯派生组合（订单号 + 子序号）。运行时 staffApi 生成 svc- 前缀 UUID（service.js:L193 `generateServiceItemId`） |
| sale_item_id | varchar(30) (FK→sale_items) | WorkFine 直拷 | `RTRIM(UDT_M_260.UDF_M_4904)`（XSLSH- 前缀）或 `RTRIM(UDT_M_763.UDF_M_4904)`（TKKLS- 前缀）| migrate-service-records.js:L82, L172; migrate-presale-services.js:L239, L356 | 销售/拓客卡流水号；FK 强约束要求 sale_items 表已存在该 ID — 即 migrate-service-records 必须在 migrate-history-orders 之后执行；migrate-presale-services Phase 1 显式合成 TKKLS sale_items 解决 FK |
| unit_real_price | numeric(10,2) | WorkFine 直拷 | `max(0, parseFloat(UDT_M_260.UDF_M_6869))` / `max(0, parseFloat(UDT_M_763.UDF_M_6869))` | migrate-service-records.js:L164, L177; migrate-presale-services.js:L297, L310 | 单次价格快照；schema 注释说"sale_items.unit_real_price 快照"，但 migrate 实际从 WF 子表 UDF_M_6869 取，**非从 PG sale_items.unit_real_price 派生**。运行时（service.js:L197-203）才是从 sale_items 拷贝 |
| is_shengmei | boolean | WorkFine 派生（链式回填）| migration `0008_aspiring_pride.sql:L13-17` UPDATE service_items SET is_shengmei = sale_items.is_shengmei WHERE 同 sale_item_id；上游 sale_items.is_shengmei ← product_skus.is_shengmei | 0008_aspiring_pride.sql | ⚠️ PG 现状仅 6/851624 行非 NULL — 因为 sale_items 自身 is_shengmei 全 NULL（见 _gaps.md 01/sale_items），链式回填无效。运行时（service.js:L204）从 sale_items 拷贝 |
| sales_category | sales_category enum | WorkFine 派生（链式回填）| migration `0011_misty_nebula.sql:L5-9` UPDATE service_items SET sales_category = sale_items.sales_category WHERE 同 sale_item_id；上游 sale_items.sales_category 历史硬编码 `'自销自耗'` | 0011_misty_nebula.sql | PG 现状 851621/851624 行非空（≈ 100%），值统一 `'自销自耗'`；3 行 NULL 是运行时数据（schema enum 列允许 NULL） |
| service_order_id | varchar(30) (FK→service_orders) | WorkFine 直拷 | 同主表 `RTRIM(UDT_S_259.UDF_S_821)` / `RTRIM(UDT_S_762.UDF_S_821)` | migrate-service-records.js:L67, L257; migrate-presale-services.js:L226, L356 | 通过 RID 关联主表后取主表订单号 |
| session_used | integer | WorkFine 直拷 | `max(1, parseInt(UDT_M_260.UDF_M_836))` / `max(1, parseInt(UDT_M_763.UDF_M_836))` | migrate-service-records.js:L162; migrate-presale-services.js:L295 | 划卡次数；数值最低保证 1（防 0/NULL） |
| employee_id | varchar(30) (FK→staff_wechat_users) | WorkFine 直拷 | `RTRIM(UDT_M_260.UDF_M_2472)` / `RTRIM(UDT_M_763.UDF_M_2472)` | migrate-service-records.js:L122, L174; migrate-presale-services.js:L270, L307 | 服务员工编号；FK 强约束要求 staff_wechat_users 表存在 |
| service_duration | integer | WorkFine 直拷 | `parseInt(UDT_M_260.UDF_M_840) \|\| null` / `parseInt(UDT_M_763.UDF_M_840) \|\| null` | migrate-service-records.js:L176; migrate-presale-services.js:L309 | 服务费金额（UDF_M_840 在 workfine_database.md L689 标注为"服务费"）— ⚠️ **migration 脚本把 UDF_M_840 解释为 duration_minutes（持续时长分钟数），但 WorkFine 字段定义是"服务费金额"**。需要核对：要么 workfine_database.md 标注错（实际 UDF_M_840=分钟数），要么 migrate 脚本字段映射错。PG 现状 712154/851624 = 83.6% 行有值 |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L74 | |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L75 | |

### 已被脚本读但未对接到 PG 的 WorkFine 列

UDT_M_260 共 32 列（去掉 RID/OBYID 后 30 个 UDF），migrate-service-records.js 仅用了 9 列（UDF_M_835/836/837/839/840/2472/4904/6868/6869）。下列 WorkFine 列**有业务含义但当前 PG 没存**：

| WorkFine 列 | 类型 | 含义 | 现状 |
|-------------|------|------|------|
| UDF_M_835 | nvarchar | 项目名称 | ⚠️ 脚本读了但**未写入 PG**（仅作 `item_name` 别名）；PG schema 在 service_items 也无 product_name 列（与 sale_items 设计不一致）。展示需依赖 sale_items.product_name JOIN |
| UDF_M_837 | money | 本次消耗金额 / 服务费 | 脚本读了用作 `service_fee` 计算 service_commissions.commission_amount，但**未写入 service_items 任何字段**。⚠️ schema 没有 service_fee 列于 service_items（与 sale_items 不一致） |
| UDF_M_839 | nvarchar | 员工姓名（快照）| 脚本读了未写入 PG；service_items 无 employee_name 冗余列 |
| UDF_M_838 | nvarchar | 员工职位 | 未对接 |
| UDF_M_842 | nvarchar | 顾客满意度（满意 / ...）| ⚠️ 未对接，**业务关键字段**：满意度评价直接关系到员工绩效 |
| UDF_M_841 | money | 项目个数 | 未对接（脚本未抽，与 session_used 含义不同）|
| UDF_M_6868 | nvarchar | 品项分类 | 脚本读了未写入 PG（仅作 `category_name` 别名）|
| UDF_M_6902 | nvarchar | 是否赠送（是/否）| ⚠️ **业务关键字段未对接**：仅 2025+ 数据就有 62190/366865 = 17% 行标"是"，**赠送服务记录与正常记录无法区分**；建议最终迁移加 `is_gift boolean` 列 |
| UDF_M_7007 | money | 可用次数（核销时刻剩余）| 未对接（与 sale_items.remaining_sessions 同步信息）|
| UDF_M_7014 | money | 次数变化（**售前独有**）| 未对接 |
| UDF_M_7135 | datetime | 有效日期（疗程卡到期日）| 未对接（与 sale_items.expire_date 重复）|
| UDF_M_7341 | money | 含义不明 | 未对接 |
| UDF_M_2473 | nvarchar | 职位序列编码 | 未对接（与 sale_allocations.UDF_M_2315 同语义）|
| UDF_M_14213 / UDF_M_14214 | — | 含义不明 | 未对接 |
| UDF_M_14831 | nvarchar | 项目门店名（脚本作 store_name fallback）| 已用作 store_id 派生回退，但未独立存 |
| UDF_M_14833 | — | 含义不明 | 未对接 |
| UDF_M_16136 | — | 含义不明 | 未对接 |
| UDF_M_16309 | nvarchar | 疗程项目编号（**售后独有**，关联 UDT_M_1281.UDF_M_14503）| ⚠️ 未对接，**可关联到商品域 SKU 的关键字段**，可补 sku_id |
| UDF_M_17859 | — | 含义不明 | 未对接 |
| UDF_M_19156 / UDF_M_19753-19759 | — | 含义不明（疑似新增审批/扩展字段）| 未对接 |

UDT_M_763 独有列（售前明细）：
| WorkFine 列 | 含义 | 现状 |
|-------------|------|------|
| UDF_M_14211 / UDF_M_14212 | 含义不明（**售前独有**）| 未对接 |
| UDF_M_14832 / UDF_M_14834 | 含义不明（**售前独有**）| 未对接 |
| UDF_M_17860 | 含义不明（**售前独有**）| 未对接 |

---

## 关键决策摘要

1. **service_order_type 数据失真严重**：PG 100% 行 = `'售前'`，WorkFine UDT_S_259 真实 96% = 售后（UDF_S_1417='售后' 250303 行 vs '售前' 8621 行）。失真链路：① migrate-service-records.js 写入时按 UDF_S_1417 派生 → ② archive `0024_service_order_type_rename.sql` 一次性 UPDATE 把 `普通/体验` 重写为 `售前/售后`，**派生规则只用 client_wechat_users.customer_type='会员客'，没读 UDF_S_1417**。最终迁移**必须**直接抽 UDF_S_1417 重做，不要走 customer_type 推导。
2. **migrate-presale-services.js 是先合成后引用**：Phase 1 凭空创建 `TKKLS-ORDER-{customer_id}` 合成 sale_orders + sale_items，再让 service_items.sale_item_id 指向这些 TKKLS- 流水。这意味着 sale_orders/sale_items 表里**有 TKKLS- 前缀的合成行**实际是为 service 模块服务的（remark='WorkFine拓客卡导入'）。最终迁移要保留这个合成模式或重新设计 service_items.sale_item_id FK 关系。
3. **UDF_M_840 字段语义存疑**：脚本作 `service_duration`（持续分钟数），workfine_database.md 标注"服务费金额"。**需要在最终迁移前抽样校验真实值范围**（如果中位值在 30-180，则脚本对；如果是金额则需重映射到 service_fee 列）。
4. **history completed_at 不真实**：migrate 脚本把 service_date（仅日期粒度）cast 成 timestamp 当 completed_at，**所有历史行 completed_at 都是当天 00:00:00**。WorkFine 没有完成时刻字段，最终迁移如需真完成时刻，**必须放弃**（数据不存在）。
5. **commission_status='待分配' 来源不明**：migrate 脚本未传 commission_status，schema 列允许 NULL，但 PG 现状 99.999% 行 = `待分配`。git history 没找到对应 backfill SQL。推测 archive 0010 加列后某次手工/未提交的 UPDATE 全量回填。最终迁移要补一个**显式默认值** `'待分配'` 写入。
6. **8 个 service_items 列继承 sale_items 快照（archive 0008/0011）但 sale_items 上游本身就 NULL/失真**：is_shengmei (6/851624 非空)、sales_category（统一 `'自销自耗'`）。链式回填没有放大数据价值，反而把 sale_items 的失真传染到 service_items。
7. **schema 与 runtime 漂移**：staffApi/routes/service.js:L208-211 INSERT service_items 时显式列出 `sku_id`，但 schema/PG 都无该列。运行时 INSERT 应该会报 `column "sku_id" does not exist`。PG 现状仅 7 行非 HLD 数据（5 行 FY-FW + 2 行 svc-）— 与运行时入口数量级不匹配，暗示 service.create 路径在生产可能正常返回但实际 INSERT 失败被吞或运行时的 sku_id 列在 ali-demo 库存在而生产没有。**这是 runtime bug 而非迁移血缘问题，不在本文档范围**，但记入 _gaps.md 提醒后续核实。
8. **HLD- 编号段两表共用**：UDT_S_259 与 UDT_S_762 共用 HLD-{YYMMDD}{序号} 编号段（参考 workfine_database.md L663），**两批 migrate 脚本同时写 service_orders 时存在 service_order_id 主键冲突风险**。migrate-presale-services.js Phase 2 用 `ON CONFLICT (service_order_id) DO NOTHING` 防御 — 这意味着**如果售前售后同号，售前数据会被静默丢弃**。最终迁移要明确两表共用 HLD 编号段的语义并设计去重规则。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- ⚠️ `service_orders.service_order_type` **100% 数据失真**：全部 `售前`，与 WorkFine UDF_S_1417 96% 售后真实分布完全不一致；最终迁移必须直接抽 UDF_S_1417 重做，**不要复用 archive 0024 派生规则**
- `service_orders.completed_at` 历史 = service_date cast，仅日期粒度，**真实完成时刻 WorkFine 无源**
- `service_orders.commission_status` 99.999% 行 = `待分配`，但脚本未写入也未在已知 migration 回填，**来源 SQL 未找到**
- `service_orders.remark` 历史 NULL（UDT_S_259 无对应字段）
- `service_orders.appointment_id` / `started_at` 历史无（migrate 脚本不写）
- `service_orders.client_user_id` 1341 行 NULL（顾客在 PG 无 customer_id 映射）
- 7 行 service_date 在 2028-2099 区间（脏值未清洗）
- `service_items.is_shengmei` 6/851624 行非空 — 链式回填上游 sale_items 自己几乎全 NULL，回填无效
- `service_items.service_duration` 字段映射存疑：脚本读 UDT_M_260.UDF_M_840 当分钟数，但 workfine_database.md 标注其为"服务费金额"
- `service_items` schema 缺 `product_name / employee_name / service_fee / is_gift / satisfaction` 列：脚本读取了 UDF_M_835(项目名) / UDF_M_839(员工名) / UDF_M_837(本次消耗) / UDF_M_6902(赠送) / UDF_M_842(满意度)，但全部丢弃；尤其 UDF_M_6902='是' 占 17%（2025+ 抽样），**赠送服务无法识别**
- `service_items.UDF_M_16309` 疗程项目编号未抽 — 这是关联商品 SKU 的关键字段（参考 UDT_M_1281.UDF_M_14503），可作未来 sku_id 回填依据
- `UDT_S_762.UDF_S_843` 预约/到店时间（售前独有 datetime）未对接 — 可作 appointment 关联或 started_at 真实来源
- HLD- 编号段 UDT_S_259 / UDT_S_762 共用，migrate-presale-services 用 `ON CONFLICT DO NOTHING` 防冲突 — 售前数据可能被静默丢弃
- `UDT_S_259.UDF_S_823` 顾客姓名 / `UDT_S_259.UDF_S_2126` 顾客电话 等快照字段未对接（与 sale_orders.customer_name/client_phone 设计对齐角度看，service_orders 缺）
- `UDT_S_259.UDF_S_829` 是否核算卡数 / `UDF_S_830` 拓客类型 / `UDF_S_831` 推广员等业务标签未对接
- ⚠️ **runtime bug**：staffApi service.js:L208-211 INSERT service_items 显式列 sku_id 但 schema/PG 无 sku_id 列；PG 现状非 HLD 行仅 7 行；需核实运行时是否实际报错（与本模块迁移血缘无关，但有运维影响）

---

## Review 报告（2026-04-26）

独立调研步骤：① 读 schema/service.ts 字段；② grep cloudfunctions + db/migrations + db/scripts 找写入入口；③ MSSQL 抽样 UDT_S_259/UDT_M_260/UDT_S_762/UDT_M_763；④ 5434 抽样 service_orders/service_items 行数与列分布；⑤ 对照实际表结构（`\d service_items` / `\d service_orders`）形成"应有形状"。

### 一致性结论
- **一致项**：≈ 19 项（schema 列结构 / PG 行数 / 列分布百分比 / migrate 脚本入口 / archive migration 派生链路 / 7 类未覆盖 WorkFine 列分组 / 关键决策摘要 7 项 / `_gaps.md` 同步条目，全部交叉核对通过）
- **不一致项**：2 项（轻微叙述偏差，详见下方）

### 偏差明细

#### 缺漏（轻微）
1. **admin Server Action 写入入口未列**：fengyu-admin/src/actions/services.ts 包含 `startServiceOrder` / `completeServiceOrder` / `cancelServiceOrder` / `createServiceOrder` 4 条 UPDATE/INSERT 入口（含 CTE 形式的 `WITH status_check ... UPDATE service_orders + UPDATE sale_items` 原子推进 + 扣次），文档"主要写入入口"段只列了 staffApi.service.create，没列 admin 端的 4 个写入入口。这是文档完整性缺漏，不影响数据血缘结论本身。
2. **HLD- 共用编号段示例**：文档 §关键决策 8 提到"两批 migrate 同时写存在主键冲突风险"，但未实际抽样验证 5434 是否存在重复 HLD 号。补充事实：服务单写入域只有 2 条非 HLD 行（`FY-FW-2604230001` / `FY-FW-2603210001`），说明运行时入口尚未在生产产生主键冲突；但 service_items 中仍存在 `svc-item-001/002` 关联的 `HLD-WX-26031x0001` 类伪运行时 service_order_id 共 2 条（疑似 E2E 数据），与文档 §"server_orders FY- 前缀 2 + service_items 7 行"叙述一致，但 service_items 行的"运行时/E2E"分类不够清晰，建议补一句"svc-item-* 行 service_order_id 用了 HLD-WX-* 测试值"。

#### 错配
- 无。

#### 数据不一致
- 无。文档所有量化指标均能在 5434 复现：
  - service_orders 行数 = 607,847（含 `service_order_type='售前'` 100%、`commission_status='待分配'` 607,844 + NULL 3）
  - service_items 行数 = 851,624（is_shengmei 非空 6 行 / sales_category 非空 851,621 行 / service_duration 非空 712,154 行 / SVCI-HLD- 851,617 + FY-FW- 5 + svc- 2 = 851,624）
  - service_date 异常年份 7 行（`>= '2027-01-01'`），与文档一致

#### 过时事实
- 无。文档时间戳 2026-04-26 与本次复核同日，所有数值反映最新 5434 状态。

### Verdict

**accept**

文档质量极高，主体血缘 / 派生失真 / 链式回填 / 7 项未覆盖 WorkFine 列、commission_status 来源未明等关键发现均已正确识别且与 PG 现状量化一致。仅"主要写入入口"段缺 admin 4 条 Server Action 入口和 svc-item-* 测试行的细分备注，属于轻微完整性补充，**不构成 minor-fix 级别的修订**（信息已可在 §关键决策 7 + _gaps.md 中追溯）。

### 关键确认
- **P0 确认**：staff service.js:L208-211 INSERT 列含 `sku_id` 但 5434 service_items 表确认**无 sku_id 列**。git history 显示此改动来自 2026-04-25 commit `d37b596`/`7f8367b`，在生产最近一次成功写入（FY-FW-2604230001 @ 2026-04-23）之**后**。即只要本次 staffApi 部署上线，员工端 service.create 调用必然 PostgreSQL `column "sku_id" does not exist` 报错，**导致店内服务单无法新建（业务永久失效级别）**，已在 _gaps.md 标 ⚠️ P0。

---

## Edge Case 报告 R2（2026-04-26）

主动挖文档外问题，8 类风险维度逐项探查 5434/fengyu + MSSQL `wkdb_20220804_86cd3292`。verdict: **serious-edge-cases**。

### 1. FK 孤立 / 引用完整性

| 探针 | 结果 |
|------|------|
| service_items.sale_item_id → sale_items 孤立 | **0** ✅ |
| service_items.service_order_id → service_orders 孤立 | **0** ✅ |
| service_orders.assigned_employee_id → staff_wechat_users 孤立 | **0** ✅ |
| service_items.employee_id → staff_wechat_users 孤立 | **0** ✅ |
| service_orders.store_id → stores 孤立 | **0** ✅ |
| service_orders.appointment_id → appointments dangling | **0** ✅ |
| service_orders.client_user_id NULL / dangling | 1341 NULL / 0 dangling — 与 R1 一致 |

FK 层全绿，所有引用真有匹配，结论**clean**。

### 2. NULL / 空串 / 极值

| 探针 | 结果 | 说明 |
|------|------|------|
| service_orders.market_name 空串/null | 0/0 | NotNull 守住 ✅ |
| service_date 极值 | min=**2023-01-09** / max=**2099-06-12**；7 行 > 2027（已 R1 列）|  ⚠️ 与 R1 一致 |
| service_items.unit_real_price 负数 | 0 | NotNull 不需 schema check ✅ |
| service_items.unit_real_price 极值 | min=0 / max=**117555.96** / over_100k=1 / **zero=198372 (23%)**| ⚠️ **23% 行 unit_real_price=0**：上游 sale_items 自身 460,669 行 = 0 拷贝过来 + 198,372 行 service_items 显式 0；快照模式失效 |
| **service_items.session_used 异常极值** | min=1 / max=**999,999** / over_100=**180** | ⚠️ **新发现**：脚本 `Math.max(1, parseInt(UDF_M_836) \|\| 1)` 没有上界守护，180 行单次划卡数超过 100，最大达 999,999（明显是脏值或 WF 端把"无限制疗程"写成 999999）。会污染 `sum(session_used)` 类提成统计 |
| **service_items.service_duration 极值** | min=1 / max=**2,500** / over_1000=2 / **under_5=2,000** / median=13 / avg=14.95 | ⚠️ MSSQL 端 UDF_M_840 0 值 128,487 行被脚本 `\|\| null` 过滤掉，但有 2,000 行 1-4 分钟（数据噪声） |

### 3. enum 漂移

| enum | schema 声明 | 实际取值 | 漂移 |
|------|-------------|---------|------|
| service_orders.status | 待服务/服务中/已完成/已取消 | 已完成 / 待服务 / 服务中（无已取消） | **clean**，已取消零行（运行时未触发过 cancel）|
| service_orders.service_order_type | 售前/售后 | 售前 100% | **R1 已识别失真，本轮验证**：5434 仍是 100% 售前；MSSQL 端 `UDF_S_1417` 真实分布 `售后 250,469 / 售前 8,624 (96.7%/3.3%)` —— 派生失真**不可由 archive 0024 修复**，必须最终迁移直接抽 |
| service_orders.commission_status | 待分配/已分配/不适用 | 待分配 99.999% / NULL 3 行 | **clean**，但 1 行 `status='已完成' AND commission_status IS NULL` 存在不变量破缺（见 §5）|
| service_items.sales_category | 自销自耗/他销自耗/他销他耗/生态合作 | 自销自耗 100% | **3 个 enum 取值零行**（dead code，archive 0011 链式回填上游全 `自销自耗`）|

### 4. unique 守住

- `service_orders.service_order_id` HAVING COUNT(*) > 1 = **0** ✅
- `service_items.service_item_id` HAVING COUNT(*) > 1 = **0** ✅
- MSSQL 抽样 `UDT_S_259 ∩ UDT_S_762` HLD 编号交集 = **5 行**（远小于 R1 担心的"大量重叠"）—— migrate-presale-services Phase 2 `ON CONFLICT DO NOTHING` 实际只静默丢弃 ≤5 行售前数据，影响**可忽略**

### 5. 跨模块一致性（高危发现密集区）

| 探针 | 结果 | 风险等级 |
|------|------|----------|
| **service_items.employee_id ≠ service_orders.assigned_employee_id 的服务单** | **79,058 单（13%）** | ⚠️ **P1 业务影响**：admin/staff 任何"该护理单服务员工=assigned_employee_id"的展示都会丢失同单内其他员工；提成路径只看 service_items.employee_id 本身没问题，但 staff.todoList / 顾客详情等按 assigned_employee_id 检索会少数据 |
| **service_items 累计扣次 > sale_items.session_count** | **38,562 行 sale_item 超消** | ⚠️ **P0 业务永久不变量破缺**：抽样 `JCLSH-20230202018 used=24/session_count=15` `JCLSH-20230202030 used=25/12`。sale_items 写入时 session_count 来自 UDF_M_4938 / 14495，service_items 写入时 session_used 来自 UDF_M_836，**两者在 WF 端不强一致**。会污染顾客"剩余次数"展示 + 服务单创建的次数预校验 |
| **service_orders.service_date > sale_items.expire_date 的"过期后服务"** | **6,745 行**（其中 6,637 行 expire_date 是 2000-01-01 到 CURRENT_DATE 间的"真实"过期日，仅 106 行落入 1900-01-01 脏值）| ⚠️ **P1 业务规则破坏**：6,637 单服务发生在卡到期之后，可能是 WF 历史导入时 expire_date 错或员工延期服务未走系统延期 — **schema 无 CHECK 约束防御** |
| **service_items.unit_real_price ≠ sale_items.unit_real_price** | **659,968 行（77%）** | ⚠️ **P1 schema 注释失实**：service.ts:L60 注释"sale_items.unit_real_price 快照"，实测 service_items 端 sa=0 而 si=7.5/20/36.92 等正数。说明 migrate 脚本从 WF UDF_M_6869 直接抽取，与 PG sale_items 端 unit_real_price（来自 UDF_M_395）来源不同。两条来源在 WF 端就不一致 |
| **status='已完成' AND commission_status IS NULL** | **1 行** | ⚠️ **P3 不变量破缺**：99.999% `status='已完成' → commission_status='待分配'`，但 1 行例外。无法在 git history 找到来源 SQL |
| **status='待服务' AND started_at IS NOT NULL** 等时间戳违反 | done_no_completed=2 / doing_no_started=1 / cancelled_with_ts=0 | ⚠️ **P3 状态机软约束**：3 行违反"完成必有 completed_at / 服务中必有 started_at"语义，schema 无 CHECK 约束 |
| **零明细 service_orders** | **2 单** | ⚠️ **P3**：HLD- 单存在但子表 UDT_M_260 关联行被脚本过滤掉，留下空壳订单 |

### 6. 死代码 / 永不命中

| 项 | 实测 |
|-----|------|
| `sales_category` enum 4 值，service_items 实际命中 1 值（`自销自耗`） | **3/4 enum 永不命中** |
| `service_orders.status='已取消'` 实际 0 行 | 1/4 enum 永不命中（运行时 staffApi.service.cancel 路径生产从未触发）|
| **MSSQL UDT_M_260.UDF_M_840 字段含义争议结案** | avg=12.77, median=13, in_minute_range[1-300]=99.997%（728,514/857,025）, max=2,500, top5 取值 = 15(13.8万)/0(12.8万)/12(9.2万)/13.5(6.8万)/10(6.6万) —— **确证为分钟数**，workfine_database.md L689 标"服务费金额"是错的（脚本对、文档错）。已在 _gaps.md 14/service_commissions 段记录 |

### 7. dump-restore 残留 / drift

| 表 | dropped 列 |
|-----|-----------|
| service_items | **attnum=10 是 `........pg.dropped.10........` 残留**（疑似旧 sku_id 或 service_fee 列被 archive DROP，baseline reset 未真重建表）|
| service_orders | 无 dropped 残留 ✅ |

与 01-order R2 发现的 `sale_orders attnum=13 dropped` 同一类问题——baseline reset 时 14 张表中部分被 drizzle nochange skip，未真 DROP/CREATE。

### 8. 运行时安全

- 全部 SQL 用参数化查询（$1, $2 占位）✅
- staffApi.service.create / complete 走 `pg.transaction()` 包裹 ✅
- staffApi.service.complete 用 `WHERE remaining_sessions >= $1 AND remaining_sessions IS NOT NULL` 原子扣减 ✅
- admin.completeServiceOrder 用 CTE `WITH status_check ... deduct AS ...` 原子推进 ✅
- ⚠️ **service_orders 索引覆盖不足**：仅 3 索引（store_id+service_date / assigned_employee_id / client_user_id），缺 `(commission_status, completed_at)` 复合索引——admin 任何"待分配服务单"列表全表扫 60 万行
- ⚠️ **service_items 索引覆盖不足**：仅 1 索引（service_order_id），按 employee_id 维度统计提成时全表扫 85 万行

### Edge 高危排序

| # | 风险 | 等级 |
|---|------|------|
| 1 | **38,562 sale_items 超消**（service_items 累计扣次 > 原 session_count）| **P0** |
| 2 | **service_order_type 100% 失真 = 售前**（R1 已识别，R2 量化 MSSQL 端 96.7% 售后真值）| **P0** |
| 3 | staffApi service.js sku_id 列错配（R1 P0 确认，已记 _gaps.md）| **P0** |
| 4 | **79,058 单（13%）service_items.employee_id ≠ assigned_employee_id**：assigned_employee_id "第一明细员工"派生丢失团队成员 | **P1** |
| 5 | **6,745 行"过期后服务"**（schema 无 CHECK 防御）| **P1** |
| 6 | **service_items.unit_real_price ≠ sale_items.unit_real_price 77%**（schema 注释失实，"快照"语义不真）| **P1** |
| 7 | **session_used max=999,999**（180 行 > 100，无上界守护，污染统计）| **P2** |
| 8 | service_items dropped column ghost（attnum=10）| **P3** |
| 9 | 1 行 commission_status NULL + 3 行时间戳状态机软约束破坏 + 2 行零明细 service_orders | **P3** |

### 8 类维度命中数

| 维度 | 命中数 |
|------|--------|
| 1. FK 孤立 | 0（全绿）|
| 2. NULL/空串/极值 | **3**（urp=0 / session_used 999999 / duration 1-4 分钟）|
| 3. enum 漂移 | **2**（service_order_type 100% 失真 + sales_category 3/4 dead code）|
| 4. unique 守住 | 0 |
| 5. 跨模块一致性 | **5**（超消/过期后服务/urp 不一致/assigned_emp 丢失/状态机软约束）|
| 6. 死代码 | **2**（sales_category 3 dead enum / 已取消 dead enum / UDF_M_840 文档错结案）|
| 7. dump-restore 残留 | **1**（service_items attnum=10 dropped 残留）|
| 8. 运行时安全 | **2**（commission 列缺索引 / employee 维度缺索引）|

**总命中 15 项**（FK + unique 完全干净，2/3/5/6/7/8 全部命中）

### Verdict

**serious-edge-cases**

最严重 3 个 P0：
1. 已知 `service_order_type` 100% 失真（R1 已列）
2. 38,562 sale_items 超消（本轮新发现，业务永久不变量破缺）
3. 已知 staffApi sku_id 错配（R1 已列）

新增 3 个 P1（assigned_emp 丢失 13% / 6,745 过期后服务 / urp 快照不真）。dropped column ghost 与 01-order 同源。

---

## 字段扩展建议 R2（2026-04-26）

基于 `已被脚本读但未对接到 PG 的 WorkFine 列` + MSSQL 抽样 + workfine_database.md 含义。MSSQL `wkdb_20220804_86cd3292` 存量：UDT_S_259 主表 630,819 行（2025+ 259,093）/ UDT_M_260 子表 857,025 行（OBYID >= 1 共 301,274 行有 SKU 关联）/ UDT_S_762 售前主表 109,429 行 / UDT_M_763 子表（与 S_762 关联）。

### P0 候选（业务依赖，缺它影响功能）

| # | WorkFine 源 | PG 应新增列 | 业务理由 | 抽取/转换 | 数据量 | 依赖 |
|---|-------------|------------|---------|-----------|--------|------|
| **1** | `UDT_S_259.UDF_S_1417 + UDT_S_762`（硬编码"售前"）| **`service_orders.service_order_type` 重写**（已存在，但需重做派生）| **业务永久失效级别**：当前 PG 100% `售前`，真实 96.7% `售后`；任何按服务类型筛选/统计的 admin 报表完全错乱 | `RTRIM(UDT_S_259.UDF_S_1417)` 直拷；UDT_S_762 全部硬编码 `'售前'`；不要走 archive 0024 派生 | 607,847 行 全量回填 | **必须先废弃 archive 0024 派生规则**；仅靠重新跑 migrate-service-records 不够，需配套一次性 UPDATE SQL 修正存量 |
| **2** | `UDT_M_260.UDF_M_6902 + UDT_M_763.UDF_M_6902` 是否赠送（`是`/`否`）| **`service_items.is_gift boolean`** | 17% 行（143,797/857,025）标"是"，**当前赠送服务与正常服务无法区分** → 提成计算可能赠送行也算业绩 / 顾客绑定/分类规则受污染 / 财务对账数据不实 | `UDF_M_6902 = '是'` → true，否则 false（含 31 行空值视为 false）| 851,624 行 全量回填 | 无；schema 加列 + migrate 脚本补抽即可 |
| **3** | `UDT_M_260.UDF_M_16309` 疗程项目编号（关联 UDT_M_1281.UDF_M_14503）| **`service_items.sku_id text`**（新增列，与 sale_items.sku_id 设计一致）| 当前 service_items 无法直接关联商品 SKU，所有"按品类统计服务次数 / 销售业绩拆分"必须 JOIN sale_items 二跳；100%（301,274/301,274）行有值 | 通过 UDF_M_16309 → UDT_M_1281.UDF_M_14503 → product_skus 反查 sku_id | 851,624 行 全量回填 | 1) schema 加 sku_id 列 + FK；2) staffApi service.js 当前已写 sku_id 但表无列 — 加列后顺便解决 R1 P0 错配；3) admin createServiceOrder 也已 INSERT sku_id（518-528）|

### P1 候选（信息流失，未来需要）

| # | WorkFine 源 | PG 应新增列 | 业务理由 | 抽取/转换 | 数据量 | 依赖 |
|---|-------------|------------|---------|-----------|--------|------|
| **4** | `UDT_M_260.UDF_M_842 / UDT_M_763.UDF_M_842` 顾客满意度（满意/一般/不满意/未评价）| **`service_items.satisfaction text`** 或 satisfaction_enum | 99.5% 行有值（852,879 满意 / 137 一般 / 25 不满意 / 16 未评价）—— **关系到员工绩效评估、顾客投诉追溯**；schema 漏掉等于把 WF 端的服务质量评价完全丢弃 | 直拷字符串或 enum：`满意/一般/不满意/未评价`（去除空串）| 851,624 行回填 | 无（也可加 enum 但 4 个值，text 更灵活）|
| **5** | `UDT_M_260.UDF_M_837 / UDT_M_763.UDF_M_837` 本次消耗金额 | **`service_items.service_fee numeric(10,2)`** | 当前脚本读了用于 `service_commissions.commission_amount` 计算但**未写 service_items 任何字段**；查询服务收入/客单价时必须通过 service_commissions 反向 JOIN（service_commissions 还有 100% 行覆盖率不保证）；max=22,864,061（明显单笔脏值，但中位数应为合理金额）| 直拷 `parseFloat(UDF_M_837)`；建议加 CHECK ≥ 0 | 851,624 行回填 | schema 加列 |
| **6** | `UDT_S_762.UDF_S_843` 售前预约/到店时间（datetime2）| **`service_orders.legacy_appt_time timestamp`**（仅售前 109,429 行有值）| **100% 覆盖**（109,429/109,429）；65% 与 service_date 同日 / 35% 不同日 — **承载历史预约语义**；最终迁移如不抽则售前 109K 行的"预约 → 服务"链路完全丢失 | 直拷 datetime2 → timestamp | 109,429 行回填 | 无 |
| **7** | `UDT_S_259.UDF_S_2599` 主表员工编号 / `UDF_S_2601` 主表员工职位 | **`service_orders.responsible_employee_id varchar(30)`** + 可选 `responsible_employee_position` | 当前 assigned_employee_id 是"第一明细员工"派生（13% 单位团队成员丢失，见 Edge §5）；UDF_S_2599 是 WF 端"该单负责人"主语义。259,093 行 2025+ 数据有值（部分空字符串需过滤）| `RTRIM(UDF_S_2599)` IS NOT NULL AND != '' → responsible_employee_id；保留 assigned_employee_id 作为执行员工（来自子表）| ~600,000 行回填 | schema 加列 + FK staff_wechat_users.employee_id |
| **8** | `UDT_S_259.UDF_S_829` 是否核算卡数 / `UDF_S_830` 拓客类型 / `UDF_S_831` 推广员 | **`service_orders.legacy_card_calc text` + `legacy_promo_type text` + `legacy_promoter_employee_id text`** | 100% 覆盖；**拓客业务关键标签**（与 sale_orders 顾客来源链路相关）；当前 PG 完全无承载 → 拓客分析路径丢失全部历史维度 | 直拷 string；UDF_S_831 是员工编号可加 FK | ~600,000 行回填 | schema 加 3 列；推广员可选 FK |
| **9** | `UDT_M_260.UDF_M_6868 / UDT_M_763.UDF_M_6868` 品项分类（49 distinct）| **`service_items.category_name text`**（冗余快照，类似 sale_items.product_name）| 当前 service_items 无 category_name；统计需 JOIN sku → category 二跳；49 distinct 数据可直接快照避免链式失真 | 直拷 `RTRIM(UDF_M_6868)` | 851,624 行回填 | schema 加列 |
| **10** | `UDT_S_259.LASTMODDATE` 最后修改时间 / `UDT_S_259.FILLDATE` 创建时间 | **`service_orders.legacy_filled_at timestamp` + `legacy_modified_at timestamp`** | 当前 created_at = `defaultNow()` (即 migrate 时刻 2026-03/04)，updated_at 同；PG 端**完全丢失 WF 端真实创建/修改时刻**。最终迁移如要追溯审计需要这两列 | 直拷 datetime2 → timestamp | 607,845 行回填 | schema 加 2 列；不影响现有 created_at/updated_at（保持系统级语义）|

### P2 候选（nice-to-have）

| # | WorkFine 源 | PG 应新增列 | 业务理由 | 数据量 | 依赖 |
|---|-------------|------------|---------|--------|------|
| **11** | `UDT_M_260.UDF_M_835 / UDT_M_763.UDF_M_835` 项目名称 | **`service_items.product_name text`**（冗余快照）| 100% 覆盖；展示需 JOIN sale_items.product_name 二跳；与 sale_items 设计一致后冗余但提升查询效率 | 851,624 行回填 | schema 加列 |
| **12** | `UDT_M_260.UDF_M_839 / UDT_M_763.UDF_M_839` 员工姓名快照 | **`service_items.employee_name text`** | 与 sale_allocations.employee_name 同设计模式；员工改名后历史记录仍能溯回 | 851,624 行回填 | schema 加列 |
| **13** | `UDT_S_259.UDF_S_823` 顾客姓名 / `UDF_S_2126` 顾客电话 | **`service_orders.client_name text` + `client_phone text`**（冗余快照）| 与 sale_orders.customer_name / client_phone 设计一致；client_user_id 1341 行 NULL 时 client_name 是唯一身份依据 | 607,845 行回填 | schema 加 2 列 |
| **14** | `UDT_S_259.UDF_S_826` 服务时长描述（"1小时30分钟"）| **`service_orders.duration_text text`** | 已有 service_items.service_duration（数值），duration_text 是用户友好版本 | 600,000+ 行回填 | schema 加列；与 service_duration 不互斥 |
| **15** | `UDT_S_259.UDF_S_819` 顾客类型 | **`service_orders.legacy_customer_type text`** | 与 UDF_S_1417 含义可能重复但 WF 端独立维护；保留以防数据交叉验证需要 | 600,000+ 行回填 | schema 加列 |
| **16** | `UDT_M_260.UDF_M_7135` 有效日期（疗程卡到期日）| 不新增列（与 sale_items.expire_date 重复）| 100% 覆盖但与 sale_items 已存字段重复；可作"过期后服务"6,745 行的 cross-validate 来源 | — | 不需要 |
| **17** | `UDT_M_260.UDF_M_841` 项目个数 / `UDF_M_2473` 职位序列编码 / `UDF_M_838` 员工职位 | 视情决定；优先级低 | 与现有字段重复或语义不明 | — | 不需要 |

### 字段扩展数汇总

| 优先级 | 候选字段数 | 影响表 |
|--------|-----------|--------|
| **P0** | 3 | service_orders × 1（重写 type）、service_items × 2（is_gift / sku_id）|
| **P1** | 7 | service_orders × 4（legacy_appt_time / responsible_employee_id / 3 个 legacy_*）+ service_items × 3（satisfaction / service_fee / category_name）+ service_orders × 2（legacy_filled_at / legacy_modified_at）|
| **P2** | 5+ | service_items × 2（product_name / employee_name）+ service_orders × 3（client_name / client_phone / duration_text / legacy_customer_type）|

**P0 = 3 个**（service_order_type 重写、is_gift、sku_id），**P1 = 7 个**，**P2 ≥ 5 个**。建议最终迁移最少补 P0 + P1（10 列，含 service_items 5 列 + service_orders 5 列），保留 WorkFine 历史业务维度的 70%+ 信息密度。

