# Ticket: 管理层顾客档案子页（mgmt-dashboard 入口"顾客档案"）

> 生成日期：2026-04-25
> **实施状态：📝 待开发**
> 端：fengyu-staff（小程序前端 + staffApi 云函数）
> 目标位置：
>   - 前端：`fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/` + `packageMgmt/mgmt-customer-detail/` 各 4 文件
>   - 入口跳转：`pages/mgmt-dashboard/mgmt-dashboard.ts:onEntryTap` `entry === 'customers'` 分支
>   - 云函数路由：`staffApi/routes/mgmt-customer.js`（新增）
>   - 路由表注册：`staffApi/index.js`
>   - 单元测试：`staffApi/__tests__/routes/mgmt-customer.test.js`
> 关联：
>   - [`mgmt-product-cycle-page`](./2026-04-25-mgmt-product-cycle-page.md) — 同期管理层 hub 子页（scope 三档 + 越权校验风格参考）
>   - [`mgmt-traffic-stats-page`](./2026-04-25-mgmt-traffic-stats-page.md) — 路由参数风格参考（scopeType/scopeId/scopeName）
>   - 门店视图复用：`pages/customer-list/`、`packageCustomer/customer-detail/`（仅作 UI 与字段口径参考，不复用代码）
>
> **一句话目标**：mgmt-dashboard 首页"顾客档案"入口落地，按 hub scope（全部 / 市场 / 门店）过滤，
> 提供姓名/手机号搜索 + 顾客列表 + 6-Tab 详情查看，**纯只读，无操作按钮**。

---

## 0 背景

入口位置：管理视图首页（`pages/mgmt-dashboard/mgmt-dashboard.wxml:162-189` `dash-entries` 区，
位于"人效数据"之下、页面最下方）的 4 列 van-grid 第 4 个入口卡片"顾客档案"
（`<view class="dash-entry-card" data-entry="customers" bindtap="onEntryTap">`）。

`pages/mgmt-dashboard/mgmt-dashboard.ts:onEntryTap` 中 4 个入口：
- `traffic`（客量数据）✅ 已实施 — 跳 `packageMgmt/mgmt-traffic-stats/`
- `sales`（销售数据）⏳ 待开发，toast"开发中"
- `products`（品项数据）✅ 已实施 — 跳 `packageMgmt/mgmt-product-cycle/`
- `customers`（顾客档案）⏳ 待开发，toast"开发中" — **本 ticket**

业务诉求：管理层（总部 / 市场）需要在 hub 选定 scope 后，进入"顾客档案"子页查看 scope 范围内的顾客
档案 + 消费历史，**只查不改**（区别于门店视图店长可分配 / 编辑备注 / 拉储值卡余额 / 勾卡开服务单）。

参考门店视图：
- `pages/customer-list/customer-list.{ts,wxml}` — 顶部 6 分类统计卡片 + 全部 / 会员 / 流量 type tab + 搜索框 + 列表
- `packageCustomer/customer-detail/customer-detail.{ts,wxml}` — 6-Tab：详情 / 日历 / 购买 / 持卡 / 赠送 / 退换

---

## 1 视图设计

### 1.1 列表页（mgmt-customer-list）

```
┌──────────────────────────────────────────────┐
│ scope: 总部 · 全部市场                        │  ← 只读提示条，禁用 mgmt-scope-picker
├──────────────────────────────────────────────┤
│ ┌────────┬────────┬────────┐                │
│ │ 活跃   │ 即将流失│ 流失   │  6 分类统计卡片 │
│ │ 1,234  │  234   │  567   │  scope 内汇总   │
│ ├────────┼────────┼────────┤                │
│ │ 沉睡   │ 本月生日│ 下月生日│                │
│ │  890   │   45   │   38   │                │
│ └────────┴────────┴────────┘                │
├──────────────────────────────────────────────┤
│ [全部 (12345)] [会员客 (5678)] [流量客 (6667)] │
├──────────────────────────────────────────────┤
│ 🔍 搜索姓名或手机号                          │
├──────────────────────────────────────────────┤
│ ┌─────┐ 张三  [星钻] [铁粉]                  │
│ │ 张  │ 13800138000                         │
│ └─────┘ 龙岗店 · 最近购买：纤体卡            │
│         最近到店：2026-04-20                  │
├──────────────────────────────────────────────┤
│ ... 列表项点击 → 详情页                       │
└──────────────────────────────────────────────┘
```

