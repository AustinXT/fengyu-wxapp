# Ticket: staff 管理层「顾客档案」页 — 移除统计卡片/类型 Tab 并改为 50/页分页列表

> 生成日期：2026-04-25
> 严重级别：P3（管理层视图体验改造，**无业务逻辑变更**）
> 端：fengyu-staff（员工端小程序 + staffApi 云函数）
> 影响面：
> - 修改：`fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.wxml`
> - 修改：`fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.ts`
> - 修改：`fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.wxss`
> - 修改：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js`（`search` 加分页；删 `stats` / `listByTag`）
> - 修改：`fengyu-staff/cloudfunctions/staffApi/index.js`（删 `mgmtCustomer.stats` / `mgmtCustomer.listByTag` 路由）
> - 修改：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js`（删 `stats` / `listByTag` describe，新增 `search` 分页用例）
> 前置：mgmt-dashboard 跳入路径 (`scopeType` / `scopeId` / `scopeName`) 不变
> 并行：与其他 staff ticket 互不干扰
>
> **一句话目标**：把管理层「顾客档案」页顶部的 6 张统计卡片 + 全部/会员客/流量客 Tab 整段删掉；搜索框留空时直接以「scope 范围内全部顾客」开始下拉分页，**每页 50 人**，触底加载下一页。

---

## 0 一句话背景

`packageMgmt/mgmt-customer-list/` 是管理层「顾客档案」入口（由 `pages/mgmt-dashboard` 通过路由透传 `scopeType` / `scopeId` / `scopeName` 进入）。当前页面结构（自上而下）：

1. **scope 提示条** ─ `数据范围：全部市场`（保留）
2. **6 张统计卡片** ─ 活跃 / 即将流失 / 流失 / 沉睡 / 本月生日 / 下月生日（**本 ticket 删除**）
3. **3 个类型 Tab** ─ 全部(N) / 会员客(N) / 流量客(N)（**本 ticket 删除**）
4. **搜索框** ─ `搜索姓名或手机号`（保留）
5. **顾客列表** ─ 当前默认列表只取 `LIMIT 20`，没有分页；标签筛选另走 `listByTag` 分页 20（**改造**）

**用户原话**：「删除红框的部分，下面的顾客列表在搜索框为空值的情况下需要返回范围内的所有顾客，每页 50 人。」

也就是说：
- 红框 = 卡片 + Tab，整段删
- 搜索框留空 ≠ "无内容"，而是 "全部顾客 + 50/页 触底加载"
- 关键字搜索（人名/手机号）顺带一致化为 50/页分页（不是本次硬性需求，但同代码路径无理由不顺带做）

---

## 1 设计决策

### 1.1 红框两块整段删除（统计卡片 + 类型 Tab）

**决策**：完全删除 `stats-section`（6 张卡片）+ `type-tabs`（3 个 Tab），不留折叠/抽屉/二级入口。

**否决方案**：
- ❌ "卡片折叠到二级页"：用户没要"换位置"，要的是"删掉"
- ❌ "保留卡片但作为筛选入口收纳到搜索框上方更细的小图标"：等同换皮，复杂度上升
- ❌ "保留 Tab（全部/会员客/流量客），仅删 6 卡片"：用户原话明确指向整个红框，且类型 Tab 当前只能作为"筛选切换器"，删掉卡片后单独一个 Tab 行无意义

**边界**：
- 删除 `stats` 字段、`activeTag` / `customerType` / `tagPage` / `tagHasMore` 状态
- 删除 `loadStats()` / `onStatTap()` / `onCustomerTypeTap()` / `loadByTag()` 方法
- 删除 wxml 对应整段，删除 wxss 对应样式块
- `stats` / `listByTag` 后端 action 一并清理（**前端唯一调用方就是本页**，按 [no-legacy-compat](feedback_no_legacy_compat.md) 直接删）

### 1.2 搜索框为空 = 全部顾客分页列表（50/页）

**决策**：进入页面、清空关键字、下拉刷新，三种场景统一进入"默认列表"分支，调用 `mgmtCustomer.search` 的分页模式（无 keyword）。每页 50 人，触底加载下一页。

**为什么是 50**：
- 用户原话明确："每页 50 人"
- 当前 `search` 的 LIMIT 20 是无分页时代的"截断防爆"硬限制，没有分页语义
- 50 一档与"补充查询"（年消费 / 最近服务 / 最近购买商品三个 N+1 子查询）的成本可控（详见 1.7）

**hasMore 判定**：用 `rows.length === pageSize` 推断（当前批返回满则可能还有下一页），**不返回 total**，避免额外 COUNT(*) 查询。

