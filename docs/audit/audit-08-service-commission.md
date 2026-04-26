# 审计报告：服务提成 service_commissions (08)

**审计时间**：2026-04-25
**域 ID**：08
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

> 本域聚焦服务单完成时按"固定手工费 + 消耗比例"双字段模型写入的 `service_commissions` 表（`db/schema/service-commission.ts:16-51`）。它是与销售提成 `sale_allocations`（域 07）平行但口径**不同**的体系：sa 存"分配业绩营业额"（business amount），sc 存**实拿提成金额** `commission_amount = fixed_fee + consume_amount`。三端入口收敛到两条写入链路（`staff service.complete` 自动写 + `admin batchSaveServiceCommissions` 手工覆盖），加 1 处只读详情页（`admin getServiceOrderCommissions`）。**client 不参与**。

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/service-commission.ts:16-51`（`serviceCommissions`，含 `chk_svc_comm_fixed_fee/consume_amount` + `uq_svc_comm_item_emp_role WHERE is_void = false`） | ↑ | — |
| 矩阵 | `db/schema/commission.ts:9-38`（`commissionRateMatrix`，含 `org_id` 维度） | ↑ | — |
| 自动写入 | — | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:388-450`（`complete` 内 per-item INSERT） | — |
| 手工覆盖 | `fengyu-admin/src/actions/service-commissions.ts:72-182`（`batchSaveServiceCommissions`：先 UPDATE is_void=true 再 INSERT） | — | — |
| 列表/分配入口 | `fengyu-admin/src/app/(main)/allocations/page.tsx:17-23`（tab='service' → `getServiceOrdersPaginated({status:'已完成'})`） | — | — |
| 分配详情页 | `fengyu-admin/src/app/(main)/allocations/service/[serviceOrderId]/page.tsx:1-35` + `_components/service-commission-detail-page.tsx:1-537` | — | — |
| 完成动作（不写 sc） | `fengyu-admin/src/actions/services.ts:333-396 completeServiceOrder` **未触发任何 sc 写入** | `staff service.js:286-475`（写入主路径） | — |
| 下游消费 | `fengyu-admin/src/actions/dashboard.ts`（依赖 sa，未读 sc） | `staff routes/staff.js:484-526 performanceDetail`、`mgmt-dashboard.js:340-355 queryServiceCommissionIncome`、`mgmt-dashboard.js:1140-1162 staffRankingIncome` | — |
| 测试 | `actions/service-commissions.test.ts`（5 用例，仅池校验） | `staffApi/__tests__/routes/service.test.js:704-893`（含 rate=0 + skills 兜底） | — |

---

## 2. 数据流图

```
[完成服务单]
  staff.service.complete (manager 或本人):
    ├─ 一次 JOIN 拿全 service_items + sale_items.service_fee/sales_category + staff_wechat_users.skills
    ├─ for 每行：
    │    fixedFee     = service_fee × session_used                     -- 固定手工费快照
    │    consumeBase  = unit_real_price × session_used                  -- 消耗业绩
    │    rate         = SELECT commission_rate FROM commission_rate_matrix
    │                       WHERE order_type='服务单' AND role_type=skills[0]||'美容师'
    │                         AND sales_category=$ AND amount_tier_min<=$ AND ...
    │                       ORDER BY amount_tier_min DESC LIMIT 1                -- ⚠️ 缺 org_id 过滤
    │                  默认 0；ON 命中失败 + consumeBase>0 → operation_logs(rate_missing)
    │    consumeAmt   = consumeBase × rate
    │    commAmt      = fixedFee + consumeAmt
    │    INSERT sc (allocation_ratio=1.00, role_type=skills[0]||'美容师', is_void=false)
    │      ON CONFLICT uq_svc_comm_item_emp_role DO NOTHING                       -- 幂等
    └─ UPDATE service_orders SET status='已完成', completed_at=NOW(),
                                  commission_status='已分配' (CAS WHERE status='服务中')

  admin.completeServiceOrder (services.ts:333-396):
    └─ ⚠️ 只翻状态 + 扣次数；**完全不写 service_commissions，也不更新 commission_status**

[手工重新分配]
  admin.batchSaveServiceCommissions (service-commissions.ts:72-182):
    ├─ 校验 ratio ∈ {0.10..1.00}、(item × roleType) 池 ≤3、池内合计 ≤100%、池内员工不重复
    ├─ tx：UPDATE sc SET is_void=true WHERE service_item_id IN(...) AND is_void=false
    │      INSERT 新 sc 行（来自前端：commissionRate / commissionAmount 由 UI 二次计算后传入）
    │      UPDATE service_orders SET commission_status = (新数组非空 ? '已分配' : '待分配')

[下游消费]
  staff.performanceDetail (staff.js:497-526):
    SUM(sc.commission_amount) WHERE sc.is_void=false AND so.status='已完成' AND service_date 在区间内
  mgmt-dashboard.queryServiceCommissionIncome (mgmt-dashboard.js:340-355):
    SUM(sc.commission_amount) WHERE role_type IN('美容师','养生师') AND so.status='已完成'
  staff.todayCommission (staff.js:150-220):
    ⚠️ 只读 sale_allocations，完全不读 service_commissions → "今日分成"漏算服务提成

[退款 / 取消]
  staff.order.approveRefund / admin.refunds.approveRefund:
    ⚠️ 完全不动 service_commissions（与 audit-07 P0-07-02 同源缺陷的服务侧）
  staff.service.cancel (only '待服务'/'服务中' → '已取消')：
    ⚠️ 已完成的服务单无 cancel 路径（只读 commission 永久存在；与 sa 无 void 同步机制）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### [P0-08-01] `staff.complete` 查询 commission_rate_matrix **缺 `org_id` 过滤** → 跨市场误命中错误费率（资损）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:401-411`
