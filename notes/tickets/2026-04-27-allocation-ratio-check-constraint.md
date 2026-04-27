# Ticket: sale_allocations.allocationRatio 缺 IN-集合 CHECK + admin batchSaveServiceCommissions 信任前端金额

> 生成日期：2026-04-27
> 实施状态：🔴 待实施
> 严重级别：**P0**（业绩 ×10 倍资损 — SUMMARY Top10 #8）
> 端：db / fengyu-admin / fengyu-staff
> 来源：[SUMMARY §2 #8](../../docs/audit/SUMMARY.md) / P0-CC1-01 / P0-CC1-04 / P0-07-03
> 关联 audit：[audit-CC1 数值精度](../../docs/audit/audit-CC1-numeric-precision.md)、[audit-07 销售提成分配](../../docs/audit/audit-07-sales-allocation.md)、横切域 E5 schema CHECK

---

## 0 一句话背景

`sale_allocations.allocation_ratio` 类型 `NUMERIC(5,2)` 允许写入 9.99（业务约定仅允许 0.10~1.00 整十档），且 admin `batchSaveServiceCommissions` 直接信任前端传入的 `commissionAmount` 不做服务端重算，两处均可被篡改造成业绩数据虚高。

## 1 问题矩阵

| # | 问题 | 文件 | 风险 |
|---|------|------|------|
| 1 | `allocation_ratio` 无 DB CHECK 约束 | `db/schema/order.ts:227` | 前端传 9.99 → 业绩 ×10 倍 |
| 2 | admin `batchSaveServiceCommissions` 信任前端 `commissionAmount` | `fengyu-admin/src/actions/service-commissions.ts:158-159` | 任意金额持久化 |
| 3 | staff 前端将 `commissionRate` 混作 `allocationRatio` 提交 | `staff miniprogram/revenue-allocation.ts:453` + `staffApi/routes/allocation.js:117` | 语义错误：30% 提成率被当成 30% 分配比例 |

## 2 资损场景

| 场景 | 端 | 资损 |
|------|----|------|
| 管理员/攻击者传 `allocationRatio=9.99`，单笔 1000 元订单写入 9990 元业绩 | admin / staff | 业绩 ×10 倍膨胀，影响全链路提成/绩效/看板 |
| 管理员传 `commissionAmount='9999.99'`，服务提成直接落库 | admin | 任意提成金额 |
| staff 前端 matrix rate=0.30 → 作为 `allocationRatio` 提交 → `totalAmount = received × 0.30` | staff | 业绩缩水 70%（反向偏差） |
| staff matrix rate=0.08 → 不在 VALID_RATIOS → 保存失败 | staff | 店长无法保存分配（业务阻塞） |

## 3 关键代码路径

### 3.1 Schema 定义（无 CHECK）

```
db/schema/order.ts:227
  allocationRatio: numeric("allocation_ratio", { precision: 5, scale: 2 }).notNull()
  → NUMERIC(5,2) 允许 -999.99 ~ 999.99，无 IN 集合约束
```

### 3.2 admin batchSaveServiceCommissions（直信前端）

```
fengyu-admin/src/actions/service-commissions.ts:152-160
  commissions.map((c) => ({
    serviceItemId: c.serviceItemId,
    employeeId: c.employeeId,
    roleType: c.roleType,
    allocationRatio: c.allocationRatio,    // 前端传入，无服务端校验
    commissionRate: c.commissionRate,       // 前端传入
    commissionAmount: c.commissionAmount,   // 前端传入，未按公式重算
  }))
  → INSERT service_commissions 直接落库
```

### 3.3 staff allocation.js（已有 VALID_RATIOS 但无 DB 兜底）

```
staffApi/routes/allocation.js:17
  const VALID_RATIOS = new Set(['0.10','0.20',...,'1.00'])
  :117-119
    const ratioStr = Number(alloc.allocationRatio).toFixed(2)
    if (!VALID_RATIOS.has(ratioStr)) {
      throw new Error('INVALID_PARAMS: allocationRatio 必须为整十百分比')
    }
  → 应用层校验存在但 DB 层无兜底，绕过 staffApi（admin 直连）可写入非法值
```

### 3.4 staff 前端 commissionRate 混作 allocationRatio

```
staff miniprogram/revenue-allocation.ts:453
  allocationRatio: line.commissionRate  // 应为 line.allocationRatio（独立字段）
  → commissionRate（提成率 0.05~0.30）被当作 allocationRatio（分配比例 0.10~1.00）
```

## 4 修复计划

### Phase 1：DB CHECK 约束（P0，S 量级）

**文件**：`db/schema/order.ts` + 新 migration

1. Schema 层面 CHECK — 在 `sale_allocations` 表加约束：

   ```sql
   ALTER TABLE sale_allocations
     ADD CONSTRAINT chk_sa_ratio_in_set
     CHECK (allocation_ratio IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00));
   ```

2. 部署前先查历史脏数据：

   ```sql
   SELECT id, allocation_ratio
   FROM sale_allocations
   WHERE allocation_ratio NOT IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00);
   ```

3. 如有脏数据，先修正再 apply migration。

### Phase 2：admin batchSaveServiceCommissions 服务端重算（P0，S 量级）

**文件**：`fengyu-admin/src/actions/service-commissions.ts`

1. 查询 `service_items.unit_real_price × session_used` 获取服务实际金额
2. 查询 `commission_rate_matrix` 获取对应 `commissionRate`
3. 服务端计算 `commissionAmount = unit_real_price × session_used × commissionRate`
4. 忽略前端传入的 `commissionAmount`，仅使用计算值
5. 参考 staffApi `service.complete`（`routes/service.js:398-414`）的已有重算模式

### Phase 3：staff 前端字段分离（P0，S 量级）

**文件**：`staff miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts`

1. `AllocLine` 增加 `allocationRatio: number` 独立字段（默认 1.00）
2. `onSave()` 提交 `line.allocationRatio` 而非 `line.commissionRate`
3. `allocation-calc.ts` 的 `suggestAllocation()` 返回增加 `allocationRatio: 1.00`
4. UI 增加独立"分配比例"下拉（10%~100% 整十档），`commissionRate` 改为只读展示

### Phase 4：service_commissions 金额 CHECK（P1，可与 E5 epic 协同）

**目标**：对 `service_commissions.commission_amount` 加范围约束 `>= 0`，并在 `commission_rate` 列加 `BETWEEN 0 AND 1` CHECK。

## 5 验收标准

- [ ] `sale_allocations` 表有 `chk_sa_ratio_in_set` CHECK，写入非整十值报约束错误
- [ ] 历史脏数据已排查并修正（如有）
- [ ] admin `batchSaveServiceCommissions` 忽略前端 `commissionAmount`，服务端按公式重算
- [ ] staff 前端 `allocationRatio` 和 `commissionRate` 为独立字段，不再混用
- [ ] staff allocation 页面有独立"分配比例"下拉控件
- [ ] `tsc --noEmit` 零新增错误（admin）
- [ ] 云函数 SQL 参数化查询（$1, $2），无拼接
- [ ] 测试：覆盖 `allocationRatio` 合法值（0.10~1.00）/ 非法值（9.99, 0.05, -1）/ NULL 场景

## 6 前置 / 关联

| 项 | 说明 |
|----|------|
| 前置 | 无（schema 字段已存在，仅加 CHECK） |
| 关联 | E5 schema 不变量 CHECK 一次性 migration |
| 关联 | P0-CC1-03 `commission_rate BETWEEN 0 AND 1` CHECK（同 epic） |
| 关联 | D-CC1-2026-04-26 决策：保留 NUMERIC(5,2) 不升级，仅补 IN-集合 CHECK |
| 关联 | D-Q7-2026-04-26 决策：rate=0 抛错 `INVALID_STATE: COMMISSION_RATE_MISSING:` |
| 参考 | staffApi `routes/allocation.js:17` VALID_RATIOS（已有应用层校验） |
| 参考 | staffApi `routes/service.js:398-414`（服务端重算佣金模式） |
