# 08 — `commission` 模块

**Schema 文件**：`db/schema/commission.ts`
**涉及 PG 表**：`commission_rate_matrix`
**WorkFine 源表**：**无业务对应实体**（详见下方"WorkFine 端无业务对应实体"小节）
**主要写入入口**：
- `fengyu-admin/src/actions/commission.ts:L89` — `createRate`（admin UI 唯一新增入口，含金额阶段重叠校验）
- `fengyu-admin/src/actions/commission.ts:L156` — `updateRate`（admin UI 唯一修改入口，乐观锁 + 重叠校验）
- `fengyu-admin/src/actions/commission.ts:L182` — `deleteRate`（admin UI 唯一删除入口，物理删除）
- `fengyu-admin/src/db/seed.ts:L286-300, L397` — `COMMISSION_RATES` 13 条 demo 种子（`onConflictDoNothing`，仅开发环境）
- `db/migrations/0010_fix_commission_matrix_sales_category.sql` — 一次性 enum 翻新（`自采自销 → 自销自耗`）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0009_commission_enum_chinese.sql` — baseline 前的英文→中文翻新（`sale → 销售单`、`service → 服务单`、`技师 → 美容师` + 复制行成`养生师`）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0010_commission_role_rename.sql` — baseline 前的角色翻新（`推广 → 推广师`、`DELETE WHERE role_type = '顾问'`）

**写入入口（运行时只读）**：
- `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:L262-269` — `getCommissionRates`（销售单 / 服务单全量，按 marketName JOIN org_nodes）
- `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:L408-415` — `suggest` 分配建议（仅销售单，按 amount_tier 命中行）
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js:L401-411` — `service.complete` 时按 `(role_type, sales_category, consumeBase)` 取最高命中阶段，rate=0 时仅写 operation_logs 不阻塞

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 维度 | 值 |
|------|------|
| 总行数 | **15** |
| 按 org_node | 南昌市场=9, 九江市场=4, Y九江市场=2 |
| 涉及市场 / 总市场数 | 3 / 24（**21 个市场无任何提成配置**） |
| 按 order_type | 销售单=13, 服务单=2 |
| 按 role_type | 美容师=8, 养生师=6, **推广=1**（旧名残留，未跟随 archive 0010 的 `推广师` 重命名） |
| 按 sales_category | 自销自耗=12, 他销自耗=3 |
| amount_tier_max 非 NULL | 4 / 15（仅 4 行有上限） |
| commission_rate 区间 | [0.0500, 0.1500]，平均 0.0953 |
| created_at distinct | 4 个时间点（2026-03-13、2026-03-14、2026-03-21 ×2）— 与 admin commission.create 在 operation_logs 出现 3 次（2026-03-21）+ commission.delete 1 次（2026-03-23）匹配 |

> **关键定位**：`commission_rate_matrix` 是 **100% 新系统独立** 表。WorkFine MSSQL 端**没有任何**业务实体（提成/分成/抽成/比例）相关的 BASE TABLE 或字段元数据；全部 15 行均由 admin UI / seed.ts 录入，运行时云函数仅做 SELECT。本模块不参与 WorkFine→PG 迁移，最终迁移脚本只需保留 admin 录入数据 + 决定是否随 baseline 重导 13 行 seed。

---

## 表 1：`commission_rate_matrix`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial (PK) | 默认值/NULL | PG 自增 | schema:L12 | |
| org_id | text NOT NULL FK→`org_nodes.id` | 新系统独立 | admin UI 下拉选自 `getMarkets()`（`org_nodes WHERE type='市场'`） | commission.ts:L18-30, L90 | 间接传递自 02-org（org_nodes.id 是 hashId 派生）；本表不直接读 WF |
| order_type | varchar(20) NOT NULL | 新系统独立 | admin UI 表单录入；当前取值 `销售单` / `服务单` | commission.ts:L91 | 命名约定与 `sale_orders.sale_order_type` 不同：仅区分销售/服务大类，不区分销售单 enum 5 值。**spec backend.pr.spec.md §2.7 写"sale/service"已过时**（archive 0009 翻新成中文） |
| role_type | varchar(20) NOT NULL | 新系统独立 | admin UI 表单录入；当前取值 `美容师` / `养生师` / `推广` | commission.ts:L92 | ⚠️ **PG 现状残留 1 行 `推广`**——archive 0010 已 `UPDATE role_type='推广师' WHERE role_type='推广'`，但 baseline 后又被某次 admin UI 录入回 `推广`（创建时间 2026-03-13 早于 admin 后台正常运营，疑似从旧库 dump 带入未清洗）。运行时 service.js:L404 按 `staff_wechat_users.skills[0]` 取角色（约定值 `美容师`/`养生师`/`推广师`），如果员工 skills 含 `推广师`，本表 `推广` 行**永不被命中**，rate=0 |
| sales_category | varchar(20) NOT NULL | 新系统独立 | admin UI 表单录入；当前取值 `自销自耗` / `他销自耗` | commission.ts:L93 | varchar **不是** enum：migration 0010 注释明确"sales_category 是 varchar(20) 不是 enum，0009 ALTER TYPE RENAME VALUE 不触达本表数据"。0010 一次性 `UPDATE 自采自销 → 自销自耗` 收尾 12 行残留 |
| amount_tier_min | numeric(10,2) NOT NULL | 新系统独立 | admin UI 表单录入（含端） | commission.ts:L94 | 现状 PG 全部 15 行 = `0.00` 或 `5000.00` 两个值；spec 仅校验阶段不重叠（`hasTierOverlap`） |
| amount_tier_max | numeric(10,2) NULL | 新系统独立 | admin UI 表单录入（不含端，NULL=∞） | commission.ts:L95 | 现状 4/15 行非 NULL，全部 `5000.00`；NULL 通过 `coalesce(crm.amount_tier_max IS NULL, ∞)` 在 SQL 中表达 |
| commission_rate | numeric(5,4) NOT NULL | 新系统独立 | admin UI 表单录入，区间 [0,1] | commission.ts:L96 | 现状值集 `{0.0500, 0.0600, 0.0800, 0.1000, 0.1200, 0.1500}` |
| created_at | timestamp NOT NULL | 默认值/NULL | `defaultNow()` | schema:L26 | 4 个 distinct 时间点 |
| updated_at | timestamp NOT NULL | 默认值/NULL | `defaultNow()` + `$onUpdate(() => new Date())` | schema:L27 | 乐观锁键（`updateRate` 携带 `expectedUpdatedAt`，`date_trunc('milliseconds', updated_at) = $prev`） |

### 唯一索引

| 索引名 | 列 | 出处 |
|--------|----|------|
| `uq_commission_matrix` | `(org_id, order_type, role_type, sales_category, amount_tier_min)` | schema:L30-37 + 0000_baseline.sql:L344 |

> 注：`amount_tier_max` **不在唯一键内**——同一 (org, order, role, cat) 下用 `amount_tier_min` 区分多阶段，重叠校验完全在应用层 `hasTierOverlap()`（commission.ts:L203-245）执行，DB 不强约束。

### 历史 schema 漂移（baseline 前后）

| 阶段 | 关键事件 | 影响 |
|------|---------|------|
| baseline 前 archive 0000 | `commission_rate_matrix` 初建（_archive_pre_baseline_2026_04/sql/0000_init_v3_1.sql:L275-350） | 初版列、初版 FK |
| baseline 前 archive 0009 | `order_type`: `sale → 销售单`、`service → 服务单`；`role_type`: `技师` 行复制成 `养生师`、原行 `UPDATE 技师 → 美容师` | 服务单的提成规则从 1 行→2 行（2 角色），数据量翻倍 |
| baseline 前 archive 0010 | `role_type`: `推广 → 推广师`，`DELETE WHERE role_type='顾问'` | 顾问角色完全清除 |
| 2026-04-10 baseline reset | 0000_baseline.sql 重建表结构 | 数据通过 dump 导入而非随 migration 自动回放，archive 翻新效果**已固化在数据**中 |
| baseline 后 0010_fix_commission_matrix_sales_category | `sales_category`: `自采自销 → 自销自耗` 12 行 | 收尾因 `sales_category` 是 varchar 不是 enum、archive 0009/0010 没触达 |

> ⚠️ **关键漏检**：archive 0010 之后又有 1 行 `role_type='推广'` 进入（created_at = 2026-03-13），说明 archive 0010 之后还有过其他写入路径（旧 PG dump 重做？admin 后台早期录入？），现状 1 行 `推广` 是**事故残留**，需在最终迁移前 UPDATE 成 `推广师` 或 DELETE。

---

## WorkFine 端无业务对应实体

本次 readonly probe 已确认 MSSQL 端**完全没有**业务级提成相关数据：

| 探查方式 | 结果 |
|----------|------|
| `INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%commission/rate/percent%'` | 仅命中 19 张 `tb_sys_strategy_*` SaaS 平台级图表/数据策略表，与"提成"完全无关 |
| `sys.extended_properties` 列描述包含 `提成` | **0 行** |
| `sys.extended_properties` 列描述包含 `分成` / `抽成` / `比例` | **0 行** |
| 表级描述包含 `提成` / `分成` | **0 行** |

