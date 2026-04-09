# 06 - 优惠券通用模型适配计划

> 依据：
> - `notes/meetings/meeting-20260304/article.md` §八 优惠券体系 ✅
> - `notes/meetings/meeting-20260324/article.md` §十二 优惠券（当前问题 + 二期需求）
>
> 结论速览：**底层通用模型已落地，无需结构性变更**，但：
> 1. 两条 P0 Bug 必须修（有效期语义 + 满减匹配口径）
> 2. `applicable_store_ids` 在后台 UI 被屏蔽（只暴露 applicableMarketIds），与 §八"适用门店"直接矛盾
> 3. `clientApi/routes/order.js` 下单时 **折扣券逻辑完全丢失**（只算现金/品项，不算折扣）
> 4. `clientApi/routes/coupon.js` 的 `redeem` 函数引用不存在的列（`redeem_code` / `max_claims` / `claimed_count`），属于死代码 + 上线即崩
>
> 本文档仅做调研与审计，不修改任何代码。

---

## 1 需求分解

| 要素 | 说明 |
|------|------|
| **变更概念** | 优惠券体系 —— 将 3 类券（现金券 / 品项券 / 折扣券）抽象为统一的"模板 + 用户券"模型 |
| **当前行为** | 三类券已经建模成 `coupon_templates` 单表 + `coupon_type` 枚举，公共字段已抽象；但若干字段在后台不暴露、部分计算分支在云函数中丢失 |
| **期望行为** | 3 类券共用同一张模板表、同一套"满减 + 适用范围 + 适用门店"要素；销售人员可为任意类型配置 `minSpend / applicableCategoryIds / applicableStoreIds`；有效期可按"领取后 N 天"或"固定时段"两种语义配置，且"领取后"语义需真正从发放时间起算 |
| **受影响角色** | 客户 C、美容师/店长 S、管理后台 admin |
| **受影响端** | admin（创建/发放/作废）、clientApi（list/available/redeem/order.create）、staffApi（coupon.available/order.create）、client 前端（checkout / my-coupons）、staff 前端（order-create） |

---

## 2 代码路径追踪

### 2.1 数据库层（`db/schema/coupon.ts`）

**核心结论：底层已是一张通用表，天然支持 3 类券。**

#### 2.1.1 枚举

`db/schema/enums.ts:46-48`：

```ts
couponTypeEnum   = pgEnum('coupon_type',   ['现金券', '品项券', '折扣券'])
couponStatusEnum = pgEnum('coupon_status', ['未使用', '已使用', '已过期'])
```

→ 与 20260304 §八"3 类券"完全对齐。注意：`项目券 → 品项券` 已通过 `manual-applied/0012_coupon_type_rename.sql` 迁移完成。

#### 2.1.2 `coupon_templates`（模板主表）

| 字段 | 类型 | 说明 | 3 券种支持度 |
|---|---|---|---|
| `template_id` | text PK | 模板 ID | 全部通用 |
| `name` | text | 券名 | 全部通用 |
| `coupon_type` | enum | 券种 | 分支判据 |
| `discount_value` | numeric(10,2) | 现金券/品项券=抵扣额；折扣券=折扣率(0~1) | 全部通用 |
| `min_spend` | numeric(10,2) | 满减门槛，0 = 无门槛 | 全部通用 ✅ §八要求 |
| `max_discount` | numeric(10,2) | 折扣券封顶金额 | 仅折扣券 |
| `total_count` | integer | 发放总量上限 | 全部通用 |
| `applicable_product_ids` | text[] | 指定商品 ID 数组，NULL=全部 | 全部通用（细粒度） |
| `applicable_category_ids` | text[] | 指定品项分类数组，NULL=全部 | 全部通用 ✅ §八"适用范围" |
| `applicable_store_ids` | text[] | 适用门店 ID 数组，NULL=全部门店 | 全部通用 ✅ §八"适用门店" |
| `applicable_market_ids` | text[] | 适用市场 ID 数组 | 全部通用（区域扩展） |
| `validity_mode` | text | `'fixed'` 固定日期 / `'days'` 领取后 N 天 | 全部通用 ✅ §十二关键 |
| `valid_from` | timestamp | fixed 模式的起始日 | fixed 模式 |
| `valid_to` | timestamp | fixed 模式的截止日 | fixed 模式 |
| `valid_days` | integer | days 模式：领取后 N 天 | days 模式 |
| `is_active`, `created_at`, `updated_at` | 元数据 | | |

#### 2.1.3 `user_coupons`（用户券实例）

| 字段 | 类型 | 说明 |
|---|---|---|
| `coupon_id` | text PK | 实例 ID |
| `template_id` | FK → coupon_templates | 模板引用 |
| `user_id` | FK → client_wechat_users | 领取人 |
| `status` | enum | 未使用 / 已使用 / 已过期 |
| `expire_at` | timestamp NOT NULL | 领取时写死的到期时间（关键） |
| `used_sale_order_id` | FK → sale_orders | 核销订单 |
| `used_at` | timestamp | 核销时间 |
| `created_at` | timestamp | **实际领取时间** |

> ✅ 索引齐全：`(user_id, status)` / `(used_sale_order_id)` / `(expire_at)`。
> ✅ 发放时已将到期时间写入实例，运行时不依赖模板的 valid_*。

#### 2.1.4 订单侧关联（`db/schema/order.ts`）

`sale_orders.coupon_id` / `sale_orders.coupon_discount`（`0001_wonderful_jasper_sitwell.sql:34-35`）—— 订单冗余快照券 ID 与抵扣金额，便于报表。✅

#### 2.1.5 结论

**通用模型已完整落地：一张 `coupon_templates` + 一张 `user_coupons`，靠 `coupon_type` 枚举分支 + `discount_value` 语义复用字段。** 满减、适用品项分类、适用门店、适用商品、适用市场、有效期（两种语义）全部齐备。3 券种在数据层"统一抽象"的目标已经达成。

⚠️ 细节：`discount_value` 同时承载"金额"和"折扣率"两种语义，对业务理解稍有心智负担，但不需要动字段，在后台输入时做校验即可（实际上 `coupon-create-page.tsx:70-73` 已经做了 `< 1` 的折扣率校验）。

---

### 2.2 后端逻辑层

#### 2.2.1 admin Server Actions —— `fengyu-admin/src/actions/coupons.ts`

**已有接口**：

