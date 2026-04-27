# Ticket: 体验卡判定从 product_kind 字面量改为 product_skus.is_experience capability 列

> 生成日期：2026-04-26
> 实施状态：🟡 进行中（2026-04-26 完成 Round 1：schema + 三端核心代码迁移；新页面/cron-worker/payNotify 共享 helper defer 至 Round 2）

## 实施进度（2026-04-26 Round 1）

✅ **db schema + migration 0017_tidy_rage**
- `product_skus.is_experience boolean NOT NULL DEFAULT false` + 部分索引
- `sale_items.is_experience boolean NOT NULL DEFAULT false`
- 末尾追加历史数据回填 UPDATE（从 product_kind='体验卡' 推导 + sale_items 反向回填）
- 临时 PG 空库 apply 验证通过

✅ **admin（10 文件）**
- `lib/product-kind.ts` 加 isExperienceSku helper
- `lib/types.ts` ProductSku 加 isExperience 字段
- `actions/products.ts` getAllSkus / getSkuById / getSkusByProductId / createSku / updateSku 全链路加 isExperience；getProductsByKind 体验卡分支按 isExperience 过滤
- `actions/orders.ts` createOrder/createConversionOrder 写入 sale_items.is_experience 快照
- `actions/cards.ts` getCustomerHeldCards 改读 saleItems.isExperience（不再 JOIN product_categories）
- `app/(main)/orders/_components/order-create/types.ts` + `trial-card-picker.tsx` + `prepaid-card-picker.tsx` + `order-create-page.tsx` 适配
- `db/seed.ts` 新增体验卡分类种子 + 2 条体验卡 SKU（isExperience: true）
- `actions/cards.test.ts` mock 改 isExperience: true
- 测试结果：884 全绿；本轮零新增 tsc 错误（剩余 25 个错误属并行 sale-order-domain-refactor）

✅ **staff（5 文件）**
- `routes/product.js` shopInit/skuList SQL 加 `is_experience = false` + 输出 isExperience 字段
- `routes/order.js` create/createConversion/createRefund 全部 INSERT sale_items 含 is_experience 快照
- `utils/refund.js` buildRefundDetails 镜像 is_experience
- `__tests__/routes/product.test.js` + `order.test.js` 新增/更新断言
- 测试结果：910 全绿（baseline 908，新增 4）

✅ **client cloudApi（4 文件）**
- `routes/product.js` SKU_VALID_FILTER 默认排除 is_experience；新增 experienceCardList action（按 sortOrder 返回体验卡 SKU）
- `index.js` 路由表注册 product.experienceCardList
- `routes/order.js` order.create 写入 sale_items.is_experience 快照
- `__tests__/routes/product.test.js` 新增 experienceCardList 3 测试
- 测试结果：340 pass / 9 skip（含新增 3）

⚠️ **payNotify 跃迁 SQL** 当前用 `pc_parent.is_card_kind = true AND pc_parent.category_name <> '充值卡'` 间接识别体验卡（capability 列模式），不是 `product_kind = '体验卡'` 字面量；本轮保持不动，跃迁 SQL 整体迁移到 `sale_items.is_experience` 留 Round 2 处理（与 §4.2 共享 helper 一并）

## 范围外（Round 2 待评审）

- ⏳ **client miniprogram 体验卡入口/列表/详情/独立购物车页** — 需 UI 设计对齐（§3.3 后半 + §10 C2/C5）
- ⏳ **cron-worker（不存在）+ refresh-customer-type 跃迁 SQL 迁移** — 需先确认 cron-worker 部署模式
- ⏳ **cloudfunctions-shared/customer-type-transition.js 共享 helper** — 跨云函数共享方案需确认（与 audit-15 P0-15-02 副本收敛 epic 协同）
- ⏳ **payNotify / staff confirmOffline / admin recordPayment 三处接入共享 helper** — 依赖上一项
- ⏳ **测试反向锁死字面量整治**（与 audit-CC9 同步） — `__tests__/routes/mgmt-product.test.js` 仍含 product_kind='体验卡' GROUP BY 维度（非业务判定，但建议后续解耦）


