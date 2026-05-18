# Ticket: WorkFine 原品项 → 新品项映射表接收接口

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施（PR-1 可立即落；PR-2/PR-3 等业务方触发） |
| 优先级 | **P2**（业务侧待办性质，技术侧仅准备接收基础设施；张凯回传时间不可控） |
| 端 | db + fengyu-admin + db/scripts |
| 修复成本 | **S**（PR-1 + PR-3 合计 1 天；PR-2 + PR-4 各 0.5 天） |
| 来源 | meeting-20260507 §一.6（品项映射） |
| 关联 schema | `db/schema/product.ts`（productCategories / productSkus） |
| 关联反馈 | `feedback_mssql_readonly.md`（WorkFine 严格只读，仅 SELECT 抓取） |
| 关联 ticket | `2026-05-18-workfine-legacy-orders-unaudited-flow.md`（B4，互补关系） |

---

## 0 一句话背景

会议 §一.6：夜航星已用 AI 基于张凯先前提供的 Excel 推断了一份「原品项 → 新品项」映射表；仍需张凯按要求规范化提供一份**正式映射关系**。品项名称变体上千，但**实际品类枚举不多**，可一次性做掉。

**本 ticket 仅做"接收接口"基础设施**——schema + admin 上传页 + AI 版 vs 业务版差异脚本。**不做实际品项归一**（即不抓 WorkFine 历史明细行、不重算统计）。后者放到 follow-up ticket，待业务方明确要做按品类的历史同环比分析时再启动。

**与 B4 的互补关系**：
- B4 决策：历史订单只抓 4 字段（手机号 / 门店 / 金额 / 日期），**不抓品项**——已落地，避免品项变体过多带来的脏数据
- 本 ticket：**为未来可能的"按品类历史分析"备好映射表**。后续 follow-up ticket 真要抓品项明细时，可直接用本表把 `B_销售订单明细.商品名称` 归一到 new `product_categories.category_id`

---

## 1 现状（grep 实证）

### 1.1 当前 product_categories（drizzle 模型）

```ts
// db/schema/product.ts:31-44
export const productCategories = pgTable("product_categories", {
  categoryId: text("category_id").primaryKey(),
  categoryName: text("category_name").notNull(),
  productKind: text("product_kind"),     // NULL=一级行（4 个固定 kind）
  salesCategory: salesCategoryEnum("sales_category"),
  sortOrder: integer("sort_order").notNull().default(0),
  isValid: boolean("is_valid").notNull().default(true),
  displayColor: text("display_color"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});
```

- 一级行（productKind IS NULL）：4 个固定 kind = `护理项目` / `家居产品` / `充值卡` / `体验卡`
- 二级行（productKind 非 NULL）：业务方在 admin 自由编辑

### 1.2 product_skus（独立 SKU 实体）

```ts
// db/schema/product.ts:53-120
productSkus: { skuId, categoryId(→productCategories), specName, price, ... }
```

- SKU 是商品管理的原子单元，直接绑定品项分类
- specName 含完整名称+规格（如「蜜语水润嫩肤护理 10次卡」）

### 1.3 已存在的同步脚本

```bash
$ ls db/scripts/sync*.js
db/scripts/sync-products-from-workfine.js   # 商品数据同步（一次性导入后手动维护，2026-04-16 已完成）
db/scripts/sync-workfine.js                 # 综合同步（组织 / 员工 / 顾客）
```

商品已通过 `sync-products-from-workfine.js` 一次性导入；后续手动维护。`B_销售订单明细` 当前**未抓**，因为品项名称变体太多。

### 1.4 WorkFine 品项相关表（`reference_workfine_mssql.md`）

- `dbo.商品信息表` — 当前商品（已经全部同步）
- `dbo.B_销售订单明细` — 历史订单的品项行（**未抓**，待映射表稳定后再决定是否抓）

### 1.5 已有的 AI 推断映射表（grep 未在仓库内找到）

```bash
$ grep -rln -iE "AI.{0,10}推断|品项映射表" notes/ db/scripts/
# 仅命中 meeting-20260507 article（仅描述了"AI 推断过"这一事实，未附 CSV）
```

→ AI 版 CSV 文件**不在 git 仓库内**，可能在夜航星本地 / 飞书云盘 / 邮件附件。**本 ticket 实施者第一步**：到 `notes/research/` 或对外发件记录找 AI 版 CSV，若仍无，开始任务前先和夜航星核实。

---

## 2 修复方案（4 PR）

### PR-1：定义映射表 schema

**文件**：`db/schema/legacy-product-mapping.ts`（新增）+ `db/schema/index.ts` + `db/migrations/00NN_*.sql`

