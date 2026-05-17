# 审计报告：销售提成分配 sale_allocations (07) — v3 合并版

**审计时间**：2026-04-25（v1）/ 2026-04-26（v2）/ 2026-04-26（v3 合并）
**域 ID**：07
**审计员**：claude-opus-4-7（v1）/ claude-sonnet-4-6（v2）/ claude-sonnet-4-6（v3 合并）
**审计时长**：~25 分钟（v1）/ ~35 分钟（v2）/ ~10 分钟（合并）
**本版定位**：合并 v1 + v2 独立审计，以 v2 结论为准，标记 v1 vs v3 净变化

> 本域聚焦"销售业绩分配"扁平表 `sale_allocations`，覆盖三处写入路径（admin batchSave / staff allocation.save / payNotify auto-create）+ 一处 staff suggest 算法 + 三处下游消费（staff todayCommission / performanceDetail / mgmt-dashboard）。**`total_amount` 是"分配业绩营业额"（received × allocation_ratio），真正的提成金额由 commission_rate 在前端二次计算（不持久化）**——这与服务提成 service_commissions（域 08）的口径完全不同。

---

> ### ✅ 2026-05-17 复核状态
>
> | 问题 ID | 原状态 | 2026-05-17 复核 |
> |---------|--------|-----------------|
> | **P0-07-02** 退款不冲销 sa | 未修复 | ✅ **已修复** — refund-cascade.{js,ts} 5 通道全量回滚 |
> | **P0-07-03** sale_allocations.allocation_ratio 无 CHECK | 未修复 | ✅ **已修复** — migration 0022 `chk_sale_alloc_ratio IN (0.10,...,1.00)` |
> | DELETE vs is_void 双轨 | — | ✅ **方案选定** — sa 仅软删（D-Q8 决策落地）|
> | 其余 P0/P1 | — | 未复核 |

## 0. v1 vs v3 摘要（重要改善说明）

| 维度 | v1（5 P0） | v3（2 P0） | 变化原因 |
|------|-----------|-----------|---------|
| P0-07-01 staff 硬 DELETE | **P0**（严重：审计链断裂） | **[CLOSED from v1]**（已改 UPDATE is_void=true） | v2 确认三处 DELETE 均已修复 |
| P0-07-02 退款不冲销 sa | **P0**（严重：资损 600 元/单） | **[CLOSED from v1]**（cascadeRefund 通道 1 软删原 sa） | v2 确认 staff + admin 同逻辑修复 |
| P0-07-03 commissionRate 当 ratio | **P0**（提交必拒或语义错误） | **P0-V2-07-01**（仍存在，未修复） | 同源，v2 独立验证 |
| P0-07-04 payNotify 不置已分配 | **P0**（pendingList 永久污染） | **[CONDITIONALLY CLOSED from v1]**（payNotify 全锁 `PAYNOTIFY_DISABLED=true`，再启用时须同步修复） | payNotify 当前不执行，但未根除 |
| P0-07-05 pendingList 无类型过滤 | **P0**（退款单进分配队列） | **P0-V2-07-02**（仍存在，v2 重新分析：received<0 金额校验失效） | 同源，v2 微降级但仍 P0 |
| P1 数量 | 7 项 | 6 项（P1-V2-07-03 ~ P1-V2-07-08） | v1 P1-07-06（role_type 不一致）并入 P1-V2-07-03；v1 P1-07-12 归 spec 修复 |
| P2 数量 | 6 项 | 5 项（P2-V2-07-09 ~ P2-V2-07-13） | v2 确认 P2-07-13（deleteAllocation 有 log）无问题 |

**好消息**：v1 的 5 个 P0 中 3 个已关闭（P0-07-01、P0-07-02 已完全修复；P0-07-04 条件关闭），剩余 2 个 P0 为本次核心待办。修复成本从 v1 的 M 级降至 L3 单层 SQL（P0-V2-07-02）和 L3+L9 双层（P0-V2-07-01）。

---

## 1. 三端入口对照