> 严重级别：**P0**（业务规则可演进性 + 客户分类跃迁正确性）
> 端：db / fengyu-admin / fengyu-staff / fengyu-client / cloudfunctions / cron-worker（**全栈**）
> 来源：用户在 SUMMARY.md 决策回访时提出（替代 D-Q5-2026-04-26 中"product_kind='体验卡'"的判定方式）
> 前置：[2026-04-26-审计 SUMMARY](../../docs/audit/SUMMARY.md) §5.1 D-Q5 / §5.2 Q5.1 / Q5.2
> 关联重构：sale-order-domain-refactor（2026-04-27 已完成，见 §9 备注）
> 关联 audit：[audit-10 P0-10-06](../../docs/audit/audit-10-customer-member-level.md)、[audit-15 P0-15-04/05](../../docs/audit/audit-15-points-member-level.md)、[audit-24 magic string '充值卡'](../../docs/audit/audit-24-product-category-dynamic.md)（**同模式问题**）
> 一句话目标：把"体验卡"从**分类字面量判定**升级为 SKU 维度的 **`is_experience` boolean capability 列**，物理隔离体验卡 SKU 与普通商品 SKU；client 端独立入口，order 行级快照，跃迁规则按 SKU 行级聚合。

---

## 0 一句话背景

当前体验卡判定路径：
```
sale_item.sku_id → product_skus.category_id → product_categories.product_kind = '体验卡'
```

`product_kind` 是 `product_categories.product_kind text` 字段（不是 pgEnum），admin 可改名（已在 [audit-24 P0-24-01](../../docs/audit/audit-24-product-category-dynamic.md) 提出）。改名瞬间击穿：
- 客户分类跃迁（体验客 / 小美客 / 会员客 判定）
- staff `CARD_PRODUCT_KINDS = ['充值卡','体验卡']` 字面量常量（[P1-24-03](../../docs/audit/audit-24-product-category-dynamic.md)）
- admin trial-card-picker 选择器（11 个文件 41 处字面量散落）

---

## 1 设计决策（来自用户）

### 1.1 核心改动：在 `product_skus` 加 `is_experience boolean` 列

| 列 | 类型 | 默认 | 用途 |
|----|------|------|------|
| `is_experience` | `boolean NOT NULL` | `false` | 标记该 SKU 是否为体验卡 |

> **为什么放 `product_skus` 而不是 `products`**：体验卡的核心特征是"低价单次体验拉新"，是 SKU 级粒度（同一个 product 可能有 SKU=体验装 + SKU=正装两个规格），不是 product 级。

### 1.2 入口物理隔离

| 端 | 当前 | 改后 |
|----|------|------|
| **admin 开单** | `trial-card-picker.tsx` JOIN `product_categories.product_kind = '体验卡'` | 直接 `WHERE is_experience = true`，零 JOIN |
| **staff 开单** | shopInit 用 `CARD_PRODUCT_KINDS` 常量排除 | shopInit 排除 `is_experience = true OR is_recharge_card = true`（与 audit-24 S24-1 双 capability 列同步落地） |
| **client 商城** | 体验卡 SKU 与普通 SKU 混在 `categories/spuList`（实际 client 端从未展示体验卡）| 商城接口默认 `WHERE is_experience = false` |
| **client 体验卡入口** | 无 | 首页轮播图下方新增"体验卡"图标 → 进入独立列表页（仅展示 `is_experience = true` 的 SKU） |
| **client 加购** | N/A | 体验卡走独立购物流，**不与商城购物车合并** |

### 1.3 订单行级快照（`sale_items.is_experience`）

| 列 | 类型 | 默认 | 用途 |
|----|------|------|------|
| `is_experience` | `boolean NOT NULL` | `false` | 开单时从 `product_skus.is_experience` 快照写入 |

**理由**：
- 与 `unit_price` / `unit_real_price` 快照同模式（real.md #2 价格快照不可变）
- admin 后续修改 `product_skus.is_experience`（如把某 SKU 从体验卡改成普通商品）不影响历史订单
- 跃迁 SQL 直接 `WHERE si.is_experience = true`，零 JOIN，性能最优

### 1.4 跃迁规则配套（回答 Q5.1 / Q5.2）

```
order_non_trial_amount = SUM(sale_items.received WHERE is_experience = false)
order_trial_amount    = SUM(sale_items.received WHERE is_experience = true)

if order_non_trial_amount >= threshold:
    new_type = '会员客'
elif order_non_trial_amount > 0:
    new_type = '小美客'
elif order_trial_amount > 0:
    new_type = '体验客'
# 客户分类只升不降（cron 内手动操作除外）：取 max(current_type, new_type)
```

