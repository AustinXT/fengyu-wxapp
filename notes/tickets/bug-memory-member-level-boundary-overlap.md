# Bug: 记忆文件 `project_member_level_rules.md` 会员等级区间 off-by-one（边界重叠）

> 生成日期：2026-04-10
> 关联适配计划：`notes/adapt-plans/02-customer-classification.md` §7.1（记忆文件修正项）
> 严重级别：低（记忆文件内容偏差，不影响运行时代码；但会误导未来基于记忆做决策的任务）
> 修复归属：单独一笔"记忆修正"提交即可，无需代码变更

---

## 1 位置

- 记忆文件：`/Users/nv/.claude/projects/-Users-nv-proj-xt-com-fengyu-wxapp/memory/project_member_level_rules.md:11-15`
- 权威代码：`fengyu-client/cloudfunctions/cronTask/index.js:79-86`（`determineMemberLevel` 函数）
- 镜像证据：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:34-38`（`spending_tier` 6 档阈值，阈值同源）
  - `fengyu-client/cloudfunctions/payNotify/index.js:119-123`（同 spending_tier 镜像）
- 适配计划已指明：`notes/adapt-plans/02-customer-classification.md:87-88, 351, 735`

## 2 现状

### 2.1 记忆文件当前表述（错误）

```markdown
| 等级 | 12个月累计消费 |
|------|---------------|
| 初钻 | ¥1,990 – 9,999 |
| 星钻 | ¥10,000 – 29,999 |
| 粉钻 | ¥29,999 – 59,999 |   ← 下界重叠
| 金钻 | ¥59,999 – 99,999 |   ← 下界重叠
| 黑钻 | ¥100,000+ |
```

- `¥29,999` 同时落在"星钻"上界与"粉钻"下界 → 语义二义
- `¥59,999` 同时落在"粉钻"上界与"金钻"下界 → 语义二义

### 2.2 代码权威逻辑（`cronTask/index.js:79-86`）

```js
function determineMemberLevel(spend) {
  if (spend >= 100000) return '黑钻'
  if (spend >= 60000)  return '金钻'
  if (spend >= 30000)  return '粉钻'
  if (spend >= 10000)  return '星钻'
  if (spend >= 1990)   return '初钻'
  return null
}
```

短路 `if` 链等价于左闭右开区间：

| 等级 | 代码实际区间 | 含义 |
|------|---|---|
| 初钻 | `[1990, 10000)` | `1990 <= spend < 10000` |
| 星钻 | `[10000, 30000)` | `10000 <= spend < 30000` |
| 粉钻 | `[30000, 60000)` | `30000 <= spend < 60000` |
| 金钻 | `[60000, 100000)` | `60000 <= spend < 100000` |
| 黑钻 | `[100000, +∞)` | `spend >= 100000` |
| null | `[0, 1990)` | 无会员等级 |

## 3 影响分析

1. **记忆误导风险**
   任何后续基于 `project_member_level_rules.md` 做档位判断、阈值校验、测试数据构造的任务（例如 e2e 构造"粉钻" fixture），若按记忆写 `29999` 当作粉钻下界，**实际 cronTask 重算时会命中星钻分支**，导致断言失败或用户分层偏差。

2. **运行时代码未受影响**
   - `determineMemberLevel` 是单处实现，`spending_tier` 档位 SQL 同源，数字一致
   - `client_wechat_users.member_level` 由 cronTask 每日 3:00 重算（`b471d70` 解耦后唯一写入点）
   - 当前生产数据按代码阈值落档，**无数据损坏**

3. **与适配计划的对齐状态**
   `notes/adapt-plans/02-customer-classification.md:87-88` 已标注"代码为准，记忆文件后续需修正"；`:735` 把本项列入"§5 记忆文件同步清单"。本 ticket 即用于闭环该条。

## 4 根因溯源

记忆最初录入时作者按"前一档上界 − 1 元"写法回推区间：
- 见 `¥10,000 – 29,999`（星钻），自然联想"下一档从 29,999 开始"
- 结果把"粉钻阈值 30000"误写成 "29999"，金钻同理

代码使用**严格大于等于**的短路链，档位真正边界是 `10000 / 30000 / 60000 / 100000` 整数，不存在 `9999 / 29999 / 59999`。

初钻/星钻的区间表述意外正确是因为 `9999` 恰好 = `10000 - 1`（描述惯例对齐），掩盖了同样的 off-by-one 手法对粉钻/金钻会暴露。

## 5 修复方案

**单步修改**：改写 `project_member_level_rules.md:9-15` 表格，消除重叠边界。

### 5.1 目标文本（推荐写成左闭右开区间，与代码同构）

```markdown
| 等级 | 12个月累计消费 | 代码阈值 |
|------|---------------|---------|
| 初钻 | ¥1,990 – ¥9,999 | `spend >= 1990` |
| 星钻 | ¥10,000 – ¥29,999 | `spend >= 10000` |
| 粉钻 | ¥30,000 – ¥59,999 | `spend >= 30000` |
| 金钻 | ¥60,000 – ¥99,999 | `spend >= 60000` |
| 黑钻 | ¥100,000+ | `spend >= 100000` |