**否决方案**：
- ❌ 一次性返回所有顾客（不分页）：scope=all 时可能上万行，云函数 / 网络 / 渲染都会爆
- ❌ 服务端返回 `{ customers, total }`：total 需要单独 COUNT(*) 一次（带 scope 过滤），与"hasMore"信息冗余
- ❌ pageSize 走前端可配置：用户已明确 50，无需配置入口

### 1.3 关键字搜索（人名/手机号）也走分页

**决策**：`search` 接口的关键字分支同步支持 `page` / `pageSize`，参数和默认列表分支一致。

理由：
- 同一 action、同一返回结构，前端走同一段渲染逻辑
- 关键字命中数也可能是几十到上百（"张"姓 + 全市场），不分页同样存在性能风险
- 若未来想"关键字 + 分页"作为深查，无需再开 ticket

### 1.4 后端 `stats` / `listByTag` 直接删除（不保留）

**决策**：从 `index.js` 路由表和 `routes/mgmt-customer.js` 中删除 `stats` 与 `listByTag` 两个 action，连同测试文件中 `mgmtCustomer.stats SQL 形态` / `mgmtCustomer.listByTag SQL 形态` 两个 describe 一并删除。

理由：
- 全仓 grep 确认这两个 action 仅由本页 `mgmt-customer-list.ts` 调用（详见 §2.3）
- 项目处于开发阶段，无客户端版本兼容包袱（参见 [no-legacy-compat](feedback_no_legacy_compat.md)）
- 留着会被认为是"还在用"，未来代码考古成本

**注意点**：
- mgmt-customer.js 顶部的注释（"8 个 action：…"）需更新为 "6 个 action"
- 测试文件 import `{ stats, listByTag }` 需移除

### 1.5 排序与分页稳定性

**决策**：默认列表 / 关键字两个分支都加 `ORDER BY c.user_id ASC` 末尾排序键，保证多页结果不重不漏。

理由：
- 当前 `search` SQL 没有 `ORDER BY`，PG 不保证返回顺序，分页一定要补
- `c.user_id` 是 PK，一定唯一稳定
- 不引入"按最近活跃排序"等业务排序 — 那会让分页跨页重复（活跃度数值在分页之间会变化）

如未来要加"按最近购买时间倒序"等业务排序，需要在主 SQL 内 LEFT JOIN 子查询拿到该字段，并把它作为第一排序键、`user_id` 作为第二排序键 — 不在本 ticket 范围。

### 1.6 空状态文案

**决策**：

| 场景 | 文案 |
|---|---|
| 默认列表加载中（首屏） | spinner（保留现有 `loading-wrap`） |
| 默认列表无任何顾客（scope 内零顾客） | `当前范围内暂无顾客` |
| 关键字搜索无结果 | `未找到该顾客`（保留现有文案） |
| 加载更多中（非首屏） | 底部小 spinner（保留现有 `loading-more`） |

`searched` 状态的语义保留：用于区分"未找到该顾客"和"当前范围内暂无顾客"两种空状态文案。

### 1.7 性能注意：补充查询的代价

`search` 主 SQL 拿到 N 行后，会用 `ANY($1)` 一次性查 3 张表补充字段（年消费 → tier；最近服务日期 → lastServiceDate；最近购买商品名 → lastPurchaseName）。N=50 时：

- spend 子查询：`sale_orders` 按 `client_user_id ANY($1)` + `paid_at >= 年初` + scope GROUP BY，单 PG round-trip
- svc 子查询：`service_orders` 按 `client_user_id ANY($1)` + `status='已完成'` + scope，DISTINCT ON
- lastPurchase 子查询：`sale_orders JOIN sale_items` 按 `client_user_id ANY($1)`，DISTINCT ON

对 N=50 完全没问题（线上现有 N=20 跑得很顺），且分页是"用户主动触底才下一页"，整体成本不会比标签页一次拉 6 类统计高。**不需要为分页改造引入缓存或预热**。

---

## 2 目标产物

### 2.1 修改清单