**关键**：
- **混合订单**（体验卡 + 普通商品）按"非体验部分总额"判跃迁（方案 B）— 体验卡部分仅当订单非体验 = 0 时才走"体验客"通道
- 这条规则**与本 ticket 引入的 `sale_items.is_experience` 快照天然契合**

---

## 2 Schema 变更

### 2.1 DDL

```sql
-- L0-1: product_skus 加 capability 列
ALTER TABLE product_skus
  ADD COLUMN is_experience boolean NOT NULL DEFAULT false;

-- L0-2: 数据回填（双轨过渡阶段，从现有 product_categories.product_kind 推导）
UPDATE product_skus ps
SET is_experience = true
WHERE EXISTS (
  SELECT 1 FROM product_categories pc
  WHERE pc.category_id = ps.category_id
    AND pc.product_kind = '体验卡'
);

-- L0-3: sale_items 加快照列
ALTER TABLE sale_items
  ADD COLUMN is_experience boolean NOT NULL DEFAULT false;

-- L0-4: 历史订单快照回填（一次性，仅运行一次）
UPDATE sale_items si
SET is_experience = true
WHERE EXISTS (
  SELECT 1 FROM product_skus ps
  WHERE ps.sku_id = si.sku_id
    AND ps.is_experience = true
);

-- L0-5: 索引（client 端独立入口列表查询性能）
CREATE INDEX idx_product_skus_is_experience
  ON product_skus(is_experience)
  WHERE is_experience = true;
```

### 2.2 不动的部分

- `product_categories.product_kind` **保留**作为商品组织维度（admin 后台分类管理仍用），但**不再驱动跃迁逻辑**
- `productKindEnum` (4 值) **保留** — 是商品组织维度，不删
- `productTypeEnum` (疗程卡/单品/家居产品) **保留** — 是商品形态维度，与是否体验卡正交

### 2.3 双轨过渡 → 单源切换

| 阶段 | product_kind = '体验卡' | product_skus.is_experience |
|------|------------------------|---------------------------|
| 第 1 周（双轨）| 仍为权威源 | 由触发器自动从 product_kind 同步 |
| 第 2 周（切换）| 降为分类标签（admin 可改名）| 升为业务权威源；所有跃迁/排除/列表 SQL 改用 is_experience |
| 第 3 周（清理）| 字面量 41 处 grep 验证 0 残留 | 唯一权威 |

**双轨期同步触发器**（仅第 1 周用，切换后删除）：

```sql
CREATE OR REPLACE FUNCTION sync_sku_is_experience() RETURNS trigger AS $$
BEGIN
  UPDATE product_skus
  SET is_experience = true
  WHERE category_id = NEW.category_id
    AND NEW.product_kind = '体验卡';
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_sku_is_experience
  AFTER UPDATE OF product_kind ON product_categories
  FOR EACH ROW EXECUTE FUNCTION sync_sku_is_experience();
```

---

## 3 三端代码改动

### 3.1 admin（fengyu-admin/src）

| 文件 | 当前 | 改后 |
|------|------|------|
| `app/(main)/orders/_components/order-create/trial-card-picker.tsx` | JOIN product_categories WHERE product_kind='体验卡' | `WHERE ps.is_experience = true` |
| `app/(main)/orders/_components/order-create-page.tsx` | `PRODUCT_KIND_CHOICES` 含 '体验卡' 字面量 | 改为按 `is_experience` 切 Tab |
| `actions/orders.ts` | createOrder 中 `'体验卡'` 字面量比较 | `si.is_experience` 字段判 |
| `actions/products.ts` | createCategory/updateCategory 维护 product_kind | 增 `is_experience` 字段编辑（admin 商品创建/编辑表单加 checkbox）|
| `actions/cards.ts` | 充值卡相关（与体验卡共用 magic string）| 解耦：充值卡用 `is_recharge_card`（参考 audit-24 S24-1）|
| `lib/product-kind.ts` | 暴露 `'体验卡'` 字面量常量 | 暴露 `isExperienceSku(sku)` helper（读 is_experience 列）|
| `db/seed.ts` | 种子数据按 product_kind 分类 | 体验卡 SKU 种子加 `is_experience: true` |
| `actions/products.test.ts` / `cards.test.ts` / `__tests__/products-getProductsByKind.test.ts` | 测试 mock '体验卡' 字面量 | 改 mock `is_experience: true`（注意 audit-24 / audit-CC9 反向锁死警告：测试不应锁死字面量）|

