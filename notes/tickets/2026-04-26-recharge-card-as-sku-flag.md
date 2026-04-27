# Ticket: 充值卡判定从 product_kind 字面量改为 product_skus.is_recharge_card capability 列

> 生成日期：2026-04-26
> 实施状态：📝 待实施（设计已定，等本 ticket 评审通过；前置 sale-order-domain-refactor 已于 2026-04-27 完成）
> 严重级别：**P0**（业务规则可演进性 + 充值入账触发正确性 + 跨端 99 处字面量散落）
> 端：db / fengyu-admin / fengyu-staff / fengyu-client / cloudfunctions / cron-worker / payNotify（**全栈**）
> 来源：用户在 SUMMARY.md 决策回访时提出（与体验卡 ticket 同模式 capability 化）
> 前置：[2026-04-26-experience-card-as-sku-flag.md](./2026-04-26-experience-card-as-sku-flag.md)（**同模式平行设计**，建议**晚 1-2 周**实施以分摊风险）
> 前置（已完成）：sale-order-domain-refactor（2026-04-27 完成；saleOrderTypeEnum 5→3，退款/回款改走 sale_order_payments，5 通道退款级联已上线）
> 关联 audit：
> - [audit-14 P0-14-01 admin applyRechargeOnOrderPaid 引用已 DROP store_id](../../docs/audit/audit-14-prepaid-card.md)（本 ticket 顺带修复）
> - [audit-24 P0-24-01 magic string '充值卡'](../../docs/audit/audit-24-product-category-dynamic.md)
> - [audit-04 payNotify 充值入账逻辑](../../docs/audit/audit-04-pay-notify.md)
> - [SCHEMA-CHANGES.md S24-1 capability 列方案](../../docs/audit/SCHEMA-CHANGES.md)
> 一句话目标：把"充值卡"从**分类字面量判定**升级为 SKU 维度的 **`is_recharge_card` boolean capability 列**；充值卡走**单一虚拟 SKU + 金额自由输入**模式；订单结构纯粹（不与普通商品混合）；**复用 client 现有入口**；**购买充值卡参与跃迁会员客判定**（D1=A）。

---

## 0 一句话背景

当前充值卡判定路径与体验卡同模式：
```
sale_item.sku_id → product_skus.category_id → product_categories.product_kind = '充值卡'
```

`product_kind` 是 `text` 字段（admin 可改名）。**99 处** `'充值卡'` 字面量散落在：
- 26 个文件（admin 6 / staff 7 / payNotify 2 / db scripts/migrations 11）
- payNotify `applyRechargeOnOrderPaid` 触发"充值入账"是核心资金路径，目前依赖字面量判定
- staff `routes/card.js`（`rechargeSkus, recharge`）和 admin `(main)/cards`、`(main)/card-transactions` 已有充值卡管理 UI

---

## 1 用户决策汇总（D1-D5）

| # | 决策 | 落地约束 |
|---|------|---------|
| **D1=A** | 购买充值卡 ≥ threshold → 跃迁会员客（充值卡是"普通单"参与跃迁）| 跃迁逻辑：充值卡订单 received 计入"非体验金额" |
| **D2=A 修正** | client 首页和"我的"页**已有充值卡入口** → **复用现有入口**，不新增 UI 入口 | 充值卡购买**仍走 sale_orders 订单逻辑**（不走单独流程）|
| **D3=B** | **单一虚拟 SKU + 金额自由输入**（与现有 `seed-recharge-virtual-product.js` 一致）| product_skus 仅 1 行 is_recharge_card=true 的虚拟 SKU；下单时 `unit_price` = 用户/staff 输入金额 |
| **D4=A** | **充值卡 SKU 严格独立**：充值卡订单 100% 全是充值卡 SKU；普通订单 0 个充值卡 SKU | 下单 API 校验：sale_items 不能同时含 is_recharge_card=true 和 false |
| **D5=B** | **晚于体验卡 1-2 周分开实施** | 体验卡 ticket 第 3 周清理完后启动充值卡 ticket |

---

## 2 设计

### 2.1 核心改动：在 `product_skus` 加 `is_recharge_card boolean` 列

| 列 | 类型 | 默认 | 用途 |
|----|------|------|------|
| `is_recharge_card` | `boolean NOT NULL` | `false` | 标记该 SKU 是否为充值卡 |

