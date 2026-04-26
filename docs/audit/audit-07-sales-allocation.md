# 审计报告：销售提成分配 sale_allocations (07)

**审计时间**：2026-04-25
**域 ID**：07
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

> 本域聚焦"销售业绩分配"扁平表 `sale_allocations`，covering 三处写入路径（admin batchSave / staff allocation.save / payNotify auto-create）+ 一处 staff suggest 算法 + 三处下游消费（staff todayCommission / performanceDetail / mgmt-dashboard）。**销售提成 commission 实际金额并不存在 sale_allocations 中**——表里 `total_amount` 是"分配业绩营业额"（received × allocation_ratio），真正的提成金额由 commission_rate 在前端二次计算（不持久化）。这与服务提成 service_commissions（域 08）的口径完全不同。

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:196-227` (`saleAllocations`) | ↑ | — |
| 枚举 | `db/schema/enums.ts:18` allocationStatusEnum / `:79` salesCategoryEnum | ↑ | — |
| 矩阵 | `db/schema/commission.ts:9-38` (`commissionRateMatrix`) | ↑ | — |
| Action/Route | `fengyu-admin/src/actions/allocations.ts:1-318`<br>`fengyu-admin/src/actions/commission.ts:1-246` | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:1-481` | — |
| 页面入口 | `fengyu-admin/src/app/(main)/allocations/[orderId]/page.tsx:1-34`<br>`_components/allocation-detail-page.tsx:1-530` | `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts:1-469` | — |
| 自动写入 | `fengyu-admin/src/actions/refunds.ts:837` (refund approve)<br>`fengyu-admin/src/actions/orders.ts:519` (close) | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1087` (close) / `:1531` (approveRefund) | `fengyu-client/cloudfunctions/payNotify/index.js:330-355` (preferred_employee 自动 100%) |
| 下游消费 | `fengyu-admin/src/actions/dashboard.ts:75` | `staff.js:163-202` (todayCommission) / `:457-482` (performanceDetail) / `mgmt-dashboard.js:326,981,1130` | — |
| 测试 | `actions/allocations.test.ts` (532 lines) | — (无 staff 单测) | — |

---

## 2. 数据流图

```
[支付完成]
  payNotify (signed/unsigned, see audit-04)
    ├─ 若 preferred_employee_id 非空 → INSERT 100% allocation per item, role_type=skills[0]||'美容师'
    │   ON CONFLICT uq_sale_alloc_item_emp_role DO NOTHING
    └─ 不修改 sale_orders.allocation_status (= '待分配')

[店长/admin 主动分配]
  staff allocation.save (DELETE then INSERT)            ← UI 提交 commissionRate 当 ratio 会被 reject
  admin allocations.batchSaveAllocations (UPDATE is_void=true then INSERT)
    └─ 同事务 SET sale_orders.allocation_status = '已分配'

[订单生命周期对 allocation 的副作用]
  staff order.close (cancel scenarios)                  ← UPDATE sale_allocations SET is_void=true
  admin order.close (orders.ts:519)                     ← UPDATE sale_allocations SET is_void=true
  staff order.approveRefund (退款单本身)                  ← refund 单 allocation_status='待分配'
                                                          原销售单 allocation 完全不动 (P0!)
  admin refund.approveRefund                            ← 同上 (P0!)

