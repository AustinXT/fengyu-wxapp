# 审计报告：品项分类动态字段 (24) — v1+v2 合并版

**审计时间**：2026-04-25 初审 + 2026-04-26 v2 重审 → 合并整理 2026-04-26
**域 ID**：24
**审计员**：claude-opus-4-7
**审计时长**：~50 分钟（v1 ~25m + v2 ~25m）
**Slug**：product-category-dynamic
**报告版本**：v1+v2 合并版，2026-04-26

---

## §1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/product.ts:30-111`（productCategories 4 capability 列 + productSkus is_experience/is_recharge_card + 2 DB CHECK） | 同左 | 同左 |
| Migration | `0014_broad_thunderbolt`（4 capability 列）；`0017_tidy_rage`（is_experience）；`0019_lethal_iron_man`（is_recharge_card + CHECK + 双向回填）；`0020_recharge_d4_constraint_trigger`（DEFERRED mix-recharge trigger） | 同左 | 同左 |
| Action / Route | `src/actions/products.ts:75-681`（getCategories / getProductKinds / getCardKindNamesFromDb / createProductKind / updateProductKind / createCategory / updateCategory / createSku / updateSku）`:1462-1696`（getProductsByKind）；`src/actions/orders.ts:1399`（createConversionOrder）；`src/actions/cards.ts:220/279`（getCustomerHeldCards） | `staffApi/routes/product.js:19-476`（CARD_PRODUCT_KINDS 兜底 / shopInit / categories / cardKinds）；`staffApi/routes/order.js`（业务 SQL 用 capability 列）；`staffApi/routes/card.js` | `clientApi/routes/product.js:16-446`（SKU_VALID_FILTER 排除双卡类；spuList/spuDetail/experienceCardList） |
| 类型 / 常量 | `src/lib/types.ts`（ProductCategory 含 4 capability）；`src/lib/product-kind.ts`（CARD_PRODUCT_KINDS @deprecated）；`src/app/(main)/orders/_components/order-create-page.tsx:41-43`（**PRODUCT_KIND_CHOICES 硬编码**） | `staffApi/routes/product.js:32`（CARD_PRODUCT_KINDS 兜底）；`__tests__/routes/recalc-customer-type-sql.test.js:9,105,134,154`（反向锁死断言） | — |
| 前端 | `src/app/(main)/products/categories/_components/product-kind-management-dialog.tsx`（一级 CRUD 4 capability）；`categories-page.tsx`（二级 CRUD） | `miniprogram/packageService/product-detail/product-detail.{ts,wxml}`（kindDisplayColor 消费） | `miniprogram/utils/cart.ts:23-25`（kindDisplayColor）+ `pagesShop/{shop,service-detail}/*` |
| 测试 | `src/actions/products.test.ts`；`src/actions/__tests__/products-getProductsByKind.test.ts` | `__tests__/routes/product.test.js`；`__tests__/routes/recalc-customer-type-sql.test.js`；`__tests__/routes/order.test.js:3835,3959-3961` | — |

---

## §2. 数据流图（v1+v2 合并视角）

```
admin createProductKind / updateProductKind
  ├─ INSERT/UPDATE product_categories(productKind=NULL, isCardKind, displayColor,…)
  ├─ 改名：tx.update children.product_kind 级联 ✓（v1 P0-24-01 已闭环）
  ├─ ❌ 停用：不级联子级 isValid（P1-24v2-10 未修）
  └─ ❌ is_card_kind 改时不同步级联子级 SKU capability（P0-24v2-02）

admin createSku / updateSku
  ├─ ✅ 应用层互斥校验：isExperience && isRechargeCard 阻断
  ├─ ✅ DB CHECK chk_sku_not_both_capabilities
  └─ ❌ 与父级 product_categories.is_card_kind 一致性校验缺失（P0-24v2-02）

DB CONSTRAINT TRIGGER（migration 0020）
  ├─ ✅ trg_check_no_mixed_recharge：DEFERRED 阻断同一订单内 is_recharge_card 混单
  └─ ❌ 漏：trg_check_no_mixed_experience — 体验卡与普通商品混单 DB 无兜底（P0-24v2-01）

—— 消费链路 ———

staff order.js 业务 SQL
  ├─ ✅ pc_parent.is_card_kind = true AND NOT si.is_recharge_card（capability 列驱动）
  └─ ✅ applyRechargeOnOrderPaid（sale_items.is_recharge_card 行级快照）

staff product.js shopInit
  ├─ ✅ NOT (sk.is_recharge_card OR sk.is_experience) — capability 列过滤
  └─ ❌ cardKinds 用 CARD_PRODUCT_KINDS 兜底常量（PG 异常时仍可能打回旧值，P1-24v2-05）

client product.js
  ├─ ✅ SKU_VALID_FILTER = is_enabled = true AND NOT (is_experience OR is_recharge_card)
  └─ ❌ 只消费 kind_display_color；is_card_kind / display_icon / requires_shengmei_flag 三端无消费
```

