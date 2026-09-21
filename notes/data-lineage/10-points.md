# 10 — `points` 模块

**Schema 文件**：`db/schema/points.ts`
**涉及 PG 表**：`point_transactions`（唯一现存表）
**WorkFine 源表**：⚠️ **完全无对应实体**（MSSQL probe 确认；详见下文「WorkFine 探源结果」）
**主要写入入口**：
- `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts`（生日积分）
- `fengyu-admin/src/cron/steps/grant-thanksgiving-benefits.ts`（感恩日积分）
- `fengyu-admin/src/cron/steps/refresh-member-levels.ts`（等级升级奖励）
- `fengyu-client/cloudfunctions/payNotify/points.js`（消费赠送 / 消费冲销，订单链净额差值法）
- `fengyu-client/cloudfunctions/clientApi/utils/points.js`（同上，被 order 路由 require）
- `fengyu-staff/cloudfunctions/staffApi/utils/points.js`（同上，被 order/service 路由 require）

> 注意：README.md 表格列出的 `customer_points` 表已在 archive `0016_sync_to_current.sql:L36-38` `DROP TABLE customer_points CASCADE` 物理删除（baseline 之前），余额由 archive `manual-applied/0011_merge_customer_points_into_client_users.sql` 一次性 UPDATE 进 `client_wechat_users.points_balance` + `points_updated_at`（属于 03-user 模块的字段，不在本模块二次记录）。本文档只覆盖 `point_transactions` 一张表。

---

## 表 1：`point_transactions`

**当前行数**（PG 5434，2026-04-26 探查）：`SELECT COUNT(*) FROM point_transactions` = **0**
**WorkFine 源行数**：N/A（WorkFine 端无积分概念）
**导入脚本**：⚠️ **零**（migrate-* / sync-workfine.js / backfill-* 全部不写 point_transactions）

> **PG 5434 现状关键事实**：
> - `point_transactions` 0 行（流水表完全空）
> - `client_wechat_users.points_balance > 0` 用户数 = 0（58803 行全部 0）
> - `client_wechat_users.points_updated_at IS NOT NULL` 行数 = 0
> - 余额一致性校验（STEP 5 SQL）`mismatch_users` = 0
>
> 推断：① archive 0011 合并 `customer_points → points_balance` 时旧表本身可能就 0 行（dev 期未运行积分发放）；② 自 baseline reset 后正式运行尚未触发任何 cron-worker / 消费赠送路径写入；③ migrate-* 脚本（订单/服务/卡）也都没回填消费赠送积分。本表当前**零数据**，最终迁移可保留为空，仅迁运行时逻辑（5 个写入入口的代码副本）。

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial | 新系统独立 | DB autoincrement | schema:L14 | 主键自增 |
| user_id | text | 新系统独立 | `client_wechat_users.user_id` FK | schema:L15-17 | 6 个写入入口都写当前发放对象 |
| type | text | 新系统独立 | 自由文本（非枚举），按入口硬编码：`'生日积分'` / `'感恩回馈'` / `'等级升级奖励'` / `'消费赠送'` / `'消费冲销'` | grant-birthday-benefits.ts:L126 + grant-thanksgiving-benefits.ts:L142 + refresh-member-levels.ts:L252 + utils/points.js:L70 | schema 默认 `'获取'`（archive 0016:L57-58 设为 text+default 之前是枚举），但实际所有写入路径都显式传 type，default 永远命中不到 |
| amount | integer | 新系统独立 | 入口分别写：`config.points`（cron 三 STEP）/ `delta = expected - granted`（消费赠送，可正可负） | 同上 | 决策 D3：不允许负余额（`expected = floor(max(0, netSettled)/100)`），但 delta 本身允许负值（消费冲销） |
| ref_order_id | varchar(30) | 新系统独立 | 消费链：`originalSaleOrderId`（原销售单 id）；cron 三 STEP：硬编码 NULL | utils/points.js:L74 + grant-*.ts:L126/142/252 | FK → sale_orders.sale_order_id；`ref_sale_order_id`（派生单关联回原单的字段）由调用方算好后再传入 |
| external_ref | text | 新系统独立 | 仅 cron 三 STEP 写入：① 生日 `birthday-pts-{YYYY}-{userId}` ② 感恩 `thx-pts-{YYYY-MM}-{userId}` ③ 升级 `member-upgrade-{userId}-{toLevel}`；消费链 4 个副本**全部 NULL**（依赖 `ref_order_id` 自然去重） | grant-birthday-benefits.ts:L122 + grant-thanksgiving-benefits.ts:L138 + refresh-member-levels.ts:L234 + utils/points.js:L72 | UNIQUE INDEX `uq_point_txns_external_ref` WHERE external_ref IS NOT NULL（schema:L29-31）；3 套幂等键策略，消费链不参与幂等约束 |
| created_at | timestamp | 新系统独立 | 入口全部写 `NOW()` | 所有 INSERT 入口 | schema 默认 `defaultNow()`，写入也显式 `NOW()` |

