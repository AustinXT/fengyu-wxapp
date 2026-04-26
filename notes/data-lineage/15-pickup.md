# 15 — `pickup` 模块

**Schema 文件**：`db/schema/pickup.ts`
**涉及 PG 表**：`pickup_records`（家居产品分次提货流水）
**WorkFine 源表**：**无**（WorkFine 完全不存在"提货 / 取货 / 领取"概念实体）
**主要写入入口**：
- `fengyu-admin/src/actions/pickup-records.ts:284-364`（`createPickupRecord`）— **唯一**业务 INSERT 入口
- `fengyu-admin/src/actions/customers.ts:834`（`mergeClientProfile` 合并孤儿顾客时 UPDATE `client_user_id` 重挂，**不创建新行**）
- `db/migrations/0000_baseline.sql:475-484`（baseline 建表）
- `db/migrations/_archive_pre_baseline_2026_04/sql/0007_sync_to_current.sql:19-21`（修 CHECK 约束名 `pickup_records_pickup_quantity_check` → `chk_pickup_quantity`，**仅 DDL 不写数据**）

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | 来源 |
|----|-------|------|
| pickup_records | **0** | — |

**佐证**：
- MSSQL 探源（`sys.tables` LIKE '%pickup%' / '%tihuo%' / '%取货%'）→ **0 命中**
- MSSQL `sys.extended_properties` 查"提货" / "取货" / "领取" / "提取" / "家居产品" 列描述 → **全部 0 命中**
- `cloudfunctions/` 全目录无 `pickup_records` / `picked_up_quantity` 字符串
- `db/scripts/{migrate,sync,seed,backfill}-*.js` 全部无 pickup 写入
- 同库 `sale_items` 中 `product_type = '家居产品'` 仅 **1 行**（且 `picked_up_quantity = 0`）— 上游业务源数据本身近乎空白

> **结论：100% 新系统独立、运行时也尚未产出**。本模块整张表是"已设计、已实现、未触发"的空表，最终 WorkFine→PG 迁移 **完全不需要触及**。

---

## 表 1：`pickup_records`

### 列级血缘（按 schema 顺序）

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial (PK) | 新系统独立 | DB autoincrement | schema:L17 | |
| sale_item_id | varchar(30) NOT NULL | 新系统独立 | 由 admin 操作员从 `getAvailablePickupItems(clientUserId)` 返回的可提货明细中选定（FK→`sale_items.sale_item_id`） | pickup-records.ts:L232-274, L334 | 筛选条件：order.status='已支付' AND item.item_direction='购买' AND product_type='家居产品' AND quantity > picked_up_quantity |
| pickup_quantity | integer NOT NULL | 新系统独立 | admin 表单输入；CHECK 约束 `pickup_quantity > 0`；事务内 UPDATE `sale_items.picked_up_quantity` 累加，超量回滚 | schema:L23, pickup-records.ts:L298-300, L311-320 | 并发安全靠 `WHERE (COALESCE(picked_up_quantity,0)+$1) <= quantity` 单语句 |
| store_id | text NOT NULL | 新系统独立 | admin 表单选择的"实际提货门店"（FK→`stores.store_id`）；可与原销售门店不同（跨店提货） | pickup-records.ts:L260-261, L304, L336 | scope 校验 `isInScope(session, storeId)` 拦截越权 |
| client_user_id | text NULLABLE | 新系统独立 | admin 表单可选选择顾客（FK→`client_wechat_users.user_id`）；后续 `mergeClientProfile` 合并孤儿时会被 UPDATE 重挂到 source | pickup-records.ts:L337 + customers.ts:L834 | nullable 设计允许"匿名顾客提货" |
| confirmed_by | varchar(30) NOT NULL | 新系统独立 | `session.employeeId`（admin 当前登录员工，FK→`staff_wechat_users.employee_id`） | pickup-records.ts:L338 | 由 JWT session 自动写入，admin 无法手填 |
| remark | text NULLABLE | 新系统独立 | admin 表单可选输入；空字符串会被 `.trim() \|\| null` 归一化 | pickup-records.ts:L339 | |
| created_at | timestamp NOT NULL | 默认值/NULL | `defaultNow()` | schema:L35 | **schema 故意未提供 `updated_at`**（流水型表）；admin 列表 ORDER BY 处特地标注 `// 例外：提货流水型表无 updatedAt 列`（pickup-records.ts:L125-126） |