---

## §3. 自身漏洞

### §3.1 P0（阻断 / 资损 / 越权）

#### [P0-24v2-01] DB CONSTRAINT TRIGGER 仅覆盖 `is_recharge_card`，**`is_experience` 漏覆盖** — 体验卡与普通商品同单可绕 DB 兜底
- **来源**：v2-only（新发现，v1 无此问题）
- **文件**：`db/migrations/0020_recharge_d4_constraint_trigger.sql:1-43`（仅 is_recharge_card）；`db/migrations/0017_tidy_rage.sql:1-23`
- **现象**：0020 trigger 函数 `check_no_mixed_recharge()` 只校验 `bool_or(is_recharge_card)` 互斥；体验卡 ticket 设计承诺"体验卡走独立购物流，不与商城购物车合并"，但 DB 层无对应 trigger。
- **风险**：
  - 体验卡混单时：若混入 5000 元体验卡 + 1 元普通商品，跃迁 SQL 按非体验 1 元判定 → 顾客本应触发会员客但被判小美客
  - sale_items.is_experience 行级快照虽已写入，但 DB 不阻断混单创建
- **复现**：
  1. 直接 SQL 在事务内 INSERT 一笔含体验卡 + 普通商品 SKU 的 sale_items
  2. COMMIT 通过（trigger 不触发）
  3. cron-worker `refresh-customer-type` 跃迁 SQL 按非体验金额判 → 顾客类型偏低
- **修复**：(L0) 镜像 0020 加 `check_no_mixed_experience()` + DEFERRED CONSTRAINT TRIGGER；或合并为综合 trigger 同时校验两列
- **CC2 命中**：双 capability 列 DB trigger 非对称兜底
- **影响半径**：DB + 三端所有混单创建路径

#### [P0-24v2-02] `product_categories.is_card_kind` 与 `product_skus.is_experience/is_recharge_card` 之间**无 DB 一致性约束** — admin 孤儿 capability 漂移
- **来源**：v2-only（新发现，v1 无此问题）
- **文件**：`db/schema/product.ts:30-111`（双 capability 列分离）；`fengyu-admin/src/actions/products.ts:535-681`（仅校验 isExperience XOR isRechargeCard，不校验与父级一致性）
- **现象**：
  - admin 可创建 is_card_kind=true 一级行，但下属 SKU 全不勾 capability → cardKinds API 返回该 kind 名但 SKU 层不知情
  - admin 也可创建 is_recharge_card=true SKU，但所属分类父级 is_card_kind=false
- **风险**：
  - staff cardKinds API（读 `product_categories.is_card_kind=true`）返回"卡类名单" ≠ product_skus 真实 capability
  - 业务跃迁 SQL `pc_parent.is_card_kind = true AND NOT si.is_recharge_card` 若 SKU is_recharge_card=false 且 is_experience=false、pc_parent.is_card_kind=true → 误判为"体验类单品卡"
  - admin 开单 Step 1 的 PRODUCT_KIND_CHOICES 与 SKU 层 capability 列脱钩
- **复现**：
  1. admin 创建 product_kind='充值卡VIP'（isCardKind=true）→ 二级分类 → SKU 不勾 capability
  2. staff 开单 → cardKinds API 返回该 kind，前端按"卡类"独立 Tab 展示
  3. order.create 走标准路径，sale_items.is_recharge_card=false → payNotify 不触发充值卡逻辑
- **修复**：(L0/L7)
  - L7：admin createSku/updateSku 加二次校验 — 父级 is_card_kind=true 时 SKU 必须 is_recharge_card=true XOR is_experience=true
  - L0：DB trigger `AFTER INSERT/UPDATE OF is_experience, is_recharge_card, category_id ON product_skus` 校验父级一致性
  - L7：updateProductKind 改 is_card_kind 时同步级联子级 SKU
- **影响半径**：DB + admin + staff + payNotify

### §3.2 P1（一致性 / 状态错乱）

#### [P1-24v2-03] admin `order-create-page.tsx:41-43` **`PRODUCT_KIND_CHOICES` 仍硬编码 4 字面量** — "DB 驱动零代码新增 kind"承诺打破
- **来源**：v1 P1-24-08（残留）
- **文件**：`fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:41-44, 130, 453`
- **现象**：`const PRODUCT_KIND_CHOICES: ProductKindChoice[] = ['组合套餐','普通商品','体验卡','充值卡']` 写死；admin 新建第 5 个 kind 不会出现在开单 Step 1 Tab
- **风险**：前端 UI 死锁，后端 getProductsByKind 已 DB 驱动但前端无法呈现
- **修复**：(L9) 改为运行时 `await getProductKinds()` 派生；`__bundle__` / `__normal__` 固定 Tab + 卡类一级行逐个 Tab

