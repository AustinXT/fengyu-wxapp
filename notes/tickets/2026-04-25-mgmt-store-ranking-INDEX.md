# Tickets Index — 管理层门店排行榜（mgmt-dashboard `ranking` tab）

> 生成日期：2026-04-25
> 需求来源：用户提出的设计稿（顶部 3 个时间维度 chip + 6 个指标按钮 + 门店排行榜列表）
> 现状：`pages/mgmt-dashboard` 的 `ranking` tab 仍是 `placeholder-page`

本需求被拆为 2 个 ticket（前后端可并行）：

| # | Ticket | 端 | 前置 |
|---|---|---|---|
| 1 | [storeRanking-api](./2026-04-25-mgmt-store-ranking-api.md) | staffApi 云函数 | T5（保有会员历史化，方案 B）— 软依赖：保有会员排名口径直接套用 T5 SQL；T5 已有完整设计可参考 [`metrics-date-alignment.md` §3.5](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md) |
| 2 | [storeRanking-page](./2026-04-25-mgmt-store-ranking-page.md) | fengyu-staff 前端 | T1 |

## 依赖图

```
metrics-date-alignment T5 (保有会员方案 B) ──┐
                                             ├──→ T1 (storeRanking API) ──→ T2 (ranking tab 前端)
                                             │
                            metrics.md 已有定义（项目数/新会员）
```

> **T5 与本 ticket 的协同**：T5 在 mgmt-dashboard.js 中定义 `queryRetainedMemberCount($date)` 的方案 B SQL；本 ticket 的"保有会员排名"复用相同口径（按 store_id 分组聚合），SQL 模板与 T5 一致。
> 若 T5 尚未合并，本 ticket 可直接落地 SQL（共享同一公式来源 T5 ticket §3.5），无强依赖；T5 合并后两处可统一抽 helper。

## 推荐执行顺序

1. **Day 1**：T1（接口 + metrics.md 时间窗口扩展 + 单元测试）
2. **Day 2**：T2（前端 ranking tab 实现，替换 placeholder + 真机联调）

## 需求复述

### 视图（来自设计稿截图）

```
┌─────────────────────────────────────────────┐
│  [本月] [上月] [本年]                        │  ← 时间维度 chip（默认本月）
│                                              │
│  [业绩排名]  [实耗排名]   [保有会员排名]      │  ← 6 个指标按钮
│  [新会员排名] [项目数排名] [客流排名]          │     默认选中"业绩排名"
│                                              │
│  ─────────── 排行榜 ───────────              │
│  排名  店名         所属市场     数据         │
│   1    南昌旭辉店    南昌市场    10000.00 业绩│
│   2    南昌云锦店    南昌市场    10000.00 业绩│
│   3    九江鸿蒙店    九江市场    10000.00 业绩│
│   ...                                        │
└─────────────────────────────────────────────┘
[首页] [门店排行榜*] [员工排行榜] [我的]   ← 已存在的 mgmt-navbar
```

> 设计稿截图中第 4 个按钮写的是"新客量排名"。已确认是笔误，业务统一口径为"新会员"（与 metrics.md / dashboard 首页一致）。文案、命名、key 全部使用"新会员"。

### 6 个指标对应（参见 [`metrics.md`](../references/metrics.md)）

| 按钮 | metrics.md 指标 | 公式 | 时间列 / 参考日 | 备注 |
|------|----------------|------|-------|------|
| 业绩排名 | 业绩 | `SUM(paid_amount)` 销售单+转换单+已支付 | `paid_at` 落入 period | 金额 |
| 实耗排名 | 实耗 | `SUM(unit_real_price * session_used)` 服务已完成 | `service_date` 落入 period | 金额 |
| 保有会员排名 | 保有会员（方案 B 实时计算） | `COUNT(DISTINCT client_user_id)` 满足 ① `became_member_at::date <= refDate` ② 90 天内有 service_orders 已完成单 | refDate = period 末（详见 §决策 D1） | 人数；按 `c.bound_store_id` 分组 |
| 新会员排名 | 新会员 | `COUNT(*)` `old_member_level IS NULL ∧ member_level IS NOT NULL` | `member_level_upgraded_at` 落入 period | 人数 |
| 项目数排名 | 项目数 | `SUM(service_items.session_used)` 服务已完成 ∩ `sales_category IN ('自销自耗','他销自耗')` | `service_date` 落入 period | 计数；快照字段 `sales_category` 已落库（service.create 已写入） |
| 客流排名 | 客流 | `COUNT(DISTINCT client_user_id)` 服务已完成 | `service_date` 落入 period | 人数 |

### 时间维度

| 维度 | 含义 | 落 period 的 SQL（业绩/实耗/客流/新会员/项目数） | refDate（保有会员） |
|------|------|---------------------------------------------------|----------------------|
| 本月 | 当前自然月 | `date_trunc('month', col) = date_trunc('month', NOW()::date)` | `NOW()::date`（本月当下） |
| 上月 | 上一个自然月 | `date_trunc('month', col) = date_trunc('month', NOW()::date - INTERVAL '1 month')` | `date_trunc('month', NOW()::date) - INTERVAL '1 day'`（上月最后一天）|
| 本年 | 当前自然年 | `date_trunc('year', col) = date_trunc('year', NOW()::date)` | `NOW()::date`（本年当下） |

> **不包含"今日"**：与 dashboard 首页时间口径有差异（首页含今日不含上月/本年）。两端时间维度独立设计。
> **保有会员特殊**：5 个指标按 period 区间求和/计数；保有会员是"refDate 时点的状态快照"，month 与 year 在本月内 refDate 同为今天 → 数值相同；lastMonth 反映上月底的保有数。这是方案 B 在排行榜场景下的自然结果，详见 §决策 D1。