> 与体验卡 `is_experience` **正交**：实际业务上 `is_experience` 与 `is_recharge_card` 不会同时为 true；CHECK 约束保护：`CHECK (NOT (is_experience AND is_recharge_card))`

### 2.2 sale_items 行级快照

| 列 | 类型 | 默认 | 用途 |
|----|------|------|------|
| `is_recharge_card` | `boolean NOT NULL` | `false` | 开单时从 `product_skus.is_recharge_card` 快照写入 |

### 2.3 入口（D2=A 修正后）

| 端 | 入口 | 改动 |
|----|------|------|
| **client** | 首页"充值卡"图标 + 我的页"充值卡管理" | **不新增**；现有入口跳转的"充值卡下单页"改为查 `WHERE is_recharge_card = true` 的 SKU（虚拟 SKU 单条）|
| **admin** | `(main)/cards` 充值卡管理页 | 充值入账判定改用 `is_recharge_card`；修复 [audit-14 P0-14-01](../../docs/audit/audit-14-prepaid-card.md) `applyRechargeOnOrderPaid` 已 DROP `store_id` 引用 |
| **staff** | `routes/card.js` `rechargeSkus`/`recharge` | rechargeSkus 改查 `WHERE is_recharge_card = true`；recharge 走标准 order.create + payNotify 路径 |
| **payNotify** | 收到拉卡拉/线下款清回调 | 改用 `WHERE EXISTS sale_items.is_recharge_card = true` 触发充值入账 |

### 2.4 严格独立约束（D4=A）

```sql
-- 在 sale_orders 创建路径上加应用层守卫：
-- INSERT 完 sale_items 后跑校验
SELECT
  bool_and(is_recharge_card) AS all_recharge,
  bool_and(NOT is_recharge_card) AS all_normal
FROM sale_items WHERE sale_order_id = $1;
-- 必须 all_recharge OR all_normal；否则 throw INVALID_PARAMS: MIXED_RECHARGE_NOT_ALLOWED
```

可在 DB 层加触发器强制（推荐第 2 周补）：

```sql
CREATE OR REPLACE FUNCTION check_no_mixed_recharge() RETURNS trigger AS $$
DECLARE has_recharge boolean; has_normal boolean;
BEGIN
  SELECT bool_or(is_recharge_card), bool_or(NOT is_recharge_card)
    INTO has_recharge, has_normal
  FROM sale_items WHERE sale_order_id = NEW.sale_order_id;
  IF has_recharge AND has_normal THEN
    RAISE EXCEPTION 'MIXED_RECHARGE_NOT_ALLOWED: sale_order_id=%', NEW.sale_order_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
```

### 2.5 跃迁规则（D1=A 落地）

充值卡订单参与"会员客阈值判定"，与体验卡 ticket §1.4 协调后：

```
order_amount_for_transition = SUM(sale_items.received WHERE is_experience = false)
# 注意：充值卡 SKU is_experience = false → 充值卡 received 自动计入
order_trial_amount = SUM(sale_items.received WHERE is_experience = true)

if order_amount_for_transition >= threshold:
    new_type = '会员客'   # 充值卡 5000 ≥ threshold → 会员客 ✓
elif order_amount_for_transition > 0:
    new_type = '小美客'   # 充值卡 500 < threshold → 小美客
elif order_trial_amount > 0:
    new_type = '体验客'

# 客户分类只升不降：取 max(current_type, new_type)
```

> **二次消费保护**：顾客用储值卡余额抵扣后续普通订单时，那个订单的 received 仍 ≥ threshold 也只会触发 max 比较，已是会员客的不会再升。spending_tier（BI 报表）累计金额可能双倍计算（5000 充值 + 5000 余额抵扣消费 = received 总和 10000），属 BI 口径漂移，不阻断业务，留 P2。

---

## 3 Schema 变更

### 3.1 DDL

