---
name: adapt-plan-decisions
description: 6 份需求适配计划的权威决策覆盖，针对结构性变更清单和待澄清问题的业务方回答
version: 1.0
date: 2026-04-10
authoritative_over:
  - 01-product-mall-refactor.md
  - 02-customer-classification.md
  - 03-staff-commission.md
  - 04-permission-model.md
  - 05-service-presale-cycle.md
  - 06-coupon-model.md
---

# 决策覆盖（Authoritative Overrides）

> **作用**：本文档对 `notes/adapt-plans/0{1..6}-*.md` 的"结构性变更清单"和"待澄清问题"章节做权威覆盖。
> **当本文档与其他 adapt plan 冲突时，以本文档为准。**

---

## §1 结构性变更清单：全部取消，以当前代码为准

**决策**：6 份 adapt plan 汇总时列出的 7 项结构性变更**全部不执行**，当前 `db/schema/*` 和 `db/migrations/*` 的实现即为权威定义。

| # | 原计划的结构变更 | 出处报告 | 决策 |
|---|---|---|---|
| 1 | `customerTypeEnum` 重排为 `[注册,体验客,流量客,会员]` | #02 | ❌ 取消，保留当前 `[流量客,体验客,小美客,会员客]` |
| 2 | `salesCategoryEnum` 改为 `[自销自耗,自销他耗,他销自耗,他销他耗]` | #03 | ⚠️ 2026-04-25 翻新：仅把 `自采自销` → `自销自耗`，其他 3 值不动；最终 4 值为 `[自销自耗,他销自耗,他销他耗,生态合作]`。新增"自销他耗"未采纳。L0→L9 共 37 个文件 + migration `0009_*` rename + 5434/5433 双库 migrate 已完成 |
| 3 | `orgNodeTypeEnum` 收窄去掉 `"部门"` | #04 | ❌ 取消，枚举保留现状 |
| 4 | `service_order_type` 枚举回滚 `[售前,售后]` → `[普通,体验]` | #05 | ❌ 取消，保留 migration 0024 的 `[售前,售后]` |
| 5 | 新增 `sale_items.document_type` 列 + 历史回填 | #05 | ❌ 取消 |
| 6 | 新增 `product_bundles` / `bundle_groups` / `bundle_items` 三表 | #01 | ❌ 取消，套餐数据继续承载于 `mall_*` 侧 |
| 7 | `product_kind` 10 层重新审计 | #01 | ❌ 取消，保持 migration 0029 当前 5 值语义 |

### 1.1 作用与影响

- **`/wx-change-propagation` skill 本次不介入**，6 份报告中所有"需交接 wx-change-propagation"的条目统一作废
- 所有需求适配工作收窄到**逻辑层**：SQL 查询、业务算法、前端渲染、UI 配置
- 业务语义与代码字面量出现歧义时，以**代码字面量**为准；如果需要补充新语义（如"新客"派生标签），通过查询/派生实现，不修改底层枚举
- 本决策同时意味着：**开发阶段不需要历史数据兼容或向后兼容逻辑**（符合 memory/feedback_no_legacy_compat）

### 1.2 每份报告需要重新推导的 Phase

| 报告 | 原 Phase A/结构性变更内容 | 重新推导方向 |
|---|---|---|
| **#01 商品/商城** | 新增 `product_bundles` 三表，套餐下沉到商品管理 | **套餐继续留在 `mall_*` 侧**；员工端开单如需套餐支持，通过额外云函数路由读取 mall_bundle_groups，或继续保留 `product_skus` 现有开单路径（不处理套餐开单） |
| **#02 顾客分类** | 枚举重排 | **枚举不动**；5 档"注册/体验客/流量客/会员/新客"作为**派生视图**，通过 SQL CASE 和聚合在 `customer.stats` / `listByTag` 中输出；`customer_type` 列继续写 `流量客/体验客/小美客/会员客` |
| **#03 员工提成** | `salesCategoryEnum` 重命名 | **枚举不动**；业绩分配校验改为**按 `skillTags` 维度独立校验**（详见 §2 Q5） |
| **#04 权限模型** | `orgNodeTypeEnum` 去"部门" | **枚举不动**；业务层面保证不再新建 `type='部门'` 的节点即可，前端过滤可保留或简化 |
| **#05 服务单/周期** | 枚举回滚 + 新增列 | **枚举不动、列不加**；售前/售后继续承载于 `service_orders.service_order_type`，不做子项级拆分；`service_items.is_presale` 写死 false 的 TODO 就地删除或以主表字段回填 |
| **#06 优惠券** | 无结构性变更 | 原计划不变 |

---