| 文件 | 改动 |
|------|------|
| `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js` | `search` 接收 `page`/`pageSize`，主 SQL 加 `ORDER BY c.user_id ASC` + `OFFSET`；返回结构改为 `{ scope, customers, page, pageSize, hasMore }`；删 `stats` 函数；删 `listByTag` 函数；更新顶部注释为 6 个 action；module.exports 移除 `stats`/`listByTag` |
| `fengyu-staff/cloudfunctions/staffApi/index.js` | 删 `'mgmtCustomer.stats'` 与 `'mgmtCustomer.listByTag'` 两行路由 |
| `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js` | 删 `mgmtCustomer.stats SQL 形态` describe；删 `mgmtCustomer.listByTag SQL 形态` describe；删 import 中的 `stats`/`listByTag`；新增 `mgmtCustomer.search 分页` 用例（page=1/page=2/默认 pageSize/越界 pageSize） |
| `fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.wxml` | 删 `stats-section` + `type-tabs` 两段；空态文案按 §1.6 调整 |
| `fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.ts` | 删 `stats` / `activeTag` / `customerType` / `tagPage` / `tagHasMore` 状态字段；删 `loadStats` / `onStatTap` / `onCustomerTypeTap` / `loadByTag` 方法；改造 `loadDefaultList` 支持 page reset；改造 `onSearch` 支持分页；改造 `onReachBottom` 用统一分页加载器；删 `CustomerStatsResponse` / `CustomerTagResponse` / `TagType` / `CustomerType` 类型 |
| `fengyu-staff/miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.wxss` | 删 `stats-section` / `stats-row` / `stat-card` / `stat-card--selected` / `stat-active` / `stat-warning` / `stat-lost` / `stat-sleep` / `stat-birthday` / `stat-birthday-next` / `stat-count` / `stat-label` / `type-tabs` / `type-tab` / `type-tab--active` / `tag-filter` 整段 |

### 2.2 不变的部分

- 路由参数（`scopeType` / `scopeId` / `scopeName`）— 透传逻辑、详情页跳转参数完全不动
- `validateScope` / `validateScopeParams` / `buildClientScope` / `buildSaleScope` / `maskPhone` 等共享 helper
- `mgmtCustomer.search` 主表 / 关联表 / 字段集合 / 手机号脱敏策略不变
- `mgmtCustomer.detail` / `calendar` / `paidOrders` / `giftHistory` / `refundHistory` / `updateNotes` / `assign` / `customerBalance` 完全不动
- 顾客卡片渲染（含 vip-badge / tier-badge / 头像 / 最近购买等）完全不动

### 2.3 全仓引用扫描结果（确认 stats/listByTag 可安全删）

```
mgmtCustomer.stats 引用：
  - cloudfunctions/staffApi/index.js:118    路由表
  - cloudfunctions/staffApi/routes/mgmt-customer.js:7,251  实现 + 注释
  - cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js:355  测试
  - miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.ts:126  ← 唯一前端调用点（本 ticket 删）

mgmtCustomer.listByTag 引用：
  - cloudfunctions/staffApi/index.js:120    路由表
  - cloudfunctions/staffApi/routes/mgmt-customer.js:9,497  实现 + 注释
  - cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js:551  测试
  - miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.ts:206  ← 唯一前端调用点（本 ticket 删）
```

确认无 admin / client / 其他云函数引用。`coverage/` 目录是构建产物，删源文件后下次跑覆盖率会自然消失，不需要手动清理。

---

## 3 实现步骤

> 推荐执行顺序：**STEP A → STEP B → STEP D**（云函数 + 测试一起做完，跑测试通过后再动前端）→ **STEP C**（前端）→ STEP E（部署）

### 3.1 STEP A：后端 `routes/mgmt-customer.js` 改造

**A1. 删除函数**

- 删除整个 `stats` 函数（约 248–335 行）
- 删除整个 `listByTag` 函数（约 494–629 行，找到 `async function listByTag(ctx) {` 到对应闭合 `}`）

**A2. 改造 `search` 函数支持分页**

入口处增加参数：

```js
const { keyword, phone, page = 1, pageSize = 50 } = ctx.event.payload || {}
const safePage = Math.max(1, Number(page) || 1)
const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50))
const offset = (safePage - 1) * safePageSize
```

> 旧 `customerType` 入参（'member'/'flow'/'all'）已废弃 — 红框删除后无入口；删除该参数与 `typeFilter` 拼接逻辑。

**主 SQL 改造**：原本 3 个分支（phone / keyword / 默认）全部加 `ORDER BY c.user_id ASC LIMIT $X OFFSET $Y`。

`phone` 分支保持不分页（手机号精确命中本就只有 0~1 行，不必分页；如未来发现"同号多账户"需要再说）。

`keyword` 分支：

