# 03 — `user` 模块

**Schema 文件**：`db/schema/user.ts`
**涉及 PG 表**：`client_wechat_users`（v3.1 合并自原 customers）、`staff_wechat_users`（v3.2-3.3 合并自原 employees）
**WorkFine 源表**：
- `UDT_S_287` 员工档案主表（3375 valid 行）
- `UDT_S_311` 顾客档案主表（59236 valid 行）

**主要写入入口**：
- `db/scripts/sync-workfine.js:L207-401` — `syncEmployees`（员工同步，UPSERT by employee_id）
- `db/scripts/sync-workfine.js:L482-722` — `syncCustomers`（顾客同步，三段式：UPSERT by phone / UPDATE by customer_id / INSERT new）
- `db/scripts/migrate-missing-customers.js` — 补录订单引用但同步表缺失的顾客（Group A 从订单合成 / Group B 顾客表存在但 phone 冲突）
- `db/scripts/recalc-all-customer-types.js` — 一次性回填存量顾客的 customer_type / member_level / became_member_at（基于 sale_orders 重算）
- `db/scripts/backfill-became-member-at.js` — 历史会员客 became_member_at 兜底（`COALESCE(member_level_upgraded_at, updated_at, created_at)`）
- `db/scripts/calc-monthly-activity.js` / `update-customer-status.js` — 月度客活 + 到店状态 cron 回写
- `db/migrations/_archive_pre_baseline_2026_04/sql/0004_windy_thor_girl.sql` — Phase B/C 把 employees → staff_wechat_users 合并的回填 SQL（baseline reset 前已执行）
- `db/migrations/0006/0007/0008/0012` — 增量加列 + 兜底 UPDATE（详见各表"出处"列）

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 表 | 总行数 | with_openid | with_customer_id | with_phone | 来源 |
|----|-------|-------------|------------------|-----------|------|
| client_wechat_users | 58803 | 12 | 58795 | 24561 | 全部由 syncCustomers + migrate-missing-customers 派生（user_id `FYGK-` 前缀 100%）|
| staff_wechat_users | 3299 | 10 | 3299（PK）| 2764 | 全部由 syncEmployees 创建；archive 0004 完成 employees → staff_wechat_users 合并 |

**WorkFine 端对比**（同日探查）：
| WF 表 | valid 行 | PG 行差 | 备注 |
|------|---------|---------|------|
| UDT_S_287 | 3375 | -76（PG 3299）| 76 行差额未确认；可能因 employee_id 重复或同步过滤 |
| UDT_S_311 | 59236 | -433（PG 58803）| skip 既无 phone 又无 customer_id 的行 |

> 顾客 user_id 是新系统派生（`FYGK-{YYYYMMDD}-{5位序号}`），不来自 WorkFine。员工 employee_id 直接拷 `UDT_S_287.UDF_S_1147`。

---