## §2 待澄清问题的业务方回答

### Q1 是否删除"小美客"

**业务方回答**：❌ **保留"小美客"**。

- `customerTypeEnum` 保持 `[流量客, 体验客, 小美客, 会员客]` 不变
- `staffApi/routes/order.js:92-103` 的 `recalcCustomerType` 死分支 Bug 仍需修复（"体验客"分支的 SQL 条件被误写成与"小美客"相同）——修复方向是**让"体验客"和"小美客"两个分支各自正确地匹配业务语义**，而非删除某一档
- **需要进一步澄清**：小美客的业务定义是什么？推广部地推销售的便宜体验卡购买者？还是与体验客共存的另一类客群？当前代码中两者 WHEN 条件相同，说明历史上就没有被正确区分

### Q2 "注册" vs "流量客"的边界

**业务方回答**：❌ **没有"注册"，只有"流量客"**。

- `customer_type` 不会有"注册"这档
- 未完成任何消费的顾客也归类为"流量客"
- meeting-20260312 §二的 5 档分类表中的"注册"档位**被业务方移除**
- 最终层级：`流量客 → 体验客 → 小美客 → 会员客`（代码当前状态）
- **派生的"新客"标签**仍然存在但不持久化，仅在 `staff.dashboard` 等报表中动态计算

### Q3 体验客是否必须购买 `product_kind='体验卡'`

**状态**：⏳ **待张凯澄清**

### Q4 `spending_tier` 年度派生 vs 历史累计

**状态**：⏳ **待张凯澄清**（推荐方向：保留当前历史累计字段 + 新增年度派生视图）

### Q5 业绩分配校验的角色维度

**业务方回答**：✅ **美容师/养生师/推广师三角色独立校验；更准确地说，按 `skillTags` 中的"有效技能标签"独立校验**。

- **现状 Bug**（来自 #03 报告）：`fengyu-admin/src/actions/allocations.ts:156-158` 把美容师/养生师合并为 beautician 组，违反独立校验原则
- **现状 Bug**（来自 #03 报告）：`cloudfunctions/staffApi/routes/allocation.js:16` 的 `DEPT_TO_ROLE = { '美容部':'美容师', ... }` 从**部门字段**推断角色，应改为读取 `staff_wechat_users.skills` 字段
- **新校验规则**：
  1. 从 `staff_wechat_users.skills`（数组）读取每个员工的有效技能标签
  2. 对每个技能标签分别建立一个"业绩分配池"
  3. 每个池独立校验 `SUM(池内分配金额) ≤ 商品金额`，池之间不互相约束
  4. 即：同一商品下，一个员工以"美容师"身份分到的金额和另一个员工以"养生师"身份分到的金额互不干扰
  5. 技能标签的权威列表由 `staff_wechat_users.skills` 的历史取值决定，不写入枚举
- **选人后角色自动填入**：也从 `skills` 字段读取（如员工只有一个技能标签则自动填，多个则让用户选）
- **影响面**：#03 Phase 2 修改计划的核心算法需按此重写；无结构性变更

### Q6 sync-workfine "财智部" → `finance+store` scope

**业务方回答**：✅ **符合预期**。

- `db/scripts/sync-workfine.js` 把"财智部"硬编码为 `finance+store` scope 符合"市场·财务"的业务语义
- #04 报告中列为"业务待决策"的这条可以关闭
- 无需修改同步脚本

### Q7 区域经理 3.5 层

**状态**：⏳ **待讨论**（meeting-20260312 §六已登记为遗留事项）

- 当前实现中"片区经理"被近似为"市场·manager"，同市场内无法区分市场总监和片区经理
- 如果某市场同时存在市场总监和片区经理，**存在越权风险**，需要业务方确认是否可以接受

### Q8 服务单"普通/体验"由店长手选 vs 按 `product_kind` 自动判定

**状态**：⏳ **待张凯澄清**

### Q9 生产 `system_configs.new_member_threshold` 当前真实值

**状态**：⏳ **待查生产库**

- 代码默认值：admin = 1980，云函数 fallback = 1990
- 会议原文：1980 元和 1990 元混用，需以生产库 `system_configs` 表的实际值为准
- 修复方向（来自 #02 #05 报告）：12 处硬编码改为从 `system_configs` 读取
- 但在未确认生产值之前，**不要贸然切换默认值**，以免改变线上会员判定结果

---

## §3 重新校准的执行优先级

基于上述决策，6 份 adapt plan 的可执行工作量大幅收窄。按"无结构性变更、纯逻辑修复"重新排序：

### P0（可立即执行，全部为逻辑层 Bug 修复）