```js
const cs = buildClientScope(scopeType, scopeId, 'c', 2)
const limitIdx = 2 + cs.params.length
const offsetIdx = limitIdx + 1
rows = await pg.query(
  `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
          c.bound_store_id, s.store_name, c.birthday
     FROM client_wechat_users c
     LEFT JOIN stores s ON s.store_id = c.bound_store_id
    WHERE (c.phone LIKE $1 OR c.name LIKE $1)
      AND ${cs.sql}
    ORDER BY c.user_id ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
  [`%${keyword.trim()}%`, ...cs.params, safePageSize, offset],
)
```

默认列表分支：

```js
const cs = buildClientScope(scopeType, scopeId, 'c', 1)
const limitIdx = 1 + cs.params.length
const offsetIdx = limitIdx + 1
rows = await pg.query(
  `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
          c.bound_store_id, s.store_name, c.birthday
     FROM client_wechat_users c
     LEFT JOIN stores s ON s.store_id = c.bound_store_id
    WHERE ${cs.sql}
    ORDER BY c.user_id ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
  [...cs.params, safePageSize, offset],
)
```

**返回结构改为**：

```js
ctx.result = {
  scope: { type: scopeType, id: scopeId || null, name: scopeName },
  customers,
  page: safePage,
  pageSize: safePageSize,
  hasMore: customers.length === safePageSize,
}
```

> ⚠️ 注意 `customers` 是补完 tier/lastServiceDate/lastPurchaseName 后的数组；`hasMore` 用补完后的长度判断没问题，因为补完不会增删条目（仅在原条目上挂字段）。

**A3. 更新模块导出**

```js
module.exports = {
  search,        // 改造后
  detail,        // 不变
  calendar,
  paidOrders,
  giftHistory,
  refundHistory,
  updateNotes,
  assign,
  customerBalance,
}
```

删去 `stats` / `listByTag` 行。

**A4. 更新文件顶部注释**

```js
/**
 * 管理层 - 顾客档案子页（mgmt-customer-list / mgmt-customer-detail）路由
 *
 * 入口：mgmt-dashboard 首页"顾客档案"卡片（entry === 'customers'）
 *
 * 6 个 action：
 *   mgmtCustomer.search        — 默认列表 / 关键字 / 手机号（scope=bound_store_id；50/页分页）
 *   mgmtCustomer.detail        — 顾客档案详情（含越权防护：bound_store_id ∈ scope）
 *   mgmtCustomer.calendar      — 月度消费日历（scope=sale_orders.store_id）
 *   mgmtCustomer.paidOrders    — 已支付订单含明细（scope=sale_orders.store_id）
 *   mgmtCustomer.giftHistory   — 赠送记录（scope=sale_orders.store_id）
 *   mgmtCustomer.refundHistory — 退换记录（scope=sale_orders.store_id）
 *
 * （updateNotes / assign / customerBalance 详见各自 JSDoc）
 *
 * 决策点：
 *   D-mgmt-phone-mask     — 管理层 staffLevel ∈ {headquarters, market} 手机号不脱敏
 *   D-customer-scope-source — 顾客主键过滤用 bound_store_id（确定性主键）
 *   D-detail-record-scope — 详情消费/服务/赠送/退换均按 sale_orders.store_id ∈ scope 过滤
 *   D-cross-scope-customer — 顾客 bound 不在 scope → 详情接口 403
 *   D-search-pagination   — search 默认/关键字分支按 user_id ASC 排序 + 50/页分页（hasMore 由 rows.length===pageSize 推断）
 */
```

### 3.2 STEP B：`index.js` 路由表清理

`fengyu-staff/cloudfunctions/staffApi/index.js`：

```diff
   'mgmtCustomer.search':        () => require('./routes/mgmt-customer').search,
-  'mgmtCustomer.stats':         () => require('./routes/mgmt-customer').stats,
   'mgmtCustomer.detail':        () => require('./routes/mgmt-customer').detail,
-  'mgmtCustomer.listByTag':     () => require('./routes/mgmt-customer').listByTag,
   'mgmtCustomer.calendar':      () => require('./routes/mgmt-customer').calendar,
```

（具体行号以实际文件为准；保持其他 8 个 mgmtCustomer.* 路由不动。）

### 3.3 STEP C：前端三件套改造

**C1. `mgmt-customer-list.wxml`** 重写为：

```xml
<!-- packageMgmt/mgmt-customer-list/mgmt-customer-list.wxml -->
<view class="container">

  <!-- scope 提示条（只读，scope 在 hub 修改） -->
  <view class="mc-scope-bar">
    <text class="mc-scope-label">数据范围：</text>
    <text class="mc-scope-value">{{scopeName || (scopeType === 'all' ? '全部市场' : '')}}</text>
  </view>

  <van-search
    value="{{searchKeyword}}"
    placeholder="搜索姓名或手机号"
    bind:search="onSearch"
    bind:change="onSearchChange"
    use-action-slot
  >
    <view slot="action" bindtap="onSearch">搜索</view>
  </van-search>

  <view wx:if="{{loading && results.length === 0}}" class="loading-wrap">
    <van-loading type="spinner" color="#C0322A" />
  </view>

  <view wx:elif="{{results.length === 0}}" class="empty-wrap">
    <van-empty description="{{searched ? '未找到该顾客' : '当前范围内暂无顾客'}}" />
  </view>

  <view wx:else class="customer-list">
    <view
      wx:for="{{results}}"
      wx:key="clientUserId"
      class="customer-card"
      data-id="{{item.id}}"
      data-client-user-id="{{item.clientUserId}}"
      data-name="{{item.name}}"
      bindtap="onItemTap"
    >
      <view class="customer-avatar">
        <text class="customer-avatar-text">{{item.name ? item.name[0] : '?'}}</text>
      </view>
      <view class="customer-info">
        <view class="customer-name-row">
          <text class="customer-name">{{item.name || '未知'}}</text>
          <text wx:if="{{item.memberLevel}}" class="vip-badge">{{item.memberLevel}}</text>
          <text wx:if="{{item.tier === 'diamond'}}" class="tier-badge tier-badge--diamond">黑钻</text>
          <text wx:elif="{{item.tier === 'iron'}}" class="tier-badge tier-badge--iron">铁粉</text>
          <text wx:elif="{{item.tier === 'fan'}}" class="tier-badge tier-badge--fan">粉丝</text>
        </view>
        <text class="customer-phone">{{item.phone}}</text>
        <text wx:if="{{item.storeName}}" class="customer-store">{{item.storeName}}</text>
        <text wx:if="{{item.lastPurchaseName}}" class="customer-recent">最近购买：{{item.lastPurchaseName}}</text>
        <text wx:if="{{item.lastServiceDate}}" class="customer-recent">最近到店：{{item.lastServiceDate}}</text>
      </view>
    </view>
    <view wx:if="{{loading && results.length > 0}}" class="loading-more">
      <van-loading size="24rpx" />
    </view>
    <view wx:if="{{!hasMore && results.length > 0}}" class="loading-more">
      <text class="no-more-text">没有更多了</text>
    </view>
  </view>

  <view class="safe-area-bottom" />
</view>
```

要点：
- `wx:key` 从 `index` 改为 `clientUserId`（分页追加渲染下 index 容易导致 key 冲突重排）
- 末尾增加 `没有更多了` 提示（视觉上让用户感知"已经到底"）

**C2. `mgmt-customer-list.ts`** 重写为：

```ts
// packageMgmt/mgmt-customer-list — 管理层"顾客档案"列表子页
// scope 由 hub（mgmt-dashboard）通过路由参数透传，本页不再出 scope-picker
// 搜索框为空 = scope 内全部顾客分页（50/页），有 keyword = 关键字分页（50/页）
import { callStaffApi } from '../../utils/cloud';
import { canAccessManagement } from '../../utils/role';

type ScopeType = 'all' | 'market' | 'store';

interface CustomerListItem {
  id: string | null;
  clientUserId: string | null;
  name: string;
  phone: string;
  phoneMasked: string;
  memberLevel: string | null;
  storeName: string;
  tier: 'diamond' | 'iron' | 'fan' | null;
  lastServiceDate: string | null;
  lastPurchaseName: string | null;
  source: string;
}

interface CustomerSearchResponse {
  scope: { type: ScopeType; id: string | null; name: string };
  customers: CustomerListItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface ScopePayload {
  scopeType: ScopeType;
  scopeId: string | null;
}

const PAGE_SIZE = 50;

const SCOPE_TYPE_LABELS: Record<ScopeType, string> = {
  all: '全部市场',
  market: '市场',
  store: '门店',
};

Page({
  data: {
    scopeType: 'all' as ScopeType,
    scopeId: null as string | null,
    scopeName: '',
    scopeTypeLabel: '全部市场',

    searchKeyword: '',
    results: [] as CustomerListItem[],
    loading: false,
    searched: false,
    page: 1,
    hasMore: false,
  },

  onLoad(query: { scopeType?: string; scopeId?: string; scopeName?: string }) {
    const scopeType = ((query?.scopeType as ScopeType) || 'all') as ScopeType;
    const scopeId = query?.scopeId ? decodeURIComponent(query.scopeId) : null;
    const scopeName = query?.scopeName ? decodeURIComponent(query.scopeName) : '';
    this.setData({
      scopeType,
      scopeId,
      scopeName,
      scopeTypeLabel: SCOPE_TYPE_LABELS[scopeType] || '全部市场',
    });
  },

  onShow() {
    if (!canAccessManagement()) {
      wx.reLaunch({ url: '/pages/workbench/workbench' });
      return;
    }
    if (this.data.results.length === 0) {
      this.loadPage(1, true);
    }
  },

  onPullDownRefresh() {
    this.loadPage(1, true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.loading && this.data.hasMore) {
      this.loadPage(this.data.page + 1, false);
    }
  },

  scopePayload(): ScopePayload {
    return { scopeType: this.data.scopeType, scopeId: this.data.scopeId };
  },

  async loadPage(page: number, reset: boolean): Promise<void> {
    this.setData({ loading: true });
    try {
      const keyword = this.data.searchKeyword.trim();
      const payload: Record<string, unknown> = {
        ...this.scopePayload(),
        page,
        pageSize: PAGE_SIZE,
      };
      if (keyword) payload.keyword = keyword;
      const data = await callStaffApi<CustomerSearchResponse>('mgmtCustomer.search', payload);
      const newResults = reset ? (data.customers || []) : [...this.data.results, ...(data.customers || [])];
      this.setData({
        results: newResults,
        page: data.page,
        hasMore: data.hasMore,
        searched: !!keyword,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearchChange(e: WechatMiniprogram.CustomEvent) {
    const value = e.detail as unknown as string;
    this.setData({ searchKeyword: value });
    if (!value.trim()) {
      // 关键字清空 → 重置回默认列表第一页
      this.loadPage(1, true);
    }
  },

  onSearch() {
    this.loadPage(1, true);
  },

  onItemTap(e: WechatMiniprogram.TouchEvent) {
    const { clientUserId } = e.currentTarget.dataset as { clientUserId?: string };
    if (!clientUserId) return;
    const { scopeType, scopeId, scopeName } = this.data;
    const params = [
      `clientUserId=${encodeURIComponent(clientUserId)}`,
      `scopeType=${encodeURIComponent(scopeType)}`,
      `scopeId=${encodeURIComponent(scopeId || '')}`,
      `scopeName=${encodeURIComponent(scopeName || '')}`,
    ].join('&');
    wx.navigateTo({ url: `/packageMgmt/mgmt-customer-detail/mgmt-customer-detail?${params}` });
  },
});
```

要点：
- `loadPage(page, reset)` 是唯一的列表加载入口 — 默认 / 关键字 / 触底 / 下拉刷新都走它
- `onShow` 仅在 `results.length === 0` 时触发首屏加载（避免详情页 navigateBack 后整页重拉）
- `searched` 在 keyword 非空时才 true，用于空态文案区分

**C3. `mgmt-customer-list.wxss`** 删除以下样式块：

```
.stats-section / .stats-row / .stat-card / .stat-card--selected
.stat-active / .stat-warning / .stat-lost / .stat-sleep / .stat-birthday / .stat-birthday-next
.stat-count / .stat-label
.type-tabs / .type-tab / .type-tab--active
.tag-filter
```

新增（可选）：

```css
.no-more-text {
  font-size: 22rpx;
  color: #bbb;
}
.empty-wrap {
  padding-top: 60rpx;
}
```

`mc-scope-bar` / `customer-card` / `customer-avatar*` / `customer-info` / `vip-badge` / `tier-badge*` 全部保留不动。

### 3.4 STEP D：测试改造

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js`：

**D1. import 修正**

```diff
- const { search, stats, listByTag, ... } = require('...')
+ const { search, ... } = require('...')
```

**D2. 删除两个 describe**

- 删 `describe('mgmtCustomer.stats SQL 形态', ...)`（约 355–465 行）
- 删 `describe('mgmtCustomer.listByTag SQL 形态', ...)`（约 551–630 行）

**D3. 在 `describe('mgmtCustomer.search SQL 形态', ...)` 中新增分页用例**

```js
test('默认列表 page=1 → ORDER BY user_id ASC LIMIT 50 OFFSET 0', async () => {
  const ctx = makeCtx({ scopeType: 'all', page: 1, pageSize: 50 })
  await search(ctx)
  const mainSql = pgQueryMock.mock.calls[0][0]
  expect(mainSql).toMatch(/ORDER BY c\.user_id ASC/)
  expect(mainSql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/)
  const params = pgQueryMock.mock.calls[0][1]
  expect(params[params.length - 2]).toBe(50)  // limit
  expect(params[params.length - 1]).toBe(0)   // offset
})

test('默认列表 page=2 → OFFSET 50', async () => {
  const ctx = makeCtx({ scopeType: 'all', page: 2, pageSize: 50 })
  await search(ctx)
  const params = pgQueryMock.mock.calls[0][1]
  expect(params[params.length - 1]).toBe(50)
})

test('未传 pageSize → 默认 50', async () => {
  const ctx = makeCtx({ scopeType: 'all' })
  await search(ctx)
  const params = pgQueryMock.mock.calls[0][1]
  expect(params[params.length - 2]).toBe(50)
})

test('pageSize 超 100 → 截断为 100', async () => {
  const ctx = makeCtx({ scopeType: 'all', pageSize: 999 })
  await search(ctx)
  const params = pgQueryMock.mock.calls[0][1]
  expect(params[params.length - 2]).toBe(100)
})

test('返回结构包含 page/pageSize/hasMore', async () => {
  const ctx = makeCtx({ scopeType: 'all', page: 1, pageSize: 50 })
  // mock 主 SQL 返回 50 行 → hasMore=true
  pgQueryMock.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({
    user_id: `u${i}`, phone: '13800000000', name: `n${i}`,
    customer_id: null, member_level: null, bound_store_id: null,
    store_name: null, birthday: null,
  })))
  pgQueryMock.mockResolvedValue([])  // 三个补充查询返回空
  await search(ctx)
  expect(ctx.result.page).toBe(1)
  expect(ctx.result.pageSize).toBe(50)
  expect(ctx.result.hasMore).toBe(true)
})

