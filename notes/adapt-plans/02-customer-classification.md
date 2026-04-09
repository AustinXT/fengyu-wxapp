# 02 — 顾客分类与会员等级规则 适配计划

> ⚠️ **本报告已被 [`00-decisions.md`](./00-decisions.md) 部分覆盖（2026-04-10）**
> - `customerTypeEnum` **不重排**，保留当前 `[流量客, 体验客, 小美客, 会员客]`
> - Q1 答：**保留"小美客"**
> - Q2 答：**没有"注册"档，未消费顾客归入"流量客"**
> - 5 档分类改为**派生视图**（SQL CASE + 聚合），不改底层枚举
> - `recalcCustomerType` 死分支 Bug 仍需修复，但方向是修复而非删除

> 生成日期：2026-04-09
> 生成者：/wx-requirement-adapt
> 会议来源：`notes/meetings/meeting-20260312/article.md §二`、`notes/meetings/meeting-20260324/article.md §七`
> 相关记忆：`project_member_level_rules.md`（会员等级 5 档，滚动 12 个月）
> 相关 commit：`b471d70 refactor(member-level): 解耦会员等级与积分系统，改由 cronTask 日重算 + 升级发权益`

---

## 0 需求分解

| 要素 | 说明 |
|------|------|
| **变更概念** | (1) 顾客类型分级（从 4 档 → 5 档，新增"新客"动态标签、"注册"档）；(2) 保有会员到店时间标签（3 档 → 5 档，新增 6 个月/1 年/超 1 年）；(3) 客流/客量定义固化；(4) 后台顾客筛选三类标签维度新增 |
| **当前行为** | `customer_type` 枚举为 `流量客/体验客/小美客/会员客`；`customer_status` 枚举为 `保有会员-稳定/保有会员-有效/预警沉睡/冰冻/休眠`；staff 顾客 Tab 6 分类卡片基于"活跃/即将流失/流失/沉睡/生日"（纯按天数分桶）；admin 顾客筛选器已包含 customer_type/status/tier/activity |
| **期望行为** | 类型枚举对齐会议："注册/体验客/流量客/会员/新客"；状态标签补齐 6 个月 / 1 年 / 超 1 年分级；staff 顾客 Tab 卡片与会议定义的类型/状态对齐；admin 保留现有筛选器并补充到店间隔标签筛选、统一语义 |
| **受影响角色** | 全体（顾客端客户、员工端美容师/店长、admin 管理层） |
| **受影响端** | db（枚举）、staffApi（customer/order/staff/service）、clientApi（payNotify）、cronTask、admin（customers actions + UI）、staff miniprogram（customer-list 页）、admin miniprogram（customers-page） |

---

## 1 证据收集：现有实现快照

### 1.1 数据库层：枚举定义

文件 `db/schema/enums.ts:58-78`

```ts
export const memberLevelEnum = pgEnum("member_level",
  ["初钻", "星钻", "粉钻", "金钻", "黑钻"])

export const customerSourceEnum = pgEnum("customer_source", [
  "美团","抖音","小程序","推带新","地推卡","拓客卡",
  "老带新","转让店","自进店","内部员工或家属",
])

export const customerTypeEnum = pgEnum("customer_type",
  ["流量客", "体验客", "小美客", "会员客"])

export const spendingTierEnum = pgEnum("spending_tier",
  ["10W+", "6-10W", "3-6W", "1-3W", "1990-1W", "<1990"])

export const monthlyActivityEnum = pgEnum("monthly_activity",
  ["二次客活", "一次客活", "0次客活"])

export const customerStatusEnum = pgEnum("customer_status", [
  "保有会员-稳定",
  "保有会员-有效",
  "预警沉睡",
  "冰冻",
  "休眠",
])
```

### 1.2 数据库层：client_wechat_users 字段

文件 `db/schema/user.ts:36-47`

- `member_level memberLevelEnum` — 由 cronTask 每日凌晨 3 点基于滚动 12 个月消费额重算并派发权益（见 `fengyu-client/cloudfunctions/cronTask/index.js:79-264`）
- `customer_type customerTypeEnum NOT NULL DEFAULT '流量客'` — 由 staffApi/order 和 payNotify 在订单支付时"只升不降"重算
- `spending_tier spendingTierEnum NOT NULL DEFAULT '<1990'` — 历史累计消费档位（6 档）
- `monthly_activity monthlyActivityEnum` — 由 `db/scripts/calc-monthly-activity.js` 或 cronTask 每日重算
- `customer_status customerStatusEnum` — 到店状态（5 档），cronTask 重算，仅对会员客有效

### 1.3 cronTask 等级重算逻辑（权威实现）

文件 `fengyu-client/cloudfunctions/cronTask/index.js:79-86`

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

- 触发时机：`0 0 3 * * * *` 定时触发（`cronTask/index.js:7`）
- 范围：`customer_type = '会员客'`（`cronTask/index.js:188-190`）
- 消费额口径：`sale_orders` `总金额 total_amount`，`status IN ('已支付','已完成') AND sale_order_type != '内部单' AND paid_at >= NOW() - INTERVAL '12 months'`
- 只升不降：`isUpgrade()` 判断，降级仅写日志不派权益（`cronTask/index.js:244-251`）

**记忆定义 vs 代码定义冲突**
`project_member_level_rules.md` 写：`粉钻 ¥29,999 – 59,999 / 金钻 ¥59,999 – 99,999`（边界重叠）
而代码是：`>= 30000 → 粉钻`、`>= 60000 → 金钻`（连续闭/开区间）。代码为准，记忆文件后续需修正。

### 1.4 顾客状态 (customer_status) 重算（当前规则）

文件 `fengyu-client/cloudfunctions/cronTask/index.js:33-68`

```sql
WHEN visits_90d >= 1 AND total_visits >= 6 THEN '保有会员-稳定'
WHEN visits_90d >= 1 AND total_visits <= 5 THEN '保有会员-有效'
WHEN last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '预警沉睡'
WHEN last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'
ELSE '休眠'
```

含义：
- 保有会员-稳定 = 3 个月内到店 且 历史累计 ≥ 6 次
- 保有会员-有效 = 3 个月内到店 且 历史累计 ≤ 5 次
- 预警沉睡 = 3~6 个月前到店
- 冰冻 = 6~12 个月前到店
- 休眠 = 超过 12 个月未到店（或从未到店）

同步实现也存在于 `db/scripts/calc-monthly-activity.js:142-215`（逻辑一致）。

### 1.5 顾客类型 (customer_type) 重算（当前规则）

文件 `fengyu-staff/cloudfunctions/staffApi/routes/order.js:59-124`（镜像实现 `fengyu-client/cloudfunctions/payNotify/index.js:137-198`，两处 CASE 字符串逐字节一致）

