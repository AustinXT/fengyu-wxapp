# Ticket: 管理视图首页指标按 selectedDate 对齐 — 排查 + 阶段 1 + 子 ticket 索引

> 生成日期：2026-04-25
> 严重级别：P2（数据不出错，但 UX 误导 + 部分指标 / 派生指标在历史日期下漂移；且发现 customer_status 计算口径 bug）
> 端：fengyu-staff（mgmt-dashboard 页面）+ staffApi + fengyu-client/cronTask + db schema
> 决策结果（2026-04-25 已确认）：
>   - 决策 1 = **1-A**：UI 标签改静态「当日/当月」
>   - 决策 2 = **2-C**：完整历史化（4 项门店状况 + 11 项派生）
>   - 决策 3 = **customer_status 仅对 customer_type='会员客' 有值**（修 cronTask STEP 1 计算口径 bug）
>   - 决策 4 = **T5 改用实时计算（方案 B）**，作废原快照表方案
> 关联（不并入本 ticket）：[mgmt-dashboard-project-count-metric](./2026-04-25-mgmt-dashboard-project-count-metric.md)（项目数指标）

---

## 0 一句话目标

把 mgmt-dashboard 首页 13 项原始指标 + 11 项派生指标全部对齐 `selectedDate` 语义。
落地分两阶段：
- **阶段 1（本 ticket 范围）**：UI 标签静态化（"今日/本月" → "当日/当月"）+ 过渡期角标（标注当前未历史化的快照范围）
- **阶段 2（拆 5 个子 ticket）**：4 项门店状况（会员/保有/员工/门店）历史化 + 派生指标分母切换

阶段 2 全部上线后，移除阶段 1 的过渡角标。

---

## 1 现状排查（13 项原始 + 11 项派生）

### 1.1 大卡 + 小卡（A 类，7 项已正确按 selectedDate）

| 卡片 | 后端 query | 时间列 | 评估 |
|------|-----------|--------|------|
| 门店业绩 | `queryStoreRevenue` | `sale_orders.paid_at` | ✓ 正确 |
| 生美业绩 | `queryShengmeiRevenue` | 同上 | ✓ |
| 门店实耗 | `queryStoreConsume` | `service_orders.service_date` | ✓ |
| 生美实耗 | `queryShengmeiConsume` | 同上 | ✓ |
| 客流 | `queryFootfall` | `service_orders.service_date` | ✓ |
| 客量 | `queryHeadcount` | 同上 | ✓ |
| 新会员 | `queryNewMembers` | `client_wechat_users.member_level_upgraded_at` | ✓ |

**剩余问题**：UI 标签「今日/本月」（`mgmt-dashboard.wxml:28-67`，16 处）+ 接口字段命名 `today/month` 不符实。

### 1.2 项目数（D 类）

引用 [`2026-04-25-mgmt-dashboard-project-count-metric.md`](./2026-04-25-mgmt-dashboard-project-count-metric.md)。本 ticket 不重复。

### 1.3 门店状况（B 类，4 项实时快照 — 决策 2-C 全部历史化）

| 状况字段 | 当前 SQL | schema 历史审计字段 | 历史化代价 |
|----------|---------|-------------------|----------|
| **会员数** memberCount | `customer_type='会员客'` 全表 COUNT | **半有**：`client_wechat_users.becameMemberAt`（schema/user.ts:53）| **轻**：仅改 SQL |
| **保有会员** retainedMemberCount | `customer_status IN ('保有会员-稳定','保有会员-有效')` 全表 COUNT | **无**：`customer_status` 由 cronTask 每日重算 | **重**：新建快照表 + 每日 cron 写历史 |
| **员工数** employeeCount | `is_resigned=FALSE ∧ skills && {美容师,养生师}` 全表 COUNT | **无**：仅 `createdAt`（同步时间，≠ 入职时间） | **中**：加 `hired_at` + `resigned_at` 两列 + 同步源回填 |
| **门店数** storeCount | `org_nodes WHERE type='门店'` 全表 COUNT | **半有**：`stores.opening_date` 已存在；`stores.is_closed` 无 `closed_at` | **中**：加 `stores.closed_at` 列 + 回填 |

### 1.4 派生指标（C 类，11 项分子分母异口径 — 决策 2-C 同步历史化）

