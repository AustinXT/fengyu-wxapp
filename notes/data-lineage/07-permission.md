# 07 — `permission` 模块

**Schema 文件**：`db/schema/permission.ts`
**涉及 PG 表**：`permission_roles`
**WorkFine 源表**：**无业务对应表**（详见下方"WorkFine 端无业务对应实体"小节）
**主要写入入口**：
- `db/scripts/sync-workfine.js:L403-478` — `syncPermissionRoles`（员工同步后自动推导，UPSERT 模式；2026-04-16 停用）
- `fengyu-admin/src/actions/permissions.ts:L219` — `assignRole`（admin UI 手动分配）
- `fengyu-admin/src/actions/permissions.ts:L272` — `revokeRole`（admin UI 撤销，硬删除）
- `fengyu-admin/src/actions/employees.ts:L442` — 员工标记离职时硬删除其全部权限
- `fengyu-admin/src/actions/employees.ts:L462` — 员工调店时同步更新 store 级 scope_id
- `fengyu-admin/src/db/seed.ts:L272-284, L393` — `PERMISSION_ROLES` 11 条 demo 种子（仅开发环境）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0016_permission_roles_hard_delete.sql` — 历史从软删除改硬删除（DROP `is_void` / `voided_at` 列 + 重建唯一索引）

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 维度 | 行数 |
|------|------|
| 总行数 | 2038 |
| 按 role | staff=1640, finance=240, manager=148, hr=3, admin=3, product=2, customer_mgr=2 |
| 按 created_by | sync=2017, FY-260321001=9, manual=5, FY-260317001=5, system=1, FY-260101-0001=1 |
| 按 updated_by | sync=2013, NULL=25 |
| scope_id 解引用 | 门店=1997, 市场=30, 总部=11 |
| created_at 区间 | 2026-03-12 ~ 2026-04-01（最后一次 sync 跑） |
| 在职员工 vs 已分权员工 | 2020 vs 2015（**5 个在职员工无任何权限行**，疑似 sync 跳过） |

> **关键定位**：`permission_roles` 是 **新系统独立** 表，WorkFine 业务层无对应实体；2017/2038 行（99%）由 `syncPermissionRoles` 通过 `staff_wechat_users.position_name + org_node` JOIN **派生推导**，仅 21 行由 admin UI 手动写入。本质上行**全部由 PG 内部数据派生**，不直接读 WorkFine 任何字段。

---

## 表 1：`permission_roles`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial (PK) | 默认值/NULL | PG 自增 | schema:L15 | 不来自 WorkFine |
| employee_id | varchar(30) FK→staff_wechat_users.employee_id | WorkFine 派生 | 来自 `staff_wechat_users.employee_id`（详见 03-user 文档；本身是 WF UDT_S_287.UDF_S_1474 的派生） | sync-workfine.js:L415, L466 | 间接传递；本表不直接读 WF |
| role | text | WorkFine 派生（PG 规则映射） | 由 `staff_wechat_users.position_name` + `org_nodes.name`（部门）映射：<br>① pos.includes('代理') → `staff`<br>② pos = '门店经理' → `manager`<br>③ pos ∈ ('市场总监','片区经理') → `manager`（scope=market）<br>④ dept = '财智部' → `finance`<br>⑤ 其他 → `staff` | sync-workfine.js:L437-457 | 7 个 enum 值 (`admin`/`manager`/`finance`/`hr`/`product`/`staff`/`customer_mgr`) 中 sync 仅会派生 `staff`/`manager`/`finance`；`admin`/`hr`/`product`/`customer_mgr` 全部由 admin UI 手工分配 |
| scope_id | text FK→org_nodes.id | WorkFine 派生 | ① 默认 = `staff_wechat_users.store_id` 对应的 `stores.org_node_id`（store 级）<br>② 市场总监/片区经理 = `org_nodes.parent_id`（market 级）<br>③ admin 角色必须指向总部节点（permissions.ts:L192-201 校验） | sync-workfine.js:L420, L439-454 + permissions.ts:L192 | 间接传递自 02-org；不直接读 WF |
| created_by | text | 新系统独立 | sync 行硬编码 `'sync'`；admin UI 行 = 操作者 `session.employeeId`；seed 行 = 字符串字面量 (`'system'`/`'sync'`/`'FY-260101-0001'`) | sync-workfine.js:L462；permissions.ts:L223；seed.ts:L273-283 | 用于区分"自动推导 vs 手工分配"，禁止 sync 覆盖手工记录（sync-workfine.js:L465 `WHERE created_by = 'sync'`） |
| updated_by | text | 新系统独立 | sync 重新跑时 = `'sync'`；admin UI 调店同步 scope = 操作者 `session.employeeId`；admin UI assign/revoke **不写**该字段（PG 现状 25 行 NULL = 未被 sync 覆写过的 admin/seed 记录） | sync-workfine.js:L462；employees.ts:L463 | ⚠️ `assignRole`/`revokeRole` 路径未填 updated_by，与 created_by 不对称 |
| created_at | timestamp | 默认值/NULL | `defaultNow()` | schema:L28 | INSERT 时间，最早 2026-03-12 = sync 首跑日 |
| updated_at | timestamp | 默认值/NULL | `defaultNow()` + `$onUpdate`；sync UPSERT 时显式 `updated_at = now()` | schema:L29 + sync:L464 | 每次 sync 跑都会 bump |

### 唯一索引

| 索引名 | 列 | 出处 |
|--------|----|------|
| `uq_perm_roles_emp_role_scope` | (employee_id, role, scope_id) | schema:L32-33 + 0000_baseline.sql:L603 |

> archive `0016_permission_roles_hard_delete.sql` 历史曾是含 `WHERE is_void = false` 的部分唯一索引；2026-04-baseline 后已统一为无条件唯一索引。

---

## WorkFine 端无业务对应实体

`syncPermissionRoles` **不直接读 WorkFine 任何 UDT_/UDF_ 表**，所以"已被脚本读但未对接"小节为空。但 MSSQL 端确实存在 7 张以 `tb_sys_*` 命名的角色/权限表，本次 readonly probe 已确认它们与本模块**完全无关**：

| WorkFine 系统表 | 行数 | 用途（推断自字段+样本） | 与 PG permission_roles 关系 |
|-----------------|------|--------------------------|----------------------------|
| `tb_sys_role` | 22 | WorkFine 平台级管理角色（如`系统管理员`/`模板设计者`/`工作流设计者`） | **无关**，是 WorkFine 平台 SaaS 自带角色，非美容院业务角色 |
| `tb_sys_user_role` | 169 | 平台用户↔平台角色映射 | **无关**，user_id 指向 WorkFine 平台账号，非员工档案 |
| `tb_sys_role_org` | 170 | 平台角色↔组织（dept_id=-1 即全局）映射 | **无关** |
| `tb_sys_module_permission` | (未抽样) | 模块级权限点 | **无关** |
| `tb_sys_strategy_permission` | (未抽样) | 策略级权限点 | **无关** |
| `tb_sys_template_permission` | (未抽样) | 模板级权限点 | **无关** |
| `tb_sys_workflow_permission` | (未抽样) | 工作流级权限点 | **无关** |

---

## 关键决策

1. **本表是"派生表的派生表"**：sync 不跨库读 WF，仅在 PG 内对 `staff_wechat_users + stores + org_nodes` 做 JOIN 推导。**最终迁移阶段，本表的产出依赖 03-user / 02-org 两个上游模块完成**——上游员工 `position_name` / `dept_name` / `store_id` 数据质量直接决定本表行准确度。
2. **派生规则与 spec 文档不一致**：`workfine-sync.spec.md §4.6` 说"其他 → role=`employee`"，但实际 sync-workfine.js:L444 fallback 是 `role='staff'`。spec 是过时文档，实际 PG enum 也只有 `staff`，无 `employee`。
3. **sync 派生覆盖率仅 4 个角色（`staff`/`manager`/`finance`，加 market scope 变体）**，剩余 4 个 enum 值（`admin`/`hr`/`product`/`customer_mgr`）必须由 admin UI 手工分配。PG 现状：admin=3、hr=3、product=2、customer_mgr=2 共 10 行手工，符合预期（demo seed 1 行 admin + 1 行 hr，剩余 8 行 = 真实 admin 用户操作）。
4. **`updated_by` 半失填问题**：`assignRole`/`revokeRole` 没写 `updated_by`，导致非 sync 记录该列长期 NULL。如果未来用 `updated_by` 做"上次谁改了"审计，需要补 admin actions。
5. **5 个在职员工无任何权限行**（in-service 2020 vs distinct perm_emp 2015）：原因推测 = 这些员工 `store_id IS NULL` 被 sync-workfine.js:L442 `if (!storeScope) continue` 跳过。最终迁移需考虑这部分员工是否补默认 staff 行。
6. **代理经理强制降级**：sync-workfine.js:L448 `pos.includes('代理') → role='staff'`（spec §4.6 注 "代理经理（position_name 包含'代理'）默认推导为 role=staff，需手动升级"）。**含义：员工档案上的"代理店长"职位会被剥夺 manager 权限**——业务侧需要核对当前 148 manager 行是否漏掉了应授权但被代理标识压制的人。
7. **store 调动仅同步 store 级 scope**（employees.ts:L448-475 显式注释）：market/headquarters 级的 manager scope 不会随员工调店变动，这是设计选择不是 bug。
8. **历史曾是软删除**：archive 0016 把 `is_void`/`voided_at` 列 DROP 了，**所有"已撤销"权限记录已物理删除**，最终迁移阶段无法恢复历史撤销审计。如需，要从 `operation_logs` 中按 `action='permission.revoke'` 重建。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- `permission_roles.updated_by` 在 `assignRole` / `revokeRole` 路径未填 → 25 行 NULL
- 5 个在职员工（store_id IS NULL）被 sync 跳过 → 0 权限行
- "代理经理" position 被强制降级为 staff，可能与业务期望不符
- 历史撤销记录（archive 0016 之前的 `is_void=true` 行）已物理删除，无法追溯
- WorkFine `tb_sys_role` / `tb_sys_user_role` 平台级角色未对接（也不应对接，与业务角色无关；登记此处仅作"已读 + 已确认无关"佐证）
- spec `workfine-sync.spec.md §4.6` 描述过时（"其他 → role=employee" vs 实际 `staff`），最终迁移前应同步刷新文档或代码

---

## Review 报告（2026-04-26）

**复核范围**：独立按 `db/schema/permission.ts` + `sync-workfine.js` + admin actions + staffApi auth/scope + PG 5434 抽样 + MSSQL readonly 抽样形成"应该长什么样"基线，再回头比对本文档主体。

**核对方法**：`db/.tmp-probe-07.js` 一次性脚本（已删除）。MSSQL 严格只读。

### 一致项（spot-checked，符合）

- 列定义 8 列（id/employee_id/role/scope_id/created_by/updated_by/created_at/updated_at）与 schema:L15-29 + 0000_baseline.sql:L322-330 一致
- 唯一索引 `uq_perm_roles_emp_role_scope (employee_id, role, scope_id)` 一致
- 两个 FK（→ staff_wechat_users.employee_id / → org_nodes.id）一致，无 ON DELETE 级联
- 总行数 2038、按 role 分布（staff=1640 / finance=240 / manager=148 / hr=3 / admin=3 / product=2 / customer_mgr=2）一致
- scope_id 解引用分布（门店=1997 / 市场=30 / 总部=11）一致
- created_by 详细分布（sync=2017 / FY-260321001=9 / manual=5 / FY-260317001=5 / system=1 / FY-260101-0001=1）一致
- updated_by 分布（NULL=25 / sync=2013）一致
- admin 角色全部指向 `16d1184b46db099a`(总部) ✓ 与 permissions.ts:L192-201 校验逻辑一致
- 推导规则 5 条（代理 / 门店经理 / 市场总监|片区经理 / 财智部 / 其他）逐条与 sync-workfine.js:L437-457 一致
- spec `§4.6` "其他 → role=`employee`" 过时事实 ✓ 文档已正确捕获
- "派生覆盖率仅 staff/manager/finance" ✓ 与 role × scope_type 矩阵一致（staff/manager/finance 各有由 sync 推导的多行；admin/hr/product/customer_mgr 几乎全是手工分配）
- archive 0016 软删除 → 硬删除迁移描述与 SQL 文件一致
- MSSQL `tb_sys_role`(22) / `tb_sys_user_role`(169) / `tb_sys_role_org`(170) 行数及"WorkFine SaaS 平台级角色（系统管理员/模板设计者…）非业务"判断 ✓ readonly 抽样确认

**一致项数：约 14 项**

### 不一致项（按 4 类）

#### 缺漏（incomplete）

1. **遗漏"离职员工仍持权限"问题**：PG 抽样发现 1 名 `is_resigned=true` 员工仍存在 permission_roles 记录。employees.ts:L440-444 在标记离职时硬删权限，但 sync-workfine.js 路径（`is_resigned=false` filter 仅决定 INSERT 与否，不删除既有行）会留下"离职后未走 admin UI 触发删除 → 历史记录残留"的 1 行漏网。建议补充到本模块"⚠️ 未覆盖字段汇总"。
2. **未提及 `created_by='manual'` 5 行的来源未知**：grep 全仓零命中字面量 `'manual'`，疑为 baseline reset 之前的历史脚本/手工 SQL 残留，文档未标注。
3. **未提及 `staffApi/middleware/auth.js:L193-198` 是另一处读路径**（同样 SELECT pr.role/scope_id JOIN org_nodes），主要写入入口列表完整但读路径列表未列出（虽然血缘文档主要关注写）。

#### 错配（mismatch）

4. **"5 个在职员工无任何权限行" → 实际 6 个**：
   - 文档第 24 行表格："在职员工 vs 已分权员工 | 2020 vs 2015（5 个在职员工无任何权限行）"
   - 实际 PG：`staff_wechat_users.is_resigned=false` 计 2020；其中 `employee_id IN (perm distinct)` 计 2014；**差值 = 6，不是 5**
   - 文档把 `2020 - distinct_perm_emp(2015) = 5` 当作"无权限的在职员工数"，但 perm_distinct_emp 包含离职员工（如发现的 1 行残留），扣回去就是 6 而不是 5
   - 第 77 行同样误说 5
5. **"create_at 区间 2026-03-12 ~ 2026-04-01"**：实测 `min=2026-03-13 04:48:49` / `max=2026-04-02 16:27:18`（Asia/Shanghai）。误差 1 天，疑似时区显示偏差。**非关键**但建议精确化。
6. **第 24 行表头 "按 created_by | sync=2017, FY-260321001=9, manual=5, FY-260317001=5, system=1, FY-260101-0001=1"** —— 总和 = 2038 ✓，但**第 7 行结论 "21 行由 admin UI 手工分配"** 与第 76 行结论 "10 行手工" 自相矛盾。实际 = 21 行（2038-2017）非 sync，扣掉 `'system'` seed 1 行 + `'manual'` 5 行（来源不明）= 15 行真实 admin 操作；与第 76 行说的"admin=3 + hr=3 + product=2 + customer_mgr=2 = 10 行"对不上（少 5 行）。建议正文统一口径。
7. **第 77 行 "原因推测 = store_id IS NULL 被 sync L442 跳过"**：实测 `is_resigned=false AND store_id IS NULL` 仅 2 人（不是 5/6）。剩余无权限员工大概率是 sync 跑后新入职 + 后续 sync 已停用（2026-04-16 决策）造成 → 与 2026-04-02 最后一次 sync 时间窗一致。原因解释错位。

#### 数据不一致（drift / inconsistent）

无。schema / 索引 / FK / 行为与 5434 实际状态完全一致。

#### 过时事实（stale facts）

8. **第 23 行 "created_at 区间 2026-03-12 ~ 2026-04-01（最后一次 sync 跑）"**：与 MEMORY 中 `workfine-sync-stopped`（2026-04-16 决策停用）+ `db/CLAUDE.md` 描述吻合，但区间右端实测是 `2026-04-02`，文档误差 1 天。
9. **第 7 行 "(2026-04-16 停用)"** —— 与 memory `workfine-sync-stopped` 一致，无问题。

### Verdict

**minor-fix**

主要事实与 schema、迁移、写入入口、PG 实际行为高度一致；推导规则、spec drift、archive 0016 演变等核心证据链都正确。问题集中在两处数字误差（5→6 / 2 不准）+ 一处结论自相矛盾（21 vs 10）。**不影响最终迁移决策**，但建议小修：
- 把"5 个无权限员工"改成"6 个"，并修正原因解释（sync 4-16 后停用 + 新入职无 sync 兜底，而非 store_id IS NULL）
- 统一 `21 vs 10` 手工分配口径
- 补充"1 行离职员工权限残留"到未覆盖字段
- created_at 区间右端改为 2026-04-02

### P0 评估

无 P0。本模块不涉及业务永久失效 / 数据资损 / 越权风险：
- admin 角色受 `requirePermission('permission:assign_admin')` + 总部节点强约束保护
- 非 admin 越权分配/撤销有 scope 隔离（permissions.ts:L184-189 / L264-269）
- 离职员工 1 行残留属审计噪音，不构成越权（只要 staffApi auth.js 仍以 `is_resigned` 闸门即可，已确认中间件 L189 `isActive = !is_resigned` 会让残留行不生效）

---

## Edge Case 报告 R2（2026-04-26）

**复核范围**：8 类风险维度逐项主动挖掘文档外的问题。本轮不预设结论，发散探查 PG 5434/2038 行 + 全仓 grep。

**核对方法**：`db/.tmp-probe-r2-07.js` + `db/.tmp-probe-r2-07b.js` 两个一次性脚本（已删除）。MSSQL 严格只读未命中（本模块零 WF 来源）。

### 8 维度逐项命中

#### 1. FK 孤立 / 引用完整性 — 【1 命中】

- **1c 离职员工权限残留**：`is_resigned=true` 员工仍存 perm 行 = **1 行**（FY-260125002 檀思思），与 R1 已报一致
- 1a/1b 父表查找：`employee_id` / `scope_id` 父行 100% 命中，无孤儿
- 1d FK ON DELETE：`confdeltype='a'` (NO ACTION)，与"硬删除"语义一致；DELETE staff_wechat_users 会被阻塞，是设计选择而非 bug

#### 2. NULL / 空串 / 极值 — 【1 命中（已知）】

- **2a updated_by NULL = 25 行**（已知），R1 已报
- 其他 not-null 列全部守住，零空串
- 2b role 长度无异常（max=12 'customer_mgr'）
- 2c 日期范围 [2026-03-13, 2026-04-02]，无极端日期；`updated_at >= created_at` 100% 满足

#### 3. enum 漂移 — 【0 命中】

- 实际 PG 7 个 role 值与 schema:L19 注释 + admin/lib/permissions.ts L15-87 PERMISSION_MATRIX 完全一致：admin/manager/finance/hr/product/staff/customer_mgr
- staffApi/utils/scope.js 仅消费 role+scopeType（不 switch role 字面量），无漂移风险

#### 4. unique 守住与否 — 【0 历史命中 / 1 设计风险】

- 4a `(employee_id, role, scope_id)` GROUP BY HAVING COUNT(*) > 1 = 0 行 ✓
- **4b admin 全部指向总部** ✓（3 行均 type='总部'）
- **4d 部门级 scope = 0 行** ✓ （schema 注释/spec 说部门级被忽略，实际无人写过部门级）
- 但 **4c 发现 4 项设计性越界**（见跨模块 §5）

#### 5. 跨模块一致性 — 【4 高危命中】 ⚠️

**5a 调店后旧店 staff 行未清理（duplicate-stale 残留）—— P1**
- 实测 1 行（FY-260311001 马晓丽）：当前 `store_id=96c09c39b47dc344(南昌丽景店, org_node 6f00d80f86943b52)`，但持有 **2 行 staff 权限**：`staff:0b42ab90d1ea77de(南昌锦城店)` + `staff:6f00d80f86943b52(南昌丽景店)`
- 根因：`employees.ts:L448-475` 调店时只 `UPDATE permission_roles SET scope_id=新店 WHERE scope_id=旧店`；但 sync 在新店 INSERT 行时该员工已经在新店有 perm 了 → ON CONFLICT 命中跳过；又因为 sync 不读旧 scope，旧店行无人删除。**这条 path 会随调店次数线性累积**——未来历史调店越多残留行越多。
- 业务影响：staffApi `expandScopeStoreIds`（utils/scope.js）会把"南昌锦城店 + 南昌丽景店"两家店都纳入该员工 scope → 数据可见范围越权（顾客/订单/服务单跨店可见）
- 修复：A 同步脚本最后增加 `DELETE FROM permission_roles WHERE created_by='sync' AND role='staff' AND employee_id=$1 AND scope_id NOT IN (新 store_org_node, [其他真实门店])` 兜底；B `employees.ts:L460` 改为 `DELETE` 旧 staff 行 + `INSERT` 新 staff 行（非 UPDATE）；C 写一次性 SQL 清理"`staff` 行的 `scope_id` 不属于该员工任何已知门店"的存量

**5b 6 个在职员工无任何权限行（R1 数字 5 修正） —— 已通过 R1 minor-fix 报**
- 实测 6 个：FY-220918004(谭缘缘 门店经理) / FY-221011001(熊诗嘉 督导) / FY-230312005(姜娜娜 门店经理) / FY-221216001(王晓乔 门店经理 store_id=NULL) / FY-221216004(陈发平 代理经理 store_id=NULL) / FY-230308001(杨慧娟 督导)
- 4 个有 store_id（推测 sync 跑后新入职 + 后续 sync 已停用 2026-04-16），2 个 store_id=NULL（被 sync L442 跳过）
- 业务影响：这 6 人无法登录员工端核心业务（auth.js:L189 isActive 通过但 scopeStoreIds=[] → buildStoreScopeCondition 返回 `FALSE` 把所有数据查询恒假）

**5c hr 角色被违规分配到 门店/市场 scope —— P0** ⚠️
- 实测 2 行（admin assignRole **无任何 scope_type 守卫**，仅 admin 角色才有 L191-201 的"必须总部"校验）：
  - id=52073: 刘梦洁 hr@scope='新余市场'(实际 type='门店'，名字误导，但是门店节点) — 配置可能错
  - id=52074: 丁思思 hr@scope='凤御管理中心'(type='市场')
- 业务影响：`hr` 角色拥有 `permission:list/assign/revoke` 等高敏权限（lib/permissions.ts:L74）。但 hr 被分配到门店级 scope 后，`hasRole(session, 'admin') === false`，触发 L184-189 的 `userScopeIds.includes(data.scopeId)` 校验 → **该 hr 用户只能在自己绑定的门店 scope 内分配权限，是约束生效的**。然而在该 scope 内 hr 仍可通过 `permission:assign` 给同店其他员工分配 staff/manager/finance 角色，**业务上从未授权门店级 hr**——是隐式越权。
- 修复：admin/actions/permissions.ts:L191-201 扩展 scope_type 守卫，按 role 白名单：admin/hr/customer_mgr/product/finance（HQ-only）只能分配到总部；manager/staff 只能门店或市场；写成函数 `assertRoleScopeMatches(role, scopeType)`

**5d manager / staff / finance 被分配到 总部 scope —— P0** ⚠️
- 实测 4 行：
  - id=52072 manager:测试员@总部 (created_by=FY-260321001)
  - id=52078 staff:丁俊兰@总部 (created_by=FY-260321001)
  - id=52076 finance:丁俊兰@总部 (created_by=FY-260321001)
  - id=52077 admin:丁俊兰@总部 (合规)
- 业务影响（**真实越权**）：staffApi/utils/scope.js:L46 `if (hasHq) return LEVEL_HEADQUARTERS`——**任何 role 只要有总部 scopeBindings 都会被升级到 headquarters 级**。这意味着丁俊兰即使没有 admin 角色，仅靠 `staff@总部` 一行就能在员工端拿到全店可见、全员可看的最高权限。本质是 `expandScopeStoreIds` "总部 → 全部 stores" 不区分 role 类型。
- 修复同 5c：scope_type 必须按 role 白名单收紧；同步给 `expandScopeStoreIds` 加"总部 scope 仅对 admin/hr/finance/customer_mgr/product 角色生效"硬编码或者"非 admin 总部 scope 只展开当前用户绑定门店"。**优先 5c 路径堵住源头。**

#### 6. 死代码 / 永不命中 — 【2 命中】

- **6a `created_by='manual'` 5 行无写入位点**：grep 全仓零命中字面量 `'manual'`，疑为 baseline reset 之前的历史脚本/手工 SQL 残留（5 行均为 2026-03-14 16:16:55 同时戳，且全部 `updated_by=NULL`，明显批量 INSERT）。已 R1 已报。
- **6b sync 永不派生 admin/hr/product/customer_mgr**：sync-workfine.js:L437-457 的 5 条 if-else 分支只产出 staff/manager/finance；其余 4 个 enum 值全靠 admin UI。所以**4 个 role 的 sync 路径是永不命中分支** = 设计如此，非 bug。
- 6c PERMISSION_MATRIX 中 staff 角色的 actions 数组**为空 `[]`**（lib/permissions.ts:L86）—— 这意味着员工端登录的 staff 角色用户在 admin 后台无任何 action（合规，admin 端不给非管理角色看），但在 staffApi 端 `roles=['staff']` 仅作为闸门字段，**实际权限由门店 scope 隐式授予**。这是双系统设计差异，不是 bug 但应文档化。

#### 7. dump-restore 残留 / drift — 【0 命中】

- **7a archive 0016 软删除列已物理删除** ✓ `is_void`/`voided_at` 不在 information_schema.columns
- **7b 唯一索引正常** ✓ `uq_perm_roles_emp_role_scope` 是无条件唯一索引（archive 注释说改之前是 partial index `WHERE is_void=false`，已验证 baseline 后恢复正常）
- **7c 种子数据残留** ✓ FY-260101-0001(张明) seed 1 行 admin + 1 行 hr 全部存在；FY-260101-0001 是 demo 用户，生产不应留存（建议 final migration 时 DROP）

#### 8. 运行时安全 — 【1 高危命中】 ⚠️

- **8a `updateEmployee` 离职 + 调店时无事务包裹** —— P1
  - employees.ts:L329-444 三步：`UPDATE staff_wechat_users` + `DELETE permission_roles WHERE is_resigned=true` + `UPDATE permission_roles WHERE storeId 改变`
  - **三个 db.* 调用各自独立无事务**。如果第二步 DELETE 在 第一步 UPDATE 之后崩溃 → 员工 `is_resigned=true` 但 perm 行残留。auth.js:L189 用 `is_resigned` 闸门兜底（不构成越权），但管理后台后续审计/报表会出现"已离职但有权限"的脏数据 → 这就是 R1 已报的 1 行残留的可能成因之一
  - 修复：包成 `db.transaction(async (tx) => { ... })`（`createEmployee` L299 已用，对称即可）
- 8b 所有 SQL 全部参数化（pg `$1/$2/$3` 或 Drizzle ORM），无注入位点 ✓
- 8c sync syncPermissionRoles BEGIN/COMMIT 包裹 ✓
- 8d **缺索引 `(employee_id)` 单列索引**：`auth.js:L193 SELECT pr.role/scope_id WHERE employee_id = $1` 是热路径（每次员工登录调用），但 PG 仅有 `(employee_id, role, scope_id)` 复合索引。复合索引最左前缀是 employee_id，所以**实际 PG 会用复合索引前缀扫**——能命中。本项无优化必要。

### 命中总数

| 维度 | 命中数 | 严重 |
|------|--------|------|
| 1. FK 孤立 | 1 | 已知（R1 报） |
| 2. NULL/极值 | 1 | 已知 |
| 3. enum 漂移 | 0 | — |
| 4. unique 守住 | 0 | — |
| 5. 跨模块一致性 | **4** | **2×P0 + 1×P1 + 1×已知** |
| 6. 死代码 | 2 | 已知 + 设计 |
| 7. dump-restore drift | 0 | — |
| 8. 运行时安全 | 1 | P1 |
| **合计** | **9** | **2×P0 + 2×P1** |

### Verdict

**serious-edge-cases**

虽然 R1 验证主体事实准确，**R2 主动挖掘暴露 2 项 P0 越权风险**（5c+5d）：admin/actions/permissions.ts 缺少"role × scope_type" 白名单守卫，导致：
- `manager/staff/finance:总部` 4 行 → staffApi 自动升级到 `headquarters` 级 → 全店可见越权（FY-260321001 / FY-230717004 已构成实际越权数据）
- `hr:门店/市场` 2 行 → 偏离"hr 是 HQ-only"的产品语义（虽然有 scope 隔离兜底，但 hr 在其单店内仍可分配给同店员工高权限角色）

P1 包含：5a 调店后旧店 staff 行未清理（数据可见范围越权累积）+ 8a updateEmployee 三步无事务（崩溃间隙脏数据风险）。

迁移阶段必须修：① permissions.ts assignRole 加 `assertRoleScopeMatches(role, scopeType)` 白名单；② 一次性 SQL 清理上述 6 行越权行；③ employees.ts updateEmployee 改用 db.transaction；④ sync-workfine.js 调店残留清理（如未来恢复 sync）。

---

## 字段扩展建议 R2（2026-04-26）

**结论：无候选，确认 100% 新系统独立。**

### 重判依据

1. **WorkFine SaaS 平台级角色 (`tb_sys_role` / `tb_sys_user_role` / `tb_sys_role_org` / `tb_sys_module_permission` / `tb_sys_strategy_permission` / `tb_sys_template_permission` / `tb_sys_workflow_permission`) 完全无业务价值**：MSSQL 抽样确认 22 行 sys 角色全部是 WorkFine 平台 SaaS 自带（`系统管理员`/`模板设计者`/`工作流设计者`等），与美容院业务角色无任何映射；用户字段指向 WorkFine 平台账号而非员工档案。**绝对不应抽。**

2. **本表全部 8 列已经齐全**：
   - `id` / `created_at` / `updated_at` 系统列
   - `employee_id` / `role` / `scope_id` 业务三元组（已有唯一索引保护）
   - `created_by` / `updated_by` 审计列（虽然 `updated_by` 半失填，但属于 admin actions bug 而非字段缺失）

3. **本模块"派生表的派生表"性质**：行全部由 PG 内部 `staff_wechat_users + stores + org_nodes` 推导。要扩字段就应该扩上游（03-user 加 `position_normalized` / 02-org 加 `dept_role_hint`），而不是在本表加冗余冷数据。

4. **WorkFine 没有"角色"概念可对接**：业务上 WorkFine 用 `position_name` 字段承载岗位，PG sync 已用它派生 role；除此之外 WF 端无任何"role"语义实体。

### 候选抽样的反向校验

为防 confirmation bias，本轮主动**反推**："如果要给 permission_roles 加列，能从哪里抽？"

| 假设候选列 | 假设源 | 评估 | 结论 |
|------------|--------|------|------|
| `revoked_at` (历史撤销时间) | 无 | archive 0016 已物理删除软删除列 | **不抽**（语义已废，操作日志兜底） |
| `granted_reason` (授予说明) | 无 | WF / PG 均无来源 | **不抽**（admin UI 可加 modal，但属新系统功能不属迁移） |
| `effective_until` (权限有效期) | 无 | 业务从未要求过期 | **不抽**（YAGNI） |
| `external_role_ref` (外部角色映射) | tb_sys_user_role | WF 平台角色无业务对应 | **不抽**（已确认 R1 verdict） |
| `position_snapshot` (派生时职位快照) | staff_wechat_users.position_name | 本表派生即时读，无需快照 | **不抽**（每次 sync 重算更准） |

5 个反推候选全部 reject。

### 候选清单

**0 个候选。** 本模块最终迁移阶段：
- ✅ 不新增任何列
- ✅ 不抽 WF 任何字段
- ✅ R1 已识别的 minor 问题（updated_by 半失填、6 行无权限员工、created_by='manual' 来源不明、seed 用户残留）通过修代码 / 一次性 SQL 解决，**与字段扩展无关**
- ✅ R2 上方报告的 2 个 P0 越权风险通过添加**应用层 scope_type 白名单守卫**修复，**也不需要新列**

P0 / P1 / P2 / P3 字段数：**0 / 0 / 0 / 0**