- **现象**：
  ```js
  SELECT commission_rate FROM commission_rate_matrix
  WHERE order_type = '服务单'
    AND role_type = $1
    AND sales_category = $2
    AND amount_tier_min <= $3
    AND (amount_tier_max IS NULL OR amount_tier_max >= $3)
  ORDER BY amount_tier_min DESC LIMIT 1
  ```
  `commissionRateMatrix.orgId`（schema `db/schema/commission.ts:14` + 唯一索引 `db/schema/commission.ts:30-37` 含 orgId）是矩阵的核心维度——admin 提成矩阵页 (`commission-page.tsx:73-90`) 强制按"市场 Tab"切换。staff 端查询**完全忽略 orgId**，从所有市场的费率行里抓一条。`ORDER BY amount_tier_min DESC LIMIT 1` 在多个市场都有匹配时，会取 amount_tier_min 最大的一条（任意市场），与服务单实际归属市场无关。
- **风险**（real.md 未直接列条目，但属于"资损 / 价格快照不可变 P0"等价类）：
  1. 多市场组织（项目 v3.0 已支持 headquarters > market > store 三级）下，A 市场的服务单按 B 市场费率结算 → 员工提成 / 财务对账系统性偏移；
  2. ORDER BY amount_tier_min DESC 让结果非确定性（同一 service_order_id 重复 complete 会因为矩阵偶发更新或写入顺序变化拿到不同 rate；若另起事务重新跑则可能违反 commission 快照语义）；
  3. 与 admin 前端 `findMatchingRate`（service-commission-detail-page.tsx:41-56）显式按 `r.orgName === marketName` 过滤的口径**不一致** → 同一服务单在 admin 详情页看到的 rate 与 staff 自动写入的 rate 不同。
- **复现**：
  1. PG 中插入两个市场的费率行：`(orgA, '服务单', '美容师', '自销自耗', 0, 1000, 0.05)` 与 `(orgB, '服务单', '美容师', '自销自耗', 500, NULL, 0.30)`
  2. 在 orgA 门店完成服务单 (consumeBase=600)
  3. 期望 rate=0.05（orgA 行命中），实际 LIMIT 1 + ORDER BY amount_tier_min DESC 返回 orgB 行 rate=0.30 → consumeAmount 翻 6 倍
- **修复**：(L3) 在 staff.complete 加载 service_orders 之后取 `so.market_name`，反查 `org_nodes.id` 后传入 SQL；或一次 LATERAL JOIN 把 org_id 维度带入。修复样板：
  ```js
  // 在 ctx.auth 已含 marketName 的情况下，先一次性查 marketOrgId
  const orgRows = await pg.query(
    "SELECT id FROM org_nodes WHERE type='市场' AND name = $1 LIMIT 1",
    [so.market_name || ctx.auth.marketName]
  )
  const marketOrgId = orgRows[0]?.id
  // SQL 加 AND org_id = $X
  ```

#### [P0-08-02] `admin.completeServiceOrder` 完全不写 `service_commissions`，admin 路径下提成永久缺失
- **文件**：`fengyu-admin/src/actions/services.ts:333-396`
- **现象**：admin 完成服务单仅做：
  1. CAS 翻状态 `WHERE status='服务中'`；
  2. CTE `deduct` 原子扣减 `sale_items.remaining_sessions`；
  3. logTransition('service.complete')。
  **完全不**触发 service_commissions 写入，也不写 `commission_status`。staff.complete 同动作会按 per-item × per-employee 写完整提成 + 置 `'已分配'`。
- **风险**：admin 后台触发的服务完成（含运营补单 / 紧急完成场景），员工提成永久 0；与 staff.complete 路径下口径完全错位。命中 audit-05 已记录的 P0-05-06，本域作为提成域的"原罪重述"再次锁定，需要单独修复路线图（不能仅在域 05 修）。
- **修复**：(L7) 把 staff.complete 内的 commission 计算抽到 `db/helpers/service-commission.ts`（admin/staff 共用）；admin.completeServiceOrder 完成 CTE 后调该 helper。或异步：admin 完成只置 `commission_status='待分配'`，由 cron/后台任务批跑写入。后者适合 admin 偶尔代办、staff 主路径仍同步写的混合方案。