```sql
-- L0-1: product_skus 加 capability 列
ALTER TABLE product_skus
  ADD COLUMN is_recharge_card boolean NOT NULL DEFAULT false;

-- L0-2: 与 is_experience 互斥 CHECK（前置：体验卡 ticket 已落地 is_experience 列）
ALTER TABLE product_skus
  ADD CONSTRAINT chk_sku_not_both_capabilities
  CHECK (NOT (is_experience AND is_recharge_card));

-- L0-3: 数据回填（双轨过渡，从 product_kind 推导）
UPDATE product_skus ps
SET is_recharge_card = true
WHERE EXISTS (
  SELECT 1 FROM product_categories pc
  WHERE pc.category_id = ps.category_id
    AND pc.product_kind = '充值卡'
);

-- L0-4: sale_items 加快照列
ALTER TABLE sale_items
  ADD COLUMN is_recharge_card boolean NOT NULL DEFAULT false;

-- L0-5: 历史订单快照回填
UPDATE sale_items si
SET is_recharge_card = true
WHERE EXISTS (
  SELECT 1 FROM product_skus ps
  WHERE ps.sku_id = si.sku_id
    AND ps.is_recharge_card = true
);

-- L0-6: 索引（payNotify 触发充值入账查询）
CREATE INDEX idx_sale_items_recharge
  ON sale_items(sale_order_id)
  WHERE is_recharge_card = true;

-- L0-7: 严格独立约束（应用层 + 第 2 周补 DB 触发器）
-- 见 §2.4
```

### 3.2 不动的部分

- `product_categories.product_kind` **保留** 作为商品组织维度（admin 后台分类管理仍用）
- `productKindEnum` 4 值保留
- `prepaid_cards` 表结构不动（balance / userId / cardId）
- `card_transactions` 表结构不动（type / amount / refOrderId）

### 3.3 双轨过渡 → 单源切换

| 阶段 | product_kind = '充值卡' | product_skus.is_recharge_card |
|------|------------------------|------------------------------|
| 第 1 周（双轨）| 仍为权威源 | 由触发器自动从 product_kind 同步 |
| 第 2 周（切换）| 降为分类标签 | 升为业务权威源；payNotify 充值入账触发用 is_recharge_card；staff/admin/client 全部改用 capability 列 |
| 第 3 周（清理）| 字面量 99 处 grep 验证 0 残留 | 唯一权威；DB 加 mixed CHECK 触发器 |

**双轨期同步触发器**（仅第 1 周用，可与体验卡 ticket §2.3 触发器合并为一个）：

```sql
CREATE OR REPLACE FUNCTION sync_sku_capabilities() RETURNS trigger AS $$
BEGIN
  UPDATE product_skus
  SET is_experience    = (NEW.product_kind = '体验卡'),
      is_recharge_card = (NEW.product_kind = '充值卡')
  WHERE category_id = NEW.category_id;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_sku_capabilities
  AFTER UPDATE OF product_kind ON product_categories
  FOR EACH ROW EXECUTE FUNCTION sync_sku_capabilities();
```

---

## 4 三端代码改动

### 4.1 admin（fengyu-admin/src）

| 文件 | 当前 | 改后 |
|------|------|------|
| `app/(main)/cards/*` | 充值卡管理页（按 product_kind 显示）| 充值卡列表查 `is_recharge_card = true`；管理 SKU 充值卡属性时弹"充值卡 SKU 严格独立"提示 |
| `app/(main)/card-transactions/*` | 流水查询 | 不变（流水按 cardId 维度，与本 capability 无关）|
| `app/(main)/orders/_components/order-create-page.tsx` | `PRODUCT_KIND_CHOICES` 含 '充值卡' 字面量 | 改为按 `is_recharge_card` 切 Tab；同时校验"严格独立"D4 |
| `actions/orders.ts` | createOrder 中 `'充值卡'` 字面量 + applyRechargeOnOrderPaid 引用已 DROP `store_id` | 改用 `si.is_recharge_card`；**修复 audit-14 P0-14-01**：移除 `store_id` 引用，改用 `prepaid_cards.user_id` 单 UNIQUE |
| `actions/cards.ts` | 充值卡相关 | 改用 `is_recharge_card` |
| `actions/products.ts` | createCategory/updateCategory 维护 product_kind | 增 `is_recharge_card` checkbox（与 `is_experience` 互斥校验）|
| `lib/product-kind.ts` | 暴露 `'充值卡'` 字面量常量 | 暴露 `isRechargeCardSku(sku)` helper |
| `db/seed.ts` | 充值卡虚拟 SKU 种子按 product_kind | 加 `is_recharge_card: true`（与 `seed-recharge-virtual-product.js` 同步）|
| `actions/products.test.ts` / `cards.test.ts` / `__tests__/products-getProductsByKind.test.ts` | mock '充值卡' 字面量（**audit-CC9 反向锁死警告**）| 改 mock `is_recharge_card: true` |