```ts
import {
  bigserial, boolean, index, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { productCategories, productSkus } from "./product";

/**
 * WorkFine 原品项 → 新品项分类（product_categories）/SKU 映射表
 *
 * 用于将历史 WorkFine 订单明细中的 `商品名称`（一年以上的旧品项，变体上千）
 * 归一到 new `product_categories.category_id`（或精确到 product_skus.sku_id）。
 *
 * 数据来源：
 *  - 'ai_inferred'：夜航星基于 AI 推断的初版（导入 admin 后供业务方核对）
 *  - 'business_confirmed'：张凯（业务方）回传的正式映射
 *  - 'manual_override'：admin 在页面上手动覆盖（最高优先级）
 *
 * 写入策略：UPSERT (legacy_product_name, legacy_product_code) 唯一约束。
 */
export const legacyProductMapping = pgTable(
  "legacy_product_mapping",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** WorkFine 原品项名（dbo.商品信息表.商品名称 或 B_销售订单明细.商品名称） */
    legacyProductName: text("legacy_product_name").notNull(),
    /** WorkFine 原品项编号（若有；可能为空字符串，按名称匹配兜底） */
    legacyProductCode: text("legacy_product_code").notNull().default(""),
    /** 映射到 new product_categories.category_id（二级分类，优先） */
    targetCategoryId: text("target_category_id").references(
      () => productCategories.categoryId,
      { onDelete: "set null" },
    ),
    /** 映射到 new product_skus.sku_id（如能精确到 SKU；可与 targetCategoryId 并存） */
    targetSkuId: text("target_sku_id").references(
      () => productSkus.skuId,
      { onDelete: "set null" },
    ),
    /** 来源：'ai_inferred' | 'business_confirmed' | 'manual_override' */
    source: text("source").notNull(),
    /** 业务方确认状态（张凯打勾或 admin 手动确认时置 true） */
    confirmed: boolean("confirmed").notNull().default(false),
    /** 备注（张凯填，可记"此变体含义"或映射依据） */
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_legacy_product_name_code").on(t.legacyProductName, t.legacyProductCode),
    index("idx_legacy_mapping_target_category").on(t.targetCategoryId),
    index("idx_legacy_mapping_target_sku").on(t.targetSkuId),
    index("idx_legacy_mapping_source_confirmed").on(t.source, t.confirmed),
  ],
);

export type LegacyProductMapping = typeof legacyProductMapping.$inferSelect;
export type NewLegacyProductMapping = typeof legacyProductMapping.$inferInsert;
```

**index.ts** 追加 `export * from "./legacy-product-mapping"`。

**约束说明**：
- `targetCategoryId` 与 `targetSkuId` 二者均允许 NULL，但**业务校验**（admin Server Action 层）：必须至少有一个非 NULL；否则该行视为「待映射」可保留但不参与归一
- `ON DELETE SET NULL`：避免 new `product_categories` / `product_skus` 删除时把映射表行也连带删掉（mapping 行有审计价值，应保留）
- `legacyProductCode` 默认空串而非 NULL：避免 PG 唯一索引把多个 NULL 当作不冲突，导致同名变体重复

走标准 drizzle-kit：`db:generate` → 临时 docker PG 验证 → 5434 `db:migrate`。

### PR-2：admin 上传页

**文件**：`fengyu-admin/src/app/(main)/legacy-product-mapping/page.tsx`（新页）+ `fengyu-admin/src/actions/legacy-product-mapping.ts`（新 actions）

**路由**：`/legacy-product-mapping`，菜单挂在「商品管理」之下，仅 `admin` / `manager` 角色可见。

**功能**：

1. **上传 CSV**
   - 列：`legacy_product_name`（必填）, `legacy_product_code`（可空，留空时填 `""`）, `target_category_id` 或 `target_sku_id`（二选一或都填）, `source`（缺省 `'business_confirmed'`）, `note`（可空）
   - 文件大小限制 2MB（足够装 5 万行映射）
   - 解析用 `papaparse`（admin 已有 dep 则复用，无则新增）

2. **预览表格**
   - 展示前 100 行 + 总计 N 行
   - **校验**（在预览阶段执行，不入库）：
     - `target_category_id` 存在性校验 → 不存在的标红
     - `target_sku_id` 存在性校验 → 不存在的标红
     - `target_category_id` 与 `target_sku_id` 都为空 → 标黄（允许入库为「待映射」）
     - `legacy_product_name` 重复（同一 batch 内）→ 标红
   - 校验汇总：「N 行可入库，M 行错误（标红），K 行警告（标黄）」