**结论**：WorkFine 美容院业务侧（UDT_*/UDF_* 命名空间）**没有提成比例配置实体**。商家此前的提成规则极有可能存在于 Excel/口头约定/旧 ERP，并通过 admin 后台一次性补录成本表 15 行。最终迁移脚本对本表**无源可抽**——只能保留 PG 现状或重新由业务侧确认 24 个市场的规则空表。

---

## 关键决策

1. **本表 100% 新系统独立**：WorkFine MSSQL 端无任何业务字段映射，最终迁移脚本不需要 `INSERT ... FROM mssql`，最多保留 admin 录入数据 + 13 行 seed.ts 作为冷启动模板。
2. **覆盖度严重不足**：24 个市场仅 3 个有规则（南昌/九江/Y九江），21 个市场云函数 `getCommissionRates` 返回空时直接抛 `INVALID_PARAMS: 未找到市场 "${marketName}" 的提成配置`（allocation.js:L271-273）——**21 个市场的店长目前完全无法做营业额分配**，业务侧需补齐。
3. **运行时容错策略**：`service.complete` 路径（service.js:L412-435）当 `commission_rate_matrix` 缺规则时 rate=0 + 写 `operation_logs(action='service.commission.missing_rate')`，**不阻塞**服务单完成；`allocation.suggest` 路径在 ratesByRole 无对应角色时取 0（无 commission_amount）。这是设计选择，不是 bug——但意味着提成发放可能因配置不全长期为 0 而不被人察觉。
4. **`推广` vs `推广师` 残留**：archive 0010 重命名后又有 1 行 `推广` 进入。运行时 staffApi `getCommissionRates` 直接将 role_type 当成 `staff_wechat_users.skills[0]` 的等价值（allocation.js:L283-292，依赖完全字符串相等），所以这 1 行**永远命中不到任何员工**。最终迁移前必须清理：`UPDATE commission_rate_matrix SET role_type='推广师' WHERE role_type='推广'`。
5. **`amount_tier_max` 大量 NULL（11/15）**：业务规则上 NULL=∞，但应用层重叠校验 `hasTierOverlap` 把 NULL 当 +∞，DB 不约束——意味着可以同时写入 `[0, NULL)` 和 `[0, 5000)` 两个互相覆盖的行。`hasTierOverlap` 仅校验"同一 (org, order, role, cat) 下区间不重叠"，理论上是覆盖所有，但插入路径会先 `INSERT` 后才依赖 UNIQUE 报错——**多线程并发录入时仍可能产生重叠行**（无 advisory lock 防护）。
6. **乐观锁仅 update 路径**：`updateRate` 用 `WHERE date_trunc('milliseconds', updated_at) = $prev` 做并发保护；`createRate` / `deleteRate` 仅靠唯一键 `23505` 报错回退，无版本号保护。
7. **删除是物理删除**（spec admin.pr.spec.md §AC-07 也明确："物理删除（快照在 sale_allocations）"）：历史 commission_rate 在 sale_allocations 已快照保留 commission_rate 列（详见 01-order 文档），所以本表 DELETE 不影响历史订单提成数据。
8. **spec 文档过时**：backend.pr.spec.md §2.7 列示例 `order_type` 为 `"sale"、"service"` + `role_type` 为 `"技师"、"推广"`，**与 archive 0009 / 0010 + 0010_fix 的实际中文枚举不一致**，需在最终迁移前同步刷新文档。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- 整表 100% 无 WorkFine 数据来源（不是"未覆盖"，是 WF 根本无对应业务实体）
- 24 个市场仅 3 个有规则 → 21 个市场云函数 `getCommissionRates` 直接抛错；最终迁移前必须由业务补齐
- 1 行 `role_type='推广'` 残留（应是 archive 0010 重命名后又被旧 dump 带回）→ 运行时无法命中员工 skills，永远 rate=0
- `amount_tier_max` UNIQUE 不参与，应用层 `hasTierOverlap` 无 advisory lock，多线程并发录入存在生成重叠行的隐患
- spec backend.pr.spec.md §2.7 的 `order_type`/`role_type` 取值与 archive 0009/0010 后实际数据不一致
- `service.commission.missing_rate` 仅写 operation_logs 不告警 → 21 市场长期 rate=0 不会浮出水面，**业务可能无感损失提成发放**
- `getCommissionRates` 通过 `marketName` 字符串 JOIN（allocation.js:L267 `WHERE n.name = $1`），如果 admin 改市场名 `org_nodes.name`，本表行不会随之失效（org_id 是 hashId 派生不会变），但前端按 `currentMarket.name` 查会失败——市场改名是业务侧潜在风险

