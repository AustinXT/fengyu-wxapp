# Ticket: 管理层客量数据子页（mgmt-dashboard 入口"客量数据"）

> 生成日期：2026-04-25
> 严重级别：P1（mgmt-dashboard 首页"客量数据"入口当前 onEntryTap 仅 toast"开发中"）
> 端：fengyu-staff（小程序前端 + staffApi 云函数）
> 影响面：
>   - 新增页面：`fengyu-staff/miniprogram/pages/mgmt-traffic-stats/`（路径与最终命名待定，本文用 `mgmt-traffic-stats`）
>   - 改造：`pages/mgmt-dashboard/mgmt-dashboard.ts` `onEntryTap` 入口跳转
>   - 新增云函数路由：`staffApi/routes/mgmt-traffic.js`（建议拆出，避免与 `mgmt-dashboard.js` 混用）
>   - metrics.md 已同步追加 5 大类指标定义（详见 [`notes/references/metrics.md` "客量数据子页"章节](../references/metrics.md)）
> 关联：
>   - [`mgmt-dashboard-metrics-date-alignment`](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md) — 历史化改造（T2 会员数 / T5 保有会员）影响本子页
>   - [`mgmt-store-ranking-page`](./2026-04-25-mgmt-store-ranking-page.md) — 同期管理层 hub 子页（参考视图风格）
>
> **一句话目标**：把 mgmt-dashboard 首页"客量数据"入口替换为完整的客量数据子页，
> 包含 5 个 section（注册 / 客流 / 客活 / 经营 / 新会员）+ 时间筛选 chip（本月/上月/本年）
> + scope（全部/市场/门店）继承 hub。

---

## 0 一句话背景

`pages/mgmt-dashboard/mgmt-dashboard.ts:282-292` 当前 `onEntryTap` 4 个入口（traffic / sales / products / customers）
全部 toast"开发中"。本 ticket 仅落 `traffic`（客量数据），其余 3 个独立 ticket。

设计稿见原始需求两张截图（提交日 2026-04-25）；指标公式权威源已写入 metrics.md。

---

## 1 视图设计

### 1.1 顶部筛选

```
┌──────────────────────────────────────────────┐
│ [ 本月 ]  [ 上月 ]  [ 本年 ]    （scope 显示） │
└──────────────────────────────────────────────┘
```

- 3 个 chip（默认 `本月` 高亮），自绘 view，不复用 vant tab（与排行榜子页同风格）。
- scope 显示沿用上层 mgmt-dashboard 选中的 scope，**子页不重复出 scope-picker**（一致性 + 节约屏幕宽度）。
  通过路由参数 `scopeId` / `scopeType` 从 hub 传入。

### 1.2 主体 — 5 个 section

```
─── 注册情况（截至当天） ───
┌──────────┬──────────┬──────────┬──────────┐
│ 总注册数 │仅注册用户│ 体验客   │ 会员客   │
│   500    │   150    │   100    │   250    │
└──────────┴──────────┴──────────┴──────────┘

─── 到店客流数据（区间内） ───
┌──────────┬──────────┬──────────┬──────────┐
│ 总客流量 │体验客流量│ 小美客流量│会员客流量│
│   360    │    60    │    100   │   150    │
│ 对应人数 │ 对应人数 │ 对应人数 │ 对应人数 │
│   130    │    60    │    20    │    50    │
│ 项目数   │ 项目数   │ 项目数   │ 项目数   │
│   260    │    120   │    40    │    100   │
└──────────┴──────────┴──────────┴──────────┘

─── 会员状态与客活 ───
（左列截面 / 右列区间）
┌────────────────────┬───┬──────────────────┬───┐
│ 保有会员-稳定      │50 │ 一次客活         │80 │
│ （3个月≥6）        │   │ 保有会员到店1次  │   │
│ 保有会员-有效      │60 │ 二次客活         │30 │
│ （3个月≤5）        │   │ 保有会员到店≥2次 │   │
│ 沉睡人数           │100│ 本月激活（沉睡） │-- │
│ 冰冻人数           │150│ 本月激活（冰冻） │-- │
│ 休眠人数           │200│ 本月激活（休眠） │-- │
└────────────────────┴───┴──────────────────┴───┘
本月激活区域：角标"等待 T5 历史化能力上线后填值"

─── 会员被经营情况（区间内） ───
（每行：消费档 → 人数 / 消费金额）
┌────────────────┬──┬────────────┬─────────┐
│ 当期消费<1990  │50│ 消费金额   │25000.00 │
│ 当期消费≥1990  │20│ 消费金额   │50000.00 │
│ 当期消费≥1w    │ 5│ 消费金额   │75000.00 │
│ 当期消费≥3w    │ 1│ 消费金额   │35000.00 │
│ 当期消费≥6w    │ 0│ 消费金额   │ 0.00    │
│ 当期消费10w+   │ 0│ 消费金额   │ 0.00    │
└────────────────┴──┴────────────┴─────────┘
会员客单价：2434.21（大字突出）

─── 新会员经营 ───
┌──────────────┬──────┬──────────────────┬──────┐
│ 新增会员数   │  10  │ 新增会员对应消费 │30000 │
│ 新增会员客单价│ 3000 │ 新增会员成交率   │12.50%│
└──────────────┴──────┴──────────────────┴──────┘
```