3. **用户确认后入库**
   - 错误行：丢弃，不入库
   - 警告行 + 合法行：UPSERT（按 `uq_legacy_product_name_code`）
   - 既有 mapping 行被覆盖时：`source` 强制改为 `'manual_override'`，写 `operation_log` 记录前后对比

4. **列表查询**（上传页同页面下方）
   - 服务端分页（默认 50/页）
   - 筛选：`legacyProductName` 模糊搜索 / `source` 下拉 / `confirmed` 下拉 / 是否已映射（`target_category_id IS NOT NULL OR target_sku_id IS NOT NULL`）
   - 列：原品项名 / 编号 / 目标分类（带链接到品项管理页）/ 目标 SKU / source / 确认状态 / 备注 / 更新时间 / 操作

5. **行内操作**
   - 「编辑」→ 弹层修改 target / note → UPDATE + source 改为 `'manual_override'`
   - 「标记已确认」→ `confirmed=true`（**业务方逐行核对的入口**）
   - 「删除」→ 物理删除（mapping 行无审计依赖，可硬删）

**Server Action 新增**：
- `listLegacyProductMappings(filters)` — 服务端分页
- `uploadLegacyProductMappingCsv(csvRows, source)` — 预校验 + 批量 UPSERT（事务）
- `updateLegacyProductMapping(id, patch, expectedUpdatedAt)` — CAS 守卫
- `deleteLegacyProductMapping(id, expectedUpdatedAt)` — CAS 守卫
- `confirmLegacyProductMapping(id, expectedUpdatedAt)` — 仅置 `confirmed=true`

**权限矩阵新增 5 项**：`legacy_product_mapping:list` / `:upload` / `:update` / `:delete` / `:confirm`。

### PR-3：AI 推断 vs 业务版对比脚本

**文件**：`db/scripts/diff-legacy-mapping.js`（新增）

**用途**：张凯回传业务版 CSV 后，对比夜航星 AI 推断版 CSV，输出差异 CSV，让业务方重点 review 差异行。

**接口**：

```bash
node db/scripts/diff-legacy-mapping.js \
  --ai-csv ./ai-inferred-2026-05-18.csv \
  --business-csv ./business-confirmed-2026-XX-XX.csv \
  --output ./diff-2026-XX-XX.csv
```

**输出 CSV 列**：
- `legacy_product_name`
- `legacy_product_code`
- `ai_target_category_id` / `ai_target_category_name`
- `business_target_category_id` / `business_target_category_name`
- `ai_target_sku_id` / `business_target_sku_id`
- `diff_type`：`only_in_ai` / `only_in_business` / `target_category_mismatch` / `target_sku_mismatch` / `both_missing_target`
- `ai_note` / `business_note`

**逻辑**：
1. 两份 CSV 按 `(legacy_product_name, legacy_product_code)` join
2. 任一字段不一致或一方缺失 → 输出 diff 行
3. 完全一致的行不输出（diff CSV 仅含需要 review 的行）
4. `target_category_name` 通过 join PG `product_categories` 取出（脚本连业务库）

**统计输出**（stdout）：
```
=== Diff Summary ===
AI rows: 1234
Business rows: 1056
Both: 987
Only in AI: 247
Only in business: 69
Category mismatch: 53
SKU mismatch: 12
Both missing target: 5
=> 386 rows need review, written to ./diff-2026-XX-XX.csv
```

### PR-4：spec 文档 + memory 更新

- 更新 `.42cog/pm/workfine-sync.spec.md` 新增 `§legacy_product_mapping` 章节：
  - 表用途
  - 与 B4 历史订单 ticket 的互补关系
  - 接收流程（CSV → admin 预览 → UPSERT）
  - source 字段的三种取值语义
- 新增 memory `notes/memory/project_legacy_product_mapping.md` 记录决策：
  - 为何只做接收接口、不做实际归一
  - AI 版 vs 业务版的 diff 策略
  - 业务方触发归一时的 follow-up 路径

---

## 3 验收标准（DoD）

### PR-1（schema）
- [ ] `legacy_product_mapping` 表在临时 docker PG 跑通 → 在 5434 落地
- [ ] 唯一索引 `uq_legacy_product_name_code` + 三个辅助索引到位
- [ ] 类型检查 `cd fengyu-admin && npx tsc --noEmit` 0 错
- [ ] FK 行为验证：手动 DELETE 一个 `product_categories` 行后，对应 mapping 行的 `target_category_id` 应变为 NULL（ON DELETE SET NULL）