| 接口 | 行 | 职责 |
|---|---|---|
| `getMarkets` | 20-31 | 拉取市场列表（券作用域选择） |
| `getCategoriesForCoupon` | 37-56 | 拉取品项分类（品项券范围） |
| `getAvailableCoupons` | 62-140 | 下单可用券（admin 开单复用） |
| `getTemplates` / `getTemplateById` | 167-203 | 列表/详情 |
| `createTemplate` | 205-278 | 创建模板 |
| `updateTemplate` | 280-341 | 更新模板（含乐观锁） |
| `toggleTemplateActive` | 343-379 | 启停 |
| `issueCoupon` | 385-456 | 单个发放 |
| `getIssuedCoupons` | 461-488 | 查询发放记录 |
| `batchIssueCoupons` | 494-595 | 批量发放（全有全无） |
| `getCustomersForBatchIssue` | 638-714 | 批量发放顾客列表 |
| `getOrgNodesForBatchIssue` | 720-735 | 组织树（批量发放筛选） |

**覆盖度与需求对比**：

| 20260304 §八 要求 | 现有实现 | 状态 |
|---|---|---|
| 满减条件 | `minSpend` 字段 + `lte(...minSpend..., totalAmount)` | ✅ 有，但有 bug（见 §4.2） |
| 适用范围 | `applicableCategoryIds` / `applicableProductIds` | 部分 ⚠️ `applicableProductIds` 完全没在后台 UI 暴露 |
| 适用门店 | `applicableStoreIds` | ⚠️ **后台 UI 根本没选门店的入口**，只有"适用市场" |
| 3 券种通用 | `couponType` 枚举 + 同表 | ✅ |
| 先出一版让销售用 | 所有基础能力已具备 | ✅ |

**关键问题 1：`applicableStoreIds` 在 Action 层存在，在 UI 层缺失**

- Action `createTemplate` 参数签名 `fengyu-admin/src/actions/coupons.ts:215`：`applicableStoreIds?: string[] | null`
- Schema `fengyu-admin/src/db/seed.ts:302` 使用了 `applicableStoreIds: null`
- 但 `coupon-create-page.tsx` / `coupon-detail-page.tsx` **整个文件没有 `applicableStoreIds` 的状态/表单控件**，只有 `selectedMarketIds / editSelectedMarketIds`。

→ 销售人员在后台无法按门店粒度创建券，只能按"市场"粒度。这直接违背了 §八"适用门店"需求。**必须在 UI 补齐**，或明确"门店 = 市场"的业务共识（不建议）。

**关键问题 2：`applicableProductIds`（按商品粒度）完全闲置**

- Schema 定义了 `applicable_product_ids text[]`
- Action 和 Types 保留了字段
- 但从没在 UI 暴露，也没在 `clientApi/staffApi` 的 `coupon.available` 里参与过滤判据（见 §2.2.2 / §2.2.3）

→ 目前"适用范围"的颗粒只落到"品项分类"。建议要么删除（避免死字段），要么补齐。根据会议"先出一版让销售用"的原则，**建议保留字段但明确文档上只支持"分类"粒度**，后续按反馈再决定是否暴露到商品粒度。

#### 2.2.2 clientApi —— `fengyu-client/cloudfunctions/clientApi/routes/coupon.js`

**暴露接口**：`list`、`available`、`redeem`

`list`（14-86）：
- 懒清扫过期券（`status='未使用' AND expire_at <= NOW()` → `'已过期'`）
- 按 user + 可选 status 查询 + 关联 `coupon_templates`
- 返回适用门店名称（`applicable_store_ids → store_name` 映射）
- ✅ 通用字段齐全

`available`（93-206）：
- 懒清扫过期券
- 解析 storeId（支持 storeName 反查）
- 查询用户可用券：`未使用 AND expire_at > NOW() AND is_active`
- 按 SKU 解析 `category_id`（`product_skus.category_id`，无需 JOIN products）
- 逐券评估：
  - **门店匹配**（`applicable_store_ids` includes storeId）
  - **品项分类匹配**（`applicable_category_ids` 与 SKU category）
  - **满减门槛**（`eligibleTotal >= minSpend`）
  - **抵扣计算**：
    - 现金券/品项券：`min(discountValue, eligibleTotal)`
    - 折扣券：`eligibleTotal × (1 - discountValue)`，可被 `max_discount` 封顶
- 结果按抵扣金额降序
- ✅ 三类券通用；calcCouponDiscount 与 admin `lib/utils.ts:37` 的实现一致

`redeem`（212-299）：**⚠️ 死代码 + 数据库不一致**
- 引用的列 `redeem_code` / `max_claims` / `claimed_count` / `expire_at`（模板级）在 `db/schema/coupon.ts` 中 **都不存在**
- 整个函数依赖这些不存在的列查询 `coupon_templates`，任何调用都会抛 `column "redeem_code" does not exist`
- 但 `clientApi/index.js` 路由表有 `coupon.redeem`，`fengyu-client/CLAUDE.md` 也列出了 redeem
- 历史原因：兑换码功能原本规划过，后被"按手机号批量发放"取代，但这段代码没清理

→ 修复方案二选一：
- **方案 A（推荐）**：删除 `redeem` 函数 + 路由注册，清理前端调用点（若有）
- **方案 B**：补齐 schema 字段（`redeem_code unique`, `max_claims int`, `claimed_count int default 0`，以及模板级到期日），并把 UI/admin 接入。但当前会议没有"兑换码领取"需求，建议不做

#### 2.2.3 staffApi —— `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js`

**暴露接口**：`available`

`available`（13-137）：
- 按 `clientPhone` 反查 `client_wechat_users.user_id`
- 后续逻辑基本复制 clientApi `available`
- ✅ 三类券通用，但**同样不检查 `applicable_product_ids`**（仅检查 category）

两处实现几乎一模一样，存在重复代码风险。后续可抽出到 `cloudfunctions/_shared/` 共享，但不在本次变更范围。

#### 2.2.4 下单核销 —— `routes/order.js`（client / staff）

##### staffApi `order.create`（`fengyu-staff/cloudfunctions/staffApi/routes/order.js:138-470`）

```js
// 行 276-338 — 优惠券处理
if (inputCouponId && clientUserId) {
  // 1. 查券 + 模板（未使用 + 未过期 + 模板启用）
  // 2. 门店匹配（applicable_store_ids includes storeId）
  // 3. 品项分类匹配（applicable_category_ids）
  // 4. 满减门槛检查
  // 5. 按券种计算 couponDiscount：
  //    - 现金券/品项券: min(discountValue, eligibleTotal)
  //    - 折扣券: eligibleTotal * (1 - discountValue)，可封顶
  // 6. 按比例分摊到 eligibleItems.received
}
// 行 400-409 — 事务内原子 claim：
//   UPDATE user_coupons SET status='已使用', used_sale_order_id=..., used_at=NOW()
//   WHERE coupon_id=? AND user_id=? AND status='未使用' AND expire_at > NOW()
```

**3 类券全部处理** ✅。逻辑与 admin `calcCouponDiscount` 一致。

##### clientApi `order.create`（`fengyu-client/cloudfunctions/clientApi/routes/order.js:138-400`）

