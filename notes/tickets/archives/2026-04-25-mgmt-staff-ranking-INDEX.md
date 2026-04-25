# Tickets Index — 管理层员工排行榜（mgmt-dashboard `ranking` tab 子视图「员工」）

> 生成日期：2026-04-25
> 需求来源：用户提出的设计稿（顶部 3 个时间 chip + 6 个指标按钮 + 员工排行榜列表，列：排名 / 员工姓名 / 所属门店 / 数据值）
> 现状：员工排行榜在原 [`mgmt-store-ranking-INDEX`](./2026-04-25-mgmt-store-ranking-INDEX.md) §"范围外"中被列为 follow-up，本批 ticket 落地

本需求被拆为 2 个 ticket（前后端可并行）：

| # | Ticket | 端 | 前置 |
|---|---|---|---|
| 1 | [staffRanking-api](./2026-04-25-mgmt-staff-ranking-api.md) | staffApi 云函数 | 无（与门店排行榜接口结构一致，可复用 timeWindowPeriod helper） |
| 2 | [staffRanking-page](./2026-04-25-mgmt-staff-ranking-page.md) | fengyu-staff 前端 | T1 + 门店排行榜 page ticket（共享 ranking tab，需要先把门店排行榜从 placeholder 替换出来） |

## 依赖图

```
门店排行榜 INDEX (已存在) ──→ 门店排行榜 page (T2) ──┐
                                                     ├──→ 员工排行榜 page (本 T2)
本 INDEX ──→ 员工排行榜 API (本 T1) ─────────────────┘
```

> **与门店排行榜的关系**：
> - 接口侧：完全独立（新 action `mgmtDashboard.staffRanking`），SQL 复用 `timeWindowPeriod` / `getRefDateExpr` 等 helper
> - 页面侧：共享同一个 `ranking` tab，通过顶部 toggle（门店 / 员工）切换两个子视图（详见 §决策 D7）
> - 时间 chip / 6 指标按钮 / 列表样式完全复用，只是数据源不同

## 推荐执行顺序

1. **Day 1**：本 T1（接口 + 单元测试）— 与门店排行榜 T1 可并行（独立 action，独立 SQL）
2. **Day 2**：本 T2（前端 ranking tab 加 toggle，复用门店排行榜布局）— 必须在门店排行榜 page ticket 合并后再做（否则 placeholder 还在）

## 需求复述

### 视图（来自设计稿截图）

```
┌─────────────────────────────────────────────┐
│  [本月] [上月] [本年]                        │  ← 时间维度 chip（默认本月）
│                                              │
│  [业绩榜单]  [实耗榜单]  [新会员排名]         │  ← 6 个指标按钮
│  [客流榜单]  [项目数榜单] [收入榜单]          │     默认选中"业绩榜单"
│                                              │
│  ─────────── 排行榜 ───────────              │
│  排名  员工姓名     所属门店     数据         │
│   1    胡蕾         南昌蓝茉店  16800.00 收入│
│   2    王陶蕊子      南昌英伦店  15500.00 收入│
│   3    杨钰珊        南昌旭辉店  14900.00 收入│
│   ...                                        │
└─────────────────────────────────────────────┘
[首页] [排行榜*] [顾客] [我的]   ← 现有 mgmt-navbar
   └─→ 子 toggle: [门店] [员工]   ← 本 ticket 新增 toggle
```

> 设计稿截图中表头列名是"店名"，但实际渲染的是员工姓名 + 下方店名灰字。文案统一为"员工姓名"（表头）+ 下方小字"所属门店"，与门店排行榜的"店名 / 所属市场"对称。

### 6 个指标对应（参见 [`metrics.md`](../references/metrics.md)）