## 关键决策记录

### D1. 保有会员排名按 T5 方案 B 实时计算（随时间变化）

**决策**：保有会员排名**随时间变化**，复用 [`metrics-date-alignment.md` §3.5 T5 方案 B](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md) 的实时计算口径。

**口径**："refDate 那天处于保有会员状态的会员客人数"，按 `c.bound_store_id` 分组：
- `became_member_at::date <= refDate`（refDate 那天已是会员客）
- 存在 `service_orders` 已完成单且 `service_date` 落在 `refDate - 90d ~ refDate` 区间（refDate 前 90 天有到店）

**refDate 取值**：
| period | refDate |
|--------|---------|
| month | `NOW()::date`（本月当下，因为本月还没结束） |
| lastMonth | `date_trunc('month', NOW()::date) - INTERVAL '1 day'`（上月最后一天） |
| year | `NOW()::date`（本年当下） |

**已知行为**：当前若处于 4 月，month 与 year 的 refDate 都是今天（4-25），保有会员数完全相同；只有 lastMonth 反映上月底的快照。这是"保有快照本质是时点状态"的合理结果。如果业务想要"本月期间增加的保有会员"或"period 内活跃过的会员"，那是另一个语义（"活跃会员"），需另开 ticket。

**前置依赖**：
- `client_wechat_users.became_member_at` 字段（schema/user.ts:53 已存在）
- T5 ticket 是同时段的姐妹 ticket，两者使用同一 SQL 模板；若 T5 已先合并，本 ticket 复用 helper；若 T5 未合并，本 ticket 直接落地相同 SQL。

### D2. 新客量 = 新会员（命名统一）

**决策**：图中"新客量排名"文案为笔误，业务无"新客"概念；统一为"新会员"。

**实现**：
- 接口 metric key：`newMember`
- 前端按钮文案、key、单位标签 全部使用 `新会员` / `新会员排名`
- SQL 与 metrics.md 一致：`COUNT(*)` `old_member_level IS NULL ∧ member_level IS NOT NULL`，按 `member_level_upgraded_at` 命中 period

### D3. 项目数排名按 metrics.md 真实定义

**决策**：metrics.md 已落定项目数公式（2026-04-25 变更），本 ticket 直接按真实公式实现。

**公式**：`SUM(service_items.session_used)` JOIN service_orders；`status='已完成'` ∩ `service_items.sales_category IN ('自销自耗','他销自耗')` ∩ `service_date` 落入 period。

**前置确认**：
- `service_items.sales_category` 列：✅ schema/service.ts:64 已存在
- 写入路径：✅ `staffApi/routes/service.js:195-210` `service.create` 已从 sale_items 拷贝快照
- 历史数据 sales_category：⚠️ T1 之前创建的 service_items 是否已回填 sales_category？需在 T1 准备阶段跑一条数据自检 SQL（`SELECT COUNT(*) FROM service_items WHERE sales_category IS NULL`）；缺失则在本 ticket 内补回填脚本

### D4. 接口粒度：仅返回所选指标

**决策**：`storeRanking(period, metric)` 一次只查一个指标的全门店排行。

**理由**：
- 切换时间维度比切换指标更频繁（用户先看业绩，再切上月对比，再切本年）
- 6 指标 × 3 period = 18 条 SQL 一次拉，P95 容易超标
- 单指标 SQL 模板简单，易维护、易测
- 切换指标的网络往返感知度低（chip 切换会触发 loading）

### D5. 排行榜默认全店降序

**决策**：
- 默认按 `value DESC` 排序
- 同值时按 `store_name ASC` 二级排序（避免随机抖动）
- 全部门店均返回（不分页），客户端展示全表
- value=0 的门店仍参与排行（垫底），让管理者看到"哪些店没数据"
- 同值并列：标准 RANK 跳号（[100, 100, 80] → 排名 [1, 1, 3]）

### D6. 不复用 mgmt-scope-picker

**决策**：排行榜不引入 scope picker。

**理由**：排行榜本身就是按门店聚合，用户无需再选"市场/门店"；权限过滤由后端按账号 staffLevel 自动应用：
- `headquarters` → 看全部门店
- `market` → 仅看自己市场下门店

### D7. 时间锚点用 `NOW()`，不接收 date 参数

**决策**：设计稿无日历组件，3 个 period 完全由 `NOW()` 锚定，前端不传日期。

**风险**：未来若需"任意月份选择"，再扩展 period 为绝对值（如 `'2026-03'`），向后兼容。

## 范围外（Follow-up）

- **员工排行榜**（截图中底部 tab "员工排行榜"还在 navbar 中）：仍是 placeholder，**不在本批 ticket 内**
- **mgmt-navbar tab 文案**："排行榜" → "门店排行榜"（在 [Ticket 2 §2.8](./2026-04-25-mgmt-store-ranking-page.md) 同 PR 顺手改）
- **保有会员"活跃会员"语义**：如业务想要"本月期间到店的会员客（不限定 90 天前 history）"，那是另一个指标，另开 ticket
- **排行榜下钻**：点击某行查看门店明细，未来需求另开 ticket
- **环比/同比/对比**：单期排行不展示，未来需求另开 ticket
- **导出排行榜数据**：CSV / Excel 导出，未来需求另开 ticket

## 指标定义

所有指标公式 / 表字段 / 筛选条件统一记录在 [`notes/references/metrics.md`](../references/metrics.md)。
本 ticket 在 T1 中**追加** `[paid_at_period]` / `[service_date_period]` / `[member_level_upgraded_at_period]` 时间窗口缩写定义到 metrics.md。

保有会员的方案 B 公式由 [`metrics-date-alignment.md` T5](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md) 落地到 metrics.md，本 ticket 不重复登记。