```js
// 行 237-294 — 优惠券处理
if (inputCouponId) {
  // 1. 查券 + 模板
  // 2. 门店匹配
  // 3. 品项分类匹配
  // 4. 满减门槛检查
  // 5. 计算 couponDiscount：
  if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '品项券') {
    couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
  }
  // ⚠️ 没有 else if 折扣券！折扣券一旦被顾客选中，实际抵扣永远是 0
  couponDiscount = Math.round(couponDiscount * 100) / 100
}
```

**⚠️ P0 Bug**：clientApi `order.create` **缺失折扣券抵扣分支**，导致顾客端选中折扣券后下单实扣 0 元，但券仍被标记为已使用 —— 顾客权益被吞。

对比：
- staffApi `order.create` 的折扣券分支存在（L330-337）
- `coupon.available`（client/staff）的折扣券分支都存在
- `fengyu-admin/src/lib/utils.ts:37` 的 `calcCouponDiscount` 也完整

只有 clientApi `order.create` 这一处缺失，明显是早期实现时的遗漏。

##### 订单取消释放券（`clientApi/routes/order.js:16-24`、`staffApi/routes/order.js:706-710`）

```sql
UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL
WHERE used_sale_order_id=$1
```

✅ 取消/关闭订单时正确回滚券状态。

---

### 2.3 前端渲染层

#### 2.3.1 客户端 —— `fengyu-client`

**我的优惠券列表** `pagesCoupon/my-coupons/my-coupons.wxml`（L64 等）
- 展示 `item.couponType` 文本
- 列表按 status 分 tab
- 只读，未涉及满减/折扣的差异化展示 ✅

**下单结算** `pagesOrder/checkout/checkout.ts`（L58-298、L370）
- `selectedCoupon`, `couponDiscount`, `availableCoupons` 三元数据
- `onOpenCouponPopup` (L251) 调 `coupon.available` 传 `{ storeId, items: [{skuId, quantity, amount}] }`，其中 `amount = price × quantity`（**原价**，未打折）
- `onCouponPick` 选中后 `couponDiscount = discount`（来自后端返回）
- 提交订单时 `couponId: selectedCoupon?.couponId`

→ 前端只透传 couponId，所有计算依赖后端。如果后端（clientApi）折扣券逻辑缺失，前端展示的折扣金额和下单结果会不一致。

**预约创建** —— 未使用优惠券 ✅

#### 2.3.2 员工端 —— `fengyu-staff`

**开单页** `pages/order-create/order-create.ts`（L69-611）
- 结构与客户端 checkout 几乎一致
- L505-520 开券选择，L512 调 `coupon.available` 传 `clientPhone + items`
- L606 提交订单 `couponId`
- ✅ 折扣券分支正确（因为 staffApi/order.create 分支完整）

**服务单/护理** —— 未使用优惠券 ✅

#### 2.3.3 admin

**`coupons-page.tsx`（列表）**
- L28-31 折扣券/现金券面值格式化（`8.5折` vs `¥50.00`）
- L105 `applicableMarketIds?.includes(marketFilter)` 筛选
- L145-165 列展示 "券类型 / 面值 / 满减 / 适用市场"
- ⚠️ 未展示"适用门店"

**`coupon-create-page.tsx`（创建）**
- 表单字段：name / couponType / discountValue / minSpend / maxDiscount / totalCount / validityMode / validDays / validFrom / validTo / applicableCategoryIds / applicableMarketIds / description
- ⚠️ **无 `applicableStoreIds` 控件**
- ⚠️ **无 `applicableProductIds` 控件**
- ✅ 折扣率校验（L70-73）
- ✅ 品项券 only 显示品项分类选择

**`coupon-detail-page.tsx`（详情/编辑）**
- 同样只展示/编辑 categoryIds 和 marketIds，**无 storeIds/productIds**

---

## 3 横切关注点检查

| 检查项 | 状态 |
|---|---|
| 权限模型 | `coupon:list` / `coupon:create` / `coupon:update` 已存在并使用 ✅ |
| 审计日志 | `logOperation('coupon.create'/'coupon.update'/'coupon.issue'/'coupon.batchIssue')` 已接入 ✅ |
| FK 约束 | `user_coupons` 三个 FK 齐全（template / user / sale_order）✅ |
| WorkFine 同步 | 优惠券 is PG-native，不涉及 WorkFine ✅ |
| seed 数据 | `fengyu-admin/src/db/seed.ts:302-304` 有 3 条 seed，含 3 种券类型 ✅ |
| 存量数据迁移 | 本次调整都是逻辑/UI 层，无需迁移 |
| 乐观锁 | `updateTemplate`/`toggleTemplateActive` 使用 `expectedUpdatedAt` ✅ |
| 原子 claim | 下单时 `UPDATE ... WHERE status='未使用' AND expire_at > NOW()` + `rowCount` 校验 ✅ |
| 过期懒清扫 | `coupon.list` / `coupon.available` 进入时 `UPDATE ... SET status='已过期'` ✅ |

---

## 4 待修 Bug（来自 20260324 §十二 + 审计中发现）

### 4.1 [P0] 有效期语义歧义 —— "从发放给顾客的日期开始计算"

**会议原文**：「有效期逻辑需确认：应从发放给顾客的日期开始计算，而非优惠券创建日期」

**审计结论**：数据层 **没有 Bug**，但 `validity_mode = 'fixed'` 时的业务语义需要和销售对齐。

展开分析：

1. **`validity_mode = 'days'` 模式**（领取后 N 天）
   - `issueCoupon`（`fengyu-admin/src/actions/coupons.ts:424-434`）：
     ```ts
     expireAt = new Date()
     expireAt.setDate(expireAt.getDate() + tpl.validDays)
     ```
   - 使用 **当前时间（发放时刻）** + N 天 → ✅ 正确符合会议需求
   - `batchIssueCoupons`（L559-569）同逻辑 ✅

2. **`validity_mode = 'fixed'` 模式**（固定日期区间）
   - `issueCoupon` L428-430：
     ```ts
     else if (tpl.validTo) {
       expireAt = new Date(tpl.validTo)
     }
     ```
   - 使用 **模板配置的 `valid_to`**，而 `valid_to` 是"券创建时"设定的
   - 如果销售理解的"有效期"是"从发放起算 N 天"，就应该用 `days` 模式
   - 如果销售理解的"有效期"是"到某个大促结束日为止"（无论何时发放），`fixed` 模式就是对的

→ **这是个需求澄清问题，不是代码 Bug**。

**建议处理**：
- 方案 A（推荐）：在后台 UI 的 `validityMode` 选项上加浮窗文案说明两种模式语义，销售自己选
- 方案 B：废除 `fixed` 模式，强制所有券都是"领取后 N 天"，避免混淆