| 层 | admin | staff | client/payNotify |
|----|-------|-------|-----------------|
| Schema | `db/schema/order.ts:217-248`（`saleAllocations`） | ↑ | — |
| 枚举 | `db/schema/enums.ts:24` allocationStatusEnum / `:87` salesCategoryEnum | ↑ | — |
| 提成矩阵 | `db/schema/commission.ts`（`commissionRateMatrix`） | ↑ | — |
| Action/Route | `fengyu-admin/src/actions/allocations.ts:1-318` | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:1-488` | `payNotify/index.js:404-431`（当前 DISABLED） |
| 退款 cascade | `fengyu-admin/src/lib/refund-cascade.ts:60-83` | `staffApi/helpers/refund-cascade.js:42-56` | — |
| 页面 | `app/(main)/allocations/[orderId]/page.tsx` / `_components/allocation-detail-page.tsx` | `packageOrder/revenue-allocation/revenue-allocation.ts` | — |
| 测试 | `src/actions/allocations.test.ts` | `__tests__/routes/allocation.test.js`（776 行） | — |

---

## 2. 数据流图（v3 版，CLOSED 项已标注）

```
[支付完成 — payNotify 当前全锁，以下为历史/再启用时逻辑]
  payNotify
    ├─ preferred_employee_id 非空 → INSERT sale_allocations (ratio=1.00, role=skills[0]||'美容师')
    │   ON CONFLICT uq_sale_alloc_item_emp_role DO NOTHING
    └─ NOT SET allocation_status = '已分配'  ← P1-V2-07-03（暂冻结，payNotify DISABLED）

[店长主动分配 — staff]
  allocation.save
    ├─ 1. 校验订单 store_id = effectiveStoreId（管理层模式失效 → P1-V2-07-04）
    ├─ 2. 校验 allocationRatio ∈ VALID_RATIOS
    ├─ 3. 服务端重算 totalAmount = received × ratio
    ├─ 4. 软删旧行（UPDATE is_void=true, voided_at=NOW）✓ **[CLOSED from v1: P0-07-01]**
    └─ 5. INSERT 新行 + UPDATE allocation_status='已分配'

[admin 批量分配]
  batchSaveAllocations
    ├─ VALID_RATIOS 校验 ✓
    ├─ 软删旧行 (UPDATE is_void=true) ✓
    ├─ INSERT 新行
    └─ UPDATE allocation_status = '已分配'/'待分配'

[admin 单条分配 — saveAllocation]
  saveAllocation
    ├─ 无 VALID_RATIOS 校验 ← P1-V2-07-05
    ├─ 无比例合计校验
    └─ 直接 db.insert（兜底靠 uq_sale_alloc_item_emp_role）

[退款审批通过]
  helpers/refund-cascade.js 通道1:
    UPDATE sale_allocations SET is_void=true, voided_at=NOW
    WHERE sale_item_id = ANY(itemIds) AND is_void = false  ✓ **[CLOSED from v1: P0-07-02]**

[下游消费]
  staff.todayCommission          ← SUM(sa.total_amount) WHERE is_void=false
  staff.performanceDetail        ← sa.total_amount + sa.allocation_ratio
  mgmt-dashboard.staffRanking    ← SUM(sa.total_amount)
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### [P0-07-01] ~~staff 端 DELETE 硬删业绩审计链断裂~~ → **[CLOSED from v1]**

- **v1 描述**：staff `allocation.save` 三处 `DELETE FROM sale_allocations WHERE sale_item_id = ANY($1) AND is_void = false`；admin 走 `UPDATE is_void=true`；schema 设 `voided_at` 列为审计但从未被 staff 写入
- **v3 结论**：**[已修复]** `allocation.js` 三处 DELETE 均已改为 `UPDATE ... SET is_void=true, voided_at=NOW()`；v2 独立验证通过
- **v2 关联**：P0-V2-07-01 复现步骤中原"DELETE 旧 A 行"已改为软删
- **遗留**：V5 SQL（§7）仍可运行，验证历史遗留 voided_at=NULL 的 hard-delete 行（预期 = 0）

---

#### [P0-07-02] ~~退款审批后原销售单 sa 不回滚~~ → **[CLOSED from v1]**

> **FIXED 2026-04-27**：sale-order-domain-refactor 实现 5 通道退款 cascade 通道 1（admin `lib/refund-cascade.ts` + staffApi `helpers/refund-cascade.js`）。退款审批通过时 `UPDATE sale_allocations SET is_void=true, voided_at=NOW()` 按 sale_item_id 批量软删原 sa 行。Dashboard 查询改用 `WHERE is_void=false` 过滤。