## 表 1：`client_wechat_users`

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| user_id | text (PK) | 新系统派生 | `FYGK-{YYYYMMDD}-{5位序号}`（每次同步当天初始化序号生成器，递增）| sync-workfine.js:L53-74, L551-552, L561 | **不来自 WorkFine**：完全 PG 派生。批次内序号在 syncCustomers 单事务中递增；migrate-missing-customers.js 也用同套生成器 |
| openid | varchar(64) | 新系统独立 | NULL（同步行 openid 全为 null，仅微信登录 bindPhone 时写入） | schema:L18 | PG 现状：仅 12/58803 行有 openid（活跃绑定的微信用户）|
| session_key | varchar(128) | 新系统独立 | 微信登录 wx.cloud session 缓存 | clientApi.auth.login | 同步不写 |
| phone | varchar(30) | WorkFine 直拷（含校验） | `validPhone(RTRIM(UDT_S_311.UDF_S_1478))`：必须 11 位且 1 开头，否则 NULL | sync-workfine.js:L489, L555 | PG 现状 24561/58803 行有 phone；WorkFine 端 27281 行有 phone — 差额 ≈ 2720 行因校验失败被设 NULL |
| customer_id | varchar(30) (UNIQUE WHERE NOT NULL) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_1475)` | sync-workfine.js:L487, L556 | WorkFine 顾客编号 `FYGK-XXXXX`；唯一索引 `uq_client_users_customer_id` 防重复 |
| name | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_1476)` | sync-workfine.js:L488, L562 | PG 现状 58799/58803（覆盖率 99.99%）|
| gender | varchar(10) | ⚠️ 未覆盖 | — | — | **WorkFine 顾客表有性别字段但脚本未抽取**：UDT_S_311 schema 中无独立 gender 列（产品上以 UDF_S_1483/1484 之一存？需确认）。PG 现状 0/58803 行有值 |
| avatar_url | text | 新系统独立 | 客户端"个人中心"上传图片 URL；同步不写 | clientApi.auth.updateProfile | PG 现状 1/58803 行非空 |
| bound_store_id | text (FK → stores.store_id) | WorkFine 派生 | `storeMap[RTRIM(UDT_S_311.UDF_S_6443)]`（store_name lookup）| sync-workfine.js:L490, L518-520, L563 | PG 现状 58797/58803（覆盖率 99.99%）；clientApi.store.bindStore 也写入 |
| bound_employee_id | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_6444)` | sync-workfine.js:L491, L564 | PG 现状 4218/58803（WF 端 4744 行有值，差额 ≈ 526 因 trim 后空）|
| bound_employee_name | varchar(50) | ⚠️ 未覆盖 | — | — | **冗余字段在 sync 时未填**：PG 现状 0/58803 行有值。schema 注释说"随 boundEmployeeId 同步写入"但实际 sync-workfine.js 未拷。运行时 staffApi.customer.assign 才写 |
| member_level | member_level enum | ⚠️ 未覆盖（枚举值不兼容）| sync 试图写 `RTRIM(UDT_S_311.UDF_S_1477)` 但**没有任何映射**：WorkFine 取值集合为 `{普通, 会员, 贵宾, 体验, 白金, 铁粉, 黑钻, 粉钻, 内部或家属}`，PG enum 仅允许 `{初钻, 星钻, 粉钻, 金钻, 黑钻}` | sync-workfine.js:L492, L564 | **业务关键字段 99.99% 流失**：WF 端 58894 行有值，PG 仅 5 行（推测仅"黑钻/粉钻"两个值偶然重叠时插入成功，其他全部因 enum 值不匹配 INSERT 失败但被 catch 吞了 — **需进一步验证**）。recalc-all-customer-types.js 后续按"滚动 12 个月销售额"自行判定（fail-fast 阈值），对历史无销售订单的会员客全部留 NULL（仅 1 行 customer_type=会员客 ∧ member_level≠NULL → 4 行初钻 + 1 黑钻 = 推算 4 行 recalc 写入 + 1 行偶然同步成功）|
| member_level_locked_until | timestamptz | 新系统独立 | NULL（cron-worker `processUpgrade` 升级时写 NOW()+150天）| migration 0006:L1 | 同步不写 |
| member_level_upgraded_at | timestamptz | 新系统独立 | NULL（cron-worker `processUpgrade` 升级时写 NOW()）| migration 0006:L2 | 同步不写 |
| old_member_level | member_level enum | 新系统独立 | NULL（cron-worker 升级前的快照）| migration 0008:L1 | PG 现状 1/58803 行有值 |
| customer_source | customer_source enum | WorkFine 派生（**严重失配**）| sync 写 `RTRIM(UDT_S_311.UDF_S_6446)`，但 enum 仅允许 `{美团, 抖音, 小程序, 推带新, 地推卡, 拓客卡, 老带新, 转让店, 自进店, 内部员工或家属}`；WorkFine 端 1300+ 自由文本值（"拓客"7596/"推广部拓客"7272/"38卡"4823/"自进"4394 等大量员工姓名当推荐人）| sync-workfine.js:L493, L565 | **PG 现状 3843 行命中 7 个枚举值**（美团 380 / 抖音 1009 / 小程序 1 / 拓客卡 7 / 老带新 485 / 转让店 1953 / 自进店 8）；WF 端 53610 行有值，**99.99% 信息流失** — `推广部拓客 / 38卡 / 拓 / 员工姓名` 等大宗类目无目标枚举可落 |
| promoter_employee_id | varchar(30) (FK → staff_wechat_users.employee_id) | 新系统独立 | NULL（同步不写）| schema:L45 | 0/58803 行有值；clientApi.auth.bindStore 时由 sourceChannel=staff 写入 |
| inviter_user_id | text (FK → client_wechat_users.user_id) | 新系统独立 | NULL（同步不写）| migration 0007:L1 | 0/58803 行有值；首次 bindStore 时写入 |
| invited_at | timestamp | 新系统独立 | NULL | migration 0007:L2 | 同上 |
| customer_type | customer_type enum NOT NULL DEFAULT '流量客' | WorkFine 派生（**间接，由订单回放推导**）| sync-workfine.js **不写此列**，全部落 schema 默认值 `'流量客'`；recalc-all-customer-types.js 用 sale_orders 重算：① 单订单或订单+回款链 ≥ new_member_threshold → 会员客；② 非卡品 SKU → 小美客；③ 卡品（除充值卡）SKU → 体验客；④ 否则流量客（仅向上跃迁）| recalc-all-customer-types.js:L60-162 | PG 现状：流量客 57155 / 小美客 1 / 会员客 1647（**注意 0 体验客**——因 product_categories 阶段商品域 SKU 关联尚未完整，CTE join 无法命中卡品）|
| became_member_at | timestamptz | WorkFine 派生（多步链）| ① recalc 用首单达阈值的 `COALESCE(paid_at, created_at)` 写入；② backfill-became-member-at.js 兜底 `COALESCE(member_level_upgraded_at, updated_at, created_at, NOW())` | recalc-all-customer-types.js:L201-244 + backfill-became-member-at.js:L66-71 + archive 0017 | PG 现状 1647/58803 行（与会员客行数一致 — 自检通过）|
| spending_tier | spending_tier enum NOT NULL DEFAULT '<1990' | ⚠️ 未覆盖 | sync / recalc / backfill **都不写此列**，全部落默认值 | archive 0022_customer_type.sql:L11-12 | **PG 现状 58803/58803 行全部为 `<1990`**（包括 1647 会员客 — 数据严重失真）。理论应该按累计销售额（含历史）打档；目前无脚本计算 |
| monthly_activity | monthly_activity enum | 新系统派生 | 每日 cron 计算：当月 service_date 去重天数 ≥2 → 二次客活，=1 → 一次客活，会员客=0 → 0次客活 | calc-monthly-activity.js:L72-139 | 同步不写 |
| customer_status | customer_status enum | 新系统派生 | 三段式 SQL：① 非会员客置 NULL；② 会员客有 service 记录的按 visits_90d/total_visits 打档；③ 会员客无记录置 `'休眠'` | update-customer-status.js / calc-monthly-activity.js:L153-195 | PG 现状：保有会员-稳定 810 / 保有会员-有效 12 / 沉睡 273 / 冰冻 242 / 休眠 310（合计 1647 = 会员客数）|
| birthday | date | WorkFine 直拷 | `toDateStr(UDT_S_311.UDF_S_1479)` （datetime2 → YYYY-MM-DD）| sync-workfine.js:L495, L566 | PG 现状 11775/58803（WF 端 12848 有值；trim 损耗 ≈ 1073）|
| occupation | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_1481)` | sync-workfine.js:L496, L566 | PG 现状 4106/58803（WF 端 4649）|
| is_married | boolean | WorkFine 派生 | `toBool(UDT_S_311.UDF_S_1482)`：`'是'` → true，其他（含 `'否'` / 空）→ false | sync-workfine.js:L497, L567 | **失真警告**：toBool 把空值映射成 `false` 而不是 NULL，PG 现状 57163/58803（97.21%）行非 NULL，但只有 8408 行 WF 端真正有值；推断 ≈ 48755 行实际是"未填"被记成 `false` |
| wechat_name | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_6445)` | sync-workfine.js:L498, L567 | PG 现状 244/58803（WF 端 250）|
| skin_type | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_6447)` | sync-workfine.js:L499, L568 | PG 现状 3223/58803（WF 端 3742）|
| improvement_focus | varchar(200) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_6448)` | sync-workfine.js:L500, L569 | PG 现状 3224/58803（WF 端 3743）|
| skin_issue | varchar(200) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_19093)` | sync-workfine.js:L501, L569 | PG 现状 3217/58803（WF 端 3737）|
| wellness_preference | varchar(200) | WorkFine 直拷 | `RTRIM(UDT_S_311.UDF_S_19094)` | sync-workfine.js:L502, L570 | PG 现状 3213/58803（WF 端 3737）|
| notes | text | 新系统独立 | NULL（运行时 staffApi.customer.updateNotes 写）| schema:L70 | PG 现状 0/58803 |
| points_balance | integer NOT NULL DEFAULT 0 | 新系统独立 | `0`（cron 每日重算从 point_transactions）| schema:L72 | PG 现状 0 行 > 0 |
| points_updated_at | timestamp | 新系统独立 | NULL | schema:L74 | |
| last_login_at | timestamp | 新系统独立 | NULL（clientApi.auth.login 写）| schema:L75 | PG 现状 5/58803 |
| created_at | timestamp NOT NULL | 新系统独立 | `defaultNow()`（同步行 = 同步时刻）| schema:L76 | 100% 行集中在 < 2026-04-10（baseline reset 前的同步窗口）|
| updated_at | timestamp NOT NULL | 新系统独立 | `defaultNow() + onUpdate`；UPSERT 时强制 `now()` | schema:L77 | |