### 3.2 staff（fengyu-staff/cloudfunctions/staffApi）

| 文件 | 当前 | 改后 |
|------|------|------|
| `routes/product.js` | `CARD_PRODUCT_KINDS = ['充值卡','体验卡']` 常量 + shopInit 排除 | shopInit 改用 `WHERE NOT (is_experience OR is_recharge_card)` |
| `__tests__/routes/product.test.js` / `mgmt-product.test.js` / `order.test.js` | mock '体验卡' 字面量 | 改 mock `is_experience: true` |

### 3.3 client（fengyu-client/cloudfunctions/clientApi + miniprogram）

| 文件 | 当前 | 改后 |
|------|------|------|
| `cloudfunctions/clientApi/routes/product.js` | shopInit/categories/spuList 不区分体验卡（实际未展示）| 默认 `WHERE is_experience = false`；新增 `experienceCardList` action `WHERE is_experience = true` |
| `miniprogram/pages/index/index.{wxml,ts}` | 轮播图 + 商城商品流 | 轮播图下方新增"体验卡"图标入口 |
| `miniprogram/pages/experience-card/*`（新建）| — | 体验卡列表页 + 详情页 + 加购独立购物车 |
| `miniprogram/pages/order/order-create-page.ts` | 商城购物车 → 下单 | 体验卡走独立下单流（不合并普通商品购物车，**SKU mix 由产品决策**）|

### 3.4 cron-worker

| 文件 | 当前 | 改后 |
|------|------|------|
| `cron-worker/steps/refresh-customer-type.ts`（新建或迁移现有逻辑）| 跃迁 SQL JOIN product_categories | 改用 `sale_items.is_experience` 直接判 |
| `cron-worker/steps/refresh-member-levels.ts` | `WHERE customer_type='会员客'` | 不变（业务设计正确）|

### 3.5 payNotify

| 文件 | 当前 | 改后 |
|------|------|------|
| `payNotify/index.js` | 收款回调触发跃迁 SQL（90 行重复副本）| 抽 `cloudfunctions-shared/customer-type-transition.js`（与 staff/admin 共用，配合 audit-15 P0-15-02 副本收敛 epic）|

---

## 4 业务规则配套

### 4.1 跃迁触发点（4 处）

| 触发点 | 时机 | 改动 |
|--------|------|------|
| 1. payNotify 收到拉卡拉款清 | 线上付款完成 | 调用共享 `transitionCustomerType(saleOrderId)` |
| 2. staff confirmOffline 线下收款 | 店长确认线下到账 | 同上 |
| 3. admin recordPayment 后台录入 | 财务补录 | 同上（**修复 audit-15 P0-15-01 admin 三资金触发点全无 settlePoints**）|
| 4. saleOrderPayments[退款] 落账 | 退款使原本达标的订单跌破阈值 | 调用 `revertCustomerType(saleOrderId)`（**与 Q6.3 历史回滚 epic 一并实施**）|

### 4.2 共享 helper（cloudfunctions-shared/）

```js
// transitionCustomerType.js
async function transitionCustomerType(saleOrderId, dbClient) {
  const { rows } = await dbClient.query(`
    SELECT
      so.client_user_id,
      cwu.customer_type AS current_type,
      SUM(si.received) FILTER (WHERE NOT si.is_experience) AS non_trial_amount,
      SUM(si.received) FILTER (WHERE     si.is_experience) AS trial_amount
    FROM sale_orders so
    JOIN sale_items si ON si.sale_order_id = so.sale_order_id
    JOIN client_wechat_users cwu ON cwu.user_id = so.client_user_id
    WHERE so.sale_order_id = $1
    GROUP BY so.client_user_id, cwu.customer_type
  `, [saleOrderId]);

  // ... 按 §1.4 算法判 new_type，UPDATE customer_type
}
```

---

## 5 实施步骤（按层）

### 第 1 周（双轨过渡）

- [ ] L0 schema migration `00NN_add_sku_is_experience.sql`：DDL §2.1（含历史回填）
- [ ] L0 触发器 `sync_sku_is_experience`（双轨期同步）
- [ ] L1 helper `cloudfunctions-shared/customer-type-transition.js` 抽取
- [ ] L1 helper `db/helpers/product-kind.ts` 加 `isExperienceSku()`
- [ ] **不动业务代码**，新代码可读 is_experience，旧代码继续读 product_kind