### 关键约束 / 索引（DDL 派生）

| 约束 | 内容 | 出处 |
|------|------|------|
| chk_pickup_quantity | `pickup_quantity > 0` | schema:L40, baseline:L484；归档 0007 修过约束名 |
| idx_pickup_records_sale_item | `(sale_item_id)` | schema:L38 |
| idx_pickup_records_client | `(client_user_id)` | schema:L39 |
| FK `sale_item_id` → `sale_items.sale_item_id` | NO ACTION | baseline:L569 |
| FK `store_id` → `stores.store_id` | NO ACTION | baseline:L570 |
| FK `client_user_id` → `client_wechat_users.user_id` | NO ACTION | baseline:L571 |
| FK `confirmed_by` → `staff_wechat_users.employee_id` | NO ACTION | baseline:L572 |

### 已被脚本读但未对接到 PG 的 WorkFine 列

**无**。WorkFine MSSQL 全库无任何 pickup 类语义实体或字段：

- `sys.tables` 名称 LIKE '%pickup%' / '%tihuo%' / '%取货%' → 0 命中
- `sys.extended_properties` 列描述 LIKE '%提货%' / '%取货%' / '%领取%' / '%提取%' / '%家居产品%' → 0 命中

WorkFine 对家居产品的销售只通过 `UDT_M_213.UDF_M_4728`（项目类型）记 "单品" / "自定义-单品"，**没有"已提走多少 / 还剩多少可提"的分次流水概念**。最终迁移没有任何 WorkFine 字段需要承接到 `pickup_records`。

---

## 关键决策摘要

1. **100% 新系统独立**：本模块与 `12/messages`、`10/points`、`08/commission`、`09/coupon`、`16/store-unbind`、`17/system-config` 同属一组——WorkFine 完全无对应实体、迁移阶段无需建立任何 WF→PG 字段映射。
2. **PG 现状 0 行 = 运行时尚未触发**：admin 提货页面已实现完整 UI（`fengyu-admin/src/app/(main)/pickup-records/`），`createPickupRecord` action 已带事务、原子 UPDATE、scope 校验、审计日志，但**5434 至今 0 行**——业务数据本身的家居产品销售明细只有 1 行（`sale_items` WHERE product_type='家居产品'），所以"无可提货物"。
3. **流水型表无 updated_at**：schema 故意省略 `updated_at` 列，与 `point_transactions / card_transactions / messages / operation_logs` 同模式。admin 排序代码处特地写注释标记例外。
4. **`mergeClientProfile` 是唯一 UPDATE 路径**：除 `createPickupRecord` 写入外，admin 顾客合并会 UPDATE `client_user_id` 把孤儿行重挂——但目前 0 行没有合并业务。
5. **架构上无 cloudfunctions 入口**：员工端小程序（staffApi）和客户端（clientApi）均无 pickup 相关 action 路由。**只能从管理后台创建提货记录**，员工端/客户端无入口。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

无需补"未覆盖字段"——WorkFine 无对应实体，PG 表所有列都由 admin runtime 写入，没有任何字段流失。

唯一需要在 `_gaps.md` 留底的运行时风险：

- ⚠️ `pickup_records` 表 **0 行** + `sale_items.product_type='家居产品'` 仅 1 行 — 整条家居产品销售→提货链路在 5434 上没有真实样本，admin 模块代码长期无法被业务数据回归验证；最终迁移如果新增了家居产品 SKU 数据，需要 e2e 跑通 create→pickup 全链路。

---

## Review 报告（2026-04-26）

**Verdict：minor-fix**