- **scope 提示条**：顶部一行只读条 `{scopeName}`，与 mgmt-product-cycle 一致——子页**不展示** mgmt-scope-picker，scope 在 hub 修改。
- **统计卡片**：6 个，与门店视图一致；点击高亮筛选 list（同 store 视图行为）。
- **type tab**：全部 / 会员客 / 流量客；切换重拉 list。
- **搜索**：姓名 + 手机号 LIKE 检索；scope 内仅。
- **列表卡片**：完全复用门店视图的 `.customer-card` 结构，但**不响应长按**（无客户分配）。

### 1.2 详情页（mgmt-customer-detail）

6 个 Tab，与门店视图同：

| Tab | 内容 | 与门店视图差异 |
|-----|------|------|
| 0 详情 | 姓名 / 手机 / 性别 / 等级 / 绑定门店 / 累计消费 / 年消费 / 上次到店 / 到店频率 / 常购商品 / 备注 | **备注只读**（无保存按钮）；**无储值卡余额展示** |
| 1 日历 | 月度消费日历 + 单日订单 | 数据按 scope 过滤（跨店合并） |
| 2 购买 | 已支付订单 + 明细 | 数据按 scope 过滤；**点击订单跳转 → 仍跳 order-detail（只读浏览）** |
| 3 持卡 | 顾客名下未用完的疗程 / 单次卡 | scope 内的卡；**移除"勾选 + 创建服务单"** UI |
| 4 赠送 | 赠送活动单 + 赠品列表 | 按 scope 过滤 |
| 5 退换 | 退换货历史 | 按 scope 过滤 |

> **仅查看，无操作按钮**：移除门店视图的 `分配（长按）` / `保存备注` / `创建服务单（持卡 Tab）` / `储值卡余额` 等所有改动型 UI。
> 订单详情跳转保留（只读浏览，order-detail 本身已有店长 / 非店长权限分支，管理层视为非店长）。

### 1.3 加载 / 空态

- 切换分类 / type tab → loading；列表清空再拉，避免错位。
- 接口失败 → toast；保留旧 display 防闪屏（同 mgmt-product-cycle 模式）。
- 越权（market 账号传 all）→ 后端 PERMISSION_DENIED，前端提示后 navigateBack。

---

## 2 路由参数与 scope 继承

### 2.1 入口跳转（mgmt-dashboard.ts）

```ts
// 修改 pages/mgmt-dashboard/mgmt-dashboard.ts onEntryTap 中的 customers 分支
if (entry === 'customers') {
  const { scope } = this.data
  const params = [
    `scopeType=${scope.scopeType}`,
    scope.scopeId ? `scopeId=${encodeURIComponent(scope.scopeId)}` : '',
    `scopeName=${encodeURIComponent(scope.scopeName || '')}`,
  ].filter(Boolean).join('&')
  wx.navigateTo({ url: `/packageMgmt/mgmt-customer-list/mgmt-customer-list?${params}` })
  return
}
```

### 2.2 列表页 → 详情页

列表项点击带 scope 透传：
```ts
wx.navigateTo({
  url: `/packageMgmt/mgmt-customer-detail/mgmt-customer-detail?clientUserId=${item.clientUserId}` +
       `&scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId || '')}` +
       `&scopeName=${encodeURIComponent(scopeName || '')}`,
})
```

详情页 onLoad 解析 scope 后，所有子接口（calendar / paidOrders / giftHistory / refundHistory）调用都带 scope 三参数。

---

## 3 后端：新增 `staffApi/routes/mgmt-customer.js`

### 3.1 设计原则

参考 `mgmt-product.js`：
- 用 `requireManagementLevel()` 守卫（强制 staffLevel ∈ {headquarters, market} 且 loginLevel='management'）
- `validateScope(auth, scopeType, scopeId)` 越权防护（market 不允许 'all'，必须命中 roleBindings）
- 复用 `buildSaleScope` / `buildClientScope` helper（mgmt-product.js 已有副本）—— **本 ticket 沿用本地副本风格**，不抽公共模块（避免跨 module 耦合）

### 3.2 接口清单