### 4.2 staff（fengyu-staff/cloudfunctions/staffApi）

| 文件 | 当前 | 改后 |
|------|------|------|
| `routes/card.js` `rechargeSkus` | 查 product_kind='充值卡' | `WHERE is_recharge_card = true`（D3=B 单虚拟 SKU 仍返回 1 行）|
| `routes/card.js` `recharge` | 创建充值订单 | 走 standard order.create 路径 + 写 sale_items(is_recharge_card=true) |
| `routes/order.js` | shopInit 用 `CARD_PRODUCT_KINDS = ['充值卡','体验卡']` 排除 + recalc-customer-type SQL 含 '充值卡' 字面量 | shopInit 改用 `WHERE NOT (is_experience OR is_recharge_card)`；recalc-customer-type SQL 改用 `is_experience` + `is_recharge_card`（修复 [audit-CC9 测试反向锁死](../../docs/audit/audit-CC9-test-migration-residue.md)）|
| `routes/product.js` | 同上常量 | 同上 |
| `__tests__/routes/card.test.js` / `product.test.js` / `order.test.js` / `recalc-customer-type-sql.test.js` | mock '充值卡' 字面量 | 改 mock `is_recharge_card: true`；删除测试中 SQL `<> '充值卡'` 字面量断言 |

### 4.3 client（fengyu-client）

| 文件 | 当前 | 改后 |
|------|------|------|
| `cloudfunctions/clientApi/routes/product.js` | shopInit/categories/spuList 不区分充值卡（默认排除）| 默认 `WHERE NOT (is_experience OR is_recharge_card)`；新增（或确认现有）`rechargeCardSku` action 返回单虚拟 SKU |
| `cloudfunctions/clientApi/routes/order.js create` | 标准下单流 | 接受 is_recharge_card 订单 + 校验严格独立 D4 |
| `miniprogram/pages/home/home.{wxml,ts}` | **首页"充值"入口**（`home.wxml:87`）| 跳转目标改为充值卡下单页（金额自由输入）|
| `miniprogram/pages/profile/profile.{wxml,ts}` | **"我的"页"充值卡查看"入口**（`profile.wxml:45`）| 跳转目标改为充值卡余额/流水查看页（如已存在则复用，否则新建）|
| `miniprogram/pages/recharge/*`（按现有命名约定决定保留或新建）| 充值卡下单页 | 表单含金额输入框 → 调 `clientApi.callFunction({action: 'order.create', payload: {skuId: $rechargeVirtualSkuId, amount}})` → 走标准支付流（拉卡拉对接前线上支付不可用，仅支持 staff 代办线下/储值卡抵扣场景）|

### 4.4 payNotify（fengyu-staff/cloudfunctions/payNotify）

> **2026-04-27 更新**：payNotify 当前仍处于 `PAYNOTIFY_DISABLED=true` 状态（D-Q1 决策）。退款流程已随 sale-order-domain-refactor 改为通过 `sale_order_payments`（`change_type='退款'`）处理，不再创建独立的 `sale_order_type='退款单'` 行。本节 payNotify 充值入账触发逻辑不受退款架构变更影响（充值入账是收款方向，退款是反方向）。

| 文件 | 当前 | 改后 |
|------|------|------|
| `index.js` 充值入账段 | `WHERE product_kind = '充值卡'` 字面量判定 | 改用 `WHERE EXISTS (SELECT 1 FROM sale_items WHERE sale_order_id = $1 AND is_recharge_card = true)` |
| `index.js` applyRechargeOnOrderPaid | 引用已 DROP `store_id` 列（与 admin 共用 helper）| **修复 audit-14 P0-14-01**：移除 store_id 引用 |
| `__tests__/index.test.js` | mock '充值卡' 字面量 | 改 mock is_recharge_card |

### 4.5 cron-worker

| 文件 | 当前 | 改后 |
|------|------|------|
| `cron-worker/steps/refresh-customer-type.ts`（与体验卡 ticket §3.4 同名）| 跃迁 SQL JOIN product_categories | 改用 `sale_items.is_experience` + `is_recharge_card` 直接判（与体验卡 ticket 共用 helper）|

### 4.6 db/scripts

