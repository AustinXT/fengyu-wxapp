# 14 — `service-commission` 模块

**Schema 文件**：`db/schema/service-commission.ts`
**涉及 PG 表**：`service_commissions`（仅 1 张）
**WorkFine 源表**：
- `UDT_S_259` 售后护理单主表（255,943 行 INNER JOIN UDT_M_260；2025-2026 共 366,857 行 → 仅 fee>0 的 298,725 行有提成意义）
- `UDT_M_260` 售后护理明细（856,791 行总；fee>0 行 659,342；其中员工 NULL 行 272；2024 及更早 360,517 行 fee>0 **未导入**）
- `UDT_S_762` 售前护理单主表 + `UDT_M_763` 售前护理明细（109,365 行；fee>0 仅 97 行 ≈ 0.09%，事实上不产生提成）

**主要写入入口**：
- `db/scripts/migrate-service-records.js:L289-298` — 售后历史导入 INSERT service_commissions（**唯一在 PG 5434 实际产出 616,210 行的脚本**）
- `db/scripts/migrate-presale-services.js:L388-394` — 售前历史导入 INSERT service_commissions（实际产出 ≈ 0 行，因 UDT_M_763 fee>0 仅 97 行且 sale_item_id 关联多数会被 saleItemIds set 过滤）
- `db/scripts/backfill-service-commissions-roletype.js` — 一次性回填 role_type（双 SQL：`staff_wechat_users.skills[1]` + 兜底 `'美容师'`，注意是 skills[1] 不是 skills[0]）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0015_svc_comm_role_alloc.sql` — ADD COLUMN role_type / allocation_ratio
- `db/migrations/_archive_pre_baseline_2026_04/sql/0018_green_rogue.sql:L17-19` — ADD COLUMN fixed_fee/consume_amount + 数据回填 `UPDATE fixed_fee = commission_amount WHERE fixed_fee = 0 AND commission_amount > 0`（**关键**：把所有历史行的 commission_amount 整体当作 fixed_fee，consume_amount 留 0）
- `db/migrations/0016_grey_the_renegades.sql:L2` — `ALTER COLUMN role_type SET NOT NULL`（在 backfill 完成后执行）
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js:L388-450` — **运行时唯一入口**（service.complete）：双字段计算（fixed_fee + consume_amount）、查 commission_rate_matrix（order_type='服务单'）、ON CONFLICT DO NOTHING

> sync-workfine.js **不操作 service_commissions**（grep 已确认）。clientApi 与 payNotify 中也无任何 INSERT。

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 维度 | 值 | 备注 |
|------|----|----|
| 总行数 | 616,210 | 全部 `service_item_id LIKE 'SVCI-HLD-%'`（migrate-service-records.js 唯一入口） |
| `is_void = TRUE` | 0 | 没有作废操作 |
| `role_type IS NULL` | 0 | backfill-service-commissions-roletype.js 已清零 |
| `allocation_ratio IS NULL` | 616,210 | **100%** — migrate 脚本不写此列；运行时 service.complete 写 1.00 但 0 行产出 |
| `fixed_fee = 0` | 0 | archive 0018 把全部 commission_amount 兜底回填到 fixed_fee |
| `consume_amount = 0` | 616,210 | **100%** — archive 0018 把 consume_amount 留 0 |
| `consume_amount > 0` | 0 | **运行时 service.complete 路径 0 行产出**（与 12/messages、10/points 同源问题） |
| `commission_rate = 0` | 0 | rate ∈ [0.01, 9.9999]，distinct=141 |
| 创建时间窗口 | 2026-03-15 07:14 ~ 21:06 | 全部集中在 14 小时（migrate-service-records.js 单次跑） |
| `commission_amount` SUM | ¥84,127,139.13 | 含 22M / 11M / 9.9M 三笔脏数据（见下） |
| `commission_amount` MAX | ¥22,864,061.73 | **WorkFine 端脏数据**：sess_used=99,769、unit_price=229.17、fee=22M（HLD-2409280171，员工 FY-230918001 王倩） |
| role_type=`美容师` | 569,543 | 92.4% |
| role_type=`养生师` | 45,507 | 7.4% |
| role_type=`推广师` | 1,160 | 0.2% |

> **关键反差**：仅 service.complete 一处运行时入口完整支持双字段模型（fixed_fee + consume_amount + allocation_ratio + 矩阵 commission_rate），但 PG 实际 616,210 行 100% 来自 migrate 脚本（不查矩阵、不拆双字段、不写 allocation_ratio）；与生产业务真实意图存在结构性偏差。

---