**一致项**（13 项）：
- Schema 8 列清单 / 类型 / NOT NULL（PG 5434 information_schema 对齐）
- 约束 `chk_pickup_quantity` + 4 条 FK + 2 条 index（pg_constraint / pg_indexes 对齐）
- pickup_records 行数 = 0
- `sale_items WHERE product_type='家居产品'` = 1 行 / `picked_up_quantity > 0` = 0 行
- WorkFine `sys.tables` LIKE '%pickup%' / '%tihuo%' / '%取货%' = 0 命中
- WorkFine `sys.extended_properties` 含 提货/取货/领取/家居产品 = 0 命中
- admin `createPickupRecord`（pickup-records.ts:284-364）入口属实
- admin `mergeClientProfile` 顾客合并 UPDATE client_user_id（customers.ts:834）入口属实
- DDL 入口：baseline 0000 + archive 0007（CHECK 名修正）属实
- "流水型表无 updated_at" 注释（pickup-records.ts:L125-126 例外标注）属实
- 列级出处行号（schema:L17/L23/L35/L38-40，pickup-records.ts:L232-274/L298-300/L311-320/L334-339）抽样核对一致
- 关键决策 §1（100% 新系统独立）、§2（PG 0 行尚未触发）、§3（流水型无 updated_at）、§4（mergeClientProfile 唯一 UPDATE 路径）均成立
- "无需补未覆盖字段"结论成立（WorkFine 端确实 0 实体）

**不一致项**（2 项，均集中在同一处错配）：

### 1. 错配（重要）— §3 关键决策第 5 条 + 文件头"主要写入入口"列表

**doc 原文**（§3-5）："架构上无 cloudfunctions 入口：员工端小程序（staffApi）和客户端（clientApi）均无 pickup 相关 action 路由。**只能从管理后台创建提货记录**，员工端/客户端无入口。"

**实际**：staffApi 已实现并注册了员工端提货 action：
- 路由注册：`fengyu-staff/cloudfunctions/staffApi/index.js:73` —
  `'order.createPickup': () => require('./routes/order').createPickup`