**相关代码位置**：
- `fengyu-admin/src/actions/coupons.ts:205-278`（createTemplate）
- `fengyu-admin/src/actions/coupons.ts:280-341`（updateTemplate）
- `fengyu-admin/src/actions/coupons.ts:424-434`（issueCoupon 到期计算）
- `fengyu-admin/src/actions/coupons.ts:559-569`（batchIssueCoupons）
- `fengyu-admin/src/app/(main)/coupons/_components/coupon-create-page.tsx:42-92`

#### 4.1.1 [P0] createTemplate / updateTemplate 有效期校验缺失（fallback 365 天陷阱）

**定性**：上面的 §4.1 是"语义歧义"需求澄清；这里是**实打实的代码 Bug**——"销售在 UI 漏填有效期字段"这个失败路径会被 fallback 兜住，产生非预期的一年有效期，且销售无从察觉。

**失控路径（销售侧看不见的"沉默默认"）**：

```
admin UI 漏填 validDays / validTo
    ↓
coupon-create-page.tsx L52-74 只校验了 name / couponType / discountValue
    ↓
createTemplate (L205-278) 只校验 discountValue 与 validFrom<validTo 顺序
    ↓
DB 里写入 validityMode='days' 但 validDays=NULL
（或 validityMode='fixed' 但 validFrom/validTo 为 NULL）
    ↓
issueCoupon (L424-434)：
  if (validityMode==='days' && validDays) → 跳过（validDays 为 NULL）
  else if (validTo)                        → 跳过（validTo 为 NULL）
  else                                     → fallback：now() + 365 天 ⚠️
    ↓
顾客收到一张 1 年有效的券（销售原以为是 30 天活动券）
```

**前后端校验缺口汇总**：

| 校验项 | 前端 (coupon-create-page.tsx) | 后端 createTemplate | 后端 updateTemplate |
|---|---|---|---|
| validityMode 必填（枚举 days/fixed） | ✅ 默认值 'days'（L42） | ❌ 类型 `string?`，未校验 | ❌ 未校验 |
| days 模式下 validDays 必填 | ❌ 无提示 | ❌ 无校验 | ❌ 无校验 |
| days 模式下 validDays 为正整数 | ⚠️ 只 parseInt（L90），无下限校验 | ❌ 无校验 | ❌ 无校验 |
| days 模式下 validDays 上限合理 | ❌ 无 | ❌ 无 | ❌ 无 |
| fixed 模式下 validFrom 必填 | ❌ 无 | ❌ 无 | ❌ 无 |
| fixed 模式下 validTo 必填 | ❌ 无 | ❌ 无 | ❌ 无 |
| fixed 模式下 validFrom < validTo | ❌ 无 | ✅ L244 已校验 | ❌ 未校验 |
| 模式 → 字段一一对应（其他字段清空） | ✅ L88-90 置 null | ❌ 不校验 | ❌ 不校验 |
| updateTemplate 的部分更新组合一致性 | — | — | ❌ 完全缺失（见下） |

**`updateTemplate` 专属陷阱**：`updateTemplate` 接受 partial data（所有字段 optional），存在 3 类绕过场景：
1. 只传 `validityMode: 'days'`，不传 `validDays`，就把一张原本 `fixed` 模式的券"改空"成"days 模式但无天数"的脏数据
2. 只传 `validDays: null`，把已经合法的 days 模式模板清空，等同失效
3. 把 `validTo` 改到 `validFrom` 之前，现有代码完全不拦（L244 的顺序校验只在 createTemplate 里）

修校验必须同时修 `updateTemplate`，并且要做到"**以合并后状态（DB 现值 + 本次补丁）**为准去判断合法性"，不能只看补丁本身。

**`issueCoupon` fallback 定性**：不是"安全兜底"，而是"把校验缺口伪装成正常流程"的反模式。必须删除（或改为报错 + 告警日志），否则即使前后端校验补齐，历史脏数据仍然会走到 365 天分支。

### 4.2 [P0] 满减券匹配异常 —— "满 500 可用券未正确匹配"

**会议原文**：「满减券适用条件测试异常（满 500 可用券未正确匹配）」

**审计结论**：有两处可疑点。

#### 疑点 ①：`getAvailableCoupons`（admin）的满减比较做了隐式 cast

`fengyu-admin/src/actions/coupons.ts:118`：

```ts
lte(sql`COALESCE(${couponTemplates.minSpend}, '0')::numeric`, totalAmount)
```

- Drizzle 把 `totalAmount`（number）作为参数传递
- 显式 `::numeric` cast，与 number 比较时 PG 内部再转一次
- 没看到明显错误，但如果 `totalAmount` 被 JS 传成字符串（如 `"500"`），PG 可能按字符串比较 `'500' <= '500'`（字符串比较是正确的，但边界值可能翻车）

→ 建议在 `getAvailableCoupons` 入参处加 `Number()` 强制化。

#### 疑点 ②：clientApi/staffApi `coupon.available` 的**满减基数口径**与下单侧不一致

这是最可能的真 Bug：

`coupon.available`（client/staff）：
```js
// L171-174 / L105-109
const eligibleTotal = eligibleItems.reduce(
  (sum, i) => sum + Number(i.amount || 0), 0
)
const minSpend = Number(coupon.min_spend) || 0
if (eligibleTotal < minSpend) continue
```

- `amount` 由前端传入，代表"该行小计（已含手动折扣）"
- 前端 checkout 构造 `amount = price × quantity`（**原价**，无手动折扣）

`order.create`：
```js
// staff L324 / client L284
const eligibleTotal = eligibleItems.reduce((s, d) => s + d.received, 0)
```

- `received` = 前端传入的 `customPrice × quantity`（**真实成交价**，含手动折扣）

→ **不一致场景**：
1. 顾客加购总价 500（原价），选了"满 500 可用"券 → `coupon.available` 用 500 判断 → 放行
2. 店长在结算弹层把某 SKU 的 `customPrice` 从 200 改成 180（手动折扣）→ 前端 `items.amount` 和 `items.received` 此时在两处计算中分别用了不同字段
3. 下单提交时 `eligibleTotal = Σreceived = 480`，`minSpend = 500` → 触发 `throw new Error('INVALID_PARAMS: 未满足使用条件（满500可用）')`

这正好解释了"满 500 可用券未正确匹配"的现象：**票面上满足，下单时不满足**。

**同时反方向也会出问题**：如果前端传 `amount` 已经是手动折扣后的，比如 `price * quantity` 使用的是 `customPrice` 而非 `originalPrice`，那么 `coupon.available` 会和 `order.create` 一致 —— 需要检查 checkout 的 `items` 构造。

**Check**：`fengyu-client/miniprogram/pagesOrder/checkout/checkout.ts:256-264`：

```ts
items = this.data.cartItems.map(i => ({
  skuId: i.skuId, quantity: i.quantity,
  amount: i.price * i.quantity,  // ← i.price 是购物车时的固定价，非 customPrice
}));
```