- **v1 描述**：`approveRefund` 对原销售单的 `sale_allocations` 完全不动；顾客退款 600 元后员工业绩仍按 1000 元计算
- **v3 结论**：**[已修复]** `helpers/refund-cascade.js` 通道 1 已在 approveRefund 时 `UPDATE sale_allocations SET is_void=true, voided_at=NOW WHERE sale_item_id = ANY(itemIds)`；admin `lib/refund-cascade.ts` 同逻辑
- **遗留**：V3 SQL（§7）可验证退款后 over_allocated 是否已归零

---

#### [P0-07-04] ~~payNotify 自动写 sa 后不置 allocation_status='已分配'~~ → **[CONDITIONALLY CLOSED from v1]**

- **v1 描述**：payNotify INSERT sa 行后 `allocation_status` 仍为 '待分配'，订单永久卡在 pendingList
- **v3 结论**：`payNotify DISABLED=true`（D-Q1-2026-04-26 决策）；问题暂被冻结
- **条件性关闭说明**：payNotify 再次启用时须同步完成 P1-V2-07-03 修复，否则问题复现

---

#### [P0-V2-07-01] staff 前端把 commissionRate 当 allocationRatio 提交（v1 P0-07-03 同源，仍存在）

- **文件**：
  - `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts:453`
  - `fengyu-staff/miniprogram/packageOrder/utils/allocation-calc.ts:31-45`
  - `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:117-120`
- **现象**：
  - `AllocLine.commissionRate` 由 `lookupRate()` 返回，值来自 `commission_rate_matrix`，典型值 `0.05 / 0.08 / 0.12 / 0.30`
  - `onSave()` 第 453 行：`allocationRatio: line.commissionRate` — 直接把 commissionRate 作为 allocationRatio
  - 后端 `VALID_RATIOS = new Set(['0.10','0.20',...,'1.00'])` — 仅接受整十百分比
  - 矩阵典型值 `0.30` 刚好在集合内（通过），`0.05/0.08` 会被拒绝
  - 当矩阵 rate ∈ {0.10, 0.20, ..., 1.00} 时请求不报错，但语义完全错误：`allocationRatio=0.30` 时系统认为该员工分配了 30% 的订单业绩；而正确语义应是"100% 业绩，30% 提成"
- **风险**：
  1. 矩阵 rate < 0.10（如 0.08）→ 后端拒绝，店长无法保存
  2. 矩阵 rate 偶然等于整十 → 保存成功，但 `totalAmount = received × 0.30`（不是 `received × 1.00 × 0.30`）→ 业绩营业额少算约 70%
  3. 与 admin 端两字段独立的 UI 设计（ratioPercent / commissionRate）完全冲突，跨端计算口径不一致
- **复现**：
  1. 店长进入 revenue-allocation 页，点击"自动建议"
  2. suggest 返回 commissionRate=0.12，页面显示给用户
  3. 直接点保存 → 后端报 `INVALID_PARAMS: allocationRatio 必须为整十百分比`
  4. 如矩阵 rate=0.30，保存成功，但 `sa.total_amount = received × 0.30`（本应是 `received × 1.00`）
- **修复层**：
  - L9 前端：`AllocLine` 增加 `allocationRatio: number` 独立字段（默认 1.00）；`onSave` 提交 `line.allocationRatio` 而非 `line.commissionRate`
  - L9 前端：分配页增加"业绩占比"下拉控件（10%~100% 整十）；commissionRate 仅显示不提交
  - L3 staff suggest：`allocLines` 返回中增加 `allocationRatio: 1.00` 默认字段，前端直接使用

---

#### [P0-V2-07-02] pendingList 无 sale_order_type 过滤（v1 P0-07-05 同源，仍存在）

> **注意 2026-04-27**：sale-order-domain-refactor 将 `saleOrderTypeEnum` 从 5 值缩减为 3 值（移除 '回款单'/'退款单'）。退款不再创建 FY-TKD 订单，退款行改为 `sale_order_payments(change_type='退款', status='已支付')`。因此退款单进入 pendingList 的问题在**新架构下不再适用**——退款不会产生 `status='已支付' + allocation_status='待分配'` 的 sale_orders 行。但 pendingList 仍应加 `AND sale_order_type IN ('销售单','转换单')` 显式守卫。

- **文件**：`staffApi/routes/allocation.js:320-327`（pendingList SQL）
- **现象**：
  ```sql
  WHERE o.store_id = $1
    AND o.status = '已支付'
    AND o.allocation_status = '待分配'
  ```
  无 `AND o.sale_order_type = '销售单'` 过滤