## 表 1：`service_commissions`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial | 新系统独立 | DB autoincrement | schema:L19 | |
| service_item_id | text (FK→service_items) | WorkFine 派生 | `'SVCI-' \|\| UDT_S_259.UDF_S_821 \|\| '-' \|\| UDT_M_260.OBYID` | migrate-service-records.js:L140, L257, L293 | 与 05/service_items.service_item_id 派生算法一致 |
| employee_id | varchar(30) (FK→staff_wechat_users) | WorkFine 直拷 | `RTRIM(UDT_M_260.UDF_M_2472)` | migrate-service-records.js:L78, L284 | service.complete 路径用员工档案 staff.employee_id |
| role_type | varchar(20) NOT NULL | WorkFine 派生 + 二次回填 | ① migrate 脚本写入：`staff_wechat_users.skills[0] \|\| '美容师'`；② migration 0016 SET NOT NULL；③ baseline reset 后 role_type 全表 NULL（baseline reset 前的回填值丢失或 ALTER 路径漏迁），用 `backfill-service-commissions-roletype.js` 二次回填，**逻辑改为 `staff_wechat_users.skills[1] \|\| '美容师'`**（注意是 [1] 而非 migrate 脚本的 [0]） | migrate-service-records.js:L168 + backfill:L60 + migration 0016:L2 | ⚠️ **数据派生路径不一致**：migrate 取 `skills[0]`，backfill 取 `skills[1]`；存量行 role_type 实际由 backfill SQL2 兜底覆盖（PG 仅 3 个值美容师/养生师/推广师，与 service.complete 路径一致）。如果原 migrate 写过 skills[0] 真值，baseline reset 是否清除了那批数据待核实 |
| allocation_ratio | numeric(5,2) | ⚠️ 未覆盖 | migrate 脚本不写（INSERT 列清单仅 6 列：service_item_id, employee_id, role_type, commission_rate, commission_amount, is_void）；运行时 service.complete:L438 写硬编码 `1.00` | migrate-service-records.js:L292 + service.js:L438 | **PG 现状 616,210/616,210 行 NULL**；运行时本应拆"多员工分配"，目前所有运行时入口固定 1.00，**多员工拆分语义未启用** |
| commission_rate | numeric(5,4) NOT NULL | WorkFine 派生（migrate 链）/ 矩阵查询（runtime） | ① migrate 脚本：`Math.min(9.9999, Math.round((service_fee / unit_real_price) × 10000) / 10000)`；当 unit_price = 0 时回退 `1.0000`；② runtime service.complete:L401-411：查 `commission_rate_matrix WHERE order_type='服务单' AND role_type AND sales_category AND amount_tier_min ≤ consumeBase ≤ amount_tier_max ORDER BY amount_tier_min DESC LIMIT 1`，无匹配规则时 `0` | migrate-service-records.js:L280-282 + service.js:L401-412 | **两套语义不互通**：migrate 路径下 rate 是"成本/价格的反推比例"，runtime 路径下 rate 是"提成矩阵规则"。PG 现状 distinct=141，min=0.01，max=9.9999（hard cap），avg=1.1445 — 与矩阵语义（一般 0.01~0.30）严重不符，**全部为 migrate 脚本派生** |
| fixed_fee | numeric(10,2) NOT NULL DEFAULT '0' | WorkFine 派生（chained backfill） | ① migrate 脚本不写 fixed_fee（INSERT 列清单无）；② archive 0018:L17-19 一次性 `UPDATE fixed_fee = commission_amount WHERE fixed_fee = 0 AND commission_amount > 0`；③ runtime service.complete:L398, L446：`Math.round(sale_items.service_fee × session_used × 100) / 100` | migrate-service-records.js + 0018:L17-19 + service.js:L398/L446 | PG 现状 100% 行 fixed_fee = commission_amount（archive 0018 把 commission_amount 整体兜底当作 fixed_fee） |
| consume_amount | numeric(10,2) NOT NULL DEFAULT '0' | 默认值/NULL | ① migrate 脚本不写；② archive 0018 ADD COLUMN DEFAULT '0' 但**未回填**；③ runtime service.complete:L399, L413：`Math.round(unit_real_price × session_used × rate × 100) / 100` | service.js:L399/L413 | PG 现状 **100% 行 = 0** — 双字段模型在历史数据中完全不成立，consume_amount 的"消耗提成"语义只能在 runtime 路径下出现（目前 0 行） |
| commission_amount | numeric(10,2) NOT NULL | WorkFine 直拷 | ① migrate 脚本：`UDT_M_260.UDF_M_837 (本次消耗/服务费)` 直接写入 commission_amount；②（设计上）runtime service.complete:L414：`fixed_fee + consume_amount`（合计） | migrate-service-records.js:L284 + service.js:L414 | ⚠️ **migrate 路径下 commission_amount 等于 service_fee，不是真实提成发放金额**；max=22,864,061.73 直接来自 WorkFine UDT_M_260.UDF_M_837 max 值（HLD-2409280171，sess_used=99,769、unit_price=229.17、99,769 × 229.17 = 22,864,061.73 — 业务侧脏数据未做卫语句） |
| is_void | boolean NOT NULL DEFAULT false | 默认值/NULL | 硬编码 `false` | migrate-service-records.js:L284 + service.js:L438 | 软删除标记，PG 现状 0 行 voided |
| created_at | timestamp NOT NULL DEFAULT NOW() | 新系统独立 | `defaultNow()` | schema:L40 | PG 现状 100% 行集中在 2026-03-15 07:14-21:06（migrate 单次跑） |
| updated_at | timestamp NOT NULL DEFAULT NOW() $onUpdate | 新系统独立 | `defaultNow()` + onUpdate；backfill 时 SET `NOW()` | schema:L41 + backfill:L61 | |

### 已被脚本读但未对接到 PG 的 WorkFine 列

| WorkFine 列 | 含义 | 现状 |
|-------------|------|------|
| `UDT_M_260.UDF_M_838` 员工职位 | 美容师/督导/养生学徒等文本职位 | ⚠️ 脚本未读；MSSQL 抽样显示与 `staff_wechat_users.skills` / `position_name` 部分重合但更细粒度（如"督导"对应 skills 不一定有）。如果未来要重建 `role_type` 真实值，UDF_M_838 比 skills[0]/[1] 更准 |
| `UDT_M_260.UDF_M_2473` 职位序列编码 | 第一职位/第二职位（与 sale_allocations.UDF_M_2315 对应） | 未对接，与 sale_allocations 是同一套职位编码体系 |
| `UDT_M_260.UDF_M_839` 员工姓名 | 服务美容师姓名 | 脚本读了但未写入提成行（仅参与 service_items 流程） |
| `UDT_M_260.UDF_M_836` 划卡次数 | 本次消耗次数（service_items.session_used） | 脚本读了但未在 service_commissions 任何字段使用（runtime 用 sale_items.service_fee × session_used） |
| `UDT_M_260.UDF_M_6869` 单次价格 | 单次服务价格 | 脚本读了仅用于 `commission_rate = service_fee / unit_real_price` 反推（数学派生），不写入提成行；其本身也未写入 service_items.unit_real_price 之外的位置 |
| `UDT_M_260.UDF_M_6902` 是否赠送 | 17%（143,773/856,791）= "是" | ⚠️ **业务关键**：赠送服务依然产生 service_fee（脏数据 / 赠品也算提成），PG 端无法区分赠送与正常提成，建议加 is_gift 列；与 05/service_items.UDF_M_6902 同样的 gap |
| `UDT_M_260.UDF_M_842` 顾客满意度 | 满意度评价（满意/一般等） | 未对接，**与员工绩效评估强关联**；建议加 satisfaction 列 |
| `UDT_M_260.UDF_M_840` 服务时长 | 99.997% 行 ≤ 300（实际是分钟数） | 在 05/service_items 已对接 service_duration；提成不需要 |
| `UDT_M_260.UDF_M_841` 项目个数 | 项目数量 | 未对接 |
| `UDT_M_260.UDF_M_7007` 可用次数 / `UDF_M_7135` 有效日期 | 卡数与到期 | 未对接 |
| `UDT_M_260.UDF_M_16309` 疗程项目编号 | 售后独有，关联 product_skus | 未对接（与 05/service_items gap 同源） |