| Action | 用途 | scope 过滤维度 |
|--------|------|---------------|
| `mgmtCustomer.stats` | 6 分类卡片汇总 | `client_wechat_users.bound_store_id` ∈ scope |
| `mgmtCustomer.search` | 默认列表 + 关键字 / 手机号搜索 | `client_wechat_users.bound_store_id` ∈ scope |
| `mgmtCustomer.listByTag` | 分类筛选列表（active / atRisk / lost / sleeping / birthday / birthdayNext） | `client_wechat_users.bound_store_id` ∈ scope；service_date 也限定 scope |
| `mgmtCustomer.detail` | 顾客档案详情（含累计 / 年消费 / 上次到店 / 频率 / 常购品） | 顾客必须 `bound_store_id` ∈ scope（越权防护）；消费 / 服务历史按 scope 过滤 |
| `mgmtCustomer.calendar` | 月度消费日历 | `sale_orders.store_id` ∈ scope |
| `mgmtCustomer.paidOrders` | 已支付订单（含明细，含未用完疗程卡） | `sale_orders.store_id` ∈ scope |
| `mgmtCustomer.giftHistory` | 赠送记录 | `sale_orders.store_id` ∈ scope |
| `mgmtCustomer.refundHistory` | 退换记录 | `sale_orders.store_id` ∈ scope |

> 不实现：`assign` / `updateNotes` / `customerBalance` —— 管理层只读视图。

### 3.3 关键 SQL 改造点（vs 门店视图 `customer.js`）

**门店视图**所有 SQL 都用 `ctx.auth.effectiveStoreId` 作为单门店过滤；**管理层视图**改为 scope 过滤片段。

例：`mgmtCustomer.search` 默认列表（无关键字）：

```sql
-- 原 customer.search
WHERE c.bound_store_id = $1${typeFilter}
LIMIT $2

-- 新 mgmtCustomer.search（scope=all）
WHERE TRUE${typeFilter}
LIMIT $1

-- 新 mgmtCustomer.search（scope=market）
WHERE c.bound_store_id IN (
  SELECT s.store_id FROM stores s
  JOIN org_nodes o ON s.org_node_id = o.id
  WHERE o.parent_id = $1 AND o.type = '门店'
)${typeFilter}
LIMIT $2

-- 新 mgmtCustomer.search（scope=store）
WHERE c.bound_store_id = $1${typeFilter}
LIMIT $2
```

`buildClientScope(scopeType, scopeId, 'c', startIdx)` 直接复用 `mgmt-product.js:76-89`。

例：`mgmtCustomer.paidOrders`（按 sale_orders.store_id scope 过滤，**跨 scope 合并**）：

```sql
-- 原 customer.paidOrders
WHERE o.status = '已支付' AND o.client_user_id = $1 AND o.store_id = $2

-- 新 mgmtCustomer.paidOrders（scope=market）
WHERE o.status = '已支付' AND o.client_user_id = $1
  AND o.store_id IN (SELECT s.store_id FROM stores s
                     JOIN org_nodes o2 ON s.org_node_id = o2.id
                     WHERE o2.parent_id = $2 AND o2.type = '门店')
```

> **语义说明**：scope=门店时，paidOrders 仅显示该门店的订单（与门店视图一致）；scope=市场时，
> 显示该市场所有门店的订单合并；scope=全部时（仅总部）显示全部订单。这与持卡 / 赠送 / 退换的语义统一。

### 3.4 越权防护：detail 接口

```js
async function detail(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { clientUserId, scopeType, scopeId } = ctx.event.payload || {}
  validateScope(ctx.auth, scopeType, scopeId)

  // 1. 拉顾客档案
  const rows = await pg.query(`SELECT ... FROM client_wechat_users c ... WHERE c.user_id = $1`, [clientUserId])
  if (rows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const pgUser = rows[0]

  // 2. 越权防护：顾客 bound_store_id 必须在 scope 内
  // scope=all → 总部已校验，跳过
  // scope=market → bound_store_id 必须在该市场下属门店
  // scope=store → bound_store_id 必须 = scopeId
  await assertCustomerInScope(pgUser.bound_store_id, scopeType, scopeId)

  // 3. 计算消费 / 频率 / 常购（按 scope 过滤）
  const { totalConsumption, yearConsumption } = await getConsumptionStatsScoped(clientUserId, scopeType, scopeId)
  const visitInfo = await getVisitInfoScoped(clientUserId, scopeType, scopeId)
  const topProduct = await getTopProductScoped(clientUserId, scopeType, scopeId)
  ...
}
```