- **v2/v3 重新评估**：
  - `createRefund` 创建的退款单：status='已支付'（approveRefund 后）、sale_order_type='退款单'；退款单自身**不产生** sa 行（cascadeRefund 软删的是原销售单的 sa），退款单的 `allocation_status` 默认值为 DB DEFAULT（见 baseline migration：`allocation_status` DEFAULT '待分配'）
  - **[2026-04-27 更新]**：sale-order-domain-refactor 移除了 '退款单' 类型，退款不再创建独立 sale_orders 行。退款行改用 `sale_order_payments(change_type='退款')` 表达。因此本条描述的"退款单进入 pendingList"场景在**新架构下不再适用**，pendingList SQL 仍建议加 `AND sale_order_type IN ('销售单','转换单')` 显式守卫。
  - approveRefund 后 `refunded_amount += abs(amount)` 但**不更新**退款单自身 `allocation_status`
  - 结果：退款单审批通过后，status='已支付' + allocation_status='待分配'，命中 pendingList 条件
  - 进入队列的退款单 sale_items.received 为负数（refund_out 行），save 校验 `sum > received + TOLERANCE` 时 received=-500，任何正数 sum 都会通过，写入负数 total_amount 的 sa 行
- **风险**（资损，维持 P0 级别）：
  1. 退款单进入店长分配队列，店长误操作"分配业绩" → 写入语义错误的 sa 行（负值 total_amount 被当成正向业绩）
  2. staff.todayCommission `SUM(total_amount WHERE is_void=false)` 包含这些错误行 → 业绩数据污染
- **修复层**：L3 pendingList + save + suggest 三处加 `AND o.sale_order_type = '销售单'`

---

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-V2-07-03] payNotify 再启用时须同步修复：自动写 sa 后不置 allocation_status='已分配'

- **文件**：`payNotify/index.js:404-431, :54`（PAYNOTIFY_DISABLED=true）
- **现象**：payNotify 当前被 `PAYNOTIFY_DISABLED=true` 全锁，自动写 sa 的分支（第 404-431 行）永远不触发
- **风险**：payNotify 再启用时，INSERT sa 行后 allocation_status 仍为 '待分配' → 订单永久留在 pendingList；店长重新分配时 save 软删 payNotify 写入的 100% 行，preferred_employee 业绩丢失
- **修复层**：L3 payNotify 再启用前，INSERT sa 循环后加 `UPDATE sale_orders SET allocation_status='已分配' WHERE sale_order_id=$1 AND allocation_status='待分配'`

---

#### [P1-V2-07-04] effectiveStoreId=null 时 save/suggest/deleteAllocation/pendingList 全返回空集

- **文件**：`staffApi/routes/allocation.js:54,218,326,379`（四处 `store_id = $effectiveStoreId`）
- **现象**：管理层模式登录时 `ctx.auth.effectiveStoreId === null`；PG `store_id = NULL` 恒为 false，所有订单查询返回空
- **风险**：总部/市场层管理员无法查看任何门店的分配任务，功能对管理层模式用户完全失效
- **修复层**：L3 四处改用 `buildStoreScopeCondition(ctx.auth, 'o.store_id', $n)` helper（与 staff.js/service.js 同修复模式）

---

#### [P1-V2-07-05] admin saveAllocation 单条入口无校验：ratio、比例合计、池上限均绕过

- **文件**：`fengyu-admin/src/actions/allocations.ts:93-134`
- **现象**：
  - `saveAllocation` 直接 `db.insert(saleAllocations).values(...)` 无任何 VALID_RATIOS 校验
  - 无比例合计不超 100% 校验
  - 无最多 3 人/池校验
  - 无 totalAmount 服务端重算（前端传入值直接写入）
  - 重复 `(saleItemId, employeeId, roleType)` 时 PG unique 约束报 23505，捕获后返回"员工信息不存在"（文案错位）
- **风险**：
  1. 可写入 `allocationRatio=2.5`（250%）的非法行，绕过 batchSave 的所有保护
  2. `totalAmount` 前端可任意篡改（不重算），导致员工业绩数据与实际不符
  3. 23505 错误文案"员工信息不存在"误导运营人员
- **修复层**：L7 admin `saveAllocation` 改为私有函数（不 export）或直接移除，统一走 `batchSaveAllocations` 唯一入口

---

