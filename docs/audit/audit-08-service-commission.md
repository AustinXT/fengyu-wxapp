# 审计报告：服务提成 service_commissions (08) — v3

**审计时间**：2026-04-26
**域 ID**：08
**审计员**：claude-sonnet-4-6（合并 v1 + v2，独立裁定冲突）
**审计时长**：~10 分钟（合并）+ v1 ~25 分钟 + v2 ~30 分钟
**关联 PR/Ticket**：—

> **v3 合并说明**：本报告合并 v1（2026-04-25，claude-opus-4-7）与 v2（2026-04-26，claude-sonnet-4-6 独立重建）两个版本。
> - 同问题以 v2 为准（v2 源码阅读链路更完整）
> - v1 P0-08-04（退款不冲销 sc）和 P0-08-05（voided_at schema 缺失）已修复 → 标记 `[CLOSED from v1]`
> - v1 P0-08-01/02/03 仍存在（继承至 v3 P0）
> - v2 新发现 P1-v2-01、P2-v2-01 补入
> - v1 P0-08-06 降级为 P1-v2-06（v2 分析显示实际漂移程度低于 v1 评估）

---

## 1. v1 vs v2 摘要

| 项目 | v1 | v2 |
|------|----|----|
| P0 总数 | 6 | 3 仍存在 + 2 CLOSED |
| P1 总数 | 8（P1-08-07 ~ 08-14） | 6（继承 P1-v2-01 ~ 06） |
| P2 总数 | 5（P2-08-15 ~ 19） | 4（继承 P2-v2-01 ~ 04） |
| 新发现 | — | P1-v2-01（P1 降级自 v1 P0-08-04 的子问题）<br>P2-v2-01（P2 测试锁死 P0-08-03） |
| CLOSED | — | P0-08-04（退款冲销）、P0-08-05（voided_at schema） |
| 降级 | — | v1 P0-08-06 → P1-v2-06 |

---

## 2. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/service-commission.ts:16-63` | ↑ | — |
| 矩阵 Schema | `db/schema/commission.ts:9-42` | ↑ | — |
| 自动写入 | — | `staffApi/routes/service.js:388-450`（complete 内 per-item INSERT） | — |
| 手工覆盖 | `fengyu-admin/src/actions/service-commissions.ts:72-182`（batchSaveServiceCommissions） | — | — |
| 退款冲销 | `fengyu-admin/src/lib/refund-cascade.ts:85-105`（通道 2，IN tx） | `staffApi/helpers/refund-cascade.js:65-79`（通道 2，IN tx） | — |
| 列表页 | `fengyu-admin/src/app/(main)/allocations/service/[serviceOrderId]/page.tsx` | — | — |
| 分配详情 UI | `allocations/_components/service-commission-detail-page.tsx:41-56`（findMatchingRate 含 orgName） | — | — |
| 矩阵维护 | `fengyu-admin/src/actions/commission.ts:32-69`（getRates，含 orgId + orgName） | — | — |
| 下游消费 | `fengyu-admin/src/actions/dashboard.ts`（仅读 sa）| `staffApi/routes/staff.js:487-530`（performanceDetail 读 sc）；`mgmt-dashboard.js:342-357`（queryServiceCommissionIncome 读 sc）；`staff.js:150-237`（todayCommission **不读 sc**） | — |
| 测试 | `fengyu-admin/src/actions/service-commissions.test.ts`（5 池校验用例） | `staffApi/__tests__/routes/service.test.js:703-893`（3 个 sc 相关用例） | — |

---

## 3. 数据流图