| 按钮 | metrics.md 指标 | 公式 | 归属字段 | 时间列 / 参考日 | 备注 |
|------|----------------|------|---------|-------|------|
| 业绩榜单 | （员工业绩 = 销售业绩分配额） | `SUM(sale_allocations.total_amount)` | `sale_allocations.employee_id` | `paid_at` 落入 period | 金额；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` ∩ 销售单/转换单+已支付 |
| 实耗榜单 | （员工实耗 = 实际服务执行额） | `SUM(service_items.unit_real_price * service_items.session_used)` | `service_items.employee_id` | `service_date` 落入 period | 金额；服务单已完成 |
| 新会员排名 | 新会员（按归属员工分组） | `COUNT(*)` `became_member_at IS NOT NULL` | `client_wechat_users.bound_employee_id`（绑定美容师，详见 §决策 D4） | `became_member_at` 落入 period | 人数；判定语义为"何时首次成为会员客" |
| 客流榜单 | （员工客流 = 实际服务的去重客户数） | `COUNT(DISTINCT service_orders.client_user_id)` | `service_items.employee_id` | `service_date` 落入 period | 人数；服务单已完成 ∩ `client_user_id IS NOT NULL` |
| 项目数榜单 | 项目数（按归属员工分组） | `SUM(service_items.session_used)` ∩ `sales_category IN ('自销自耗','他销自耗')` | `service_items.employee_id` | `service_date` 落入 period | 计数；服务单已完成 |
| 收入榜单 | 销售提成收入 + 服务提成收入 | `SUM(sale_allocations.total_amount) + SUM(service_commissions.commission_amount)` | 员工 ID（销售=`sale_allocations.employee_id`，服务=`service_commissions.employee_id`） | 销售按 `paid_at`，服务按 `service_date`，两者各自命中 period 后求和 | 金额；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` |

> **业绩 vs 收入区别**（详见 §决策 D6）：业绩仅含销售部分（sale_allocations）；收入 = 销售 + 服务提成。两者销售部分公式相同；收入因增加服务提成而 ≥ 业绩。

### 时间维度

| 维度 | 含义 | 落 period 的 SQL |
|------|------|---------------------------------------------------|
| 本月 | 当前自然月 | `date_trunc('month', col) = date_trunc('month', NOW()::date)` |
| 上月 | 上一个自然月 | `date_trunc('month', col) = date_trunc('month', NOW()::date - INTERVAL '1 month')` |
| 本年 | 当前自然年 | `date_trunc('year', col) = date_trunc('year', NOW()::date)` |

> **与门店排行榜对齐**：完全相同，复用 `timeWindowPeriod` helper（在门店排行榜 T1 中已落地）。
> **不含"今日"**：与 dashboard 首页不同，但与门店排行榜一致。

## 关键决策记录

### D1. 排行员工范围 = 与人均口径一致的"产能员工"

**决策**：员工排行榜只包含
- `is_resigned = FALSE`（在职）
- `skills && ARRAY['美容师','养生师']`（具备产能技能）
- 当前账号 staffLevel 可见范围（headquarters 全部 / market 自己市场下的所有员工）

**理由**：
- 推广师享提成但不属"产能员工"，不在 metrics.md `employeeCount` 范围（人均分母不含他们）
- 排行榜如果含推广师 → "新会员排名"对推广师不公平（推广师无 bound_employee_id 关系）；含管理者 → "实耗排名"对店长不公平
- 与人效区指标分母口径严格对齐，避免"看似排名第一但其实是兼职管理者"的误导

**包含 0 值员工**：与门店排行榜一致 → 当期无产出的员工仍参与排行（垫底），让管理者看到"哪些员工本月没出业绩"。

**离职员工**：本月离职但本月内有产出的员工 → **不进**当期排行（与"快照即当下"语义一致；如业务想要"本月产出无论是否在职"，那是另一指标，需另开 ticket）。

### D2. 业绩归属 = `sale_allocations.employee_id`（按分配）

**决策**：业绩排名不按"开单人"，按 `sale_allocations` 分配到员工头上的金额求和。

**理由**：
- 一笔销售可能由"开单店长 + 推广师 + 美容师"三人分配
- 直接 SUM `sale_orders.paid_amount` 会把同一笔订单算到多个员工头上
- `sale_allocations.total_amount` 已是员工实际分到的金额，求和不会重复计算

**过滤**：
- `is_void = FALSE`（撤销的分配不算）
- `role_type IN ('美容师','养生师')`（与 D1 一致；推广师虽享分成但不进排行）
- `sale_orders.sale_order_type IN ('销售单','转换单')` ∩ `status = '已支付'`（与 metrics.md 业绩口径一致）
- 退款单 `total_amount` 为负数 → 自然抵消，符合"净销售业绩"语义

### D3. 实耗 / 客流 / 项目数归属 = `service_items.employee_id`（实际执行人）

**决策**：使用 `service_items.employee_id`（实际服务执行人），不用 `service_orders.assigned_employee_id`（单据负责人）。

**理由**：
- 一张服务单可能多个员工协作（多个 service_items，每个 item 不同 employee）
- `assigned_employee_id` 是创建时分配的"主负责人"，未必是真正干活的人
- `service_items.employee_id` 是每条明细的实际执行者，最贴合"谁的客流 / 谁的项目数"

