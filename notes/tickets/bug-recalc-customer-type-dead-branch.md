# Bug: `recalcCustomerType` 死分支 — "体验客"永远不可达

> 生成日期：2026-04-10
> 关联适配计划：`notes/adapt-plans/02-customer-classification.md` §1.5
> 严重级别：低（语义缺陷，无数据损坏）
> 修复归属：不单独发 fix，随顾客类型 5 档重构（§5.2 变更 3）一并消除

---

## 1 位置

- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:92-103`（`recalcCustomerType` 函数）
- `fengyu-client/cloudfunctions/payNotify/index.js:166-177`（支付回调重算镜像，SQL 逐字节一致）

## 2 缺陷代码

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
          SELECT SUM(r.total_amount) FROM sale_orders r
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
  WHEN EXISTS (                              -- ③ 体验客 ⚠ 与 ② 字节级相同
    SELECT 1 FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付','已完成')
      AND sale_order_type = '销售单'
  ) THEN '体验客'
  ELSE '流量客'                              -- ④
END
```

## 3 症状证明

按 PG CASE 短路语义（首个 TRUE 的 WHEN 终止后续求值），真实可达路径仅 3 条：

| 顾客状态 | 命中分支 | 返回值 |
|---|---|---|
| 有销售单 且 ① 达阈值 TRUE | ① | `'会员客'` |
| 有销售单 且 ① 达阈值 FALSE | ② | `'小美客'` |
| 无任何已支付销售单 | ④ | `'流量客'` |

**分支 ③ 永不可达** — ③ 的 EXISTS 为 TRUE 时 ② 必已为 TRUE 并短路；② 为 FALSE 时 ③ 以相同谓词也必 FALSE。

## 4 根因溯源

Migration `db/migrations/0022_customer_type.sql:3-6` 原设计按 `sale_order_type` 区分：

```
-- 体验客：售前体验卡68/99/线上体验等（体验单）
-- 小美客：单笔消费 < 1990 元（普通单）
```

当时 `sale_order_type` 枚举包含 `'体验单'`，③ 分支应当是 `sale_order_type = '体验单'`。

随后 commit `538bf4f refactor(staff): 适配 product_kind + sale_order_type 枚举重构` 把 `sale_order_type` 精简为 `销售单/内部单/回款单/转换单/退款单` 5 值（migrations 0028-0031），**'体验单' 枚举值被删除**。重构时 ③ 分支的 `'体验单'` 字符串被批量 find-replace 成 `'销售单'`，与 ② 变得同构；重构清单漏审"体验客判定"这一条。

## 5 可观测影响

1. **枚举值成僵尸值**
   `customer_type = '体验客'` 不再有任何运行时生产者。`db/schema/enums.ts:64` 保留该枚举值仅供 admin 手工更新或 v0.x 历史数据；新项目零使用。

2. **Admin 筛选恒空**
   `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx:186` 硬编码 `CUSTOMER_TYPES = ["流量客","体验客","小美客","会员客"]`，后台筛选"体验客"结果集永远为空（silent UX 缺陷）。

3. **"只升不降"排序二次保险**
   `order.js:114-121` 与 `payNotify/index.js:188-195` 的排序表 `流量客=0 < 体验客=1 < 小美客=2 < 会员客=3`。即使手工把顾客改为 `'体验客'`，下次 `recalcCustomerType` 触发时：命中"小美客"(2>1) 升级覆盖；命中"流量客"(0<1) 升级失败但语义矛盾。结论：**死分支 + 单向排序 ⇒ `'体验客'` 无法长期存续**。

4. **双处镜像**
   同段 SQL 以拷贝粘贴方式同时存在于 staffApi（店长开单路径）与 payNotify（微信支付回调路径）。任何修复必须两处同步。

## 6 附带语义漂移（一并记录）