```
[staff.service.complete]  service.js:286-475
  ├─ requireStaffBound() + manager 或本人权限校验
  ├─ CAS WHERE status='服务中' 后进入 pg.transaction
  ├─ for each service_item:
  │    原子扣减 sale_items.remaining_sessions
  │    ─── 提成计算 ───
  │    roleType = skills[0] || '美容师'           ← 仅取第一个 skill
  │    fixedFee = service_fee × session_used
  │    consumeBase = (unit_real_price × quantity / session_count) × session_used   ← per-session 折算（commit e0dd09f）
  │    rate = SELECT commission_rate FROM commission_rate_matrix
  │             WHERE order_type='服务单' AND role_type=$1
  │               AND sales_category=$2
  │               AND amount_tier_min<=$3
  │             ORDER BY amount_tier_min DESC LIMIT 1   ← ⚠️ 无 org_id 过滤
  │    rate=0 + consumeBase>0 → opLog('rate_missing')  ← ⚠️ 仍写 sc，不阻塞
  │    INSERT service_commissions ... ON CONFLICT DO NOTHING
  └─ UPDATE service_orders SET status='已完成', commission_status='已分配'
       WHERE status='服务中'                              ← ⚠️ rate=0 时也写 '已分配'

[admin.completeServiceOrder]  services.ts:334-397
  ├─ CTE：UPDATE service_orders SET status='已完成', completed_at=NOW()
  │        WHERE status='服务中'
  │  CTE：UPDATE sale_items remaining_sessions - si.session_used
  └─ ⚠️ 完全不写 service_commissions，也不写 commission_status
         → commission_status 保持 NULL

[admin.batchSaveServiceCommissions]  service-commissions.ts:72-182
  ├─ 校验 ratio 整十 + 池 ≤3 + 池内合计 ≤100% + 员工不重复
  ├─ tx: UPDATE service_commissions SET is_void = true
  │        WHERE service_item_id IN (...) AND is_void = false  ← ⚠️ 不写 voided_at
  │      INSERT 新 sc 行（commissionAmount 由前端传入，后端不重算）
  └─     UPDATE service_orders SET commissionStatus = 数组非空 ? '已分配' : '待分配'

[退款审批通过]
  admin.approveRefund (refunds.ts:849)  → cascadeRefund(tx, ...) → 通道 2:
    UPDATE service_commissions SET is_void=true, voided_at=NOW(), voided_reason=$
      WHERE service_item_id IN (SELECT ... FROM service_items WHERE sale_item_id = ANY($itemIds))
      AND voided_at IS NULL                                     ✅ 退款冲销已实现（CLOSED from v1）

  staff.approveRefund (order.js:1620)   → cascadeRefund(client, ...) → 同上        ✅

[todayCommission]  staff.js:150-237
  ← 只读 sale_allocations（sa.total_amount）
  ⚠️ 完全不读 service_commissions → 员工"今日分成"漏算服务提成

[performanceDetail]  staff.js:487-530
  ← 同时读 sale_allocations + service_commissions sc.commission_amount  ✅

[mgmt-dashboard.queryServiceCommissionIncome]  mgmt-dashboard.js:342-357
  ← 读 sc.commission_amount WHERE role_type IN ('美容师','养生师')
  ⚠️ 漏算 role_type='推广师' 的 sc 行
```

---

## 4. 自身漏洞

### 4.1 P0（阻断/资损/越权，3 个仍存在 + 2 个 CLOSED）

#### [P0-08-01] `staff.complete` 查询 `commission_rate_matrix` **无 `org_id` 过滤** → 跨市场误命中错误费率（资损）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:401-411`
- **现象**：
  ```sql
  SELECT commission_rate FROM commission_rate_matrix
   WHERE order_type = '服务单'
     AND role_type = $1
     AND sales_category = $2
     AND amount_tier_min <= $3
     AND (amount_tier_max IS NULL OR amount_tier_max >= $3)
   ORDER BY amount_tier_min DESC LIMIT 1
  ```
  `commission_rate_matrix.org_id` 是矩阵权威维度（schema `commission.ts:14`；唯一索引 `uq_commission_matrix` 含 orgId；admin UI 按 marketTab 切换）。staff.complete 完全忽略该字段。多市场环境下，A 市场的服务单按全库匹配一条 ORDER BY amount_tier_min DESC 的行，与实际归属市场无关。
- **v2 独立证伪**：在 `service.js:170-188`，`service_orders` 插入时已存 `market_name`；`so.market_name` 在 `complete` 里的 `so` 对象中可取到（`service.js:304`），但传递到费率查询时完全丢弃。
- **风险**：
  1. 多市场组织下，员工提成计算错误；财务对账系统性偏移；
  2. ORDER BY amount_tier_min DESC 让结果非确定性（同一 service_order_id 重复 complete 可能拿到不同 rate）；
  3. admin 详情页按 `r.orgName === marketName` 过滤，与 staff 自动写入口径不一致 → 同一服务单在 admin 和 staff 视角佣金不同。