**口径一致性**：
- 客流：按 `service_items.employee_id` GROUP，COUNT(DISTINCT `service_orders.client_user_id`)
  > 注意 service_items 与 service_orders 是 N-1，需 JOIN 后按员工分组
- 项目数：按 `service_items.employee_id` GROUP，SUM(`session_used`) WHERE `sales_category IN ('自销自耗','他销自耗')`
- 实耗：按 `service_items.employee_id` GROUP，SUM(`unit_real_price` × `session_used`)

### D4. 新会员判定 + 归属

**新会员判定**（覆盖 metrics.md 现有定义）：
- 判断字段：`client_wechat_users.became_member_at`（首次成为会员客的时间戳）
- 命中条件：`became_member_at IS NOT NULL` ∩ `became_member_at` 落入 period
- **不再使用** `old_member_level IS NULL ∧ member_level IS NOT NULL ∩ member_level_upgraded_at`（旧口径包含会员等级跃迁，与"新会员"语义不符）

**为什么改判定**：
- `member_level_upgraded_at` 涵盖任何会员等级升级（初钻→星钻、星钻→粉钻 等），不限于"首次成会员"
- `became_member_at` 与 `customer_type='会员客'` 跃迁严格同步维护，专门表达"何时首次成为会员客"
- 业务语义：新会员 = 首次跨过"会员"门槛的人，与等级内升降无关

**归属字段**：`client_wechat_users.bound_employee_id`（绑定美容师）

**理由**：
- 凤御双美的会员体系：顾客成为会员是长期服务关系的结果，主要功劳在"绑定美容师"
- `bound_employee_id` 由 WorkFine 同步或营业额分配默认人员维护，是比较稳定的归属字段
- 备选 `promoter_employee_id`（推荐人）只在邀请场景有值，覆盖率低

**已知行为**：
- 顾客 `bound_employee_id IS NULL` 时该新会员**不归属任何员工**，不会出现在任何员工的"新会员"统计里
  → 与"新会员排名"语义一致："谁带来的新会员"
- 如果业务想要看"未归属新会员"总量，那是另一个看板指标，本 ticket 不实现

**前置确认**：在 T1 实施前跑数据自检，统计 `bound_employee_id IS NULL` 的"新会员（按 became_member_at）"占比。如果占比 > 30%，需评估是否切换到"按 promoter_employee_id"或"按首次升级时的服务单 service_items.employee_id"。

**跨 ticket 影响（必须同步）**：
- `notes/references/metrics.md` "新会员" 行需更新公式与时间字段（→ `became_member_at`）
- 门店排行榜 ticket（[mgmt-store-ranking-api](./2026-04-25-mgmt-store-ranking-api.md) §2.6 "新会员排名" SQL）需同步改字段
- staff.dashboard / mgmt-dashboard.summary 等所有现有"新会员"查询需逐一确认是否要随之改口径（建议在本 T1 实施时一并扫描修正，避免新旧口径并存）

### D5. 收入定义 = 销售提成（业绩） + 服务提成

**决策**：
- "收入" = `SUM(sale_allocations.total_amount)` + `SUM(service_commissions.commission_amount)`
- 与 metrics.md "销售提成收入 + 服务提成收入" 严格一致
- `role_type IN ('美容师','养生师')` ∩ `is_void = FALSE`

**为什么不另加员工层"提成率"**：
- metrics.md 中 `sale_allocations.total_amount` 在业务上已被定义为"销售提成收入"（即员工层面的"业绩"等同于"销售提成"，因为业务上有"业绩 = 提成基数 = 实拿"的隐含约定）
- `service_commissions.commission_amount` 也是已计算后的实拿提成
- 两者求和即"员工总产值（提成口径）"

**SQL 实现**：两个独立子查询按 `employee_id` 全外连接（FULL OUTER JOIN），各自 COALESCE 0 后相加。

### D6. 业绩 vs 收入的区别

**澄清**：
| 指标 | 公式 | 含义 | 与"业绩"差额 |
|------|------|------|---------------|
| 业绩榜单 | `SUM(sale_allocations.total_amount)` | 员工分配到的销售业绩金额 | — |
| 收入榜单 | 业绩 + `SUM(service_commissions.commission_amount)` | 员工产值合计（销售业绩 + 服务提成） | + 服务提成 |