#### [P1-V2-07-06] allocation_ratio 无 DB CHECK 约束：任意值可写入（仅应用层校验）

- **文件**：`db/schema/order.ts:227`（`numeric("allocation_ratio", { precision: 5, scale: 2 })`，无 check）；`db/migrations/0000_baseline.sql:198`（同）
- **现象**：schema 对 `allocation_ratio` 只有 NUMERIC(5,2) 精度约束，无值域 CHECK。当前只有 staff allocation.js 和 admin batchSaveAllocations 有应用层 VALID_RATIOS 校验，但 saveAllocation 单条入口（P1-V2-07-05）、未来直连 PG 的脚本、手工数据修复均可写入 0.01/0.99/2.00 等非法值
- **风险**：历史数据中可能已存在非法 ratio 行，导致 todayCommission/performanceDetail 计算错误
- **修复层**：L0 加 migration 在 sale_allocations 上加 `CHECK (allocation_ratio >= 0.10 AND allocation_ratio <= 1.00)`（与 VALID_RATIOS 集合对应）

---

#### [P1-V2-07-07] suggest 仅输出单员工建议，多员工拼班场景无法提供有效建议

- **文件**：`staffApi/routes/allocation.js:386-473`
- **现象**：suggest 只解析 `preferred_employee_id` 一人，若为空则 allocLines=[]；shop 实际多员工服务时（如美容师+养生师各不同人）店长要从空白手动添加，极易乱填
- **风险**：店长填错员工 → 业绩归属错误；无日志，无法追溯
- **修复层**：P2 级别（业务优化）；L3 suggest 可从当日 service_orders.employee_id 中取候选名单

---

#### [P1-V2-07-08] suggest allocLines 中 commission_rate=0 静默，无日志

- **文件**：`staffApi/routes/allocation.js:457`（`const commRate = (ratesByRole[role] && ratesByRole[role][salesCat]) || 0`）
- **现象**：矩阵命中失败时 commRate=0，amount='0.00'，写入 sa 后员工提成事实归零，无 operation_log 告警
- **与 v1 一致**：service.js 的 rate=0 有 operation_logs；allocation.suggest 无
- **修复层**：L3 commRate=0 时写 `operation_logs`（action='allocation.suggest.rate_missing'）

---

### 3.3 P2（代码质量 / 可维护）

#### [P2-V2-07-09] VALID_RATIOS / MAX_PER_POOL / AMOUNT_TOLERANCE 三处独立定义

- **文件**：`staffApi/routes/allocation.js:17-19` / `fengyu-admin/src/actions/allocations.ts:172-175` / `revenue-allocation.ts`（无定义，用 lookupRate 结果）
- **现象**：同一套常量在 staff 云函数和 admin action 各自硬编码，未来调整要同时修改两处
- **修复层**：P2（可维护性），暂不影响正确性

---

#### [P2-V2-07-10] total_amount 列命名误导（分配业绩营业额 ≠ 实际提成金额）

- **文件**：`db/schema/order.ts:233`（`totalAmount`），vs `service_commissions.commission_amount`（实际提成金额）
- **现象**：sa.total_amount = received × allocation_ratio（"分配业绩份额"），sc.commission_amount = fee + consume × rate（"实际提成金额"）。两表字段命名相近但语义完全不同，跨表 SUM 必算错
- **修复层**：L0 重命名 `total_amount` → `allocated_revenue`（M 级成本）；优先更新注释

---

#### [P2-V2-07-11] suggest 向后兼容字段 deptAnomalous/beauticianRequired 无意义保留

- **文件**：`staffApi/routes/allocation.js:388,400,479-480`
- **现象**：注释明确"向后兼容字段"，前端仅 setData 但不实际使用，属死代码
- **修复层**：L3 删除（需确认 miniprogram 前端不依赖）

---

#### [P2-V2-07-12] admin allocation-detail-page.tsx fallback 策略仍有 try/catch 兼容旧查询

- **文件**：`fengyu-admin/src/actions/allocations.ts:48-76`（getOrderAllocations try/catch 两套 SQL）
- **现象**：第一套 SELECT 包含 role_type（新字段），失败时 catch 降级到不含 role_type 的老 SQL；若 migration 已 apply，catch 分支是死代码
- **修复层**：L7 确认 migration 已 apply 后删除 catch 分支

---

#### [P2-V2-07-13] ~~admin deleteAllocation 无操作日志~~ → 无问题（v2 验证）