```sql
SELECT CASE
  WHEN EXISTS (                              -- ① 会员客
    SELECT 1 FROM sale_orders o
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND (
        o.total_amount >= $2
        OR (o.total_amount + COALESCE((
          SELECT SUM(r.total_amount)
          FROM sale_orders r
          WHERE r.ref_sale_order_id = o.sale_order_id
            AND r.sale_order_type = '回款单'
            AND r.status IN ('已支付','已完成')
        ), 0)) >= $2
      )
  ) THEN '会员客'
  WHEN EXISTS (                              -- ② 小美客
    SELECT 1 FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付','已完成')
      AND sale_order_type = '销售单'
  ) THEN '小美客'
  WHEN EXISTS (                              -- ③ 体验客 ⚠ 与 ② WHERE 子句字节级相同
    SELECT 1 FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付','已完成')
      AND sale_order_type = '销售单'
  ) THEN '体验客'
  ELSE '流量客'                              -- ④
END
```

#### ❗ Bug：`recalcCustomerType` 死分支 — "体验客"永远不可达

**位置**
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:92-103`（`recalcCustomerType` 函数内）
- `fengyu-client/cloudfunctions/payNotify/index.js:166-177`（支付回调重算镜像）

**症状**
上述 SQL 中分支 ② "小美客" 与 ③ "体验客" 的 `WHEN EXISTS (...)` 子查询**逐字符相同**（同一张 `sale_orders` 表、同一组谓词 `client_user_id=$1 / status IN ('已支付','已完成') / sale_order_type='销售单'`）。按 PG CASE 的短路求值语义（第一个返回 TRUE 的 WHEN 即终止后续分支计算），真实可达的执行路径仅三条：

| 顾客状态 | 命中分支 | 返回值 |
|---------|---------|--------|
| 有销售单 且 ① 达阈值判定 TRUE | ① | `'会员客'` |
| 有销售单 且 ① 达阈值判定 FALSE | ② | `'小美客'` |
| 无任何已支付销售单 | ④ | `'流量客'` |

**分支 ③ 在任何输入下都不可能返回** — 因为只要 ③ 的 EXISTS 为 TRUE，② 必然已经为 TRUE 并提前短路；只要 ② 为 FALSE，③ 以相同谓词也必然为 FALSE。这是教科书式的 dead code。

**根因溯源**
Migration `db/migrations/0022_customer_type.sql:3-6` 的原始设计按 `sale_order_type` 区分两类客：
```
-- 体验客：售前体验卡68/99/线上体验等（体验单）
-- 小美客：单笔消费 < 1990 元（普通单）
```
当时 `sale_order_type` 枚举包含 `'体验单'`，③ 分支应当是 `sale_order_type = '体验单'`。随后 commit `538bf4f refactor(staff): 适配 product_kind + sale_order_type 枚举重构` 把 `sale_order_type` 精简到现在的 5 值 `销售单/内部单/回款单/转换单/退款单`（见 migrations 0028-0031），**'体验单' 枚举值被删除**。重构时 `recalcCustomerType` 中 ③ 分支的 `'体验单'` 字符串被批量 find-replace 成 `'销售单'`，没人重新审视语义，结果与 ② 变得同构。重构清单里也没有"体验客判定"条目，所以评审时漏过。

**可观测影响**

1. **枚举值成僵尸值**
   `customer_type = '体验客'` 不再有任何运行时生产者。`db/schema/enums.ts:64` 保留该枚举值仅供 admin 手工更新或 v0.x 历史数据回溯使用；新项目零使用（no-legacy-compat 反馈适用，无存量需兜底）。

2. **Admin 筛选恒空**
   `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx:186` 硬编码 `CUSTOMER_TYPES = ["流量客","体验客","小美客","会员客"]`，用户在后台筛选"体验客"时结果集永远为空，是 silent UX 缺陷。

3. **"只升不降"排序的二次保险让 bug 无法被外部绕过**
   `order.js:114-121` 与 `payNotify/index.js:188-195` 的升级排序表是 `流量客=0 < 体验客=1 < 小美客=2 < 会员客=3`。即使 DBA 或 admin 手工把某顾客 `customer_type` 直改为 `'体验客'`，只要该顾客下一次触发 `recalcCustomerType`（店长开单或微信支付回调），新算出来的值必定 ∈ {会员客, 小美客, 流量客}。命中"小美客"时因 2 > 1 升级成功，"体验客"被覆盖；命中"流量客"时因 0 < 1 升级失败 — 但这属于 "有销售单却降级为流量客" 的逻辑矛盾（说明顾客本来就不该是体验客）。结论：**死分支 + 单向排序 = `'体验客'` 无法长期存续**。

4. **双处镜像**
   同一段 SQL 以拷贝粘贴的方式同时存在于 `staffApi/routes/order.js`（店长开单路径）和 `clientApi/payNotify/index.js`（微信支付回调路径）。任何修复必须两处同时进行；本次 §5.2 变更 3 重写 `recalcCustomerType` 时应把逻辑抽到共享 util（或至少加显式 "镜像于 payNotify/index.js:L 的 P" 注释）避免下次再漂移。

**附加语义漂移（非 dead branch，一并记录）**
Migration 0022 注释声明"单笔消费 >= 1990 → 会员客"，但分支 ① 的 SQL 计算的是 `o.total_amount + SUM(回款单 total_amount)`，即"销售单本身金额 + 其对应回款单累计"，实质是"订单款清总额"而非"单笔"。这个漂移同样是 538bf4f 前后迭代累积的结果。会议 §2.1 明确"历史累计或单笔消费 ≥ 1990 元"，目前 ① 分支的语义（按单张销售单的订单款清口径）**部分对齐**会议但仍非"历史累计"（累计应是该顾客所有销售单 SUM，而代码只把单张销售单与其回款单相加）。本次变更 3 已计划改为 `SUM(total_amount)` 全累计口径，一并纠正。

**结论：不要再把 migration 0022 的注释当作权威**。权威语义以会议 §2.1 + 变更 3 新 SQL 为准，migration 注释仅供历史追溯。

**修复归属**
本 bug 不单独发 fix；§5.2 变更 3 重写 `recalcCustomerType` 时：
- 删除 `'小美客'` 分支（连同枚举）
- "体验客" 判定改为 `EXISTS (JOIN products ON p.product_kind='体验卡')`
- 死分支自然消除
- `payNotify/index.js` 镜像作为变更 3 的同步项一并 patch

**阈值来源**：`system_configs.new_member_threshold` (默认 1990) — 代码中写死回落值 1990，但 dashboard 的 newMembers 指标硬编码 `o.total_amount >= 1980`（`staff.js:676`），阈值两处不一致。

### 1.6 staff 顾客 Tab 分类（当前实现）

文件 `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:502-560` (`stats`) + `566-664` (`listByTag`)

**stats 返回**：

```js
{
  active,        // 最近服务 <= 30 天
  atRisk,        // 30 < 最近服务 <= 60 天
  lost,          // 60 < 最近服务 <= 90 天
  sleeping,      // 最近服务 > 90 天 或 无服务
  birthday,      // 本月生日
  birthdayNext,  // 下月生日
  total,         // 绑定本店顾客总数
  memberCount,   // customer_id 非空计数（会员客等价）
  flowCount,     // customer_id 为空计数
}
```

**问题**：
1. "会员 vs 流量"用 `customer_id IS NOT NULL/NULL` 判断，而不是 `customer_type`。`customer_id` 是 WorkFine 同步来的顾客编号；小程序自主录入的顾客有可能 `customer_id` 为 null 但 `customer_type='会员客'`。应改为 `customer_type`。
2. 状态分桶的天数边界（30/60/90）与 cronTask 的 3 月/6 月/12 月/预警沉睡/冰冻/休眠完全不一致。两套语义并存。
3. 没有"注册"、"体验客"、"新客"分类。

**listByTag 参数**：tag in `active|atRisk|lost|sleeping|birthday|birthdayNext`（`customer.js:615-619`），应扩展对齐。

### 1.7 staff 前端 customer-list 页

文件 `fengyu-staff/miniprogram/pages/customer-list/customer-list.wxml:4-47`

- 6 张分类卡片（活跃/即将流失/流失/沉睡/本月生日/下月生日）
- 顶部 3 Tab（全部/会员客/流量客）
- TS 文件 `customer-list.ts:5,14` 硬编码：
  ```ts
  type TagType = 'active' | 'atRisk' | 'lost' | 'sleeping' | 'birthday' | 'birthdayNext';
  type CustomerType = 'all' | 'member' | 'flow';
  ```
- tier 徽章 `diamond/iron/fan` 使用自定义年度消费档位（`customer.js:99`），不复用 `spending_tier` 枚举 — 表述冗余。

### 1.8 clientApi points.js

文件 `fengyu-client/cloudfunctions/clientApi/routes/points.js:13-31`

已经从 `client_wechat_users.member_level` 单列读取（b471d70 重构后），不再 JOIN member_levels 表。无需本次变更再调整。

### 1.9 admin 顾客管理页

文件 `fengyu-admin/src/actions/customers.ts:130-224` (`getCustomersPaginated`)

已支持筛选字段：`marketId, storeId, memberLevel, customerSource, customerType, spendingTier, monthlyActivity, customerStatus, search`

文件 `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx:29-36`

硬编码列表，需要跟随枚举变更同步更新：
```ts
const MEMBER_LEVELS = ["黑钻","金钻","粉钻","星钻","初钻"]
const CUSTOMER_TYPES = ["流量客","体验客","小美客","会员客"]
const SPENDING_TIERS = ["10W+","6-10W","3-6W","1-3W","1990-1W","<1990"]
const MONTHLY_ACTIVITIES = ["二次客活","一次客活","0次客活"]
const CUSTOMER_STATUSES = ["保有会员-稳定","保有会员-有效","预警沉睡","冰冻","休眠"]
```

顾客详情 serializeCustomer 包含上述全部字段（`customers.ts:36-68`），类型定义 `src/lib/types.ts` 对应也需联动变更。

### 1.10 admin 看板 newMembers 指标

文件 `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:669-691`

- 定义：本期内 `total_amount >= 1980` 且 `client_user_id` 之前无任何已支付订单
- 字段名：`newMembers`
- 前端 `fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts:12,26,79` 展示 newMembers

**问题**：
1. 阈值硬编码 1980，应读 `system_configs.new_member_threshold`（与其他地方一致）
2. "新客"逻辑按"之前无任何已支付订单"判定，但会议原文强调"当月消费**首次达到**会员标准"，即允许之前有订单但未达标；当前实现会漏记从"非会员客→会员客"的跳档用户
3. "毛增加，不扣减流失"语义未编码（目前查询结构本身不扣减，但需要文档明确，并与 admin 看板统计口径统一）

---

## 2 会议决议（期望行为）

### 2.1 顾客类型 5 档（meeting-20260312 §二）

| 会议标签 | 定义 | 计算时机 |
|---------|------|----------|
| **注册** | 仅注册，无任何消费 | 顾客入库即默认 |
| **体验客** | 购买"不算业绩"的卡（68/99 元体验卡，对应 `product_kind = '体验卡'`） | 体验卡订单支付后 |
| **流量客** | 有消费但未达会员标准（< 1990） | 任意非体验卡订单支付后 |
| **会员** | 历史累计或单笔消费 ≥ 1990 元 | 订单支付后（只升不降） |
| **新客** | 当月消费首次达到会员标准的客人（**动态标签**，毛增加不扣减） | 由聚合查询动态计算，不入库字段 |

**重要语义变化**：
1. "小美客" **废弃**（原本与"体验客"分支相同，是 dead code，无存量数据需要迁移）
2. 新增 "注册" 为初始默认值（取代 "流量客"）
3. 新增 "新客" — 这是一个**动态时间窗口派生标签**，不是持久化字段。应在聚合查询时实时计算。
4. 现"体验客"的定义收窄：必须是购买了 `product_kind = '体验卡'` 的订单，而不是"低于会员标准的任何消费"

### 2.2 保有会员到店时间标签（meeting-20260312 §二 + 20260324 §七）

当前实现（3 个月 / 6 个月 / 12 个月）已覆盖大部分节点，但会议强调：

| 新增标签 | 条件 |
|---------|------|
| 活跃会员 | 3 个月内到店（✅ 已有，对应 `保有会员-稳定/有效`） |
| 睡眠会员 | 超过 3 个月未到店（✅ 已有，对应 `预警沉睡`） |
| 6 个月未到店 | 3~6 个月前到店（✅ 已有，对应 `预警沉睡` 下界，但命名未对齐） |
| 1 年未到店 | 6~12 个月前到店（✅ 已有，对应 `冰冻`） |
| 超 1 年未到店 | 12 个月以上（✅ 已有，对应 `休眠`） |

**结论**：`customer_status` 枚举语义基本对齐，**无需新增值**，但会议要求后台筛选 UI 使用"当月到店 / 3 个月未到店 / 6 个月未到店"作为筛选标签 —— 这是 **展示层的别名**，可通过映射函数实现，不需要枚举层变更。

**待定**：张凯方"标签分类表"仍在规整中（20260312 §遗留事项），后续若增加"超 1 年细分"再扩展。

### 2.3 客流 vs 客量定义（meeting-20260312 §二）

| 指标 | 计算单位 | 去重规则 | 数据来源 |
|------|----------|----------|----------|
| 客流 | 人次/日 | 同日去重（一天多个服务单只算一次），月内累加 | `service_orders` |
| 客量 | 人数/月 | 全月去重（一个月来十次只算一人） | `service_orders` |

**当前实现对齐情况**（`staff.js:599-618`）：

- ✅ `footfall` 用 `COUNT(DISTINCT (client_user_id, service_date))` — 正确对齐客流
- ✅ `headcount` 用 `COUNT(DISTINCT client_user_id)` — 正确对齐客量

但前端 dashboard 显示未加注释 + labels 有歧义，需要 UI 层补充提示文案。

### 2.4 后台筛选新维度（meeting-20260324 §七）

张凯接受"实时计算带来的查询慢"，要求：
- **到店间隔标签**：当月到店 / 3 个月未到店 / 6 个月未到店（新维度）
- **消费档位标签**：按年度累计消费分档（`spending_tier` 现有，但枚举是"历史累计"口径，应新增"年度累计"口径或复用）
- **状态标签**：活跃 / 即将流失 / 流失 / 沉睡（现有 `customer_status` 可映射）

**口径冲突**：现有 `spending_tier` 是**历史累计**（`refreshSpendingTier` 无时间过滤，见 `order.js:42-47`），而会议讲的是**年度累计**。两个口径不同，需选择：(A) 重命名现有字段为 `lifetime_spending_tier` 并新增 `annual_spending_tier`；或 (B) 改为年度并迁移历史数据。

---

## 3 差异分析

### 3.1 数据库枚举维度

| 枚举 | 当前 | 期望 | 差异类型 | 处理方式 |
|------|------|------|----------|----------|
| `customer_type` | `流量客/体验客/小美客/会员客` | `注册/体验客/流量客/会员/新客*` | ✅ **结构性变更** | 删除"小美客"、重命名"会员客→会员"、新增"注册"；"新客"为动态标签不入枚举 |
| `customer_status` | `保有会员-稳定/保有会员-有效/预警沉睡/冰冻/休眠` | 无变化（UI 别名映射） | ❌ 无枚举变更 | UI 层新增展示映射 |
| `spending_tier` | 历史累计 6 档 | 年度累计（语义变化） | ⚠ 口径变化 | 选择方案见 §5.2 |
| `monthly_activity` | `二次/一次/0次客活` | 无变化 | ❌ 无枚举变更 | 不动 |
| `member_level` | `初钻/星钻/粉钻/金钻/黑钻` | 无变化（cronTask 已 b471d70 统一） | ❌ 无枚举变更 | 不动；但需校正项目记忆 `project_member_level_rules.md` 的区间描述 |

### 3.2 字段结构维度

| 字段 | 当前默认 | 期望 | 影响 |
|------|---------|------|------|
| `client_wechat_users.customer_type` | `default '流量客'` | `default '注册'` | 需迁移：新建顾客默认改"注册"；存量"流量客"中无任何订单的回刷为"注册" |
| `client_wechat_users.spending_tier` | `default '<1990'` | 视方案 A/B 而定 | 见 §5.2 |
| 新增 `annual_spending_tier`（可选方案 A） | — | 新列 | 方案 A 下新增 |

### 3.3 业务逻辑维度

| 逻辑点 | 当前 | 期望 |
|--------|------|------|
| `recalcCustomerType` 分支 | 体验客分支死代码（条件与小美客相同） | 删除"小美客"；"体验客"判定改为 `EXISTS 体验卡订单`；"会员"判定保留；默认降级"注册" |
| "新客"计算 | `staff.dashboard` 条件 `NOT EXISTS 之前已支付订单` | 条件改为 `NOT EXISTS 之前累计消费达阈值` — 即顾客历史累计 `< threshold` 且本期累计 `>= threshold` |
| 阈值硬编码 1980 | `staff.js:676` 硬编码 | 读 `system_configs.new_member_threshold` |
| `customer.stats` 会员/流量判断 | `customer_id IS NOT NULL` | 改为 `customer_type = '会员'` |
| `customer.stats` 分类桶 | 30/60/90 天固定切分 | 对齐 `customer_status` cronTask 口径（3月/6月/12月），避免两套口径 |
| `customer.listByTag` tag 枚举 | `active/atRisk/lost/sleeping/birthday/birthdayNext` | 扩展：`registered/experience/flow/member/newThisMonth` 类型桶 + 现有状态桶 |

### 3.4 前端渲染维度

| 位置 | 当前 | 期望 |
|------|------|------|
| staff customer-list.wxml 6 卡片 | 按 active/atRisk/lost/sleeping/birthday/birthdayNext | 会议定义：5 类型 + 4 状态 + 2 生日 = 11 卡片太多，需分层展示：第一行类型（注册/体验/流量/会员/新客），第二行状态（活跃/即将流失/流失/沉睡），第三行生日 |
| staff customer-list.ts TagType | `'active'\|'atRisk'\|...` | 扩展枚举，或按两个独立维度（typeTag + statusTag）各自选中 |
| staff customer-list 3-Tab（全部/会员客/流量客） | `customerType: 'all'\|'member'\|'flow'` | 可废弃，与上方 5 类型卡片语义重叠 |
| admin customers-page.tsx hardcode 常量 | 4 customer types | 修改为 5 types，并移除"小美客" |
| admin `CUSTOMER_TYPE_COLORS` 配色表 | 按 4 type | 按 5 type |
| admin 筛选器 | 已有 8 个下拉 | 新增"到店间隔"维度下拉（3 选项，基于 customer_status 映射） |

### 3.5 横切关注点检查清单

- [ ] **权限检查**：无新增权限点，沿用 `customer:list` / `customer:update`
- [ ] **审计日志**：`customer_type` 变更目前由 order/payNotify 隐式触发，需补 `logOperation('customer.typeChange')` 保持与 cronTask memberLevelChange 日志一致性
- [ ] **数据完整性**：`customer_type` 枚举值删除"小美客"时，需检查 `client_wechat_users.customer_type = '小美客'` 是否有存量数据（新项目按规则应为 0 行，但仍需脚本校验；按 no-legacy-compat 反馈，开发阶段无需保留兼容性）
- [ ] **WorkFine 同步**：`db/scripts/sync-workfine.js` 是否写入 customer_type？查 §4.6
- [ ] **seed 测试数据**：`fengyu-admin/src/db/seed.ts` 若有 '小美客' 需刷新
- [ ] **单测/E2E**：`staffApi/__tests__/routes/customer.test.js`、`admin/actions/customers.test.ts`、`admin/e2e/*.spec.ts` 含硬编码枚举值

---

## 4 代码路径追踪结果（按层）

### 4.1 L0 数据库枚举

| 文件 | 行 | 内容 |
|------|-----|------|
| `db/schema/enums.ts` | 64 | `customerTypeEnum` 定义 |
| `db/schema/enums.ts` | 68 | `spendingTierEnum` 定义 |
| `db/schema/enums.ts` | 72-78 | `customerStatusEnum` 定义 |
| `db/schema/user.ts` | 41 | `customerType` 列默认值 |
| `db/schema/user.ts` | 43 | `spendingTier` 列默认值 |

### 4.2 L1 迁移 SQL（读脚手架）

现有相关迁移：
- `db/migrations/0023_document_type.sql` — 售前/售后快照依赖 `customer_type`
- （暂无历史 `customer_type` 枚举修改迁移）

本次将新增迁移：
- `00XX_customer_type_5tier.sql` — 枚举替换
- `00XX_customer_default_registered.sql` — 默认值 + 回刷

### 4.3 L2 staff 云函数

| 文件 | 行 | 角色 |
|------|-----|------|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 29-51 | `refreshSpendingTier()` — 档位重算（含 1990） |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 59-124 | `recalcCustomerType()` — 类型重算（死分支需修） |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 362-381 | 售前/售后 documentType 判断（`customer_type === '会员客'`） |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 632 | 支付后调用 `refreshSpendingTier` |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 1075 | 另一处 `refreshSpendingTier` |
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` | 18-141 | `search` — customer_type 参数 `'member'\|'flow'`，用 `customer_id` 判断（bug） |
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` | 502-560 | `stats` — 6 卡片 + 会员/流量计数 |
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` | 566-664 | `listByTag` — tag 枚举 |
| `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 569-693 | `dashboard` — 客流/客量/newMembers |
| `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 676 | 新客阈值硬编码 1980 |
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | — | `customer_type` 相关（需复查） |
| `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/customer.test.js` | — | 单测枚举值 |

### 4.4 L3 client 云函数

| 文件 | 行 | 角色 |
|------|-----|------|
| `fengyu-client/cloudfunctions/payNotify/index.js` | 113-198 | 支付回调中重算 `spending_tier` + `customer_type`（同 staffApi 逻辑） |
| `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 331 | 下单时读 `new_member_threshold` |
| `fengyu-client/cloudfunctions/clientApi/routes/points.js` | 13-31 | `balance` — 读 `member_level`，✅ 已 b471d70 对齐 |
| `fengyu-client/cloudfunctions/cronTask/index.js` | 33-68 | STEP 1: `customer_status` 重算 |
| `fengyu-client/cloudfunctions/cronTask/index.js` | 79-264 | STEP 2: `member_level` 重算 + 权益派发 |

### 4.5 L4 admin 层

| 文件 | 行 | 角色 |
|------|-----|------|
| `fengyu-admin/src/actions/customers.ts` | 36-68 | `serializeCustomer` 字段映射 |
| `fengyu-admin/src/actions/customers.ts` | 130-224 | `getCustomersPaginated` 筛选 |
| `fengyu-admin/src/actions/customers.ts` | 184-195 | `customerType/spendingTier/monthlyActivity/customerStatus` 各自 eq 筛选 |
| `fengyu-admin/src/actions/customers.ts` | 385-462 | `updateCustomer`（未暴露 customer_type 编辑入口） |
| `fengyu-admin/src/actions/orders.ts` | 532 | 读 new_member_threshold |
| `fengyu-admin/src/lib/types.ts` | — | `Customer` 类型定义含 customerType |
| `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` | 29-36 | 硬编码枚举常量 |
| `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` | 160-210 | 列定义 customerType/memberLevel/spendingTier/customerStatus |
| `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` | 236-339 | 筛选器 UI（8 下拉 + 搜索） |
| `fengyu-admin/src/actions/customers.test.ts` | — | 单测 |
| `fengyu-admin/src/actions/settings.ts` | 97,105,139 | newMemberThreshold 读写 |
| `fengyu-admin/src/db/seed.ts` | — | seed 可能含 '小美客'（需确认） |

### 4.6 L5 同步脚本

`db/scripts/sync-workfine.js` — 需确认同步时是否写 customer_type

### 4.7 L6 staff miniprogram 前端

| 文件 | 行 | 角色 |
|------|-----|------|
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 5 | `TagType` 类型定义 |
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 14 | `CustomerType` 类型定义 |
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 66-76 | `data.stats/customerType/activeTag` |
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 107-120 | `loadDefaultList` 带 `customerType` 参数 |
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 149-167 | 切换类型/标签 |
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.wxml` | 4-47 | 6 卡片 + 3 Tab 结构 |
| `fengyu-staff/miniprogram/pages/customer-list/customer-list.wxss` | — | 对应样式类名 |
| `fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts` | 12,26,79 | newMembers 字段 |
| `fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.wxml` | — | newMembers 展示 |

---

## 5 修改计划（按执行顺序）

### 5.0 前置：产品决策澄清

在动手前需要用户/产品确认以下歧义：

**Q1 — "小会员客" 如何处理？**
当前枚举含"小美客"但代码逻辑是死分支（不可达）。会议定义无此概念。
建议：**直接删除**（new project, no-legacy-compat，存量应为 0 行）。

**Q2 — "注册"与"流量客"的边界？**
"注册"是仅注册无消费，但当前"流量客"含义"未达会员标准的有消费客户"。
建议：
- 保留"流量客"仅表示"有消费但未达会员"
- 新增"注册"作为默认初始值
- 所有 `customer_type IN ('流量客','体验客')` 中无订单的行回刷为"注册"

**Q3 — "体验客"必须购买体验卡吗？**
会议原文：*"购买不算业绩的卡（68/99 元体验卡）"*，隐含必须是 `product_kind = '体验卡'`。
建议：**严格按体验卡判定**，无体验卡订单的低消费客户归"流量客"。

**Q4 — "会员客" 改名为"会员"？**
会议原文用"会员"，当前枚举用"会员客"。
建议：**改名为"会员"**，与会议术语对齐。

**Q5 — "新客"是否需要持久化字段？**
按会议定义"当月消费首次达到会员标准"，本质是**时间窗口派生标签**，每天都在变化。
建议：**不持久化**，只在聚合查询（dashboard/stats/listByTag）中实时计算。

**Q6 — `spending_tier` 口径：历史累计 vs 年度累计？**
当前代码是历史累计（`refreshSpendingTier` 无时间过滤），会议 §七讲"年度累计消费分档"。
建议：方案 A — 保留 `spending_tier` 为历史累计，新增派生 SQL 计算年度累计（不入库），admin 筛选器支持两个口径（需新增 URL 参数）。
或方案 B — 直接改为年度累计，但影响 payNotify 和 staff order 的调用点。
**推荐方案 A**（影响面小）。

**以上问题回答前，后续步骤 5.1 - 5.9 按推荐答案执行。**

---

### 5.1 结构性变更 → 交接 `/wx-change-propagation`

**变更 1：`customerTypeEnum` 枚举重构**

```
删除: '小美客', '会员客'
新增: '注册', '会员'
保留: '流量客', '体验客'
排序: ['注册', '体验客', '流量客', '会员']
```

10 层扫描必查点：
1. L0 `db/schema/enums.ts:64` — 枚举定义
2. L0 `db/schema/user.ts:41` — 列默认值 `'流量客'` → `'注册'`
3. L1 新增迁移 `00XX_customer_type_rename.sql`
4. L2 `staffApi/routes/order.js` — `recalcCustomerType` 整个重写（含"只升不降"排序）
5. L2 `staffApi/routes/order.js:67` — `'会员客'` → `'会员'` 字符串
6. L2 `staffApi/routes/order.js:369` — 售前/售后判断中的 `'会员客'`
7. L2 `staffApi/routes/customer.js:25-30` — `search` 参数 member/flow 映射
8. L2 `staffApi/routes/customer.js:502-560` — `stats`
9. L2 `staffApi/routes/customer.js:615-619` — `listByTag` tag 扩展
10. L3 `payNotify/index.js:113-198` — 同 recalcCustomerType 逻辑
11. L3 `cronTask/index.js:189` — `'会员客'` → `'会员'`
12. L3 `db/scripts/calc-monthly-activity.js:94,155,203` — `'会员客'` → `'会员'`
13. L4 `fengyu-admin/src/actions/customers.ts:185` — enum cast
14. L4 `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx:33` — `CUSTOMER_TYPES` 常量
15. L4 `fengyu-admin/src/lib/types.ts` — Customer.customerType 联合类型
16. L4 `fengyu-admin/src/db/seed.ts` — 种子数据
17. L6 `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts:14` — `CustomerType` 联合类型（前端对应） + `.wxml` 类型卡片列表
18. L7 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/customer.test.js` — 测试固件
19. L7 `fengyu-admin/src/actions/customers.test.ts` — 测试固件
20. L7 `fengyu-admin/e2e/customers.spec.ts`（若存在） — E2E 断言

交接命令：

```
/wx-change-propagation customerTypeEnum 重构为 [注册,体验客,流量客,会员]
```

**变更 2：`customer_type` 默认值从 `'流量客'` → `'注册'`**

1. 列定义 `db/schema/user.ts:41`
2. 迁移 SQL 更新 existing default
3. 回刷 SQL（可选）：无任何订单的 `customer_type = '流量客'` → `'注册'`

### 5.2 逻辑变更（直接执行）

**变更 3：重写 `recalcCustomerType`（修复死分支 + 对齐新语义）**

文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:59-124`
对应：`fengyu-client/cloudfunctions/payNotify/index.js:137-198`（同步）

新逻辑：

```sql
SELECT CASE
  -- 会员：存在销售单使累计消费（或含回款单）达到阈值
  WHEN (
    SELECT COALESCE(SUM(total_amount::numeric), 0)
    FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付', '已完成')
      AND sale_order_type = '销售单'
  ) >= $2 THEN '会员'
  -- 流量客：有销售单但未达阈值
  WHEN EXISTS (
    SELECT 1 FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付', '已完成')
      AND sale_order_type = '销售单'
  ) THEN '流量客'
  -- 体验客：只买过体验卡（product_kind='体验卡'），未买过其他销售单
  WHEN EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN products p ON p.product_id = sk.product_id
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付', '已完成')
      AND p.product_kind = '体验卡'
  ) THEN '体验客'
  -- 注册：无任何消费
  ELSE '注册'
END AS computed_type
```

"只升不降"排序更新：
```
注册(0) < 体验客(1) < 流量客(2) < 会员(3)
```

**变更 4：修复 `customer.stats` 的会员判断**

文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:548-558`

```diff
-  const memberRows = await pg.query(`
-    SELECT COUNT(*) AS cnt FROM client_wechat_users
-    WHERE bound_store_id = $1 AND customer_id IS NOT NULL
-  `, [storeId])
-  const memberCount = Number(memberRows[0].cnt)
+  // 按新枚举分组统计 5 类
+  const typeRows = await pg.query(`
+    SELECT customer_type, COUNT(*) AS cnt
+    FROM client_wechat_users
+    WHERE bound_store_id = $1
+    GROUP BY customer_type
+  `, [storeId])
+  const typeMap = Object.fromEntries(typeRows.map(r => [r.customer_type, Number(r.cnt)]))
+  const memberCount = typeMap['会员'] || 0
```

同时新增"新客"计数（当月首次达标）：

```sql
SELECT COUNT(DISTINCT o.client_user_id) AS new_member_count
FROM sale_orders o
WHERE o.store_id = $1
  AND o.status IN ('已支付', '已完成')
  AND o.paid_at >= date_trunc('month', CURRENT_DATE)
  AND EXISTS (/* 本店本月订单 */)
  AND NOT EXISTS (
    -- 该顾客在本月之前累计消费 < 阈值
    SELECT 1 FROM sale_orders o2
    WHERE o2.client_user_id = o.client_user_id
      AND o2.status IN ('已支付','已完成')
      AND o2.paid_at < date_trunc('month', CURRENT_DATE)
    GROUP BY o2.client_user_id
    HAVING SUM(o2.total_amount::numeric) >= $2
  )
