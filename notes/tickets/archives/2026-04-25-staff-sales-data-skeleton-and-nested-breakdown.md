# Ticket: staff 管理层「销售数据」页 — 经营类型骨架化 + 一二级品项嵌套合并（品项动态来源）

> 生成日期：2026-04-25
> 严重级别：P3（管理层视图体验优化，不影响业务正确性）
> 端：fengyu-staff（员工端小程序 + staffApi 云函数）
> 影响面：
> - 修改：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`（`salesData` 出参结构 + 新增骨架查询）
> - 修改：`fengyu-staff/miniprogram/pages/sales-data/sales-data.ts`
> - 修改：`fengyu-staff/miniprogram/pages/sales-data/sales-data.wxml`
> - 修改：`fengyu-staff/miniprogram/pages/sales-data/sales-data.wxss`
> 前置：[2026-04-25-staff-sales-data-breakdown-default-expand.md](./2026-04-25-staff-sales-data-breakdown-default-expand.md)（默认展开 + 空态占位已落地，本 ticket 在其上演进）
> 并行：与其他 staff 页面 ticket 互不干扰
>
> **一句话目标**：把「按经营类型 / 按一级品项 / 按二级品项」三个独立分组，重构为「按经营类型」（4 行硬骨架，0 也展示）+「按品项」（一二级嵌套树，**骨架来自 `product_categories` 表当前快照**，不预设固定枚举）。当期销售为零时仍铺出完整骨架，值为 `0.00`。

---

## 0 一句话背景

上一版 ticket（同日生成）把三个分组从"点击展开"改为"永久铺开"，但仍保留三组并列结构，且**当某组无数据时整组显示「暂无数据」占位**。用户反馈：
> 「显示暂无数据，请你补充上数据，就算数据库没有对应的结果，也需要展示数据骨架，值可以为 0。请你设计这个数据骨架，两个层级的品项数据也可以一起展示，怎么好看怎么来。」

后续澄清：
> 「品项分类不是固定的，是需要从数据库请求的。」

两个核心诉求：
1. **页面结构稳定**：分类 label 列必须始终展示，零销售时 value=0.00 占位（而非整组「暂无数据」）
2. **一级 + 二级品项合并展示**：一级品项作为分组节点，二级品项作为子项嵌套于一级下方
3. **骨架不能写死**：`product_kind` / `category_name` 是 `product_categories` 表的运营动态字段，骨架必须从该表实时读取

**为什么前一版仅"永久展开"不够 + 为什么不能写死枚举**：
- "暂无数据"占位让管理者无法判断是该分类不存在还是当期销售为零
- `product_kind` 在 `db/schema/enums.ts` 中**不是 pgEnum**，而是 `product.ts::product_categories.product_kind` 的 `text` 列；当前数据库内容是 `护理项目 / 家居产品 / 充值卡 / 体验卡`，但运营可在 admin 增删改这些分类
- 同理 `category_name` 也是动态文本，无法预设
- 唯一可硬编码骨架的只有 `sales_category`（真 pgEnum：自销自耗 / 他销自耗 / 他销他耗 / 生态合作）

---

## 1 设计决策

### 1.1 数据骨架来源

| 维度 | 来源 | 当前样本（仅供参考，不写死） |
|---|---|---|
| 经营类型 | **`sales_category` pgEnum**（写死） | 自销自耗 / 他销自耗 / 他销他耗 / 生态合作（共 4） |
| 一级品项 | **`product_categories` 表 `SELECT DISTINCT product_kind` 实时查** | 护理项目 / 家居产品 / 充值卡 / 体验卡（共 4，未来可变） |
| 二级品项 | **`product_categories` 表实时查（含 product_kind + category_name 配对）** | 50 行左右（其中护理项目下 41 行） |

**关键决策**：经营类型走 pgEnum 写死（业务约束铁定 4 值），一级/二级品项走 DB 动态查（运营可维护）。

### 1.2 视觉结构：嵌套两组

```
┌─ 业绩与品项 ────────────────────────────────────┐
│                                                │
│ ┌─ 按经营类型汇总 ──────────────────────────┐ │
│ │  自销自耗                          1234.56 │ │
│ │  他销自耗                              0.00 │ │
│ │  他销他耗                              0.00 │ │
│ │  生态合作                              0.00 │ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ ┌─ 按品项汇总 ─────────────────────────────┐ │
│ │ ▎护理项目                          5678.90 │ │  ← 一级（左竖条 + 主色加粗）
│ │     · 中华神灸                     2345.67 │ │  ← 二级有数据（按 value DESC）
│ │     · 周年庆                       1234.50 │ │
│ │     · 季节活动                       456.00 │ │
│ │     · 其他                             0.00 │ │  ← 二级零值（骨架，排在有数据之后）
│ │     · ……                                   │ │
│ │ ▎家居产品                              0.00 │ │  ← 一级零值仍展示
│ │     · 安吉丽美颜之爱                   0.00 │ │  ← 该一级下所有二级骨架仍展示
│ │     · 悠妃曼                           0.00 │ │
│ │     · ……                                   │ │
│ │ ▎充值卡                            1000.00 │ │
│ │     · 储值卡                       1000.00 │ │
│ │     · 次卡                             0.00 │ │
│ │ ▎体验卡                                0.00 │ │
│ │     · 68体验卡                         0.00 │ │
│ └────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

