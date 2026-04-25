# Ticket: 统一"院装产品"与"家居产品"命名为"家居产品"

> **Status**: 已决策方案 B（枚举值重命名），待执行
> **Date**: 2026-04-25
> **Owner**: 待定
> **Related**: `2026-04-25-product-categories-fully-dynamic.md`（product_kind 完全动态化）、`2026-04-24-normal-products-category-exclude-filter.md`

---

## 决策记录（2026-04-25）

✅ **采用方案 B**：把 `product_type` pgEnum 中 `'院装产品'` 重命名为 `'家居产品'`。

**冲突澄清**：原本担心与 `product_kind='家居产品'` 字面同名会导致代码可读性下降。实际上：
- `product_categories.product_kind` 的值是**运营在 admin 维护的数据库内容**，命名是什么都不应该影响代码逻辑；
- **项目代码中本来就不应该有写死 `'护理项目'` / `'家居产品'` 等 `product_kind` 字面量** —— 这是 ticket `2026-04-25-product-categories-fully-dynamic.md` 跟踪的独立问题；
- 因此 product_type 改名后即使与 product_kind 字面同名，也不会因"代码里两个相同字面量混淆"产生问题（前者是合法的 enum 字面量比较，后者是反模式应当移除）。

**WorkFine 同步脚本**：随同改名一并替换字面量（脚本已停用但留在仓库）。
**归档 ticket**：`notes/tickets/archives/*` 不动（保留历史快照）。
**研究文档**：`notes/research/workfine_database.md` 保留 WorkFine 原始术语"院装产品"，加备注说明 PG 已重命名。

---

## 1 关键发现（必读）

> **当前系统里"院装产品"和"家居产品"是两个不同维度的概念，不是同义词。**

| 维度 | 字段 | 类型 | 当前值 | 语义 |
|------|------|------|--------|------|
| **商品大类** | `product_categories.product_kind` | text 列（不再是 pgEnum） | `护理项目 / 家居产品 / 充值卡 / 体验卡` | 商品按品类划分（运营在 admin 自由增删） |
| **核销/交付方式** | `product_skus.product_type` + `sale_items.product_type`（快照） | **pgEnum `product_type`** | `疗程卡 / 单品 / 院装产品` | 核销逻辑：疗程卡多次核销、单品一次核销、院装产品支付即完成（不走到店核销，需提货 `pickup_records`） |

**所以"院装产品"是 `product_type` 的一个值，不是 `product_kind`**。当前同步规则（`db/scripts/sync-products-from-workfine.js`）：每条 UDT_M_341 记录生成 `product_kind='家居产品'` 的 product + `product_type='院装产品'` 的 sku — 数据上两者目前 1:1 对应，但**字段语义独立**。

---

## 2 用户需求理解

**原始描述**：「统一全局院装产品和家居产品的名称为家居产品」

**两种合理解读**（必须先澄清）：

### 解读 A：仅 UI 文案 / 注释 / 文档统一为"家居产品"
- **底层枚举值不动**（`product_type` 仍是 `'院装产品'`）
- 只把所有面向用户/运营/开发者文档里出现的字符串"院装产品"改成"家居产品"
- ✅ 风险极低，无需 DB migration
- ❌ 代码中 `product_type === '院装产品'` 字面量仍残留，开发者读代码会困惑

### 解读 B：枚举值彻底重命名 `'院装产品'` → `'家居产品'`
- 改 pgEnum 值 + 全量代码字面量替换 + 历史数据自动跟随（`ALTER TYPE ... RENAME VALUE`）
- ✅ 概念彻底统一，源代码到 UI 一致
- ❌ 与 `product_kind = '家居产品'` 字面冲突 — SQL/JS 中靠列名/属性名区分两者
- ❌ 需 DB migration + 双库部署 + 全量 grep 替换 + 测试 fixture 同步

### 解读 C（推荐拒绝）：合并字段语义
- 把 `product_type` 与 `product_kind` 合并为同一字段
- ❌ 不可行：`product_kind` 已被多处引用（一级品项 Tab、看板分组、提成矩阵），与"核销逻辑"是正交维度

---

## 3 当前行为 vs 期望行为