[下游绩效消费]
  staff.todayCommission                ← SUM(sa.total_amount) 当"业绩营业额"
  staff.performanceDetail              ← 列出 sa.total_amount + sa.allocation_ratio
  mgmt-dashboard.staffRanking          ← SUM(sa.total_amount)
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### [P0-07-01] staff 端 save 用 DELETE，admin 用 UPDATE is_void=true — 业绩审计/退款回溯彻底失效
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:86,163,234`（**DELETE**）
  - `fengyu-admin/src/actions/allocations.ts:279`（UPDATE is_void=true, voided_at=NOW()）
  - schema `db/schema/order.ts:213-214`（**显式声明 is_void / voided_at 软删除模型**）
- **现象**：staff `allocation.save` 重新分配前直接 `DELETE FROM sale_allocations WHERE sale_item_id = ANY($1) AND is_void = false`；同样的 staff `deleteAllocation`、空数组 save 也是 DELETE。admin 走 soft delete (is_void=true)。
- **风险**：
  1. 历史分配记录从硬盘消失，**无法回溯"原本分给谁、何时被覆盖"**——schema 设 `voided_at` 列就是为了审计。
  2. 退款 / 关单 流程 (P0-07-02) 需要遍历"曾经分配过的所有 sa 行"统计员工业绩冲销，DELETE 后这条链断裂。
  3. staff 与 admin 在同一资源上并存两种实现，`is_void=true` 历史行只能由 admin 产生 → 数据语义错位（管理后台看到的"已作废"≠ 员工端的"删除前状态"）。
- **复现**：
  1. payNotify 写入一条 100% 分配（员工 A）
  2. 店长打开重分配，分给 B
  3. staff DELETE 旧 A 行 → admin 报表查询"所有 voided 行"看不到 A 的痕迹
- **修复层**：L3（staff allocation.js 三处 DELETE → 改 `UPDATE ... SET is_void=true, voided_at=NOW()`）+ L8（写一次性脚本核对历史 DELETE 数据是否需要补回）

#### [P0-07-02] 退款审批后**原销售单的 sale_allocations 完全不回滚**——员工业绩资损
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1488-1636`（approveRefund）
  - `fengyu-admin/src/actions/refunds.ts:830-870`（同模式）
- **现象**：approveRefund 仅做 4 件事：① 翻转 FY-TKD 状态为 '已支付' + 设 refund 单自身 `allocation_status='待分配'`；② UPDATE 原销售单的 `paid_amount/prepaid_card_amount`；③ 退款单 sale_items 上的 `remaining_sessions` 扣减；④ 写 sale_order_payments 退款行。**完全不对原销售单的 `sale_allocations` 行做任何动作**。
- **风险**（违反 real.md #3 支付幂等，命中 CC1 数值精度）：
  1. 顾客买 1000 元 → 100% 分配给员工 A，sa.total_amount=1000
  2. 顾客退款 600 元 → sale_orders.paid_amount 重算到 400（正确），但 sa.total_amount 依然是 1000
  3. 员工 A 当月业绩 / 提成全部按 1000 计算 → **企业多支付 600 元业绩对应的提成**
  4. spec `db/schema/order.ts:193-195` 明确说"退款业绩 total_amount 为负数" → 但实现既不写新负数行，也不调整原行；spec 与实现脱节
- **修复层**：L3 staff order.approveRefund + L7 admin refunds.approveRefund 加：① 按 refund 比例 INSERT 新 sa 行（total_amount 为负，role_type/employee_id 复制原行）或 ② UPDATE 旧 sa 行 total_amount 按比例缩减；同时 L9 前端绩效页对负数行的展示。

#### [P0-07-03] staff 前端把 commission_rate（如 0.05/0.08）当 allocationRatio 提交 → 后端必拒 INVALID_PARAMS
- **文件**：
  - `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts:448-455`（onSave 构造 payload）
  - `fengyu-staff/miniprogram/packageOrder/utils/allocation-calc.ts:31-46`（lookupRate 返回 commissionRate ∈ rate 矩阵 [0..1)）
  - `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:17,114-117`（VALID_RATIOS = {0.10..1.00}，严格枚举）
- **现象**：UI 自动填充行的 `commissionRate` 来自 `commission_rate_matrix`（典型值 0.05/0.08/0.12 等小于 0.10）。`onSave` 把这个值原样塞到 `allocationRatio`：
  ```ts
  allocationRatio: line.commissionRate,  // L453
  ```
  服务端只接受 {0.10,0.20,…,1.00}，自动建议出来的行**几乎必拒**。