- **复现**：
  1. 插入两条矩阵行：`(orgA, '服务单', '美容师', '自销自耗', 0, 1000, 0.05)`、`(orgB, '服务单', '美容师', '自销自耗', 500, NULL, 0.30)`
  2. orgA 门店完成服务单 (consumeBase=600)
  3. 期望 rate=0.05，实际 ORDER BY amount_tier_min DESC → 返回 orgB 行 rate=0.30 → consumeAmount 翻 6 倍
- **修复**：(L3) `complete` 取 `so.market_name` 一次性查 `org_nodes.id WHERE type='市场' AND name=$1`，再在费率查询加 `AND org_id = $X`。

#### [P0-08-02] `admin.completeServiceOrder` **完全不写 `service_commissions`，也不写 `commission_status`**

- **文件**：`fengyu-admin/src/actions/services.ts:334-397`
- **现象**：admin 路径 CTE 仅翻状态 + 扣次数（`services.ts:360-381`），**无任何 sc INSERT，也无 commission_status 更新**。`commissionStatus` 无 DEFAULT NOT NULL，所以 admin 完成的服务单 commission_status IS NULL。
- **风险**：
  1. admin 完成路径下员工提成永久 0；
  2. admin allocation tab 按 `status='已完成'` 筛选，这些单会显示但 commissionStatus=NULL → UI 行为未定义；
  3. 与 staff.complete 路径下 `commission_status='已分配'` 彻底错位。
- **修复**：(L7) admin.completeServiceOrder 完成 CTE 后同事务触发 sc 计算（抽共用 helper）；或仅置 commission_status='待分配'，由 admin 手工分配补全（后者实现成本低）。