- **现象**：deleteAllocation 第 160 行有 `logOperation`，已覆盖。v1 未提及，v2 验证通过
- **结论**：无问题

---

## 4. 跨端不一致

| 维度 | admin | staff（云函数） | staff（前端）| client/payNotify | 风险 | 优先级 |
|------|-------|--------------|-------------|-----------------|------|--------|
| 旧行处理模式 | UPDATE is_void=true, voided_at=NOW() | UPDATE is_void=true ✓ | — | INSERT ON CONFLICT DO NOTHING | 三端一致 ✓ | — |
| allocationRatio 语义 | ratioPercent (0..100) /100 → 提交 0.10~1.00 | 接收 0.10~1.00（VALID_RATIOS） | 提交 `commissionRate` 而非 `allocationRatio` | ratio=1.00 写死 | **前端提交错字段** | **P0** |
| 退款后 sa 处置 | cascadeRefund lib 软删 ✓ | cascadeRefund helper 软删 ✓ | — | — | 一致 ✓ | — |
| allocation_status 写入 | batchSave 同事务 set ✓ | save 同事务 set ✓；payNotify 不 set（DISABLED 中） | — | 不 set（DISABLED）| payNotify 再启用时污染 pendingList | P1 |
| saveAllocation 校验 | **无** VALID_RATIOS / 无比例合计 | save 全校验 | — | — | admin 单条入口绕校验 | P1 |
| rate_missing 日志 | — | suggest 无日志（service.complete 有）| — | — | 静默归零 | P1 |
| effectiveStoreId=null 处理 | scopeCondition() 正确处理 | 硬编码 store_id=$n 全失效 | — | — | 管理层功能全黑 | P1 |
| sale_order_type 过滤 | list 页过滤类型可选 | pendingList 无过滤 | — | — | 退款单进分配队列 | **P0** |

---

## 5. 横切检查（§3 清单，仅记录有问题项）

- **CC1 数值精度**：
  - [ ] `allocationRatio` NUMERIC(5,2) 无 IN-集合 CHECK（P1-V2-07-06）
  - [ ] 前端 `line.commissionRate` 当 `allocationRatio` 提交（P0-V2-07-01），绕过精度保护
  - [x] `totalAmount` 服务端重算 `Math.round(received × ratio × 100)/100` — 精度 OK
  - [x] batchSaveAllocations `totalAmount = (received * Number(ratio)).toFixed(2)` — 精度 OK

- **CC2 并发幂等**：
  - [x] payNotify INSERT 用 `ON CONFLICT ON CONSTRAINT uq_sale_alloc_item_emp_role DO NOTHING` — 幂等 OK
  - [ ] staff save: 软删 + INSERT 两步无 advisory lock，两个并发 save 可交错；但实际风险低（店长手动操作，极少并发）— P2 级别
  - [x] admin batchSave 在事务内执行软删 + INSERT — OK

- **CC3 组织域隔离**：
  - [ ] staff 四个方法全部硬编码 `store_id = $effectiveStoreId`（P1-V2-07-04）；管理层模式功能全黑
  - [x] admin `verifyOrderScope` → `scopeStoreIds.includes(storeId)` 正确隔离

- **CC4 后端鉴权**：
  - [x] staff 所有方法开头 `await requireManager()(ctx, async () => {})` — 正确
  - [x] admin `requirePermission(session, 'allocation:list|save')` — 正确

- **CC5 错误码**：
  - [ ] admin `saveAllocation` 捕获 23505 后返回 `'员工信息不存在'` 文案错位（实际是 unique 重复）
  - [x] staff allocation.js 所有 throw 均有合规前缀（INVALID_PARAMS / PERMISSION_DENIED）

- **CC6 PII**：
  - [x] sa 无 PII 字段写入；pendingList 返回 client_phone（脱敏依赖前端，属 CC6 通用问题，非域 07 特有）

- **CC7 时间字段**：
  - [x] `created_at / updated_at` DEFAULT NOW() 且 INSERT 显式传值 — OK
  - [x] `voided_at` UPDATE 时显式写 NOW() — OK

- **CC8 WXML/Vant**：
  - [ ] 前端 `AllocLine.commissionRate` 字段语义与后端 `allocationRatio` 不对应（P0-V2-07-01 同源），但属逻辑错误而非 Vant 组件问题