### 1.3 加载占位 / 空态

- 切换 chip 立即 `loading=true`，重新拉接口；保留旧 `display` 直到新数据到（避免闪屏）
- 接口失败 → 顶部 toast + section 内显示 `--`
- scope=门店 / 市场 / 全部 都用同一接口，分母走 metrics.md scope 规则

---

## 2 时间口径

完全对齐 metrics.md "时间窗口缩写约定"中"period 锚 NOW"语义（与 `mgmtDashboard.storeRanking` 同源）。

| chip | period 入参 | startDate | endDate |
|------|-------------|-----------|---------|
| 本月 | `month` | `date_trunc('month', NOW())::date` | `NOW()::date` |
| 上月 | `lastMonth` | `date_trunc('month', NOW() - INTERVAL '1 month')::date` | `(date_trunc('month', NOW()) - INTERVAL '1 day')::date` |
| 本年 | `year` | `date_trunc('year', NOW())::date` | `NOW()::date` |

后端入参 `period: 'month' | 'lastMonth' | 'year'`，由服务端解析为 `[startDate, endDate]`，
**不传具体日期**（避免前端时区差和闰月日期错位；与 `storeRanking` 接口的 period 命名保持一致）。

---

## 3 代码改动

### 3.1 入口跳转（替换 placeholder）

**`fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.ts`** `onEntryTap`：

```ts
onEntryTap(e: WechatMiniprogram.BaseEvent) {
  const entry = (e.currentTarget.dataset as { entry?: string }).entry
  if (entry === 'traffic') {
    const { selectedScopeId, selectedScopeType } = this.data  // hub 当前 scope
    wx.navigateTo({
      url: `/packageMgmt/mgmt-traffic-stats/mgmt-traffic-stats?scopeId=${selectedScopeId || ''}&scopeType=${selectedScopeType || ''}`,
    })
    return
  }
  // sales / products / customers 仍 toast，分别独立 ticket
  ...
}
```

> 路径决策点：是否新建 `packageMgmt` 分包？参考现有 `packageOrder` 内已含 `dashboard` / `staff-performance`，
> 可考虑放入 `packageOrder` 暂存；建议另起 `packageMgmt` 分包，避免 packageOrder 越发肥大。
> 本期挂在 `packageMgmt`（如不接受，拍板时改路径）。

### 3.2 新页面骨架

**`fengyu-staff/miniprogram/pages/mgmt-traffic-stats/`**（4 文件 ts/wxml/wxss/json）：

- `data` 结构：