### 关键决策

1. **整表 100% 新系统独立**：MSSQL probe 列描述含"积分/会员积分"0 行 + 列名含 `point/score/credit/积分` 仅命中 4 个 SaaS 平台无关列（`tb_sys_dataspec_score`/`tb_sys_identity_user_token` 等）+ 表名/描述含"积分" 0 行。WorkFine 完全无积分实体，最终迁移**对本表无源可抽**，留空即可。

2. **2 套幂等机制并存**：
   - **cron 三 STEP**：用 `external_ref` UNIQUE 索引 + `ON CONFLICT DO NOTHING RETURNING id` —— RETURNING 空表示冲突，**不再 UPDATE points_balance**（grant-birthday-benefits.ts:L130-137；refresh-member-levels.ts:L256-263；grant-thanksgiving-benefits.ts:L146-153）。
   - **消费链 3 副本（client/staff/payNotify utils/points.js）**：用"链净额 - 已发"差值法 `delta = expected - granted`，`delta=0` 时直接 return 不写流水，天然幂等。`grantedRes` 通过 `WHERE ref_order_id = $1` 聚合，未走 external_ref 通道，因此**消费链积分 external_ref 永远 NULL**。

3. **余额缓存 vs 流水权威源**：
   - 流水（`point_transactions`）是权威源（schema 注释：「积分流水（权威源）」）。
   - 余额（`client_wechat_users.points_balance`）是缓存，由 INSERT 流水成功的同一事务内 `UPDATE points_balance = points_balance + amount` 维护。
   - STEP 5（`audit-points-balance.ts`）每天巡检 `points_balance` ≠ `SUM(amount)` 的用户，**仅告警不修复**（决策 D7：自动修补会掩盖上游 bug）。退化路径：若巡检发现偏差，必须人工查清楚来源后手工修。

4. **type 自由文本**：`type` 是 text 而非 enum（archive 0016:L57 把它从 enum 改成 text + default `'获取'`）。已知 5 个取值（见 admin/actions/points.ts:L14 注释）：`'生日积分'`、`'感恩回馈'`、`'等级升级奖励'`、`'消费赠送'`、`'消费冲销'`。admin 列表页通过 `selectDistinct(type)` 动态拉下拉（actions/points.ts:L164）。最终迁移如要严格化，可改成 enum，但需要先固化所有取值集。

5. **消费链发放仅限"销售单"**：`ORDER_TYPES_EARN_POINTS = new Set(['销售单'])`（utils/points.js:L13）。内部单/回款单/转换单/退款单都不是"原始发放点"，它们引用的原销售单才发；派生单触发时调用方应传 `ref_sale_order_id` 给 `settlePointsForOrder`。

6. **三处副本必须同步**：`fengyu-client/cloudfunctions/clientApi/utils/points.js` + `fengyu-staff/cloudfunctions/staffApi/utils/points.js` + `fengyu-client/cloudfunctions/payNotify/points.js` 三份字节级一致（注释明确"任一处修改后必须同步另两端"），云函数独立部署单元跨目录 require 不可行才平铺。最终迁移如重写积分逻辑必须三端同步改。

### WorkFine 探源结果（无源）

通过 MSSQL 只读探查（read-only `sys.extended_properties` + `sys.tables` + `sys.columns`），结论：

- **列描述含"积分/会员积分/积分余额/奖励分/points"**：0 行
- **列名含 `point/score/credit/积分`**：4 行，全部与积分业务无关（`tb_sys_dataspec_score.score_type` 是 SaaS 平台数据评分类型；`tb_sys_identity_user_token.end_point`、`tb_sys_sms_provider.endpoint` 是接口端点；`tb_sys_workflow_activity.is_back_appoint` 是工作流回退标识）
- **表名/描述含"积分"**：0 行

最终迁移脚本对本模块**完全无 WorkFine 来源可抽**，等同 08-commission（`commission_rate_matrix`）和 09-coupon（券模板/实例）的"100% 新系统独立"分类。

### 已被脚本读但未对接到 PG 的 WorkFine 列

无（WorkFine 完全无积分相关字段；migrate-* / sync-workfine.js 无任何代码读取或写入 point_transactions）。

### ⚠️ 运行时漂移与潜在风险（非血缘问题，记入待核）