### 3.1 当前行为
- **产品标签**：商品详情页同时展示 `product_kind`（家居产品大类）+ `product_type`（院装产品核销方式）— 两个标签并存（参考 `fengyu-staff/miniprogram/packageService/product-detail/product-detail.wxml:24`）
- **业务规则**：`product_type='院装产品'` 时拒绝创建服务单（`staffApi/routes/service.js:106`），不计入预约（`fengyu-client/miniprogram/pagesOrder/orders/orders.ts:51`），通过 `pickup_records` 走提货流程
- **看板口径**：`分客型产品出库 = sale_items.product_type = '院装产品'`（`mgmt-dashboard.js:1335`），口径已存在 ticket `2026-04-25-mgmt-sales-data-INDEX.md` 备注：「`product_type='院装产品'` 比 `product_kind='家居产品'` 更精确，因为前者过滤"门店发货的实物"」
- **同步**：`sync-workfine.js:784` 把 WorkFine 含"家居"或"院装"的字符串都映射为 `product_kind='家居产品'`；`sync-products-from-workfine.js:54` 缺省 `product_type='院装产品'`

### 3.2 期望行为（待用户确认）
- **若选解读 A**：用户/员工/客户在所有 UI 上看到的就是"家居产品"，不再出现"院装产品"字样
- **若选解读 B**：底层 `product_type` 枚举值变为 `家居产品`，与 `product_kind` 同名但分属不同字段；所有代码字面量、SQL 字符串、TS 联合类型一并替换

---

## 4 影响面清单（grep 完整结果）

### 4.1 数据库层（仅解读 B 涉及）

| 文件 | 改动 |
|------|------|
| `db/schema/enums.ts:3` | `productTypeEnum` 第三值 `'院装产品'` → `'家居产品'` |
| `db/migrations/00NN_*.sql`（新增） | `ALTER TYPE "public"."product_type" RENAME VALUE '院装产品' TO '家居产品';` |
| `db/migrations/meta/*` | `npm run db:generate` 自动产出 |
| `db/schema/product.ts:53`、`db/schema/order.ts:150,163`、`db/schema/pickup.ts:10,18` | 注释里的"院装产品"改名 |
| `db/CLAUDE.md:28` | "院装产品提货记录" → "家居产品提货记录" |
| `db/scripts/sync-products-from-workfine.js:43-76,143` | 字面量 `'院装产品'` → `'家居产品'` + 注释 |
| `db/scripts/sync-workfine.js:784-1012` | 同上 |
| `db/scripts/seed-recharge-virtual-product.js:10,105` | SQL 内字面量 + 注释 |

### 4.2 后端云函数层（解读 A/B 都涉及，A 仅注释，B 含字面量）

| 文件 | 行号 | 现状 | 改动（解读 B） |
|------|------|------|----------------|
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 604-606 | `d.productType === '院装产品'` 判定 session_count=null | 字面量替换 |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 2380-2414 | `pickup_records` 创建：WHERE `product_type = '院装产品'` + 注释"院装产品分次提货" | SQL + 注释 |
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 106-107 | `if (si.product_type === '院装产品')` + `INVALID_PARAMS: 院装产品不走到店服务流程` | 字面量 + 错误信息 |
| `fengyu-staff/cloudfunctions/staffApi/routes/card.js` | 158-159 | `productType = '院装产品'`（充值卡 sku 的 product_type） | 字面量 |
| `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js` | 1335-1353 | SQL 5 注释 + `WHERE si.product_type = '院装产品'` | SQL + 注释 |
| `fengyu-staff/cloudfunctions/staffApi/utils/refund.js` | 11 | 注释"单品 / 院装产品" | 注释 |
| `fengyu-client/cloudfunctions/clientApi/routes/card.js` | 300 | INSERT 中 `'院装产品'` 字面量 | 字面量 |

**测试 fixture（必须同步）**：
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js`（多处，~10 处 mock 数据 + 描述文案）
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js:127-144`
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/card.test.js:32-293`
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-dashboard.test.js:1939-2143`

### 4.3 管理后台层（fengyu-admin）