### WorkFine 实际承载提成的字段对照

> 以下是真实"提成"语义在 WorkFine 端的字段，**migrate 脚本并未严格按此抽取**：

| WorkFine 字段 | 业务含义 | PG 处理 |
|---------------|----------|--------|
| `UDT_M_260.UDF_M_837` 本次消耗（金额） | 实际服务费金额 | → migrate 直拷为 `service_commissions.commission_amount` 也作为 `fixed_fee` |
| `UDT_M_260.UDF_M_840` 服务时长（分钟） | 时长，非金额 | → 写入 `service_items.service_duration`（分钟，**workfine_database.md L689 标注"金额"是错的**） |
| `UDT_M_260.UDF_M_6869` 单次价格 | 价格基准 | → 仅用于 commission_rate 反推派生 |

实际"提成系数表" / "提成档位规则"在 WorkFine 端**找不到对应实体**（与 08/commission 模块结论一致：probe 结果"提成/分成/抽成/比例"业务字段 0 行）。这就是为什么 migrate 脚本只能用 service_fee/unit_price 反推 commission_rate，且产出 distinct=141 的奇怪比例分布。

---

## 关键决策摘要

1. **migrate 路径与 runtime 路径双字段语义彻底不兼容**：
   - migrate 路径：commission_amount = service_fee = fixed_fee；consume_amount = 0；rate = service_fee / unit_real_price 反推
   - runtime 路径：commission_amount = fixed_fee + consume_amount；fixed_fee = sale_items.service_fee × session_used（完全独立计算）；rate = commission_rate_matrix 矩阵查询
   - PG 现状 100% migrate 路径，runtime 路径 0 行
2. **archive 0018 兜底回填把所有历史 commission_amount 视作 fixed_fee**：明确"消耗提成口径"在历史数据中不可恢复，只能由后续运行时积累。最终迁移如果重做提成计算，需要决定历史数据是否仍走"全部计入 fixed_fee"还是按业务实际拆分（已不可恢复）。
3. **2024 及更早数据完全未导入**：migrate-service-records.js `WHERE YEAR(UDF_S_822) >= 2025` 切片，约 360,000+ 历史 fee>0 行（2023+2024+少量 2022 之前）从未进入 PG。如最终迁移要补回，需要重跑脚本去掉年份限制 + 处理 staff/store/sale_item lookup 跨年问题。
4. **WorkFine 端脏数据未做卫语句**：`sess_used = 99,769` / `999,999` / `100` 这种异常次数被 migrate 脚本无脑承接，导致 PG 出现 22M / 11M / 9.99M 三个超大 commission_amount。最终迁移建议加 `(sess_used BETWEEN 1 AND 100)` 卫语句或在 PG 端清洗。
5. **role_type 派生路径双源不一致**：migrate 写 `skills[0]`、backfill 写 `skills[1]`、runtime（service.complete）写 `skills[0]`、sale_allocations migrate 写 `skills[0]`。PG 现状全表由 backfill 的 `skills[1] || '美容师'` 兜底（baseline reset 后 role_type 全表 NULL 触发 backfill 二次执行）。**最终迁移必须统一为 `skills[0]`**（与生产逻辑对齐），否则 sale_allocations / service_commissions 同员工 role_type 不一致影响绩效统计。
6. **commission_rate 9.9999 hard cap**：脏数据触发 `Math.min(9.9999, ratio)`，PG 现状有大量 rate=9.9999 行（赠送行 fee>0 但 unit_price=0 时强制走 fallback `1.0000`，但 unit_price 极小且 fee 大时会触发 cap）。
7. **runtime 写入 0 行问题（与 12/messages、10/points 同源）**：staffApi.service.complete 在 baseline reset 后没有任何成功写入。需运维侧核实：① service.complete 路径是否被业务调用过；② commission_rate_matrix 21 个市场缺规则会触发 rate=0 但仍 INSERT（不阻塞）；③ 是否所有服务单都在 baseline reset 后还停留在"服务中"状态未 complete。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- ⚠️ `service_commissions.allocation_ratio` 100% NULL（migrate 不写、runtime 固定 1.00 但 0 行产出）— 多员工分配语义在 PG 中完全空缺
- ⚠️ `service_commissions.consume_amount` 100% = 0（archive 0018 不回填）— 双字段模型在历史数据中不成立
- ⚠️ `service_commissions.commission_rate` migrate 路径用 `fee/price` 数学派生（distinct=141、avg=1.14）与 runtime 矩阵查询语义彻底不兼容
- ⚠️ migrate 脚本 `--year>=2025` 硬切片导致 2024 及更早 360,000+ fee>0 行**完全未导入**
- ⚠️ MAX commission_amount=22,864,061.73 / 11,755,596 / 9,999,990 三笔脏数据从 WorkFine 直接传入未做卫语句（sess_used 99,769 / 100 / 999,999 异常）
- ⚠️ role_type 派生路径双源不一致：migrate=skills[0] / backfill=skills[1] / runtime=skills[0]；PG 现状由 backfill skills[1] 兜底
- ⚠️ runtime service.complete 路径在 baseline reset 后 0 行产出（与 12/messages、10/points 同源问题）
- `UDT_M_260.UDF_M_6902` 是否赠送（17% 行）— 赠送服务依然产生提成；PG 端无法区分（与 05/service_items 同 gap）
- `UDT_M_260.UDF_M_842` 顾客满意度 — 与员工绩效评估强关联但未对接
- `UDT_M_260.UDF_M_838` 员工职位 / `UDF_M_2473` 职位序列编码 — 比 staff.skills 更准的角色派生候选源
- `commission_rate_matrix` 21 个市场缺规则会让 runtime 写入 rate=0 + operation_logs.action='service.complete.rate_missing'，业务静默失败

---

## Review 报告（2026-04-26）