| 派生 | 分子 | 分母 | 评估 |
|------|------|------|------|
| 月店均（业绩/生美/实耗/生美实耗，4 项） | 本月数据 ✓ | `storeCount`（快照）✗ | △ 漂移 |
| 占比（memberRetainRate） | retainedMemberCount（快照） | memberCount（快照） | ✗ 完全不变 |
| 店均会员 / 店均保有 | 各快照 | storeCount（快照） | ✗ 完全不变 |
| 人均会员数 ×2 | memberCount（快照） | employeeCount（快照） | ✗ 完全不变 |
| 人均业绩/生美/实耗/生美实耗/客流/客量/新客（日/月，14 数字） | 当日/当月 ✓ | employeeCount（快照）✗ | △ 漂移 |
| 人均项目数 | 占位 | employeeCount | △ 跟项目数 ticket |

---

## 2 阶段 1 — 本 ticket 实施清单

### 2.1 前端：标签替换（决策 1-A，A 类 7 项）

**`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxml`**

将 4 张大卡（line 28-49）+ 4 张小卡（line 56-73）共 16 处替换：

```xml
<!-- 旧 -->
<text class="lbl">今日：</text>
<text class="lbl">本月：</text>

<!-- 新 -->
<text class="lbl">当日：</text>
<text class="lbl">当月：</text>
```

> 项目数小卡也按相同方式改文案，但 value 在该 ticket 内仍为 `--`，由项目数 ticket 单独替换。
> 「人效数据」区的 `日均` / `月均` 标签保持不变。

### 2.2 前端：过渡期角标（决策 2-C 完成前的提示，落地后移除）

**`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxml`**

「门店状况」section title 下方插入（line 77 之后）：

```xml
<view class="dash-section-title">门店状况</view>
<view class="dash-section-note dash-section-note--transitional">该区域当前为实时快照，不随所选日期变化（历史化改造进行中）</view>
```

「人效数据」section title 下方（line 108 之后）：

```xml
<view class="dash-section-title">人效数据</view>
<view class="dash-section-note dash-section-note--transitional">分子按所选日期出数，分母（员工数）当前为实时快照（历史化改造进行中）</view>
```

**`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxss`** 新增：

```css
.dash-section-note {
  font-size: 24rpx;
  color: #999;
  margin: -16rpx 0 16rpx 0;
  padding: 0 16rpx;
  line-height: 1.5;
}
.dash-section-note--transitional {
  color: #C0322A;
}
```

> `--transitional` 修饰符让阶段 2 完成后能精准定位移除。

### 2.3 metrics.md 更新

**`notes/references/metrics.md`** 「门店状况 / 人效（截面快照，不随日历变化）」章节首句之前追加：

```md
> **2026-04-25 起**：本节 4 项及其派生指标已规划历史化改造（详见 ticket 索引
> [`mgmt-dashboard-metrics-date-alignment.md`](../tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md)）。
> 改造完成前为实时快照，UI 区域有过渡角标提示。
```

变更记录追加：

```md
| 2026-04-25 | 文案语义对齐（"今日/本月" → "当日/当月"）；门店状况/人效区追加过渡期角标；规划完整历史化（拆 5 子 ticket） |
```

### 2.4 阶段 1 测试与验收

- 微信开发者工具登录 HQ → mgmt-dashboard → 8 张卡片左侧标签全部为「当日/当月」
- 「门店状况」「人效数据」section 下方显示红色过渡提示文案
- 切换 selectedDate → A 类 7 项数据变化、B 类 4 项不变（与角标说明一致）
- `mgmt-dashboard.test.js` 现有用例全绿（后端 SQL 不修改）

### 2.5 阶段 1 交付物

- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxml` 16 处「今日/本月」→「当日/当月」
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxml` 「门店状况」「人效数据」section 下方各加 1 行 `dash-section-note--transitional`
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.wxss` 新增 `.dash-section-note` + `.dash-section-note--transitional` 样式
- [ ] `notes/references/metrics.md` 截面快照章节追加备注 + 变更记录追加 1 行
- [ ] 微信开发者工具端到端验收

---

## 3 阶段 2 — 子 ticket 索引（6 个，独立推进）

下表是 2-C 完整历史化方案拆分。每个子 ticket 独立的 schema 改动 + SQL + 测试 + 验收，
本 ticket 仅给出骨架，每个子 ticket 在执行前需各自展开为完整 ticket。

### 3.1 子 ticket 依赖图

```
T0（cronTask customer_status 口径修复，先行）
   │