#### [P0-08-03] rate 矩阵命中失败 → **静默写入 commission_rate=0 + 状态推 '已分配'**，运维补完矩阵后无回扫机制
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:412-450`
- **现象**：
  - `const rate = Number(rateRows.rows[0]?.commission_rate || 0)` — 缺规则 → 0
  - rate=0 + consumeBase>0 时仅写一条 `operation_logs.action='service.complete.rate_missing'`，**INSERT 仍照常写**（`commission_amount = fixedFee + 0`）
  - 同事务 `service_orders.commission_status = '已分配'`（line 454）
  - 唯一索引 `uq_svc_comm_item_emp_role WHERE is_void=false`（service-commission.ts:44-46）阻止后续以同 (service_item_id, employee_id, role_type) 重新插入
  - 全仓 grep 无任何 cron / admin 工具检测 `commission_rate=0 AND consume_amount=0 AND fixedFee 隐含 only` 行后回扫
- **风险**（直接资损）：
  1. 矩阵补完前完成的服务单永久按 0 入账（员工绩效 / 月度日历少计），与 audit-05 P0-05-05 同根但本域要把"无回扫"作为独立 P0 升级；
  2. `commission_status='已分配'` 让 admin 服务提成 tab (`allocations-page.tsx:171`) 在 UI 上显示"查看分配"而非"分配"，店员/财务不会主动重新分配；
  3. service_commissions 行已存在 → admin.batchSaveServiceCommissions 可手工覆盖（先 UPDATE is_void=true 再 INSERT），但需要人工识别哪些行 rate=0；目前**没有任何 admin 页面 / 报表暴露这些 rate=0 行**。
- **修复**：(L3/L7) 任选一：
  - 选项 A（推荐）：staff.complete 检测到 `rate=0 && consumeBase>0` 时 **不写 sc**，置 `commission_status='待分配'`，admin allocation tab 走人工分配（与 sa pendingList 体验一致）；
  - 选项 B：仍写 sc 但置 `commission_status='待分配'`（让 UI "查看分配"切回"分配"），并新增 `service_commissions.needs_recompute` 标志位 + admin cron 回扫；
  - 选项 C：保留现状但**强制阻塞** complete（业务受影响，不推荐）。

#### [P0-08-04] 退款审批后**不冲销 service_commissions**（资损，与 audit-07 P0-07-02 平行）
- **文件**：
  - `fengyu-admin/src/actions/refunds.ts:830-960 approveRefund`：仅翻 FY-TKD 状态 + 扣 `sale_items.remaining_sessions` + 储值卡回冲；**完全不动** `service_commissions`
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js approveRefund`：同源同症
- **现象**：顾客购卡 1000 元 → 完成 1 次服务（扣 1 次，提成入账）→ 全额退款。退款单仅扣 sale_items.remaining_sessions（让卡可以"退完"），但已写入的 `service_commissions` 行（fixed_fee + consume_amount）**永久留存**。
- **风险**（直接资损 + 违反 real.md #2 价格快照不可变扩展含义）：
  1. 员工拿了"已退款"服务的提成，企业付双倍成本；
  2. 财务对账时 `SUM(service_commissions.commission_amount) > 实际服务收入`；
  3. 与 sale_allocations 同源缺陷叠加 → 同一笔退款，员工销售提成 + 服务提成都不冲销。
- **修复**：(L3 + L7) staff.order.approveRefund + admin.refunds.approveRefund 同事务：
  ```sql
  -- 方案 A：将该退款单关联的 service_items 上所有 sc 行作废
  UPDATE service_commissions sc SET is_void = true, updated_at = NOW()
  WHERE service_item_id IN (
    SELECT sit.service_item_id FROM service_items sit
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    WHERE si.sale_order_id = $refSaleOrderId  -- 原销售单
       OR si.ref_sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $refSaleOrderId)
  )
  -- 方案 B：INSERT 负数行（与建议中 sale_allocations 退款方案对齐）
  ```
  注意：schema **没有 `voided_at` 列**（schema/service-commission.ts:16-51 不存在），需补 schema（见 §6 L0）。

#### [P0-08-05] schema 不存在 `voided_at` 列 + admin batchSave 用 `is_void=true` 软删但缺时间戳，审计断裂
- **文件**：`db/schema/service-commission.ts:16-51` + `fengyu-admin/src/actions/service-commissions.ts:144-149`
- **现象**：
  - schema 仅 `is_void boolean default false`，无 `voided_at timestamp`；
  - admin batchSave 在 tx 内 `UPDATE service_commissions SET is_void = true ...`，**没有 voided_at 时间戳**
  - 与 sale_allocations 设计对比：`db/schema/order.ts:213-214` 显式声明 `is_void` + `voided_at` 双字段；admin sa batchSave (allocations.ts:279) 写 voided_at=NOW()
- **风险**：
  1. 审计无法回答"哪一行被谁、何时作废"——staff/admin 都没办法从 sc 行重建时间线；
  2. P0-08-04 修复（退款冲销）落地时无法记录"是退款触发的作废"vs"店长重新分配触发的作废"；
  3. 与 audit-07 sale_allocations 双轨修复方向相反：sa 已经有 voided_at，sc 反而没有。
- **修复**：(L0) 补 migration 添加 `voided_at timestamp NULL`，admin/staff 所有 `SET is_void = true` 语句同事务写 voided_at=NOW()。

#### [P0-08-06] `roleType` 推断三处算法**完全分裂**：admin / staff / payNotify 三套 → 同一服务单口径漂移
- **文件**：
  - `staff service.js:395-396`：`const roleType = skills[0] || '美容师'`（永远只取第一个 skill）
  - `admin service-commission-detail-page.tsx:88-95`：`if (skills.includes('推广师')) skillTag='推广师'; else if (skills.includes('养生师')) skillTag='养生师'; else skillTag='美容师'`（**优先级反过来**——推广师 > 养生师 > 美容师）
  - admin 自由选择：UI 提供 `SKILL_TAGS = ['美容师','养生师','推广师']` 下拉，可任填