| 文件 | 当前 | 改后 |
|------|------|------|
| `db/scripts/seed-recharge-virtual-product.js` | 创建充值卡虚拟 SKU（product_kind='充值卡'）| 直接写 `is_recharge_card: true` |
| `db/scripts/recalc-all-customer-types.js` | 全量重算用 product_kind 字面量 | 改用 `is_experience` + `is_recharge_card`（与跃迁 helper 共用 SQL 模板）|
| `db/scripts/sync-workfine.js` / `phase-a-converge.sql` / `5433-converge.sql` | 历史归档（WorkFine 已停用）| **不动**，归档 |

---

## 5 业务规则配套

### 5.1 充值入账触发链路

```
client/staff 创建充值订单（sale_items.is_recharge_card=true）
  ↓
顾客付款（拉卡拉/线下/储值卡）
  ↓
payNotify 收到回调 OR staff confirmOffline OR admin recordPayment
  ↓
共享 helper applyRechargeOnOrderPaid(saleOrderId, dbClient):
  1. SELECT prepaid_cards.card_id WHERE user_id = $userId（ON CONFLICT DO NOTHING 创建）
  2. UPDATE prepaid_cards SET balance = balance + $amount WHERE card_id = $cardId
  3. INSERT card_transactions(card_id, type='充值', amount=+$amount, ref_order_id=$saleOrderId)
  ↓
共享 helper transitionCustomerType(saleOrderId, dbClient):
  1. 按 §2.5 规则判 new_type，UPDATE customer_type
```

### 5.2 跃迁触发点（与体验卡 ticket §4.1 共用）

| 触发点 | 时机 | 充值卡场景 | 普通商品场景 |
|--------|------|----------|------------|
| payNotify 收到拉卡拉款清 | 线上付款完成 | 充值入账 + 跃迁判 | 仅跃迁判 |
| staff confirmOffline 线下收款 | 店长确认线下到账 | 同上 | 同上 |
| admin recordPayment 后台录入 | 财务补录 | 同上（**修复 audit-15 P0-15-01**）| 同上 |
| saleOrderPayments[退款] 落账 | 退款 | **充值卡退款 → 同事务扣减 prepaid_cards.balance + 写反向 card_transactions(扣款,negative) + 跃迁回退**（与 [Q6.3 历史回滚 epic](../../docs/audit/SUMMARY.md) 一并实施）| 跃迁回退 |

### 5.3 退款联动（充值卡专属）

充值卡订单退款是**资金最敏感场景**：

| 子场景 | 处理 |
|--------|------|
| 充值卡未消费 → 全额退款 | 扣减 prepaid_cards.balance；balance 不能 < 0 |
| 充值卡部分消费后 → 退款 | 业务策略未定（**待 Q6.3 epic 决策**：按已消费比例 vs 全额扣余）|
| 充值卡余额已 < 退款额 | 抛 `INSUFFICIENT_BALANCE: PREPAID_OVERDRAFT_REFUND` |

---

## 6 实施步骤（按层）

> **D5=B 排期**：体验卡 ticket 第 3 周清理完后启动本 ticket。建议时间 **2026-05-17 ~ 2026-06-07**（3 周）。

### 第 1 周（双轨过渡）

- [ ] L0 schema migration `00NN_add_sku_is_recharge_card.sql`：DDL §3.1（不含触发器和 mixed CHECK）
- [ ] L0 与 is_experience 互斥 CHECK（前置：体验卡 ticket 已落地 `is_experience` 列）
- [ ] L0 触发器 `sync_sku_capabilities`（双轨期同步，与体验卡 ticket §2.3 合并）
- [ ] L1 helper `cloudfunctions-shared/apply-recharge-on-order-paid.js` 抽取（admin/staff/payNotify 共用）
- [ ] L1 helper `cloudfunctions-shared/customer-type-transition.js` 跃迁规则更新（§2.5）

### 第 2 周（切换）

- [ ] L3 admin cards / orders / cards.ts / products.ts / lib/product-kind.ts / seed.ts 全部改用 is_recharge_card
- [ ] L3 admin **修复 audit-14 P0-14-01**：applyRechargeOnOrderPaid + createConversionOrder 移除 store_id 引用
- [ ] L3 staff routes/card.js / order.js / product.js 改用 is_recharge_card
- [ ] L3 client miniprogram 现有充值卡入口跳转目标更新（**先 grep 定位**）+ clientApi/routes/product.js 增 rechargeCardSku 接口
- [ ] L3 client/staff/admin order.create 增"严格独立"D4 应用层校验
- [ ] L3 payNotify 充值入账触发改用 is_recharge_card
- [ ] L4 cron-worker / db/scripts/recalc-all-customer-types.js 改用 capability 列
- [ ] L9 spec 更新：backend.pr.spec.md 充值卡章节

