# Ticket — 销售数据页后端接口（staffApi `mgmtDashboard.salesData`）

> 前置：无
> 后置：salesData-page（T2）

## 目标

在 `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js` 中新增 `mgmtDashboard.salesData` action，为销售数据页提供两类数据：
1. **业绩与实耗**：总业绩、分客型业绩（小美客/新增会员/老会员）、总实耗、分客型项目实耗、分客型产品出库
2. **品项维度汇总**：按经营类型 / 一级品项 / 二级品项三维度

## 接口设计

### Action：`mgmtDashboard.salesData`

**请求参数**

```js
{
  period: 'month' | 'lastMonth' | 'year',   // 时间维度
  scope: { type: 'all' | 'market' | 'store', id?: string }  // 门店/市场/全部，与其他 mgmtDashboard action 一致
}
```

**响应结构**

```js
{
  code: 0,
  data: {
    // === 业绩与实耗 ===
    totalRevenue: string,           // 总业绩（SUM paid_amount，2位小数）
    xiaomeiRevenue: string,         // 小美客业绩
    newMemberRevenue: string,       // 新增会员业绩
    oldMemberRevenue: string,       // 老会员业绩

    totalConsume: string,           // 总实耗（SUM unit_real_price * session_used，2位小数）
    xiaomeiProjectConsume: string,  // 小美客项目实耗
    newMemberProjectConsume: string,// 新增会员实耗
    oldMemberProjectConsume: string,// 老会员实耗

    xiaomeiProductOut: string,      // 小美客产品出库
    newMemberProductOut: string,    // 新增会员产品出库
    oldMemberProductOut: string,    // 老会员产品出库

    // === 品项维度汇总 ===
    bySalesCategory: [              // 按经营类型
      { label: string, value: string }  // label: '自销自耗'等，value: 金额字符串
    ],
    byProductKind: [                // 按一级品项
      { label: string, value: string }  // label: '护理项目'等
    ],
    byCategoryName: [               // 按二级品项
      { label: string, value: string }  // label: product_categories.category_name
    ]
  }
}
```

> 金额全部在后端格式化为 `'0.00'` 字符串（与现有 mgmt-dashboard.js 数字格式保持一致）。
> 品项汇总按 value DESC 排序，value=0 的行不返回（空品类不展示）。

## SQL 规范

### 时间窗口 helper

在文件顶部或 action 内复用现有 `getTimeWindowPeriod` / `timeWindowPeriod` 函数（若已存在），或新增：

```js
function getSalesDataPeriod(period) {
  // 返回 { startDate, endDate }，字符串格式 'YYYY-MM-DD'
  // 本月: { start: 当月1号, end: 今天 }
  // 上月: { start: 上月1号, end: 上月最后一天 }
  // 本年: { start: 当年1月1日, end: 今天 }
}
```

### SQL 1 — 总业绩

```sql
SELECT COALESCE(SUM(o.paid_amount::numeric), 0) AS total_revenue
FROM sale_orders o
WHERE o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date BETWEEN $startDate AND $endDate
  AND <scope>
```

### SQL 2 — 分客型业绩（3 条，或 1 条用 CASE 聚合）

推荐用单 SQL CASE 聚合，减少 round-trip：

```sql
SELECT
  COALESCE(SUM(si.received::numeric) FILTER (
    WHERE c.customer_type = '小美客'
  ), 0) AS xiaomei_revenue,
  COALESCE(SUM(si.received::numeric) FILTER (
    WHERE c.became_member_at::date BETWEEN $startDate AND $endDate
  ), 0) AS new_member_revenue,
  COALESCE(SUM(si.received::numeric) FILTER (
    WHERE c.customer_type = '会员客'
      AND c.became_member_at::date < $startDate
  ), 0) AS old_member_revenue
FROM sale_items si
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
JOIN client_wechat_users c ON c.client_user_id = o.client_user_id
WHERE o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date BETWEEN $startDate AND $endDate
  AND <scope on o.store_id>
```

### SQL 3 — 总实耗

```sql
SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS total_consume
FROM service_items sit
JOIN service_orders so ON so.service_order_id = sit.service_order_id
WHERE so.status = '已完成'
  AND so.service_date BETWEEN $startDate AND $endDate
  AND <scope on so.store_id>
```

### SQL 4 — 分客型项目实耗（CASE 聚合）