- **现象**：员工 skills=['美容师','推广师'] 时：
  - staff 自动写 sc.role_type='美容师'
  - admin 重分配页打开同一行 → init 时按 admin 算法把已存在行的 roleType 显示为'推广师'（line 88: `if (skills.includes('推广师'))`），并按"推广师"费率重新匹配 commission_rate_matrix（findMatchingRate 用 roleType='推广师'）；保存时把 sc 的 role_type 改为'推广师'
  - 同一服务单的"自动入账"vs"店长查看后保存"金额会不同
- **风险**：员工业绩随店长是否点开"分配页"飘动；与 audit-07 P1-07-06（payNotify 同样问题）形成跨域同根类问题。
- **修复**：(L0/L3/L7) 三处统一推断算法。建议放到 `db/helpers/role-resolve.ts`（admin/staff 共用），优先级语义需业务确认（"美容师 > 养生师 > 推广师"或反向）。

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-08-07] `staff.todayCommission` 完全不读 `service_commissions` → "今日分成"漏算服务提成
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:150-220`
- **现象**：todayCommission 的 `today_amount` / `lastMonthAmount` 全部 SUM(sa.total_amount)。员工端 Tab 1"工作台 → 今日分成"卡片显示的金额仅含销售提成业绩。`staff.performanceDetail` (line 484-526) 与 `mgmt-dashboard` 已用 service_commissions，唯独 todayCommission 漏掉。
- **风险**：员工日常 KPI 体感与月度绩效详情对不上账（同一员工，工作台金额 < 绩效页明细加总）。
- **修复**：(L3) todayCommission 加并行查询 sc.commission_amount，按 staffWfId+today/lastMonth 区间汇总叠加。

#### [P1-08-08] `service_commissions` 无 `service_order_id` 索引 / 列；管理后台查询用 IN(SELECT) 子查询，易退化
- **文件**：`db/schema/service-commission.ts:43-49`（仅 `idx_svc_comm_employee_id`） + `service-commissions.ts:34-45 + 142-149`
- **现象**：sc 表只通过 `service_item_id → service_items.service_order_id` 二级跳转。admin getServiceOrderCommissions / batchSaveServiceCommissions / 退款 helper 都需要"根据 service_order_id 找 sc 行"，子查询 `WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id = $1)` 在 service_items 量级大时退化。无 `service_order_id` 冗余列与索引。
- **风险**：CC2 性能 + P0-08-04 退款冲销将更频繁查询，加剧瓶颈。
- **修复**：(L0) 二选一：(a) 补冗余列 `service_order_id text` + 索引；(b) 在 `service_items.service_order_id` 上建索引（已有 `idx_svc_items_order_id` service.ts:78-79，OK）；当前命中 (b) 最够，但子查询写法仍可优化为 EXISTS。

#### [P1-08-09] `commission_status` 枚举 / 状态语义在 admin / staff 不一致
- **文件**：
  - schema `db/schema/service.ts:38`：`commissionStatus: allocationStatusEnum('commission_status')`（沿用 sa 的枚举：`待分配 / 已分配`，db/schema/enums.ts:18）
  - staff service.complete 写 '已分配'（service.js:454），即使 rate=0 + consumeBase>0
  - admin batchSave 写 `commissions.length > 0 ? '已分配' : '待分配'`（service-commissions.ts:166）→ 空数组 = '待分配'，含分配 = '已分配'，**忽略"无需分配"语义**
  - admin allocations-page.tsx:171 默认值兜底 '待分配'，UI 文案"分配"vs"查看分配"按 commissionStatus 切换
- **现象**：
  1. rate=0 静默写入后状态='已分配'，UI 显示"查看分配"，店员看不到风险信号；
  2. 空 array 重保存 → '待分配'，但实际数据库里仍有历史 sc 行（is_void=true）→ 状态语义模糊（"无需分配"vs"重置等待"）；
  3. allocationStatusEnum 与 sa 共用，未来扩 'auto-assigned' / 'pending-recompute' 时需考虑跨表语义。
- **修复**：(L0) 把 `commission_status` 从 allocationStatusEnum 拆出独立 `serviceCommissionStatusEnum`，加值 `已分配 / 待分配 / 部分分配 / 待重算`；(L3/L7) 三处写入路径同步。

#### [P1-08-10] admin batchSave 不校验 `serviceItemId` 已被作废的 sc 行幂等冲突
- **文件**：`fengyu-admin/src/actions/service-commissions.ts:142-167`
- **现象**：流程是 `UPDATE is_void=true ... → INSERT 新行`。唯一索引 `uq_svc_comm_item_emp_role WHERE is_void=false` 不会阻止重新 INSERT，但若用户在客户端**未变更**（同 employee+role）仅修改 ratio，新行 INSERT 会成功，但旧行变成 is_void=true 永久"幽灵"占位。同 (service_item, employee, role) 历史多次重分配会留下 N 行 is_void=true。审计上 OK，但若加 voided_at 后仍无 `voided_by` / `void_reason`，无法区分"店长改主意"vs"退款冲销"。
- **修复**：(L0) 加 `voided_at` + `voided_by` + `void_reason` 三列（与 sale_allocations 一致），void_reason 枚举建议 `'重新分配' / '退款冲销' / '订单取消'`。

#### [P1-08-11] `service.complete` 写入 sc 时 ON CONFLICT DO NOTHING → 重复 complete 时**新数据被丢弃**而非更新
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:432-449`
- **现象**：唯一索引 `uq_svc_comm_item_emp_role WHERE is_void = false`。若服务单已完成（commission_status='已分配'），管理员 → '服务中' 改写状态后再 complete 一次（如修复扣次错误），sc 行已存在 → ON CONFLICT DO NOTHING 跳过新值。新的 fixed_fee/consume_amount 计算结果**不会覆盖**旧行。但 service_orders.completed_at 不会被覆盖（CAS WHERE status='服务中'），整体语义看似"幂等"，实际 sc 旧值锁死。
- **风险**：极端运维场景（如 service_fee 配置改了，店长想重算）下管理员需要先 UPDATE is_void=true 才能重写。**没有任何路径暴露这一点**，店员只会看到"完成了但金额没变"。
- **修复**：(L3) 选 (a) ON CONFLICT DO UPDATE（让重 complete 覆盖）；(b) 文档化"重 complete 不重算 sc，需走 admin batchSave 重新分配"；(c) 加 admin 工具按钮"重算服务提成"（推荐）。