- 顾客端 checkout 没有手动改价能力 → `price == received`，**不会触发**
- 员工端 `staff/miniprogram/pages/order-create/order-create.ts` 需要检查 items 构造（staff 端才有改价）

**相关代码位置**（真实 Bug 概率从高到低）：
1. `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:105-109` + `fengyu-staff/miniprogram/pages/order-create/order-create.ts` 的 items 构造（是否用的 `customPrice × quantity`）
2. `fengyu-client/cloudfunctions/clientApi/routes/coupon.js:171-174`
3. `fengyu-admin/src/actions/coupons.ts:118`（隐式 cast）

**建议修复**：
- 统一 `coupon.available` 和 `order.create` 的满减基数口径：**都用"折后小计"（即 `received`）**，前端构造 items 时字段名统一为 `receivedAmount`
- 后端在比较前显式 `Number()` + `toFixed(2)` 确保精度
- 加 e2e 测试覆盖"满减边界值"（499.99 / 500.00 / 500.01）

### 4.3 [P0] clientApi `order.create` 缺失折扣券分支

**位置**：`fengyu-client/cloudfunctions/clientApi/routes/order.js:291-294`

```js
if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '品项券') {
  couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
}
// ⚠️ 缺 else if 折扣券 分支
couponDiscount = Math.round(couponDiscount * 100) / 100
```

**影响**：顾客端选中折扣券下单 → `couponDiscount = 0` → 实付全价 → 但 `user_coupons.status` 被原子 claim 为"已使用"。顾客权益被吞。

**对比参考实现**：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:332-337`
- `fengyu-admin/src/lib/utils.ts:37-64`
- `fengyu-client/cloudfunctions/clientApi/routes/coupon.js:181-186`（available 接口里是对的）

**修复**：在 L293 后插入：

```js
else if (couponInfo.coupon_type === '折扣券') {
  couponDiscount = eligibleTotal * (1 - Number(couponInfo.discount_value))
  if (couponInfo.max_discount) {
    couponDiscount = Math.min(couponDiscount, Number(couponInfo.max_discount))
  }
}
```

### 4.4 [P1] clientApi `redeem` 引用不存在的数据库列

**位置**：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:224-290`

**问题**：SQL 引用 `redeem_code`, `max_claims`, `claimed_count`, `expire_at`（模板级）—— 这些列在 `coupon_templates` 中都不存在。

**证据**：`grep redeem_code|max_claims|claimed_count` 在 `db/schema/` 下 0 命中。

**影响**：`coupon.redeem` 任何调用都会抛 `column "xxx" does not exist`。好在前端目前没有任何页面调用该接口（grep 全仓 `coupon.redeem` 只出现在 `index.js` 路由表、test、cloudfunction CLAUDE.md）。**是死代码而非线上崩溃**。

**修复**：
- 从 `clientApi/index.js` 路由表删除 `redeem` 条目
- 删除 `routes/coupon.js` 中的 `redeem` 函数导出
- 删除 `__tests__/routes/coupon.test.js` 中对 redeem 的测试（如有）
- 从 `fengyu-client/CLAUDE.md` / `cloudfunctions/clientApi/CLAUDE.md` 的接口表删除 redeem

### 4.5 [P1] admin UI 未暴露 `applicable_store_ids`

**位置**：
- `fengyu-admin/src/app/(main)/coupons/_components/coupon-create-page.tsx`
- `fengyu-admin/src/app/(main)/coupons/_components/coupon-detail-page.tsx`
- `fengyu-admin/src/app/(main)/coupons/_components/coupons-page.tsx`

**问题**：DB/Action/Types 全都保留了 `applicableStoreIds`，但 UI 三个文件中完全没有对应控件。销售人员无法配置"适用门店"。

**对应需求**：20260304 §八"通用设计要素：满减条件、适用范围、**适用门店**"。

**修复思路**（结构性小改动）：
1. 新增 Server Action `getStoresForCoupon(marketIds?: string[])`，按可选市场过滤返回 stores
2. 在 create/detail 页仿照 "适用市场" 的 UI 模式，新增"适用门店"多选 Card，支持"全部门店" toggle
3. 在 coupons 列表页增加 `applicableStoreIds` 列展示，或用 tooltip 标注
4. `createTemplate` 调用时带上 `applicableStoreIds`
5. 需要增加一条校验：**applicableStoreIds 和 applicableMarketIds 同时为空则视为全部；两者同时非空时取交集语义**，并在 UI 文案明确

### 4.6 [P2] `applicable_product_ids` 字段闲置

schema、Action 参数、Types 保留，UI 和下单匹配逻辑完全不用。

**建议**：
- 短期：在 `.42cog/pm/backend.pr.spec.md` 或本文件里标注为"保留字段，暂不暴露，待销售反馈后决定"
- 长期：如果一版后销售需求"按商品粒度发券"，再开坑实现 UI + 匹配逻辑

**不建议立刻删除**：避免后续重新加字段要跑迁移。

### 4.7 [P2] 重复代码 —— client/staff 的 `coupon.available`

`fengyu-client/.../routes/coupon.js:93-206` 与 `fengyu-staff/.../routes/coupon.js:13-137` 几乎 1:1 复制：同样的门店反查、懒清扫、品项匹配、满减、三类券计算。

建议抽象到 `cloudfunctions/_shared/coupon-matcher.js`，两边引用。**非本次变更范围**。

---

## 5 差异报告

### 5.1 当前行为

1. 数据层三类券已经落地成 `coupon_templates + user_coupons + coupon_type 枚举` 单模型（`db/schema/coupon.ts`）
2. admin 后台可创建/编辑/启停/发放/批量发放优惠券（`src/actions/coupons.ts`）
3. admin UI 支持配置 `couponType / discountValue / minSpend / maxDiscount / totalCount / validityMode(fixed|days) / validFrom/To / validDays / applicableCategoryIds / applicableMarketIds / description`
4. admin UI **不支持** 配置 `applicableStoreIds` 与 `applicableProductIds`
5. 客户端可以查看"我的券"、下单时选择可用券；员工端可以在开单时帮顾客选可用券
6. 下单核销时通过事务 + 原子 UPDATE 保证券不被重复使用；订单取消时回滚券状态
7. clientApi/staffApi 的 `coupon.available` 按 `门店匹配 → 品项分类匹配 → 满减门槛 → 按券种计算抵扣` 评估，三类券分支均存在
8. clientApi `order.create` 的折扣券抵扣分支**缺失**，折扣券在顾客端下单实扣 0
9. `coupon.redeem`（clientApi）引用不存在的列，死代码
10. `getAvailableCoupons`（admin）与下单侧的满减基数口径**不一致**（可能出现"可用列表显示可用，下单时报不满足"）
11. `issueCoupon` fallback 默认 365 天有效，`createTemplate` 对 `validDays/validTo` 缺少必填校验

### 5.2 期望行为