视觉要点：
- **经营类型组**：扁平 4 行
- **品项组**：一级用 4rpx 主色左竖条 + 主色加粗 label；二级缩进 32rpx + 灰色 `·` 项目符号 + 26rpx 字号
- **一级零销售仍展示**；其下属二级骨架也全部展示（运营在 `product_categories` 表登记的所有 `category_name` 都在）
- 一级与下属二级在视觉上属于一张卡片（无中间分隔阴影），相邻一级之间用 1rpx 浅色分隔线
- 经营类型卡 / 品项卡之间间距沿用 `16rpx`，与上方业绩矩阵 / 实耗卡保持一致节奏

> 关于护理项目下 41 个二级骨架的可滚性：用户原话「怎么好看怎么来」给了视觉自由度，二级在所属一级下按"值 DESC + label 升序"排，有数据的二级始终排在前面，零值骨架自然下沉到该一级末尾，扫视无压力。

### 1.3 后端 vs 前端：在哪里组装骨架

**决策：后端组装骨架**，出参直接是嵌套结构。

理由：
- 前端只渲染、不计算，逻辑更薄
- 一级求和（= 该一级下所有二级 sum）后端用 SQL 单次扫描就能拿到，前端 reduce 反而是重复计算
- 骨架来源在数据库，后端拿快照天然就近
- 经营类型枚举常量在后端（与 `db/schema/enums.ts` 同源），前端跟数据契约走

**否决方案**：前端拼骨架。前端拿不到 `product_categories` 表，需要额外开一个"分类列表"接口拉骨架，徒增 RTT。

### 1.4 出参契约变更

```diff
 // mgmtDashboard.salesData 返回值
 {
   totalRevenue, xiaomeiRevenue, ...,         // 业绩与实耗矩阵不变
   xiaomeiProductOut, newMemberProductOut, oldMemberProductOut,

-  bySalesCategory: BreakdownItem[],          // 旧：仅含有数据的，按值 DESC
+  bySalesCategory: BreakdownItem[],          // 新：固定 4 行（pgEnum 序），无数据 value='0.00'
+
-  byProductKind: BreakdownItem[],            // 旧：仅含有数据的，按值 DESC
-  byCategoryName: BreakdownItem[],           // 旧：扁平二级品项，仅含有数据的
+  byProductKind: BreakdownGroup[],           // 新：嵌套，骨架来自 product_categories 当前快照
+
+  // 类型：
+  // BreakdownItem: { label: string, value: string }            // value 是 '1234.56' 字符串
+  // BreakdownGroup: { label: string, value: string, children: BreakdownItem[] }
+  //   - label = product_kind 文本
+  //   - value = 该一级下所有二级 SUM
+  //   - children = product_categories 中所属该 kind 的全部 category_name（骨架），按 value DESC + label 升序
 }
```