#### [P1-08-12] `service_commissions.allocation_ratio` precision NUMERIC(5,2)；写入语义混乱
- **文件**：`db/schema/service-commission.ts:29`（`numeric('allocation_ratio', { precision: 5, scale: 2 })`）+ staff service.complete 硬写 1.00（service.js:438）+ admin 写 0.10..1.00 整十值（service-commissions.ts:69, 108）
- **现象**：
  1. staff 自动写永远 1.00（一行覆盖一个 employee × role），admin 手工分配可写 0.10..1.00
  2. 唯一索引 `(service_item_id, employee_id, role_type) WHERE is_void=false` 让"同员工同角色多行 ratio 加总"在 schema 层面**不可能**——意味着多人池场景下，admin batchSave 的 (poolEntries.length > 3 / sum>100%) 校验是基于 (service_item_id, role_type) 池，在唯一索引层只能容纳 (item × emp × role) 三元组各 1 行
  3. 与 sale_allocations.allocation_ratio NUMERIC(5,2) 一致，但 sa 没有强制 1.00 默认，sc 实际唯一约束让 ratio 只能在"单 employee × 单 role × 单 item"内表达
- **风险**：精度合理但默认值与 admin 校验组合下，多人共服一项的提成拆分语义模糊。
- **修复**：(L0) 加 `chk_svc_comm_ratio CHECK (allocation_ratio IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00))`；(L3) staff.complete 默认 1.00 仅在"单人完成"场景，多人场景需依赖 admin batchSave 修订（spec 要求确认）。

#### [P1-08-13] `service_commissions` 不存 `org_id` / `store_id` / `service_date` 快照 → 跨期对账依赖 JOIN
- **文件**：schema `db/schema/service-commission.ts`（仅有 service_item_id / employee_id / role_type，无 org/store/date）
- **现象**：所有 dashboard / 绩效查询都需要 `JOIN service_items → service_orders` 才能拿到 store_id + service_date。3 跳 JOIN 在数据增长后是性能负担；当 service_orders 改店（如同店升级）时也无法保留事件时点的归属。
- **风险**：CC2 性能 + 历史口径漂移；P1。
- **修复**：(L0) 补 `service_date date`、`store_id text`、`org_id text` 三列（写入时同事务 INSERT 快照）；(L3) staff.complete 写入时填这些字段。

#### [P1-08-14] admin batchSave 把 `commissionRate` / `commissionAmount` 由前端传入并直接持久化，不在后端二次校验
- **文件**：`fengyu-admin/src/actions/service-commissions.ts:78-81 + 152-161`
- **现象**：commissions[i].commissionRate / commissionAmount 由 service-commission-detail-page.tsx:510-512 前端计算（`(Number(allocAmount) * commRate).toFixed(2)`）后传入。后端不重算 / 不与 commission_rate_matrix 二次比对。
- **风险**：恶意 admin 用户（或 BUG）可篡改 commissionAmount → 任意金额入账（CC4 后端鉴权弱化 + real.md #5 后端统一鉴权违背）。
- **修复**：(L7) 后端按 `(service_items.unit_real_price × session_used) × allocationRatio × commission_rate(matrix 命中)` 重算并以服务端值入库；前端传入仅作 hint。

### 3.3 P2（代码质量 / 可维护）

#### [P2-08-15] `staff.complete` 内 commission 计算 N+1（per-item 一次 commission_rate_matrix 查询）
- **文件**：`service.js:401-411`
- **现象**：每个 service_item 独立查 matrix。10 个 item → 10 次 RTT 在事务内串行。
- **修复**：(L3) 一次拼接 `WHERE (role_type, sales_category, amount_tier_min) IN (...) ` 用 LATERAL JOIN，或事务前批量查 rateMap。

#### [P2-08-16] `commission_rate_matrix.role_type` / `order_type` / `sales_category` 用 varchar(20) 而非 enum
- **文件**：`db/schema/commission.ts:17-19`
- **现象**：全部 varchar(20)，无 DB 层 enforce。staff 端写 '服务单' / '美容师' 全靠业务约定。
- **风险**：未来加值时（如新 role_type='营养师'）无法跨表 enforce + 全仓 grep。
- **修复**：(L0) varchar → enum 迁移（与 audit-07 ENUM-AUDIT E07-sales-category 同诉求）。