#### [P1-24v2-04] admin `orders.ts:1399` + `cards.ts:279` 仍硬编码 `productKind === '体验卡'` 字面量
- **来源**：v1 P1-24-03（体验卡部分 Round 1 未完全覆盖，漏了两处）
- **文件**：
  - `fengyu-admin/src/actions/orders.ts:1399`（createConversionOrder 体验卡折抵判定）
  - `fengyu-admin/src/actions/cards.ts:220 / 279`（getCustomerHeldCards 体验卡 SKU 识别）
- **现象**：Round 1 ticket §3.1 列出的 10 个文件已全部改完，但这两处明显遗漏
- **风险**：admin 改名"体验卡"后持卡列表丢失；历史体验卡折抵无法识别；与 sale_items.is_experience 行级权威矛盾
- **修复**：(L7) cards.ts:279 改为 `eq(productSkus.isExperience, true)`；orders.ts:1399 改为 `row.is_experience === true`

#### [P1-24v2-05] staff `CARD_PRODUCT_KINDS` 兜底常量 + admin `lib/product-kind.ts` deprecated 仍在引用（v1 P2-24-10 升级）
- **来源**：v1 P2-24-10（升级为 P1）
- **文件**：
  - `staffApi/routes/product.js:32`（CARD_PRODUCT_KINDS = ['充值卡','体验卡']）
  - `fengyu-admin/src/lib/product-kind.ts`（@deprecated 常量）
- **现象**：cardKinds PG 异常时回退到 `CARD_PRODUCT_KINDS.slice()` — 改名瞬间 + 新建第 5 个 kind 漏呈现；兜底常量反向锚定了"DB 驱动"承诺
- **风险**：运营改名后 PG 异常极小概率仍可击穿，fallback 不 fail-closed
- **修复**：(L3) cardKinds PG 异常时返回 `{ names: [], _fallback: true }` 让前端拒绝渲染；admin lib/product-kind.ts 在所有新代码切走后删除

#### [P1-24v2-06] `recalc-customer-type-sql.test.js` 反向锁死 `not.toContain('is_card_kind')` 与 `order.test.js` 含 `is_card_kind` 断言矛盾
- **来源**：v1 P2-24-12（升级为 P1）
- **文件**：
  - `staffApi/__tests__/routes/recalc-customer-type-sql.test.js:105/134/154`（要求不含 is_card_kind）
  - `staffApi/__tests__/routes/order.test.js:3961`（要求含 is_card_kind）
  - `staffApi/__tests__/routes/product.test.js:578`（要求含 is_card_kind）
- **现象**：测试互相矛盾的"反向锁死"模式阻碍 schema 演进；未来改 is_card_kind 列名必须同时改两组测试
- **风险**：测试反模式让任何 capability 列重构成本翻倍
- **修复**：(L3) 跃迁 SQL 测试改 positive 断言：`toMatch(/sale_items.*is_experience/)` + `toMatch(/sale_items.*is_recharge_card/)`；删除 `not.toContain('is_card_kind')`

#### [P1-24v2-07] `getCategories` LEFT JOIN parent **不过滤 parent.is_valid** — v1 P0-24-02 / P1-24-06 残留，未在 Round 1 关闭
- **来源**：v1 P0-24-02 / P1-24-06（残留）
- **文件**：`fengyu-admin/src/actions/products.ts:93-98`
- **现象**：
  ```ts
  .leftJoin(parent, and(
    isNull(parent.productKind),
    eq(parent.categoryName, productCategories.productKind),
  ))
  ```
  缺 `eq(parent.isValid, true)`；三个 getter 守卫不一致：getCardKindNamesFromDb ✓ / getProductsByKind('__normal__') ✓ / getCategories ✗
- **风险**：停用父级后子级 parentCapability 字段仍返回已停用值，admin SKU 表单与 cardKinds API 不一致
- **修复**：(L7) getCategories / getProductKinds 统一加 `eq(parent.isValid, true)`；getProductKinds 加 includeDisabled 参数

#### [P1-24v2-08] `createProductKind` 不校验 `displayColor` HEX 格式
- **来源**：v1 P1-24-09（残留）
- **文件**：`fengyu-admin/src/actions/products.ts:174-223`
- **现象**：`displayColor` 直接 `data.displayColor ?? null` 入库，无 regex 校验
- **风险**：`red` / `oklch(...)` / 任意字符串入库 → Vant `<van-tag>` 渲染异常；CC8 命中
- **修复**：(L7) Zod schema 加 `regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/)`；空字符串规范化为 null