```ts
type Period = 'month' | 'lastMonth' | 'year'

interface TrafficData {
  registration: {
    regTotal: number; regOnly: number; regTrial: number; regMember: number
  }
  traffic: Array<{                    // 4 列：total / trial / xiaomei / member
    type: 'total' | 'trial' | 'xiaomei' | 'member'
    label: string                     // '总' / '体验客' / '小美客' / '会员客'
    count: number                     // 客流量（次）
    users: number                     // 对应人数
    sessions: number                  // 项目数（扣卡次数）
  }>
  status: {
    retainedStable: number
    retainedActive: number
    dormantWarn: number               // schema='预警沉睡'
    dormantFrozen: number
    dormantDeep: number
    activeOnce: number
    activeTwice: number
    reactivatedFromWarn: number | null   // 等 T5 历史化前为 null → UI 显示 '--'
    reactivatedFromFrozen: number | null
    reactivatedFromDeep: number | null
  }
  memberOps: {
    buckets: Array<{                  // 6 桶
      tier: '<1990' | '1990-1W' | '1-3W' | '3-6W' | '6-10W' | '10W+'
      count: number
      spend: number
    }>
    avgTicket: number                 // 会员客单价
  }
  newMembers: {
    count: number
    spend: number
    avgTicket: number                 // = spend / count，前端派生
    convRate: number                  // 0-1，前端格式化为百分比
  }
}
```

- `onLoad(query)` 读 `scopeId` / `scopeType` → `setData({ scopeId, scopeType })`
- `onPeriodChange` 切 chip → 重拉接口
- 后台返回直接 `setData({ display: data })`，前端只做格式化（formatAmount / formatCount / formatPercent）

### 3.3 后端云函数

**新文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js`

`index.js` 路由表追加：

```js
mgmtTraffic: {
  summary: require('./routes/mgmt-traffic').summary,   // 一次性返回全部 5 个 section
}
```

`summary(payload, ctx)`：
- `requireManagementLevel()`（与 mgmt-dashboard 同守卫）
- 入参：`{ period: 'month' | 'lastMonth' | 'year', scopeId?: string, scopeType?: '市场' | '门店' }`（period 命名与 `mgmtDashboard.storeRanking` 一致）
- 内部解析 `period` → `[startDate, endDate]`（参考 mgmt-dashboard.js 现有的 month/today 解析模式）
- 5 段 SQL 并发执行（`Promise.all`），与 mgmt-dashboard.summary 同节奏
- 返回 `TrafficData` 结构

**关键 SQL 模板**：详见 metrics.md 各章节的 CTE / WHERE 模板，本 ticket 不重复。

> **slow warn 阈值**：本子页 SQL 数量比 hub summary 多（≥ 5 段），但每段都比 hub summary 单段轻；
> 仍按 800ms slow warn 处理（与 hub 一致，便于运维监控对齐）。

### 3.4 测试

**`__tests__/routes/mgmt-traffic.test.js`** 新增：

- 注册情况 4 项 SQL 形态断言（`regTotal` 不带 `customer_type` 过滤；其余 3 项各带）
- 到店客流 4 列 ×（count / users / sessions）= 12 数字的 SQL 形态
- 会员状态 5 项截面 + 2 项区间客活 SQL 形态；3 项激活返回 `null`
- 会员被经营 6 桶聚合 + 客单价分母防除零
- 新会员经营 4 项；成交率分母 `customer_type IN ('体验客','小美客')`
- scope 三档（全部 / 市场 / 门店）的 WHERE 拼接断言

> Mock 模式与 mgmt-dashboard.test.js 同思路（jest.mock pg）。

---

## 4 metrics.md 联动

metrics.md 已在本 ticket 同 PR 完成追加（"客量数据子页"章节，43 项指标 + 区间约定）。
后续若决策点（D-trafficSessionsScope / D-react-source / D-conv-denom）业务方拍板，
**先改 metrics.md 再改代码**（保持 metrics.md 是权威源）。

---

## 5 决策点（业务方需拍板）

| 编号 | 议题 | 默认方案 | 备选 |
|------|------|----------|------|
| **D-trafficSessionsScope** | section 2"项目数（扣卡次数）"是否限定 `sales_category IN ('自销自耗','他销自耗')`（与首页项目数对齐） | 不限定（含全部销售类别）| 限定（与首页一致）|
| **D-react-source** | section 3"本月激活"3 项实现 | 本期占位 `--` + 角标，等 T5 历史化能力（实时反推） | 立即上 `customer_status_history` 审计表 |
| **D-conv-denom** | section 5"新增会员成交率"分母 | B：区间内到店的体验客 + 小美客 | A：仅体验客 / C：所有非会员客 |
| **D-act-status-mapping** | UI"沉睡人数"对应 schema `预警沉睡`（命名差异）| 接受，前端文案层映射 | 改 schema 枚举（破坏性，不建议）|
| **D-package-path** | 新页面落在哪个分包 | `packageMgmt`（新建分包）| `packageOrder` |

---

## 6 测试与验收

### 6.1 后端

- `mgmt-traffic.test.js` 全绿（覆盖 SQL 形态 + scope 拼接 + 防除零）
- 在 dev 环境用 `_testOpenid` 命中总部账号，3 个 period × 3 种 scope = 9 次接口调用，返回结构完整、字段类型正确

### 6.2 前端

- 微信开发者工具登录 HQ → mgmt-dashboard → 客量数据入口 → 子页正确渲染
- 切换 3 个 chip → loading→ 新数据替换；旧数据短暂保留不闪
- scope 切换在 hub 完成后回到子页 → 数据按新 scope 刷新
- 接口失败 → toast + section 内 `--`
- "本月激活"3 项当前显示 `--` + 角标
- 数字格式化：金额保留 2 位 + 千分位；人数整数 + 千分位；占比保留 2 位 + `%`

### 6.3 数据自检

```sql
-- 注册情况自检：4 项之和 + 小美客存量 = 总注册数
SELECT
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type='流量客') +
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type='体验客') +
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type='小美客') +
  (SELECT COUNT(*) FROM client_wechat_users WHERE customer_type='会员客')
  =
  (SELECT COUNT(*) FROM client_wechat_users)