**`byCategoryName` 字段彻底移除**（开发阶段无兼容包袱，与 [feedback_no_legacy_compat](../../../.claude/projects/-Users-nv-proj-xt-com-fengyu-wxapp/memory/feedback_no_legacy_compat.md) 一致）。

### 1.5 脏数据处理：`product_kind IS NULL` 的 category_name

当前 DB 有 9 条 `product_kind IS NULL` 的 `category_name`（如 `222` / `招牌` / `明星` 等历史脏数据）。

**决策：在骨架查询中过滤 `product_kind IS NULL`**，不在前端展示"未分类"组。理由：
- 这是 `product_categories` 表数据维护问题，应由 admin 后台清理
- 与现有 SQL 7（一级聚合）已用 `pc.product_kind IS NOT NULL` 的口径对齐
- 避免前端出现莫名其妙的"未分类"分组

### 1.6 排序口径

| 维度 | 排序 |
|---|---|
| 经营类型（4 行） | pgEnum 固定序：自销自耗 / 他销自耗 / 他销他耗 / 生态合作 |
| 一级品项（动态行） | 按当期 SUM(value) DESC，tiebreak label 升序 |
| 二级品项（每个一级下） | 按当期 SUM(value) DESC，tiebreak label 升序 |

**为什么一级也按值排（不按 label 字母）**：
- 一级数量少（当前 4 个），DESC 排让"营收主力品类"始终排在最上方
- 写死优先级（如硬编码"护理项目第一"）违背"分类是动态的"原则；新增一个"美容卡"类别就要改代码

**为什么不把零值的排到最后用一个特殊 tiebreak**：
- 不需要：当 SUM=0 时所有零值并列，再按 label 升序就是稳定的排列
- 当期总销售 > 0 时，>0 的一级 / 二级自然排到前面，=0 的下沉到末尾

### 1.7 性能影响

**新增 1 次查询**（SQL 9，骨架查 product_categories 快照）：
```sql
SELECT product_kind, category_name
  FROM product_categories
 WHERE product_kind IS NOT NULL
   AND category_name IS NOT NULL
 ORDER BY product_kind, category_name
```
表行数 50~100 量级，**毫秒级**，与原 8 条查询一起并发跑（`Promise.all`），不增加端到端延迟。

**前端渲染节点数**：经营类型 4 行 + 一级 4 行 + 二级 50 行 ≈ 58 行，与上一版同量级。

---

## 2 目标产物

### 2.1 修改清单

| 文件 | 改动 |
|------|------|
| `cloudfunctions/staffApi/routes/mgmt-dashboard.js` | 顶部新增 `SALES_CATEGORY_SKELETON` 常量；`Promise.all` 增加 SQL 9（骨架查询）；新增装配函数；移除 `byCategoryName`，新增 `byProductKind` 嵌套结构 |
| `miniprogram/pages/sales-data/sales-data.ts` | 类型 `BreakdownGroup` 替换扁平 `byCategoryName`；data 初值简单空数组（骨架由后端首次响应灌入） |
| `miniprogram/pages/sales-data/sales-data.wxml` | 三组 → 两组；品项组渲染嵌套（一级 + children）；删除 `sd-breakdown-empty` 整组占位 |
| `miniprogram/pages/sales-data/sales-data.wxss` | 新增 `.sd-kind-row` / `.sd-kind-bar` / `.sd-leaf-row` 嵌套样式；移除 `.sd-breakdown-empty` |

### 2.2 不变的部分

- 路由参数 `scopeType` / `scopeId` / `period` 不变
- 业绩与实耗矩阵（顶部两张卡）完全不动
- `mgmtDashboard.salesData` action 名不变
- `loadData()` 调用方式不变
- 数据库 schema、枚举值、SQL 1~8 主体逻辑不变（SQL 8 仅微调过滤条件）
- 外层 `<mgmt-data-state>` 三态壳保留

---

## 3 实现步骤

### 3.1 STEP A：后端 `mgmt-dashboard.js::salesData` 改造

**A1. 文件顶部新增枚举常量**（仅经营类型）：