#### [P0-08-03] `rate=0` 时**仍 INSERT sc + 置 commission_status='已分配'** → 静默资损 + 无回扫机制

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:412-454`
- **现象**：
  ```js
  const rate = Number(rateRows.rows[0]?.commission_rate || 0)  // 缺规则 → 0
  // rate=0 + consumeBase>0：写 opLog('rate_missing')，但 INSERT sc 照常执行（line 433-449）
  // 最终 commission_status='已分配'（line 454）
  ```
  唯一索引 `uq_svc_comm_item_emp_role WHERE is_void=false`（`service-commission.ts:51-53`）阻止之后重新 INSERT。矩阵补完后无任何 cron / admin 工具检测历史 rate=0 行。
- **风险**：
  1. 矩阵补完前完成的服务单永久按 0 计提成（员工绩效少计）；
  2. commission_status='已分配' 让 admin UI 显示"查看分配"，财务/店员不会重新分配；
  3. `service.test.js:836-842` 断言 `rate=0 + consume_amount=0 + commission_amount=80`，**主动锁死了这个错误行为**（见 §6 CC9）。
- **修复**：(L3) rate=0 + consumeBase>0 时不写 sc，置 commission_status='待分配'，让 admin allocation tab 走人工补算。

---

**[P0-08-04] 退款审批后不冲销 service_commissions — [CLOSED from v1]**

> **FIXED 2026-04-27**：sale-order-domain-refactor 实现 5 通道退款 cascade 通道 2（admin `lib/refund-cascade.ts:85-105` + staffApi `helpers/refund-cascade.js:65-79`）。退款审批通过时 `UPDATE service_commissions SET is_void=true, voided_at=NOW(), voided_reason=$reason WHERE service_item_id IN (...) AND voided_at IS NULL`。Dashboard 查询改用 `WHERE voided_at IS NULL` 过滤。

- **v1 描述**：refunds.ts + order.js approveRefund 完全不动 service_commissions；schema 无 voided_at 列。
- **v2 核实**：admin.refund-cascade.ts:85-105 通道 2 已实现 `UPDATE service_commissions SET is_void=true, voided_at=NOW(), voided_reason=$`；staff 同理。
- **状态**：✅ **已修复（CLOSED from v1）**

---

**[P0-08-05] schema 不存在 `voided_at` 列 — [CLOSED from v1]**

- **v1 描述**：schema/service-commission.ts 仅 `is_void boolean`，无 `voided_at`；batchSave UPDATE is_void=true 不写时间戳，审计断裂。
- **v2 核实**：schema 已补 `voided_at timestamp NULL` + `voidedReason`（`service-commission.ts` 最新版本）。
- **注意**：batchSave 路径仍漏写 voided_at（P1-v2-01）。
- **状态**：✅ **已修复（CLOSED from v1）；P1-v2-01 为残余子问题**

---

### 4.2 P1（数据一致 / 状态错乱）

#### [P1-v2-01] `admin.batchSaveServiceCommissions` UPDATE is_void=true **不写 `voided_at`**（P0-08-05 的残余子问题）

- **文件**：`fengyu-admin/src/actions/service-commissions.ts:143-149`
- **现象**：
  ```sql
  UPDATE service_commissions SET is_void = true
  WHERE service_item_id IN (...) AND is_void = false
  ```
  无 `voided_at = NOW()`，无 `voided_reason`。对比：退款 cascade 路径（admin.refund-cascade.ts:91-93 + staff.helpers/refund-cascade.js:71）均写 `voided_at = NOW(), voided_reason`。
- **风险**：
  1. 审计无法区分"店长手工重分配"vs"退款冲销"触发的作废；
  2. `idx_sc_voided_at` 索引 WHERE voided_at IS NOT NULL 无法索引这批行；
  3. 当前 `performanceDetail` 用 `AND sc.voided_at IS NULL` 过滤（`staff.js:524`）+ `is_void=false` 双重过滤，实际数据无错误；但若未来去掉 is_void 双重过滤，会引入幽灵数据。
- **修复**：(L7) batchSave UPDATE 加 `voided_at = NOW(), voided_reason = '手工重分配'`。

#### [P1-v2-02] `todayCommission` **不读 `service_commissions`** → 员工工作台"今日分成"漏算服务提成

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:150-237`
- **现象**：todayCommission 的 `today_amount` / `lastMonthAmount` 全部 SUM(sa.total_amount)；`service_commissions` 完全不在此路由中读取。与同文件 `performanceDetail`（line 487-530）已读 sc 形成明显不一致。
- **风险**：员工工作台 KPI 日常体感与月度绩效明细对不上账（工作台金额 < 绩效页加总）。
- **修复**：(L3) todayCommission 加并行查询：`SUM(sc.commission_amount) WHERE sc.employee_id=$1 AND sc.is_void=false AND sc.voided_at IS NULL AND so.service_date BETWEEN today_start AND today_end`，结果叠加入 `todayAmount`。