#### [P1-24v2-09] CC5 `INVALID_PRODUCT_KIND:` 前缀不在 4 项约定
- **来源**：v1 CC5 命中（残留）
- **文件**：`fengyu-admin/src/actions/products.ts:328, 377`
- **现象**：`createCategory` / `updateCategory` 用 `INVALID_PRODUCT_KIND:` 前缀
- **修复**：(L7) 改为 `INVALID_PARAMS:`

#### [P1-24v2-10] `updateProductKind` 停用一级行**无依赖检查 + 不级联子级**
- **来源**：v1 P0-24-01（停用场景残留；改名级联已修）
- **文件**：`fengyu-admin/src/actions/products.ts:229-305`
- **现象**：停用时（isValid=false）不级联子级 isValid；不校验 SKU 引用；不校验未支付订单；v2 capability 列落地后停用语义不再致命（业务 SQL 不读 product_kind），但 cardKinds API 强制 isValid=true 使停用仍有部分下游影响
- **修复**：(L7) isValid=false 时事务内级联子级；UI 弹层确认"将同时停用 N 个二级分类"

### §3.3 P2（代码质量 / 可维护）

#### [P2-24v2-11] `display_icon` 列 admin 写入但**三端无渲染消费**（dead column）
- **来源**：v1 P2-24-11（残留）
- **文件**：admin write `product-kind-management-dialog.tsx:289-296` / `actions/products.ts:212`；staff/client grep `displayIcon` = 0 命中
- **修复**：(L3/L9) staff/client 透传 + 前端 `<van-icon>` 渲染；或删除该列

#### [P2-24v2-12] migration 0014 注释残留"组合套餐"行
- **来源**：v1 P2-24-13（残留）
- **文件**：`db/migrations/0014_broad_thunderbolt.sql:14-15`
- **修复**：(L0) 注释说明为兜底分支

#### [P2-24v2-13] 一级行 `sales_category` 永远 NULL 但无 CHECK 约束
- **来源**：v1 P2-24-14（残留）
- **文件**：`db/schema/product.ts:34`
- **修复**：(L0) 加 CHECK `(product_kind IS NULL AND sales_category IS NULL) OR (product_kind IS NOT NULL)`

#### [P2-24v2-14] admin 缺 `deleteProductKind` action — 仅软停用（设计决定未固化）
- **来源**：v1 P1-24-07（残留）
- **文件**：`fengyu-admin/src/actions/products.ts`（grep: 无 deleteProductKind）
- **修复**：(L0) schema 注释明确 productCategories 永不硬删除；UI 把"停用"明确说明为"软停用"

#### [P2-24v2-15] migration 0017/0019 数据回填用 `product_kind` 字面量（一次性，低风险）
- **来源**：v2-only（信息性，低风险）
- **文件**：`db/migrations/0017_tidy_rage.sql:5-13`；`0019_lethal_iron_man.sql:11-29`
- **修复**：(L0) 注释明确"一次性 baseline 回填，运营改名后请用 admin 表单重新维护"

---