---

## Review 报告（2026-04-26）

独立调研后再回看本文档，整体血缘骨架准确（schema 列、写入入口、UNIQUE 约束、运行时只读路径、WorkFine 端无对应实体的探查结论），主体可作为最终迁移参考。但若干**事实与时间线**与 5434 现状对不上，需作 minor-fix。

**一致项**（采样自调研对照）：8 项 — schema 9 列定义、commission.ts L89/L156/L182 写入入口、allocation.js L262-269 / L408-415、service.js L401-411 取最高命中阶段逻辑、UNIQUE `uq_commission_matrix` 列组成、seed 13 行规则、PG 总行数 15 / 3 市场覆盖 / 24 总市场 / role 计数（美容师=8, 养生师=6, 推广=1）/ amount_tier_max 非 NULL=4/15、commission_rate 区间 [0.0500, 0.1500]、archive 0009 / 0010 / 0010_fix 翻新效果。

**不一致项**：6 项（minor）。

### 偏差明细

#### A. 错配（5 项，最严重为 action 名错配）

1. **operation_logs action 名写错** — 文档 §写入入口 + 关键决策 #3 + ⚠️未覆盖字段汇总第 6 行 均称 `service.commission.missing_rate`，**实际 service.js:L421 写的是 `service.complete.rate_missing`**（命名空间和字段顺序均不同）。运维 alert 规则若按文档配 grep 关键字会全部漏告警。
2. **created_at 时间点描述错** — 文档 §PG 现状表"created_at distinct"行说"4 个时间点（2026-03-13、**2026-03-14**、2026-03-21 ×2）"。实际 4 个 distinct 时间点是 `2026-03-13T15:48:03 / 2026-03-18T17:10:50 / 2026-03-21T14:45:46 / 2026-03-21T14:46:01`（UTC）。第二批应为 **2026-03-19**（北京时间）/ **2026-03-18**（UTC），不是 03-14。
3. **关键决策 #4「推广 残留来源」时间线错配** — 文档说"archive 0010 重命名后又有 1 行 `推广` 进入"。实际 row id=3（`role_type='推广'`）的 created_at = 2026-03-13T15:48:03.041Z 与同批次另外 6 行**毫秒级同步插入**（id=1..7 共 7 行），明显是同一次 bulk insert，**早于** archive 0010 的 rename 时点；正确解释是"DB 由 dump-restore 加载，archive 0010 的 UPDATE 从未在该 DB 实例上 apply 过"。同步还可佐证：staff_wechat_users 中**所有**含 `推广*` 的员工 skill 都已是 `推广师`（archive 0010 的 staff 部分被另一路径 apply 了），唯独 commission_rate_matrix 的 row id=3 漏更。
4. **关键决策 #5 重叠校验风险描述错** — 文档说"理论上是覆盖所有，但插入路径会先 INSERT 后才依赖 UNIQUE 报错——多线程并发录入时仍可能产生重叠行（无 advisory lock 防护）"。实际 commission.ts:L84 `createRate` 是**先 `hasTierOverlap()` 后 `insert`**（不是反过来），且 hasTierOverlap 已正确处理 NULL（`isNull(amountTierMax) OR existMax > newMin`），单线程下 `[0,NULL)` + `[0, 5000)` 重叠会被检出阻止。真正剩下的并发风险只有 read-then-write 的 TOCTOU 窗口（无 advisory lock 也无事务隔离锁）——这点文档描述方向对但论据"先 INSERT 后报错"事实错。
5. **§列级血缘 amount_tier_min 现状说明** — 文档说"PG 全部 15 行 = `0.00` 或 `5000.00` 两个值"，实际是 `0.00` × 11 + `5000.00` × 4（含 11/4 的具体分布数字应注明，避免读者推论 amount_tier_min 与 tier_max 的对应关系）。