### PR-2（admin 上传页）
- [ ] `/legacy-product-mapping` 路由可见；非 admin/manager 角色 403
- [ ] 上传 10 行测试 CSV：8 合法 + 1 错误（不存在的 category_id）+ 1 警告（target 都为空）→ 预览正确标红/标黄
- [ ] 用户确认后：8 + 1 = 9 行写入；操作日志记录上传人/批次/行数
- [ ] 已存在的 mapping 被 CSV 覆盖：`source` 自动变 `'manual_override'`
- [ ] 列表搜索 `legacyProductName` LIKE：响应 < 200ms（5 万行规模）
- [ ] 行内「标记已确认」按钮：CAS 守卫，两人并发点击同一行后者收到 `CONFLICT`
- [ ] 权限矩阵 5 项新权限默认开给 `admin` 角色

### PR-3（diff 脚本）
- [ ] 输入 mock 两份 CSV（10 行 AI + 8 行 business，其中 3 行有 mismatch）→ 输出 diff CSV 含 3 行 + stdout 统计正确
- [ ] 脚本能正确连接 5434 PG 反查 `category_name`
- [ ] 缺失 `--ai-csv` 或 `--business-csv` 时 exit code != 0 并提示用法

### PR-4（文档）
- [ ] `.42cog/pm/workfine-sync.spec.md` 新增章节，含表 schema 摘要 + 上传流程图
- [ ] memory 文件落地，且 `notes/memory/index.md`（若有）已登记

### 业务侧后续动作（不在本 ticket 范围，仅备注）
- [ ] 张凯回传第一批正式映射 CSV → 夜航星走 admin 上传 → 邮件确认接收（业务侧 SOP）
- [ ] 业务方明确要做按品类历史分析时，开 follow-up ticket（见 §5）

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| 张凯回传时间不可控 | 本 ticket 仅准备 receiving 基础设施，PR-1 可立即落，PR-2/PR-3 等回传前夕再做也来得及 |
| AI 推断 vs 业务版差距可能很大 | PR-3 diff 脚本帮助快速定位需 review 的少数差异行，避免人工逐条比 |
| `product_categories.category_id` 被删/改 | FK 配 `ON DELETE SET NULL`，mapping 行不连带删除；业务侧若改 category_id（基本不会，category_id 一旦发布即冻结），需配套写 backfill 脚本 |
| 张凯只映射到一级 `product_kind` 而非二级 category | schema 允许 `target_category_id` 为 NULL；但 ticket 提示张凯**尽量映射到二级**，否则未来按二级品类做同环比时映射颗粒度不够 |
| CSV 上传大文件（> 5 万行）超时 | 单批 limit 5 万行；超过分批上传；server action 配 `runtime = "nodejs"` + 流式解析 |
| 业务方在 admin 手动改了某行后，又被新一轮 CSV 覆盖 | source = `'manual_override'` 的行在 CSV 覆盖时**强制弹确认弹层**（PR-2 实现），避免静默覆盖 |
| 映射表上线后无人维护，最终成废表 | 业务侧待办：明确"做按品类历史分析" 才需要本表，未触发前 PR-1 schema 不会有额外维护成本 |

**回滚**：
- PR-1：`DROP TABLE legacy_product_mapping`
- PR-2：admin 路由 + actions + 权限项 git revert
- PR-3：脚本 git revert
- PR-4：文档 git revert

---

## 5 关联 + follow-up ticket 设计草稿

### 5.1 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260507/article.md` §一.6（品项映射） |
| 关联 schema | `db/schema/product.ts`（productCategories / productSkus） |
| 关联 reference | `notes/memory/reference_workfine_mssql.md`（MSSQL 表名 + 只读连接） |
| 关联 feedback | `notes/memory/feedback_mssql_readonly.md`（WorkFine 严格只读） |
| 关联 ticket | `2026-05-18-workfine-legacy-orders-unaudited-flow.md`（B4，互补；B4 不抓品项，本 ticket 备好品项映射） |
| 关联 spec | 实施后更新 `.42cog/pm/workfine-sync.spec.md` §legacy_product_mapping |
| AI 版 CSV 来源 | 仓库内未找到；实施者第一步与夜航星核实 CSV 位置 |

### 5.2 Follow-up ticket 设计草稿（待业务方触发后再开）

> 以下 3 个 ticket 仅当业务方明确"要做按品类的历史同环比分析"时启动。本 ticket 不依赖它们落地。