## §4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| `is_card_kind` 写入 | ✓ createProductKind / updateProductKind | — | — | 单端写入 | OK |
| `is_card_kind` 读取 | ✓ getCardKindNamesFromDb（DB，无 isValid 守卫） | ✓ cardKinds API + order.js；shopInit 已用 capability 列 ✓ | ✗ 不读 | 前端 Tab 选择器漏（PRODUCT_KIND_CHOICES 硬编码） | P1 |
| `is_experience` 写入 | ✓ createSku / updateSku 互斥校验 | — | — | OK | OK |
| `is_experience` 读取 | ✓ getAllSkus / getCustomerHeldCards | ✓ shopInit + order INSERT | ✓ SKU_VALID_FILTER + experienceCardList | 三端口径一致 | OK |
| `is_recharge_card` 写入 | ✓ createSku / updateSku + DB CHECK | — | — | OK | OK |
| `is_recharge_card` 读取 | ✓ orders.ts / cards.ts | ✓ card.js / order.js applyRechargeOnOrderPaid | ✓ SKU_VALID_FILTER + card.js | 三端口径一致 | OK |
| **DB trigger：单订单 mix 阻断** | DEFERRED trigger | ↑ | ↑ | 仅 is_recharge_card ✓；is_experience 缺 | **P0** |
| **product_categories.is_card_kind ↔ product_skus capability 一致性** | 应用层零校验 | — | — | 孤儿 capability 漂移 | **P0** |
| `display_color` 写入 | ✓ ColorPicker（无 HEX 校验） | — | — | 渲染异常 | P1 |
| `display_color` 读取 | ✓ DataTable 色块 | ✓ kind_display_color JOIN | ✓ kind_display_color → cart tag | 三端 OK | OK |
| `display_icon` 写入 | ✓ Input | — | — | dead column | P2 |
| `display_icon` 读取 | ✓ types | ✗ 不 SELECT | ✗ 不 SELECT | 列写不消费 | P2 |
| `requires_shengmei_flag` 写入 | ✓ Switch | — | — | OK | — |
| `requires_shengmei_flag` 读取 | ✓ SKU 表单显隐 | ✗ 不读 | ✗ 不读 | 单端消费即合理 | OK |
| 一级行 isValid=false 阻断下游 | ✗ 无依赖检查 + 不级联子级 | shopInit 阻断 / categories 不阻断 / cardKinds 阻断 | N/A | 三查询口径漂移 | P1 |
| LEFT JOIN parent 时 is_valid 过滤 | ✗ getCategories ✗ / getProductKinds ✗ | ✓ _queryCategoryRows ✓ | N/A | 4 个 getter 不一致 | P1 |
| 业务 SQL "充值卡/体验卡"字面量 | ✓ orders.ts:1399 / cards.ts:279 残留'体验卡' | ✓ order.js 已迁移 | ✓ clientApi 已迁移 | 业务规则绕过的最后漏洞 | P1 |
| 前端商品类型 4 选 1 (admin Step 1) | ✗ 硬编码 PRODUCT_KIND_CHOICES | N/A | N/A | "零代码新增 kind" 破裂 | P1 |
| displayColor HEX 格式校验 | ✗ 无校验 | N/A | N/A | XSS / 渲染破坏 | P1 |
| CC5 错误前缀 | ✗ INVALID_PRODUCT_KIND: 不在 4 项约定 | N/A | N/A | 前缀污染 | P1 |
| 删除语义 | 仅软停用，无 delete | N/A | N/A | 停用含义在多查询不一致 | P2 |

---

## §5. 横切检查（套用 audit_plan.md §3 模板）

- [x] **CC1 数值精度**：本域不涉及金额
- [ ] **CC2 并发幂等**：DB CONSTRAINT TRIGGER 单边覆盖（is_recharge_card ✓ / is_experience ✗）→ **P0-24v2-01**；application-level 互斥校验良好但 DB 兜底非对称
- [x] **CC3 组织域隔离**：本域是全局基础数据，无组织维度
- [x] **CC4 后端鉴权**：admin 全部 requirePermission ✓；staff cardKinds requireStaffBound ✓；client product.categories 无 requirePhone（设计允许匿名浏览）
- [ ] **CC5 错误码**：`INVALID_PRODUCT_KIND:` 不在 4 项约定 → **P1-24v2-09**
- [x] **CC6 PII**：本域不涉及
- [x] **CC7 时间字段**：created_at / updated_at 由 Drizzle defaultNow / $onUpdate 管理 ✓
- [ ] **CC8 WXML/Vant**：`<van-tag color="{{kindDisplayColor}}">` 接收非 HEX 字符串渲染未定义（联动 P1-24v2-08）
- [ ] **CC9 测试与迁移残留**：
  - recalc-customer-type-sql.test.js `not.toContain('is_card_kind')` vs order.test.js `toMatch(/is_card_kind/)` 矛盾 → **P1-24v2-06**
  - admin/staff CARD_PRODUCT_KINDS deprecated 双副本（P1-24v2-05）
  - admin orders.ts:1399 / cards.ts:279 硬编码 '体验卡'（P1-24v2-04）
  - migration 0014 "组合套餐"已废弃概念残留（P2-24v2-12）
  - migration 0017/0019 一次性回填字面量残留（P2-24v2-15）
  - `display_icon` 写入但不消费（P2-24v2-11）
  - 已废弃枚举/表全仓 grep 0 命中 ✓

---