- ⚠️ **PG 5434 现状 0 行**（point_transactions + 全部 points_balance=0）：表明 baseline reset 后 cron-worker 在 5434 一次都没成功跑过 STEP 2/3/4，且消费链入口（payNotify/clientApi/staffApi）也未真实触发过。需运维侧核实：① cron-worker 是否实际部署 + 启动；② `system_configs` 的 `birthday_benefits` / `thanksgiving_benefits` / `member_level_benefits` 是否有有效配置；③ 是否所有真实生产订单都 < 100 元（floor(amount/100) = 0）—— 但 sale_orders 现状 142811 行，全部 0 不合理。**疑似消费链路径未实际接通**或 `POINTS_ACCRUAL_ENABLED=false` feature flag 全局禁用。
- ⚠️ `points_updated_at` 与 `point_transactions.created_at` 一致性：消费链 4 个副本 + cron 三 STEP 都在同一事务内 UPDATE `points_balance + points_updated_at = NOW()`，理论一致；但巡检 SQL（audit-points-balance.ts）只比 SUM(amount) vs points_balance，不比时间戳，时间戳偏差不会触发告警。
- ⚠️ **cron 升级三件套与消费冲销的余额方向**：`refresh-member-levels.ts` 升级时只 INSERT 正 amount + 加 balance，但降级时（`processDowngrade`）**不 INSERT 反向流水也不减 balance**——降级仅清 `member_level_locked_until`、改 `member_level`。如顾客先升后降再升，`external_ref = member-upgrade-{userId}-{toLevel}` 命中冲突 RETURNING 空 → 第二次升级**不重发积分**。属设计决策（同档不复发），但若业务侧期望"二次升级要补发"则属 bug。
- ⚠️ `refunds.ts:L398-414` 计算"已享用积分价值"用 `external_ref = 'member-upgrade-{userId}-{toLevel}'` 精准查升级奖励，再用 `WHERE amount < 0 AND created_at >= upgradedAtThreshold` FIFO 近似归属升级以来已消耗积分。`min(grantedPoints, usedPointsSince)` 避免高估，但若顾客升级后既消耗了消费赠送积分又消耗了升级奖励积分，FIFO 把"消费赠送被消耗的部分"错算成"升级奖励被消耗"，**会高估 usedUpgradePoints → 高估 suggestedOverdraftDeduction**（refunds.ts:L417-424）。
- ⚠️ `point_transactions` 无 `updated_at` 列（流水表设计）：admin 列表页 `orderBy(desc(createdAt))` 排序（actions/points.ts:L149，注释「例外：积分流水型表无 updatedAt 列」），与项目"配置/档案型 desc(updatedAt)"默认排序约定不同。

---

## 关键决策摘要

1. **整表 100% 新系统独立**，与 08/09 同类。最终迁移脚本无 WorkFine 数据源，**留空白即可**；只需保证 5 个运行时入口的 INSERT 语义保留。
2. **PG 5434 当前 0 行**是关键事实——本模块所有运行时路径在 baseline reset 后都还没实际跑通。最终迁移前需验收：① `cron-worker --once` 在生产能否成功 + 写出流水；② 消费链是否真接进 sale_order create/pay/confirm 路径；③ `POINTS_ACCRUAL_ENABLED` feature flag 是否被误关。
3. **`customer_points` 表已物理删除**（archive 0016 + 0011-manual），余额迁至 `client_wechat_users.points_balance`（属 03-user 模块）；本文档不重复跟踪。
4. **`type` 列从 enum 退化为 text**：archive 0016:L57-58 显式 ALTER。最终迁移需评估是否回归 enum——5 个已知值（生日积分/感恩回馈/等级升级奖励/消费赠送/消费冲销），若稳定可改回，否则保持 text + 应用层校验。
5. **3 套幂等机制**：cron 用 external_ref UNIQUE，消费链用 ref_order_id 差值法，余额缓存用 SQL 事务原子性。最终迁移如重写需保持这 3 套之间的边界（不要混用 external_ref 与 ref_order_id 的语义）。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- `point_transactions` 全表 0 行 — 不是字段未覆盖，是**全表零数据**，最终迁移可留空但需运维验收 cron + 消费链入口是否真实运行
- WorkFine 完全无积分实体（已确认无源），无 gap 字段需补
- `client_wechat_users.points_balance / points_updated_at` 均 0 / NULL — 跨模块影响（03-user 模块 gap 也应记录）
- `point_transactions.type` 是 text 不是 enum，最终迁移可考虑收紧
- `refunds.ts` FIFO 归属升级奖励消耗算法与"消费赠送先入先出"假设可能冲突，导致高估 suggestedOverdraftDeduction

---

## Review 报告（2026-04-26）

**复核方法**：独立 5 步流程（schema/grep/MSSQL probe/PG probe/独立结论）后再对照本文档。

### 一致项（22 处全部复核命中）