| 文件 | 行号 | 改动（解读 B） |
|------|------|----------------|
| `src/lib/types.ts:190` | `export type ProductType = '疗程卡' \| '单品' \| '院装产品'` → `'家居产品'` |
| `src/lib/schemas.ts:96` | `z.enum(['疗程卡', '单品', '院装产品'])` |
| `src/actions/products.ts:530,1327,1347` | `VALID_PRODUCT_TYPES` 常量 + 联合类型注解 |
| `src/actions/orders.ts:611,688,1084,1184` | 联合类型注解 + `productType: '院装产品'` 字面量 |
| `src/actions/cards.ts:223-229` | 注释 + 联合类型 |
| `src/actions/pickup-records.ts:211-327` | 注释 + SQL `WHERE si.product_type = '院装产品'` + 错误信息"OVER_QUANTITY: ...非院装产品..." |
| `src/lib/refund.ts:11` | 注释 |
| `src/app/(main)/products/create/_components/product-create-page.tsx:151` | `<option value="院装产品">院装产品</option>` |
| `src/app/(main)/products/[id]/_components/product-detail-page.tsx:195` | 同上 |
| `src/app/(main)/orders/_components/order-create-page.tsx:1043,1125` | 联合类型 cast |
| `src/app/(main)/orders/_components/order-create/types.ts:103` | 联合类型 |
| `src/app/(main)/orders/_components/order-create/prepaid-card-picker.tsx:60` | `productType: '院装产品'` |
| `src/app/(main)/pickup-records/_components/pickup-record-create-page.tsx:207-214` | UI 文案"2. 选择院装产品" / "该顾客暂无可提货的院装产品" / "...购买了院装产品..." |
| `src/actions/orders.test.ts:1310-1361` | 测试 mock |

### 4.4 小程序前端层

| 文件 | 行号 | 改动（解读 B） |
|------|------|----------------|
| `fengyu-staff/miniprogram/packageService/service-create/service-create.ts` | 222-225 | `productType !== '院装产品'` 过滤 + 注释 |
| `fengyu-staff/miniprogram/mock/product.ts` | 9, 136-149, 170, 181 | mock 数据 |
| `fengyu-staff/miniprogram/packageOrder/order-detail/order-detail.wxml` | 162 | 注释"创建服务单（已支付 + 非院装产品订单）" |
| `fengyu-client/miniprogram/pagesOrder/orders/orders.ts` | 51 | `i.product_type !== '院装产品'` 过滤 |
| `fengyu-client/miniprogram/pagesOrder/order-detail/order-detail.ts` | 129-132 | 注释 + 字面量 |
| `fengyu-client/miniprogram/pagesOrder/order-detail/order-detail.wxml` | 77 | `wx:if="{{item.product_type === '院装产品'}}"` 显示"已交付"标签 |

### 4.5 规范文档层（.42cog/、notes/）

**强建议解读 A/B 都改**（这些文档面向产品和开发者，统一称呼能减少未来歧义）：

| 文件 | 处数 |
|------|------|
| `.42cog/cog.md` | 41, 57（认知模型） |
| `.42cog/pm/backend.pr.spec.md` | 149, 153, 241, 653, 685（后端规范多处） |
| `.42cog/pm/client.pr.spec.md` | 86, 184, 186, 200, 360 |
| `.42cog/pm/staff.pr.spec.md` | 94, 408 |
| `.42cog/pm/workfine-sync.spec.md` | 45, 309-326, 391 |
| `.42cog/dev/client.sys.spec.md` | 164 |
| `.42cog/design/staff.ui.spec.md` | 460 |
| `.42cog/design/client.ui.spec.md` | 473, 495, 557, 623 |

**已归档的 ticket 引用（保留历史，不强制改）**：`notes/tickets/archives/*` 多处提及，仅做记录用，不影响当前业务。

**研究/参考文档**：`notes/research/workfine_database.md`、`notes/references/backend_pr.md`、`notes/adapt-plans/01-product-mall-refactor.md` — 与历史数据源 UDT_M_341 直接相关，**应保留"院装产品"字样**（这是 WorkFine 原始术语），但可加注「在 PG 中已统一为家居产品」。

### 4.6 client 端云函数 README/测试报告

`fengyu-client/cloudfunctions/clientApi/README.md:170` 与 `测试报告.md:52,58,59,88,187,194` — 历史记录性文档，建议保留并加备注，**不替换**。

---

## 5 推荐方案

### 推荐：解读 B（彻底重命名），但分两阶段执行

