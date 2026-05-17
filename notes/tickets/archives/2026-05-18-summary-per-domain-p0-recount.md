# SUMMARY §1.1 / §1.2 单域 P0 计数 v4 重算（可选 / P2）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | ⏳ 待实施（**低紧急度**） |
| 优先级 | **P2**（仅文档准确度，无代码/资损影响） |
| 端 | 项目根（`docs/audit/SUMMARY.md`） |
| 修复成本 | **S**（< 2h） |
| 来源 | SUMMARY v4 §6.1 #C |

> ⚠️ **本 ticket 标记为可选**：当前 §1.1 / §1.2 表中 "P0" 列展示的是 v2 (2026-04-27) 旧值，而 §1.3 合计行已经更新到 v4 (~131)；阅读体验上单域计数与合计行不对齐，但**不影响任何决策与代码行为**。可与 v5 审计同批顺手做。

---

## 0 一句话背景

SUMMARY §1.3 全栈合计已重算到 v4（业务域 ~103 / 横切域 ~28 / 合计 ~131），但 §1.1 (25 业务域) 和 §1.2 (9 横切域) 的单域 "P0" 列仍是 v2 旧数；新 reader 看表会按域加和得到 v2 的 162，与开篇 v4 合计 ~131 不一致。需要逐域重新核算并刷新两张表。

## 1 现状（grep 实证）

### 1.1 §1.1 当前状态（v2 旧值，业务小计 = 124）

`docs/audit/SUMMARY.md:74-101`：

```
| NN | 域 | P0 | P1 | P2 | 总计 | 报告 |
|----|----|----|----|----|------|------|
| 13 | 优惠券 | 8 | 7 | 6 | 21 | audit-13-coupons.md |
| 05 | 服务单 + 扣次原子性 | 8 | 8 | 5 | 21 | audit-05-service-order.md |
| 11 | 退款 / 退换货 | 7 | 6 | 6 | 19 | audit-11-refunds.md |
...
| **业务小计** |  | **124** | **188** | **144** | **456** |  |
```

### 1.2 §1.2 当前状态（v2 旧值，横切小计 = 38）

`docs/audit/SUMMARY.md:103-116`：

```
| ID | 横切域 | P0 | P1 | P2 | 总计 | 报告 |
|----|--------|----|----|----|------|------|
| CC4 | 后端鉴权 | 11 | 5 | 3 | 19 | audit-CC4-auth.md |
| CC2 | 并发与幂等 | 6 | 6 | 5 | 17 | audit-CC2-concurrency-idempotency.md |
...
| **横切小计** |  | **38** | **56** | **53** | **147** |
```

### 1.3 §1.3 v4 目标值（已写）

`docs/audit/SUMMARY.md:120-126`：

```
| 业务域（25）| 124 | 111 | **~103** | 188 | 144 | ~435 |
| 横切域（9）|  38 |  32 | **~28** |  56 |  53 | ~137 |
| **合计** | 162 | 143 | **~131** | **244** | **197** | **~572** |
```

注解 `notes/tickets/archives/2026-05-17-*.md` + `2026-05-18-*.md` 关闭明细见 SUMMARY §2 Top10 表和 §2.1 关闭归档。

## 2 修改计划

### 2.1 重算方法

对每个 audit-NN 子报告执行：

```bash
# 在 audit-NN 文件中搜索 P0 标签出现
grep -nE '^\*\*P0\*\*' docs/audit/audit-13-coupons.md   # 标题级 P0 计数
grep -nE '\[P0-[0-9]+-[0-9]+\]' docs/audit/audit-13-coupons.md  # 编号级
# 再交叉过滤掉：
#  - 划掉的（~~P0-NN-YY~~）
#  - "降级 P2" / "降级 P1" 标记
#  - "✅ 已关闭" / "DONE" 标记
```

更稳的方式：直接在每个 audit-NN 顶部摘要表查 "P0 状态" 列（多数报告已维护增量摘要）。

### 2.2 关闭项映射表（v2 → v4 增量参考）