`assertCustomerInScope` 失败 → 抛 `PERMISSION_DENIED: 顾客不在当前 scope 范围内`。

### 3.5 手机号脱敏决策

`customer.js` 用 `isManagerRole = ctx.auth.roles.includes('manager')` 判断是否脱敏。
管理层 staffLevel ∈ {headquarters, market} 通常**不**带 `manager` role（manager 是门店店长 role），按现规则会被脱敏。

**本 ticket 决策（D-mgmt-phone-mask）**：管理层 staffLevel ∈ {headquarters, market} **手机号不脱敏**。
理由：管理层有客户档案查阅权限，是合理的 KYC 场景，与店长视角同等级。
实现：`const isMgmtFullPhone = ctx.auth.staffLevel === 'headquarters' || ctx.auth.staffLevel === 'market'`，
满足时返回原始 phone，否则降级 `maskPhone(phone)`（理论上不会走到，因为 requireManagementLevel 已保证）。

---

## 4 前端：新增两个页面

### 4.1 `packageMgmt/mgmt-customer-list/`

| 文件 | 说明 |
|------|------|
| `mgmt-customer-list.ts` | onLoad 解析 scope；onShow 拉 stats + 默认列表；6 分类点击 / type tab 切换 / 搜索 / 列表项跳详情；**移除**：onLongPressAssign + onAssignClose + onAssignSelect + showAssignSheet + isManager（无须显隐操作） |
| `mgmt-customer-list.wxml` | 复用门店视图 wxml 结构；移除 `bindlongpress` + `<van-action-sheet>`；增加顶部 `scope-readonly-bar` |
| `mgmt-customer-list.wxss` | 复用门店视图样式 + scope 提示条样式 |
| `mgmt-customer-list.json` | 注册 `van-search` / `van-empty` / `van-loading`（与门店视图相同） |

### 4.2 `packageMgmt/mgmt-customer-detail/`

| 文件 | 说明 |
|------|------|
| `mgmt-customer-detail.ts` | 6 Tab 数据加载逻辑；onLoad 接收 clientUserId + scope；所有 callStaffApi 改为 `mgmtCustomer.*` 接口；**移除**：客户分配 / 保存备注 / 储值卡余额 / 持卡勾选 / 创建服务单 |
| `mgmt-customer-detail.wxml` | 复用门店视图 wxml；备注 `<textarea disabled>`；持卡 Tab 移除 checkbox + stepper + "创建服务单"按钮，改纯展示；移除储值卡余额行 |
| `mgmt-customer-detail.wxss` | 复用门店视图样式 |
| `mgmt-customer-detail.json` | 注册 `van-tab` / `van-tabs` / `van-cell` / `van-empty` / `van-loading`（与门店视图相同） |

### 4.3 分包注册（app.json）

`app.json` `subPackages` 中 `packageMgmt.pages` 已有 `mgmt-traffic-stats` + `mgmt-product-cycle`，
追加 `mgmt-customer-list` + `mgmt-customer-detail`。

---

## 5 决策点