;  -- 应返回 t

-- 会员被经营 6 桶人数 = 区间内有消费的会员客 distinct 数
WITH member_spend AS (...)  -- 同 metrics.md
SELECT COUNT(*) FROM member_spend;  -- 应等于 6 桶人数之和
```

---

## 7 不在本 ticket 范围

- "本月激活"3 项的实际计算（依赖 [`metrics-date-alignment T5`](./2026-04-25-mgmt-dashboard-metrics-date-alignment.md) 落地后单独跟进，本期占位 `--`）
- 注册情况 / 会员被经营情况的"customer_type 历史化"（等 T2 历史化完成后再升级口径）
- 销售数据 / 品项数据 / 顾客档案 3 个 mgmt-dashboard 入口（独立 ticket）
- "新增会员成交率"分母候选 A/C 改造（D-conv-denom 业务方拍板后再改）
- 数字格式化的 `formatPercent` 工具函数（如 `utils/number.ts` 没有，本 ticket 内补一个）

---

## 8 工程量预估

- 前端页面 + 入口跳转：M（1 天，含样式 + 与 hub 联动）
- 后端 5 段 SQL + 路由：M（1 天，含单测）
- 联调 + 业务方决策点澄清：S（半天）
- **合计**：~2.5 天

---

## 9 交付物清单

- [ ] `pages/mgmt-traffic-stats/{ts,wxml,wxss,json}` 4 文件
- [ ] `app.json` 注册新页面（或新建 `packageMgmt` 分包）
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` `onEntryTap` 跳转改造
- [ ] `cloudfunctions/staffApi/routes/mgmt-traffic.js` 新建（5 段 SQL + 解析 period + scope）
- [ ] `cloudfunctions/staffApi/index.js` 路由表追加 `mgmtTraffic.summary`
- [ ] `cloudfunctions/staffApi/__tests__/routes/mgmt-traffic.test.js` 新建
- [ ] `notes/references/metrics.md` 已同步（PR 内同 commit）
- [ ] 微信开发者工具端到端验收 + 数据自检 SQL 通过
