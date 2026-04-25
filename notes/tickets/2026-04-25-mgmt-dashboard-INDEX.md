# Tickets Index — 管理层数据中心首页（mgmt-dashboard `dashboard` tab）

> 生成日期：2026-04-25
> 需求来源：用户提出的设计稿（日历 + 市场/门店筛选 + 8 卡片：业绩 / 实耗 / 客流 / 客量 / 新会员 / 项目数）

本需求被拆为 4 个串/并行可控的 ticket：

| # | Ticket | 端 | 前置 |
|---|---|---|---|
| 1 | [snapshot-fields](./2026-04-25-mgmt-dashboard-snapshot-fields.md) | DB schema + staffApi + cronTask | 无 |
| 2 | [summary-api](./2026-04-25-mgmt-dashboard-summary-api.md) | staffApi | T1 |
| 3 | [scope-picker](./2026-04-25-mgmt-dashboard-scope-picker.md) | fengyu-staff 组件 + staffApi | 无（与 T2 并行） |
| 4 | [home-page](./2026-04-25-mgmt-dashboard-home-page.md) | fengyu-staff 页面 | T1 + T2 + T3 |

## 依赖图

```
T1 (snapshot fields) ────┐
                         ├─→ T2 (summary api) ─┐
                                                ├─→ T4 (home page)
                         ┌─→ T3 (scope picker)─┘
```

## 推荐执行顺序

1. **Day 1–2**：T1（schema + 写入路径 + cron 调整 + 历史回填）
   - 重点：双库 migrate + 数据完整性 SQL 自检
2. **Day 2–3**（与 T1 收尾并行）：T3（scope-picker 组件 + scopeOptions 接口）
3. **Day 3–4**：T2（summary 接口）—— 必须 T1 已完成
4. **Day 4–5**：T4（首页整合）—— 必须 T1/T2/T3 都已完成

## 范围外（Follow-up）

- **项目数指标的真实实现**：T4 中先占位 `--`；待业务方明确"项目数"是 service_items 行数、还是去重后的 sku 数、还是某个分类的服务次数；后续另开 ticket
- **时间维度扩展**：首版仅"今日 + 本月"；如需要"上月 / 季度 / 任意区间"另开 ticket
- **数据中心下钻**：卡片点击查看明细（按门店 / 按品类 / 按员工）另开 ticket
- **环比 / 同比**：当前不展示；产品需求确认后另开 ticket
- **mgmt-dashboard 其余 3 个 tab**（排行榜 / 顾客 / 我的）：仍是 placeholder，不在本批 ticket 内

## 指标定义

所有 8 个指标的公式 / 表字段 / 筛选条件统一记录在 [`notes/references/metrics.md`](../references/metrics.md)。
**新增统计指标必须先在 metrics.md 登记**，再在 ticket 中引用，避免口径分散。

## 关键决策记录

- **新建 `mgmtDashboard.summary` 而非扩展 `staff.dashboard`**：避免一个接口兼容个人视角和管理层视角两种语义
- **市场维度过滤统一走 `org_nodes` 子查询**，不用 `service_orders.market_name` 文本匹配：org_nodes 是关系来源，市场改名不会让历史统计漂移
- **门店业绩用 `paid_amount`，生美业绩用 `received` SUM**：paid_amount 是订单层（含转换/回款抵消），received 是行级、可按生美过滤
- **`old_member_level IS NULL` 作为"新会员"判定**：与"首次升级"语义一致；历史数据全部 NULL 是预期，不做反推回填
- **3 个新增字段全部 nullable**：先保证 migration 可上线、写入路径可逐步完善；首版不强制 NOT NULL