### 关键决策

1. **user_id 完全 PG 派生**：与 02-org `org_nodes.id` (hashId) 不同，user_id 是序号递增格式（`FYGK-YYYYMMDD-NNNNN`），**不可反推**到 WorkFine 任何字段。如需反查 WorkFine 顾客 RID，需要保留 `customer_id` 列做 join。
2. **member_level 99.99% 流失** — sync-workfine.js 直接拷 WF 取值，但 PG enum 不兼容（普通/会员/贵宾/体验/白金/铁粉 全部无对应）。若最终迁移要保留 WF 等级语义，**必须新增 `legacy_member_level varchar` 列**保留原文，PG enum 由 recalc 重算（这是当前实现的折衷方案，但存量"贵宾/白金"等高价值标签信息已永久丢失）。
3. **customer_source 99.99% 流失** — 类似问题：1300+ 自由文本被裁剪为 7 个枚举值，53610 → 3843 行。建议最终迁移补 `legacy_customer_source text` 列保留原文。
4. **is_married 数据失真** — toBool 把 NULL/空 当成 false，是迁移的语义错误：59236 → 8408 真实有值，PG 却落 57163 行；需要改成 `tribool`（boolean nullable）+ `null` 当未填。
5. **spending_tier 全部默认 `<1990`** — 没有任何脚本计算这个字段，包括 1647 会员客也是 `<1990`，**实际是 schema 默认值未被覆盖**。需要补一个 backfill 按 sale_orders 累计金额打档。
6. **customer_type=体验客 数=0** — recalc-all-customer-types CTE join 依赖 product_skus.category_id → product_categories.product_kind 完整链路，但商品域 SKU 数据 v2.1 重构未完整覆盖体验卡，导致体验客判定恒不命中。

### 已被脚本读但未对接到 PG 的 WorkFine 列

UDT_S_311 共 49 列，syncCustomers 仅用了 16 列。其余 33 列含义对照（参考 `notes/research/workfine_database.md`）：

| WorkFine 列 | 类型 | 含义推断 | 现状 |
|-------------|------|----------|------|
| UDF_S_1472 / UDF_S_1473 | nvarchar | 编辑/创建标记 | 未对接 |
| UDF_S_1474 | datetime2 | 顾客建档日期 | ⚠️ **未对接但有用**：可作为 `created_at` 的真实业务时间（PG 当前用同步时刻）|
| UDF_S_1480 | decimal | 含义未明（金额？）| 未对接 |
| UDF_S_1483 / UDF_S_1484 | nvarchar(350) | 详细地址 / 联系人备用电话？| ⚠️ 未对接，schema 也无对应列 |
| UDF_S_1486 | nvarchar | 顾客性别？（待 sample 验证）| ⚠️ 推测是 `gender` 来源，sync 未抽 |
| UDF_S_1717 / UDF_S_1718 | decimal | 含义未明（积分/余额？）| 未对接 |
| UDF_S_6486 | nvarchar | 推荐人 / 备注？| 未对接 |
| UDF_S_17014 | nvarchar | 标签？ | 未对接 |
| UDF_S_17758 / UDF_S_17759 | nvarchar | 标签 / 分类？ | 未对接 |
| UDF_S_17850 | nvarchar | 含义未明 | 未对接 |
| UDF_S_17856-58 | decimal | 累计金额（消费/储值？）| ⚠️ **未对接但有用**：可能是 `spending_tier` 真实数据源 |
| UDF_S_18104 | decimal | 含义未明（金额）| 未对接 |
| UDF_S_18105 | nvarchar | 含义未明 | 未对接 |
| UDF_S_18399 / UDF_S_18400 | nvarchar | 含义未明 | 未对接 |
| UDF_S_18518 | nvarchar | 含义未明 | 未对接 |
| UDF_S_19120-19124 | nvarchar | 含义未明（连续 5 列）| 未对接 |
| UDF_S_21230 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1712 | nvarchar(150) | A/B/C/D/E 五级分类（"会员价值分档"）| ⚠️ **脚本读了但 PG 列已 DROP**：archive 0016 已 DROP `category` 列；sync 仍试图 INSERT `category=$8`，**该 INSERT 现在在生产库会报错**（如果 sync 还在跑）。WF 端有 23356 行 A/B/C/D/E 分级数据**完全未保留** |
| UDF_S_18105 ~ 18400 | nvarchar | 多个未明列 | 未对接 |