test('返回行数 < pageSize → hasMore=false', async () => {
  const ctx = makeCtx({ scopeType: 'all', page: 1, pageSize: 50 })
  pgQueryMock.mockResolvedValueOnce([
    { user_id: 'u1', phone: '13800000000', name: 'n1', customer_id: null,
      member_level: null, bound_store_id: null, store_name: null, birthday: null },
  ])
  pgQueryMock.mockResolvedValue([])
  await search(ctx)
  expect(ctx.result.hasMore).toBe(false)
})
```

> ⚠️ 上面的 mock 写法是示意，实际命名以测试文件中已有的 `makeCtx` / `pgQueryMock` 风格为准（先 read 文件确认 mock 工具名）。

**D4. 跑测试**

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/staffApi
npm test -- mgmt-customer
```

预期：原 search/detail/calendar/paidOrders/giftHistory/refundHistory 用例全部通过；stats/listByTag describe 已删除；新增 6 个分页用例全部通过。

### 3.5 STEP E：部署 staffApi

```bash
# 通过 cloudbase-deploy skill 或：
cd fengyu-staff/cloudfunctions/staffApi
tcb fn code update -n staffApi
```

> ⚠️ 禁止 `tcb fn deploy --force`（会清环境变量，参见 [cloudbase-envvar-risk](project_cloudbase_envvar_risk.md)）