- `point_transactions` 列结构（7 列：id/user_id/type/amount/ref_order_id/created_at/external_ref）— PG `information_schema.columns` 完全一致
- 行数 0 / cwu 58803 / cwuBalGt0 0 / cwuUpdatedNotNull 0 / saleOrders 142811 — PG 5434 现状全部命中
- 索引清单（pkey + idx_point_txns_user_id + uq_point_txns_external_ref WHERE NOT NULL）— PG `pg_indexes` 完全一致
- `customer_points` 表已 DROP — `information_schema.tables` 0 行确认
- `operation_logs` 中 `points.%` 0 行 — 与"baseline reset 后从未触发任何告警"内部推断自洽
- 5 个 type 值（`生日积分`/`感恩回馈`/`等级升级奖励`/`消费赠送`/`消费冲销`）来源行号全部能回查
- 3 套幂等键设计（cron external_ref / 消费链差值法 / 余额事务原子性）—— 代码完全验证
- archive `0011_merge_customer_points_into_client_users.sql` UPDATE points_balance 来源逻辑命中
- `archive/0016_sync_to_current.sql:L36-38` DROP customer_points + `0016:L57-58` ALTER type SET text DEFAULT '获取' 命中
- `archive/0006_wonderful_earthquake.sql:L5+L7` 添加 `external_ref` 列 + `uq_point_txns_external_ref` 唯一索引（**注意：是当前 baseline 的 `0006`，不是 archive；本文档未提此 migration 但事实链清楚**）
- 3 处副本边界（client utils + staff utils + payNotify root）—— 文件树命中
- `ORDER_TYPES_EARN_POINTS = new Set(['销售单'])` 决策 D1 完全验证
- `refunds.ts:L398-414` FIFO 归属算法行号准确

### 不一致项（4 类共 4 条）

#### 缺漏（1 条 / 信息性）
- L41 列级血缘表的"出处"列引用 `utils/points.js:L72` 表示"消费链副本 external_ref 全部 NULL"，但实际**消费链 INSERT 语句的字段列表中根本不写 `external_ref`**（INSERT 只写 5 列：user_id/type/amount/ref_order_id/created_at），而非"显式写 NULL"。出处行号 L72 落在 INSERT 内但语义略有偏差。建议改为 `utils/points.js:L60-63`（INSERT 字段清单未含 external_ref）。

#### 错配（2 条 / 数字自相矛盾）
1. **副本数量自相矛盾**：L41 + L80 写 "消费链 **4** 个副本"，但 L50 + L61 写 "消费链 **3** 副本" / "三处副本"。事实正确数 = **3**（client/staff/payNotify）。L41/L80 系笔误。
2. **写入入口数量自相矛盾**：表头列出 6 个写入入口（3 个 cron STEP + 3 个 utils 副本），但 L30 + L90 写 "**5** 个写入入口" / "**5** 个运行时入口"。如把 3 个 utils 副本视为同一逻辑则 = 4 个独立入口（3 cron + 1 消费链逻辑），如视为独立部署单元 = 6。"5" 无论如何不成立。

#### 数据不一致（0 条）
PG 量化指标全部命中。

#### 过时事实（1 条 / 行号轻微偏差）
- L41 中 "schema:L29-31" 准确 ✓；但同行 "grant-birthday-benefits.ts:L126/142/252" 把三个文件不同行号串联表述容易误读：实际 `birthday-benefits.ts` 的 `'生日积分'` 在 L126，`thanksgiving-benefits.ts` 的 `'感恩回馈'` 在 L142，`refresh-member-levels.ts` 的 `'等级升级奖励'` 在 L252，三者本身正确，但语法上 ":L126/142/252" 会让读者以为是同一文件多个行号。建议拆开标注。

### MSSQL Probe 状态

⚠️ MSSQL 探查未能完成（`SD` 账号密码已过期；同时尝试 `admin` 账号密码错误，连接拒绝）。本文档之前的 MSSQL probe 结论"WorkFine 完全无积分实体"按 schema/字段名/中文描述模式分析具有**强先验合理性**（Workfine 是工作流 SaaS，无积分原生概念），且与"该模块零行数据"一致。本次未能独立复现该 probe，仅作"未独立验证但合理"标记。如需严格收尾，应等 MSSQL 凭据更新后重跑 probe。

### Verdict: **minor-fix**

主要文档结构、列血缘、决策摘要、PG 现状、archive 演化路径全部正确；问题集中在两处数字自相矛盾（4 vs 3 副本、5 vs 6 入口），属编辑期遗漏。无 P0，无 _gaps.md 顶部章节需求。修复方式：在原文 4 处把数字统一为 "3 副本" / "6 写入入口（其中 3 副本字节级一致）"。

---

## Edge Case 报告 R2（2026-04-26）

**复核范围**：从 8 类风险维度独立挖掘文档外的隐藏问题（不限文档边界、发散为先、不防 confirmation bias）。
**探针**：`db/.tmp-probe-r2-10.js` + `.tmp-probe-r2-10b.js`（PG 5434 + MSSQL 双库探）已跑完即删。

### 8 维度命中清单