- **风险**：
  1. 店长操作"自动分配"按钮后保存 → 100% 报错"allocationRatio 必须为整十百分比"。
  2. 唯一 work-around 是手动改成 10%/20%——但前端没有 UI 控件让店长把 commissionRate 改成 ratio（字段语义都是 `commissionRate`）。
  3. 与 admin 端语义彻底冲突：admin 把 100% 拆给 1-3 人（ratio = 1.00 / 0.50 / 0.30 等），员工的"提成 = ratio × received × commission_rate"分两步算；staff 端字段命名与计算混淆。
- **复现**：
  1. 店长进入 revenue-allocation 页 → suggest 自动填员工 + commissionRate=0.05
  2. 直接点保存 → toast "INVALID_PARAMS: allocationRatio 必须为整十百分比（0.10~1.00）"
- **修复层**：L9 staff 前端把 `allocationRatio` 与 `commissionRate` 拆成两个独立字段（参考 admin allocation-detail-page.tsx 的 ratioPercent vs commissionRate 双字段设计）+ L3 staff allocation.suggest 在 allocLines 里同时返回这两个字段。

#### [P0-07-04] payNotify 自动写 sa 但**不**置 `allocation_status='已分配'` → 永久卡在"待分配"列表
- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:330-355`
- **现象**：支付回调里若 `targetOrder.preferred_employee_id` 非空，按"100% 分给指定美容师"INSERT N 条 sa 行。**但同事务里 sale_orders.allocation_status 仍是默认 '待分配'**。`allocation.pendingList` (`allocation.js:301-321`) 用 `WHERE allocation_status = '待分配'` 过滤，这种已自动分配过的订单照样出现在店长"待分配列表"。
- **风险**：
  1. 店长 UI 反复看到同一个订单"待分配"，点开后 staff allocation.save 走 DELETE → INSERT 重写，相当于把 payNotify 的自动分配废掉，**业绩归属可能从 preferred_employee 转移到店长选的人**。
  2. 与 admin 的 dashboard.ts:75 "未分配订单数"统计直接污染。
  3. 若店长跳过分配点 onSkipAllocation（payload 空数组），allocation.save 走 DELETE 然后 SET '已分配'——**自动分配的 100% 行被静默删除**，员工业绩归零。
- **修复层**：L3 payNotify 在 INSERT 完 sa 后，对 sale_orders 加 `UPDATE ... SET allocation_status = '已分配' WHERE sale_order_id = $1`（可考虑加 `AND allocation_status = '待分配'` CAS）。

#### [P0-07-05] pendingList / save 不过滤 sale_order_type → 退款单/转换单/回款单进店长分配队列，且 received<0 时金额校验形同虚设
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:301-321`（pendingList）/ `52-68`（save 仅查 status）
- **现象**：
  ```sql
  WHERE o.store_id = $1
    AND o.status = '已支付'
    AND o.allocation_status = '待分配'
  ```
  **没有 `AND o.sale_order_type = '销售单'` 过滤**。退款单审批后被显式置 `allocation_status='待分配'`（order.js:1531） → 出现在 pendingList。retake 转换单/回款单也可能命中。
- **风险**：
  1. 店长打开退款单 → 看到的 sale_items.received 是负数（refund_out 行 received=-amount）
  2. save 校验 `sum > received + AMOUNT_TOLERANCE`：if received=-500，任何正数 sum 都 > -500 + 0.02，校验形同虚设；同时若 sum 仍为负，会把-500 全部分给员工（正向业绩 to negative）。
  3. 转换单的"业绩归属"语义未定义，强行复用销售单分配 UI 极易误操作。
- **修复层**：L3 staff allocation.js pendingList + save + suggest 三处都加 `AND sale_order_type = '销售单'`；负 received 的退款分配走专门通道（P0-07-02 修复方案）。

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-07-06] payNotify role_type 推断逻辑与 staff suggest 不一致
- **文件**：
  - `payNotify/index.js:336-337`：`roleType = skills[0] || '美容师'`（永远只取第一个）
  - `staffApi/routes/allocation.js:444-464`：suggest 对每个 skill **生成一条 allocLine**（员工有 ['美容师','养生师'] 时返回 2 行）
  - `fengyu-admin/src/actions/allocations.ts:111-118`：roleType 缺省时 `skills[0] || '美容师'`（与 payNotify 一致）