> **特别提示**：archive `0016_sync_to_current.sql:L99` 删除了 `client_wechat_users.category` 列。但 `sync-workfine.js:L493/L532-543/L592/L615/L641/L660/L678/L697/L701` 仍把 category 读入 staging 并写入主表 — **如果 sync 在 baseline reset 后再跑就会报错**。当前规避：sync 已经停用（2026-04-16，参考 `workfine-sync-stopped` memory）。

---

## 表 2：`staff_wechat_users`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| employee_id | varchar(30) (PK) | WorkFine 直拷 | `RTRIM(UDT_S_287.UDF_S_1147)` | sync-workfine.js:L214, L297, L366 | v3.3 简化：employee_id 升为 PK（删除原 user_id 列）|
| openid | varchar(64) | 新系统独立 | NULL（同步行 openid 全为 null，仅微信登录 bindPhone 写入）| schema:L102 | PG 现状 10/3299 |
| session_key | varchar(128) | 新系统独立 | 微信登录写 | staffApi.auth.login | |
| phone | varchar(30) (UNIQUE WHERE NOT NULL) | WorkFine 派生 | `validPhone(RTRIM(UDT_S_287.UDF_S_1152))` + 去重逻辑：同号在职优先保留 1 条，其余设 NULL | sync-workfine.js:L294-328, L367 | **去重前先 `UPDATE staff_wechat_users SET phone = NULL WHERE phone IS NOT NULL`**（L332 — 全表清空再 UPSERT，因唯一索引）；PG 现状 2764/3299，WF 端 2985 有值，差额 ≈ 221 来自重复 + 占位号过滤 |
| name | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_287.UDF_S_1155) || empId`（fallback 到 empId）| sync-workfine.js:L215, L368 | PG 现状 3299/3299（覆盖率 100%，因有 fallback）|
| gender | varchar(20) | WorkFine 直拷 | `RTRIM(UDT_S_287.UDF_S_1148)` | sync-workfine.js:L216, L369 | PG 现状 3298/3299 |
| id_card | varchar(200) | WorkFine 直拷 | `RTRIM(UDT_S_287.UDF_S_1154)` | sync-workfine.js:L218, L370 | ⚠️ **schema 注释说"AES-256-GCM 加密存储"，但 sync 写的是明文**：PG 现状 3251/3299 行有值，需验证是否真加密。如未加密，违反 PII 合规 |
| store_id | text (FK → stores.store_id) | WorkFine 派生 | `storeMap[RTRIM(UDT_S_287.UDF_S_1163)]` | sync-workfine.js:L219, L341, L371 | PG 现状 3285/3299 |
| org_node_id | text (FK → org_nodes.id) | WorkFine 派生（部门匹配）| ① 同时有 store + dept_name → `storeDeptMap[storeName + '\|' + deptName]`（门店级部门 hashId）；② 仅 dept_name → `globalDeptMap[deptName]`（全局部门，挂总部）| sync-workfine.js:L220, L264-289, L342-348, L372 | **本字段是 02-org 的"部门 376 行"主要来源**（部门由本步骤创建：storeDeptPairs + globalDeptNames）|
| position_name | varchar(50) | WorkFine 直拷 | `RTRIM(UDT_S_287.UDF_S_1161)` | sync-workfine.js:L221, L373 | PG 现状 3298/3299；常见值：美容师 1038 / 实习经理 327 / 财智部初级助理 313 / 代理经理 276 / 推广员 242 |
| birthday | date | WorkFine 直拷 | `toDateStr(UDT_S_287.UDF_S_1149)`（datetime2 → YYYY-MM-DD）| sync-workfine.js:L222, L374 | PG 现状 2920/3299（WF 端 2997）|
| skills | text[] | ⚠️ 部分覆盖（手工维护 + commission rename）| sync-workfine.js **不写此列**；archive 0010_commission_role_rename.sql:L6 把 skills 中 `'推广'` UPDATE 为 `'推广师'`；员工端"我的"页面手动维护 | archive 0010 + 员工端 staffApi.staff.* | PG 现状 955/3299 行有值；常见值：美容师 647 / 推广师 200 / 养生师 113 / 管理 4。**业务关键**：sale_allocations.role_type 由 `skills[0]` 派生（详见 01-order） |
| is_resigned | boolean NOT NULL DEFAULT false | WorkFine 派生 | `toBool(RTRIM(UDT_S_287.UDF_S_1624))`：`'是'` → true | sync-workfine.js:L223, L310, L375 | PG 现状 1279 离职 / 2020 在职；WF 端 1304 离职 |
| hired_at | date | ⚠️ 未覆盖（用 created_at 兜底）| migration 0012:L13-15 兜底回填：`UPDATE staff_wechat_users SET hired_at = created_at::date WHERE hired_at IS NULL` | migration 0012 + schema:L121 | **WorkFine SQL Server 当前无"入职日期"字段**（migration 0012 注释：UDT_S_287 仅 UDF_S_1149=birthday）。PG 现状 3299/3299 全部用 created_at 兜底（即同步时刻），**与真实入职日期完全无关**——影响 mgmt-dashboard 员工历史化 |
| resigned_at | date | ⚠️ 派生 + 兜底（不来自 WF 真实日期）| migration 0012:L19-22 兜底回填：`UPDATE staff_wechat_users SET resigned_at = updated_at::date WHERE is_resigned = TRUE AND resigned_at IS NULL` | migration 0012 + schema:L123 | **数据失真**：1279 行 resigned_at 全部 = 同步时刻 `updated_at::date`，**不是真实离职日期**。WF 端 UDT_S_287.UDF_S_1626 是 datetime2，可能就是离职日期但 sync 未抽取（待 sample） |
| last_login_at | timestamp | 新系统独立 | NULL（staffApi.auth.login 写）| schema:L124 | PG 现状 1/3299 |
| created_at | timestamp NOT NULL | 新系统独立 | `defaultNow()` | schema:L125 | 100% 行集中在 2026-03-13 ~ 2026-03-21（同步窗口，仅 5 个不同日期 — 几次完整同步 run）|
| updated_at | timestamp NOT NULL | 新系统独立 | `defaultNow() + onUpdate`；UPSERT 时强制 `now()` | schema:L126 | |

### 关键决策

1. **employee_id 直接来自 WF**（与 client_user_id 不同），所以可以反查 WorkFine。其他业务表 FK 都引这个 PK，迁移时要保留。
2. **手机号去重逻辑很特殊**：sync 先全表 UPDATE 清空 phone，再 UPSERT 写回 — 单步事务内执行。如果 sync 中途失败 ROLLBACK 没问题；但如果脚本被 SIGKILL 之类硬中断，会留 phone 全 NULL 的状态。生产环境跑过 5 次同步（2026-03-13 ~ 21），未观察到事故。
3. **id_card 加密标记不一致**：schema 注释强制 AES-256-GCM，sync 写明文。**最终迁移前必须验证哪个是真相**（看运行时 staffApi 是否有解密路径），否则可能生产已经在合规风险中。
4. **hired_at / resigned_at 数据失真**：与 02-org `stores.closed_at` 是同一类问题（migration 0012 用 updated_at 兜底）。如业务需要真实日期，最终迁移要从 WF 重抽 UDT_S_287.UDF_S_1626（需 sample 验证语义）。
5. **skills 数组只有 955/3299 行有值**：远低于 position_name（3298）覆盖率。`sale_allocations.role_type` 派生依赖 skills[0]，缺失时会 fallback 到 `'美容师'`（参考 01-order migrate-allocations.js:L168）—— 实际 1038 美容师 + 327 实习经理 + ... 都没有 skills，role_type 大部分是 fallback 值。

### 已被脚本读但未对接到 PG 的 WorkFine 列

UDT_S_287 共 60+ 列，syncEmployees 仅用了 9 列（UDF_S_1147/1148/1149/1152/1154/1155/1161/1163/1513/1624）。重要未抽列：

| WorkFine 列 | 类型 | 含义推断 | 现状 |
|-------------|------|----------|------|
| UDF_S_1150 | decimal | 含义未明（年龄/序号？）| 未对接 |
| UDF_S_1151 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1153 | nvarchar | 含义未明（备用电话？）| 未对接 |
| UDF_S_1156 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1157 | nvarchar(3000) | 备注（长文本）| 未对接 |
| UDF_S_1158 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1159 | datetime2 | ⚠️ **疑似入职日期**（与 hired_at gap 高度相关）| 未对接 |
| UDF_S_1160 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1162 | datetime2 | 含义未明（日期）| 未对接 |
| UDF_S_1164 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1165 | datetime2 | 含义未明（日期）| 未对接 |
| UDF_S_1183 | nvarchar | 含义未明 | 未对接 |
| UDF_S_1625 | nvarchar | ⚠️ **疑似离职原因**（is_resigned=true 时通常配套）| 未对接 |
| UDF_S_1626 | datetime2 | ⚠️ **疑似离职日期**（resigned_at 真实数据源候选）| 未对接，PG resigned_at 用 updated_at 兜底 |
| UDF_S_1627 | nvarchar | 含义未明 | 未对接 |
| UDF_S_2089 + 11 个 UDF_S_10085+ | nvarchar | 含义未明（推测：紧急联系人/银行账户/合同/学历）| 未对接 |
| UDF_S_12921 / 13408-13429 | 多类型 | 含义未明（22 个连续列 — 推测扩展档案）| 未对接 |

> 强烈建议在生成最终迁移脚本前，对 UDT_S_287 的 1159/1162/1626/1627 + 1625 抽样核对语义，至少把 hired_at/resigned_at 的真实日期补上。

---

## 关键决策摘要（跨两表）

1. **WorkFine → PG 枚举值映射缺失**是本模块最大风险：member_level、customer_source 两个枚举的值集合在 WF 端有上千种自由文本，PG enum 只允许 5-10 个固定值，sync 直接拷写导致 99%+ 信息流失。
2. **顾客同步缺 phone 时不报错继续 INSERT** — sync 三段式逻辑健壮（phone 段 + customer_id 段 + 新建段），但 group A `migrate-missing-customers.js` 用订单 customer_name 当作 name 写入，并不能完整恢复顾客档案（仅 name+store_id）。
3. **categroy 字段未删 / 已 DROP 不一致** — sync 脚本仍写 `category` 列，但 PG schema 该列已 DROP（archive 0016）。同步现已停用（2026-04-16），但代码未清理；最终迁移脚本必须删掉这一列的 INSERT，否则迁移会报 column does not exist。
4. **runtime 新写字段不来自 WF**：openid / session_key / avatar_url / notes / promoter_employee_id / inviter_user_id / member_level_locked_until / member_level_upgraded_at / customer_status / monthly_activity / points_balance / last_login_at — 这些字段在最终迁移时**不需要从 WF 拉**，但需要保留 schema 默认值不覆盖。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

### client_wechat_users
- `member_level` — WF UDF_S_1477 取值集（普通/会员/贵宾/体验/白金/铁粉/...）与 PG enum（初钻/星钻/粉钻/金钻/黑钻）99.99% 不兼容；建议补 legacy_member_level text 列
- `customer_source` — WF UDF_S_6446 1300+ 自由文本被裁剪到 7 种枚举值；建议补 legacy_customer_source text 列
- `gender` — sync 未抽取（推测来源 UDT_S_311.UDF_S_1486 待验证），PG 全 NULL
- `bound_employee_name` — schema 标注"冗余写入"但 sync 未实现，PG 全 NULL
- `is_married` — toBool 把 NULL 当 false，57163/58803 行存伪 false
- `spending_tier` — 没有任何脚本计算，全部默认 `<1990`，包括 1647 会员客
- `customer_type=体验客` 数恒为 0 — recalc CTE 依赖商品域 SKU 链路缺失
- `category` 列已 DROP 但 sync 仍写 — sync 在 baseline 后跑会报错（已停用规避）
- WF UDT_S_311.UDF_S_1474（建档日期）未抽取，PG created_at 是同步时刻
- WF UDT_S_311.UDF_S_17856-58（金额累计列）未对接，可能是 spending_tier 真实数据源
- WF UDT_S_311.UDF_S_1483/1484（地址/备用电话）未对接，schema 也无承载列
- WF UDT_S_311.UDF_S_1712 (A/B/C/D/E 分级，23356 行有值) — `category` 列删除后 WF 这一列价值分档信息**完全丢失**

### staff_wechat_users
- `id_card` — schema 注释"AES-256-GCM 加密"但 sync 写明文；PII 合规风险待核
- `hired_at` — WF UDT_S_287 当前无入职日期（待确认是否 UDF_S_1159/1162），PG 全部用 created_at 兜底
- `resigned_at` — 1279 离职行全部 = updated_at::date，**不是真实离职日期**；WF UDF_S_1626 是 datetime2 候选
- `skills` — 仅 955/3299 行有值，sale_allocations.role_type 派生数据质量差
- WF UDT_S_287.UDF_S_1157（备注 nvarchar(3000)）未抽
- WF UDT_S_287.UDF_S_1625（疑似离职原因）未对接
- WF UDT_S_287 共 60+ 列，sync 仅用 9 列；剩余 50+ 列含义不明，可能含合同/学历/紧急联系人等业务有用字段
- 3375 → 3299 行差额（76 行）来源未确认

---

## Review 报告（2026-04-26）

独立 5 步调研后对比文档：列字段 / 写入入口 / MSSQL 抽样（admin@47.96.87.33:1433）/ PG 抽样（5434/fengyu）/ 形成应该长什么样。

### 一致项数 / 不一致项数

- 一致项：约 28（PK 派生算法、user_id `FYGK-` 100% 覆盖、bound_employee_name 0/58803、becameMemberAt = 1647 与会员客对齐、id_card 明文 360/111 开头确认、resigned 1279/in-service 2020、UDT_S_1712 共 23356 行 A/B/C/D/E、is_married false/true 量级、customer_status 总和 = 1647、archive 0016 DROP category 列与 sync 仍写存在的"已停用规避"等）
- 不一致项：**8 项**（见下）

### 偏差明细

**A. 缺漏（doc 漏说的事实）**

1. **`monthly_activity` 100% NULL（0/58803）**：doc L63 说"每日 cron 计算"，但 PG 现状全部 NULL。calc-monthly-activity.js 在生产从未跑过，与 10/points + 12/messages 同源问题（cron-worker 在 baseline reset 后零产出）。doc 应在备注列加"PG 现状 0/58803"。
2. **`UDF_S_1486` 取值 ≠ gender**：doc L99 推测 1486 是 `gender` 来源，但 sample 显示 1486 取值是 `'否'`（疑似"是否会员"或类似 bool 标记），**不是性别**。gender 真实来源 WF 端不存在或藏在另一列，仍需排查。
3. **UDT_S_287.UDF_S_1162 全员有值（3299/3299）**：doc L166 / L207 把 1162 标"含义未明"，但抽样：① 全表 100% 覆盖；② 91.3%（3011/3299）行 1162 与 employee_id 内嵌的"FY-YYMMDD…"日期戳偏差 ≤ 90 天；样本如 emp_id `FY-230420001` 对应 d1162=2023-04-20——**1162 极大概率就是入职日期**，应作为 `hired_at` 真实数据源。doc 关键决策 4 错误地从 migration 0012 注释引用"WF 当前无入职日期字段"，应推翻。
4. **UDT_S_311.UDF_S_1474 = 顾客建档日期，58187/59239 (98.2%) 有值**：doc L96 / L200 标"未对接但有用"，正确，但量级未给。补此数据后，`created_at` 可从同步时刻矫正为真实建档时间，影响月度新客指标历史化。

**B. 错配（doc 写错的事实）**

5. **UDF_S_1626 = 真实离职日期已确认，1279 行有值与 PG 1279 离职行 100% 数量匹配**：doc L171 / L208 / L149 都标"待 sample 验证"——已验证。同时 **UDF_S_1625 = 真实离职原因**（取值 `'个人原因'` / `'0'` 等，1279 行覆盖），doc L170 标"疑似"已可确认。
6. **member_level 5 行 ≠ doc 推算（4 初钻 + 1 黑钻）**：实测 PG 4 初钻 + 1 黑钻 = 5（一致）。但 doc L52 说"WF 端 58894 行有值"，实测 WF 端 58898 行（57727+678+263+151+62+13+3 = 58897，含 1 粉钻 1 黑钻 1 铁粉 = 58898）。差额 < 0.01% 可接受。
7. **WF UDT_S_311 valid 行 = 59239（doc 写 59236）**：差 3 行，量级正确但需更新（可能是 syncCustomers 跑后 WF 端新增 3 顾客）。同理 customer_source `推广部拓客` 实际 7276 行（doc 写 7272），`推广部` 1005 行 doc 未列；不影响整体 99.99% 流失结论。
8. **PG customer_status 数值 drift**：doc 说"沉睡 273 / 保有会员-稳定 810"，实测"沉睡 283 / 保有会员-稳定 800"。可能是 update-customer-status.js 多次跑后 ±10 行的正常波动；总和仍 = 1647 = 会员客数，逻辑自洽。

**C. 数据不一致**

9. **PG is_married 三态分布**：doc L67 / L196 说"57163/58803 行存伪 false"，实测 false=57113，null=1640，true=50。null=1640 行**已被 admin 端某路径写回 NULL**（不是 sync），与 doc"toBool 把 NULL 全部映射 false"假设矛盾。toBool 行为仍需保留警告，但"全部 false 化"的描述需修正为"绝大多数（57113）"。

**D. 过时事实**

10. （无）

### 关键 P0 升级建议

- 已经确认 **UDF_S_1162 = 入职日期 + UDF_S_1626 = 离职日期 + UDF_S_1625 = 离职原因**，最终迁移脚本应直接抽取，**不要复用 migration 0012 的兜底**——否则 hired_at/resigned_at 永久=同步时刻，影响 mgmt-dashboard 员工数历史化（决策 D8 ticket）。已记入 _gaps.md。

### Verdict: **minor-fix**

数据血缘表主体无重大错误，但有 4 个具体待补/待修正条目（hired_at/resigned_at 真实数据源、monthly_activity 0 行、UDF_S_1474 量级、is_married 三态分布）。不需要重写，按以上 8 点 inline patch 即可。

---

## Edge Case 报告 R2（2026-04-26）

主动挖文档外问题，8 类风险维度逐项探针（PG 5434/fengyu）。

### 8 类维度结论

| # | 维度 | 命中 / 未命中 / 不适用 | 关键证据 |
|---|------|----------------------|---------|
| 1 | FK 孤立 / 引用完整性 | **命中（高危）** | 1 个高危：`bound_employee_id` 4210 孤立行（4188 是中文姓名而非 ID）；其他 4 个 FK 列 0 孤立 |
| 2 | NULL / 空串 / 极值 | **命中（中危）** | client.birthday 7 行 < 1900（最早 0172-11-10），26 行 > 今天（最远 2043）；staff.birthday 49 行 < 15 岁（含 18 行在职），1 行 staff.gender = "汉"（民族字串错位）；client.phone 81 行格式异常（`空号`/`.`/`0`/`131+9769733`）；user_id 1 行格式异常 `FYGK-b3abfd8bb034`；空字符串：0 行（sync RTRIM + nullIfEmpty 守住） |
| 3 | enum 漂移 | **命中（已知，强化证据）** | member_level 5 行（4 初钻 + 1 黑钻）；customer_source 7/10 个值 0 行；customer_type 体验客 0 行；spending_tier 6 个值中 5 个 0 行；monthly_activity 100% NULL；staff.skills "管理"/"面部护理" 等单值出现（设计未明确） |
| 4 | unique 约束守住 | **未命中** | openid / phone / customer_id / user_id 全部无重复（含部分唯一索引下 `IS NOT NULL`） |
| 5 | 跨模块一致性 | **命中（中危）** | 5 行 `member_level NOT NULL` 但 customer_type=流量客（1 行）or 会员客但 became_member_at=NULL（0 行已通过）；1 行 `old_member_level=粉钻` 但 member_level=NULL（recalc / cron 状态不自洽）；其他跨表 cross-ref（sale_orders.client_user_id / appointments.client_user_id / service_orders.client_user_id 反向 join）全部 0 孤立 |
| 6 | 死代码 / 永不命中 | **命中（低危）** | bound_employee_name 0/58803 行（schema 注 "冗余写入" 但 sync + admin 均不实现）；session_key 全 0；customer_source 3 值 / member_level 3 值 / spending_tier 5 值在 enum 但 DB 0 行 |
| 7 | dump-restore 残留 / drift | **未命中** | category 列已 DROP 与 schema 一致；employees / customers 旧表已删；staff.user_id 旧 PK 列已删 |
| 8 | 运行时安全 / 索引 | **命中（中危）** | 缺索引：`bound_employee_id`、`promoter_employee_id`、`customer_type`、`customer_status` 均无独立索引（顾客分类统计 / 美容师"我的新会员" SQL 高频但全表扫）；id_card schema 注释 "AES-256-GCM 加密" 但 3251/3251 行 18 位明文（PII 合规已发生风险）；FK 全部 NO ACTION（删除引用行需先清空，但目前无删除接口） |

### 高危发现明细

#### 高危 1（**业务永久失效，资损**）：`client_wechat_users.bound_employee_id` 列名声称"员工编号"但 4188/4218 (99.3%) 行实际是员工姓名

**证据**：

```sql
SELECT
  sum(CASE WHEN bound_employee_id ~ '^[一-龥]+$' THEN 1 ELSE 0 END) AS chinese_name_like,
  sum(CASE WHEN bound_employee_id ~ '^FY-[0-9]+$' THEN 1 ELSE 0 END) AS valid_id_format,
  sum(CASE WHEN bound_employee_id IS NOT NULL THEN 1 ELSE 0 END) AS total_non_null