- 实现位置：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2377-2444` — 函数 `createPickup(ctx)`
  - L2391-2399：UPDATE sale_items SET picked_up_quantity 累加（强制本店 `store_id = $3` + 类型 `'家居产品'`）
  - L2430-2434：INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, remark)
- 副本：`fengyu-staff/CLAUDE.md` 路由表已列出 `order.createPickup`；`staffApi/CLAUDE.md` 同样列出

差异性质：staffApi `createPickup` 与 admin `createPickupRecord` 是**两个并行 INSERT 入口**，业务逻辑同构（原子累加 picked_up_quantity + INSERT pickup_records），但门店来源不同：
- admin：`data.storeId`（表单选择）+ `isInScope` 校验
- staffApi：`ctx.auth.effectiveStoreId`（强制本店，无跨店参数）

文档"唯一业务 INSERT 入口"的结论因此失实。当前未触发是因为员工端小程序前端**尚未实装**调用页面（`grep -rn createPickup fengyu-staff/miniprogram/` = 0 命中），但路由已部署，一旦前端接入即会写入。

### 2. 缺漏（次要）— 与 picked_up_quantity 状态机相关的旁路写入

**doc 未提**：`staffApi createConversion`（order.js:2230-2242）转换单耗尽原"单品"卡时
`UPDATE sale_items SET picked_up_quantity = quantity`，**不创建 pickup_records 行**但直接把
"可提余量"清零。

性质：写入目标是 `sale_items.picked_up_quantity`（属于 01-order 模块），不是 `pickup_records`。
列入此处仅作为同表外部副作用提醒，避免后续读 doc 的人误以为"picked_up_quantity 只能由提货流程累加"。

**P0 评估**：无。staffApi createPickup 路由功能与 admin 等价，schema 列名一致（INSERT 列清单
sale_item_id/pickup_quantity/store_id/client_user_id/confirmed_by/remark 全部存在于 5434），不会
触发"列不存在"型业务永久失效。pickup_records 0 行 + 前端未接入决定它当前并未真实写库。
不写入 _gaps.md P0 章节。

**建议修复**（minor-fix）：
1. 文件头"主要写入入口"补一条 staffApi `routes/order.js:2383-2444`（createPickup）— 标注"已部署但前端未调用"
2. §3 第 5 条改写："架构上 staffApi 已注册 `order.createPickup` 路由（routes/order.js:2377-2444），但员工端小程序前端尚未接入调用页面；clientApi 无 pickup 入口。当前实际写入仅来自 admin。"
3. 列级血缘 `store_id` 一行可补一句："staffApi 入口下该列固定为 `ctx.auth.effectiveStoreId`（强制本店），不接受跨店参数；admin 入口则允许跨店"
4. 关键决策可补 §6："picked_up_quantity 旁路状态机：staffApi createConversion 在转换单耗尽原'单品'卡时直接 UPDATE sale_items.picked_up_quantity = quantity（order.js:L2231-2242），不写 pickup_records 行——这是唯一的非提货语义清零路径。"

---

## Edge Case 报告 R2（2026-04-26）

**Verdict：minor-issues**（PG 端 0 行使大部分维度无法在数据上证伪；唯一确凿严重问题集中在权限/旁路路径）

**8 维度 R2 探针结果**（PG 5434 实测，MSSQL 凭据已过期 → 复用 R1 "WF 无 pickup 实体" 结论）：

| # | 维度 | 命中 | 备注 |
|---|------|------|------|
| 1 | FK 孤立 | 0 | 4 条 FK 全数实存（pg_constraint 校核），probe 全 0 孤儿 |
| 2 | NULL/空串/极值 | 0 | 0 行无可证；schema 上 `pickup_quantity NOT NULL` + `CHECK (>0)` + 4 列 NOT NULL 守住 |
| 3 | enum 漂移 | N/A | 模块无 enum 列 |
| 4 | unique 守住 | 0HIGH | 同 sale_item 多次 pickup **设计允许**（分次提货），无需 unique；同毫秒重复 0 行 |
| 5 | **跨模块一致性** | **2HIGH** | 见 E1 / E2 |
| 6 | **死代码 / 永不命中** | **2** | 见 E3 / E4 |
| 7 | dump-restore drift | 0 | baseline 重置后 chk_pickup_quantity 名称已收敛；archive 0007 已纳归档 |
| 8 | **运行时安全** | **2HIGH** | 见 E5 / E6 |

### E1（HIGH，跨模块一致性）— `picked_up_quantity` 双写一致性已被 staffApi `createConversion` 旁路破坏

- **位置**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2230-2242`（转换单分支 `productType === '单品'`）
- **行为**：`UPDATE sale_items SET picked_up_quantity = quantity` 直接清零原"单品"卡可提余量，**不写 pickup_records 行**
- **不变量破裂**：未来任意时点 `SUM(pickup_records.pickup_quantity GROUP BY sale_item_id) ≤ sale_items.picked_up_quantity` 在转换链上**永久不等**（左 < 右）
- **业务影响**：admin 提货记录列表 `getPickupRecordsPaginated` 100% 漏统计转换单消耗的"单品"卡数量；admin `getAvailablePickupItems` 的"已提数量"展示与"实际提货流水汇总"对不上
- **当前 5434 凭据**：5434 上 `单品` product_type 的 picked_up_quantity 全为 0（10,005 行 `zero_cnt`，0 行 `gt0_cnt`），probe PG.4 `sum_records_lt_picked_up=0` 仅因 pickup_records 0 行 + 转换单也 0 触发；一旦转换业务启动，差值会立刻浮现
- **R1 复核已点名但未升级到 EDGE 段**：本轮 R2 升级为高危一致性问题，并提议加运维 audit SQL（每日检查左 < 右行数）

### E2（HIGH，跨模块一致性）— sum(pickup) 与 picked_up_quantity 应用层校验存在但**无 DB 兜底**

- 现状：admin/staffApi 两个入口的 UPDATE `WHERE (COALESCE(picked_up_quantity,0) + $1) <= quantity` 是**单语句原子守卫**，理论上并发安全
- 缺口：① schema 没有 `CHECK (picked_up_quantity <= quantity)`；② 没有触发器或 partial index 兜底两个入口外的任何手工 UPDATE / 数据迁移脚本（`migrate-history-orders.js` 类回填脚本若误写会绕过两条入口的应用层守卫直接写超量）
- 当前 5434 实测：`picked_up_over_quantity_si = 0`（probe PG.4），暂未发生；属"应用层守住但无最后一道墙"