### 第 3 周（清理）

- [ ] grep 验证 `'充值卡'` 字面量 99 处全部消除（保留 product_categories 表中分类名作为 UI 展示）
- [ ] DB 加 mixed CHECK 触发器（§2.4）
- [ ] 删除双轨期触发器 `sync_sku_capabilities`（与体验卡 ticket §2.3 同步删除）
- [ ] 删除测试中锁死字面量的反模式（与 audit-CC9 同步整治）

---

## 7 测试要点

### 7.1 单元测试

- 跃迁规则：充值卡订单 ≥ threshold → 会员客；< threshold → 小美客；混合订单（不允许）应抛错
- 充值入账幂等：payNotify 重放、staff/admin 重复确认收款，prepaid_cards.balance 只增一次
- 严格独立 D4：sale_items 含 is_recharge_card=true 与 is_recharge_card=false 混合时抛 `MIXED_RECHARGE_NOT_ALLOWED`
- is_experience 与 is_recharge_card 互斥 CHECK：尝试 INSERT 同时 true 应被 DB 拒绝
- 历史回填正确性：回填后 `count(is_recharge_card=true) = count(JOIN product_kind='充值卡')`

### 7.2 集成测试

- admin 创建充值卡虚拟 SKU 表单含 is_recharge_card checkbox
- staff `recharge` API 创建充值订单（金额自由输入）→ 走 order.create → 写入 sale_items(is_recharge_card=true)
- client 现有充值卡入口可用（先 grep 确认入口位置 + 跳转）
- 退款充值订单 → 余额回退 + 跃迁回退（与 Q6.3 epic 一并测）

### 7.3 反向校验 SQL

```sql
-- 验证 1：双轨期内 is_recharge_card 与 product_kind 一致性
SELECT count(*) FROM product_skus ps
LEFT JOIN product_categories pc USING (category_id)
WHERE (ps.is_recharge_card = true) != (pc.product_kind = '充值卡');
-- 期望：0

-- 验证 2：sale_items 快照
-- (新订单走快照，旧订单回填时直接复制)

-- 验证 3：充值入账完整性 — prepaid_cards.balance = SUM(card_transactions.amount)
SELECT pc.user_id, pc.balance,
       COALESCE((SELECT SUM(amount) FROM card_transactions ct WHERE ct.card_id = pc.card_id), 0) AS calc_balance
FROM prepaid_cards pc
WHERE pc.balance != COALESCE(...);
-- 期望：0 行

-- 验证 4：严格独立 D4
SELECT sale_order_id FROM sale_items
GROUP BY sale_order_id
HAVING bool_or(is_recharge_card) AND bool_or(NOT is_recharge_card);
-- 期望：0 行
```

---

## 8 回滚策略

| 阶段 | 失败场景 | 回滚动作 |
|------|---------|---------|
| 第 1 周 migration | 数据回填错误 | `ALTER TABLE product_skus DROP COLUMN is_recharge_card` + `sale_items` 同操作 |
| 第 2 周代码切换 | 三端有路径漏改 | 重新启用双轨期触发器；admin/staff/payNotify 部分代码可独立回滚 |
| 第 3 周 mixed CHECK 加入 | 历史数据有混合订单（不应该存在但要确认）| 跑验证 SQL #4 看是否有历史混合订单；如有先清洗再加 CHECK |

---

## 9 验收标准

- [ ] DDL §3.1 全部 7 条 migration 落盘 5434/fengyu
- [ ] grep `'充值卡'` 在 fengyu-admin/src + fengyu-staff/cloudfunctions + fengyu-client + payNotify = 0 命中（仅允许在 db/seed.ts / spec / ticket / migration 注释中）
- [ ] payNotify / staff confirmOffline / admin recordPayment 三处充值入账逻辑统一通过共享 helper
- [ ] is_recharge_card 与 is_experience 互斥 CHECK 生效
- [ ] 严格独立 D4 应用层 + DB 触发器双重保护
- [ ] 跃迁规则单元测试 4 场景全绿（含充值卡 ≥ threshold 升会员客）
- [ ] 反向校验 SQL #1/#2/#3/#4 全部 0 行
- [ ] **修复 audit-14 P0-14-01**：applyRechargeOnOrderPaid + createConversionOrder 不再引用 store_id
- [ ] audit-24 P0-24-01 magic string '充值卡' 部分关闭