#### [P2-08-17] admin commission tab 用 `getServiceOrdersPaginated({status:'已完成'})` 不按 `commissionStatus` 筛选
- **文件**：`fengyu-admin/src/app/(main)/allocations/page.tsx:18-23`
- **现象**：tab='service' 仅过滤 status='已完成'。已分配 / 待分配混在一起，列表只能靠 UI badge 区分。staff sa 用 `pendingList` 路由专门筛选 `allocation_status='待分配'`，admin sc 缺等价路由。
- **风险**：店员每次进 admin allocation tab 看到完整全列表，对"待分配"识别效率低。
- **修复**：(L7) getServiceOrdersPaginated 加 `commissionStatus?: '待分配'|'已分配'` 过滤；UI 加 sub-tab。

#### [P2-08-18] `service.complete` rate_missing operation_log 的 `source='staffApi'` 与其他模块命名不统一
- **文件**：`service.js:419-430`
- **现象**：与 audit-05 P2-05-20 同源——其他模块或 cron 用 'cronTask' / 'staff_api'，无统一规范。
- **修复**：(L3) 全仓约定 'staffApi' / 'staff_api'/'admin'/'cronTask' 字面值并文档化。

#### [P2-08-19] admin batchSave 错误码 `'员工信息不存在，请检查后重试'` 实际触发可能是 23503 (FK)，文案错位
- **文件**：`fengyu-admin/src/actions/service-commissions.ts:170-173`
- **现象**：catch err.code === '23503' → 返回"员工信息不存在"，但 23503 也可能是 service_item_id FK 失败（虽前置校验通常拦住）。错误前缀不在约定 4 项内。
- **修复**：(L7) 区分 FK 类型 + 前缀加 `INVALID_PARAMS:`。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 完成动作是否写 sc | **完全不写** | 写（per-item × per-employee） | — | admin 路径下提成永久缺失 | **P0** |
| 矩阵查询过滤维度 | findMatchingRate 含 `marketName` | **不含 org_id** | — | 跨市场误命中费率 | **P0** |
| roleType 推断 | `推广师>养生师>美容师` | `skills[0]\|\|'美容师'` | — | 同员工同服务单，admin 看到的角色 ≠ staff 自动写入 | **P0** |
| rate=0 处理 | 前端显示 0% 红色 placeholder | 静默写入 + opLog | — | 静默资损，无提示无回扫 | **P0** |
| 退款冲销 sc | refunds.approveRefund 不动 | order.approveRefund 不动 | — | 退款后提成不冲销 | **P0** |
| voided_at 列 | 无（admin 仅 SET is_void=true） | 无 | — | 审计断裂（与 sa 双轨） | **P0** |
| commission_status 写入 | 空数组 → '待分配'，否则 '已分配' | 永远 '已分配'（即使 rate=0） | — | 状态语义模糊 | P1 |
| commission_rate / commissionAmount 由谁算 | 前端算后传后端持久化 | 后端按 matrix 实时算 | — | admin 后端不二次校验 → 篡改可能 | P1 |
| todayCommission 是否含 sc | n/a | **不含**（只看 sa） | — | 员工"今日分成"漏算 | P1 |
| ratio 默认 | 整十范围 0.10..1.00 | 永远 1.00 | — | 多人池场景表达不一致 | P1 |
| 错误前缀 | 中文文案，无前缀 | INVALID_PARAMS / PERMISSION_DENIED | — | CC5 不一致 | P2 |

---

## 5. 横切检查（套用 §3）