FROM client_wechat_users
-- 结果：chinese_name_like=4188, valid_id_format=0, total_non_null=4218
```

**Top 10 孤立值（中文姓名）**：陈贵梅 162 / 陈海燕 140 / 邓荣玉 100 / 付霞 90 / 刘佳星 72 / 卢飘 64 / 无 64 / 徐菊花 56 / 胡蕾 54 / 万敏 52

**根因**：

- `db/scripts/sync-workfine.js:L491` `RTRIM(UDF_S_6444) AS bound_employee_id`
- WorkFine `UDT_S_311.UDF_S_6444` 实际是 nvarchar，存的是"绑定美容师姓名"，不是员工编号
- sync 把 raw 文本原样塞进语义为 `employee_id` 的 PG 列；该列**没有 FK 约束**（schema:L32 也未声明 references），完美绕过校验
- 形成对比：同模块 `promoter_employee_id` 列**有** FK → staff_wechat_users.employee_id 约束，所以保持干净（但目前 0 行有值，仅是因为 sync 不写它）

**业务影响**：

- `staff.js:L711` "我的新会员" SQL：`newMemberFilter = 'c.bound_employee_id = $1'`（$1 是 employee_id 如 `FY-220801001`）。employee_id 不可能命中中文姓名行 → **美容师在工作台看到的"我的新会员"恒为 0**（除了运行时 admin/staff.assign 主动赋值的极少数行）
- `mgmt-dashboard.js:L1042-1048` staffRanking SQL：`GROUP BY c.bound_employee_id`，4188 个中文名行被聚合成 400 个伪员工分组，与真实 staffRanking 完全错位（店长看到的员工绩效榜单都是错的）
- `customer.js:L305-310` 顾客详情"指定美容师名"：`SELECT name FROM staff_wechat_users WHERE employee_id = bound_employee_id` → **99.3% 顾客 UI 显示空美容师**

**修复方向**：

- A（推荐）：写 backfill 脚本，按 `staff_wechat_users.name` 反查 employee_id（注意 staff name 有重复：陈倩/王丽/李娟 各 3 个，需结合 `staff.store_id = client.bound_store_id` 二次唯一化）。Sample 探针显示 405/419 distinct name 可由 staff_name 单点匹配，剩 14 个置 NULL
- B：新增 `bound_employee_name` 列保原文 + 全列 NULL 化 bound_employee_id；运行时 SQL 改用 name join（但姓名重名问题仍存在）
- C：直接给 bound_employee_id 加 FK + check 约束 `^FY-`，强制 sync 解析；旧数据 backfill 修

#### 高危 2（**数据脏 + 业务异常**）：`client_wechat_users.birthday` 含古代/未来日期 33 行

**证据**：

```sql
SELECT min(birthday), max(birthday),
  sum(CASE WHEN birthday < '1900-01-01' THEN 1 ELSE 0 END) AS pre_1900,
  sum(CASE WHEN birthday > CURRENT_DATE THEN 1 ELSE 0 END) AS future_birthday