#### [P1-v2-03] `mgmt-dashboard.queryServiceCommissionIncome` 用 `role_type IN ('美容师','养生师')` 过滤，排除推广师

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:351`
- **现象**：
  ```sql
  AND sc2.role_type IN ('美容师', '养生师')
  ```
  若某员工 skills=['推广师']（无美容师/养生师 skill），staff.complete 会写入 role_type='推广师' 的 sc 行。该行的 commission_amount 被 mgmt-dashboard 完全漏算。
- **风险**：管理看板"服务提成收入"指标低估；`staffRankingIncome`（line 1150）同样有此过滤，推广师员工绩效不显示在排行榜。
- **修复**：(L3) 去掉 role_type IN 过滤（或改为 IN ('美容师','养生师','推广师') 三值覆盖）；spec 层面确认服务提成是否应含推广师贡献。

#### [P1-v2-04] `commission_status` 复用 `allocationStatusEnum`（仅 2 值），语义贫乏

- **文件**：`db/schema/service.ts:38`；`db/schema/enums.ts:23-24`
- **现象**：`commissionStatus: allocationStatusEnum('commission_status')` → 只有 `待分配 / 已分配`。admin.completeServiceOrder 不写该字段 → NULL。P0-08-02 的修复需要此字段支持第三值如 `'待触发'` 或 `'待重算'`。
- **修复**：(L0) 拆出独立 `serviceCommissionStatusEnum`，加值 `'待触发'`（admin 完成但未生成提成）/ `'待重算'`（rate=0 待人工介入）/ `'已分配'` / `'待分配'`。

#### [P1-v2-05] admin `batchSave` 的 `commissionAmount` 由前端传入，后端**不重算**

- **文件**：`fengyu-admin/src/actions/service-commissions.ts:79-81`（输入参数）、`service-commission-detail-page.tsx:510`（前端计算）
- **现象**：UI 计算 `commissionAmount = (Number(allocAmount) * commRate).toFixed(2)` 后传入 server action，后端直接持久化（`service-commissions.ts:159`）。后端无重算逻辑，不与 commission_rate_matrix 比对。
- **风险**（real.md #5 后端统一鉴权）：恶意或 bug 导致的篡改后 commissionAmount 直接入库。
- **修复**：(L7) batchSave 按 `(unit_real_price × allocationRatio × commission_rate_matrix 命中值)` 在后端重算并以服务端值入库；前端传值仅作 hint。

#### [P1-v2-06] `roleType` 推断在 staff.complete vs admin UI 存在语义差异（降级自 v1 P0-08-06）

- **文件**：
  - `staff service.js:396`：`skills[0] || '美容师'`（取第一个）
  - `service-commission-detail-page.tsx:88-95`：`comm.roleType || ''`（优先读已有 sc.role_type；仅在 roleType 为空时按 skills 推断，推广师>养生师>美容师）
- **v2 分析**：admin UI 的 `initCommissions` 优先读 `comm.roleType`（即 DB 已存的 sc.role_type），仅当 `comm.roleType` 为空时按推断逻辑初始化。因此：
  - 首次打开分配页（sc 行已由 staff.complete 写入）：admin UI 直接读 sc.role_type → **实际无漂移**；
  - 若 sc 行 is_void=true 后新建分配（无已有行）：admin UI 按推断逻辑初始化 skillTag，可能与 staff 优先级不同。
- **风险**：降级为 P1；仅在"admin 手工重分配初始化"场景下，空行的默认 skillTag 可能与 staff 自动写入不同，需人工核对。
- **修复**：(L7) 统一封装 `resolveRoleType(skills)` 函数，admin UI 和 staff.complete 共用同一优先级逻辑。

---

### 4.3 P2（代码质量 / 可维护）

#### [P2-v2-01] `service.test.js:836-842` 测试断言 `rate=0 + consume_amount=0` **锁死了 P0-08-03 错误行为**

- **文件**：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js:836-842`
- **现象**：
  ```js
  expect(rate).toBe(0)
  expect(consumeAmt).toBe(0)
  expect(commAmt).toBe(80)   // 仅固定手工费
  ```
  断言验证"rate=0 时 sc 仍然写入"，与 P0-08-03 建议的修复方向（rate=0 时不写 sc）相反 → 修复 P0-08-03 后此测试必须同步更新。
- **修复**：(L9 测试) 按 P0-08-03 的修复选项，将断言改为：`expect(svcCommInsert).toBeNull()` + `commission_status='待分配'`。

#### [P2-v2-02] `service.complete` 内 per-item 费率查询 N+1（每 service_item 独立一次 RTT）

- **文件**：`service.js:401-411`
- **现象**：10 个 service_item → 10 次 commission_rate_matrix 查询，串行在事务内。
- **修复**：(L3) 一次 batch 预查 `rateMap`，按 `(roleType, salesCategory, consumeBase)` 键匹配。

#### [P2-v2-03] `commission_rate_matrix.role_type / order_type / sales_category` 用 varchar(20)，无 DB 枚举约束

- **文件**：`db/schema/commission.ts:17-19`
- **修复**：(L0) 迁移为独立枚举，与 sale_allocations.role_type 等同类字段保持一致。

#### [P2-v2-04] admin `batchSave` 错误处理：`err.code === '23503'` 捕获后文案混淆 FK 类型，无错误前缀

- **文件**：`service-commissions.ts:169-173`
- **现象**：`return { success: false, message: '员工信息不存在，请检查后重试' }`，23503 也可能来自 `service_item_id` FK 失败，文案不准确；无 `INVALID_PARAMS:` 前缀（违反 CC5 约定）。
- **修复**：(L7) 区分 FK 字段 + 前缀加 `INVALID_PARAMS:`。

---