#### B. 过时事实（1 项）

6. **§写入入口"baseline 前 archive 0010 ..."表述** — 文档说该 migration "DELETE WHERE role_type='顾问'"。实际 archive 0010 同时还 `UPDATE staff_wechat_users SET skills = array_replace(skills, '推广', '推广师')`（员工技能同步），这点重要且本表残留 `推广` row 的根因正与之相关，但文档未提，导致读者会误认为只触发了 commission_rate_matrix 单表。

#### C. 缺漏（无 P0，3 项 minor）

7. 列级血缘**未列出索引以外的约束**：`commission_rate_matrix` 当前只有 PK + UNIQUE + 1 个 FK→`org_nodes.id`，没有 CHECK 约束（`commission_rate ∈ [0,1]` / `amount_tier_min ≥ 0` 全无 DB 强约束），这点与文档关键决策 #5 互为补充但未明示。
8. 未提**spec 与 code drift 的 tickets/ 归档线索**：`backend.pr.spec.md §2.7` 至今仍写 `sale/service`、`技师/推广`，文档已识别（关键决策 #8），但未引用既有归档票号（如有）/ 待开归档票号。
9. 未列出**潜在前端入口**：`fengyu-admin/src/app/(main)/commission/page.tsx` 等页面的存在（仅在 admin/CLAUDE.md 有提及"提成矩阵"），文档主体只列 actions/commission.ts，没有页面层路径。

#### D. 数据不一致（无）

PG 抽样数字与文档**完全对得上**（15 / 9-4-2 / 24 / 4-15 / 0.0500-0.1500 / commission.create 3 + commission.delete 1）。唯一对不上的是 created_at 日期（见 A2）。

### Verdict: **minor-fix**

主因：1 项 action 名错配（A1，运维告警链路依赖准确字符串）+ 1 项时间线错配（A3，掩盖了 archive 0010 部分 apply 的真实根因）。其余均不影响最终迁移脚本设计。

**建议改动清单**：
- A1 全文替换 `service.commission.missing_rate` → `service.complete.rate_missing`（3 处）
- A2 `2026-03-14` → `2026-03-19`（北京时间，对应 UTC 03-18T17:10）
- A3 改写关键决策 #4 第二段为"DB 由 dump-restore 加载，archive 0010 在 commission_rate_matrix 上的 UPDATE 漏 apply（但 staff_wechat_users.skills 的 array_replace 已生效，员工端全部使用 `推广师`），导致 row id=3 永远命中不到任何员工"
- A4 关键决策 #5 改"先 INSERT 后 UNIQUE 报错" → "createRate 先 `hasTierOverlap` 后 `insert`，但 read-then-write 无 advisory lock，并发录入存在 TOCTOU 重叠风险"
- A5 §列级血缘 amount_tier_min 行附 `(11×0.00 + 4×5000.00)`
- B6 §写入入口 archive 0010 行末追加 `+ UPDATE staff_wechat_users.skills array_replace(推广→推广师)`
- 可选 C8: 引一行 follow-up — 若需 spec sync，开 `notes/tickets/2026-04-26-commission-spec-drift.md`

---

## Edge Case 报告 R2（2026-04-26）

本轮主动挖文档外的边缘问题，跑了两段 PG 5434 探针 + 一段 MSSQL 反查 UDT_M_217（营业额分配子表 124,682 行），8 个风险维度命中 6 个；blocking 1 个、serious 2 个、minor 3 个。

### 维度 1 — FK 孤立 / 引用完整性

- ✅ **0 行 FK 孤立**：15 行 `org_id` 全部命中 `org_nodes.id`（探针 `LEFT JOIN org_nodes WHERE n.id IS NULL` 空集）
- ✅ **0 行挂在 inactive org**：3 个涉及市场 `is_active = true`
- ✅ **3 个 org_nodes 全部 type='市场'**：未误挂到门店 / 部门 / 总部节点
- ⚠️ **风险点（设计层）**：`commission_rate_matrix.org_id` FK 缺 `ON DELETE` 子句（schema:L14-16 仅 `references(() => orgNodes.id)`，默认 `NO ACTION`），如果业务侧通过 admin 删除一个市场而该市场下还有 commission 规则，DELETE 会被 FK 阻止；admin/org/actions 删除路径需先清规则，否则报 `23503` 丑错给运营。考虑改 `ON DELETE RESTRICT` 显式表达，或在 admin org actions 加级联预清理逻辑。

### 维度 2 — NULL / 空串 / 极值