| # | 维度 | 命中 | 关键发现 |
|---|------|------|---------|
| 1 | FK 孤立 / ON DELETE | ✅ 干净 | `LEFT JOIN client_wechat_users user_id IS NULL` = 0；`LEFT JOIN sale_orders ref_order_id` = 0；表 0 行天然不可能孤立 |
| 2 | NULL / 空串 / 极值 | ✅ 干净 | `null_amount`/`empty_type` = 0；`min_amt/max_amt`/`zero/neg/huge` 全 NULL（0 行）；`created_at` OOB = 0；`points_balance < 0` = 0 行（表设计目标"不允许负余额"已守） |
| 3 | enum 漂移 | ⚠️ 设计层 | `type` 是 text + default `'获取'`（archive 0016 ALTER）；distinct_types **0 个值**（无现役数据）→ 既无漂移也无对照基线，最终迁移收紧到 enum 时**只能信仰式锁定 5 个理论值**，无法用历史数据反推可能漏列 |
| 4 | unique 守住 | ✅ 干净 | `external_ref_duplicates` = 0；唯一索引 `uq_point_txns_external_ref WHERE NOT NULL` 健在；表结构 + 索引列出 3 项均存在 |
| 5 | 跨模块一致性 | 🔴 严重 | balance_mismatch_users = 0（数学上一致，因为两边都全 0）；但 49,072 销售单 `paid_amount ≥ 100` + `client_user_id NOT NULL` **应** 产出 ≥49072 条 `'消费赠送'` 流水 — 实际 0 条；`member_level_upgraded_at` 1 行存在 → 应触发 1 条 `'等级升级奖励'` 流水 — 实际 0 条；运行时三链路彻底失效 |
| 6 | 死代码 / 永不命中 | 🔴 严重 | `type='获取'` default 0 命中（symptom，非问题）；**5 类写入路径全部 0 产出**（birthday/thanksgiving/member_upgrade/consume_grant/consume_offset 全 0）；`points.settleFailed` 操作日志 0 行 → `settlePointsSafe` 一次都没执行过（不是被 catch 吞错，而是上层根本没调用，或调用时 `POINTS_ACCRUAL_ENABLED=false` 短路）；`type` 自由文本字段一旦 baseline reset 后真实运行起来，distinctTypes 下拉只能动态拉到运行时实际产出过的值，**前 1-2 周 admin 列表筛选下拉是空** |
| 7 | dump-restore drift | ✅ 干净 | `customer_points` 表 `to_regclass` = NULL（已物理 DROP）；orphan idx 0 个；orphan view 0 个；archive 0016 + 0011-manual 路径完全收敛 |
| 8 | 运行时安全 | ⚠️ 中等 | 5 个写入入口（cron 三 STEP + 3 副本 utils）全部用 Drizzle `sql\`...\`` 模板字面量或 `pg.query` 参数化（$1, $2），**无 SQL 注入位点**；事务边界 OK（cron 路径单 STEP `db.transaction`，消费链路径调用方在自己的 tx 里调 `settlePointsForOrder`）；但 **`settlePointsSafe` catch 之后的 INSERT operation_logs 也包在主事务 client 里**（`utils/points.js:L94-104` `await client.query('INSERT ... operation_logs ...')`），如果主事务因前序操作已 abort 掉，error log 这一步也会失败、被外层 catch 吞掉 → "失败也不留痕" |

### 高危发现（按 verdict 严重度排序）

#### 🔴 高危 #1：消费链积分**正式运行 0 命中**（决策面 / 运维 / 设计三方共失）
- **现象**：5434 累计 `point_transactions` 0 行；`sale_orders` 142,811 行（含 75,269 销售单已付款 + 49,072 销售单 `paid_amount ≥ 100` + 75,264 销售单含 `client_user_id`）；按 `floor(paid_amount/100)` 应至少产出 49,072 条 `'消费赠送'` 流水
- **影响**：
  - 顾客积分余额永远为 0 → 客户端 `points.balance` API 返回 0 → 顾客感知"无积分系统"
  - `member_level` 升档逻辑滚动 12 月消费额 SQL 仍能跑（不依赖积分），但**升档时三件套权益里的"积分赠送"100% 失效**
  - 管理后台 `/points` 页面永远空 + admin `distinctTypes` 下拉永远为空数组
- **根因候选**（按可能性降序）：
  1. **migrate-* 历史回填脚本**（订单/服务/卡）确认未补发积分（10-points.md L22 已标），所有 142,811 行历史订单是 batch import 进来的，积分流水从未补发
  2. 真实生产 wxpay/alipay webhook 自 2026-04-10 baseline reset 后**未触发过任何成功支付**（payNotify 没有 `points.settleFailed` 也没有 `'消费赠送'`，说明 settlePointsSafe 函数本身没执行过）
  3. `POINTS_ACCRUAL_ENABLED=false` 环境变量被部署侧默认禁用（云函数环境变量看不到）
  4. cron-worker 容器是否启动 / STEP 2/3/4 是否被 cron 触发未知