部署后用 mock 模式或登录管理层账号验证 §4.2。

---

## 4 测试策略

### 4.1 后端单测

- `npm test -- mgmt-customer` 全绿
- 覆盖率不应下降（删除 stats/listByTag 减少了源码行数，等比覆盖率不变或上升）

### 4.2 微信开发者工具手动验证

打开 `fengyu-staff/miniprogram/`，登录管理层账号 → mgmt-dashboard → 点 `顾客档案`：

| 用例 | 操作 | 期望 |
|---|---|---|
| 1. 首屏 | 进入页面 | scope 提示条 + 搜索框 + 顾客列表（50 条以内）+ 底部"没有更多了"或继续加载状态 |
| 2. 触底加载 | 上滑到底 | 自动追加下一页 50 条；加载中底部显示 spinner；满 50 后还有下一页则继续可滚 |
| 3. 全部到底 | 滚到底 N 次后返回不足 50 条 | 底部显示"没有更多了"，再下滑无新增请求 |
| 4. 关键字搜索 | 输入"张" + 点"搜索"或回车 | 列表重置为关键字命中的第一页（50 内）；点击触底加载下一页 |
| 5. 清空关键字 | 把关键字一键清空 | 自动回到默认全列表第一页 |
| 6. 关键字无结果 | 输入"qwertyzz" | `未找到该顾客` 空态 |
| 7. scope 内零顾客 | 进入一个空门店 scope | `当前范围内暂无顾客` 空态 |
| 8. 详情页返回 | 点列表项进详情 → 返回 | 列表保留分页位置（**不重新加载**） |
| 9. 下拉刷新 | 顶部下拉 | 列表回到第一页 50 条，分页位置归零 |