```

**变更 5：统一 stats 状态桶与 cronTask 口径**

将 `customer.js:526-545` 的 30/60/90 天分桶改为读取 `customer_status` 字段（cronTask 已填充）：

```js
const rows = await pg.query(`
  SELECT customer_status, COUNT(*) AS cnt
  FROM client_wechat_users
  WHERE bound_store_id = $1
  GROUP BY customer_status
`, [storeId])

const statusMap = Object.fromEntries(rows.map(r => [r.customer_status, Number(r.cnt)]))

const active = (statusMap['保有会员-稳定'] || 0) + (statusMap['保有会员-有效'] || 0)
const atRisk = statusMap['预警沉睡'] || 0  // 3-6 个月
const lost = statusMap['冰冻'] || 0        // 6-12 个月
const sleeping = statusMap['休眠'] || 0    // 12+ 个月
```

**变更 6：`customer.listByTag` 扩展**

新增 tag：`registered | experience | flow | member | newThisMonth`

`customer.js:605-620` 的过滤器按 customer_type 查；"newThisMonth" 走上面的"新客"聚合。

**变更 7：`staff.dashboard` 新客口径修正**

文件：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:669-691`

1. 删除硬编码 `1980`，改读 `system_configs.new_member_threshold`
2. 条件从"之前无任何已支付订单"改为"之前累计消费 < 阈值"：