- **修复**：
  - A 立即 `tcb fn invokefunction --name payNotify` 用真实订单 id 跑一次 dry-run，看是否报错或被 `feature-flag-disabled` 短路（保留 console.log 现场）
  - B 立即 `docker exec fengyu-cron-worker node --conditions=react-server cron-worker.mjs --once` 看 STEP 5 audit 输出
  - C 写一次性补偿脚本 `db/scripts/backfill-points-from-orders.js` — 扫描 `sale_orders WHERE sale_order_type='销售单' AND paid_amount > 0 AND client_user_id IS NOT NULL` 调 `settlePointsForOrder` 历史回填（基于差值法天然幂等 + 大量不会重复入账）

#### 🔴 高危 #2：派生单 `ref_sale_order_id` **6 行全部 NULL**，链净额计算依据缺失
- **现象**：5434 现状 `回款单`/`转换单`/`退款单`/`内部单` 共 6 行（4 转换 + 2 内部），**全部 `ref_sale_order_id IS NULL`**
- **影响**：`settlePointsForOrder` (clientApi/staffApi/payNotify utils) `SELECT SUM(paid_amount) WHERE sale_order_id=$1 OR ref_sale_order_id=$1` — 派生单上溯链路靠 `ref_sale_order_id`；现状 6 行无 ref，链净额永远=该原销售单自己 paid_amount → 派生单触发 settle 时**取不到原单上下文**直接 `return { skipped: 'order-not-found' }`（如果传的就是派生单 sale_order_id）
- **根因**：上游创建派生单（admin `actions/refunds.ts` / staff `routes/order.js` 退款分支）应该写 `ref_sale_order_id`，但当前 6 行都没填 → 上游 SQL 缺列；migrate-* 脚本对历史派生单也未回填 ref
- **修复**：
  - A schema 层加 `CHECK (sale_order_type = '销售单' OR ref_sale_order_id IS NOT NULL)`
  - B 一次性回填 SQL 把现有 6 行 ref 关联到原单（人工核对 — 现存量小可手工）
  - C 全量回填后 cron-worker 加 STEP `audit-derived-orders-without-ref`

#### 🟠 中危 #1：`type` 自由文本无 enum 守门、无 CHECK 约束、无校验层
- **现象**：archive 0016 把 type 从 enum 退化为 text + default `'获取'`；5 个写入入口全靠**字符串硬编码**（`'生日积分'`、`'感恩回馈'` 等）；admin 列表 `selectDistinct(type)` 动态拉下拉
- **风险**：
  - 任意一个写入入口 typo（`'消费冲销'` 写成 `'消费冲消'`）→ 流水照写、admin 下拉多一条新值、refunds.ts FIFO 算法仍按 `amount<0` 全聚合**无副作用**——但**新人重写积分逻辑时不知道命名约定**就可能引入"消费抵扣"等同义词
  - schema default `'获取'` 永远命中不到，但反过来如果有人手工 `INSERT INTO point_transactions (user_id, amount) VALUES (...)` 不传 type，就会写一条 type='获取' 的流水**与 5 个已知值脱节**，admin 列表筛选会出现不可识别的"获取"项
- **修复**：
  - A schema 层加 `CHECK (type IN ('生日积分','感恩回馈','等级升级奖励','消费赠送','消费冲销'))` 或回归 enum
  - B 删除 `default '获取'`（永远命中不到的 default 是"假语义" debt）
  - C admin/cloudfunctions/utils 加导出常量 `POINT_TXN_TYPES`，所有 INSERT 强制引用常量

#### 🟠 中危 #2：`refunds.ts` FIFO 归属"升级以来已用积分"按 `amount<0 AND created_at >= upgradedAtThreshold` 聚合，**会把"消费冲销"也算成"升级奖励消耗"**
- **现象**：`refunds.ts:L406-413` 算 `usedPointsSince = SUM(-amount) WHERE amount < 0 AND created_at >= upgradedAtThreshold` —— 这里 `amount<0` 包括 ① 顾客主动用积分抵扣（如果将来开放）② 退款触发的 `'消费冲销'`（已是 amount<0）；`usedUpgradePoints = min(grantedPoints, usedPointsSince)`
- **场景**：顾客升级 → 销售单 1000 元（积分=10）→ 退款（点 stat ≤ 0 触发 `'消费冲销' amount=-10`）→ admin 跌档计算时把这 10 算成"升级奖励消耗" → suggestedOverdraftDeduction 高估
- **现状**：当前 0 行流水 → 0 错算；但放量后只要发生过 `'消费冲销'`+随后跌档，就会触发
- **修复**：refunds.ts SQL 加 `AND type NOT IN ('消费冲销')` 过滤；或更严谨：`AND type IN ('用户消费', '主动抵扣')` 白名单（但目前还无主动抵扣功能，先排除冲销即可）