- ✅ NotNull 全守住：`order_type / role_type / sales_category` 0 行 `NULL` 或 `''`
- ✅ `commission_rate` 区间 `[0.0500, 0.1500]`，无负数无超过 1.0 的（也不需要——numeric(5,4) 上限就是 9.9999）
- ✅ `amount_tier_min` 全部 ≥ 0（min=0.00，max=5000.00），无负数
- ✅ 时间字段全部在 `2026-03-13 ~ 2026-03-21` 区间，无 1900 / 2100 异常
- ⚠️ **`amount_tier_max` 11/15 NULL**（73%），运行时 `COALESCE(amount_tier_max, 9999999999)` 当成 +∞ 处理。**风险**：业务对 NULL 的语义"无上限"是约定俗成，DB 层无 CHECK 约束（无 `CHECK(amount_tier_max IS NULL OR amount_tier_max > amount_tier_min)`），admin UI 表单理论上可写入 `min=5000, max=4000` 这种非法区间，应用层 `hasTierOverlap` 不会检测此点。**建议加 DB CHECK**：`CHECK (amount_tier_max IS NULL OR amount_tier_max > amount_tier_min)` + `CHECK (commission_rate >= 0 AND commission_rate <= 1)` + `CHECK (amount_tier_min >= 0)`。

### 维度 3 — enum 漂移（schema vs 数据 vs 代码）

| 字段 | schema 类型 | 实际取值 | 代码用法 | 漂移 |
|------|-----------|---------|---------|------|
| `order_type` | varchar(20) NOT NULL（无 enum） | `销售单`×13、`服务单`×2 | service.js:L403 写死 `'服务单'` / allocation.js:L413 写死 `'销售单'`；admin commission.ts L17 (orderType) 不约束 | spec.md §2.7 仍写 `'sale'/'service'` 已过时（R1 关键决策 #8） |
| `role_type` | varchar(20) NOT NULL | `美容师`×8、`养生师`×6、`推广`×1 | service.js:L396 取 `staff_wechat_users.skills[0] \|\| '美容师'`；当前员工 skills 实际值为 `美容师`/`养生师`/`推广师`/`管理`/`面部护理`/`经络调理`/`身体护理`/`艾灸`/`皮肤管理` 共 9 类 | **3 类风险**：①`推广` 行死规则（R1 已记录）；②skills 中 `管理`(4)/`面部护理`(3)/`经络调理`(1)/`身体护理`(1)/`艾灸`(1)/`皮肤管理`(1) 共 11 名员工 skills[0] 可能落到这些非标值，service.complete 找不到 commission rate 规则 → 全部 rate=0；③`sale_allocations.role_type` 实测值 `美容师`(132429)/`推广师`(16629)/`养生师`(7657) 三个；`service_commissions.role_type` 实测同上分布。本表 `推广` 那行根本不被任何下游使用 |
| `sales_category` | varchar(20) NOT NULL | `自销自耗`×12、`他销自耗`×3 | service.js:L405 / allocation.js:L429 按字符串等值取 | `sale_items.sales_category` 实测仅 `自销自耗`(208018)/`他销自耗`(1) **2** 类，但 allocation.js:L285-286 默认 4 类 `{自销自耗,他销自耗,他销他耗,生态合作}` 写死在 grouped 里——**`他销他耗`/`生态合作` 是死代码分支**，永远拿不到 rate（详见维度 6） |

### 维度 4 — UNIQUE 约束守住与否

- ✅ **0 行重复**：`(org_id, order_type, role_type, sales_category, amount_tier_min)` 5-tuple distinct
- ✅ **0 行区间重叠**：自连接探针 `a.amount_tier_min < COALESCE(b.amount_tier_max,∞) AND b.amount_tier_min < COALESCE(a.amount_tier_max,∞)` 空集
- ⚠️ **应用层 hasTierOverlap 是 read-then-write 无锁**（commission.ts:L83-103），并发调 `createRate` 仍可能擦肩；DB UNIQUE 不含 `amount_tier_max`，无法兜底重叠。**P2**

### 维度 5 — 跨模块一致性 ⚠️ **本轮最大发现**

`role_type` 三套集合对照：

| 来源 | 取值 | 备注 |
|------|------|------|
| `commission_rate_matrix.role_type`（15 行） | `美容师`(8)、`养生师`(6)、`推广`(1) | **`推广` 死规则**；缺 `推广师` |
| `sale_allocations.role_type`（156715 行 is_void=false） | `美容师`(132429)、`推广师`(16629)、`养生师`(7657) | 全部 3 类规范名 |
| `service_commissions.role_type`（616210 行 is_void=false） | `美容师`(569543)、`养生师`(45507)、`推广师`(1160) | 全部 3 类规范名 |
| `staff_wechat_users.skills` UNNEST | `美容师`(647)、`推广师`(200)、`养生师`(113)、**`管理`(4)、`面部护理`(3)、`经络调理`(1)、`身体护理`(1)、`艾灸`(1)、`皮肤管理`(1)** | **9 类**，含 6 个非"角色"专长（**P0**） |

**漏洞 1（serious）**：`staff_wechat_users.skills` 含 `管理 / 面部护理 / 经络调理 / 身体护理 / 艾灸 / 皮肤管理` 共 11 名员工。当 `service.complete` 调 `roleType = skills[0] || '美容师'`，如果某员工 skills=`['管理','美容师']`，roleType 会取到 `'管理'`，commission_rate_matrix 必查不到，rate=0。**核心 bug**：service.js:L396 取 `skills[0]` 是不正确的，应取 `skills` 中**与提成矩阵 role_type 集合的交集**第一项。

**漏洞 2（minor）**：`sale_allocations` 用了 `推广师`(16629 行) 但 `commission_rate_matrix` 只有 `推广` 那 1 行——意味着南昌市场 16629 笔销售单的推广师角色全部走 rate=0（allocation.suggest 命中不到）；不过 `suggest` 是分配建议工具，不阻塞，但产品体验下来就是"南昌推广师全部建议为 0 提成"。