- [ ] **CC1 数值精度**：sc 列 NUMERIC(10,2) / (5,4) 合规；JS 端 `Math.round(x*100)/100` ✓；但 P1-08-14 admin batchSave 不二次校验金额，前端浮点字符串可被篡改。
- [ ] **CC2 并发幂等**：`uq_svc_comm_item_emp_role WHERE is_void=false` ✓；ON CONFLICT DO NOTHING 满足重 complete 幂等但 P1-08-11 牺牲了"重算"语义。
- [ ] **CC3 组织域隔离**：`mgmt-dashboard.queryServiceCommissionIncome` 用 buildSaleScope ✓；但 staff.performanceDetail 用 sc.employee_id = $1 直接过滤，无 store/org 维度（员工跨店调动后历史归属不变，OK）；**P0-08-01 矩阵查询缺 org_id 是 CC3 子集**——读取费率时未按市场隔离。
- [ ] **CC4 后端鉴权**：staff.complete `requireStaffBound() + manager 或本人` ✓；admin verifyServiceOrderScope ✓；但 P1-08-14 admin batchSave 不重算 → 弱化 CC4 含义。
- [ ] **CC5 错误码**：admin 全部中文裸文案（"分配比例必须为整十..."、"员工信息不存在..."）；staff 用 INVALID_PARAMS / PERMISSION_DENIED ✓。CC5 命中。
- [x] **CC6 PII**：sc 表无 PII；operation_logs.detail 写 service_item_id / serviceOrderId 不含 PII。
- [ ] **CC7 时间字段**：`createdAt / updatedAt` defaultNow + $onUpdate ✓；但**无 `voided_at`** → P0-08-05；P1-08-13 缺 service_date 快照导致跨期对账依赖 JOIN。
- [x] **CC8 WXML/Vant**：本域 client 不参与，staff 端无界面对应（仅 service.complete 流程触发）。
- [ ] **CC9 测试与残留**：admin service-commissions.test.ts 仅 5 个池校验用例，无 voided_at / org_id / 退款冲销断言；staff service.test.js 含 rate=0 写入用例（line 814-843）但断言 commission_amount=80 即"接受静默写入"——**测试反向锁死了 P0-08-03 错误行为**，需要修测试。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/service-commission.ts` + 新 migration | 加 `voided_at timestamp NULL`、`voided_by varchar(30) NULL`、`void_reason varchar(20) NULL`、`service_date date NULL`、`store_id text NULL`、`org_id text NULL` | P0-08-04, P0-08-05, P1-08-10, P1-08-13 |
| L0 schema | `db/schema/service.ts` | 拆 `commission_status` 出独立 `serviceCommissionStatusEnum('待分配','已分配','部分分配','待重算')` | P1-08-09 |
| L0 schema | `db/schema/service-commission.ts:29` | 加 `chk_svc_comm_ratio CHECK (allocation_ratio IN (0.10..1.00))` | P1-08-12 |
| L0 schema | `db/schema/commission.ts:17-19` | varchar → enum 迁移（order_type / role_type / sales_category） | P2-08-16, audit-07 P1-07-12 |
| L3 staff routes | `staffApi/routes/service.js:401-411` | matrix 查询加 `AND org_id = $X`，X 来自 marketName → org_nodes lookup | **P0-08-01** |
| L3 staff routes | `staffApi/routes/service.js:412-450` | rate=0 + consumeBase>0 时不写 sc，置 commission_status='待分配'，仅 opLog | **P0-08-03** |
| L3 staff routes | `staffApi/routes/order.js approveRefund` | 同事务 UPDATE service_commissions SET is_void=true, voided_at=NOW(), void_reason='退款冲销' WHERE service_item_id IN (...) | **P0-08-04** |
| L3 staff routes | `staffApi/routes/staff.js:150-220 todayCommission` | 加 service_commissions sum 并入 today_amount | P1-08-07 |
| L3 staff routes | `staffApi/routes/service.js:401-411` | 一次性 batch 查 commission_rate_matrix（解决 N+1） | P2-08-15 |
| L3 staff routes | `staffApi/routes/service.js:419-430` | source='staffApi' / 'staff_api' 统一约定 | P2-08-18 |
| L7 admin actions | `fengyu-admin/src/actions/services.ts:333-396 completeServiceOrder` | 调用 staff complete 等价提成生成（共享 db helper），或异步：仅置 commission_status='待分配' 由 cron 写入 | **P0-08-02** |
| L7 admin actions | `fengyu-admin/src/actions/refunds.ts:830-960 approveRefund` | 同事务作废关联 sc | **P0-08-04** |
| L7 admin actions | `fengyu-admin/src/actions/service-commissions.ts:152-161 batchSave` | 后端按 matrix + sale_items.service_fee 重算 commissionAmount，忽略前端值 | P1-08-14 |
| L7 admin actions | `fengyu-admin/src/actions/services.ts:89-155 getServiceOrdersPaginated` | 加 `commissionStatus?:` 过滤 | P2-08-17 |
| L7 admin actions | `fengyu-admin/src/actions/service-commissions.ts:170-173` | 错误前缀加 `INVALID_PARAMS:` 并区分 FK 表 | P2-08-19 |
| L9 admin UI | `service-commission-detail-page.tsx:88-95` | 接入 `db/helpers/role-resolve.ts` 统一 roleType 推断 | **P0-08-06** |
| L8 cron / migration | 新增 admin 批跑工具 | 扫描 `commission_rate=0 AND consume_amount=0` 的历史 sc 行（rate=0 但矩阵已补全）→ 标 needs_recompute | P0-08-03 收尾 |

---

## 7. 验证 SQL（在 5434/fengyu EXPLAIN，禁止写入）

```sql
-- V1 静默 rate=0 但 consumeBase>0 的提成行（P0-08-03 实证）
SELECT COUNT(*) AS rate_zero_with_consume_base
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
WHERE sc.is_void = false
  AND sc.commission_rate = 0
  AND sit.unit_real_price > 0
  AND sit.session_used > 0;

-- V2 admin 路径下完成的服务单（commission_status IS NULL 且 status='已完成'）（P0-08-02 实证）
-- 与 staff 写入路径区分：staff 一定写 '已分配'
SELECT COUNT(*) AS admin_completed_no_commission
FROM service_orders so
WHERE so.status = '已完成'
  AND so.commission_status IS NULL;

-- V3 退款后未冲销的 sc 行（P0-08-04 实证）
-- "原销售单已退款 (paid_amount<total_amount or refunded_at IS NOT NULL) 但相关 sc 仍 is_void=false"
SELECT COUNT(*) AS refunded_but_active_sc
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN sale_items si    ON si.sale_item_id     = sit.sale_item_id
JOIN sale_orders so   ON so.sale_order_id    = si.sale_order_id
WHERE sc.is_void = false
  AND so.paid_amount < so.total_amount
  AND so.sale_order_type = '销售单';

-- V4 跨市场费率误命中风险评估（P0-08-01）
-- 找出有"多市场都有该 (order_type, role_type, sales_category, tier) 行"且服务单刚好 complete 的场景
SELECT order_type, role_type, sales_category,
       COUNT(DISTINCT org_id) AS distinct_markets