## 5. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 | v3 状态 |
|------|-------|-------|--------|------|--------|---------|
| 完成动作是否写 sc | **完全不写，也不写 commission_status** | 写 per-item × per-employee，置 '已分配' | — | admin 路径提成永久缺失 | **P0** | 仍存在（P0-08-01） |
| 矩阵查询过滤维度 | `findMatchingRate` 按 orgName | **无 org_id 过滤** | — | 跨市场误命中 | **P0** | 仍存在（P0-08-01） |
| rate=0 处理 | UI 红色 0% 展示 | 静默写入 + opLog，置 '已分配' | — | 无回扫机制，资损 | **P0** | 仍存在（P0-08-03） |
| 退款冲销 sc | refunds.ts → cascadeRefund ✅ | order.js → cascadeRefund ✅ | — | — | — | **[CLOSED from v1]** |
| voided_at schema | schema 已有 voided_at + voidedReason ✅ | ↑ | — | — | — | **[CLOSED from v1]** |
| voided_at 写入 | batchSave 不写 voided_at | cascadeRefund 写 | — | 审计断裂 | P1 | **新发现**（P1-v2-01） |
| commission_status 语义 | 空数组 → '待分配'；admin 路径完成 → NULL | 永远 '已分配'（含 rate=0） | — | NULL 与 '待分配' 混淆 | P1 | 仍存在（P1-v2-04） |
| todayCommission 是否含 sc | n/a | **不含**（只读 sa） | — | 员工工作台漏算 | P1 | 仍存在（P1-v2-02） |
| commissionAmount 由谁算 | 前端算后传 | 后端实时算 | — | admin 不二次校验 | P1 | 仍存在（P1-v2-05） |
| roleType 推断 | 优先读 sc.role_type；空时推广师>养生师>美容师 | skills[0]\|\|'美容师' | — | 仅新建行时漂移 | P1（降级）| 程度降低（P1-v2-06） |
| 错误前缀 | 中文裸文案，无前缀 | INVALID_PARAMS / PERMISSION_DENIED | — | CC5 不一致 | P2 | 仍存在 |

---

## 6. 横切检查（§3 Checklist）

- [x] **CC1 数值精度**：sc 列 NUMERIC(10,2) / (5,4) ✅；JS 端 `Math.round(x*100)/100` ✅；但 P1-v2-05 admin batchSave 不重算金额，前端浮点字符串可被篡改。
- [ ] **CC2 并发幂等**：`uq_svc_comm_item_emp_role WHERE is_void=false` ✅；`ON CONFLICT DO NOTHING` 满足重复 complete 幂等；P0-08-03 写 rate=0 行后唯一索引阻止后续重插 → 修复 P0-08-03 时需确认幂等策略更新。
- [ ] **CC3 组织域隔离**：`mgmt-dashboard.queryServiceCommissionIncome` 用 buildSaleScope ✅；但 **P0-08-01 矩阵查询缺 org_id** 是 CC3 子集。
- [x] **CC4 后端鉴权**：staff.complete `requireStaffBound() + manager 或本人` ✅；admin batchSave `requirePermission(session, 'allocation:save')` + verifyServiceOrderScope ✅。P1-v2-05 commissionAmount 由前端传入为弱化 CC4。
- [ ] **CC5 错误码**：admin batchSave 错误文案无 `INVALID_PARAMS:` 前缀（`service-commissions.ts:109,128,135,171`），与 staff 用 INVALID_PARAMS/PERMISSION_DENIED 不一致。
- [x] **CC6 PII**：sc 表无 PII；opLog 写 serviceItemId 不含 PII ✅。
- [ ] **CC7 时间字段**：`createdAt / updatedAt` defaultNow + $onUpdate ✅；`voided_at` schema 已补 ✅；但 batchSave UPDATE is_void=true 不写 voided_at → P1-v2-01。
- [x] **CC8 WXML/Vant**：本域 client 不参与，staff 无 sc 相关 UI ✅。
- [ ] **CC9 测试与残留**：admin service-commissions.test.ts 仅 5 个池校验用例，无 voided_at / org_id / 退款冲销断言；`service.test.js:836-842` 断言锁死 P0-08-03 错误行为（P2-v2-01）；admin completeServiceOrder 无 sc 写入测试（P0-08-02 无覆盖）。