T1（阶段 1，本 ticket）
   │
   ├─→ T2 (B-1 会员数)  ─┐
   ├─→ T3 (B-2 员工数)  ─┤
   ├─→ T4 (B-3 门店数)  ─┼─→ T6 (C 派生指标分母切换)
   └─→ T5 (B-4 保有会员，方案 B 实时计算)─┘
                                          │
                                          └─→ 移除阶段 1 过渡角标
```

> T0 是独立 bug 修复，应优先合并（与本 ticket 阶段 1 可并行）。
> T2-T5 可完全并行；T6 必须等 T2-T5 全部完成；移除角标在 T6 后或与 T6 同一 PR。

### 3.2 T0 — cronTask customer_status 计算口径修复（bug fix，前置）

**目标**：customer_status 只对 `customer_type='会员客'` 的顾客计算，非会员客一律为 NULL。

**当前 bug**：
- `fengyu-client/cloudfunctions/cronTask/index.js` STEP 1（每日 03:00 跑）对**所有** customer_type 计算 customer_status，导致非会员客（流量客/体验客/小美客）也被打上"保有会员-稳定/有效"标签
- `db/scripts/update-customer-status.js`（备用脚本）有相同 bug
- `db/scripts/calc-monthly-activity.js`（line 197-211）已有正确语义（先 NULL 非会员 + 仅算会员），但**不被生产 cron 调用**
- 现状：admin 客户列表中非会员客可能显示"保有会员-稳定"等不合理标签；mgmt-dashboard 的「保有会员数」高估

**修复 SQL（cronTask STEP 1 + update-customer-status.js 同步）**：

```sql
-- 1. 非会员客一律置 NULL（清理脏数据 + 防止 customer_type 反向变更后残留）
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客';

-- 2. 会员客有到店记录的：按 visits_90d / total_visits 打状态
WITH visit_stats AS (
  SELECT
    so.client_user_id,
    MAX(so.service_date) AS last_service_date,
    COUNT(DISTINCT so.service_date) AS total_visits,
    COUNT(DISTINCT so.service_date) FILTER (
      WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
    ) AS visits_90d
  FROM service_orders so
  WHERE so.status = '已完成' AND so.client_user_id IS NOT NULL
  GROUP BY so.client_user_id
)
UPDATE client_wechat_users u
   SET customer_status = CASE
         WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
         WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '预警沉睡'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
         ELSE '休眠'::customer_status
       END,
       updated_at = NOW()
  FROM visit_stats vs
 WHERE u.user_id = vs.client_user_id
   AND u.customer_type = '会员客';

-- 3. 会员客但完全无到店记录的：置 '休眠'
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   );
```

**改动文件**：
- `fengyu-client/cloudfunctions/cronTask/index.js` 替换 `UPDATE_CUSTOMER_STATUS_SQL` + `RESET_NO_VISITS_SQL` 两处 SQL，按上述三段
- `db/scripts/update-customer-status.js` 同步修改
- `db/scripts/calc-monthly-activity.js` `calcCustomerStatus` 函数与 cronTask 对齐（已基本一致，仅小修）
- `notes/references/metrics.md` 「保有会员数」行追加注：「customer_status 由 cronTask STEP 1 每日重算，仅对 customer_type='会员客' 打值」
- 一次性数据修复（部署后立即跑）：上述 3 段 SQL 在 dev/prod 库各跑一次，让脏数据收敛
- 测试：cronTask 单测扩展（如有）+ 数据自检 SQL（COUNT WHERE customer_type != '会员客' AND customer_status IS NOT NULL 应为 0）

**部署后验收**：
- admin 客户列表筛选「保有会员-稳定」：返回的所有顾客 customer_type 都是「会员客」
- mgmt-dashboard 保有会员数：相比修复前**会下降**（因为之前高估了非会员的活跃客）
- 数据自检 SQL 返回 0

**工程量**：S（半天，含数据修复 + 验证）

**风险**：
- 修复后 admin 列表筛选「保有会员-稳定」的非会员客行会消失 — 是预期的修正，不是回归
- mgmt-dashboard 保有会员数显著下降 — 需要预先告知业务方"修正高估"

### 3.2 T2 — B-1 会员数历史化

**目标**：`memberCount` 反映「`$date` 那天已经是会员客的人数」。

**关键 SQL**：
```sql
-- 旧
SELECT COUNT(*) FROM client_wechat_users c WHERE c.customer_type='会员客' AND <scope>
-- 新
SELECT COUNT(*) FROM client_wechat_users c
WHERE c.became_member_at::date <= $date
  AND <scope>