**复核方法**：先独立读 `db/schema/service-commission.ts` + `migrate-service-records.js` + `migrate-presale-services.js` + `backfill-service-commissions-roletype.js` + `service.js:L380-450` + `staff.js:L484-526` + `mgmt-dashboard.js:L340-355` + `service-commissions.ts`（admin） + `0018_green_rogue.sql` + `0015_svc_comm_role_alloc.sql` + `0016_grey_the_renegades.sql`，然后用 `.tmp-probe-14.js` 跑 PG 5434 + MSSQL 抽样后再读文档对比。

### 一致项数 / 不一致项数

- 一致项 ≈ 30 项（schema 字段清单、PG 现状大部分量化指标、archive 0018 兜底回填语义、双语义不兼容结论、最高三笔脏数据来源、commission_amount SUM/MAX 精确匹配、role_type 三值分组精确匹配、operation_logs 0 行、9.9999 hard cap 1364 行、rate=1.0000 行 554,721 等）
- 不一致项 = 8 项（详见下表）

### 偏差明细

#### 缺漏

1. **admin Server Action `batchSaveServiceCommissions` 完全漏列**：`fengyu-admin/src/actions/service-commissions.ts:L142-168` 是**第二个运行时写入入口**（先 `UPDATE is_void=true` 作废、再 `INSERT serviceCommissions.values()`，事务内同步 service_orders.commission_status）。文档 L17 仅列 staffApi service.complete 为"运行时唯一入口"——直接漏抓 admin 营业额分配的服务提成保存路径。该路径还会触发 `serviceCommission.batchSave` operation_logs 与 `revalidatePath('/allocations')`。
2. **admin 读取入口 `getServiceOrderCommissions`（actions/service-commissions.ts:L26-61）漏列**：虽然不是写入但是核心读取面，文档"主要写入入口"清单未提到 admin 端读路径与 scope 校验逻辑。
3. **mgmt-dashboard 入口漏列**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:L340-355 queryServiceCommissionIncome` 是文档完全未提的另一个高频读取面，且 WHERE 含 `role_type IN ('美容师','养生师')` 业务规则——推广师 1,160 行的提成在大屏汇总中**被自动剔除**，这个规则文档未捕获。

#### 错配

4. **migrate "2024 及更早 360,517 行 fee>0 完全未导入" 严重失实**（L7、L100、L113 三处反复声明）：PG 5434 实测 service_date 分布 2023:139,654 / 2024:205,311 / 2025:239,107 / 2026:32,133 → 共 **344,965 行 service_date < 2025-01-01 已在 PG**，仅与 MSSQL 360,612 差 ~15,000 行。migrate 脚本默认 `YEAR(UDF_S_822) >= 2025` 与实际数据不符——可能是历史上有过 `--year=2023` / `--year=2024` 多次跑过，或 UDT_S_259/UDT_M_260 RID 关联出了跨年行。该错配会让最终迁移漏估量纲 ~57%，是关键事实错误。
5. **MSSQL UDT_S_259 行数与 fee>0 行数 outdated**：文档 L6-7 写 UDT_S_259=255,943（含 INNER JOIN），实测 630,962 / INNER JOIN UDT_M_260 856,995；fee>0 doc=659,342 实测 659,522；UDT_M_260 fee>0+员工 NULL doc=272 实测 181；2025-2026 doc=366,857 实测 367,069。属一致量级的过时事实但文档语气过于精确，应注明"MSSQL 实例增量更新"。
6. **UDT_M_763 fee 字段名错**：文档 L8 暗示 fee>0 仅 97 行 ≈ 0.09%；本次复核探查 `UDT_M_763.UDF_M_4885` 不存在（Invalid column name）。文档 L7 标注的 "UDT_M_763 fee 字段" 可能是 UDF_M_837 或别的；97 行的来源 SQL 应在脚本里反查（migrate-presale-services.js 实际取 `m.UDF_M_837` 同一字段名作 service_fee 列）。
7. **schema NOT NULL 标注错位**：文档 L54 列级血缘 allocation_ratio 写"numeric(5,2)"未显示 NULL 状态；schema:L29 实际声明就是 nullable，已对齐。但 commission_rate 文档写 "numeric(5,4) NOT NULL"——schema 实测 nullable=NO 正确。无错。

#### 数据不一致

8. **role_type 派生路径自相矛盾**：L53 列级血缘说 "PG 仅 3 个值美容师/养生师/推广师，与 service.complete 路径一致"；L102 关键决策又说 "PG 现状全表由 backfill 的 skills[1] || '美容师' 兜底"。两段对**同一事实**给出两个相反派生源（service.complete=skills[0] vs backfill=skills[1]）。从 backfill 脚本头部注释（"2026-04-25 审计发现：service_commissions.role_type 全表 NULL"）看，2026-04-25 之前 PG role_type 确实全 NULL，所以"全表 backfill skills[1] 兜底"才是事实，"与 service.complete 一致"那句应改为"形态一致但派生源不同"，避免误导。
9. **rate=1.0000 行数信息暗藏未列**：探查显示 rate=1.0000 行 554,721（含 unit_price=0 fallback 和 fee/price=1.0 自然值），占总行 90%；rate=9.9999 1,364 行。文档 L33/L55 仅给 distinct=141 / max=9.9999 / avg=1.1445，未提"90% 行 rate=1.0000"这一关键分布特征，会误导后续分析者以为 rate 分布更均匀。

#### 过时事实

10. **MSSQL 行数 + 2024 数据未导入** 两处过时（已并入"错配 #4 #5"，不重复）。

### Verdict

**minor-fix**

整篇文档的列级血缘 + schema 列定义 + PG 量化指标主体（commission_amount SUM/MAX、role_type 三值分组、9.9999 hard cap、archive 0018 兜底语义、双语义不兼容结论、operation_logs 0 行）全部精确匹配实测；6 项错配中 #4「2024 及更早全未导入」是关键事实错误必须订正，#1「admin batchSaveServiceCommissions 漏列」是关键运行时入口漏列必须补，#3「mgmt-dashboard 推广师剔除规则」是业务规则漏列应补；其余 5 项是 wording / 量级数 / 自相矛盾的小修。无 P0（业务永久失效 / 数据资损 / 越权）问题——业务静默写入 0 行已在文档中明确告警。

---

## Edge Case 报告 R2（2026-04-26）

**复核方法**：先独立读 `db/schema/service-commission.ts` + 4 个写入路径 + 3 个读取路径 + audit-role-type-nulls cron + archive 0018，再用 `.tmp-probe-r2-14*.js` 跑 PG 5434（MSSQL 凭据`SD/Se4Qimoh`已过期，仅依赖 PG 实测 + 已有 R1/_gaps 数据交叉验证），落入 8 类风险维度逐项打分。

### 8 维风险评分

| # | 维度 | 命中 | 关键证据 |
|---|------|------|---------|
| 1 | FK 孤立 | ❌ 干净 | service_item_id/employee_id 双向 0 孤立，间接 service_items→sale_items 也 0 孤立（FK1=0/FK2=0/FK3=0） |
| 2 | NULL/空串/极值 | ⚠️ HIGH | allocation_ratio 100% NULL（616,210/616,210）；consume_amount 100% = 0；fixed_fee=commission_amount 100% 一致但 max=22,864,061.73；3 笔 commission_amount 介于 9.99M~22.86M（sess_used 99,769/100/999,999 等业务侧脏数据来自 WF 直接传入，详见任务 1 #2 极值表） |
| 3 | enum 漂移 | ⚠️ HIGH | role_type ∈ {美容师 569,543 / 养生师 45,507 / 推广师 1,160} 共 3 值；commission_rate_matrix `order_type='服务单'` 实际**只有 2 个 role_type（美容师/养生师）+ 1 个 sales_category（自销自耗）共 2 条规则**；推广师 1,160 行 100% 不在矩阵集合内，运行时会被 silent rate=0；sales_category={`他销他耗`,`生态合作`} 在矩阵中也完全缺失 |
| 4 | unique 守住与否 | ❌ 干净 | uq_svc_comm_item_emp_role 当前 0 dup，svc_item × employee 多 role_type 也 0 行（因 backfill 的 SQL2 兜底覆盖率 100%，所有行 role_type 唯一） |
| 5 | 跨模块一致性 | ⚠️ HIGH | ① fixed_fee=commission_amount 双字段崩 100%（archive 0018 整体兜底）；② 6,616 行 svcComm 与 service_items 的 unit_real_price×session_used 不等（其中 over=2,870 / under=3,746 / unit_price=0 仍有 amt>0 共 874 行），证明历史 service_items.unit_real_price 与 sale_items.service_fee 双源不严格对齐；③ JCLSH-20230620053 单 sale_item 关联 488 行 svcComm（疗程卡多次划次），与 05/service `38,562 sale_items 累计扣次 > session_count` 同源不变量破缺；④ commission_rate_matrix 矩阵覆盖率 1.7% 服务单组合（2 条 / 应有 3 role × N category × 多 market 数百条）；⑤ admin `batchSaveServiceCommissions` 把 commission_status 写 `'已分配'`，PG 现状 commission_status=`'待分配'` 行数 = 607,844（全部历史单未走 admin），3 行 `NULL` 来自 runtime |
| 6 | 死代码 / 永不命中 | ⚠️ HIGH | runtime service.complete 路径 operation_logs 共 3 行（2026-03-11 / 2026-03-21 / 2026-04-23），但**对应的 3 个 service_order 的 service_commissions 0 行**（runtime 路径"调用了但未产生 svcComm"——sale_items.service_fee=0 + sales_category 非自销自耗 + 推广师不在矩阵 三因素任一即触发产出 0 行）；admin batchSaveServiceCommissions operation_logs 0 行；is_void=true 0 行（软删除路径未启用） |
| 7 | dump-restore drift | ⚠️ HIGH | ① 双字段模型 100% 崩（archive 0018 把 commission_amount 整体回填为 fixed_fee，consume_amount 留 0）；② commission_rate 分布 90% rate=1.0000(554,721) / 9.4% rate∈(1, 9.9999)(58,132) / 0.32% rate∈(0,1)(1,993) / 0.22% rate=9.9999(1,364)——整个 rate 分布与"提成矩阵"语义无关，纯 service_fee/unit_price 反推；③ service_date 跨 7 年（2023:139,654 / 2024:205,311 / 2025:239,107 / 2026:32,133 / 2028:2 / 2055:2 / 2099:1），其中 2055/2099 是 WF 端日期录入脏数据；④ allocation_ratio NOT NULL 行 = 0 行（runtime 路径"曾尝试"但 0 行成功），与 archive 0015 ADD COLUMN 后无任何回填的语义 drift 对齐 |
| 8 | 运行时安全 | ⚠️ MED | ① 索引齐：uq_svc_comm_item_emp_role (partial WHERE is_void=false) + idx_svc_comm_employee_id；service_item_id 单列查询无索引（mgmt-dashboard 与 staff.performanceDetail 都按 sale_item_id/employee_id JOIN，未命中 service_item_id 单列）；② SQL 全部参数化（pg `$N` 占位符）+ Drizzle ORM，无注入位点；③ admin batchSaveServiceCommissions 双步 UPDATE+INSERT 在事务内，但**先 UPDATE is_void=true 后 INSERT 没有 advisory lock**——并发同 service_order 双调用可能产生"作废一份 + 插入一份"的脏读窗口（ON CONFLICT DO NOTHING 守 uq 但作废时机暴露）；④ runtime service.complete 路径在 commission_rate_matrix 缺规则（推广师/他销他耗/任意 market）时 silent INSERT rate=0 行，operation_logs.action='service.complete.rate_missing' 设计是好的但当前 0 命中（因为运行时仅 3 次调用且全部命中"美容师/自销自耗"或"零产出"路径）——**21 市场 × 3 角色 × 3 sales_category = 189 组合矩阵规则缺 187 条** |

### 关键 Edge Case 列表（按 P0/P1/P2 分级）

#### E1（P0）：commission_rate_matrix `服务单` 仅 2 条规则覆盖率 1.7%，runtime service.complete 命中"推广师 / 他销他耗 / 生态合作"任一即 silent rate=0

- 实测：`SELECT order_type, role_type, sales_category, COUNT(*) FROM commission_rate_matrix WHERE order_type='服务单' GROUP BY 1,2,3` → 2 行，仅 `美容师/自销自耗/0.12` + `养生师/自销自耗/0.12`；3 个 service.complete 调用对应的 service_orders 一行 svcComm 都没产出
- 业务影响：① 全部 21 市场推广师服务单 100% 提成丢失（runtime 路径）；② 任何 sales_category!='自销自耗' 的服务单 silent rate=0；③ operation_logs.action='service.complete.rate_missing' 触发但 PG 现状 0 行说明历史从未触发（因为历史走 migrate 路径绕过 matrix）；④ 一旦放量，**业务永久无感损失**
- 修复：A 立即补 commission_rate_matrix 至完整 21 市场 × 3 角色 × 3 sales_category；B 长期把 silent INSERT rate=0 改为 throw（业务侧需先确保矩阵齐全）；C 对推广师角色的服务提成业务规则做单独决策（是否应有矩阵规则，还是固定走 sale_allocations 路径）

#### E2（P0）：runtime service.complete 调用 3 次但 svcComm 产出 0 行 — service_fee=0 + 矩阵缺规则双重静默失败

- 实测：`operation_logs WHERE action LIKE 'service.complete%'` 3 行（HLD-WX-2603110001 / FY-FW-2603210001 / FY-FW-2604230001），但 `service_commissions WHERE allocation_ratio IS NOT NULL OR consume_amount > 0` 共 0 行；`service_orders WHERE commission_status IS NULL` 仅 3 行（与 3 个 runtime 调用对齐，commission_status 也未被 service.complete 写过 `'已分配'`）
- 故障路径：service.js:L398 `fixedFee = service_fee × session_used`；若 sale_items.service_fee=0（疗程卡核销场景常见）→ fixedFee=0；同时矩阵缺规则 → rate=0 → consumeAmount=0 → commissionAmount=0；**INSERT service_commissions 仍执行写入 0 元提成行**（service.js:L432-449 不判 commissionAmount>0）；理论上应有 3 个 svcComm 行（每行 commissionAmount=0）但实测 0 行，怀疑 service_items employee_id IS NULL 导致 INSERT 提前抛异常并被外层吞掉
- 业务影响：① runtime 路径事实上 100% 业务失效（迁移完成后投产将立即产生大量"提成丢失"工单）；② commission_status 同步逻辑也漏了——service.js 完成路径写 `'已分配'`，但 commission_status NULL 的 3 行说明 INSERT 提成失败后 service_orders.status 已转 `'已完成'` 但 commission_status 没同步，**形成 commission_status NULL 这种 schema 未定义的状态**
- 修复：A service.js:L394 加 guard `if (!row.employee_id) continue` + 写 operation_logs；B 加单元测试模拟 service_fee=0 + employee_id=NULL 场景；C audit cron 加 `service_orders.status='已完成' AND commission_status NULL` 告警

#### E3（P0）：3 笔脏数据未做卫语句 — sess_used 99,769/100/999,999 致 commission_amount 9.99M~22.86M 直接写入 PG

- 实测：MAX 5 行 svcComm.commission_amount = 22,864,061.73(SVCI-HLD-2409280171-2 / FY-230918001) / 11,755,596.00(unit_price=117,555.96 异常单价) / 9,999,990(unit_price=10 + sess_used=999,999) / 9,998,220(同) / 5,878,159.56(sess_used=999,687)；MAX 22M 反推 99,769×229.17=22,864,053（接近）说明确实是 sess_used 异常值乘出
- 业务影响：① mgmt-dashboard 服务提成 SUM 含 22.86M，3 笔合计 ~50.5M 被算入 84.13M 总额（占 60%！）；② 员工 FY-230918001/FY-250609002/FY-250116001 个人绩效页面历史展示天文数字提成，业务感知必失真；③ archive 0018 兜底回填把脏数据进一步固化（fixed_fee=commission_amount=22M）
- 修复：A 一次性 UPDATE service_commissions SET commission_amount=...(用 sess_used CAP 100 重算) WHERE commission_amount > 1,000,000；B migrate 脚本 L280-282 加 `if (sessionUsed > 100 || sessionUsed < 1) skip` 卫语句；C 业务侧人工复核 11 行 commission_amount > 100k 的真伪并决定是否清洗

#### E4（P1）：mgmt-dashboard 推广师 1,160 行 + 20,700.62 元 silent 剔除（业务规则未对齐）

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:L349` `WHERE sc2.role_type IN ('美容师', '养生师')`
- 实测：visible 615,050 行 / hidden 1,160 行；hidden_amt = 20,700.62 元；涉及 10 名员工
- 业务影响：① 数据看板"服务提成总额"少计 0.025%（金额小但是规则隐藏）；② sale_allocations 表有 127 名员工 distinct 推广师（销售侧），与服务侧 10 名 distinct 推广师严重不对齐——说明推广师角色在销售/服务两个维度业务定义存在割裂
- 修复：A 业务侧明确推广师服务提成口径；B mgmt-dashboard 改 `role_type IN (SELECT role_type FROM commission_rate_matrix WHERE order_type='服务单')` 而非硬编码（矩阵驱动）；C 文档化"推广师不参与服务提成"决策