```sql
SELECT
  COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
    WHERE c.customer_type = '小美客'
  ), 0) AS xiaomei_project_consume,
  COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
    WHERE c.became_member_at::date BETWEEN $startDate AND $endDate
  ), 0) AS new_member_project_consume,
  COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
    WHERE c.customer_type = '会员客'
      AND c.became_member_at::date < $startDate
  ), 0) AS old_member_project_consume
FROM service_items sit
JOIN service_orders so ON so.service_order_id = sit.service_order_id
JOIN client_wechat_users c ON c.client_user_id = so.client_user_id
WHERE so.status = '已完成'
  AND so.service_date BETWEEN $startDate AND $endDate
  AND <scope on so.store_id>
```

### SQL 5 — 分客型产品出库（CASE 聚合）

```sql
SELECT
  COALESCE(SUM(si.received::numeric) FILTER (
    WHERE c.customer_type = '小美客'
  ), 0) AS xiaomei_product_out,
  COALESCE(SUM(si.received::numeric) FILTER (
    WHERE c.became_member_at::date BETWEEN $startDate AND $endDate
  ), 0) AS new_member_product_out,
  COALESCE(SUM(si.received::numeric) FILTER (
    WHERE c.customer_type = '会员客'
      AND c.became_member_at::date < $startDate
  ), 0) AS old_member_product_out
FROM sale_items si
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN product_categories pc ON pc.category_id = sk.category_id
JOIN client_wechat_users c ON c.client_user_id = o.client_user_id
WHERE pc.product_kind = '家居产品'
  AND o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date BETWEEN $startDate AND $endDate
  AND <scope on o.store_id>
```

### SQL 6 — 按经营类型汇总

```sql
SELECT si.sales_category AS label,
       COALESCE(SUM(si.received::numeric), 0) AS value
FROM sale_items si
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date BETWEEN $startDate AND $endDate
  AND <scope on o.store_id>
  AND si.sales_category IS NOT NULL
GROUP BY si.sales_category
ORDER BY value DESC
```

### SQL 7 — 按一级品项汇总

```sql
SELECT pc.product_kind AS label,
       COALESCE(SUM(si.received::numeric), 0) AS value
FROM sale_items si
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN product_categories pc ON pc.category_id = sk.category_id
WHERE o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date BETWEEN $startDate AND $endDate
  AND <scope on o.store_id>
  AND pc.product_kind IS NOT NULL
GROUP BY pc.product_kind
ORDER BY value DESC
```

### SQL 8 — 按二级品项汇总

```sql
SELECT pc.category_name AS label,
       COALESCE(SUM(si.received::numeric), 0) AS value
FROM sale_items si
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN product_categories pc ON pc.category_id = sk.category_id
WHERE o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date BETWEEN $startDate AND $endDate
  AND <scope on o.store_id>
GROUP BY pc.category_name
ORDER BY value DESC
```

## scope 过滤写法

复用 mgmt-dashboard.js 现有的 scope 子句写法：
- 全部：不加过滤
- 市场：`o.store_id IN (SELECT s.store_id FROM stores s JOIN org_nodes n ON s.org_node_id=n.id WHERE n.parent_id=$marketId AND n.type='门店')`
- 门店：`o.store_id = $storeId`

## 执行顺序

1. 在 `mgmt-dashboard.js` 末尾新增 `case 'salesData':` 分支
2. 实现 `getSalesDataPeriod(period)` helper（可复用已有的 timeWindowPeriod 逻辑）
3. 依次执行 SQL 1–8，组装响应对象
4. 金额用 `parseFloat(val).toFixed(2)` 或现有 formatAmount 工具格式化
5. 品项汇总过滤 value=0 行后返回

## 测试用例

| 场景 | 验证点 |
|------|--------|
| period='month' | startDate=当月1日，endDate=今天 |
| period='lastMonth' | endDate=上月最后一天（非今天） |
| period='year' | startDate=当年1月1日，endDate=今天 |
| 空数据（无订单） | 所有金额返回 '0.00'，品项数组返回 [] |
| scope=store | 只统计指定门店 |
| 小美客无订单 | xiaomeiRevenue='0.00' |

## 性能预估

- SQL 1/3：单表聚合，O(N) where N=当期订单数，快
- SQL 2/4/5：多 JOIN + FILTER 聚合，单次扫描完成三分型，比 3 次分开查更优
- SQL 6–8：含 product_skus + product_categories JOIN，品类表小（百级行），影响可忽略
- 预计 P95 < 500ms（参考 dashboard.summary 800ms 慢查警戒线）
