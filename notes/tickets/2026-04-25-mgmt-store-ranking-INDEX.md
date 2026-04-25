# Tickets Index — 管理层门店排行榜（mgmt-dashboard `ranking` tab）

> 生成日期：2026-04-25
> 需求来源：用户提出的设计稿（顶部 3 个时间维度 chip + 6 个指标按钮 + 门店排行榜列表）
> 现状：`pages/mgmt-dashboard` 的 `ranking` tab 仍是 `placeholder-page`

本需求被拆为 2 个 ticket（前后端可并行）：

| # | Ticket | 端 | 前置 |
|---|---|---|---|
| 1 | [storeRanking-api](./2026-04-25-mgmt-store-ranking-api.md) | staffApi 云函数 | 无 |
| 2 | [storeRanking-page](./2026-04-25-mgmt-store-ranking-page.md) | fengyu-staff 前端 | T1 |

## 依赖图

```
T1 (storeRanking API) ──→ T2 (ranking tab 前端)
```

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
│  [新客量排名] [项目数排名] [客流排名]          │     默认选中"业绩排名"
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

### 6 个指标对应（参见 [`metrics.md`](../references/metrics.md)）

| 按钮 | metrics.md 指标 | 公式 | 时间列 | 备注 |
|------|----------------|------|-------|------|
| 业绩排名 | 业绩 | `SUM(paid_amount)` 销售单+转换单+已支付 | `paid_at` | 金额 |
| 实耗排名 | 实耗 | `SUM(unit_real_price * session_used)` 服务已完成 | `service_date` | 金额 |
| 保有会员排名 | 保有会员数 | `COUNT(*)` `customer_status IN ('保有会员-稳定','保有会员-有效')` | — | **截面快照，不随时间变化**（详见 §决策） |
| 新客量排名 | 新会员 | `COUNT(*)` `old_member_level IS NULL ∧ member_level IS NOT NULL` | `member_level_upgraded_at` | **口径与"新会员"对齐**（详见 §决策） |
| 项目数排名 | 项目数 | _占位（待业务定义）_ | _待定义_ | 接口先返回空排行（每店 value=0） |
| 客流排名 | 客流 | `COUNT(DISTINCT client_user_id)` 服务已完成 | `service_date` | 人数 |

### 时间维度

| 维度 | 含义 | SQL |
|------|------|-----|
| 本月 | 当前自然月 | `date_trunc('month', col) = date_trunc('month', now()::date)` |
| 上月 | 上一个自然月 | `date_trunc('month', col) = date_trunc('month', now()::date - INTERVAL '1 month')` |
| 本年 | 当前自然年 | `date_trunc('year', col) = date_trunc('year', now()::date)` |

> **不包含"今日"**：与 dashboard 首页时间口径有差异（首页含今日不含上月/本年）。两端时间维度独立设计。

## 关键决策记录

### 1. 保有会员排名 与 时间维度的关系

**决策**：保有会员是当前截面快照（参见 metrics.md 门店状况章节："不与日历日期挂钩"），三个时间维度返回的数据**完全相同**。

**实现**：
- 后端：选中 `retainedMember` 指标时，忽略 `period` 参数
- 前端：选中保有会员排名后，时间 chip 仍可点击但数据不变；考虑加灰色提示文字"该指标为当前快照"（可选）

**理由**：与 dashboard 首页保有会员卡口径一致（截面快照）；若产品坚持要"那一天的保有会员数"，需另设审计字段（属另开 ticket 范围）。

### 2. 新客量 = 新会员？

**决策**：首版按"新会员"口径实现（`old_member_level IS NULL` ∧ `member_level IS NOT NULL`，按 `member_level_upgraded_at` 命中时间窗）。

**风险**：业务可能想表达的是"首次到店人数"或"首次绑店人数"，而非"首次升级会员人数"。

**Follow-up**：实现完成后给业务方看真实数据，确认口径是否一致；若需切换，开新 ticket 单独调整 `queryNewMembers` 的 SQL（其余无影响）。

### 3. 项目数排名

**决策**：与 dashboard 首页一致，先返回空排行（每店 value=0），等业务方明确"项目数"是 service_items 行数 / 去重 sku 数 / 某分类的服务次数后另开 ticket。

**前端表现**：选中"项目数排名"后展示"功能开发中"占位 toast，或列表全 `--`；与首页保持一致。

### 4. 接口粒度：一次返回 6 指标 vs 仅返回所选指标

**决策**：**仅返回所选指标**（`storeRanking(period, metric)`）。

**理由**：
- 切换时间维度比切换指标更频繁（用户先看业绩，再切上月对比，再切本年）
- 6 指标一次查需要 ≥18 条 SQL（6 × 3 时间），P95 容易超标
- 单指标接口 SQL 模板简单，易维护、易测
- 切换指标的网络往返感知度低（chip 切换会触发 loading）

### 5. 排行榜默认全店降序

**决策**：
- 默认按 `value DESC` 排序
- 同值时按 `store_name ASC` 二级排序（避免随机抖动）
- 全部门店均返回（不分页），客户端展示全表
  - 当前门店总数 ≤30 量级，不必分页；后续门店膨胀到 100+ 再加分页

### 6. 不复用 mgmt-scope-picker

**决策**：排行榜不引入 scope picker。

**理由**：排行榜本身就是按门店聚合，用户无需再选"市场/门店"；权限过滤由后端按账号 staffLevel 自动应用：
- `headquarters` → 看全部门店
- `market` → 仅看自己市场下门店

## 范围外（Follow-up）

- **员工排行榜**（截图中底部 tab "员工排行榜"还在 navbar 中）：仍是 placeholder，**不在本批 ticket 内**
- **项目数指标的真实 SQL**：等业务定义，与 dashboard 首页同步推进
- **新客量口径复核**：实现后业务对数据，确认是否换口径
- **排行榜下钻**：点击某行查看门店明细，未来需求另开 ticket
- **环比/同比/对比**：单期排行不展示，未来需求另开 ticket
- **导出排行榜数据**：CSV / Excel 导出，未来需求另开 ticket

## 指标定义

所有指标公式 / 表字段 / 筛选条件统一记录在 [`notes/references/metrics.md`](../references/metrics.md)。
本 ticket 在 T1 中**追加** `[paid_at_period]` / `[service_date_period]` / `[member_level_upgraded_at_period]` 时间窗口缩写定义到 metrics.md。