1. **[#06] clientApi `order.create` 折扣券分支补全**（`fengyu-client/.../order.js:291-294`）——线上顾客权益被吞
2. **[#06] 满减基数口径统一**（`available` 用原价 vs `create` 用折后价）
3. **[#06] `createTemplate` 有效期 validityMode 校验**
4. **[#06] `clientApi/routes/coupon.js` 的 `redeem` 死代码删除** + CLAUDE.md / index.js 路由表同步清理
5. **[#02] `recalcCustomerType` 死分支修复**（`staffApi/routes/order.js` + `fengyu-client/cloudfunctions/payNotify/index.js`）—— ✅ **已完成** 2026-04-15，commit `be89af7`（merge `385c631`），方案见 `notes/tickets/02-1-recalc-customer-type-fix.md`；Q1 权威定义已落地为 product_kind 判定的新 CASE SQL
6. **[#05] `service_items.is_presale` TODO 落地**——从 `service_orders.service_order_type` 或其他口径回填，不再写死 false
7. **[#03] `performanceDetail` 口径修正**——`unit_real_price × session_used` 不是服务提成，改为从 `service_commissions` 或按手工费+消耗比例计算

### P1（需先回答 Q3/Q4/Q8/Q9，再决定实现方案）

8. **[#02] 5 档派生分类**（注册除外，即 4 档：体验客/流量客/小美客/会员客 + 派生新客标签）
9. **[#02] 后台顾客管理筛选标签扩展**（到店间隔/消费档位/状态）
10. **[#05] 1980/1990 硬编码收敛**（等 Q9 回答后执行）
11. **[#05] `service_order_type` 由手选改自动判定**（等 Q8 回答后执行）

### P2（结构性前置被取消后的降级方案，需评估可行性）

12. **[#01] 员工端开单的套餐支持**：保留 `mall_bundle_groups` 为唯一套餐数据源，员工端开单页如需覆盖套餐场景，新增 staffApi 路由读取 mall_bundle_groups，而不是下沉到 product_* 侧。**或者明确员工端开单暂不支持套餐**
13. **[#01] 商品管理/商城管理权限收窄**：引入 `mall_mgr` 角色并从 `product` 角色剥离"商城分类/展示"的操作权限
14. **[#03] `skillTags` 驱动的业绩分配校验重写**（Admin allocations.ts + staffApi allocation.js）
15. **[#04] 员工端云函数 `ctx.auth.roles` 结构化**——扩展为 `{role, scopeId, scopeType}[]` 以支持市场级权限聚合，修改 `staffApi/middleware/auth.js:79-98`
16. **[#04] staff.dashboard 等接口增加市场级聚合路径**

### P3（需要业务方决策，暂不推进）

17. **[#04] 区域经理 3.5 层方案**（Q7）
18. **[#02] `spending_tier` 年度 vs 历史累计口径**（Q4）
19. **[#02] 记忆文件 `project_member_level_rules.md` 阈值区间 off-by-one 修正**

---

## §4 每份报告的适用条款摘要

| 报告 | 原 Phase 1（结构性） | 原 Phase 2+（逻辑性） | 本决策后的执行范围 |
|---|---|---|---|
| **#01** | ❌ 三表新建 + 枚举重审 | 权限/UI 拆分 | 仅执行权限收窄 + 套餐降级方案（P2-12/13） |
| **#02** | ❌ customerTypeEnum 重排 | 派生逻辑 + 聚合视图 | 保留 4 档 + 派生"新客"，扩展筛选标签（P0-5, P1-8/9, P3-19） |
| **#03** | ❌ salesCategoryEnum 重命名 | 固定手工费 + skillTags 校验 | 修口径 Bug + skillTags 重写（P0-7, P2-14） |
| **#04** | ❌ orgNodeTypeEnum 收窄 | scope 结构化 + 市场聚合 | 仅执行 auth.js 结构化 + dashboard 市场聚合（P2-15/16, P3-17） |
| **#05** | ❌ 枚举回滚 + 加列 | 硬编码收敛 + TODO 落地 | 修 TODO + 硬编码统一（P0-6, P1-10/11） |
| **#06** | — | 3 P0 Bug + 适用门店 UI | 全部原计划执行（P0-1/2/3/4, P2 适用门店 UI） |

---

## §5 本决策的追溯路径

- **来源对话日期**: 2026-04-10
- **业务方确认方**: 用户（夜航星/谢工）转述或代表
- **原报告所在分支**: `dev`
- **决策冻结时间**: 本文件创建时刻
- **变更方式**: 如本决策需要再次调整，应更新本文件的 §1/§2 对应章节而非直接修改 6 份 adapt plan