### 第 2 周（切换）

- [ ] L3 admin trial-card-picker / order-create-page / orders / products / cards 全部改用 is_experience
- [ ] L3 staff product.js shopInit 改用 is_experience + is_recharge_card 双 capability
- [ ] L3 client experienceCardList 接口 + 体验卡入口页 + 列表页
- [ ] L4 cron-worker 跃迁 SQL 改用 is_experience
- [ ] L4 payNotify / staff confirmOffline / admin recordPayment 三处接入共享 helper
- [ ] L9 spec 更新：backend.pr.spec.md 跃迁规则章节 + schema docstring

### 第 3 周（清理）

- [ ] grep 验证 `'体验卡'` 字面量 41 处全部消除（保留 product_categories 表中的分类名作为 UI 展示）
- [ ] 删除双轨期触发器 `sync_sku_is_experience`
- [ ] 删除测试中锁死字面量的反模式（与 audit-24 / audit-CC9 同步整治）

---

## 6 测试要点

### 6.1 单元测试

- 跃迁规则 4 场景：纯体验卡订单 / 纯普通订单（达标）/ 纯普通订单（不达标）/ 混合订单（按非体验部分判）
- `is_experience` 快照不可变：开单后改 `product_skus.is_experience` 不影响 `sale_items.is_experience`
- 历史回填正确性：回填后 `count(is_experience=true) = count(JOIN product_kind='体验卡')`

### 6.2 集成测试

- admin 创建/编辑 SKU 表单含 is_experience checkbox
- client 首页能看到体验卡入口；点击进入列表展示且仅展示 is_experience SKU
- staff 开单流不出现体验卡 SKU（除非是体验客后续转化场景，由产品决策）

### 6.3 E2E 测试

- 顾客通过体验卡入口下单 → 体验客
- 体验客后续在 staff 端被开单（普通商品）→ 跃迁到小美客或会员客
- 退款已达标订单 → 跃迁回退（**等 Q6.3 epic 落地**）

### 6.4 反向校验 SQL

```sql
-- 验证 1：双轨期内 is_experience 与 product_kind 一致性
SELECT count(*) FROM product_skus ps
LEFT JOIN product_categories pc USING (category_id)
WHERE (ps.is_experience = true)  != (pc.product_kind = '体验卡');
-- 期望：0

-- 验证 2：sale_items 快照与当时 product_skus 一致性（仅历史快照）
-- （新订单走快照，旧订单回填时直接复制当时状态）

-- 验证 3：跃迁正确性（修复后跑）
WITH expected AS (
  SELECT
    cwu.user_id,
    CASE
      WHEN MAX(CASE WHEN NOT si.is_experience THEN si.received END)
           OVER (PARTITION BY cwu.user_id) >= [threshold]
        THEN '会员客'
      ...
    END AS expected_type
  FROM ...
)
SELECT count(*) FROM expected
WHERE expected_type != cwu.customer_type;
-- 期望：0（如有 N>0 → 跃迁触发路径漏写）
```

---

## 7 回滚策略

| 阶段 | 失败场景 | 回滚动作 |
|------|---------|---------|
| 第 1 周 migration | 数据回填错误 | `ALTER TABLE product_skus DROP COLUMN is_experience` + `sale_items` 同操作 |
| 第 2 周代码切换 | 三端有路径漏改 | 重新启用双轨期触发器；admin/staff 部分代码可独立回滚（cloudfunctions 部署版本）|
| 第 3 周清理 | grep 没扫干净 | 不删触发器，继续维护双轨 |

---

## 8 验收标准

- [ ] DDL §2.1 全部 5 条 migration 落盘 5434/fengyu
- [ ] grep `'体验卡'` 在 fengyu-admin/src + fengyu-staff/cloudfunctions + fengyu-client/cloudfunctions = 0 命中（仅允许在 db/seed.ts / spec / ticket / migration 注释中存在）
- [ ] client 首页可见体验卡入口；点击 → 进入体验卡列表；可下单
- [ ] 跃迁规则单元测试 4 场景全绿
- [ ] 反向校验 SQL #1/#2/#3 全部 0 行
- [ ] audit-10 P0-10-06 / audit-15 P0-15-04 / audit-24 magic string '体验卡' 部分关闭（'充值卡' 部分留给 audit-24 S24-1 ticket）