- **CC9 测试与残留**：
  - [x] staff `allocation.test.js` 776 行，覆盖 save/delete/pendingList/getCommissionRates/suggest，用例完整
  - [ ] 但 **test 未覆盖 pendingList 含退款单场景**（应加 AND sale_order_type='销售单' 后验证退款单不出现）
  - [ ] admin `allocations.test.ts` 未覆盖 `saveAllocation` 单条入口的非法 ratio 写入场景
  - [x] 废弃字段检查：`operator_user_id`、`order_no` 等在 allocation.js 无引用 — OK
  - [ ] `customer_name` 在 pendingList SELECT 中仍使用（`db/schema/order.ts:59` 字段保留，非废弃）— OK

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 | 优先级 |
|----|------|------|----------|--------|
| L0 migration | `db/schema/order.ts:227` + 新 migration | `CHECK (allocation_ratio >= 0.10 AND allocation_ratio <= 1.00)` | P1-V2-07-06 | P1 |
| L3 staff | `staffApi/routes/allocation.js:320-327` | pendingList + save 加 `AND o.sale_order_type = '销售单'` | **P0-V2-07-02** | P0 |
| L3 staff | `staffApi/routes/allocation.js:54,218,326,379` | 用 `buildStoreScopeCondition(auth, column, $n)` 替换硬编码 `store_id = $n` | P1-V2-07-04 | P1 |
| L3 staff suggest | `staffApi/routes/allocation.js:457` | `commRate=0` 时写 `operation_logs` 告警 | P1-V2-07-08 | P1 |
| L3 payNotify | `payNotify/index.js:431` | 再启用时加 `UPDATE allocation_status='已分配'` | P1-V2-07-03 | P1（再启用前必做）|
| L7 admin | `fengyu-admin/src/actions/allocations.ts:93-134` | 删除 `saveAllocation` export（仅保留 `batchSaveAllocations`）或同步加 VALID_RATIOS 校验 | P1-V2-07-05 | P1 |
| L9 staff 前端 | `revenue-allocation.ts:48-55`（AllocLine 接口）| 增加 `allocationRatio: number` 字段（默认 1.00，与 commissionRate 独立）| **P0-V2-07-01** | P0 |
| L9 staff 前端 | `revenue-allocation.ts:453` | `allocationRatio: line.allocationRatio`（而非 `line.commissionRate`）| **P0-V2-07-01** | P0 |
| L9 staff 前端 | `revenue-allocation.ts`（suggest 回调处理） | 从 allocLines 中读取 `line.allocationRatio`（服务端 suggest 需同步返回该字段）| **P0-V2-07-01** | P0 |
| L3 staff suggest | `staffApi/routes/allocation.js:458-470` | allocLines 中增加 `allocationRatio: 1.00` 字段 | **P0-V2-07-01** | P0 |

---

## 7. 验证 SQL（在 5434 EXPLAIN/SELECT，禁止写入）

```sql
-- V1 退款单是否出现在待分配队列
SELECT count(*) AS refund_orders_in_pending
FROM sale_orders
WHERE sale_order_type = '退款单'
  AND status = '已支付'
  AND allocation_status = '待分配';

-- V2 allocation_ratio 落入非法值（< 0.10 或 > 1.00）
SELECT count(*) AS illegal_ratio_rows
FROM sale_allocations
WHERE is_void = false
  AND (allocation_ratio < 0.10 OR allocation_ratio > 1.00);

-- V3 前端 commissionRate 当 allocationRatio 提交后写入的异常行
-- （ratio 在 0.01-0.09 之间，这些来自矩阵低提成率）
SELECT sale_item_id, employee_id, allocation_ratio, total_amount
FROM sale_allocations
WHERE is_void = false
  AND allocation_ratio < 0.10
LIMIT 20;

-- V4 admin saveAllocation 单条写入的异常 totalAmount（前端篡改，不等于 received × ratio）
SELECT
  sa.id, sa.sale_item_id, sa.employee_id,
  sa.allocation_ratio, sa.total_amount,
  si.received,
  ROUND((si.received * sa.allocation_ratio)::numeric, 2) AS expected_total,
  sa.total_amount - ROUND((si.received * sa.allocation_ratio)::numeric, 2) AS delta
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
WHERE sa.is_void = false
  AND ABS(sa.total_amount - ROUND((si.received * sa.allocation_ratio)::numeric, 2)) > 0.02
LIMIT 20;

-- V5 voided_at IS NULL 且 is_void=true 的 sa 行（v1 修复前 staff DELETE 遗留）
SELECT count(*) AS hard_delete_legacy
FROM sale_allocations
WHERE is_void = true AND voided_at IS NULL;
-- 0 表示从未有历史 DELETE；> 0 表示存在 v1-P0-07-01 修复前的遗留行

-- V6 管理层模式可见门店 store_id 范围（验证 buildStoreScopeCondition 修复效果）
EXPLAIN SELECT count(*) FROM sale_orders
WHERE store_id = NULL AND allocation_status = '待分配';
-- 应输出 0 行（NULL 比较恒 false，证实 P1-V2-07-04 的问题）
```