### E3（MEDIUM，死代码）— staffApi `createPickup` **路由已注册但前端 0 调用**

- 路由：`fengyu-staff/cloudfunctions/staffApi/index.js:73` + 实现 `routes/order.js:2383-2444`
- 验证：`grep -rn "createPickup" fengyu-staff/miniprogram/` = **0 命中**（probe 已确认，文档 R1 复核已记）
- 影响：单测覆盖（`__tests__/routes/order.test.js:3559+` 共 5 个用例）但前端未接入，全链路无任何端到端用例。本轮 R2 复测 fenyu-staff 项目 5434 `operation_logs.target_type='pickup_record'` = 0 / `source='staffApi'` 命中 = 0 行（probe PG.7/PG.13），证实生产从未被触发
- 风险：员工端任意未来一次"加上 createPickup 调用"即直写生产；建议在前端接入前补 e2e 用例 + 至少先在测试 envId 上跑一次

### E4（MEDIUM，死代码）— admin `mergeClientProfile` 重挂 pickup_records.client_user_id 永远命中 0 行

- 位置：`fengyu-admin/src/actions/customers.ts:834`，UPDATE 把孤儿顾客的 pickup_records 行 `client_user_id` 重挂到合并目标
- 验证：5434 `pickup_records` 总 0 行 → 该 UPDATE 永远 rowCount=0
- 风险：未来 pickup_records 长期为空时该路径长期无法回归，迁移阶段如果新增家居产品销售并触发提货后再回头测试合并，**首次有数据的合并**才会真正暴露 bug
- 建议：mergeClientProfile 单测里至少补一个 fixture 模拟有 pickup_records 行的情况

### E5（HIGH，运行时安全）— staffApi `createPickup` **缺角色守卫与权限检查**

- 守卫现状：函数仅调用 `requireStaffBound()` —— 校验"已绑定手机号 + 关联员工档案"，**不要求 manager 角色或任何权限位**
- 对比 admin 入口：`createPickupRecord` 走 `requirePermission(session, 'pickup_record:create')` —— admin/manager 两角色才有此权限（PERMISSION_MATRIX 仅 admin/manager 含 `pickup_record:create`）
- 漏洞利用面：员工端"任意已绑定员工"（含 beautician / 普通门店员工 / 流量客服）都可调用 `order.createPickup` 累加 picked_up_quantity 并写 pickup_records 行（confirmed_by = 自身 staffWfId）。一旦员工端前端接入，即与 admin 端"店长才能提货"的设计权限模型不一致
- 修复：在 createPickup 头部加 `await requireManager()(ctx, async () => {})` 与 `order.create` 等开单接口对齐（参考 order.js 同文件其他函数）

### E6（HIGH，运行时安全）— admin `createPickupRecord` 事务**不写 audit 行的话回滚才会回滚日志**，但**审计日志在事务外**

- 位置：`pickup-records.ts:309-353`
- 行为：`db.transaction()` 块仅含 UPDATE + INSERT pickup_records；`logOperation()` 在 transaction 完成后才执行（L346）
- 影响：极小概率下事务 commit 成功 → 进程崩溃（OOM / pod kill / network timeout）→ logOperation 没写 → operation_logs 缺这一笔，与"全审计要求"模型有 1 行偏差
- 当前 5434 现状：pickup_records=0 行 / operation_logs target_type='pickup_record'=0 行（probe PG.7），双侧空一致；问题尚不可证伪，记入 best-practice gap

### 其他 MS 命中（次要 / 信息）