```sql
AND NOT EXISTS (
  SELECT 1 FROM sale_orders o2
  WHERE o2.client_user_id = o.client_user_id
    AND o2.status IN ('已支付','已完成')
    AND o2.paid_at < $start
  GROUP BY o2.client_user_id
  HAVING SUM(o2.total_amount::numeric) >= $threshold
)
AND (
  SELECT SUM(o3.total_amount::numeric)
  FROM sale_orders o3
  WHERE o3.client_user_id = o.client_user_id
    AND o3.status IN ('已支付','已完成')
    AND o3.paid_at <= $end
) >= $threshold
```

**变更 8：admin customers-page 常量刷新 + 新增"到店间隔"筛选**

文件：`fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx:29-36`

```diff
-const CUSTOMER_TYPES = ["流量客", "体验客", "小美客", "会员客"]
+const CUSTOMER_TYPES = ["注册", "体验客", "流量客", "会员"]
```

新增"到店间隔"下拉（UI 别名映射到 customer_status）：

```tsx
const VISIT_INTERVALS = [
  { label: '当月到店',      statuses: ['保有会员-稳定', '保有会员-有效'] },
  { label: '3 个月未到店', statuses: ['预警沉睡'] },
  { label: '6 个月未到店', statuses: ['冰冻', '休眠'] },
]
```