#### 🟠 中危 #3：`settlePointsSafe` 内 `INSERT operation_logs` 共享主事务 client，**主事务 abort 时 error log 也丢失**
- **位置**：`utils/points.js:L94-104`（3 副本一致）
- **现象**：`catch (err)` 后 `client.query('INSERT INTO operation_logs ...')` 在同一个 pg client（即同一事务），如果上层 `await client.query('UPDATE ...')` 已经因约束失败让事务进入 abort 状态，再 INSERT operation_logs 会抛 `current transaction is aborted`
- **影响**：`points.settleFailed` 永远不会被记录、外层 try/catch 静默吞掉 → 排查现场缺失
- **修复**：用独立连接（payNotify 已有 pool，可拿独立 client）写 `points.settleFailed`，与主事务解耦

### MSSQL 重判结论（R1 已结论，本轮 fresh probe 复测）

5 维 MSSQL 探查（列描述/列名/表名/会员等级/赠回馈语义）独立复现 R1 verdict：

- 列描述含"积分/奖励分/积分余额/会员积分" — **0 行**（unchanged）
- 列名含 `point/score/credit/积分/奖励` — 4 行，全是 SaaS 平台无关字段（`tb_sys_*`）（unchanged）
- 表名含 `point/score/credit` 或描述含 `积分/奖励/level` — 1 行 `tb_sys_dataspec_score`（数据规约评分配置，与会员积分无关）
- 会员等级语义 — 2 行 `field_level`（数据字段层级，非 VIP 等级）
- 赠送/权益/回馈/感恩语义 — **0 行**

**结论维持：WorkFine 完全无积分实体可抽**。与 09-coupon 的"`UDT_S_209` 反推顾客级历史现金券"机会不同——10-points 没有任何代理列可重建积分历史。最终迁移**对本表无源可抽**保持 R1 结论。

### Verdict: **serious-edge-cases**

R1 的 minor-fix 仅限于"文档与代码自身的数字自相矛盾"，本轮聚焦运行时风险后**升级为 serious**：

- 🔴 高危 #1（消费链 0 命中 + 49,072 销售单理论应发积分但 0 流水） — 业务功能性 bug，blocking
- 🔴 高危 #2（派生单 `ref_sale_order_id` 6 行全 NULL） — 上游 SQL 缺列、设计层不变量缺失
- 🟠 中危 #1/#2/#3 — 设计 + 应用层共 3 处可改进项

最终迁移建议优先级：**先修高危 #1 + #2，否则积分模块的最终迁移做了等于没做**（迁移空表 + 留 5 个不被调用的入口，业务侧用户感知不到任何积分）。

---

## 字段扩展建议 R2（2026-04-26）

**前提**：R1 已确认"WF 完全无积分实体"，本轮 MSSQL fresh probe 复现该结论（见上）。WF 端无任何代理字段可反推积分流水或余额。所有扩展候选均**新系统独立**，不依赖 WF。