| 域 | v2 P0 | v3 关闭 | v4 关闭 | v4 剩 | 关闭依据快查 |
|---|------|---------|---------|------|-------------|
| 01 auth | 5 | -1 (_testOpenid) | -1 (D-Q2 banner) | ~3 | §2.1 / §2 Top10 #12 |
| 02 order | 5 | 0 | -1 (Advisory lock #3) | ~4 | §2.1 |
| 04 pay-notify | 4 | 0 | 0 | 4 | E1 唯一灾难级未关 |
| 05 service-order | 8 | 0 | -1 (sku_id #2) | ~7 | §2.1 |
| 07 sales-alloc | 5 | -1 (sa ratio CHECK) | 0 | ~4 | migration 0022 |
| 08 svc-comm | 6 | -1 (commission CHECK) | 0 | ~5 | migration 0022 |
| 09 product-sku | 3 | -1 (E9 R2 is_recharge_card) | 0 | ~2 | commit ed3bf1f |
| 10 customer | 5 | -1 (customer scope) | 0 | ~4 | §2.1 |
| 11 refunds | 7 | -1 (refund cascade 5 ch) | 0 | ~6 | migration 0018+0019 |
| 12 store-binding | 6 | -1 (from_store_name) | 0 | ~5 | §2.1 |
| 13 coupons | 8 | -1 (createOrder scope) | -1 (face_value #11) | ~6 | §2.1 + §2 Top10 #11 |
| 14 prepaid-card | 5 | 0 | -1 (balance CHECK) | ~4 | migration 0028 |
| 15 points | 4 | -1 (settlePoints) | 0 | ~3 | settlePoints-on-sale-order |
| 17 dashboard | 6 | -1 (公式) | -1 (#15 三端一致性) | ~4 | §2.1 + §2 Top10 #15 |
| CC1 数值精度 | 4 | 0 | -2 (round + Math.round) | ~2 | §2 Top10 #5 + #6 |
| CC2 并发 | 6 | 0 | -2 (CAS + Advisory) | ~4 | §2 Top10 #8 + #3 |
| CC3 org 隔离 | 7 | -1 (customer scope) | -1 (scope helper #13) | ~5 | §2.1 + §2 Top10 #13 |
| CC4 后端鉴权 | 11 | 0 | -1 (withPermission HOF #4) | ~10 | §2 Top10 #4 |
| CC9 测试/迁移残留 | 3 | -1 (sale_orders 7列 DROP) | -1 (sku_id #2) | ~1 | migration 0025 + Top10 #2 |

> 上表为参考骨架，**执行时仍需对每个 audit-NN 逐文件核验**，以 audit-NN 本身的 P0 列表为权威源。

### 2.3 修改步骤

1. 对 25 业务域 + 9 横切域，按 §2.1 方法逐文件 grep，得到每域 v4 实际 P0 剩余数
2. 更新 `docs/audit/SUMMARY.md` §1.1 表（76-101 行）：仅改 "P0" 列；P1/P2/总计 列暂不动（v4 未推进 P1/P2）
3. 更新 §1.2 表（107-115 行）：同上
4. 更新 "**业务小计**" / "**横切小计**" 行的 P0 累加值
5. 验证：业务小计 P0 + 横切小计 P0 == §1.3 v4 合计 (~131)
6. 如计数与 §1.3 不一致（±5 以内可接受），在 §1.3 表下方更新注脚说明差额来源（如"包含 N 项 P1→P0 升级 / N 项尚未在 audit-NN 文件标 DONE"）
7. 同步删除 §1.3 表下 `> v3→v4 关闭 12 项 P0…§1.1 与 §1.2 的单域计数仍未逐条重算…` 这段免责说明

### 2.4 命令草稿（脚本可选）

```bash
# 在 docs/audit/ 下抓全部活跃 P0 编号（已闭项目通常会被划掉或加 ✅）
for f in docs/audit/audit-*.md; do
  total=$(grep -cE '\[P0-[A-Z0-9_-]+\]' "$f")
  closed=$(grep -cE '~~\[P0-[A-Z0-9_-]+\]~~|\[P0-[A-Z0-9_-]+\].*✅' "$f")
  echo "$f  total=$total  closed=$closed  active=$((total-closed))"
done
```

> 注：grep 启发式只是辅助，每域**仍需眼校** audit-NN 顶部的 P0 摘要表。

## 3 验收 DoD

- [ ] `docs/audit/SUMMARY.md` §1.1 表 25 业务域 "P0" 列全部更新到 v4 实际值
- [ ] §1.2 表 9 横切域 "P0" 列全部更新到 v4 实际值
- [ ] "**业务小计**" P0 + "**横切小计**" P0 之和 与 §1.3 v4 合计 (`~131`) 误差 ≤ ±5（误差需在表下注脚说明）
- [ ] §1.3 表下方"v3→v4 关闭 12 项 P0；§1.1 与 §1.2 的单域计数仍未逐条重算"段落删除或改写为"v4 已重算"
- [ ] §1.1 / §1.2 表头 P0 列标题增加 `(v4)` 后缀以明示
- [ ] git commit 信息：`docs(audit/SUMMARY): §1.1/§1.2 单域 P0 计数 v4 重算 (~131 对齐)`
- [ ] 仅修改 `docs/audit/SUMMARY.md` 一个文件；不改代码、不改其它 audit-NN

## 4 影响范围与回滚

**范围**：
- 仅文档变更，不影响任何代码 / 测试 / 部署
- 阅读体验提升（合计行与单域行对齐）

**out-of-scope**：
- 不重算 P1 / P2 列（v4 未系统性推进 P1/P2 关闭）
- 不修改 audit-NN 子报告本身的内容（若发现 audit-NN 该标 DONE 未标，单独立 ticket）
- 不调整 §2 Top10 排序 / §4 Roadmap 表（已是 v4 状态）

**回滚**：
- `git revert <commit>` 即可，无任何二次影响

**前置依赖**：
- 无强依赖；可在任何时间窗口推进
- 建议与下一次（v5）审计同批做 — 那时正好需要逐域回看 audit-NN 状态，顺手把表刷新

**风险**：
- 重算口径与 audit-NN 顶部摘要表略有差异时如何取舍：**以 audit-NN 顶部摘要为权威**；若 audit-NN 摘要本身陈旧，先开子 ticket 修 audit-NN，再回头刷 SUMMARY 表