FROM commission_rate_matrix
WHERE order_type = '服务单'
GROUP BY order_type, role_type, sales_category
HAVING COUNT(DISTINCT org_id) > 1
LIMIT 50;

-- V5 service_commissions 软删除审计断裂（is_void=true 但无时间戳；P0-08-05 实证）
SELECT COUNT(*) AS voided_no_timestamp
FROM service_commissions
WHERE is_void = true;
-- 期望：>0，因为 schema 没 voided_at，所有 is_void=true 行都没"作废时间"

-- V6 roleType 不一致（P0-08-06 间接证明）
-- 找出员工 skills=['美容师', '推广师']（数组含多 skill）的 sc 行
SELECT sc.id, sc.role_type, swu.skills
FROM service_commissions sc
JOIN staff_wechat_users swu ON swu.employee_id = sc.employee_id
WHERE sc.is_void = false
  AND array_length(swu.skills, 1) > 1
  AND sc.role_type = swu.skills[1]   -- staff.complete 写入路径 = skills[0] 的索引
LIMIT 50;

-- V7 todayCommission 漏算量化（P1-08-07）
-- 今日某员工 sc 提成 vs sa.total_amount 差额
SELECT
  sc.employee_id,
  COALESCE(SUM(sc.commission_amount::numeric), 0) AS today_service_commission,
  (
    SELECT COALESCE(SUM(sa.total_amount::numeric), 0)
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    WHERE sa.employee_id = sc.employee_id AND sa.is_void=false
      AND so.status='已支付'
      AND so.paid_at::date = CURRENT_DATE
  ) AS today_sales_alloc
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN service_orders so ON so.service_order_id = sit.service_order_id
WHERE sc.is_void=false
  AND so.service_date = CURRENT_DATE
GROUP BY sc.employee_id
LIMIT 20;

-- V8 唯一索引意义验证：同一 (item, emp, role) 是否真不可能多行
SELECT service_item_id, employee_id, role_type, COUNT(*)
FROM service_commissions WHERE is_void = false
GROUP BY 1,2,3 HAVING COUNT(*) > 1;
-- 期望：0 行
```

---

## 8. 回归测试用例（建议）

1. **P0-08-01 跨市场矩阵命中**：在 PG 注入两个市场 `(orgA, '服务单','美容师','自销自耗',0,1000,0.05)` + `(orgB, ...,500,NULL,0.30)`，对 orgA 门店服务单 complete，断言写入 sc.commission_rate=0.05；当前实现会失败。
2. **P0-08-02 admin 完成路径**：admin completeServiceOrder 后查 service_commissions 应有 N 行（与 staff 完成等价），当前实现 0 行。
3. **P0-08-03 rate=0 不入账**：清空 commission_rate_matrix，对 service_order complete，断言 sc 无新行 + commission_status='待分配'；修复后断言。
4. **P0-08-04 退款冲销**：完成服务单后 admin.refunds.approveRefund 整退原单，断言 sc.is_void=true 且 voided_at IS NOT NULL。
5. **P0-08-06 roleType 一致**：员工 skills=['美容师','推广师']，staff.complete 写入后立即开 admin 分配页 init，断言 admin UI 默认 roleType 与 sc.role_type 相同。
6. **P1-08-07 todayCommission 含 sc**：员工今日完成服务单 + sa 各一笔，断言 todayCommission.todayAmount 含两者之和。
7. **P1-08-09 commission_status 边界**：admin 保存空数组后 commission_status='待分配'，再保存非空后 '已分配'；断言 UI tab 切换符合预期。
8. **P1-08-14 后端重算**：admin batchSave 传入篡改后的 commissionAmount=99999，断言后端入库值由 matrix 重算（非 99999）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（admin + staff + DB，无 client）**：☑
- 涉及历史数据：☑（P0-08-01 跨市场误命中需历史回扫；P0-08-03 rate=0 行需补算；P0-08-04 退款回填需作废）
- 修复成本：**L**（6 P0 + 8 P1 + 5 P2，含 schema 6 列 + 1 enum 拆分 + admin/staff 双端 helper 收敛 + 历史数据回扫）

---

## 10. 后续待办

- [ ] 与域 05（服务单）、域 07（销售提成）联动确认 voided_at + voided_by + void_reason 三列 schema 同步推进
- [ ] 与域 11（退款）联动确认退款审批回滚链路：`原单 sa 缩减` + `相关 sc 作废` 两件事必须同事务
- [ ] 与域 17（数据看板）联动：mgmt-dashboard.queryServiceCommissionIncome 已正确读 sc，但口径 `role_type IN ('美容师','养生师')` 与 sc 行实际 roleType（含'推广师'）不一致，需对齐
- [ ] 与域 18（员工绩效）联动：staff.performanceDetail 已读 sc，但 todayCommission 漏读，需统一
- [ ] 与域 25（推广员链路）联动：sc.role_type='推广师' 的提成归属与推广员业绩归属是否双重计算（当前 staff.complete skills[0] 推断会优先美容师，推广师 sc 行难产生）
- [ ] 长期：考虑把 `service_commissions` 的写入移出 staff.complete 主路径（cron 异步），降低 complete 事务时长 + 让 admin/staff 统一走同一异步重算