### 4.3 静态扫描

```bash
# 确认前端无残留引用
grep -rn "mgmtCustomer\.stats\|mgmtCustomer\.listByTag\|onStatTap\|onCustomerTypeTap\|loadByTag\|loadStats\|stats-section\|type-tabs\|stat-card\|activeTag\|customerType\b" \
  /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram/

# 后端无残留实现
grep -rn "mgmtCustomer\.stats\|mgmtCustomer\.listByTag\|^async function stats\|^async function listByTag" \
  /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/cloudfunctions/
```

预期：上述命令零命中（除 `coverage/` 等构建产物，可忽略）。

### 4.4 不需要的测试

- 后端 `detail` / `calendar` / `paidOrders` / `giftHistory` / `refundHistory` 路由未变 → 不需要新增测试
- 手机号脱敏策略未变 → 现有 `mgmtCustomer 手机号脱敏策略` describe 全部继续通过
- admin 不调用本接口 → 无需 admin 端测试

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 删 stats/listByTag 影响其他端 | §2.3 grep 已确认仅本页调用，admin 与 client 均无引用 |
| 分页 SQL 没排序导致跨页重复/丢失 | §1.5 强制 `ORDER BY c.user_id ASC` |
| `pageSize` 用户端伪造大值（999） | 后端 §3.1 `Math.min(100, ...)` 截断 |
| 触底连续触发导致同页重复请求 | `if (!this.data.loading && this.data.hasMore)` 守卫 |
| 详情页返回后重新 onShow → 整页重拉丢失分页位置 | `onShow` 内 `if (this.data.results.length === 0) loadPage(1, true)` 守卫 |
| 50 条 + 3 个 N+1 子查询是否压垮 PG | 单批 50 行 + 3 条 ANY($1) GROUP BY，`client_user_id` 有索引；线上现有 20/批跑得很顺，50/批同量级 |
| wxss 中残留 `stat-*` 样式不会报错但污染 | 一次性 grep 清理；不影响功能 |
| 测试文件 import `stats`/`listByTag` 残留 | STEP D1 修正 import |
| coverage/ 残留旧 stats/listByTag HTML | 下次跑覆盖率自动重生成；如需立即清理 `rm -rf coverage` |