- **风险**：payNotify 自动落 1 行 100% 美容师业绩；店长打开后 suggest 给出 2 行（美容师 + 养生师），按 commission_rate_matrix 各拿 5%/8% 等 → 重新保存（save DELETE+INSERT）后，原本的 100% 美容师业绩被拆成两份。两端语义不一致导致同一订单的"自动状态" vs "建议状态"金额不同，员工绩效随店长是否点开"分配页"飘动。
- **修复层**：L3 三处统一 role 推断算法（推荐：默认全 skills 各一行 + payNotify 也走"每个 skill 一行 100%/N"。

#### [P1-07-07] save 流程的 store scope 检查漏洞：管理层模式 effectiveStoreId=null → 全部命中"订单不存在或不属于本门店"
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:53-58, 211-214, 367-372`
- **现象**：所有 SQL 都 `AND store_id = $2`，`$2 = ctx.auth.effectiveStoreId`。当店长以"管理层模式"登录时（multi-store + manager），`effectiveStoreId === null`，PG 会把 `store_id = NULL` 视为 false → 所有订单都"不存在"。
- **波及**：与 audit-05 P1-05-10 / audit-06 P1-06-09 同源。allocation 模块的全部 5 个 method 命中。
- **修复层**：L3 三处用 `buildStoreScopeCondition(ctx.auth, 'store_id', $n)` 替换硬编码 `store_id = $n`（同 audit-05/06 修复模式）。

#### [P1-07-08] 同一订单的 sa 行可被同事务内重复 insert（admin 的 save 单条写入路径）
- **文件**：`fengyu-admin/src/actions/allocations.ts:120-127`（saveAllocation 单条插入，无 batch / 无 (saleItemId, employeeId, roleType) 总和上限校验）
- **现象**：单条 saveAllocation **完全不**校验：
  - 池内比例 ≤ 100%（与 batchSave 不一致）
  - 同 (saleItem, employee, role) 不重复（仅靠 DB unique index 兜底，但报错信息为 "23505" → 提示文案为 "员工信息不存在"，文案错位 line 305）
  - allocationRatio 是否在 [0..1]（admin 不像 staff 校验 VALID_RATIOS）
- **风险**：用 saveAllocation 路径绕开 batchSave 的所有校验；前端如果有"快捷加一行"按钮直接调 saveAllocation，即可写入 ratio=2.5（250%）的非法行。
- **修复层**：L7 admin saveAllocation 移除（保留 batchSave 唯一入口）或同步加 ratio/池/范围校验。

#### [P1-07-09] commission_rate_matrix 命中失败时静默 rate=0
- **文件**：
  - `staffApi/routes/allocation.js:449`：`const commRate = (ratesByRole[role] && ratesByRole[role][salesCat]) || 0`
  - `staffApi/routes/service.js:412-430`：service.complete 在 rate=0 + consumeBase>0 时**有**写 operation_logs `service.complete.rate_missing`
  - allocation.suggest **没有**对应 logs
- **风险**：员工查 staff.todayCommission 看到的是"分配业绩营业额"乘以 1（因 sa.total_amount = received × ratio）；但前端实际算"提成 = received × allocation_ratio × commission_rate"，commission_rate 静默为 0 时员工提成归零，无运维信号。
- **修复层**：L3 在 staff allocation.suggest 命中 commRate=0 时（matrix 该 role/salesCategory/tier 缺失）写 operation_log。

#### [P1-07-10] suggest 算法只用 preferred_employee_id 一人，忽略多员工接单 / 拼班场景
- **文件**：`staffApi/routes/allocation.js:381-465`（suggest 只 resolve preferred_employee_id，没有则不出 allocLines）
- **现象**：spec backend.pr.spec.md §550 "allocation save/list scope" 暗示分配可多员工拆分。**suggest 完全不输出多员工建议**，店长只能从空白开始手动添加。新顾客 / 拼班场景的"美容师 + 养生师 + 推广师"三角色组合需要店长熟知矩阵，否则乱填。
- **修复层**：L3 suggest 引入"门店在职员工 × salesCategory × 矩阵 tier"的 top-N 建议；至少把"门店当日有服务记录的员工"作为候选。

#### [P1-07-11] sale_allocations.allocation_ratio 精度 NUMERIC(5,2) — 1.00 没问题，但 0.05/0.08 等矩阵 commission_rate 不能直接存
- **文件**：`db/schema/order.ts:206`（`numeric("allocation_ratio", { precision: 5, scale: 2 })`）vs spec `backend.pr.spec.md:262` 一致 `numeric(5,2)`
- **现象**：scale=2 仅保留 2 位小数。允许的合法值是 {0.10..1.00}（与 `VALID_RATIOS` 集合一致）。表面合理，但 staff 前端 P0-07-03 错把 commission_rate 当 ratio 写时，0.05 会被 round 到 0.05（仍然存）— 即使 backend 校验，schema 也不能拦住。
- **风险**：单元测试漏掉 `0.05` 写入"成功但语义错误"的边界。建议加 DB CHECK `allocation_ratio IN (0.10,0.20,...,1.00)` 或至少 `allocation_ratio >= 0.10 AND allocation_ratio <= 1.00`。
- **修复层**：L0 加 CHECK（migration 0017）。

#### [P1-07-12] backend.pr.spec.md §2.10 与实际 schema 唯一索引列数不符
- **文件**：
  - spec `.42cog/pm/backend.pr.spec.md:267`：`UNIQUE(sale_item_id, employee_id) WHERE is_void = false`
  - 实际 schema `db/schema/order.ts:222-224`：`uniqueIndex("uq_sale_alloc_item_emp_role").on(saleItemId, employeeId, roleType).where(is_void=false)`
- **现象**：spec 的 unique key 是 2 列，实际是 3 列（多了 role_type）。这影响了"同员工对同 sale_item 是否能同时挂多个角色（美容师 + 养生师）"的语义——按 spec 不允许，按实际允许。
- **修复层**：L0 改 spec（实现优先，多角色场景是合理设计）；同步 audit log 追踪历史。

### 3.3 P2（代码质量 / 可维护）

#### [P2-07-13] staff/admin 双源校验逻辑漂移：MAX_PER_POOL 常量重复定义
- **文件**：`staffApi/routes/allocation.js:17-19` / `fengyu-admin/src/actions/allocations.ts:172-175` / `fengyu-staff/miniprogram/.../revenue-allocation.ts:18`（`MAX_PER_GROUP`）
- **现象**：`VALID_RATIOS` / `MAX_PER_POOL=3` / `AMOUNT_TOLERANCE=0.02` 三处独立定义，未来调整任何一处都要 grep 全仓。
- **修复层**：L0 db/schema/constants.ts 或 sharedHelpers/allocation-rules.ts 统一定义 + L3/L7 复用。

#### [P2-07-14] admin saveAllocation 单条写入路径无对应路由测试，但仍 export
- **文件**：`fengyu-admin/src/actions/allocations.ts:93-135`（saveAllocation 单条 export，actions/__tests__ 无单条测试）
- **现象**：仅 batchSaveAllocations 有完整测试覆盖。saveAllocation 是死路径但仍可被外部 import → 配合 P1-07-08 形成绕过校验路径。
- **修复层**：L7 直接删除（YAGNI）。

#### [P2-07-15] suggest 接口 `deptAnomalous` / `beauticianRequired` 是"向后兼容"残留字段
- **文件**：`staffApi/routes/allocation.js:380-393, 467-477`
- **现象**：注释明确写"向后兼容字段"，前端 revenue-allocation.ts:140 也仅 set/不 use。
- **修复层**：L3 删字段（属 P2，不影响功能）。

#### [P2-07-16] sale_allocations.total_amount 命名误导 — 实际是"分配业绩营业额"，与 service_commissions.commission_amount 语义错位
- **文件**：`db/schema/order.ts:212` (`totalAmount`) vs `db/schema/service-commission.ts` (`commission_amount`)
- **现象**：sale_allocations 存的是 received × allocation_ratio（"业绩营业额份额"），service_commissions 存的是 fee + consume × rate（"实际提成金额"）。**两表 amount 列同样叫 amount/total_amount 但语义完全不同**，跨表 SUM 必算错。
- **修复层**：L0 重命名 sale_allocations.total_amount → sale_allocations.allocated_revenue（数据迁移成本 M）。

#### [P2-07-17] admin 端无人能进入此页面：admin 角色无 'allocation:list/save' 权限
- **文件**：`fengyu-admin/src/lib/permissions.ts:15-37`（admin actions 数组里没有 allocation:*）
- **现象**：注释 line 36 "admin 不碰业务数据" 显式排除。但 manager 角色（线上零数据，因为线上 manager 全是店长在 staffApi 域 + scope）也少见。
- **风险**：admin 后台页 `/allocations/[orderId]` 实际只对 finance（list-only）+ manager（可写）开放。若线上 manager 没正确分配，相当于该页死代码。
- **修复层**：L7 修文档明确 owner（属 P2）。

#### [P2-07-18] verifyOrderScope / verifySaleItemScope 重复实现，不复用 scopeCondition
- **文件**：`fengyu-admin/src/actions/allocations.ts:13-37`
- **现象**：手写 scope 校验，与 `lib/permissions.ts:184` 的 `scopeCondition` 风格不一致。
- **修复层**：L7 改 `and(eq, scopeCondition(...))` 单查询。

---

## 4. 跨端不一致

| 维度 | admin | staff | client/payNotify | 风险 | 优先级 |
|------|-------|-------|------------------|------|--------|
| 删除模式 | UPDATE is_void=true, voided_at=NOW() | **DELETE** (硬删) | INSERT-only with ON CONFLICT DO NOTHING | 审计断裂 / 退款回滚链断 | **P0** |
| sale_order_type 过滤 | scope/list 均不显式过滤 | pendingList/save 全无 type 过滤 | — | 退款单进分配队列 | **P0** |
| role_type 缺省策略 | skills[0] \|\| '美容师' | save: required + 校验; suggest: 全 skills 每个一行 | skills[0] \|\| '美容师' | 自动 vs 手动 vs admin 三套语义 | P1 |
| 分配比例语义 | ratioPercent (0..100) → /100 toFixed(2) | commission_rate（错） → INVALID_PARAMS | 写死 1.00 | UI 提交即拒 | **P0** |
| allocation_status 写入 | batchSave 同事务 set | save 同事务 set；payNotify **不**set | payNotify **不**set | pendingList 永久污染 | **P0** |
| ratio 校验 | VALID_RATIOS（仅 batchSave） | VALID_RATIOS（save） | — | admin saveAllocation 漏校验 | P1 |
| 退款回滚分配 | refunds.approveRefund 不动原 sa | order.approveRefund 不动原 sa | — | **资损：员工业绩多算** | **P0** |
| effectiveStoreId 处理 | scopeCondition + admin 跳过 | 硬编码 store_id = effectiveStoreId | — | 管理层模式空集 | P1 |
| 矩阵命中失败 | 前端 findMatchingRate → 0 | suggest commRate \|\| 0 静默 | n/a | 提成静默归零 | P1 |
| 池上限 | MAX_PER_GROUP=3 | MAX_PER_POOL=3 | — | 跨端常量不共享 | P2 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [ ] **CC1 数值精度**：✗ NUMERIC(5,2) 允许任意 0.00..9.99（本应是 IN VALID_RATIOS）；JS 端用 `Number(x).toFixed(2)` 配合 `parseFloat`，但 Math.round 拼凑 (`allocation.js:119`) 而非 Decimal 库；退款链 sa 不更新（P0-07-02）
- [ ] **CC2 并发幂等**：✗ payNotify 用 ON CONFLICT DO NOTHING 是好的；staff DELETE+INSERT 没有 advisory lock，并发两个 save 可一删一插交错；admin 用事务但同样无 advisory lock
- [ ] **CC3 组织隔离**：✗ staff 5 个方法全部硬编码 `store_id = $effectiveStoreId`（P1-07-07，与 audit-05/06 同源）
- [x] **CC4 后端鉴权**：admin requirePermission + verifyOrderScope ✓；staff requireManager() ✓
- [ ] **CC5 错误码**：✗ admin saveAllocation 返回 `'员工信息不存在'` 实际触发的是 23505（unique 重复）→ 误导
- [x] **CC6 PII**：未发现 sa 写入 PII
- [x] **CC7 时间字段**：DEFAULT NOW() / `$onUpdate` 一致
- [ ] **CC8 WXML/Vant**：staff revenue-allocation.ts UI 与 backend 字段名错位（commissionRate vs allocationRatio）
- [ ] **CC9 测试与残留**：✗ staff allocation.js 无 cloud function 单测；admin allocations.test.ts 无单条 saveAllocation 测试

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/order.ts:206` | 加 `check("chk_alloc_ratio", ratio >= 0.10 AND ratio <= 1.00)` | P1-07-11 |
| L0 schema | `db/schema/order.ts:212` | 重命名 `total_amount` → `allocated_revenue` | P2-07-16 |
| L0 spec | `.42cog/pm/backend.pr.spec.md:267` | unique key 改 (sale_item_id, employee_id, role_type) | P1-07-12 |
| L3 staff | `staffApi/routes/allocation.js:86,163,234` | DELETE → UPDATE is_void=true, voided_at=NOW() | **P0-07-01** |
| L3 staff | `staffApi/routes/allocation.js:53,211,367` | 用 buildStoreScopeCondition 取代 store_id=$n | P1-07-07 |
| L3 staff | `staffApi/routes/allocation.js:307` | + AND sale_order_type = '销售单' | **P0-07-05** |
| L3 staff | `staffApi/routes/order.js:1488` | approveRefund 同事务对原单 sa 写负 total_amount 行 | **P0-07-02** |
| L3 staff | `staffApi/routes/allocation.js:449` | rate=0 时写 operation_logs.allocation.rate_missing | P1-07-09 |
| L3 client | `payNotify/index.js:355` | INSERT sa 后 UPDATE allocation_status='已分配' | **P0-07-04** |
| L7 admin | `actions/allocations.ts:93-135` | 删除 saveAllocation 单条入口（保留 batchSave 唯一） | P1-07-08 / P2-07-14 |
| L7 admin | `actions/refunds.ts:830` | approveRefund 同事务对原单 sa 写负 total_amount 行 | **P0-07-02** |
| L7 admin | `actions/allocations.ts:13-37` | 用 scopeCondition 替换 verifyOrderScope 手写 | P2-07-18 |
| L9 staff UI | `miniprogram/.../revenue-allocation.ts:448-455` | 区分 ratioPercent (0.1..1) 与 commissionRate (≥0)；分别提交 | **P0-07-03** |
| L9 staff UI | `miniprogram/.../revenue-allocation.ts` | 加"分配比例"下拉框（10%~100% 整十） | **P0-07-03** |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- V1 退款单进入"待分配"队列：sale_order_type=退款单 + allocation_status='待分配' 同时存在
SELECT count(*)
FROM sale_orders
WHERE sale_order_type = '退款单'
  AND status = '已支付'
  AND allocation_status = '待分配';