#### E5（P1）：admin batchSaveServiceCommissions UPDATE+INSERT 双步无 advisory lock，并发双调用脏读窗口

- 位置：`fengyu-admin/src/actions/service-commissions.ts:L142-168`
- 故障路径：① 用户 A 提交分配 → tx.UPDATE is_void=true → 还未 INSERT；② 用户 B 同时提交另一份 → tx.UPDATE is_void=true（已 idempotent 重复 UPDATE）→ tx.INSERT 用户 B 版本；③ 用户 A 继续 INSERT 用户 A 版本 → 最终 service_order 同时有 A+B 两份合法（uq 守 service_item_id+employee_id+role_type 但同 service_order 不同 service_item 可绕过）
- 现状：admin 当前 0 行运行时数据（commission_status='已分配' 0 行），E5 暂无实证但放量后必现
- 修复：tx 开头加 `SELECT pg_advisory_xact_lock(hashtext('svccomm:'||serviceOrderId))`

#### E6（P1）：service_orders.commission_status 三态破缺（NULL / 待分配 / 已分配 + 缺 'rate_missing' 状态）

- 实测：commission_status='待分配' 607,844 行 + NULL 3 行 + '已分配' 0 行
- 故障路径：service.complete 在 service.js:L454 设 `commission_status='已分配'`，但 INSERT svcComm 失败时 commission_status 已写值（事务行为依赖回滚是否触发）；admin 设 `已分配 || 待分配` 两态；migrate 脚本完全不写
- 业务影响：① admin 营业额分配页面 commission_status 三态不全（runtime rate_missing 静默失败的 service_order 卡死在 NULL 或 待分配）；② audit cron 没有针对 commission_status NULL 的告警
- 修复：schema 加 `CHECK (commission_status IN ('待分配','已分配','分配失败'))` + service.js INSERT svcComm 失败路径写 `'分配失败'` + 加新 audit cron STEP