FROM client_wechat_users WHERE birthday IS NOT NULL
-- min=0172-11-10, max=2075-02-12, pre_1900=7, future_birthday=26
```

样本：陈宝红（FYGK-20260313-24406）birthday=`0172-11-10`；方菊花 `2043-03-17`；曾新容 `2029-12-06`；江军连 `1899-12-30`

**根因**：sync-workfine.js:L495 `toDateStr(UDT_S_311.UDF_S_1479)` 直拷无范围校验。WorkFine 端建档时手工录入误差或粘贴失败

**业务影响**：

- 顾客生日提醒/筛选：admin 顾客详情可能崩在 `new Date('0172-11-10')` 解析；本月生日 / 下月生日统计准确度受影响
- 营销短信：群发"生日福利券"时给古代/未来日期顾客发消息，UI bug 暴露给用户
- 量级：33 / 11775 ≈ 0.28%，量小但可见

**修复**：sync 与 admin actions.customers.update 加 `[1900, current_year]` 校验；现存 33 行 NULL 化

#### 高危 3（**PII 合规已发生风险**）：`staff_wechat_users.id_card` schema 注释"AES-256-GCM 加密"但 3251/3251 行均为明文身份证

**证据**：

```sql
SELECT
  sum(CASE WHEN length(id_card) = 18 THEN 1 ELSE 0 END) AS plain_18digit,
  sum(CASE WHEN length(id_card) BETWEEN 60 AND 250 AND id_card ~ '^[A-Za-z0-9+/=]+$' THEN 1 ELSE 0 END) AS encrypted_like