---

## 7. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/service.ts` | 拆 commission_status 出独立 `serviceCommissionStatusEnum`（4 值：待分配/已分配/待触发/待重算） | P1-v2-04 |
| L0 schema | `db/schema/commission.ts:17-19` | varchar → 独立枚举（order_type / role_type / sales_category） | P2-v2-03 |
| L3 staff routes | `staffApi/routes/service.js:401-411` | 矩阵查询加 `AND org_id = $X`（X = 先查 org_nodes WHERE name=market_name AND type='市场'） | **P0-08-01** |
| L3 staff routes | `staffApi/routes/service.js:417-449` | rate=0 + consumeBase>0 时不 INSERT sc，置 commission_status='待重算'（或新枚举值） | **P0-08-03** |
| L3 staff routes | `staffApi/routes/staff.js:150-237 todayCommission` | 加 service_commissions 并行查询，叠加 today_amount | P1-v2-02 |
| L3 staff routes | `staffApi/routes/mgmt-dashboard.js:351` | `role_type IN ('美容师','养生师','推广师')` 或去掉此 IN 过滤 | P1-v2-03 |
| L3 staff routes | `staffApi/routes/service.js:401-411` | batch 预查 rateMap（解决 N+1） | P2-v2-02 |
| L7 admin actions | `fengyu-admin/src/actions/services.ts:360-381 completeServiceOrder` | 完成 CTE 后同事务置 commission_status='待触发'（或触发 sc 计算 helper） | **P0-08-02** |
| L7 admin actions | `fengyu-admin/src/actions/service-commissions.ts:143-149 batchSave UPDATE` | 加 `voided_at = NOW(), voided_reason = '手工重分配'` | P1-v2-01 |
| L7 admin actions | `fengyu-admin/src/actions/service-commissions.ts:152-161 batchSave INSERT` | 后端重算 commissionAmount，忽略前端传值 | P1-v2-05 |
| L7 admin actions | `fengyu-admin/src/actions/service-commissions.ts:169-173` | 错误前缀加 `INVALID_PARAMS:` + 区分 FK 表 | P2-v2-04 |
| L9 前端（可选） | `service-commission-detail-page.tsx:88-95 initCommissions` | 统一 roleType 推断算法（与 staff.complete skills[0] 一致） | P1-v2-06 |
| L9 测试 | `service.test.js:836-842` | 修复 P0-08-03 后同步更新断言（不再写 sc，改期望 commissionStatus='待重算'） | P2-v2-01 |

---

## 8. 验证 SQL（在 5434/fengyu EXPLAIN，禁止写入）

```sql
-- V1 P0-08-01：跨市场矩阵命中风险
SELECT order_type, role_type, sales_category,
       COUNT(DISTINCT org_id) AS distinct_markets
FROM commission_rate_matrix
WHERE order_type = '服务单'
GROUP BY order_type, role_type, sales_category
HAVING COUNT(DISTINCT org_id) > 1;
-- >0 行意味着多市场矩阵同 (order_type, role_type, sales_category) 存在，完全忽略 org_id 会误命中

-- V2 P0-08-02：admin 完成路径下 commission_status=NULL 的已完成服务单
SELECT COUNT(*) AS admin_completed_no_commission_status
FROM service_orders
WHERE status = '已完成'
  AND commission_status IS NULL;
-- >0 行说明 admin 路径已产生此问题

-- V3 P0-08-03：rate=0 但 consumeBase>0 的 sc 行（静默漏算）
SELECT COUNT(*) AS rate_zero_with_consume_base
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
WHERE sc.is_void = false
  AND sc.voided_at IS NULL
  AND sc.commission_rate = 0
  AND sit.unit_real_price > 0
  AND sit.session_used > 0;
-- >0 行说明已有漏算数据

-- V4 P1-v2-01：batchSave 作废但无 voided_at 的行（schema 已补后的漏写路径）
SELECT COUNT(*) AS voided_no_timestamp
FROM service_commissions
WHERE is_void = true
  AND voided_at IS NULL;
-- >0 行说明 batchSave 路径已产生此问题（v1 P0-08-05 schema 修复后残余）

-- V5 P1-v2-02：今日有 sc 记录但 todayCommission 未含的员工示例
SELECT sc.employee_id,
       COALESCE(SUM(sc.commission_amount::numeric), 0) AS today_service_commission
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN service_orders so ON so.service_order_id = sit.service_order_id
WHERE sc.is_void = false
  AND sc.voided_at IS NULL
  AND so.status = '已完成'
  AND so.service_date = CURRENT_DATE
GROUP BY sc.employee_id
HAVING SUM(sc.commission_amount::numeric) > 0;
-- 若有结果，工作台"今日分成"漏算这些员工的服务提成

-- V6 退款冲销验证（CLOSED from v1，供回归）
SELECT COUNT(*) AS refunded_but_active_sc
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN sale_items si    ON si.sale_item_id     = sit.sale_item_id
JOIN sale_orders so   ON so.sale_order_id    = si.sale_order_id
WHERE sc.is_void = false
  AND sc.voided_at IS NULL
  AND so.refunded_amount > 0;
-- 期望 0（退款冲销已实现）；若 >0 则退款 cascade 仍有漏洞
```