**漏洞 3（design）**：MSSQL `UDT_M_217` 历史营业额分配 124,682 行覆盖 **25+ 角色**（代理经理/督导/实习经理/美容师/养生师/推广员/售前导师/推广部主管/门店副经理/美艺首席/养生老师/中级美艺老师/综合项目导师/初级美艺老师/门店经理/高级操作老师/美容学员/初级操作老师/中级操作老师/养生主管/养生副主管/高级美艺老师/美艺老师/售前经理 等），新系统强行只用 3 类规范名（美容师/养生师/推广师），**信息有损耗**。如果业务侧需要按"代理经理 / 督导 / 实习经理"等粒度计提（这些都是历史真实在用），新系统当前矩阵无能为力——这是产品设计层面的口径压缩，不是技术 bug，但需 PM 确认是否接受。

### 维度 6 — 死代码 / 永不命中分支

- 🔴 **`合作生态` / `他销他耗` 永不命中**：allocation.js:L285-286 / L426 在 `orderRates` / `serviceRates` 默认初始化 `{自销自耗:0, 他销自耗:0, 他销他耗:0, 生态合作:0}` 4 个键。但实际 `sale_items.sales_category` 只有 `自销自耗`/`他销自耗` 2 个值（208018/1），`commission_rate_matrix` 也只这 2 个值。**`他销他耗` / `生态合作` 是死分支**，前端 UI 可能展示却永不接收非零数据。建议从代码删除以减少 noise，或在 sales_category 加 enum 约束限定 2 值。
- 🔴 **`commission_rate_matrix.role_type='推广'` (id=3) 死规则**：R1 已识别；本轮在 `staff_wechat_users.skills` 全表 0 行包含 `'推广'`（仅 `'推广师'`），重证此规则永不被命中；`sale_allocations.role_type` 也无 `'推广'`。
- ✅ schema 9 列全部被代码引用（无 schema 死列）
- ✅ `commission.ts` 4 个导出函数（`getMarkets / getRates / createRate / updateRate / deleteRate`）全部在 admin/(main)/commission/page.tsx 间接引用（之前 R1 §C9 也提及）

### 维度 7 — dump-restore 残留 / drift

- 🔴 **`role_type='推广'` row id=3** 是 archive 0010 的 UPDATE 在 5434 这一实例上漏 apply 的残留（R1 已识别为时间线错配但未给最终修复 SQL）。修复 SQL（一次性，幂等）：
  ```sql
  UPDATE commission_rate_matrix SET role_type='推广师' WHERE role_type='推广';
  -- 注意：这会触发 UNIQUE (org_id, order_type, role_type, sales_category, amount_tier_min)
  --   但当前 6707cc8b88579108 / 销售单 / 推广(师)/ 自销自耗 / 0.00 仅此 1 行，UPDATE 安全
  ```
- ✅ archive 0009 的 `sale → 销售单` / `service → 服务单` 已生效（grep 全表 0 行英文）
- ✅ archive 0010_fix 的 `自采自销 → 自销自耗` 已生效
- ✅ `pg_attribute` 0 行 `attisdropped=true`（不像 sale_orders 表那样有 ghost 列）
- ⚠️ **operation_logs 0 行 `service.complete.rate_missing`**：实测整张 service_commissions 表 616,210 行 100% rate>0（无 `rate_zero`），意味着自上线以来从未触发过该告警分支——**要么矩阵覆盖足够，要么 commission rate 从未取到 0**。然而 21 个市场无规则、`他销他耗`/`生态合作` 死分支理论上必触发——更可能是历史回填脚本（migrate-service-records.js / backfill-service-commissions-roletype.js）**绕过了 staffApi service.complete**，直接用其他 rate 默认值导入了 service_commissions，这条路径未经 commission_rate_matrix 校验。**P1：需审计 backfill-service-commissions-roletype.js 的 rate 来源**。

### 维度 8 — 运行时安全

- ✅ **SQL 注入**：admin commission.ts 全部用 Drizzle ORM 链式 + 占位；staffApi allocation.js / service.js 均用 `pg.query(sql, [params])` 参数化
- ⚠️ **多步写无事务**：`commission.ts:createRate` (`SELECT hasTierOverlap` + `INSERT`) 不在事务里、无 advisory lock；`updateRate` 用乐观锁 `WHERE updated_at = $prev` 但 `hasTierOverlap` SELECT 与 UPDATE 之间也无锁。**TOCTOU 窗口存在**，单店多管理员并发录入 P3
- ⚠️ **缺索引**：当前仅 PK + 1 UNIQUE 索引。`getCommissionRates` 通过 `JOIN org_nodes ON n.id = crm.org_id WHERE n.name = $1` 查询 — `org_nodes(name)` 无索引（pg_indexes 0 命中），15 行 + 24 市场规模下走 Seq Scan 是 OK 的，但 R1 没提到**`commission_rate_matrix(org_id, order_type)` 的过滤索引**也欠缺；运行时 `service.complete` 按 `(order_type='服务单', role_type, sales_category)` 过滤无索引（Seq Scan，cost 1.36），15 行规模无影响，但补齐 24 市场后会 200~500 行，依然 Seq Scan 不影响（业务 SLA 无虞）。**P3，可不优化**

### Verdict: **serious-edge-cases**

主因：
1. **维度 5 漏洞 1**（service.js:L396 `roleType = skills[0]` 取值不约束在 commission 矩阵 role_type 集合内 → 11 名员工 skills[0] 可能落到 `管理`/`面部护理` 等非标值 → silent rate=0）— **serious**
2. **维度 6** `他销他耗 / 生态合作` 死分支 + **维度 5 漏洞 2** 南昌市场推广师 16629 笔销售 0 提成建议 — **serious**
3. **维度 2** 缺 DB CHECK 约束 + **维度 7** `推广` 死规则待清 + **维度 1** FK 缺 ON DELETE 显式语义 — **minor**