-- V2 payNotify 自动写入但订单卡在"待分配"（preferred_employee_id 非空 + 已支付 + 有 sa 行 + 仍 '待分配'）
SELECT o.sale_order_id, o.allocation_status, o.preferred_employee_id, count(sa.id) as sa_count
FROM sale_orders o
LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
LEFT JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id AND sa.is_void = false
WHERE o.status = '已支付'
  AND o.preferred_employee_id IS NOT NULL
  AND o.allocation_status = '待分配'
GROUP BY o.sale_order_id, o.allocation_status, o.preferred_employee_id
HAVING count(sa.id) > 0;

-- V3 已退款但 sa 未回滚：原销售单 paid_amount 减少但 sa.total_amount 总和不变
SELECT
  o.sale_order_id, o.total_amount, o.paid_amount,
  COALESCE(SUM(sa.total_amount), 0) AS sa_sum,
  COALESCE(SUM(sa.total_amount), 0) - o.paid_amount AS over_allocated
FROM sale_orders o
LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
LEFT JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id AND sa.is_void = false
WHERE o.sale_order_type = '销售单'
  AND o.status = '已支付'
  AND o.paid_amount < o.total_amount   -- 部分退款痕迹
GROUP BY o.sale_order_id
HAVING SUM(sa.total_amount) > o.paid_amount + 0.02
LIMIT 50;