FROM staff_wechat_users WHERE id_card IS NOT NULL
-- plain_18digit=3250, encrypted_like=0, max_len=18
```

**根因**：sync-workfine.js:L218 `RTRIM(UDF_S_1154)` 直拷；schema:L108 注释与代码实现不一致

**业务影响**：3299 名员工身份证号明文存于 PG，符合 PII 泄露风险；admin 后台读 id_card 时无解密层（运行时无解密代码 grep）

**修复**：① 写一次性加密迁移脚本（KEK + DEK 体系）；② 加 admin 端解密路由；③ 同步脚本最终迁移时改为加密写入

### 中危发现

- **member_level 5 行状态错配**：1 行 customer_type=流量客但 member_level=黑钻（recalc 只升不降）；1 行 old_member_level=粉钻但 member_level=NULL（cron-worker 升级失败回滚不完整）。修复：写一次性 cleanup 脚本对齐
- **client.phone 81 行非法**（`空号`/`.`/`0`/`131+9769733`/`13530986989/15907907823`）：sync 的 validPhone（11 位 + 1 开头）被 10 位数字 / 含分隔符串 / "空号" 字面值绕过。建议加严 `^1[3-9][0-9]{9}$`
- **user_id 1 行格式异常 `FYGK-b3abfd8bb034`**：admin 端 createCustomer 路径用了 hashId 生成器与 sync 的序号生成器格式冲突
- **缺索引**：bound_employee_id / promoter_employee_id / customer_type / customer_status 高频用于聚合查询但无独立索引；表 58803 行已成中等规模，全表扫开始有性能感知
- **死代码**：bound_employee_name 列 0 行写入；session_key 列 0 行写入；customer_source/member_level/spending_tier enum 中各有 3-5 个值永远 0 行（spending_tier 整字段死配置——单值 `<1990`）

### Verdict: **serious-edge-cases**

主要因高危 1 (`bound_employee_id` name/id 错位) 已经导致美容师"我的新会员" / mgmt-dashboard staffRanking / customer.detail 三个高频接口在生产环境产生**业务永久失效 + 错误聚合数据**，这是已发生的资损级问题（不是潜在风险）。即便没有这条，高危 2 (33 行荒谬生日) + 高危 3 (3251 行明文身份证 PII 合规) 任一单独都够 serious 级别。

P0 修复顺序：

1. bound_employee_id backfill 重写为真实 employee_id（业务永久失效，影响每天店长/美容师查工作台）
2. id_card 加密迁移（合规风险，无业务影响但每日累积）
3. birthday 范围校验 + 33 行 NULL 化（小但可见）