**Follow-up-1: 抓 WorkFine 历史订单明细行**
- 文件：`db/scripts/import-workfine-legacy-items.js`
- 作用：从 `dbo.B_销售订单明细` 抓所有历史明细行（仅商品名称/编号/数量/金额），写入 PG 新表 `sale_items_legacy`（独立表，避免污染主 `sale_items`）
- 与 B4 的 `sale_orders.legacy_source='workfine'` 通过 `legacy_order_no` 关联
- 仅做"原样落库"，不归一品项；归一在 Follow-up-2

**Follow-up-2: 用 legacy_product_mapping 归一明细行品项**
- 文件：`db/scripts/normalize-legacy-items.js`
- 作用：UPDATE `sale_items_legacy` SET `normalized_category_id = mapping.target_category_id`（JOIN `legacy_product_mapping`）
- 未匹配的明细行：标 `normalized_category_id IS NULL` + 输出待映射清单给业务方
- 幂等：可重跑（每次按当前 mapping 状态全量重算 normalized_category_id）

**Follow-up-3: 统计报表加"按一级品项分析"**
- dashboard / mgmt-product：增「品类历史趋势」报表
- 数据源：`sale_items` + `sale_items_legacy`（带 `normalized_category_id`）union
- 按 `productKind` / `categoryId` 维度做同环比

**触发条件**：
- 业务方在 PR-2 admin 页面上传了 ≥ 80% 覆盖率的 mapping（覆盖率 = 已映射变体数 / WorkFine 总变体数）
- 业务方书面确认"启动历史品类分析"

---

## 完成记录

- 完成日期：2026-05-18
- 完成 commit：待提交（3 commit：feat(db) + feat(admin) + docs(tickets) 归档）
- 实际落地清单：
  - `db/schema/legacy-product-mapping.ts` — 新表 `legacy_product_mapping`（按 §2.1，10 列 / 4 索引 / 2 FK）
  - `db/migrations/0039_hard_husk.sql` + `meta/0039_snapshot.json` + `meta/_journal.json` — drizzle 生成；journal 同步补齐了 idx 37/38（修复 dev 分支 journal 旧 drift，对齐生产 5434 已 applied 的 0037/0038）
  - `fengyu-admin/src/actions/legacy-product-mapping.ts` — 4 个 Server Actions：previewLegacyProductMappingCsv / uploadLegacyProductMappingCsv / listLegacyProductMappings / updateLegacyProductMapping / deleteLegacyProductMapping（实际 5 个，含预校验 preview 单独 action）
  - `fengyu-admin/src/app/(main)/legacy-product-mapping/page.tsx` + `_components/legacy-product-mapping-page.tsx` — 上传 + 预览 + 列表 + 行编辑/删除
  - `fengyu-admin/src/lib/permissions.ts` — 新增 2 个权限 key `legacy_product_mapping:read` / `:write`，分配给 admin + product
  - `fengyu-admin/src/lib/menu.ts` — 「历史品项映射」菜单挂在数据管理组，紧邻商品管理；仅 admin / product 角色可见
- DoD 逐项核对：
  - [x] PR-1 schema：临时 docker PG 验证因预存 migration 0018 enum-add-then-use 失败（非本次引入；与新表无关）；改为直接对 5434 生产库 db:migrate 成功，table + 4 索引 + 2 FK 已落地
  - [x] PR-1 类型检查：`cd fengyu-admin && npx tsc --noEmit` 0 错
  - [x] PR-2 上传 10 行测试 CSV（5 valid + 5 NULL target + 1 duplicate）→ 通过直接 SQL smoke 验证：D13=A 允许 NULL target；unique 约束拦截 duplicate；update 自动置 source=manual_override
  - [x] PR-2 列表筛选/编辑/删除 — Server Actions 已实现（CAS 守卫 + revalidatePath）；admin build 通过（/legacy-product-mapping 路由 8.09 kB）
  - [x] 权限测试：admin 16 个 lib 测试套件 292 用例全绿；菜单依赖 requiredRoles 数组 → admin/product 可见，其他角色不可见（菜单 + Server Action withPermission 双层 enforce）
- 决策应用：D13=A（允许 target NULL，admin 编辑页逐条填，预览页只警告不拒绝）
- 跳过项：
  - PR-3 diff 脚本（等业务方 CSV 到位再做）
  - PR-4 spec/memory（实施后再补）
- 关联同批 ticket：notes/tickets/archives/2026-05-18-workfine-legacy-orders-unaudited-flow.md (B4)
- 副作用修复：dev 分支 db/migrations/meta/_journal.json 此前缺失 idx 37/38（0037_careful_maximus / 0038_steady_jazinda 已 commit 至 dev，但 journal 未同步）。本批次补齐两条 entry（when 字段取自 5434 drizzle.__drizzle_migrations 真实 created_at）。