1. 数据层保持不变（已满足通用模型目标）
2. admin UI 补齐"适用门店"配置入口，销售可按门店/市场/全部三档控制生效范围
3. admin UI 在有效期模块加文案或做单选收窄，避免"券创建日 vs 领取日"的理解歧义
4. admin `createTemplate` 校验：`validityMode='days' ⇒ validDays > 0`；`validityMode='fixed' ⇒ validFrom<validTo`
5. clientApi `order.create` 补齐折扣券分支，与 staffApi 对齐
6. clientApi `coupon.redeem` 移除或重建（建议移除）
7. client/staff `coupon.available` 与 `order.create` 统一满减基数口径（都用折后 received）
8. 所有满减比较前做 `Number()` 强制转换与 `toFixed(2)` 精度处理
9. 增加 E2E：满减边界、折扣券核销金额、券取消回滚

### 5.3 差异矩阵

| 维度 | 当前 | 期望 | 影响范围 | 类别 |
|---|---|---|---|---|
| 3 券种统一模型（schema） | ✅ 已达成 | 保持 | `db/schema/coupon.ts` | 无需改动 |
| 满减（min_spend） | 字段存在但基数口径不一致 | 统一用 received | `*/routes/coupon.js`, `*/routes/order.js` | 逻辑 |
| 适用范围（category） | ✅ 已支持 | 保持 | — | 无需改动 |
| 适用范围（product） | 字段存在，UI/逻辑未用 | 保持冬眠，加注释 | admin UI, spec 文档 | 文档 |
| 适用门店 | schema 有，admin UI 无 | admin 补 UI | `coupons/*`, `actions/coupons.ts` | UI+Action |
| 适用市场 | ✅ 已支持 | 保持 | — | 无需改动 |
| 有效期 days 模式 | ✅ 领取日起算 | 保持 | — | 无需改动 |
| 有效期 fixed 模式 | 模板配置日期 | 加文案说明 + 必填校验 | admin UI + `createTemplate` | 文案+校验 |
| 折扣券下单抵扣 | staff ✅ / admin ✅ / client ❌ | 补 client 分支 | `clientApi/routes/order.js:291-294` | Bug 修复 |
| redeem 兑换码 | 死代码 + schema 缺列 | 删除 | `clientApi/routes/coupon.js:212-299`, `clientApi/index.js`, CLAUDE.md | 删除 |
| 批量发放 | ✅ 全有全无 | 保持 | — | 无需改动 |
| 乐观锁 | ✅ | 保持 | — | 无需改动 |

---

## 6 修改计划（按执行顺序）

### Phase 0 — 澄清与文档

1. **与销售对齐"有效期"语义**：
   - 当前 `days` 模式=领取日起算，`fixed` 模式=模板设定区间
   - 询问销售：是否仍需要 `fixed` 模式？如果只是"满减大促到某日截止"，等价于"days 模式 + 到大促日"两步转换
   - 决策若为"只保留 days 模式"，则下阶段去掉 UI 的 fixed 选项（但 schema 字段保留以备将来）

2. **更新 `.42cog/pm/backend.pr.spec.md` / `admin.pr.spec.md`**：
   - 明确"通用优惠券模型"章节
   - 记录 `applicable_product_ids` 为"保留字段，暂不支持"
   - 记录"满减基数 = 折后小计"口径

### Phase 1 — P0 Bug 修复

3. **修复 clientApi `order.create` 折扣券分支缺失** [逻辑变更，直接改]
   - 文件：`fengyu-client/cloudfunctions/clientApi/routes/order.js:291-294`
   - 改动：补 `else if (couponInfo.coupon_type === '折扣券') { ... }` 分支，抄 staffApi 同逻辑
   - 部署：通过 `/cloudbase-deploy` 重新上传 clientApi
   - 测试：补单测覆盖「折扣券顾客端下单」场景

4. **修复满减基数口径不一致** [逻辑变更，直接改]
   - 文件 A：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:93-206`
   - 文件 B：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:13-137`
   - 文件 C：`fengyu-client/miniprogram/pagesOrder/checkout/checkout.ts:256-264`（items 构造）
   - 文件 D：`fengyu-staff/miniprogram/pages/order-create/order-create.ts`（items 构造，需查）
   - 改动：
     - 前端构造 items 时，`amount` 字段改为 `receivedAmount`，值 = 折后成交价 × 数量
     - 后端 `coupon.available` 读取 `receivedAmount`（向前兼容旧 `amount` 字段 1-2 个灰度周期）
     - `coupon.available` 和 `order.create` 在比较前显式 `Number(x).toFixed(2)` 精度处理
   - 测试：E2E 覆盖 499.99 / 500.00 / 500.01 边界，以及"原价满足但折后不满足"场景