8 维度命中：✅✅⚠️✅🔴🔴🔴⚠️ 命中 6 个（FK 设计风险 / NULL CHECK 缺失 / enum 漂移 / 跨模块不一致 / 死分支 / drift 残留）。

---

## 字段扩展建议 R2（2026-04-26）

R1 结论"100% 新系统独立，WF 无对应实体"在本轮**重判后部分修正**：MSSQL `UDT_M_217`（124,682 行 × 70,899 distinct RID 营业额分配子表）虽不直接映射 `commission_rate_matrix`，但承载了**历史角色 × 部门 × 员工号 × 5 类金额字段**的全部分配快照——可反推合理的提成率矩阵作为**冷启动数据源**。R1 的"无源可抽"应改为"无 1:1 字段映射，但有反向衍生路径"。

### 字段候选清单

#### P0 — 必加

**1. `position_name` varchar(50) NULL — 职位名（取代 role_type 单字段，保留历史 25+ 角色粒度）**

- WF 源：`UDT_M_217.UDF_M_418`（"代理经理 / 督导 / 实习经理 / 美容师 / 养生师 / 推广员 / 售前导师 / 推广部主管 / 美艺首席 / 养生老师 / 综合项目导师 / 美容学员 …"等 30+ 值）
- 业务理由：当前 `role_type` 只 3 类强归一，**信息有损**。MSSQL 历史 25+ 角色覆盖：管理层（代理经理/督导/实习经理/门店经理/门店副经理）+ 操作层（美容师/养生师/养生老师/美艺首席/中级美艺老师 等）+ 业务层（推广员/推广部主管/售前导师/美容顾问）。如果 PM 只做"美容师/养生师/推广师" 3 类**消耗提成**就够，那不必加；但如果要做"店长 / 督导 / 售前导师"等管理层激励（激励池抽分），现有矩阵无法表达。
- 抽取式：`SELECT DISTINCT UDF_M_418 FROM UDT_M_217 WHERE UDF_M_418 IS NOT NULL AND UDF_M_418 != ''` 列举 → admin 端做下拉；历史 RID 70,899 笔反推时直接 INSERT
- 数据量：30+ distinct 值 × 24 市场 × 多区间 → 上千行
- 优先级：**P0**（产品决策点：角色粒度是否压缩到 3 类）
- 依赖：先与 PM 确认是否扩展角色粒度；admin UI commission/page.tsx 加 position_name 字段；如保留则可在矩阵 role_type 演化为"角色大类（美容师/养生师/推广师）+ position_name（细分）"两级

**2. `department_name` varchar(50) NULL — 部门名（让矩阵按部门分轴而非按 role_type 分轴）**

- WF 源：`UDT_M_217.UDF_M_13713 / UDF_M_13714`（"美容部 008 / 推广部 007 / 养生部 011 / 品项部 009 / 售前部 010 / 财智部 006"等 5 主部门 + 5 边缘部门）
- 业务理由：当前 `role_type` 与 `department` 的关系是 1:N（美容师角色横跨美容部 / 养生部门），但 commission_rate_matrix 没有 department 维度——**无法表达"同一角色在不同部门提成不同"** 的业务规则。MSSQL 的 4 个金额字段 (UDF_M_420/421/422/423) **正好对应 4 个部门的"业绩归属"**（同一服务单按部门切金额，不同部门分得提成）。当前 PG 把这 4 维度强行归并成 `sales_category`（自销自耗 / 他销自耗），表达力下降。
- 抽取式：`SELECT UDF_M_13713 AS dept, UDF_M_13714 AS code, COUNT(*) FROM UDT_M_217 GROUP BY UDF_M_13713, UDF_M_13714`
- 数据量：6-10 distinct 值
- 优先级：**P0**（产品决策点）
- 依赖：与 #1 联动决策；如果保持当前 `sales_category` 4 值不变（自销自耗/他销自耗/他销他耗/生态合作），那 department_name 也算冗余；但 sales_category 并非"部门"而是"销售口径"——口径与部门是正交概念，建议加新维度

**3. `commission_kind` varchar(20) NULL — 提成类型（手工费 / 消耗 / 业绩 / 充值 / 退款）**

- WF 源：通过 `UDT_M_217.UDF_M_420 vs UDF_M_421 vs UDF_M_422 vs UDF_M_423` 四金额字段语义反推（每行只有一个非零，互斥；总和 = UDF_M_13715）
- 业务理由：当前 `commission_rate` 单字段无法区分"手工费率 vs 消耗率 vs 业绩率"。`service-commission.ts` schema 已实质区分 `fixed_fee + consume_amount`（双字段模型），但**比例矩阵单表只存 commission_rate 一个口径**，导致 fixed_fee 无率可查（强制业务侧把手工费独立配置在另外的字段——目前是 `sale_items.service_fee` 直接存绝对额，不存比例）。`UDT_M_217` 每行金额值已经是**完整提成额**（不是销售额 × rate），这意味着 WorkFine 历史走的是"按业绩切金额"模型而非"按率乘销售"模型——这是新旧系统的根本模型差异。
- 抽取式：从 UDT_M_217 反推每个 (角色, 部门) 组合下 4 类金额的占比，再除以同 RID 下父订单总额，计算等效 rate
- 数据量：每个矩阵格新增 4-5 行（按 commission_kind 分轴）
- 优先级：**P0**（决定系统能否落地"业绩切金额 + 比例切提成"双模并行）
- 依赖：需 PM 确认提成模型走"率乘"还是"金额切"还是混合