#### E7（P2）：commission_rate 分布异常 — 90% rate=1.0000 / 9.4% rate∈(1, 9.9999)

- 实测：rate=1.0000 行 554,721（unit_price=0 fallback + service_fee/unit_price=1.0 自然命中）；rate∈(1, 9.9999) 共 58,132（2 倍单价；service_fee>unit_price）；rate=9.9999 1,364（hard cap 触发）；rate∈(0,1) 仅 1,993 行（与"矩阵 0.12 提成"完全不重合）
- 业务影响：commission_rate 字段在历史数据中事实上是"派生比例"而非"提成比例"，admin 任何展示该字段会误导用户
- 修复：A admin UI 把 commission_rate 列从历史行清掉或改名"派生比例"；B 重做提成计算时 commission_rate 单独迁移路径

#### E8（P2）：service_date 7 年跨度含 2055/2099 三笔脏数据

- 实测：2028=2 / 2055=2 / 2099=1（WF 端 UDF_S_822 录入脏值未做 RANGE 校验）
- 业务影响：未来日期 service_orders 在 service_date 排序的报表中永远顶置；按"近 30 天"过滤会漏掉这些行（CURRENT_DATE-30d 窗口外）
- 修复：A migrate 脚本加 `WHERE UDF_S_822 BETWEEN '2010-01-01' AND DATEADD(YEAR, 1, GETDATE())`；B PG schema 加 CHECK service_orders.service_date BETWEEN '2010-01-01' AND '2030-12-31'

