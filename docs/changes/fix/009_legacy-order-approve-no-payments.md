---
type: fix
number: "009"
date: 2026-07-20
title: 历史订单审核剥离「首次支付」补登流水（回归哑数据口径）
tags: [legacy-orders, payment-invariant, workfine-sync]
related: ["arch/001"]
---

# fix/009 历史订单审核剥离「首次支付」补登流水

## 事件概述
- 发现时间：2026-07-20
- 影响范围：历史订单（WorkFine 迁移单，`legacy_source='workfine'`）的审核流程；dev 库 902 条已审核历史单带有补登的 `sale_order_payments` 流水。
- 严重程度：低（口径偏差，不影响金额/业务；仅数据形态不符「哑数据」定位，并让历史单意外耦合了资金不变量 I1）。

## 背景
历史订单（WorkFine 旧系统迁移）定位为「只记录消费痕迹：门店 + 时间 + 实付金额」，落库即终态：

- 历史转换单 / 销售单 / 回款单统一落成 `sale_order_type='销售单'`、不建 `sale_allocations`、不计提成；回款单当独立销售单处理、不与销售/转换单做关联分配（原单号只在 `legacy_raw_snapshot.original_order_no` 备查）。
- 导入阶段零副作用（详见 `.42cog/pm/workfine-sync.spec.md` §9.8）。

正常转换单才需要完整回款结构（capture allocation、`item_direction` 转出/转入、`ref_sale_order_id` 关联）——历史单不走这套。

## 根因分析
**直接原因**：`approveLegacyOrder` / `batchApproveLegacyOrders`（2026-07-13 引入）在审核通过时补登一条 `sale_order_payments`「首次支付」流水（`note='历史订单核对通过补登'`），金额 = `total_amount`，目的是维持资金不变量 I1（`received = Σ sop[已支付].amount`）。

**根本原因**：当时只考虑了 I1 不变量的全局一致性，没意识到历史单是「哑数据」——它的 `received` 是旧系统平移值，本就不该配支付流水。补登流水让历史单意外获得了「回款结构」，违反了 spec §9.8「不拉明细、不关联原单」的延伸语义：不应有任何支付/回款结构。

## 修复方案
### 代码 — `fengyu-admin/src/actions/legacy-orders.ts`
- `approveLegacyOrder` / `batchApproveLegacyOrders` 删除 `INSERT INTO sale_order_payments ... '历史订单核对通过补登'` 段。审核动作只保留 `UPDATE received=total_amount` + `paid_at=sale_order_datetime` + 会员/标签重算（`recomputeCustomerTagsInTx` + `recomputeMemberLevelOnly`，历史单仍作为消费痕迹计入会员等级/消费档位）。

### 不变量豁免 — `fengyu-admin/src/cron/steps/audit-payment-invariants.ts`
- I1 SQL 加 `WHERE so.legacy_source IS DISTINCT FROM 'workfine'`，豁免历史单（`received` 为平移值、无流水）。`IS DISTINCT FROM` 对 NULL 安全，非 legacy 单不受影响。
- I2 / I2b / I5 历史单天然满足，无需改。

### 测试
- `legacy-orders.test.ts` 补 `approveLegacyOrder` / `batchApproveLegacyOrders` 用例：断言审核不写 `sale_order_payments`、仍 `UPDATE received/status`、仍调会员/标签重算。
- `audit-payment-invariants.test.ts` 用例 D 补断言：I1 SQL 含 `legacy_source IS DISTINCT FROM 'workfine'`。

### 存量回填 — `db/scripts/backfill-legacy-payments-cleanup.js`（新建）
- 清理已审核历史单的补登流水：`note='历史订单核对通过补登'`（全仓唯一标记，仅由 legacy-orders.ts 产生），DELETE 额外限定 `legacy_source='workfine'` 双保险。
- 支持 `--apply`（默认 dry-run）。dev 库 dry-run 确认 **902 行**。

### spec
- `.42cog/pm/workfine-sync.spec.md` §9.8 补「审核口径」段：只 `UPDATE received=total_amount`、不补登 payments、received = 旧系统实收、I1 对 legacy 豁免、会员/档位重算保留。

## 验证
- `npx tsc --noEmit` 零错误。
- `bunx vitest run` 全量 **1813 用例通过**（97 文件）。
- 回填脚本 dev 库 dry-run 902 行，样本全部 `FY-ABZH/FY-XSD` + `legacy_source=workfine` + `received/total` 一致，确认是补登流水无疑。

## 后续 TODO
- [x] 提交 PR → merge main → 部署 admin（含 cron-worker，使 I1 豁免生效）。
- [x] 部署后回填：dev(47.113.202.7:5433) `--apply`，再 prod(118.178.196.26:5433) `--apply`（2026-07-20 完成：双库各删 1987 行；两库同源 baseline，fix/009 写作时的 902 为早期快照）。
- [ ] 部署后跑一次 `docker exec fengyu-cron-worker node cron-worker.js --once`，确认 STEP 11 无 legacy 单 I1 违规。

## 预防措施
- [ ] 历史单（`legacy_source` 非空）在任何「全局不变量校验 / 聚合」里默认排除；新增不变量时主动决策是否纳入 legacy（参考 I5 白名单范式，而非默认全收）。
- [ ] 给历史单加任何「维持不变量」的补偿写入前，先确认它是否本就该满足该不变量——哑数据不应被强行套用活数据的不变量约束。