> 权威实现：`fengyu-client/cloudfunctions/cronTask/index.js:79-86`
> 短路 if 链等价左闭右开：`[1990, 10000) / [10000, 30000) / [30000, 60000) / [60000, 100000) / [100000, +∞)`
```

### 5.2 关键变更 diff

```diff
- | 粉钻 | ¥29,999 – 59,999 |
- | 金钻 | ¥59,999 – 99,999 |
+ | 粉钻 | ¥30,000 – 59,999 |
+ | 金钻 | ¥60,000 – 99,999 |
```

并追加一行代码权威引用（`cronTask/index.js:79-86`），防止下次再被"区间写法"误导。

## 6 验证清单

- [ ] 记忆文件 `project_member_level_rules.md:11-15` 更新后自读一遍，确认 5 档区间无重叠、无间隙
- [ ] 在记忆文件底部补充 `**Source of truth:** fengyu-client/cloudfunctions/cronTask/index.js:79-86` 锚点
- [ ] `grep` 项目内其他文档（特别是 `.42cog/`、`notes/` 下）对 "29999"、"59999" 的引用，确认无同类误表述
- [ ] 适配计划 `02-customer-classification.md:735` 的 TODO 划掉（或在该计划内标记 DONE）

## 7 附带风险提醒（不纳入本 ticket 修复范围）

- 会员等级阈值（1990/10000/30000/60000/100000）是**硬编码多处**，与 `new_member_threshold = 1990`（`system_configs`）一样存在**集中化候选**（见 `bug-member-threshold-hardcoded.md`）。本次仅修记忆，**不改代码**；档位阈值集中化是独立改造项。
- `spending_tier` 枚举（6 档）阈值同源但档位边界不同（`1990-1W / 1-3W / 3-6W / 6-10W / 10W+`），记忆文件未覆盖该枚举。若后续记忆需补充 spending_tier 档位，注意 `1-3W` 对应 `[10000, 30000)`、`3-6W` 对应 `[30000, 60000)`，与会员等级同阈值但命名不同。

---

## 8 修复归属 commit 建议

记忆文件不在 git 仓库内（在 `~/.claude/projects/...`），无需提交代码。修复动作：
1. 直接用 Write/Edit 改写记忆文件
2. 同步更新 `adapt-plans/02-customer-classification.md:735` 的 TODO 状态（可与其他记忆修正一起批量处理）

若希望留下代码层审计痕迹，可在 `notes/adapt-plans/02-customer-classification.md` §7.1 加一行 changelog：
```
- 2026-04-10 修正 project_member_level_rules.md 会员等级区间 off-by-one（见 tickets/bug-memory-member-level-boundary-overlap.md）
```