### 数据交叉一致性（重大错配 #4 已确认）

R1 已纠正"2024 及更早全未导入"，本次再次确认：service_date 分布 2023:139,654 / 2024:205,311 / 2025:239,107 / 2026:32,133（PG 总 615,205 行 vs WF MSSQL 2025+ 367,069 + 历史 ~344k = 711k → 差额 ~96k 行涉及 fee=0 行不进 svcComm 可解释，**最终量级差距 ~15k**）。R1 修订结论确实正确：**migrate 脚本已实际跑过 2024 数据（与脚本默认 `--year>=2025` 默认值不符的事实**），可能是 `--year=2024` / `--year=2023` 多次手工跑过，或外部分支版本 SQL 不带年份过滤。

### Verdict

**serious-edge-cases**

8 维命中 6 维（FK 孤立 + unique 守住为 ❌干净；其余 6 维均 HIGH/MED 命中）。

P0 风险 3 个：
- E1 commission_rate_matrix 服务单覆盖率 1.7% — 放量后业务永久损失
- E2 runtime service.complete 调用 3 次产出 0 行 svcComm（commission_status NULL 残留）
- E3 22.86M / 11.76M / 9.99M 三笔脏数据未做卫语句已固化到 PG（合计 ~50M 影响 mgmt-dashboard 总额）

P1 风险 3 个（E4-E6）；P2 风险 2 个（E7-E8）。

无 P0「业务永久失效 / 数据资损 / 越权」级 immediate breach，但 E1+E2 一旦真实放量将立即触发"提成丢失"工单流。

---

## 字段扩展建议 R2（2026-04-26）

参考 14-service-commission.md 主体 + _gaps.md（已有 05-service / 08-commission 同源 EXTEND）+ workfine_database.md L675-696 UDT_M_260 字段表。MSSQL 凭据已过期无法 fresh probe，依赖 R1 已确认数据 + workfine_database.md 字段表。

### P0（业务依赖、最终迁移必须补）

**EXT-1（P0）：`service_commissions.is_gift boolean` 新增列（与 05/service EXT-2 同源，迁至 svcComm 也复制）**

- WF 源：`UDT_M_260.UDF_M_6902 = '是'` → true / 其他 → false（已确认 17% 行 = 143,773/856,791）
- PG 应新增列：`service_commissions.is_gift boolean NOT NULL DEFAULT false`（也可由 service_items.is_gift JOIN 反推，但写入 svcComm 减少 JOIN）
- 业务理由：① 赠送服务依然产生 service_fee 与 fixed_fee（archive 0018 已固化），但财务 / 提成口径业务侧明确"赠送服务**不计提成**"；② 当前 PG 100% 视赠送行如正常（commission_amount > 0），财务对账数据失真
- 抽取式：migrate-service-records.js 的 SELECT 加 `RTRIM(m.UDF_M_6902) AS is_gift`；INSERT 加 `is_gift = (raw_is_gift = '是')`
- 数据量：616,210 行回填，预估 ~104,756 行（17%）需置 true
- 依赖：① 与 05/service EXT-2 配套；② 提成算法逻辑改：is_gift=true 时 commission_amount=0；③ admin 重算历史提成路径

**EXT-2（P0）：`service_commissions.satisfaction varchar(20)` 新增列**

- WF 源：`UDT_M_260.UDF_M_842` 顾客满意度评价（满意/一般/不满意 等枚举文本，与 05/service 同源）
- PG 应新增列：`service_commissions.satisfaction varchar(20)`（nullable，业务侧未填默认 NULL）
- 业务理由：① 员工绩效评估强关联——"高满意度服务"加成、"低满意度"扣减；② 当前 PG 端无任何满意度数据，绩效评估只能按金额维度算；③ admin 员工绩效页面可加"满意度分布"卡片；④ R1 主体文档 L73 标注"未对接，与员工绩效评估强关联"
- 抽取式：migrate-service-records.js 的 SELECT 加 `RTRIM(m.UDF_M_842) AS satisfaction`；INSERT 直拷
- 数据量：估 ~30%~50% 行有值（业务执行率），余 NULL
- 依赖：① schema 加列；② 员工绩效页面 / admin 服务单详情展示；③ 不影响现有提成计算