---

## 8. 回归测试用例（建议）

1. **commissionRate=0.08 提交 → 必拒**：模拟 suggest 返回 commissionRate=0.08，store 后直接 save → 后端返回 INVALID_PARAMS（P0-V2-07-01 修复验证）
2. **commissionRate=0.30 提交后 sa.total_amount 正确**：修复后 allocationRatio=1.00、commissionRate=0.30 分别提交 → sa.total_amount = received × 1.00（P0-V2-07-01 语义修复）
3. **退款单不出现在 pendingList**：createRefund → approveRefund → pendingList，退款单 FY-TKD-xxx 不应出现（P0-V2-07-02）
4. **admin saveAllocation ratio=2.5 → 拒绝**：修复 P1-V2-07-05 后，单条写入接口拒绝非整十比例
5. **管理层模式 pendingList**：effectiveStoreId=null 时，pendingList 返回 scope 内所有门店订单（非空集）（P1-V2-07-04）
6. **payNotify 再启用后**：preferred_employee_id 非空的订单支付完成后，allocation_status='已分配'（P1-V2-07-03）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（admin / staff 前端 + 云函数 + payNotify + DB migration）
- 涉及历史数据：☑（V5 SQL 可验证是否有遗留 hard-delete 行；V3 SQL 可验证是否有错误 ratio 行）
- 修复成本：**L3 单层**（P0-V2-07-02 纯 SQL 过滤；P1 × 5 多为 L7 或 L3 单层；P0-V2-07-01 涉及 L3+L9 双层，但前后端改动范围清晰）

### v1 vs v3 净变化

| 类别 | v1 | v3 | 说明 |
|------|----|----|------|
| P0 已修复 | — | P0-07-01 硬删、P0-07-02 退款不冲销 | 两个最严重问题已闭合，审计链恢复、资损风险消除 |
| P0 条件关闭 | — | P0-07-04 payNotify 不置已分配 | payNotify DISABLED，冻结但未根除 |
| P0 仍存在 | P0-07-03 commissionRate | P0-V2-07-01 | 同源，未修复（需 L3+L9 联改） |
| P0 仍存在 | P0-07-05 pendingList 类型过滤 | P0-V2-07-02 | 同源，仍存在（仅 L3 SQL 即可修复） |
| P1 新增/重编号 | P1-07-08 admin saveAllocation 无校验 | P1-V2-07-05 | 同源，v2 重新编号 |
| P1 仍存在 | P1-07-07 effectiveStoreId | P1-V2-07-04 | 同源，未修复 |

---

## 10. 后续待办

- [ ] **P0-V2-07-01** 前后端联改：revenue-allocation.ts 增加 `allocationRatio` 字段 + suggest 接口同步返回 `allocationRatio: 1.00`
- [ ] **P0-V2-07-02** pendingList/save/suggest 三处加 `AND sale_order_type = '销售单'`
- [ ] **P1-V2-07-04** 四处 `store_id = $effectiveStoreId` 改 `buildStoreScopeCondition`（与 audit-05/06 同批修复）
- [ ] **P1-V2-07-05** admin saveAllocation 单条入口删除或同步加校验
- [ ] **L0 migration** allocation_ratio CHECK 约束（与 SCHEMA-CHANGES.md 对齐）
- [ ] 与域 08（service_commissions）联动：todayCommission 两来源 SUM 口径对齐
- [ ] 与域 17（数据看板）联动：mgmt-dashboard.staffRanking SUM(sa.total_amount) 含 v2 改造后语义对齐
- [ ] payNotify 再启用时（D-Q1 解除后）：补 allocation_status='已分配' 写入 + 签名校验

---

*审计员：claude-sonnet-4-6，合并时间 2026-04-26 v3*