| 编号 | 议题 | 推荐结论 | 理由 |
|------|------|---------|------|
| **D-route-isolation** | 复用 `customer.*` vs 新建 `mgmt-customer.*` | **新建 `mgmt-customer.*`** | 与 mgmt-product / mgmt-traffic 模式一致；scope 守卫 + manager 守卫互斥，硬塞同一接口分支会增加测试复杂度 |
| **D-mgmt-phone-mask** | 管理层手机号是否脱敏 | **不脱敏** | 管理层 KYC 场景正当；与店长（manager role）同等级 |
| **D-customer-scope-source** | 顾客主键过滤用 `bound_store_id` 还是 `sale_orders.store_id 历史出现过` | **`bound_store_id`** | 顾客绑定门店是确定性主键；按业务历史出现过会引入"曾跨市场购买"的灰色顾客，列表口径模糊 |
| **D-detail-record-scope** | 详情页购买 / 服务 / 赠送 / 退换 scope 过滤 | **按 sale_orders.store_id / service_orders.store_id ∈ scope** | 与列表口径一致；scope=市场时跨该市场门店合并；不显示该市场以外的历史（避免越权） |
| **D-cross-scope-customer** | 顾客 bound 在 A 市场，但在 B 市场也有消费 → B 市场账号能查吗？ | **不能查（403）** | 详情接口越权防护以 `bound_store_id ∈ scope` 为准；与列表搜索口径一致 |
| **D-action-buttons** | 是否保留某些"操作"（如订单详情跳转） | **移除写操作 / 保留只读跳转**：移除 assign / save notes / 储值卡 / 持卡勾选；保留订单详情跳转（order-detail 本身已有读权限分支） | 题面要求"只查看"；订单详情属只读浏览，无写副作用 |
| **D-package-path** | 新页面分包 | **`packageMgmt/`**（与 mgmt-traffic-stats / mgmt-product-cycle 同分包） | 已存在分包，避免新增分包导致小程序代码包数变化 |
| **D-listByTag-pageSize** | listByTag 分页大小 | **20**（与门店视图一致） | 一致体验；管理层视图数据量更大但分页相同，避免一次过载 |

---

## 6 测试计划

### 6.1 后端单元测试 — `staffApi/__tests__/routes/mgmt-customer.test.js`

参考 `mgmt-product.test.js`（38 cases），目标 ≥ 30 cases：

| 描述块 | 大致 cases | 覆盖点 |
|--------|------|------|
| `参数与权限校验` | 6 | INVALID_PARAMS（缺 scope）+ PERMISSION_DENIED（market 传 all / market 越权 / store 越权 / 非管理层访问）|
| `stats SQL 形态` | 4 | scope=all / market / store + bound_store_id IN scope 子查询 |
| `search SQL 形态` | 5 | 默认列表 / 关键字 / 手机号 + scope 三档 |
| `listByTag SQL 形态` | 4 | tag × scope；service_date 过滤 |
| `detail 越权防护` | 3 | bound_store_id 不在 scope → 403 |
| `detail 出数` | 3 | 累计 / 年消费 / 频率 / 常购按 scope 过滤 |
| `calendar / paidOrders / giftHistory / refundHistory SQL 形态` | 4 | 各接口 sale_orders.store_id IN scope 子查询 |
| `手机号脱敏策略` | 2 | staffLevel=headquarters → 原值；staffLevel=market → 原值 |

> Mock pg.query 按 SQL 关键字匹配返回不同 stub；与 mgmt-product.test.js 同思路。

### 6.2 前端 — 待人工验收

- 微信开发者工具登录 HQ → mgmt-dashboard → 顾客档案卡片 → 列表正确渲染（统计 + type tab + 搜索 + 列表）。
- HQ → 切换 scope=某市场 → 进入子页 → 数据按市场过滤；统计卡片数 ≤ HQ 视角。
- 市场账号 → 默认市场作 scope → 进入子页正常；尝试改 URL 加 scopeType=all → 返回 403。
- 列表项点击 → 详情页 6 Tab 正常加载，数据按 scope 过滤。
- 详情页**无**：分配（长按无反应）/ 备注保存按钮 / 储值卡余额 / 持卡勾选 + 创建服务单按钮。
- 详情页**有**：订单详情跳转（只读浏览）。
- 接口失败 → toast；保留旧 display 防闪屏。
- 数字格式：金额 2 位小数 + 千分位；人数整数 + 千分位。

### 6.3 数据自检 SQL（可运行版）

```sql
-- 自检 1：管理层接口 stats 与门店视图 stats（scope=该门店）必须返回一致
-- 取任一活跃门店：
WITH s AS (SELECT 'STORE_ID_X' AS sid)
SELECT
  (SELECT COUNT(*) FROM client_wechat_users WHERE bound_store_id = (SELECT sid FROM s)) AS total_pg,
  -- 与 mgmtCustomer.stats(scope=store, scopeId='STORE_ID_X').total 对比，应一致
  (SELECT COUNT(*) FROM client_wechat_users WHERE bound_store_id = (SELECT sid FROM s) AND customer_id IS NOT NULL) AS member_pg;
-- → 调用 mgmtCustomer.stats 应返回 total_pg / member_pg 完全一致

-- 自检 2：scope=market 的顾客数 = 该市场所有门店顾客数之和
WITH market_id AS (SELECT 'MKT_ID_X' AS mid)
SELECT COUNT(*) FROM client_wechat_users c
WHERE c.bound_store_id IN (
  SELECT s.store_id FROM stores s
  JOIN org_nodes o ON s.org_node_id = o.id
  WHERE o.parent_id = (SELECT mid FROM market_id) AND o.type = '门店'
);
-- → 与 mgmtCustomer.stats(scope=market, scopeId=...).total 比对
```