```

**前置确认**：
- `becameMemberAt` 必须在所有 `customer_type → '会员客'` 跃迁路径都正确写入。grep 当前写入路径，必要时补回填脚本（已升级为会员客但 `becameMemberAt IS NULL` 的历史行）。

**改动文件**：
- `mgmt-dashboard.js` `queryMemberCount`
- 可能：cronTask 升级路径补 `becameMemberAt = NOW()`（如尚未写入）
- `metrics.md` 会员数行改公式
- 单测：`mgmt-dashboard.test.js` 加入 historical date 用例

**工程量**：S（半天）

### 3.3 T3 — B-2 员工数历史化

**目标**：`employeeCount` 反映「`$date` 那天在职的员工人数」。

**Schema 改动**：
```ts
// db/schema/user.ts staffWechatUsers
hiredAt: date('hired_at'),                    // 入职日期
resignedAt: date('resigned_at'),              // 离职日期；NULL 表示在职
```

**关键 SQL**：
```sql
SELECT COUNT(*) FROM staff_wechat_users s
WHERE s.skills && ARRAY['美容师','养生师']::text[]
  AND s.hired_at <= $date
  AND (s.resigned_at IS NULL OR s.resigned_at > $date)
  AND <scope>
```

**回填策略**：
- `hired_at`：从 WorkFine 同步源（如有"入职日期"字段）回填；无源时按 `created_at::date` 兜底
- `resigned_at`：当前 `is_resigned=true` 的行回填 `updated_at::date` 兜底

**改动文件**：
- `db/schema/user.ts` + `db/migrations/00NN_*.sql`（drizzle-kit 生成 + 末尾追加 UPDATE 回填）
- `db/scripts/sync-workfine.js` 同步映射（如 WorkFine 有源字段）
- `mgmt-dashboard.js` `queryEmployeeCount`
- admin 员工管理页面（员工编辑表单加 `hired_at` / `resigned_at` 字段，配合"标记离职"操作写入 `resigned_at`）
- `metrics.md` 员工数行改公式
- 单测

**工程量**：M（1-2 天）

**保留 `is_resigned` 列**：作为冗余 / 索引友好的当前状态字段（`is_resigned = (resigned_at IS NOT NULL AND resigned_at <= NOW())`）。生成列或 trigger 维护。

### 3.4 T4 — B-3 门店数历史化

**目标**：`storeCount` 反映「`$date` 那天在营的门店数」。

**Schema 改动**：
```ts
// db/schema/org.ts stores
closedAt: date('closed_at'),  // 闭店日期；NULL 表示在营
```

**关键 SQL**：
```sql
SELECT COUNT(*) FROM stores s
JOIN org_nodes o ON s.org_node_id = o.id
WHERE o.type = '门店'
  AND s.opening_date <= $date
  AND (s.closed_at IS NULL OR s.closed_at > $date)
  AND <scope>
```

**回填策略**：
- `closed_at`：当前 `is_closed=true` 的行回填 `updated_at::date` 兜底
- `opening_date`：已存在，仅需校验为 NOT NULL（缺失行回填 `created_at::date`）

**改动文件**：
- `db/schema/org.ts` + migration（生成 + 末尾追加回填）
- `mgmt-dashboard.js` `queryStoreCount`
- admin 门店管理页面（关店操作时写入 `closed_at = today`）
- `metrics.md` 门店数行改公式
- 单测

**工程量**：M（1 天）

### 3.5 T5 — B-4 保有会员历史化（方案 B 实时计算）

**目标**：`retainedMemberCount` 反映「`$date` 那天处于保有会员状态的会员客人数」。

**口径定义**：「**$date 那天已是会员客** ∩ **$date 前 90 天到店至少 1 次**」。

**关键 SQL**：

```sql
SELECT COUNT(DISTINCT so.client_user_id) AS v
FROM service_orders so
JOIN client_wechat_users c ON c.user_id = so.client_user_id
WHERE so.status = '已完成'
  AND so.client_user_id IS NOT NULL
  AND so.service_date BETWEEN ($date::date - INTERVAL '90 days') AND $date::date
  AND c.became_member_at IS NOT NULL
  AND c.became_member_at::date <= $date::date          -- "$date 那天已经是会员"
  AND <scope on c.bound_store_id>