Migration 0022 注释写"单笔消费 >= 1990 → 会员客"，但分支 ① 实际 SQL 算的是 `o.total_amount + SUM(回款单 total_amount)`，即"订单款清总额"，既非"单笔"亦非"历史累计"。会议 §2.1 明确"历史累计或单笔消费 ≥ 1990 元"，现状与会议**部分对齐**（单张销售单的订单款清 vs 顾客所有销售单 SUM）。

**结论**：migration 0022 注释已过时，权威语义以会议 §2.1 + §5.2 变更 3 新 SQL 为准。

---

## 7 修复方案

**不单独发 fix**，随顾客类型 5 档（`注册/体验客/流量客/会员/新客`）重构一次性消除。

### 7.1 修改点清单

| # | 文件 | 动作 |
|---|---|---|
| 1 | `db/schema/enums.ts:64` | `customerTypeEnum` 删 `'小美客'`、`'会员客'`，新增 `'注册'`、`'会员'` |
| 2 | `db/schema/user.ts:41` | `customer_type` 默认值 `'流量客'` → `'注册'` |
| 3 | 新迁移 `00XX_customer_type_5tier.sql` | 枚举替换 + 默认值回刷 |
| 4 | `staffApi/routes/order.js:59-124` | 重写 `recalcCustomerType`（见 7.2） |
| 5 | `clientApi/payNotify/index.js:137-198` | 同步镜像（建议抽共享 util） |
| 6 | `staffApi/routes/order.js:362-381` | `'会员客'` → `'会员'` 字面量 |
| 7 | `cronTask/index.js:189` | `'会员客'` → `'会员'` |
| 8 | `db/scripts/calc-monthly-activity.js:94,155,203` | `'会员客'` → `'会员'` |
| 9 | admin `customers-page.tsx:33` + `lib/types.ts` + seed + e2e | 硬编码枚举同步 |
| 10 | staff miniprogram `customer-list.ts:14` | `CustomerType` 联合类型扩展 |

### 7.2 新 `recalcCustomerType` SQL

```sql
SELECT CASE
  -- 会员：历史累计销售单金额 >= 阈值
  WHEN (
    SELECT COALESCE(SUM(total_amount::numeric), 0)
    FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付','已完成')
      AND sale_order_type = '销售单'
  ) >= $2 THEN '会员'
  -- 流量客：有销售单但未达阈值
  WHEN EXISTS (
    SELECT 1 FROM sale_orders
    WHERE client_user_id = $1
      AND status IN ('已支付','已完成')
      AND sale_order_type = '销售单'
  ) THEN '流量客'
  -- 体验客：只买过体验卡，未买过其他销售单
  WHEN EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN products p ON p.product_id = sk.product_id
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付','已完成')
      AND p.product_kind = '体验卡'
  ) THEN '体验客'
  -- 注册：无任何消费
  ELSE '注册'
END AS computed_type
```

"只升不降"新排序：`注册(0) < 体验客(1) < 流量客(2) < 会员(3)`

### 7.3 验证清单

- [ ] 单测 `staffApi/__tests__/routes/order.test.js` 补齐 4 个 case（注册/体验客/流量客/会员）
- [ ] 单测 `staffApi/__tests__/routes/customer.test.js` 枚举固件刷新
- [ ] `admin/actions/customers.test.ts` 枚举固件刷新
- [ ] E2E `admin/e2e/customers.spec.ts`（若存在）筛选断言更新
- [ ] 手工回归：开单支付 → `client_wechat_users.customer_type` 按新规则更新
- [ ] 手工回归：微信支付回调 → payNotify 镜像更新一致
- [ ] 数据校验：`SELECT COUNT(*) FROM client_wechat_users WHERE customer_type IN ('小美客','会员客')` 应为 0（迁移前执行）

### 7.4 修复归属 commit 建议

单独一个 commit：`fix(customer-type): 消除 recalcCustomerType 死分支 + 对齐 5 档新语义`，与结构性枚举变更 commit 独立，便于 cherry-pick 和 review。