```js
// 销售数据页骨架常量（仅经营类型 — 与 db/schema/enums.ts::salesCategoryEnum 同源）
// 一级/二级品项骨架不在此写死，运行时从 product_categories 表读取（见 SQL 9）
const SALES_CATEGORY_SKELETON = ['自销自耗', '他销自耗', '他销他耗', '生态合作']
```

**A2. SQL 8 微调（保持过滤一致性）**：

```diff
       // SQL 8: 按二级品项汇总
       pg.query(
-        `SELECT pc.category_name AS label,
+        `SELECT pc.product_kind AS kind,
+                pc.category_name AS label,
                 COALESCE(SUM(si.received::numeric), 0) AS value
            FROM sale_items si
            JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
            JOIN product_skus sk ON sk.sku_id = si.sku_id
            JOIN product_categories pc ON pc.category_id = sk.category_id
           WHERE ${scSale.sql}
             AND o.sale_order_type IN ('销售单', '转换单')
             AND o.status = '已支付'
             AND o.paid_at::date BETWEEN $1 AND $2
+            AND pc.product_kind IS NOT NULL
+            AND pc.category_name IS NOT NULL
-          GROUP BY pc.category_name
-          ORDER BY value DESC`,
+          GROUP BY pc.product_kind, pc.category_name`,
         saleP,
       ),
```

> SQL 8 不再 ORDER BY，由 JS 装配阶段统一排序（值 DESC + label 升序）。

**A3. 新增 SQL 9（骨架查询，与 SQL 1~8 并发执行）**：

```diff
   const t0 = Date.now()
-  const [revRows, custRevRows, consRows, custConsRows, prodOutRows, catRows, kindRows, nameRows] =
+  const [revRows, custRevRows, consRows, custConsRows, prodOutRows, catRows, kindRows, nameRows, skeletonRows] =
     await Promise.all([
       // SQL 1~8 ... 不变 ...
+      // SQL 9: 品项骨架（不依赖时间窗 / scope，是 product_categories 表的当前全量快照）
+      pg.query(
+        `SELECT product_kind, category_name
+           FROM product_categories
+          WHERE product_kind IS NOT NULL
+            AND category_name IS NOT NULL
+          ORDER BY product_kind, category_name`,
+        [],
+      ),
     ])
```

**A4. 装配函数替换原 `toList`**：

```js
const fmtRow = (label, value) => ({ label, value: fmt(value) })
const cmpDescByValueAscByLabel = (a, b) => {
  const dv = parseFloat(b.value) - parseFloat(a.value)
  return dv !== 0 ? dv : a.label.localeCompare(b.label, 'zh-Hans-CN')
}

// 经营类型骨架（4 行硬展示，pgEnum 序）
const catMap = new Map(catRows.map((r) => [r.label, r.value]))
const bySalesCategory = SALES_CATEGORY_SKELETON.map((lbl) =>
  fmtRow(lbl, catMap.get(lbl) || 0),
)

// 一级 / 二级骨架来自 SQL 9 的 product_categories 快照
const kindTotalMap = new Map(kindRows.map((r) => [r.label, r.value]))
const leafValueMap = new Map() // `${kind}::${label}` -> value
for (const r of nameRows) {
  leafValueMap.set(`${r.kind}::${r.label}`, r.value)
}

// 按 product_kind 分组骨架
const groupBuilder = new Map() // kind -> { value, children: [] }
for (const sk of skeletonRows) {
  if (!groupBuilder.has(sk.product_kind)) {
    groupBuilder.set(sk.product_kind, { children: [] })
  }
  const v = leafValueMap.get(`${sk.product_kind}::${sk.category_name}`) || 0
  groupBuilder.get(sk.product_kind).children.push(fmtRow(sk.category_name, v))
}

// 装配最终结构：一级 value 取 kindRows，children 排序，一级整体按 value DESC + label 升序
const byProductKind = Array.from(groupBuilder.entries())
  .map(([kind, { children }]) => ({
    label: kind,
    value: fmt(kindTotalMap.get(kind) || 0),
    children: children.sort(cmpDescByValueAscByLabel),
  }))
  .sort(cmpDescByValueAscByLabel)

ctx.result = {
  totalRevenue: fmt(revRows[0]?.v),
  // ... 业绩与实耗字段不变 ...
  bySalesCategory,
  byProductKind,
  // byCategoryName 字段彻底删除
}
```