- **N1（INFO）**：208,050 行 `sale_items` 中 `picked_up_quantity` 实存为 `0`（NOT NULL 默认 0），probe PG.4 的 `picked_up_set_on_non_home=208050` 看似异常，实质无 NULL 列空缺；并非 R2 真实问题。
- **N2（INFO）**：12,972 行 `sale_items.product_name` 命中"盒/瓶/液/霜/精华/喷雾"等家居产品关键词，但仅 1 行被打上 `product_type='家居产品'`（probe PG.10）。这是 04/product 模块的分类问题，pickup 模块只是受害者；如未来上游补全分类，pickup 表会立刻有大量可提货数据，前端若仍未接入会立即出现 admin/staffApi 路径覆盖率不足。
- **N3（INFO）**：MSSQL 凭据已过期（`SD` 用户密码超期），无法本轮独立复现 R1 "WF 0 pickup 实体" 探针，但 R1 双源（`sys.tables` LIKE + `sys.extended_properties`）+ R1 复核独立验证均成立，加之 R1 范围足够覆盖 PK 命名（pickup/tihuo/取货/领取/提取/家居/自提/发货）共 8 套关键字，无需 R2 强行重跑。

---

## 字段扩展建议 R2（2026-04-26）

**前提**：R1 + R1 复核已确认 WorkFine 完全无 pickup 实体；本轮重判结论一致。所有候选字段均**确认无 WF 反向源**（MSSQL 凭据虽不可用，但词典探源 R1 已穷尽 8 套关键字）。

### P0 字段（必须，影响业务正确性 / 数据完整性）

#### 1. `pickup_records.expected_quantity` 或 `sale_items.picked_up_quantity` 上的 `CHECK` 约束

- WF 源：**确认无候选**（不变量层缺失）
- PG 应新增：在 `sale_items` 加 `CHECK (picked_up_quantity <= quantity)`（DDL CONSTRAINT）
- 优先级：**P0**
- 业务理由：当前两条入口靠应用层 `WHERE (COALESCE(picked_up_quantity,0)+$1) <= quantity` 单语句原子守卫，但 staffApi `createConversion` 已绕开此守卫直接 SET = quantity，且 schema 0 兜底；任何 backfill / 一次性 SQL 误写会立即破不变量
- 抽取式：N/A（DDL）
- 数据量：现 0 行违反，加约束零阻塞
- 依赖：先确认 staffApi createConversion 写入路径没有传 `quantity > original.quantity` 的极端值

### P1 字段（重要，提升可用性 / 审计追溯）

#### 2. `pickup_records.sale_order_id`（销售订单冗余快照，避开两跳 JOIN）

- WF 源：确认无候选
- PG 应新增：`varchar(30) NOT NULL`，FK → `sale_orders.sale_order_id`，由 INSERT 路径同时写入
- 优先级：P1
- 业务理由：① admin `getPickupRecordsPaginated` 当前要 `pickup_records → sale_items → sale_orders` 两跳 JOIN 才能展示订单号（已成代码 L122-L123）；② 跨店提货场景下原销售订单门店与提货门店分离，列表/筛选无法直接按"原销售订单"维度查询；③ 退款/转换链路若需联动 pickup 流水，单跳 JOIN 性能优势明显
- 抽取式：`INSERT INTO pickup_records ... sale_order_id = (SELECT sale_order_id FROM sale_items WHERE sale_item_id=$1)`，admin/staffApi 两入口同步加
- 数据量：0 行新增，未来每提货 1 次 +1 行
- 依赖：FK NO ACTION，禁止 sale_orders 在 pickup_records 存在时被删

#### 3. `pickup_records.product_snapshot`（jsonb，记 product_name + sku_spec_name + unit_real_price）

- WF 源：确认无候选
- PG 应新增：`jsonb` 列存 `{productName, skuSpecName, unitRealPrice, productType}`
- 优先级：P1
- 业务理由：admin 列表当前 JOIN 4 张表（sale_items + product_skus + stores + 顾客 + 员工）拉信息，且 product_skus 后续被改名/下架后，旧 pickup 流水会拉到错误的 SKU 名称；快照解耦时间漂移
- 抽取式：INSERT 时 `(SELECT row_to_json(...) FROM sale_items LEFT JOIN product_skus...)`
- 数据量：0 行新增
- 依赖：上线后老数据不补；新增数据从此带快照

#### 4. `pickup_records.delivery_method`（enum：到店自提 / 配送 / 邮寄）