**EXT-3（P0）：`service_commissions.position_name varchar(50)` 新增列（与 08/commission 同源）**

- WF 源：`UDT_M_260.UDF_M_838` 员工职位（"美容师"/"督导"/"养生学徒"/"店长" 等更细粒度）+ `UDF_M_2473` 职位序列编码（"第一职位"/"第二职位"，与 sale_allocations 同套）
- PG 应新增列：`service_commissions.position_name varchar(50)` + 备选 `position_seq varchar(20)`
- 业务理由：① **role_type 派生路径双源不一致**（migrate=skills[0] / backfill=skills[1] / runtime=skills[0]）的根本性修复路径——直接从 WF 抽取真实职位而非反推 staff.skills；② 员工绩效页面"按职位拆分"维度；③ 与 08/commission EXT 一致
- 抽取式：migrate-service-records.js 的 SELECT 加 `RTRIM(m.UDF_M_838) AS position_name, RTRIM(m.UDF_M_2473) AS position_seq`；migrate INSERT 直拷；同时 backfill 脚本可新增 SQL3 用 position_name 反推 role_type 替代 skills[1] 兜底
- 数据量：估 90%+ 覆盖率（WF 端业务必填）
- 依赖：① schema 加列；② role_type 派生路径重写；③ admin "服务提成审计" 页面新增列

### P1（业务降维收益、可选）

**EXT-4（P1）：`service_commissions.is_void_reason text` 新增列**

- WF 源：无；新系统 admin batchSaveServiceCommissions 的"作废原因"
- 业务理由：当前 is_void=true 仅 0 行（archive 0018 后无作废操作），admin UPDATE is_void=true 时无原因记录，审计层无法回溯"为什么作废"
- 数据量：0 行回填
- 依赖：admin UI 新增"作废原因"输入框

**EXT-5（P1）：`service_commissions.commission_kind varchar(20)` 区分"固定手工费 / 消耗提成 / 拓客提成"等明细**

- WF 源：`UDT_M_260.UDF_M_837` 本次消耗 + 派生
- 业务理由：当前 fixed_fee + consume_amount 双字段模型 100% 崩（archive 0018 兜底），新增 kind 列可保留"提成种类"语义；同时为推广师"拓客提成"独立类目铺路
- 数据量：616,210 行回填，全部 kind='handicraft_fee'（archive 0018 兜底语义）
- 依赖：与 EXT-3 配合；admin 提成展示按 kind 分组

**EXT-6（P1）：`service_commissions.matrix_rule_id bigint` 新增列**

- WF 源：无；运行时 service.complete 路径用，记录命中的矩阵规则 id
- 业务理由：① 当前 service.complete 查矩阵无审计证据，commission_rate 怎么来的无法回溯；② 矩阵规则后续调整时，可知"哪些 svcComm 行用了旧规则"
- 数据量：0 行回填（历史 migrate 路径无矩阵 id），仅 runtime 新增写入
- 依赖：service.js:L401-411 LIMIT 1 改为返回 id；schema 加 FK→commission_rate_matrix

**EXT-7（P1）：`service_commissions.duration_minutes int` 新增列**

- WF 源：`UDT_M_260.UDF_M_840` 服务时长（**workfine_database.md L689 标注"金额"是错的**，实测 99.997% 行 ≤ 300 分钟）
- 业务理由：① 计算"单位时间提成"（commission_amount / duration_minutes）；② 员工绩效页面"工时-收入比"卡片；③ 05/service.service_items.service_duration 已有同源数据，svcComm 加列减少 JOIN
- 数据量：616,210 行回填
- 依赖：与 05/service.service_items.service_duration 共源；非必需，可在统计 SQL JOIN 解决

### P2（数据完整性增强、低优先级）

**EXT-8（P2）：`service_commissions.item_count int` 新增列**

- WF 源：`UDT_M_260.UDF_M_841` 项目个数
- 业务理由：当前所有 svcComm 默认 1 个项目；item_count > 1 的行（套餐/组合服务）在统计时被低估
- 数据量：616,210 行回填，估 ~5% 行 > 1
- 依赖：schema 加列；admin 显示项目个数

**EXT-9（P2）：`service_commissions.legacy_filled_at timestamp` 新增列**

- WF 源：`UDT_S_259.UDF_S_822` 服务日期（与 service_orders.service_date 同源但 svcComm 加列减少 JOIN 链 svcComm→items→orders）
- 业务理由：高频报表 SQL（mgmt-dashboard / staff.performanceDetail）都需 JOIN 三表过滤 service_date，svcComm 加列后 JOIN 链 -2
- 数据量：616,210 行回填
- 依赖：与 05/service 同源数据，可选

**EXT-10（P2）：`service_commissions.legacy_card_validity_until date` 新增列**

- WF 源：`UDT_M_260.UDF_M_7135` 有效日期（拓客卡到期）
- 业务理由：① 当前充值卡到期信息散布在 sale_items.expire_date；② 推广师提成统计可加"已过期卡"筛选
- 数据量：估 ~10% 拓客卡相关行有值
- 依赖：可选；与 11/prepaid-card 共源

### 字段扩展统计

- **P0：3 个**（EXT-1 is_gift / EXT-2 satisfaction / EXT-3 position_name）
- **P1：4 个**（EXT-4 is_void_reason / EXT-5 commission_kind / EXT-6 matrix_rule_id / EXT-7 duration_minutes）
- **P2：3 个**（EXT-8 item_count / EXT-9 legacy_filled_at / EXT-10 legacy_card_validity_until）
- **总计 10 个**

WF 字段抽取覆盖率提升：当前 svcComm 仅抽 UDF_M_2472(employee_id) + UDF_M_837(amount) + 派生 rate；R2 后将抽 UDF_M_842 / UDF_M_6902 / UDF_M_838 / UDF_M_2473 / UDF_M_840 / UDF_M_841 / UDF_M_7135 共 7 个新字段，覆盖率从 ~10% 提升至 ~40%（UDT_M_260 26 列中可用业务列 ~17 列）。