| # | 字段 | 优先级 | 类型 / 默认 | 业务理由 | WF 源 | 抽取式 | 数据量影响 | 依赖 |
|---|------|--------|-------------|---------|-------|--------|-----------|------|
| **P0.1** | `point_transactions.type` 收紧为 enum | **P0** | enum 5 值 | 中危 #1：text 自由文本无校验，typo 风险 + admin 下拉空白；5 个值已稳定（archive 0016 改 text 之前就是 enum） | 无 | N/A | 0 行 → 转换零成本 | migration 仅 `ALTER TYPE` + `CHECK` 加 enum；无应用层修改（5 入口已硬编码常量） |
| **P0.2** | `point_transactions.balance_after` integer NOT NULL | **P0** | 写入时累计余额 | 流水 + 余额双源真相缺失：审计层（admin 列表）只能算"当前 SUM"不能复现"该笔写入时余额"，跌档退款 refunds.ts FIFO 算法也只能用 ts 近似；行级缓存余额便于审计 | 无 | INSERT 时 `LAG(SUM(amount)) OVER (PARTITION BY user_id ORDER BY created_at) + amount` | 0 行不需回填；新写入路径要在 5 副本同步加 `balance_after = (SELECT COALESCE(MAX(balance_after),0) FROM ...) + amount` | 5 写入入口三副本同步改 + audit-points-balance.ts 第二道闸门验 `balance_after = SUM(amount until createdAt)` |
| **P1.1** | `point_transactions.ref_sale_item_id` text | P1 | 关联到 sale_items 行级 | 高危 #2 的延伸：消费赠送目前只关 sale_orders，无法对"销售单内某商品退款"精确冲销；卡分录退款时一笔 sale_order 含多个 sale_item，目前的链净额算法**整单算**，不区分到 item 级 | 无 | 调用方 `settlePointsForOrder(client, originalSaleOrderId, saleItemId?)` | 0 行 → 0 回填；新写入路径补字段 | utils/points.js 三副本签名加 saleItemId 可选；refunds.ts FIFO 算法升级到 item 级 |
| **P1.2** | `point_transactions.idempotency_key` text + UNIQUE | P1 | 与 external_ref 互补 | 现状 `external_ref` UNIQUE 仅 cron 三 STEP 用，消费链靠 `ref_order_id 差值法` 隐式幂等；如需将来增加"积分商城兑换"或"主动抵扣"路径，无统一幂等键 | 无 | 调用方按业务自定义 (e.g. `manual-grant-{adminId}-{createdAt}`) | 0 行 → 0 回填 | schema 加列 + 唯一索引 WHERE NOT NULL；与 external_ref 并列（external_ref 偏"业务键"，idempotency_key 偏"调用键"） |
| **P1.3** | `point_transactions.granted_by_employee_id` text FK | P1 | admin 手工调整流水（如客服补/扣积分）需要溯源 | 现 5 个写入入口都是系统自动，未来 admin 加"手工调整"按钮（按 09-coupon 已有 issueCoupon 模式）必须记录操作人 | 无 | admin action 拿 `session.userId` 写 | 0 行 → 0 回填 | admin action `manualAdjustPoints`（暂未实现） + UI 入口 |
| **P1.4** | `point_transactions.note` text | P1 | 审计补充说明 | type 收紧 enum 后，"消费赠送"分类下不同子原因（如优惠券抵扣后的净额、用户用余额抵扣后净额）需要文字描述 | 无 | 写入方按业务填 | 0 行 → 0 回填 | 写入方非空校验由应用层而非 DB |
| **P2.1** | `point_transactions.expire_at` timestamp | P2 | 积分过期机制（行业惯例：积分 1-2 年过期） | 当前积分**永不过期**（schema 无任何过期字段、cron 无任何 sweep STEP）；放量后历史积分滚动累积、客单价计算 ROI 失真；行业惯例从赠送日起 1-2 年过期 | 无 | 写入时 `created_at + INTERVAL '1 year'` | 0 行 → 0 回填；新增 cron STEP `expire-points` 每日扫 expire_at < NOW() 写 `'积分过期' amount=-X` 流水（同时减 balance） | 新 cron STEP + 业务方决策（过期周期/规则） |
| **P2.2** | `point_transactions.amount_yuan_value` numeric(10,2) | P2 | 行级冗余"等价人民币" | 现状 admin refunds.ts `pointRate = system_configs.points_to_yuan_rate`（默认 0.01）算"已用积分价值"，但配置变更时历史流水回看不准；写入时快照价值便于审计 | 无 | 写入时 `amount * (SELECT value FROM system_configs WHERE key='points_to_yuan_rate')` | 0 行 → 0 回填 | 5 写入入口同步加；admin actions/settings.ts 已有 `getPointsToYuanRate` 可复用 |
| **P2.3** | `client_wechat_users.points_lifetime_earned` integer + `points_lifetime_spent` integer | P2 | 顾客等级模型补强 | 现 `points_balance` 是当前余额；分析顾客忠诚度需"累计赚的"和"累计花的"——可由 SUM 实时算但放量后耗时；缓存到 cwu 与 `total_spend_cache` 同档次 | 无 | cron `audit-points-balance.ts` 第二步顺手维护 | 0 行 → 0 回填；cron STEP 5 升级 | 与 03-user 的 customer_status / total_spend_cache 同维护方式 |
| **P2.4** | `point_transactions.source` enum('cron','clientApi','staffApi','payNotify','admin') | P2 | 写入路径来源标记 | 现状 6 入口写流水时 type 区分了"业务原因"但**不区分"调用入口"**；故障排查时 admin 列表无法过滤"哪个入口发的"；与 operation_logs.source 平行 | 无 | 写入时硬编码 | 0 行 → 0 回填 | 5 入口同步改 + admin 列表加筛选 |

### 候选总结

- **总计 10 个候选字段**（P0×2 / P1×4 / P2×4）
- **P0**：2 个（enum 收紧 + balance_after 行级缓存） — 都是**修内功**，不增加业务复杂度，最终迁移强烈建议带上
- **P1**：4 个（item 级关联 + idempotency_key + granted_by + note） — 业务深化时按需加
- **P2**：4 个（过期 + 元价值 + lifetime 累计 + source 标记） — 长期演进，依赖业务决策

无 P3（"放弃"档）—— 因为 WF 完全无源，所有候选都是**新系统独立设计**，不存在"WF 有但抽不出"的失败候选。