- WF 源：确认无候选（WF 无对应字段，新业务需求）
- PG 应新增：`varchar(20) DEFAULT '到店自提'`
- 优先级：P1
- 业务理由：当前 schema 隐含"到店自提"语义（store_id 必填），但实务上家居产品有"店内自取"和"快递配送"两条业务流；产品规范 admin.pr.spec.md 未定义但实际门店操作存在
- 抽取式：N/A，新建 enum
- 数据量：0 行新增
- 依赖：与产品需求方确认枚举值；admin UI 加单选按钮

#### 5. `pickup_records.delivery_address` + `delivery_phone`（配送地址快照）

- WF 源：确认无候选
- PG 应新增：`text NULLABLE` 各 1 列
- 优先级：P1
- 业务理由：搭配 #4，配送方式下需要邮寄地址；当前完全无字段承接
- 抽取式：admin UI 表单输入
- 数据量：0 行新增
- 依赖：#4 必须先落

#### 6. `pickup_records.confirmed_by_role`（员工角色快照，避免 FK 循环展开）

- WF 源：确认无候选
- PG 应新增：`text NULLABLE`，记 confirmed_by 当时的 manager/staff 角色
- 优先级：P1
- 业务理由：与 02/org_nodes 模块的"员工调店清空 scope"问题对齐：员工调岗后角色变化，回头查历史提货记录无法判断"当时谁有权限做这事"；快照可避免审计困难
- 抽取式：INSERT 时从 `permission_roles` 取主角色
- 数据量：0 行新增
- 依赖：staffApi `requireManager()` 落地后此列才有意义

### P2 字段（可选，未来扩展）

#### 7. `pickup_records.batch_id`（批量提货分组键）

- WF 源：确认无候选
- PG 应新增：`uuid NULLABLE`
- 优先级：P2
- 业务理由：顾客一次提多种家居产品，admin 当前 UI 只支持单条 INSERT；如未来支持"一次性勾选 N 个明细全部提货"，需要 batch_id 串起来便于回滚 / 列表分组
- 抽取式：admin 多选表单 → 同一事务 N 条 INSERT 共享一个 uuid
- 数据量：0 行新增
- 依赖：admin UI 重做

#### 8. `pickup_records.cancelled_at` + `cancelled_by` + `cancel_reason`（撤销提货）

- WF 源：确认无候选
- PG 应新增：3 列，全 NULLABLE
- 优先级：P2
- 业务理由：当前模型只支持"提货 = INSERT"，无任何撤销路径；如顾客提货后发现质量问题原路退回需要回冲 picked_up_quantity，目前只能 backfill SQL
- 抽取式：N/A，新增 admin action `cancelPickupRecord(id, reason)` 事务内反向 UPDATE + 标 cancelled
- 数据量：0 行新增
- 依赖：业务方确认是否需要"无审批的店员撤销"还是要走审批流

#### 9. `pickup_records.client_phone_snapshot`（顾客手机号快照）

- WF 源：确认无候选
- PG 应新增：`varchar(20) NULLABLE`
- 优先级：P2
- 业务理由：client_user_id 可为 NULL（匿名提货），且 client_wechat_users 后续可被合并/改电话；快照保留"当时的联系电话"
- 抽取式：INSERT 时拷贝 `client_wechat_users.phone`
- 数据量：0 行新增
- 依赖：无

### P3 字段（最低优先级 / 信息）

#### 10. `pickup_records.signature_url`（顾客手写签名 URL）

- WF 源：确认无候选
- PG 应新增：`text NULLABLE`（CloudBase COS 文件 URL）
- 优先级：P3
- 业务理由：合规要求顾客签字；当前 0 字段承接
- 抽取式：admin 上传组件 → COS
- 数据量：0 行新增
- 依赖：业务/合规确认是否真需要

### 扩展统计

- **候选总数**：10
- **P0**：1（CHECK 约束）
- **P1**：5（sale_order_id / product_snapshot / delivery_method / delivery_address+phone / confirmed_by_role）
- **P2**：3（batch_id / 撤销三件套 / client_phone_snapshot）
- **P3**：1（signature_url）
- **WF 反推命中**：0（确认无候选；R1 R1复核 R2 三轮一致）