---

## 10 与其他决策 / ticket 的关系

| 关联项 | 关系 |
|--------|------|
| [体验卡 ticket](./2026-04-26-experience-card-as-sku-flag.md) | **同模式 capability 列**；触发器、跃迁 helper、grep 反模式整治可共用代码；D5=B 错峰实施 |
| [audit-14 P0-14-01](../../docs/audit/audit-14-prepaid-card.md) | 本 ticket §4.1 / §6 第 2 周顺带修复（移除 store_id 引用）|
| [audit-24 S24-1](../../docs/audit/SCHEMA-CHANGES.md) | 本 ticket 是 S24-1 的具体实施方案 |
| [audit-15 P0-15-01](../../docs/audit/audit-15-points-member-level.md) | 本 ticket §5.1 / §5.2 通过共享 helper 修复 admin recordPayment 缺充值入账 |
| [Q6 sale_order_type 重构 epic](../../docs/audit/SUMMARY.md) | 本 ticket 不依赖 Q6；可独立实施。> **2026-04-27 更新**：Q6 sale-order-domain-refactor **已完成**。saleOrderTypeEnum 5→3（`'回款单'`/`'退款单'` 已移除），退款/回款改走 `sale_order_payments`（`change_type='退款'/'回充'`）+ `sale_order_payment_details` 子表。§5.3 充值卡退款现已可直接走 `saleOrderPayments[退款]` 统一流（不再需要单独的退款单 sale_order 行）。`paymentFlowStatusEnum` 新增 `'待审批'` 值用于退款审批。 |
| [Q6.3 历史回滚 epic](../../docs/audit/SUMMARY.md) | 充值卡退款的"已部分消费"分支留待 Q6.3 决策（按比例 vs 全额扣余）。> **2026-04-27 更新**：Q6.3 的 5 通道退款级联（sale_allocations / service_commissions / user_coupons / point_transactions / pickup_records）已在 domain refactor 中落地，充值卡退款可复用此级联基础设施。 |

---

## 11 关联重构完成记录

> **2026-04-27 更新**：sale-order-domain-refactor 已完成并落地（migration 0019+0021 applied）。
> - saleOrderTypeEnum 从 5 值缩减为 3 值（`'销售单'`, `'内部单'`, `'转换单'`）；`'回款单'` / `'退款单'` 已移除，退款/回款改走 `sale_order_payments`（`change_type='退款'/'回充'`）。
> - `sale_order_payment_details` 子表已创建（operator, note, refund_reason, audit info 等字段从 sale_order_payments 拆出为 1:1 子表）。
> - `paymentFlowStatusEnum` 新增 `'待审批'` 值用于退款审批流。
> - 5 通道退款级联已上线：sale_allocations(is_void=true)、service_commissions(voided_at)、user_coupons(restored)、point_transactions(reverse)、pickup_records(rolled back)。
> - `sale_order_payments` 不再有 `operator_employee_id` / `note` 列（移至 `sale_order_payment_details` 子表）。
> - 对本 ticket 影响：§5.3 充值卡退款可直接走 `sale_order_payments[退款]` + 退款级联基础设施；不再需要独立的退款单 sale_order 行。payNotify 仍 `PAYNOTIFY_DISABLED=true`，充值入账触发逻辑不受影响。

---

## 12 一句话总结

**`product_skus.is_recharge_card` boolean 列**取代 `product_categories.product_kind = '充值卡'` 字面量 + **`sale_items.is_recharge_card` 行级快照**支撑跃迁/对账 + **D3=B 单虚拟 SKU 金额自由输入** + **D4=A 严格独立**（CHECK 触发器双层保护）+ **D2=A 复用 client 现有入口**（充值仍走 sale_orders）+ **D1=A 购买充值卡参与跃迁会员客判定** + 共享 helper 收敛 4 端充值入账副本。3 周双轨过渡，影响 26 文件 99 字面量 + 三端 + cron + payNotify。**晚于体验卡 ticket 1-2 周实施（D5=B）。**