---

## 9. 回归测试用例（建议）

1. **P0-08-01 跨市场矩阵命中**：插入 orgA/orgB 两条矩阵行，对 orgA 门店 complete，断言 sc.commission_rate 为 orgA 对应费率（非 orgB）。
2. **P0-08-02 admin 路径无 sc**：admin.completeServiceOrder 后查 service_commissions → 0 行 + commission_status IS NULL；修复后断言 commission_status='待触发'。
3. **P0-08-03 rate=0 不入账**：清空矩阵，complete 服务单，断言 sc 无新行 + commission_status='待重算'；修复后正确。
4. **退款冲销回归（CLOSED from v1）**：complete → approveRefund，断言 sc.is_void=true + voided_at IS NOT NULL + voided_reason 含退款关键字。
5. **P1-v2-01 batchSave voided_at**：batchSave 重分配后查 is_void=true 行，断言 voided_at IS NOT NULL + voided_reason='手工重分配'。
6. **P1-v2-02 todayCommission 含 sc**：今日 complete 一笔服务单（非 sa），断言 todayCommission.todayAmount 含 sc.commission_amount。
7. **P1-v2-05 commissionAmount 后端重算**：batchSave 传入 commissionAmount=99999，断言入库值由矩阵重算（非 99999）。
8. **V4 voided_at IS NULL 回归**：执行 V4 验证 SQL，期望 0 行（修复后）。

---

## 10. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（admin + staff + DB，无 client）**：☑
- 涉及历史数据：☑（P0-08-03 rate=0 历史 sc 行需补算；P0-08-02 admin 路径完成的历史 sc 需补录；P1-v2-01 voided_at IS NULL 历史行需修复）
- 修复成本：**M**（3 P0 仍存在，6 P1，4 P2；含 1 schema 枚举变更 + L3/L7 双端修复 + 历史数据回扫）

---

## 11. 后续待办

- [ ] P0-08-01：与域 17（数据看板）联动确认 mgmt-dashboard.queryServiceCommissionIncome 补 org_id 过滤后口径一致
- [ ] P0-08-02：与域 05（服务单）联动确认 admin.completeServiceOrder 补 commission 路径后 CTE 事务边界安全
- [ ] P0-08-03：与域 18（员工绩效）联动：performanceDetail 已读 sc（rate=0 行导致绩效少算），需配合回扫脚本修复历史数据；P2-v2-01 测试用例同步更新
- [ ] P1-v2-04：与域 07（销售提成）联动：`allocationStatusEnum` 在 sale_allocations 和 service_orders 复用，若拆出 serviceCommissionStatusEnum 需同步评估 migration 影响
- [ ] v1 P0-08-04 退款冲销：已修复（admin + staff cascadeRefund 通道 2），补充 E2E 回归测试确认
- [ ] v1 P0-08-05 voided_at schema：已修复（schema 已补列），但 batchSave 路径仍漏写（P1-v2-01）需跟进
- [ ] 长期：考虑将 sc 写入移出 staff.complete 主路径（异步/cron），降低事务时长，同时自然解决 admin/staff 双端一致性问题