> 注：`groupBuilder` 用 `Map` 而非对象，是为了保留 `product_categories` 表的原始顺序（`ORDER BY product_kind` 已按 kind 聚拢），后续再用 `cmpDescByValueAscByLabel` 重排。

**A5. SQL 8 注释从「按二级品项汇总」改为「按一二级品项当期销售（嵌套用）」**。

### 3.2 STEP B：前端 `sales-data.ts` 类型与 data 改造

```diff
 type Period = 'month' | 'lastMonth' | 'year'
 type ScopeType = 'all' | 'market' | 'store'

 interface BreakdownItem {
   label: string
   value: string
 }
+
+interface BreakdownGroup {
+  label: string
+  value: string
+  children: BreakdownItem[]
+}

 interface SalesDataResp {
   totalRevenue: string
   // ... 业绩与实耗字段不变 ...
   bySalesCategory: BreakdownItem[]
-  byProductKind: BreakdownItem[]
-  byCategoryName: BreakdownItem[]
+  byProductKind: BreakdownGroup[]
 }

 interface IData {
   period: Period
   // ...
   bySalesCategory: BreakdownItem[]
-  byProductKind: BreakdownItem[]
-  byCategoryName: BreakdownItem[]
+  byProductKind: BreakdownGroup[]
 }

 Page<IData, WechatMiniprogram.IAnyObject>({
   data: {
     // ...
-    bySalesCategory: [],
-    byProductKind: [],
-    byCategoryName: [],
+    bySalesCategory: [],   // 首次 setData 由后端骨架灌入
+    byProductKind: [],
   },
```

`loadData()` 中的 setData：

```diff
       this.setData({
         // ... 业绩与实耗字段不变 ...
-        bySalesCategory: d.bySalesCategory || [],
-        byProductKind: d.byProductKind || [],
-        byCategoryName: d.byCategoryName || [],
+        bySalesCategory: d.bySalesCategory || [],
+        byProductKind: d.byProductKind || [],
       })
```

> 不在前端再硬编码 `INITIAL_PRODUCT_KIND` 等常量 — 骨架是动态的，加载完成前空数组（外层 `<mgmt-data-state state="{{state}}">` 已经处理 loading 态）。

### 3.3 STEP C：前端 `sales-data.wxml` 模板改造

> 注：当前文件外层有 `<mgmt-data-state state="{{state}}" bind:retry="onRetry">` 三态壳包裹，**保留不动**；本 step 仅替换其中"业绩与品项区"那一个 `<view class="sd-section">` 块。

替换"业绩与品项区"整段（前一版 ticket 的三组结构 → 本 ticket 的两组）：

```xml
<!-- 业绩与品项区 -->
<view class="sd-section">
  <view class="sd-section-title">业绩与品项</view>

  <!-- 1. 按经营类型汇总（pgEnum 4 行硬骨架） -->
  <view class="sd-breakdown-group">
    <view class="sd-breakdown-item">
      <text class="sd-breakdown-label">按经营类型汇总</text>
    </view>
    <view class="sd-breakdown-list">
      <view class="sd-breakdown-row" wx:for="{{bySalesCategory}}" wx:key="label">
        <text class="sd-breakdown-name">{{item.label}}</text>
        <text class="sd-breakdown-value">{{item.value}}</text>
      </view>
    </view>
  </view>

  <!-- 2. 按品项汇总（一级 + 二级嵌套，骨架来自 product_categories 快照） -->
  <view class="sd-breakdown-group">
    <view class="sd-breakdown-item">
      <text class="sd-breakdown-label">按品项汇总</text>
    </view>
    <view class="sd-breakdown-list">
      <block wx:for="{{byProductKind}}" wx:key="label" wx:for-item="kind">
        <!-- 一级行：左竖条 + 主色加粗 -->
        <view class="sd-kind-row">
          <view class="sd-kind-bar"></view>
          <text class="sd-kind-name">{{kind.label}}</text>
          <text class="sd-kind-value">{{kind.value}}</text>
        </view>
        <!-- 二级行：缩进 + 项目符号（骨架包含所有该一级下的二级，零值也在） -->
        <view class="sd-leaf-row" wx:for="{{kind.children}}" wx:key="label" wx:for-item="leaf">
          <text class="sd-leaf-name">· {{leaf.label}}</text>
          <text class="sd-leaf-value">{{leaf.value}}</text>
        </view>
      </block>
    </view>
  </view>
</view>
```

