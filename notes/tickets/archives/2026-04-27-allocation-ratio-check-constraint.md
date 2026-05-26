# Ticket: sale_allocations.allocationRatio 缺 IN-集合 CHECK + admin batchSaveServiceCommissions 信任前端金额

> 生成日期：2026-04-27
> 实施状态：🟢 代码层 + DB CHECK 均已部署（2026-05-17 commission_rate CHECK 经 migration 0024 补齐）
> 严重级别：**P0**（业绩 ×10 倍资损 — SUMMARY Top10 #8）
> 端：db / fengyu-admin / fengyu-staff
> 来源：[SUMMARY §2 #8](../../docs/audit/SUMMARY.md) / P0-CC1-01 / P0-CC1-04 / P0-07-03
> 关联 audit：[audit-CC1 数值精度](../../docs/audit/audit-CC1-numeric-precision.md)、[audit-07 销售提成分配](../../docs/audit/audit-07-sales-allocation.md)、横切域 E5 schema CHECK

---

## 0 一句话背景

`sale_allocations.allocation_ratio` 类型 `NUMERIC(5,2)` 允许写入 9.99（业务约定仅允许 0.10~1.00 整十档），且 admin `batchSaveServiceCommissions` 直接信任前端传入的 `commissionAmount` 不做服务端重算，两处均可被篡改造成业绩数据虚高。

## 1 问题矩阵

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | `allocation_ratio` 无 DB CHECK 约束 | `db/schema/order.ts` | ✅ Schema 已定义，migration 待部署 |
| 2 | admin `batchSaveServiceCommissions` 信任前端 `commissionAmount` | `fengyu-admin/src/actions/service-commissions.ts` | ✅ 已修复 |
| 3 | staff 前端将 `commissionRate` 混作 `allocationRatio` 提交 | `staff miniprogram/revenue-allocation.ts` | ✅ 已修复 |
| 4 | `service_commissions.commission_amount` 无 CHECK | `db/schema/service-commission.ts` | ✅ Schema 已定义 |
| 5 | `service_commissions.commission_rate` 无范围 CHECK | `db/schema/service-commission.ts` | ✅ 2026-05-17 migration 0024 部署（脏数据已 0 行，CHECK 已生效） |

## 2 实施记录（2026-04-27）

### Phase 1：DB CHECK 约束 — ✅ 已部署

**已部署 CHECK 约束**：
- `sale_allocations.chk_sale_alloc_ratio` — `allocation_ratio IN (0.10,...,1.00)`
- `service_commissions.chk_svc_comm_alloc_ratio` — `allocation_ratio IS NULL OR IN (0.10,...,1.00)`
- `service_commissions.chk_svc_comm_commission_amount` — `commission_amount >= 0`
- `service_commissions.chk_svc_comm_commission_rate` — `commission_rate >= 0 AND <= 1`（2026-05-17 migration 0024 补齐）

**数据清洗**：52,065 行 `sale_allocations` 脏数据已清洗并 COMMIT：
- 单人池（20,748 行）→ ratio=1.00, total=received
- 多人池纯脏（28,191 行）→ 按原比例归一化后归整到 0.10 档
- 混合池（3,126 行）→ 非法行归整到 0.10

### Phase 2：admin batchSaveServiceCommissions 服务端重算 — ✅ 已完成

**修改文件**：`fengyu-admin/src/actions/service-commissions.ts`

变更内容：
1. 事务前查询 `service_items` + `sale_items` 获取定价数据（unitRealPrice, sessionUsed, salesCategory, serviceFee）
2. 事务内对每条提成：
   - 计算 `fixedFee = round(serviceFee × sessionUsed, 2)`
   - 计算 `consumeBase = round(unitRealPrice × sessionUsed, 2)`
   - 查询 `commission_rate_matrix` 获取 rate
   - 无匹配时抛 `INVALID_STATE: COMMISSION_RATE_MISSING`（D-Q7 决策）
   - 计算 `commissionAmount = fixedFee + consumeAmount`
3. 使用服务端计算值 INSERT，忽略前端传入的 commissionRate/commissionAmount
4. 保留所有原有校验（VALID_RATIOS、池校验、scope 校验）

### Phase 3：staff 前端字段分离 — ✅ 已完成

**修改文件**：
- `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts`
- `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.wxml`
- `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.wxss`

变更内容：
1. `AllocLine` 接口增加 `allocationRatio: number` 独立字段（默认 1.00）
2. `onStaffSelected()` 创建新行时设 `allocationRatio: 1.00`
3. `restoreAllocations()` 从 `allocation_ratio` 读取，`commissionRate` 置 0
4. `onSave()` 使用 `line.allocationRatio` 而非 `line.commissionRate`
5. WXML 增加 `.alloc-ratio-badge` 条件显示（非 1.00 时展示分成比例）

### Phase 4：service_commissions 金额 CHECK — ✅ Schema 已定义

**已修改文件**：`db/schema/service-commission.ts`

新增 CHECK：
- `chk_svc_comm_commission_amount`: `commission_amount >= 0`
- `chk_svc_comm_commission_rate`: `commission_rate >= 0 AND commission_rate <= 1`
- `chk_svc_comm_alloc_ratio`: `allocation_ratio IS NULL OR allocation_ratio IN (0.10,...,1.00)`

## 3 待办

- [x] **commission_rate 脏数据清洗 + CHECK**：migration 0024 (`0024_cleanup_commission_rate.sql`) 已部署 5434。Plan B 全部归零（与新代码"矩阵无匹配置 0"一致），同时 ADD `chk_svc_comm_commission_rate`。2026-05-17 诊断 5434 脏数据已为 0，UPDATE 是 no-op；CHECK 验证违例 INSERT 被拒绝
- [x] **schema vs snapshot drift 修复**：`db/schema/service-commission.ts:62` 取消 TODO 注释加回 check 调用；同时修复 `0023_snapshot.json` prevId 错误指向 0021 的历史 bug
- [ ] **Phase 3 后续**：UI 增加独立"分配比例"下拉控件（10%~100% 整十档），当前仅有条件 badge
- [ ] **测试**：admin batchSave 新增的服务端重算逻辑需单元测试覆盖

## 4 验收标准

- [x] admin `batchSaveServiceCommissions` 忽略前端 `commissionAmount`，服务端按公式重算
- [x] staff 前端 `allocationRatio` 和 `commissionRate` 为独立字段，不再混用
- [x] `tsc --noEmit` 零新增错误（admin）
- [x] `sale_allocations` 表有 `chk_sale_alloc_ratio` CHECK — 已部署
- [x] `service_commissions` 表有 `chk_svc_comm_alloc_ratio` + `chk_svc_comm_commission_amount` — 已部署
- [x] 52,065 行历史脏数据已清洗（2026-04-27 committed）
- [x] `service_commissions.commission_rate` BETWEEN 0 AND 1 CHECK（2026-05-17 migration 0024 部署到 5434）
- [ ] staff allocation 页面有独立"分配比例"下拉控件（Phase 3 后续）
- [ ] 测试：覆盖服务端重算 + 合法/非法 allocationRatio 场景

## 5 前置 / 关联

| 项 | 说明 |
|----|------|
| 关联 | E5 schema 不变量 CHECK 一次性 migration |
| 关联 | D-CC1-2026-04-26 决策：保留 NUMERIC(5,2) 不升级，仅补 IN-集合 CHECK |
| 关联 | D-Q7-2026-04-26 决策：rate=0 抛错 `INVALID_STATE: COMMISSION_RATE_MISSING:` |
| 参考 | staffApi `routes/allocation.js:17` VALID_RATIOS（已有应用层校验） |
| 参考 | staffApi `routes/service.js:398-414`（服务端重算佣金模式） |