-- V4 sa.allocation_ratio 落入非法值（< 0.10 或 > 1.00）
SELECT count(*) AS illegal_ratio_rows
FROM sale_allocations
WHERE is_void = false
  AND (allocation_ratio < 0.10 OR allocation_ratio > 1.00);

-- V5 退款单的 sa 行（应该不应该存在）
SELECT count(*)
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE o.sale_order_type = '退款单'
  AND sa.is_void = false;

-- V6 staff 硬 DELETE 的副作用：voided_at IS NULL 但 is_void=true（不可能用 staff 路径产出）
SELECT count(*)
FROM sale_allocations
WHERE is_void = true AND voided_at IS NULL;
-- 期望：>0 行说明历史曾用 voided_at 默认 null；=0 行说明 admin 全程走的 NOW()，staff 全是 DELETE 不留痕
```

---

## 8. 回归测试用例（建议）

1. **payNotify 自动分配 + 店长跳过分配 → 业绩归属验证**：preferred_employee_id 已填，确认支付后 sa 自动写入，店长跳过分配（onSkipAllocation），最后 staff.todayCommission 应仍归原员工。
2. **退款 50% → 原销售单 sa 自动按比例缩减**：验证 P0-07-02 修复后 sa.total_amount 比例缩减。
3. **staff allocation.save: 提交 commissionRate=0.05 → 必拒 + 提示文案明确**（不应是"必须为整十"+店长不知所措）。
4. **管理层模式店长**：multi-store manager 切到 management → allocation.pendingList 应返回 scope 内全部门店待分配单。
5. **退款单 sale_order_type='退款单' 不出现在 pendingList**。
6. **DELETE → UPDATE is_void=true 改造后**：批量更新前后查询 voided_at 列均有值。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（admin / staff / payNotify + sale_allocations + sale_orders + commission_rate_matrix）
- 涉及历史数据：☑（DELETE 模式造成的历史业绩痕迹丢失需评估补救）
- 修复成本：M（P0×5 / P1×7 / P2×6；其中 P0-07-02 / P0-07-03 是核心，需要 schema + admin + staff + 前端 4 层联改）

---

## 10. 后续待办

- [ ] 与域 08 (service_commissions) 联动核对：确认 sale_allocations.total_amount 与 service_commissions.commission_amount 在 staff.todayCommission / staff.performanceDetail 中是否被错误同口径加和
- [ ] 与域 11 (退款) 联动：P0-07-02 修复方案在退款链路中的对账方式
- [ ] 与域 17 (数据看板) 联动：mgmt-dashboard.staffRanking 用 SUM(sa.total_amount) 计算"业绩"是否需要根据 P0-07-02 修复后的负数行重新口径
- [ ] 与域 18 (员工绩效) 联动：performanceDetail 对 sa.allocation_ratio 的展示与下游口径对齐
- [ ] 长期：考虑把 `sale_allocations` 改成 immutable append-only（每次重分配 INSERT 新行，原行 is_void=true 而非 DELETE），便于审计追溯