#### P1 — 应加

**4. `effective_from` / `effective_to` timestamp NULL — 规则生效期**

- WF 源：无（WF 端无规则表）
- 业务理由：当前 `commission_rate_matrix` 无版本/时效字段——一旦 admin 改率，旧订单的提成发放规则瞬时变化（虽然历史 sale_allocations 已经快照 commission_rate，但 service_commissions 的扣减比例也是按当前规则取）。**典型场景**：年中调薪时，5 月 1 日生效新率，需要 4 月 30 日订单按旧率计提。
- 抽取式：手工录入；历史 `commission_rate_matrix` 全部置 `effective_from = '2020-01-01', effective_to = NULL`
- 数据量：每行加 2 列；查询 SQL 加 `AND effective_from <= NOW() AND (effective_to IS NULL OR effective_to > NOW())`
- 优先级：**P1**
- 依赖：service.complete / allocation.suggest SQL 加时效过滤；admin UI 加生效期表单字段

**5. `created_by_employee_id` / `updated_by_employee_id` varchar(30) NULL — 操作人审计**

- WF 源：无
- 业务理由：当前矩阵无操作人字段，operation_logs 通过 logOperation 间接记录，但当前 admin/commission.ts:L105 / L170 `logOperation` 调用只记录 target = orgId / id，没记录 operator 在表里——审计追溯需 join logs 表。加列后查询直接 `SELECT * FROM commission_rate_matrix WHERE updated_by_employee_id = ...` 无需 JOIN
- 抽取式：admin/commission.ts createRate / updateRate 从 session.employeeId 写入
- 数据量：2 列 NULL，新增数据自然填充
- 优先级：**P1**（审计运营需求）
- 依赖：admin actions 改写

**6. `notes` text NULL — 规则备注**

- WF 源：无
- 业务理由：admin UI 录入新规则时，业务侧常希望写"为什么这样设"（如 "2026-04 集团激励调整 / 总裁特批"），目前没字段可存，运营把备注写在 operation_logs.detail jsonb 里不易查
- 优先级：**P1**
- 依赖：admin UI form 加 textarea

**7. `is_active` boolean NOT NULL DEFAULT true — 软删标记**

- WF 源：无
- 业务理由：当前 `deleteRate` 物理删除（admin/commission.ts:L182），sale_allocations 已快照保留 commission_rate 列，但任何"为什么这条规则不见了"的追溯都要查 operation_logs。改软删后规则历史完整可见。
- 优先级：**P1**
- 依赖：deleteRate 改 `UPDATE SET is_active=false`；getRates / 命中 SQL 加 `WHERE is_active=true`

#### P2 — 可加

**8. `min_qualifying_amount` numeric(10,2) NULL — 起算门槛**

- WF 源：无明确字段；可从 UDT_M_217 反推 "某角色月累计销售 < 起算门槛则不计提" 的隐含规则（需 SQL 聚合分析）
- 业务理由：很多商家规则是"月销低于 5000 不计提"，目前矩阵不能表达
- 优先级：**P2**

**9. `max_cap_amount` numeric(10,2) NULL — 单单提成封顶**

- WF 源：UDT_M_217.UDF_M_13715 max=50000，疑似有封顶
- 业务理由：防止单笔大订单提成失控
- 优先级：**P2**

**10. `priority` int DEFAULT 0 — 多规则优先级（解决重叠歧义）**

- WF 源：无
- 业务理由：当前 hasTierOverlap 完全禁止重叠，但业务可能希望"店长指定 vs 默认 vs 阶段 fallback"分级
- 优先级：**P2**

#### P3 — 不加（无源 / 价值低）

**11. ~~`commission_amount_absolute` numeric — 绝对额提成（部分行不走比例）~~** — 当前 `service-commissions.fixed_fee` 已扛此责，本表不需要重复

**12. ~~`role_path` text — 多角色组合（"主美 + 副美"）~~** — 业务模型暂不需要

### 字段扩展统计

| 优先级 | 字段数 | 名称 |
|--------|-------|------|
| P0 | 3 | position_name / department_name / commission_kind |
| P1 | 4 | effective_from + effective_to / created_by + updated_by / notes / is_active |
| P2 | 3 | min_qualifying_amount / max_cap_amount / priority |
| P3 | 2 | commission_amount_absolute / role_path（建议放弃） |
| **总候选** | **12** | **P0=3 / P1=4 / P2=3 / P3=2** |

### 反向衍生迁移脚本（可选）

如 PM 决定 P0 #1/#2/#3 全加，可从 UDT_M_217 124,682 行反推冷启动矩阵：

```js
// db/scripts/derive-commission-matrix-from-udf-m-217.js（新建，一次性）
// 1. 按 (UDF_M_418 角色, UDF_M_13713 部门) 分组聚合 5 类金额
// 2. 每组对照同 RID 主单营业额计算等效 rate（amount / parent_total）
// 3. 按金额阶段分位（0~2000 / 2000~5000 / 5000~∞）拟合 3 阶段矩阵
// 4. INSERT INTO commission_rate_matrix VALUES (org_id, '销售单', position_name, department_name, commission_kind='业绩', tier_min, tier_max, fitted_rate)
// 预估：5 个市场 × 25 角色 × 5 部门 × 3 阶段 ≈ 1875 行（远多于当前 15 行）
```

**重大风险**：UDT_M_217 RID 关联到 UDT_M_213（订单主表），但 71 万 RID 跨 5 个市场未拆分；本反推**必须先确认**每条历史营业额行能否回溯到所属市场——若 UDT_M_213 无 market_id 列，本路径作废。