**业务上为何把两者并排展示**：
- 业绩衡量"开单贡献"
- 收入衡量"全口径产值（含服务执行）"
- 两者排名通常正相关但并非完全一致（有些员工销售强但服务少，反之亦然）

### D7. UI 集成 = `ranking` tab 顶部 sub-toggle（门店 / 员工）

**决策**：不新增 nav tab，在已规划的"门店排行榜"上方加 toggle 切换"门店 / 员工"两个子视图。

**理由**：
- mgmt-navbar 当前 4 tab（首页/排行榜/顾客/我的）布局已定，加第 5 tab 视觉拥挤
- 门店和员工排行榜的 UI 95% 一致（时间 chip + 6 指标按钮 + 列表），合并后更紧凑
- 用户切换"门店 ↔ 员工"维度的频率高于切换 nav tab，sub-toggle 更顺手

**实现**：
- `ranking` tab 顶部新增 segment 控件（参考 vant van-tabs 或自绘 2 段）
- 切 toggle 时保留时间 chip + metric 按钮的选中状态（用户期望：切换维度，不重置筛选）
- toggle 状态写到 `ranking.dimension: 'store' | 'staff'`

**备选方案 A（已否决）**：mgmt-navbar 加第 5 tab "员工" → 拥挤，且需要重新设计 4 tab 时的 icon 间距
**备选方案 B（已否决）**：profile 页加入口卡片 "员工排行榜" → 与门店排行榜不对称

> **mgmt-navbar `ranking` tab 文案**：保留为"排行榜"（不再像门店 ticket 改为"门店排行榜"），因为它现在承载两个子视图。原门店 ticket 中"label 改名"项作废 → 在本 ticket page 中同步回改。

### D8. 不复用 mgmt-scope-picker

**决策**：与门店排行榜一致，不引入 scope picker。

**理由**：
- 排行榜对象是员工（按门店天然分组展示），不需要"市场/门店"切换
- 权限过滤后端按账号 staffLevel 自动应用：
  - `headquarters` → 看全部市场下全部门店的员工
  - `market` → 仅看自己市场下门店的员工

### D9. 时间锚点用 `NOW()`，不接收 date 参数

**决策**：与门店排行榜一致。设计稿无日历，3 个 period 完全由 `NOW()` 锚定。

**风险**：未来若需"任意月份选择"，再扩展 period 为绝对值（如 `'2026-03'`），向后兼容。

### D10. 接口粒度：仅返回所选指标（与门店排行榜一致）

**决策**：`staffRanking(period, metric)` 一次只查一个指标的全员工排行。

**理由**：6 指标 × 3 period × N 员工 一次拉聚合容易超 P95；切换指标的网络往返感知度低。

### D11. 排序规则

**决策**：
- 主排序：`value DESC`
- 二级排序：`employee_name ASC`（避免随机抖动；name 重名风险存在但低）
- 三级排序：`employee_id ASC`（最终兜底）
- 同值并列：标准 `RANK()` 跳号（[100, 100, 80] → 排名 [1, 1, 3]）
- value=0 仍参与排行（垫底）
- 不分页（员工数 ≤200 量级；前端用 scroll-view 滚动）

## 范围外（Follow-up）

- **顾客排行榜 / 商品排行榜** 等其他维度排行 — 未来需求另开 ticket
- **排行榜下钻**：点击某员工查看其指标明细（本月每天的实耗 / 业绩） — 未来需求另开 ticket
- **环比 / 同比 / 对比**：单期排行不展示，未来需求另开 ticket
- **导出排行榜数据**：CSV / Excel 导出，未来需求另开 ticket
- **排行榜分页 / 滚动加载**：当前不分页，全部一次返回；员工数突破 500 后再考虑

## 指标定义

所有指标公式 / 表字段 / 筛选条件统一记录在 [`notes/references/metrics.md`](../references/metrics.md)。

本 ticket 在 T1 中**追加**以下到 metrics.md（如门店排行榜 ticket 已先行追加则跳过 period 段）：
- `[paid_at_period]` / `[service_date_period]` / `[member_level_upgraded_at_period]` 时间窗口缩写（与门店排行榜共享，先到先加）
- "员工排行榜归属规则"小节：6 指标的归属字段（D2 / D3 / D4 / D5 表）

业绩 / 收入两个员工层面公式如不在 metrics.md 现有列表中，T1 顺手补登（与"销售提成收入"语义对齐，明确"业绩 = SUM(sale_allocations.total_amount)" 的员工层定义）。