## §6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/migration | 新建 `00NN_experience_mix_trigger.sql` | 镜像 0020 加 `check_no_mixed_experience()` + DEFERRED CONSTRAINT TRIGGER on `sale_items.is_experience` | P0-24v2-01 |
| L0 schema/migration | 新建迁移 | `AFTER INSERT/UPDATE OF is_experience, is_recharge_card, category_id ON product_skus` 校验与父级 `product_categories.is_card_kind` 一致性 | P0-24v2-02 |
| L0 schema | `db/schema/product.ts:34` | 加 CHECK 一级行 sales_category 强制 NULL | P2-24v2-13 |
| L0 schema 注释 | `db/schema/product.ts:30` | 明确 productCategories 永不硬删除；说明 0017/0019 一次性回填 | P2-24v2-14, P2-24v2-15 |
| L3 staff | `staffApi/routes/product.js:458-476 cardKinds` | PG 异常时 fail closed：`{ names: [], _fallback: true }` | P1-24v2-05 |
| L3 staff test | `__tests__/routes/recalc-customer-type-sql.test.js:105/134/154` | 删除 `not.toContain('is_card_kind')`；改 positive 断言 `toMatch(/sale_items.*is_experience/)` + `/sale_items.*is_recharge_card/` | P1-24v2-06 |
| L7 admin | `src/actions/orders.ts:1399` | `row.product_kind === '体验卡'` → `row.is_experience === true` | P1-24v2-04 |
| L7 admin | `src/actions/cards.ts:220/279` | `productCategories.productKind = '体验卡'` → `productSkus.isExperience = true` | P1-24v2-04 |
| L7 admin | `src/actions/products.ts:535-681` | 加二次校验：父级 is_card_kind=true 时 SKU 必须 capability=true（互斥） | P0-24v2-02 |
| L7 admin | `src/actions/products.ts:93-98` | LEFT JOIN parent 加 `eq(parent.isValid, true)` | P1-24v2-07 |
| L7 admin | `src/actions/products.ts:128-153` | getProductKinds 加 includeDisabled 入参 | P1-24v2-07 |
| L7 admin | `src/actions/products.ts:174-223` | Zod displayColor `regex(/^#([0-9a-fA-F]{6}\|[0-9a-fA-F]{3})$/)`；空字符串 → null | P1-24v2-08 |
| L7 admin | `src/actions/products.ts:229-305` | isValid=false 时事务内级联子级；UI 弹层确认依赖 | P1-24v2-10 |
| L7 admin | `src/actions/products.ts:328, 377` | `INVALID_PRODUCT_KIND:` → `INVALID_PARAMS:` | P1-24v2-09 |
| L9 admin | `src/app/(main)/orders/_components/order-create-page.tsx:41-43` | PRODUCT_KIND_CHOICES 改为运行时 `await getProductKinds()` 派生 | P1-24v2-03 |
| L9 staff/client | `miniprogram/packageService/product-detail/*` + `client/pagesShop/*` | 消费 displayIcon 字段（或删除该列） | P2-24v2-11 |

---

## §7. 验证 SQL（5434 EXPLAIN/SELECT 仅，禁止写入）

```sql
-- 1. SKU capability 列与父级 is_card_kind 一致性（P0-24v2-02）
SELECT
  pc_parent.category_name AS parent_kind,
  pc_parent.is_card_kind,
  count(*) FILTER (WHERE ps.is_experience OR ps.is_recharge_card) AS sku_with_cap,
  count(*) FILTER (WHERE NOT (ps.is_experience OR ps.is_recharge_card)) AS sku_without_cap
FROM product_skus ps
JOIN product_categories pc ON pc.category_id = ps.category_id
JOIN product_categories pc_parent
  ON pc_parent.product_kind IS NULL
 AND pc_parent.category_name = pc.product_kind
GROUP BY pc_parent.category_name, pc_parent.is_card_kind
HAVING (
  (pc_parent.is_card_kind = true AND count(*) FILTER (WHERE ps.is_experience OR ps.is_recharge_card) = 0)
  OR
  (pc_parent.is_card_kind = false AND count(*) FILTER (WHERE ps.is_experience OR ps.is_recharge_card) > 0)
);

-- 2. 历史 sale_items 是否存在 mix-experience 订单（P0-24v2-01）
SELECT sale_order_id,
       count(*) FILTER (WHERE is_experience) AS exp_items,
       count(*) FILTER (WHERE NOT is_experience) AS non_exp_items
FROM sale_items
GROUP BY sale_order_id
HAVING count(*) FILTER (WHERE is_experience) > 0
   AND count(*) FILTER (WHERE NOT is_experience) > 0;

-- 3. 一级行 is_valid=false 但子级 is_valid=true（P1-24v2-10）
SELECT parent.category_name AS disabled_kind,
       count(*) FILTER (WHERE child.is_valid = true) AS active_children
FROM product_categories parent
LEFT JOIN product_categories child
  ON child.product_kind = parent.category_name
WHERE parent.product_kind IS NULL AND parent.is_valid = false
GROUP BY parent.category_name
HAVING count(*) FILTER (WHERE child.is_valid = true) > 0;

-- 4. displayColor 非 HEX 格式（P1-24v2-08）
SELECT category_id, category_name, display_color
FROM product_categories
WHERE display_color IS NOT NULL
  AND display_color !~ '^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$';

-- 5. is_card_kind=true 一级行 vs 实际带 capability 的 SKU 名单交叉
WITH parent_card_kinds AS (
  SELECT category_name FROM product_categories
  WHERE product_kind IS NULL AND is_card_kind = true AND is_valid = true
), sku_capability_kinds AS (
  SELECT DISTINCT pc.product_kind AS kind
  FROM product_skus ps
  JOIN product_categories pc ON pc.category_id = ps.category_id
  WHERE ps.is_experience = true OR ps.is_recharge_card = true
)
SELECT
  (SELECT array_agg(category_name ORDER BY category_name) FROM parent_card_kinds) AS parent_kinds,
  (SELECT array_agg(kind ORDER BY kind) FROM sku_capability_kinds) AS sku_kinds;

-- 6. 一级行 sales_category 非 NULL（P2-24v2-13）
SELECT category_id, category_name, sales_category
FROM product_categories
WHERE product_kind IS NULL AND sales_category IS NOT NULL;

-- 7. display_icon dead column 程度（P2-24v2-11）
SELECT count(*) FILTER (WHERE display_icon IS NOT NULL) AS filled,
       count(*) FILTER (WHERE display_icon IS NULL) AS empty
FROM product_categories;

-- 8. 孤儿二级行检查（product_kind 指向不存在或已停用的一级行）
SELECT child.category_id, child.category_name, child.product_kind
FROM product_categories child
WHERE child.product_kind IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_categories parent
    WHERE parent.product_kind IS NULL
      AND parent.category_name = child.product_kind
      AND parent.is_valid = true
  );
```