要点：
- 不再有 `wx:if="length > 0"` + `wx:else` 整组占位（骨架保证非空）
- 不再有"该分类暂无明细"占位（每个一级下二级骨架完整，运营若把某分类清空则确实显示不出来 — 这正确）
- 一级 / 二级各用一套独立 class（`.sd-kind-*` / `.sd-leaf-*`），不复用 `.sd-breakdown-row`
- `wx:for-item="kind"` / `wx:for-item="leaf"` 重命名以便嵌套层不混淆

### 3.4 STEP D：前端 `sales-data.wxss` 嵌套样式

> 注：当前 wxss 已统一使用 CSS 变量（`var(--color-bg-card)` / `var(--radius-lg)` / `var(--spacing-tight)` 等）。本 step 新增样式延用变量风格。

在 `.sd-breakdown-row` 之后追加新规则，并删除 `.sd-breakdown-empty`：

```diff
-.sd-breakdown-empty {
-  background: var(--color-bg-card);
-  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
-  text-align: center;
-  font-size: 24rpx;
-  color: var(--color-text-hint);
-  padding: 32rpx 0;
-  box-shadow: var(--shadow-card);
-}

+/* 一级品项行：左竖条 + 主色加粗 */
+.sd-kind-row {
+  display: flex;
+  align-items: center;
+  padding: 18rpx 28rpx 14rpx;
+  border-top: 1rpx solid var(--color-divider-soft);
+}
+.sd-kind-row:first-child {
+  border-top: none;
+}
+.sd-kind-bar {
+  width: 4rpx;
+  height: 28rpx;
+  background: var(--color-primary);
+  border-radius: 2rpx;
+  margin-right: 12rpx;
+}
+.sd-kind-name {
+  flex: 1;
+  font-size: 28rpx;
+  color: var(--color-primary);
+  font-weight: 600;
+  word-break: break-all;
+}
+.sd-kind-value {
+  font-size: 28rpx;
+  color: var(--color-primary);
+  font-weight: 600;
+  flex-shrink: 0;
+}
+
+/* 二级品项行：缩进 + 灰色 · 项目符号 */
+.sd-leaf-row {
+  display: flex;
+  justify-content: space-between;
+  align-items: center;
+  padding: 10rpx 28rpx 10rpx 56rpx;
+  font-size: 26rpx;
+}
+.sd-leaf-row:last-child {
+  padding-bottom: 16rpx;
+}
+.sd-leaf-name {
+  flex: 1;
+  color: var(--color-text-secondary);
+  padding-right: var(--spacing-tight);
+  word-break: break-all;
+}
+.sd-leaf-value {
+  color: var(--color-text-primary);
+  font-weight: 500;
+  flex-shrink: 0;
+}
```

视觉收尾：
- 一级 padding 上下不对称（`18rpx 28rpx 14rpx`），让一级与下属二级在视觉上更紧凑
- 二级 `padding-left: 56rpx`（28rpx 标题缩进 + 28rpx 二级再缩）形成层级感
- 一级 `border-top: 1rpx solid var(--color-divider-soft)`（首个无）作为相邻一级分隔线
- 一级 + 二级共享同一张卡片（`.sd-breakdown-list` 的圆角 + 阴影），不再独立分组

---

## 4 测试策略

### 4.1 后端测试

`fengyu-staff/cloudfunctions/staffApi/routes/__tests__/mgmt-dashboard.test.js`（如已存在），新增/调整：