5. **修复 createTemplate / updateTemplate 有效期必填校验 + 消灭 issueCoupon fallback** [逻辑变更，直接改，对应 §4.1.1]

   **5.1 脏数据预检（上线阻塞前置）**

   上线新校验前必须先清理 DB 里已有的脏数据，否则任何带有旧脏数据的 update 请求都会被新校验拦住。在 admin 机器或 db 容器里跑：

   ```sql
   -- 应有效期但字段缺失的模板
   SELECT template_id, name, coupon_type, validity_mode, valid_days, valid_from, valid_to, is_active
   FROM coupon_templates
   WHERE is_active = true
     AND (
       validity_mode IS NULL
       OR (validity_mode = 'days'  AND valid_days IS NULL)
       OR (validity_mode = 'fixed' AND (valid_from IS NULL OR valid_to IS NULL OR valid_from >= valid_to))
     );

   -- 已发放但走过 fallback 365 天分支的记录（用于事后稽核，可选）
   SELECT uc.coupon_id, uc.template_id, uc.user_id, uc.expire_at, uc.created_at
   FROM user_coupons uc
   JOIN coupon_templates ct ON uc.template_id = ct.template_id
   WHERE ct.validity_mode IS NULL
      OR (ct.validity_mode = 'days'  AND ct.valid_days IS NULL)
      OR (ct.validity_mode = 'fixed' AND ct.valid_to IS NULL);
   ```

   - 第一条如有命中：在后台人工修复（补填天数或起止日期，或停用模板），逐条处理并 `operation_logs` 留痕
   - 第二条如有命中：与销售对齐是否需要调整顾客已持券的到期时间（一般不动，只做稽核）

   **5.2 后端 `createTemplate` 校验补齐**（`fengyu-admin/src/actions/coupons.ts:205-278`）

   - 把参数签名中的 `validityMode?: string` 改成必填 `validityMode: 'days' | 'fixed'`
   - 在现有 `discountValue` 校验之后、`db.insert` 之前，追加以下校验块：

   ```ts
   // 校验 validityMode 枚举
   if (data.validityMode !== 'days' && data.validityMode !== 'fixed') {
     return { success: false, message: '有效期模式必须为 days 或 fixed' }
   }

   // 校验 days 模式
   if (data.validityMode === 'days') {
     const vd = Number(data.validDays)
     if (!Number.isInteger(vd) || vd <= 0) {
       return { success: false, message: '"领取后 N 天"模式需填写正整数有效天数' }
     }
     if (vd > 3650) {
       return { success: false, message: '有效天数不能超过 3650 天（10 年）' }
     }
   }

   // 校验 fixed 模式
   if (data.validityMode === 'fixed') {
     if (!data.validFrom || !data.validTo) {
       return { success: false, message: '"固定时段"模式需同时填写开始与结束日期' }
     }
     if (new Date(data.validFrom) >= new Date(data.validTo)) {
       return { success: false, message: '有效期开始日期必须早于结束日期' }
     }
     // 可选：提醒已过期
     if (new Date(data.validTo) <= new Date()) {
       return { success: false, message: '有效期结束日期必须晚于当前时间' }
     }
   }
   ```

   - 同步在 `db.insert().values(...)` 里根据模式清空另一侧字段，防止混入残留值：
     - days 模式：`validFrom: null, validTo: null`
     - fixed 模式：`validDays: null`
   - 既有的 L244 "validFrom>validTo 顺序校验"被新的 fixed 分支覆盖，可删除

   **5.3 后端 `updateTemplate` 校验补齐**（同文件 L280-341）

   - 难点：partial update，不能只看补丁本身；必须"**DB 现值 merge 补丁**"后再整体校验
   - 改动思路：
     1. 开头先 `SELECT` 现值（代码已有 `before` 变量，复用即可）
     2. 构造 `merged = { ...before, ...patch }`（只合并本次变更字段）
     3. 调用一个内部函数 `validateValidityFields(merged)`，复用 §5.2 的校验逻辑（抽成 `src/lib/coupon-validate.ts` 或同文件私有函数都行）
     4. 若 `patch.validityMode` 从 A 切到 B，则另一侧字段必须**由本次补丁显式传入**，不能靠 DB 残留——额外检查：
        - 切到 days：patch 必须含 `validDays`
        - 切到 fixed：patch 必须同时含 `validFrom` + `validTo`
     5. 校验通过后，根据 merged 模式把另一侧字段在 `updateData` 里强制置 null（与 createTemplate 对齐）
   - 同时把"仅对单字段做顺序校验"补齐：合并后若 fixed 模式，`validFrom >= validTo` 拦截

   **5.4 消灭 `issueCoupon` / `batchIssueCoupons` 的 365 天 fallback**（L424-434 和 L559-569）

   - 删除 fallback 分支，改为：

   ```ts
   let expireAt: Date
   if (tpl.validityMode === 'days' && tpl.validDays) {
     expireAt = new Date()
     expireAt.setDate(expireAt.getDate() + tpl.validDays)
   } else if (tpl.validityMode === 'fixed' && tpl.validTo) {
     expireAt = new Date(tpl.validTo)
   } else {
     // 理论不可达（createTemplate/updateTemplate 已保证），做硬兜底 + 告警日志
     console.error('[issueCoupon] INVALID_TEMPLATE: 有效期字段缺失', {
       templateId: tpl.templateId,
       validityMode: tpl.validityMode,
       validDays: tpl.validDays,
       validTo: tpl.validTo,
     })
     return { success: false, message: '优惠券模板有效期配置异常，请联系管理员修复后再发放' }
   }
   ```

   - 理由：原 fallback 掩盖了 createTemplate 的 Bug；新的防线建成后，走到 else 分支一定是脏数据或代码回滚，必须让销售看见错误而不是默默发 365 天
   - `batchIssueCoupons` 同步改造，且由于是批量操作，遇到该模板应**整批失败并回滚**（不能部分成功），错误信息带上 templateId 方便定位

   **5.5 前端 `coupon-create-page.tsx` 联动校验**（L42-108）

   - 在 `handleCreate` 的现有校验链（L52-74）之后、`setSaving(true)` 之前，补：

   ```ts
   if (validityMode === 'days') {
     const vd = parseInt(validDays, 10)
     if (!Number.isInteger(vd) || vd <= 0) {
       toast.error('请填写"领取后 N 天"的有效天数（正整数）')
       return
     }
     if (vd > 3650) {
       toast.error('有效天数不能超过 3650 天')
       return
     }
   } else if (validityMode === 'fixed') {
     if (!validFrom || !validTo) {
       toast.error('"固定时段"模式需同时填写开始与结束日期')
       return
     }
     if (new Date(validFrom) >= new Date(validTo)) {
       toast.error('有效期开始日期必须早于结束日期')
       return
     }
   }
   ```

   - 文案必须与后端完全一致（便于用户识别错误来源）
   - `coupon-detail-page.tsx`（更新入口）同样补，校验函数抽成共享 helper 避免两处漂移
   - UI 层面：切换 `validityMode` 时自动清空另一侧输入框的值（当前代码 L88-90 只在提交时 null 化，用户视觉上看不到清空），减少二次提交时的脏数据观感

   **5.6 测试用例**

   - 后端单测（`fengyu-admin/src/actions/__tests__/coupons.test.ts`）：
     - createTemplate × 6：
       - ❌ validityMode 缺失 / 非法枚举值
       - ❌ days + validDays 缺失
       - ❌ days + validDays=0 / -1 / 非整数 / >3650
       - ❌ fixed + validFrom 缺失
       - ❌ fixed + validTo 缺失
       - ❌ fixed + validFrom >= validTo
       - ✅ days + validDays=30 成功，且 validFrom/validTo 被写 null
       - ✅ fixed + 合法区间成功，且 validDays 被写 null
     - updateTemplate × 5：
       - ❌ 只传 `validityMode: 'days'` 不传 validDays（从 fixed 切 days 未给字段）
       - ❌ 只传 `validDays: null` 把现有 days 模板清空
       - ❌ 只传 `validTo` 使之早于 DB 现有 validFrom
       - ✅ 完整切模式 fixed → days（patch 同时带 validDays）
       - ✅ 只改 name（不触发有效期校验链）
     - issueCoupon × 3：
       - ✅ 正常 days 模式发放，expire_at ≈ now + validDays
       - ✅ 正常 fixed 模式发放，expire_at === validTo
       - ❌ 模拟 DB 脏数据（validDays=NULL）时返回 INVALID_TEMPLATE 错误而不是走 365 分支
     - batchIssueCoupons × 1：脏数据模板整批回滚

   - 前端单测（若有 `coupon-create-page.test.tsx`）或 E2E（`e2e/coupons.spec.ts`）：
     - days 模式漏填 validDays → UI 提示且不调 createTemplate
     - fixed 模式只填 validFrom → UI 提示
     - 模式切换后字段清空观感

   **5.7 验收标准（AC）**

   - AC-1：admin UI 在"领取后 N 天"模式漏填天数提交 → 前端阻止 + 后端 400（双保险）
   - AC-2：admin UI 在"固定时段"模式只填一半日期提交 → 前端阻止 + 后端 400
   - AC-3：直接调用 Server Action `createTemplate` 绕过前端，缺字段或字段非法 → 后端明确错误，不落库
   - AC-4：直接调用 `updateTemplate` 做恶意 partial update（切模式不给字段、字段置 null、日期倒置）→ 全部拦截
   - AC-5：`issueCoupon` / `batchIssueCoupons` 面对脏数据模板 → 报错 + `console.error` 审计日志，**不再给出 365 天兜底**
   - AC-6：脏数据预检 SQL 在上线前执行，结果为 0 行（或全部已人工修复）
   - AC-7：所有新增校验都有单测覆盖，`bun run test` 通过

   **5.8 部署顺序（关键）**

   1. 先跑 §5.1 脏数据 SQL，修完或停用有问题的模板
   2. 发布 §5.2 + §5.3 + §5.5 的前后端校验（此时 fallback 还在，作为过渡期兜底）
   3. 在预发/生产观察 1~3 天，确认没有新的脏数据产生（可定期跑 §5.1 第一条 SQL）
   4. 最后发布 §5.4 的 fallback 移除
   5. 不要把 §5.2 和 §5.4 揉进一个 PR——拆成两次上线，降低线上风险