---

## §8. 回归测试用例（建议）

1. **DB trigger 对称性**：事务内插入混合 `is_experience` sale_items → 期望 COMMIT 时被新 trigger 拒绝（P0-24v2-01 修复后）
2. **孤儿 capability 校验**：admin 创建 SKU is_recharge_card=true 但所属父级 is_card_kind=false → 期望应用层拒绝（P0-24v2-02 修复后）
3. **新建第 5 个 kind 在 admin 开单 Step 1 自动出现**：createProductKind('福利活动', isCardKind=false) → Tab 应增加选项（P1-24v2-03 修复后）
4. **改名"体验卡"不击穿持卡列表**：getCustomerHeldCards 应仍返回该 SKU（P1-24v2-04 修复后）
5. **getCategories 父级停用后子级 parent\* 字段返回 null**（P1-24v2-07 修复后）
6. **displayColor HEX 校验**：传入 `red` / `oklch(...)` → reject `INVALID_PARAMS:`（P1-24v2-08 修复后）
7. **一级行停用级联子级**：isValid=false → 子级 isValid 同步置 false（P1-24v2-10 修复后）
8. **测试反向锁死整治**：跃迁 SQL 测试改 positive `toMatch` 后，改 is_card_kind 列名不应破坏整组测试（P1-24v2-06 修复后）

---

## §9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（P0-24v2-01 / P0-24v2-02 横跨 DB schema + admin actions + staff/client/payNotify）
- 涉及历史数据：☑（0017/0019 一次性回填；0014 仅命中 5 字面量行；新增 trigger 不动历史；P0-24v2-02 一致性 trigger 若加 DB 会暴露已存孤儿）
- 修复成本：M（L0 新 trigger × 2 + L7 admin 4 处字面量 + L9 PRODUCT_KIND_CHOICES 重构 + L3 测试整治；单端独立可推进）

---

## §10. 后续待办

- [ ] **与 PM 对齐**：P0-24v2-02 的"孤儿 capability 校验"在 admin 端是阻断还是告警？
- [ ] **与 PM 对齐**：display_icon 决策（消费 OR 删除）；建议联动 displayColor 形成"完整分类徽章"
- [ ] **与 client/staff PM 对齐**：是否需要在购物车/商品详情展示"卡类徽章"/"生美标识"
- [ ] **CROSS-CUTTING 命中**：
  - CC2 双 capability 列 DB trigger 非对称（v2 新发现）
  - CC9 测试反向锁死 toContain + not.toContain 同字段矛盾（v2 强化）
  - CC9 deprecated 常量残留（admin/staff CARD_PRODUCT_KINDS 双副本）
  - CC9 dead column / dead config（display_icon）
  - CC8 Vant `<van-tag>` 接收非 HEX 字符串渲染兜底缺失
  - CC5 admin `INVALID_PRODUCT_KIND:` 自定义前缀
- [ ] **SCHEMA-CHANGES 提议**：
  - S24-1：新增 `check_no_mixed_experience()` DEFERRED trigger（镜像 0020）
  - S24-2：product_skus ↔ product_categories.is_card_kind 一致性 trigger
  - S24-3：getCategories LEFT JOIN parent 加 isValid 守卫
  - S24-4：updateProductKind 停用时级联子级
  - S24-5：display_color 加 CHECK regex（HEX 格式）
  - S24-6：一级行 sales_category 强制 NULL CHECK