---

## 9 与其他决策 / ticket 的关系

| 关联项 | 关系 |
|--------|------|
| [SUMMARY.md D-Q5-2026-04-26](../../docs/audit/SUMMARY.md) | 本 ticket **回答** Q5.1（"非体验卡"判定字段 = `is_experience`）+ Q5.2（混合订单按非体验部分总额判）|
| [audit-24 S24-1 充值卡 capability](../../docs/audit/SCHEMA-CHANGES.md) | **平行设计**：本 ticket = `is_experience`；audit-24 = `is_recharge_card`。两者共用"capability 列替代字面量"模式，建议同 epic 实施 |
| [audit-15 P0-15-02 settlePoints 三端副本](../../docs/audit/audit-15-points-member-level.md) | 本 ticket §3.5 / §4.2 共享 helper 是该 P0 的修复路径之一 |
| [Q6 sale_order_type 重构 epic](../../docs/audit/SUMMARY.md) | 本 ticket 与 Q6 **解耦**：is_experience 不依赖 sale_order_type 重构；可独立先实施。> **2026-04-27 更新**：Q6 sale-order-domain-refactor **已完成**。saleOrderTypeEnum 5→3（'回款单'/'退款单' 已移除），退款/回款改走 sale_order_payments（change_type='退款'/'回款'），5 通道退款级联已上线。本 ticket 不受影响，但 Round 2 退款跃迁回退（§4.1 触发点 4）可直接使用新的 sale_order_payments 退款流程。 |
| [audit-CC9 测试反向锁死](../../docs/audit/audit-CC9-test-migration-residue.md) | 本 ticket §3.1/§3.2 改测试 mock 时一并整治反向锁死反模式 |

---

## 10 待用户确认点

| # | 问题 | 推荐方向 |
|---|------|---------|
| C1 | 体验卡 SKU 是否允许同 product 下与正装 SKU 共存？（同 product，不同 SKU 一个体验一个正装）| 否，在 product 选 SKU 的时候就禁止选体验卡 SKU（不显示选项）|
| C2 | client 体验卡购物车是否与商城购物车物理隔离（不可同单下）| **是**（用户原话"独立入口"暗示）|
| C3 | admin 后台是否允许把已有体验卡 SKU 改回非体验卡？ | 允许，但提示"已有订单的 sale_items 快照不变"|
| C4 | `productKindEnum` 中"体验卡"值是否保留？| 不保留，而且 productKindEnum 本来就要取消，productKind 是 text，存储在数据库，可维护|
| C5 | 体验卡入口是否支持运营配置（admin 后台开关 + 排序）？ | 支持配置，productSkus本来就有 sortOrder 和 isEnabled字段 |

---

## 11 关联重构完成记录

> **2026-04-27 更新**：sale-order-domain-refactor 已完成并落地（migration 0019+0021 applied）。
> - saleOrderTypeEnum 从 5 值缩减为 3 值（`'销售单'`, `'内部单'`, `'转换单'`）；`'回款单'` / `'退款单'` 已移除。
> - 退款/回款改走 `sale_order_payments`（`change_type='退款'/'回充'`）+ `sale_order_payment_details` 子表。
> - 5 通道退款级联已上线：sale_allocations(is_void=true)、service_commissions(voided_at)、user_coupons(restored)、point_transactions(reverse)、pickup_records(rolled back)。
> - `paymentFlowStatusEnum` 新增 `'待审批'` 值用于退款审批流。
> - 本 ticket 客户类型跃迁逻辑（§1.4 基于 `sale_items.is_experience`）**不受影响**——跃迁判据是 SKU 行级字段而非 sale_order_type。
> - Round 2 中退款触发跃迁回退（§4.1 触发点 4）可直接对接新的 `sale_order_payments` 退款流程。

---

## 12 一句话总结

**`product_skus.is_experience` boolean 列**取代 `product_categories.product_kind = '体验卡'` 字面量判定 + **`sale_items.is_experience` 行级快照**支撑跃迁/对账 + **client 端独立入口**物理隔离体验卡与商城商品 + **共享 helper**收敛 4 端跃迁副本。3 周双轨过渡，影响 14 文件 41 字面量 + 三端 + cron + payNotify。