```

> **为什么不需要快照表（原方案 A 已作废）**：customer_status 完全是 service_orders 的派生函数（输入只有 status='已完成' / service_date / client_user_id），可以任意 $date 实时算出，无需中间存储。
>
> **为什么不依赖 customer_status 列**：customer_status 列是「当前快照」（cronTask 每日重算），不能反映历史日期；T0 修复后 customer_status 只对会员客有值，但仍是当前态。

**与 T0 / T2 的协同**：
- 依赖 `became_member_at` 字段（schema/user.ts:53 已存在；T2 已规划同口径）
- T0 修复后 customer_type='会员客' ⟺ became_member_at IS NOT NULL（单调写入），但此 SQL 仍显式写 `became_member_at <= $date` 以支持历史日期判定

**业务规则简化**：
- 当前 update-customer-status.js 把保有会员细分为「稳定」(visits_90d≥1 ∧ total_visits≥6) 与「有效」(visits_90d≥1 ∧ total_visits≤5)
- 合并态「保有会员」= `visits_90d ≥ 1`（即 90 天到店至少 1 次）
- mgmt-dashboard 当前只看合并态，本 SQL 不区分细分子类

**性能预估**：
- 数据量：30 店 × 800 单/月 × 60 月 ≈ 144 万行 service_orders（status='已完成' 后约 130 万）
- 90 天窗口扫描估 7.2 万行 → GROUP BY 约 5000 个独立客户 → JOIN client_wechat_users
- P95 估 200-400ms，落在 mgmt-dashboard.summary 的 800ms slow warn 阈值内

**可选索引优化**（如 EXPLAIN ANALYZE 慢）：
```sql
CREATE INDEX CONCURRENTLY idx_svc_orders_completed_date_client
ON service_orders (service_date, client_user_id)
WHERE status = '已完成' AND client_user_id IS NOT NULL;
-- size 估 130 万 × 24 字节 ≈ 30 MB
```

**改动文件**：
- `mgmt-dashboard.js` 替换 `queryRetainedMemberCount` 为方案 B SQL
- `metrics.md` 保有会员行改公式（service_orders 派生 + became_member_at 判定）
- 单测：扩展 mgmt-dashboard.test.js，覆盖历史日期 + 边界（顾客 became_member_at = $date / $date+1 / $date-89）
- （可选）EXPLAIN ANALYZE 后追加部分索引

**工程量**：S（半天）

**作废说明**：原方案 A（建 `customer_status_history` 快照表 + cron 写历史 + 历史回填 730 万行）已作废。
方案 B 工程量从 L 降到 S，存储成本归零，业务规则避免漂移，是严格更优解。

### 3.6 T6 — C 类派生指标分母切换

**目标**：把所有派生指标的分母（`storeCount` / `employeeCount`）从"当前快照"切换为"`$date` 历史口径"。

**前置**：T2 / T3 / T4 / T5 全部完成（保有会员的 retainRate 派生依赖 T5）。

**改动**：
- `mgmt-dashboard.js` `summary()` 计算 `monthlyAvgPerStore` 时分母用 T4 历史化的 storeCount（按 selectedDate 月末或月初取一个语义点，建议月末 `last_day_of_month($date)`，因为月度业绩是整月维度，对应整月在营门店）
- `mgmt-dashboard.ts` `buildDisplay` 派生计算保持不变（接口已经返回正确的 storeCount/employeeCount）
- 实际上**绝大部分派生计算无需修改**（前端只是 `s.metric / s.employeeCount`），只要后端返回的 `storeCount` / `employeeCount` 已经是历史口径，前端自动正确

**单一注意点**：「日维度」派生（如人均业绩 当日）用 selectedDate 当日的 employeeCount；「月维度」派生（如人均业绩 当月）用 selectedDate 月末的 employeeCount（接口需 `today` / `month` 两个分母）。这是接口扩展点：

```ts
// 接口字段扩展
employeeCount: { day: number, month: number }
storeCount:    { day: number, month: number }
```

**改动文件**：
- `mgmt-dashboard.js` `summary()` 增加月末分母查询
- `mgmt-dashboard.ts` `SummaryData` 类型 + `buildDisplay` 修正 perEmpAmount/perEmpCount 选用 day vs month 分母
- `metrics.md` 派生指标章节明确两套分母语义
- 单测：扩展 SQL 形态断言 + buildDisplay 单测
- **同 PR 移除阶段 1 过渡角标**（`.dash-section-note--transitional` 元素）

**工程量**：M（1 天，主要在前端 buildDisplay 调整 + 单测扩展）

---

## 4 测试与验收（阶段 1）

见 §2.4。阶段 2 各子 ticket 各自定义验收。

---

## 5 不在本 ticket 范围

- 项目数指标（已有 ticket）
- 阶段 2 子 ticket 的详细实现（T2-T6 各自展开为完整 ticket）
- 接口字段重命名 `today` → `day`（如果阶段 2 T6 不顺便改，单开 ticket）
- mgmt-dashboard 的 ranking / customers 子 tab（其他 ticket）

---

## 6 后续工作清单（要排期的子 ticket）

- [x] T0 — cronTask customer_status 计算口径修复（S，半天，**前置**，独立 PR）— **2026-04-25 完成**
- [ ] T2 — B-1 会员数历史化（S，半天）
- [ ] T3 — B-2 员工数历史化（M，1-2 天）
- [ ] T4 — B-3 门店数历史化（M，1 天）
- [x] T5 — B-4 保有会员历史化（**方案 B 实时计算**，S，半天）— **2026-04-25 完成**
- [ ] T6 — C 派生指标分母切换（M，1 天）+ 移除阶段 1 过渡角标

阶段 2 全部完成后，本 ticket 文末追加 ✅ 收官记录到变更日志。

**总工程量预估**：~5 天（不含 review / 联调 / 业务验收）。原 T5 方案 A 占 2-3 天；改方案 B 后整体压缩 30%。

---

## 附 A：13 项原始指标 + 11 项派生最终态对照表

| # | 指标 | 类别 | 阶段 1 后 | 阶段 2 后（终态） |
|---|------|------|---------|---------|
| 1-2 | 门店业绩 当日/当月 | A | 文案对齐 | 同左 |
| 3 | 门店业绩 月店均 | C | 角标说明 | 分母历史化（T6） |
| 4-6 | 生美业绩 同 1-3 | A/C | 同上 | 同上 |
| 7-9 | 门店实耗 同 1-3 | A/C | 同上 | 同上 |
| 10-12 | 生美实耗 同 1-3 | A/C | 同上 | 同上 |
| 13-14 | 客流 当日/当月 | A | 文案对齐 | 同左 |
| 15-16 | 客量 当日/当月 | A | 同上 | 同上 |
| 17-18 | 新会员 当日/当月 | A | 同上 | 同上 |
| 19-20 | 项目数 当日/当月 | D | 占位 | 项目数 ticket |
| 21 | 会员数 | B | 角标 | 历史化（T2） |
| 22 | 保有会员 | B | 角标 | 历史化（T5） |
| 23 | 占比（retainRate） | C | 角标 | 分子分母都历史化（依赖 T2+T5） |
| 24 | 门店数 | B | 角标 | 历史化（T4） |
| 25-26 | 店均会员 / 店均保有 | C | 角标 | 分母历史化（T2+T4，T2+T5） |
| 27 | 员工数 | B | 角标 | 历史化（T3） |
| 28-29 | 人均会员数 ×2 | C | 角标 | 分子分母都历史化（T2+T3） |
| 30-37 | 人均业绩/实耗/客流/客量/新客 日/月 ×8 | C | 角标 | 分母历史化（T6 用月末/当日的 employeeCount） |
| 38-39 | 人均项目数 日/月 | D | 占位 | 项目数 ticket + T6 |