| 用例 | 期望 |
|---|---|
| `salesData` 全空销售数据库（product_categories 有数据） | `bySalesCategory.length===4` 且全部 `value==='0.00'`；`byProductKind.length` = `product_categories` 中 distinct product_kind 数；每个 group `value==='0.00'`、`children` 是该 kind 下全部 category_name（值 `'0.00'`） |
| `salesData` 仅护理项目有销售 | `byProductKind[0].label==='护理项目'`、`value > 0`；其下 children 中有数据的二级排前（>0），零值二级排后；其余一级 group `value==='0.00'`、children 全为 0 |
| `salesData` `product_kind IS NULL` 脏数据 | `byProductKind` 不包含"未分类"组；脏行被静默丢弃 |
| `salesData` `product_categories` 全空时 | `byProductKind === []`（前端能正确渲染空列表） |
| 排序稳定性 | 多次调用同期，相同数据 `byProductKind` 顺序稳定（值 DESC + label 升序） |
| 跨 `product_categories` 增删 | mock 在 product_categories 增加一条新 product_kind，新调用立即在 byProductKind 出现该组 |

### 4.2 前端编译/类型自检

```bash
grep -rn "byCategoryName\|INITIAL_PRODUCT_KIND\|PRODUCT_KIND_SKELETON" \
  /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/
```

预期：除 ticket 文档外，源代码零命中（因为骨架不在前端写死、不再返回 byCategoryName、不再用 PRODUCT_KIND_SKELETON 常量）。

```bash
grep -rn "BreakdownGroup\|sd-kind-\|sd-leaf-\|SALES_CATEGORY_SKELETON" \
  /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/
```

预期：覆盖 `mgmt-dashboard.js`（仅 `SALES_CATEGORY_SKELETON`） + `sales-data.{ts,wxml,wxss}`。

### 4.3 微信开发者工具手动验证（5 用例）

| 用例 | 操作 | 期望 |
|---|---|---|
| 1. 默认进入（本月，有数据） | 直接打开页面 | 经营类型 4 行全显（部分 0.00），一级品项按值 DESC 全显（部分 0.00），有数据的一级下二级完整骨架（值 0 也在） |
| 2. 切到一个无销售数据的 scope/period | 选一个空数据组合 | 经营类型 4 行全 0.00；一级品项数量 = `product_categories` 当前 distinct product_kind 数，全 0.00；每个一级下二级骨架完整、全 0.00 |
| 3. 长二级列表（护理项目本年） | 切换"本年" + 全店 | 护理项目下二级行较多（含零值骨架），有数据的排前，零值下沉；其余 3 个一级行结构对齐 |
| 4. admin 后台新增一个 product_kind | 在 admin 加一个新分类（如"礼品卡"）+ 一个 category_name，不录销售 | sales-data 页刷新后立即出现"礼品卡"一级 + 该一级下的新二级，值均为 0.00 |
| 5. 视觉对比 | 与上方业绩矩阵对照 | 经营类型卡 / 品项卡之间间距 16rpx，与业绩矩阵 ↔ 实耗卡间距一致；一级行主色加粗与上方"业绩与实耗"小标题色调一致 |

### 4.4 手动 SQL 验证（可选，开发期一次性）

```sql
-- 验证骨架查询返回行数 = product_categories 表中 product_kind / category_name 都非空的行数
SELECT product_kind, COUNT(*)
  FROM product_categories
 WHERE product_kind IS NOT NULL AND category_name IS NOT NULL
 GROUP BY product_kind
 ORDER BY product_kind;
-- 预期：当前 4 行（护理项目 41 / 家居产品 4 / 充值卡 2 / 体验卡 1），后端 byProductKind 长度应等于此 4
```

---

## 5 风险与缓解