---

## 7 已知偏差与待跟进

### 7.1 跨 scope 顾客的展示语义

某顾客 bound 在 A 市场，但在 B 市场也有消费（跨地理流动）。

- B 市场账号查不到该顾客（搜索 / 列表均返回空）— 与 D-cross-scope-customer 决策一致。
- HQ 账号能查到，详情页显示全部跨市场消费（scope=all）。

后续若业务要求"按 sale_orders 历史出现过"维度（即"消费足迹"）开放跨市场查询，需新增 `mgmtCustomer.searchByFootprint` 接口；不在本 ticket 范围。

### 7.2 性能下界缺失

`paidOrders` / `calendar` 在 scope=market 时会扫描该市场全部门店的 sale_orders；
当前数据量级（几万行）跑得动，未来 50 万行+ 时建议加复合索引 `idx_so_client_paid_store(client_user_id, paid_at, store_id, status)`。

### 7.3 6 分类口径与门店视图一致性

复用门店视图 `stats` 函数的活跃度阈值（30 / 60 / 90 天）+ 生日月份判定逻辑，
**SQL 层** scope 替换 `bound_store_id = $1` 为 `buildClientScope(...)`，`service_orders.store_id = $1` 为 `buildSaleScope(...)`。
两个函数的本地副本（mgmt-customer.js）与 mgmt-product.js 保持完全一致；如未来抽公共模块，统一替换。

---

## 8 不在本 ticket 范围

- `mgmtCustomer.searchByFootprint`（按消费足迹跨 scope 搜索）
- 销售数据 / 顾客档案以外其他 mgmt-dashboard 入口（独立 ticket）
- 顾客分配 / 备注编辑等写操作开放给管理层（业务暂未提需求）
- 储值卡余额跨 scope 展示（业务规则：余额跨店统一，但管理层视图暂不展示）
- 详情页持卡 Tab"创建服务单"功能（管理层不开服务单）

---

## 9 交付物清单

- [ ] `packageMgmt/mgmt-customer-list/{ts,wxml,wxss,json}` 4 文件
- [ ] `packageMgmt/mgmt-customer-detail/{ts,wxml,wxss,json}` 4 文件
- [ ] `app.json` `packageMgmt.pages` 追加 `mgmt-customer-list` + `mgmt-customer-detail`
- [ ] `pages/mgmt-dashboard/mgmt-dashboard.ts` `onEntryTap` `customers` 分支跳转
- [ ] `cloudfunctions/staffApi/routes/mgmt-customer.js`（stats / search / listByTag / detail / calendar / paidOrders / giftHistory / refundHistory）
- [ ] `cloudfunctions/staffApi/index.js` 路由表 `mgmtCustomer.*`
- [ ] `cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js`（≥ 30 cases）
- [ ] 微信开发者工具端到端验收（6.2 全部勾选）
- [ ] dev 库自检 SQL 跑通（6.3）

---

## 10 实施顺序建议

1. **第 1 步**：先落 `mgmt-customer.js` 后端 + 测试（stats / search 两接口先行）→ bun test 全过。
2. **第 2 步**：补 detail / calendar / paidOrders / giftHistory / refundHistory / listByTag → 测试覆盖。
3. **第 3 步**：前端 mgmt-customer-list 列表页，调通 stats + search + listByTag。
4. **第 4 步**：前端 mgmt-customer-detail 详情页，调通 6 Tab。
5. **第 5 步**：mgmt-dashboard.ts 入口跳转打通 + app.json 分包注册。
6. **第 6 步**：端到端验收（HQ + 市场两账号各跑一遍）+ 数据自检 SQL。

> 依赖前置：mgmt-product 已落地 `validateScope` + `buildSaleScope` + `buildClientScope`，
> 本 ticket 直接照搬本地副本（不抽公共模块），降低跨 ticket 风险。