- [ ] **ENUM-AUDIT 命中**：
  - E24-product-kind-dynamic：text 列非枚举，admin order-create-page 仍硬编码 4 选 1 → 前端 enum 同步 DB 规约待建立

---

## §11. v1→v2 合并摘要

### 已 RESOLVED 项目（v1 → Round 1 2026-04-26 完成）

| v1 ID | 描述 | 化解方式 | 来源 |
|-------|------|----------|------|
| **P0-24-01** | "充值卡" magic string 击穿 staff 业务 SQL | migration 0019/0020 落地 `is_recharge_card` capability 列 + staff/order.js / payNotify / cards.js 全部 hot-path SQL 迁移到 capability 列 | ticket [2026-04-26-recharge-card-as-sku-flag](../tickets/2026-04-26-recharge-card-as-sku-flag.md) Round 1 |
| **P1-24-03**（体验卡部分）| shopInit 用 JS 常量排除"体验卡" | migration 0017 + ticket Round 1 staff/client 代码切至 `product_skus.is_experience` | ticket [2026-04-26-experience-card-as-sku-flag](../tickets/2026-04-26-experience-card-as-sku-flag.md) Round 1 |
| **P1-24-04** | client 端 kindDisplayColor 无 fallback | staff shopInit kindNotIn 已切 capability 列 + client cart.ts 已退化 type='primary'兜底 | v2 确认 RESOLVED |
| **P2-24-12**（测试反向锁死"充值卡"部分）| recalc 测试锁死 `<> '充值卡'` 字面量 | staff/order.js 已迁 capability 列，`recalc-customer-type-sql.test.js` 仍含 `not.toContain('is_card_kind')` 但含义已变（测试组内矛盾见 P1-24v2-06） | 已闭环，剩余测试矛盾归入 P1-24v2-06 |
| **P0-24-02**（改名级联部分）| 改名不级联子级 product_kind | v2 确认 `updateProductKind` 事务内已做级联 ✓ | v2 确认 |
| **P1-24-03**（displayColor 部分）| 体验卡部分 shopInit 无 capability 列 | 0017 migration + 代码已迁移（displayColor 部分与 P1-24-04 合并） | — |
| **P1-24-05**（新建 kind 回填部分）| displayColor 默认空字符串 | admin ColorPicker 已默认 `#1989FA`，但 state 空字符串与 input default 脱节（P1-24v2-08 关联） | 仍有残留，见 P1-24v2-08 |

### v2-only 新发现（v1 无，从未评估）

| ID | 描述 | 根因 |
|----|------|------|
| **P0-24v2-01** | DB trigger 仅覆盖 is_recharge_card，is_experience 漏覆盖 → 体验卡混单可绕 DB 兜底 | 0020 trigger 设计与 0017 ticket 实施时间差导致非对称 |
| **P0-24v2-02** | product_categories.is_card_kind 与 product_skus capability 无 DB 一致性约束 → 孤儿 capability 漂移 | 双 capability 列（父级/子级）分离设计，应用层零交叉校验 |

### v1→v2 状态变化总览

| 类别 | 数量 |
|------|------|
| v1 RESOLVED（含部分关闭） | **6**（P0-24-01 ✓、P0-24-02 改名部分 ✓、P1-24-03 体验卡部分 ✓、P1-24-04 ✓、P2-24-12 充值卡部分 ✓、P1-24-05 部分 ✓） |
| v2 新发现 P0 | **2**（P0-24v2-01、P0-24v2-02） |
| v1 升级为 P1（v2 深化） | **5**（P1-24-03 充值卡残留→P1-24v2-04；P1-24-08→P1-24v2-03；P2-24-10→P1-24v2-05；P2-24-12→P1-24v2-06；P0-24-02/P1-24-06→P1-24v2-07+P1-24v2-10） |
| v1 → v2 持续残留 P1 | **3**（P1-24-09→P1-24v2-08；CC5→P1-24v2-09；P0-24-01 停用场景→P1-24v2-10） |
| v1 → v2 持续残留 P2 | **5**（P2-24-11→P2-24v2-11；P2-24-13→P2-24v2-12；P2-24-14→P2-24v2-13；P1-24-07→P2-24v2-14；v2 P2-24v2-15 信息性） |
| **合并后总 P0/P1/P2** | **P0=2 / P1=8 / P2=5** |

> **关键合并决策**：v1 的 P0-24-01（充值卡 capability 列）根因已在 Round 1 完整化解；v2 揭示的新根因集中在"trigger 非对称 + capability 列三方一致性"——这是 migration 0019/0020 落地后新暴露的一类隐患，与 v1 的"未做"是不同层次的问题，不应合并计为同一 P0。