| 风险 | 缓解 |
|---|---|
| 护理项目下二级数量大（>40 含骨架），整张品项卡变长 | 当前性能可接受（DOM 节点 ~58）；若后续超 100 行再单独开 ticket 加"展开/收起"控件（不影响当前契约） |
| 排序按值 DESC 在零数据期没区分度（所有都 0） | tiebreak 用 `label.localeCompare('zh-Hans-CN')` 拼音序，结果稳定可预测 |
| `product_categories` 表脏数据（NULL 行）会让 byProductKind 漏掉部分 category_name | SQL 9 已过滤 `product_kind IS NOT NULL AND category_name IS NOT NULL`；这部分需要 admin 后台清理（不在本 ticket 范围） |
| 经营类型 pgEnum 后续新增枚举值（如新增"集团采购"），后端常量未同步 | 在 `mgmt-dashboard.js` 顶部注释明确"与 enums.ts::salesCategoryEnum 同源"；变更走 [wx-change-propagation](../../../.claude/skills/wx-change-propagation/) 全仓扫描 |
| SQL 9 拉全表 product_categories（无 scope 过滤）— 多店共享同一份骨架 | 这是设计意图（骨架是全局 product 维度，与 scope 无关）；若未来支持"门店私有商品"需要重新审视 |
| `product_kind` text 列可能由不同来源写入相同语义但不同 spelling（如"护理项目"vs"护理项目 "尾空格） | 本 ticket 不处理；建议 admin 表单加 trim + 唯一约束 |

---

## 6 不在本 ticket 范围

- 一级 / 二级的指标口径变更（仍用 `received` 求和，与现有一致）
- `product_kind IS NULL` 脏数据的 admin 清理流程
- `product_kind` 文本去重/标准化（trim、大小写归一）
- 二级数量爆炸时的折叠/分页能力（留作后续 ticket）
- 经营类型 / 一级品项的可视化（条形图、占比环），仅文本列表
- mgmt-dashboard hub 页本身的展示改造
- 业绩与实耗矩阵的任何变动

---

## 7 交付物清单

### 7.1 后端

- [ ] `cloudfunctions/staffApi/routes/mgmt-dashboard.js`：新增 `SALES_CATEGORY_SKELETON` 常量（注释强调"仅经营类型，品项骨架走 SQL 9 动态查"）
- [ ] `cloudfunctions/staffApi/routes/mgmt-dashboard.js`：SQL 8 微调（增加 NULL 过滤 + 返回 kind 列）
- [ ] `cloudfunctions/staffApi/routes/mgmt-dashboard.js`：新增 SQL 9（`product_categories` 骨架查询）
- [ ] `cloudfunctions/staffApi/routes/mgmt-dashboard.js`：装配逻辑替换原 `toList`，输出 `bySalesCategory`(4 行) + `byProductKind`(动态嵌套组)，**移除 `byCategoryName`**
- [ ] 部署到 CloudBase（参考 [cloudbase-deploy](../../../.claude/skills/cloudbase-deploy/) skill）

### 7.2 前端

- [ ] `pages/sales-data/sales-data.ts`：新增 `BreakdownGroup` 类型；删除 `byCategoryName` 字段；data 初值简单空数组
- [ ] `pages/sales-data/sales-data.wxml`：三组 → 两组；品项组渲染嵌套（一级 + 二级骨架）；删除整组「暂无数据」与「该分类暂无明细」占位
- [ ] `pages/sales-data/sales-data.wxss`：新增 `.sd-kind-row` / `.sd-kind-bar` / `.sd-kind-name` / `.sd-kind-value` / `.sd-leaf-row` / `.sd-leaf-name` / `.sd-leaf-value`；删除 `.sd-breakdown-empty`

### 7.3 验证

- [ ] `grep -rn "byCategoryName\|PRODUCT_KIND_SKELETON" fengyu-staff/` 在源码（非 ticket 文档）零命中
- [ ] 微信开发者工具 5 用例全部通过（默认 / 全空 / 长二级 / admin 新增 / 视觉对比）
- [ ] 后端 vitest 用例（如已有 mgmt-dashboard.test.js）扩充并通过
- [ ] 部署后从 mgmt-dashboard 进入 sales-data 实测（本月/上月/本年 三档 + 不同 scope）

### 7.4 不需要

- 数据库 schema 变更
- migration
- 路由参数或 action 名变更
- admin 后台联动改动（除非测试 4 用例需要 admin 配合操作）