对应 `getCustomersPaginated` 新增 `visitInterval` 参数，在后端映射为 `customer_status IN (...)`。

**变更 9：staff customer-list 前端 UI 改造**

文件：`fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` + `.wxml`

- `CustomerType` 类型联合：`'all' | '注册' | '体验客' | '流量客' | '会员' | 'newClient'`
- 卡片分两行：类型 (5) + 状态 (4) + 生日 (2)
- 或保留双 Tab 模式：上方类型 segmentedControl，下方状态卡片

UI 方案由设计确认后实施。

### 5.3 文档 & 记忆同步

- 修正 `project_member_level_rules.md` 的阈值区间表述（`project_member_level_rules.md:9-15`） **(DONE 2026-04-10，见 tickets/bug-memory-member-level-boundary-overlap.md)**
- 更新 `.42cog/pm/staff.pr.spec.md §312` 的"新会员"定义
- 更新 `.42cog/pm/admin.pr.spec.md §232` 的"新会员消费门槛"说明，补充"当月首次达标"定义
- 更新 `.42cog/design/admin.ui.spec.md:825` 相关 UI 规格
- 更新 `CLAUDE.md` 根目录的 MEMORY 摘要

### 5.4 单测 / E2E 跟进

- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/customer.test.js` — 新增 5 类型与新客统计的用例
- `fengyu-admin/src/actions/customers.test.ts` — 筛选参数新增
- `fengyu-admin/e2e/*.spec.ts` — 如有顾客相关断言

### 5.5 seed 数据

`fengyu-admin/src/db/seed.ts` 中若有顾客示例，刷新为新枚举值（若有"小美客"则改）。

### 5.6 部署顺序

1. db 先跑迁移（本地 → 测试环境 → 生产）
2. staffApi + clientApi + payNotify + cronTask 同时部署（依赖同一枚举）
3. admin 部署（读旧枚举会抛类型错误）
4. 小程序前端发版（客户端/员工端）

**关键**：db 迁移和云函数必须同一窗口滚动，不能只先迁 db。建议走 worktree：

```
scripts/worktree-setup.sh feat/customer-5tier
```

---

## 6 风险点

### 6.1 枚举替换风险

**风险**：PG `customer_type` 列无法直接 ADD/DROP VALUE 到任意位置（Postgres 只支持 ADD VALUE，不支持 RENAME/REORDER），必须新建枚举 + 重新绑定列。

**缓解**：参考 `db/migrations/0028-0031` 的 sale_order_type 迁移模式：
1. `CREATE TYPE customer_type_new`
2. `ALTER TABLE client_wechat_users ADD COLUMN customer_type_new customer_type_new`
3. `UPDATE` 数据（`会员客→会员`、`小美客→流量客`或`体验客`、默认`流量客→注册` if 无订单）
4. `ALTER TABLE DROP COLUMN customer_type`
5. `ALTER TABLE RENAME customer_type_new → customer_type`
6. `DROP TYPE customer_type_old; RENAME customer_type_new → customer_type`

### 6.2 新客语义与 member_level 解耦

**风险**：会议的"新客"= 当月首次达到会员标准；而 `member_level` 由 cronTask 滚动 12 个月重算。两者时间窗口不同：
- 新客：**自然月本月首次 ≥ 1990**
- member_level 初钻：**滚动 12 个月累计 ≥ 1990**

两者可能不一致：当月新达标 1990 但滚动 12 个月累计 < 1990（因早期退款/转换）时，"新客" YES 但 `member_level` 仍为 NULL。

**缓解**：文档明确两者为不同指标。"新客"不入库，仅聚合派生；不要尝试与 `member_level` 联动。

### 6.3 cronTask 与订单实时重算的竞争

**风险**：cronTask 每日 3:00 重算 `member_level`；订单支付时 `recalcCustomerType` 实时更新 `customer_type`。若一天内顾客跨档，cronTask 会发一次权益，`customer_type` 可能已在日间更新为"会员"。

**缓解**：这是预期行为（b471d70 的设计意图），无需缓解；但要验证 `customer_type = '会员'` 判断作为 cronTask 重算过滤条件（`cronTask/index.js:189`）的正确性 —— 重命名后记得改。

### 6.4 "小美客"存量数据

**风险**：虽然分支死代码，但若历史某版本曾产生 `'小美客'` 行，迁移会 UPDATE 失败。

**缓解**：按 no-legacy-compat 反馈，开发阶段直接用 `UPDATE client_wechat_users SET customer_type='流量客' WHERE customer_type='小美客'` 兜底再删枚举值。

### 6.5 前端类型检查破坏

**风险**：`customer-list.ts` / `customers-page.tsx` 的 `CustomerType` 联合类型更新后，所有引用处的类型断言需要同步。TS strict 模式会直接报错。

**缓解**：本次变更后立刻跑 `cd fengyu-admin && npx tsc --noEmit`，并在 devtools 里跑 typescript 构建。

### 6.6 阈值配置散落

**风险**：`new_member_threshold = 1990` 有多处硬编码（`staff.js:676` 1980、`order.js:72`、`payNotify/index.js:146` 回落值），数字甚至不一致（1980 vs 1990）。

**缓解**：本次一并统一为 `system_configs.new_member_threshold` 单点读取，默认值统一 1990（会议明确 1990/1980 混用，按 20260324 §3.2 以 ≥1990 为准）。

### 6.7 客流/客量术语前端误读

**风险**：会议明确定义客流 = 日去重累计，客量 = 月去重，但前端 label 文案当前模糊。用户可能继续把 `footfall` 看成总单数。

**缓解**：dashboard.wxml 的 label 加注释（如"客流（人次/日）"、"客量（人数/月）"），并在首次上线时周知张凯。

---

## 7 建议的后续动作

### 7.1 立即可执行（P0）

1. **澄清 §5.0 Q1-Q6 六个歧义点**（产品侧决策），推荐走一个 15 分钟对齐会
2. 启动 worktree：`scripts/worktree-setup.sh feat/customer-5tier`
3. 执行 `/wx-change-propagation customerTypeEnum 重构`，完成 L0-L10 扫描
4. 按 §5.1-5.2 的修改列表，分 3 个 commit 提交：
   - commit A：db schema + migration
   - commit B：云函数 (staffApi + clientApi + payNotify + cronTask)
   - commit C：admin + staff miniprogram + tests

**Changelog：**

- 2026-04-10 修正 project_member_level_rules.md 会员等级区间 off-by-one（见 tickets/bug-memory-member-level-boundary-overlap.md）

### 7.2 近期跟进（P1）

5. **消费档位口径澄清**：§5.0 Q6 答案出来后，决定 `spending_tier` 是否新增 `annual_spending_tier` 派生
6. **新客聚合查询性能**：当前按 §5.2 变更 7 的方案，每个 dashboard 请求都要做窗口聚合，高并发下可能 > 500ms。考虑方案：
   - 物化视图 `mv_new_members_by_month`，cronTask 每日重算
   - 或索引 `(client_user_id, paid_at, status)` 覆盖
7. **补充测试数据**：`seed.ts` 覆盖 5 种新类型各一个样本
8. **admin 看板新客指标**：当前只在 staff dashboard 有，admin 端可考虑补充

### 7.3 中长期（P2）

9. **张凯提供的"标签分类表"到位后**（20260312 §遗留事项），重新评估是否需要进一步细分 `customer_status`（如 "超 1 年" 独立档）
10. **用"动态派生"模式替代部分持久化标签**：`customer_type` 目前持久化，若未来业务口径频繁变更，可考虑改为 `view` 或 `function` 派生
11. **审计日志补充**：b471d70 已为 `member_level` 变更写日志，建议 `customer_type` 变更同样写 `customer.typeChange` 日志，供数据分析师回溯
12. **spec 文档同步**：与 `/meeting-to-spec` skill 联动，把本次决策写入 `.42cog/pm/staff.pr.spec.md §顾客域` 和 `.42cog/cog.md` 的顾客分层定义

### 7.4 与其他适配计划的联动

- 若存在 `01-xxx.md` 或后续 `03-xxx.md` 涉及订单/服务单，注意它们也读 `customer_type`（`order.js:369` 售前/售后判断），修改需保持一致
- 若有"商品管理重构（套餐多选多）"适配计划，要确保"体验卡"品类识别 (`product_kind = '体验卡'`) 的 SKU 查询路径同步调整
- 若有"数据看板"适配计划，客流/客量/新客的定义要与本计划对齐

---

## 8 附录 A — 会议原文关键引述索引

| 议题 | 会议 | 行号 |
|------|------|------|
| 5 档顾客类型定义 | meeting-20260312 §二 顾客分类标签 | article.md:51-58 |
| "毛增加不扣减流失" | meeting-20260312 §二 | article.md:58 |
| 客流/客量定义 | meeting-20260312 §二 客流 vs 客量 | article.md:60-65 |
| 保有会员到店时间标签 | meeting-20260312 §二 保有会员 | article.md:75-83 |
| 1980 元会员标准需做成配置 | meeting-20260312 遗留事项 | article.md:210 |
| 后台顾客分类标签筛选 | meeting-20260324 §七 7.1 | article.md:188-196 |
| 后台筛选包含到店间隔/消费档位/状态 | meeting-20260324 §七 7.1 | article.md:191-194 |
| 实时计算查询慢可接受 | meeting-20260324 §七 7.1 | article.md:196 |
| 是否纳客单自动判断 | meeting-20260324 §3.2 开单字段补充 | article.md:92 |

## 9 附录 B — 关键代码位置索引

| 功能 | 文件 | 行号 |
|------|------|------|
| customerTypeEnum 定义 | `db/schema/enums.ts` | 64 |
| customerStatusEnum 定义 | `db/schema/enums.ts` | 72-78 |
| memberLevelEnum 定义 | `db/schema/enums.ts` | 58 |
| spendingTierEnum 定义 | `db/schema/enums.ts` | 68 |
| client_wechat_users.customerType 列 | `db/schema/user.ts` | 41 |
| cronTask STEP 1 customer_status | `fengyu-client/cloudfunctions/cronTask/index.js` | 33-68 |
| cronTask STEP 2 member_level | `fengyu-client/cloudfunctions/cronTask/index.js` | 79-264 |
| determineMemberLevel 阈值 | `fengyu-client/cloudfunctions/cronTask/index.js` | 79-86 |
| refreshSpendingTier | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 29-51 |
| recalcCustomerType（含死分支） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 59-124 |
| 支付后触发重算（staff 端） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 632, 1075 |
| 售前/售后 documentType 判断 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 362-381 |
| 支付回调重算（client 端 payNotify） | `fengyu-client/cloudfunctions/payNotify/index.js` | 137-198 |
| clientApi points.balance | `fengyu-client/cloudfunctions/clientApi/routes/points.js` | 13-31 |
| customer.search (member/flow 参数) | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` | 25-30 |
| customer.stats 6 卡片 | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` | 502-560 |
| customer.listByTag | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` | 566-664 |
| staff.dashboard 客流客量新会员 | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 569-693 |
| staff.dashboard 新客阈值硬编码 | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 676 |
| admin getCustomersPaginated 筛选 | `fengyu-admin/src/actions/customers.ts` | 130-224 |
| admin customers-page 枚举常量 | `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` | 29-36 |
| admin customers-page 筛选器 UI | `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` | 236-339 |
| staff customer-list TagType 联合 | `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 5 |
| staff customer-list CustomerType 联合 | `fengyu-staff/miniprogram/pages/customer-list/customer-list.ts` | 14 |
| staff customer-list 6 卡片 wxml | `fengyu-staff/miniprogram/pages/customer-list/customer-list.wxml` | 4-47 |
| settings.ts newMemberThreshold | `fengyu-admin/src/actions/settings.ts` | 97,105,139 |
| db calc-monthly-activity | `db/scripts/calc-monthly-activity.js` | 70-215 |

---

## 10 汇总：交接 `/wx-change-propagation` 的一句话摘要

```
/wx-change-propagation customerTypeEnum: 删除'小美客''会员客'，新增'注册''会员'，
  保留'流量客''体验客'，默认值'流量客'→'注册'，同步所有 SQL/TS 字面量与类型联合
```

以及联动变更：
- `client_wechat_users.customer_type` DEFAULT 调整
- `recalcCustomerType` 逻辑从 total_amount 改累计 SUM 判断
- `staff.dashboard` newMembers 阈值取配置 + 语义改"首次累计达标"
- `customer.stats` 会员计数从 `customer_id` 判断改 `customer_type` 判断
- `customer.stats` 状态分桶与 cronTask `customer_status` 口径统一
- admin `customers-page` CUSTOMER_TYPES 常量更新 + 新增"到店间隔"筛选下拉
- staff `customer-list` 卡片改两行（类型/状态分离）

— 完 —