---

## 6 不在本 ticket 范围

- 任何业务规则变更（活跃 / 即将流失 / 流失 / 沉睡的判定口径）— 这些口径与 customer.stats（**非** mgmtCustomer.stats）的定义将继续在门店端 `pages/customer-list` 使用，本 ticket 不动
- 顾客详情页 `mgmt-customer-detail` 的任何改动
- mgmt-dashboard 首页的 `顾客档案` 入口卡片样式 / 跳转参数变更
- 排序方式变更（按最近活跃 / 按消费降序等）— 当前固定 `user_id ASC`
- 多门店多市场账号下「批量切换 scope」改造
- 管理层端"按标签筛选顾客"能力的替代实现 — 本 ticket 直接删除该能力，未来如有需要再开新 ticket
- 顾客列表的 PWA 离线缓存 / 客户端搜索增量

---

## 7 交付物清单

### 7.1 修改

- [ ] `cloudfunctions/staffApi/routes/mgmt-customer.js`：删 `stats` / `listByTag` 函数；`search` 加 `page`/`pageSize`/排序/OFFSET；返回结构含 `hasMore`；module.exports 同步更新；顶部注释更新为 6 个 action
- [ ] `cloudfunctions/staffApi/index.js`：删 `mgmtCustomer.stats` / `mgmtCustomer.listByTag` 路由
- [ ] `cloudfunctions/staffApi/__tests__/routes/mgmt-customer.test.js`：删两个废弃 describe；改 import；新增 6 个 search 分页用例
- [ ] `miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.wxml`：删红框两段；空态文案区分；`wx:key` 改 `clientUserId`；新增"没有更多了"提示
- [ ] `miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.ts`：状态 / 方法 / 类型按 §3.3 重写；新增 `loadPage(page, reset)` 统一入口
- [ ] `miniprogram/packageMgmt/mgmt-customer-list/mgmt-customer-list.wxss`：删 stat-* / type-tab* / tag-filter 样式块；可选新增 `.no-more-text`

### 7.2 验证

- [ ] `cd cloudfunctions/staffApi && npm test -- mgmt-customer` 全绿
- [ ] §4.3 grep 命令零命中
- [ ] 微信开发者工具中 §4.2 用例 1–9 全部通过
- [ ] 部署 staffApi 后，环境变量 `PG_CONNECTION_STRING` / `CLIENT_SECRET` 仍在（参见 cloudbase-envvar-risk）

### 7.3 不需要

- 数据库无变更（无 migration）
- admin 端无变更
- client 端无变更
- staff 端其他页面（workbench / order-create / service / customer-list / profile）无变更
- 路由参数兼容（mgmt-dashboard → mgmt-customer-list 跳转 URL 完全不变）