### Phase 2 — P1 清理

6. **删除 clientApi `coupon.redeem`（死代码）** [删除，直接改]
   - 文件 A：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:212-299`（函数 + export）
   - 文件 B：`fengyu-client/cloudfunctions/clientApi/index.js`（路由表中 `coupon.redeem` 条目）
   - 文件 C：`fengyu-client/cloudfunctions/clientApi/__tests__/routes/coupon.test.js`（如有 redeem 测试）
   - 文件 D：`fengyu-client/CLAUDE.md` / `fengyu-client/cloudfunctions/clientApi/CLAUDE.md` 的接口表
   - 全仓 grep `coupon.redeem` 确认无前端调用
   - 部署：重新上传 clientApi

7. **admin 补齐"适用门店"UI** [结构小变更 + 逻辑]
   - 新增 Server Action：`fengyu-admin/src/actions/coupons.ts` 增加 `getStoresForCoupon`（可选 marketIds 过滤）
   - `coupon-create-page.tsx` 增加新 Card：
     - checkbox "全部门店" toggle
     - 未勾选时渲染按市场分组的 stores 多选
     - state: `allStores / selectedStoreIds`
     - 传入 `createTemplate`: `applicableStoreIds`
   - `coupon-detail-page.tsx` 同样增加编辑区
   - `coupons-page.tsx` DataTable 加列展示 `适用门店`（或 tooltip）
   - 业务语义澄清：
     - `applicableMarketIds = null && applicableStoreIds = null` → 全部生效
     - 两者 both set → 取**并集**（市场内所有门店 ∪ 指定门店）
     - 会议未指明，建议 PM 确认
   - 更新 types.ts 已有 `applicableStoreIds: string[] | null`，无需改
   - 测试：action 单测 + E2E "创建门店专属券"

### Phase 3 — P2 文档

8. **更新 `.42cog/pm/backend.pr.spec.md`**：
   - 优惠券章节补充"通用模型 + 3 券种 + 满减 + 适用门店/市场/品项 + 两种有效期"说明
   - 标注 `applicable_product_ids` 为保留字段

9. **更新 CLAUDE.md 接口表**：
   - 删除 `clientApi.coupon.redeem`
   - 确认 `staffApi.coupon.available` 和 `clientApi.coupon.available` 的 items payload 字段名统一

---

## 7 风险点

| 风险 | 等级 | 缓解 |
|---|---|---|
| clientApi 折扣券 Bug 可能已经导致线上顾客权益被吞 | 高 | 修复部署后，跑 SQL 排查：`SELECT * FROM user_coupons uc JOIN coupon_templates ct ON uc.template_id=ct.template_id WHERE uc.status='已使用' AND ct.coupon_type='折扣券' AND used_sale_order_id IS NOT NULL`，人工复核是否需要补偿 |
| 满减基数口径调整影响老订单快照 | 低 | `sale_orders.coupon_discount` 是快照，已入库数据不受影响；新口径只影响新下单 |
| 前端 `amount → receivedAmount` 字段改名灰度 | 中 | 云函数侧做 `receivedAmount ?? amount` 兼容，2 周后删除 |
| 新增 applicableStoreIds UI 需与 PM 确认"并集 vs 交集"语义 | 中 | 先做"并集"实现，文档写清，上线前会议确认 |
| 删除 redeem 接口若前端有隐蔽调用会 404 | 低 | 全仓 grep `coupon.redeem` 确认无命中后再删；保留一个 deprecated 版本抛友好错误 1 周 |
| 有效期模式"fixed vs days"销售可能混淆 | 中 | 在 UI 浮窗加文案，或只保留 days 模式 |
| `coupon.available` 与 `order.create` 代码重复，后续修一处漏一处 | 低 | Phase 4（非本次范围）抽共享模块 |

---

## 8 结论

| 议题 | 结论 |
|---|---|
| 20260304 §八 "3 券种统一模型" | ✅ **已实现**，数据层无需结构性变更 |
| 20260304 §八 "满减条件" | ⚠️ 字段齐全，但基数口径可能不一致（真 Bug） |
| 20260304 §八 "适用范围" | ✅ 分类粒度已支持；商品粒度字段闲置 |
| 20260304 §八 "适用门店" | ❌ **后台 UI 缺失**，需补齐 |
| 20260324 §十二 "有效期逻辑" | ⚠️ days 模式正确；fixed 模式是需求澄清；校验不全 |
| 20260324 §十二 "满 500 匹配异常" | ⚠️ 定位到疑点 —— 满减基数口径不一致 |
| clientApi 折扣券核销 | ❌ **P0 Bug**，分支缺失需立即修 |
| clientApi redeem 接口 | ❌ 死代码，清理 |
| 二期需求（生日发券 / 满额发券 / 套餐赠券） | 不在本次范围，记录到 backlog |

**总体判断**：通用模型的"思路"与"骨架"已经在 2026-03-04 会议前就落地好了，本次变更不涉及 schema / 枚举 / 字段增删，**无需交接给 `/wx-change-propagation`**。全部修改项都是：
- 逻辑 Bug 修复（Phase 1，3 项，P0）
- 死代码清理（Phase 2-6，P1）
- UI 补齐（Phase 2-7，P1，含一个新 Action）
- 文档对齐（Phase 3）

建议按 Phase 1 → Phase 2 → Phase 3 顺序推进，Phase 1 的 P0 Bug 修复后需立即部署 clientApi 并跑一次"折扣券下单"回归，再做后续清理与 UI 增强。