**理由**：
1. 用户的诉求就是"全局统一名称"，解读 A 留下底层不一致的技术债，会让后续维护者困惑（"为什么数据库存的是院装产品但 UI 显示家居产品"）
2. PG `ALTER TYPE ... RENAME VALUE` 原子操作，所有现存行的引用自动跟随，无需 UPDATE
3. 影响面虽广但都是字面量替换，机械化操作可由 `/wx-change-propagation` 统一处理

**风险点**：
- ⚠️ `product_type='家居产品'` 与 `product_kind='家居产品'` 同名 — SQL 必须靠列名区分；推荐**所有 SQL 强制带表别名**（已基本符合，需复核）
- ⚠️ 双库迁移：5434/fengyu + 5433/fengyu_wxapp 都要跑 `db:migrate`
- ⚠️ 测试 fixture 量大（~30 处 mock）必须同步替换，否则 jest 失败
- ⚠️ admin 端 `<option value="院装产品">` 的下拉数据库查询历史行 `product_type='院装产品'` 时必须先做迁移，否则会产生 mismatch

### 阶段 1（本 ticket 范围）—— 结构性变更

→ **交接给 `/wx-change-propagation`**，扫描 `'院装产品'` 字面量、`product_type` 枚举类型、相关注释/文档/测试

具体步骤：
1. 改 `db/schema/enums.ts` → `npm run db:generate` 产出 `ALTER TYPE ... RENAME VALUE` migration
2. 临时容器空库验证 migration 可从零 apply
3. 全量替换：
   - `'院装产品'`（带引号字面量）→ `'家居产品'`
   - `院装产品`（注释/UI 文案，需人工逐处审查避免误伤"院装"作为词根的其他场景，如 `'院装' as fallback specName`）
4. TS 联合类型 `ProductType` 同步更新
5. 测试 fixture 全量替换 + `npm test`/`bun run test` 全绿
6. 双库 `db:migrate` 部署

### 阶段 2 —— 文档统一

人工或脚本批量替换 `.42cog/`、`notes/references/`、`notes/adapt-plans/` 中的"院装产品"为"家居产品"，
保留 `notes/research/workfine_database.md`（WorkFine 原始术语）的描述并加备注。

---

## 6 决策点（需用户回复）

1. **方案选择**：A（仅 UI 文案）/ B（枚举值重命名，推荐）/ C（拆为两个独立 ticket）？
2. **范围**：是否包括"WorkFine 同步脚本里的 `'院装产品'` 字面量"？
   - 该脚本已停用（参考 memory `workfine-sync-stopped`），但代码仍在仓库
   - 建议：脚本内同步替换，但保留 `notes/research/workfine_database.md` 的 WorkFine 原始术语
3. **历史文档**：`notes/tickets/archives/*` 中已归档的 ticket 是否需要更新？
   - 建议：**不改**（归档即历史，改动会破坏归档的"时间快照"性质）

---

## 7 验收标准

阶段 1 完成后：
- [ ] `db:migrate` 在两库各执行一次成功，`product_type` 枚举三值变为 `疗程卡 / 单品 / 家居产品`
- [ ] `grep -rn "'院装产品'\|\"院装产品\"" .` 在代码层（排除 archives / WorkFine research 文档）零结果
- [ ] `bun run test`（admin） + staffApi/clientApi `npm test` 全绿
- [ ] 手工冒烟：admin 商品创建页下拉选项、提货录入页文案、staff 开单页过滤逻辑、client 订单详情页"已交付"标签正确显示"家居产品"
- [ ] 看板分客型产品出库口径不变（仍按原 `'院装产品'` 字段值，重命名后跟随）

阶段 2 完成后：
- [ ] `.42cog/` 与 `notes/references/`、`notes/adapt-plans/` 内"院装产品"字样仅在显式标注「WorkFine 历史术语」处保留

---

## 8 回滚策略

阶段 1 回滚（仅在 migration 后业务故障时启用）：
1. 写新的反向 migration：`ALTER TYPE "public"."product_type" RENAME VALUE '家居产品' TO '院装产品'`
2. revert 代码 PR
3. 双库 `db:migrate`

历史快照行不会损坏（PG enum rename 是元数据级操作，不重写数据）。
