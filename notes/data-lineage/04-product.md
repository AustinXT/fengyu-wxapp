# 04 — `product` 模块

**Schema 文件**：`db/schema/product.ts`
**涉及 PG 表**：`product_categories`, `product_skus`, `mall_categories`, `products`, `mall_product_skus`, `mall_bundle_groups`
**WorkFine 源表**：`UDT_M_1281`（全国可售项目，481/798 行）/ `UDT_M_1383`+`UDT_S_1382`（门店自定义项目，401/504 行）/ `UDT_M_1460`+`UDT_S_1459`（促销方案明细，285/754 行）/ `UDT_M_341`（家居/院装产品，1940/2043 行）

**主要写入入口**：
- ⚠️ **现行（v2.1 重构后）**：**全部由 `fengyu-admin/src/actions/products.ts` 增删改**（无定时同步）。WorkFine 同步路径已废弃。
- 已废弃：`db/scripts/sync-products-from-workfine.js`（写老表 `product_spu` / `product_spu_sku_map`，已在 archive 0012 一次性 drop）
- baseline 种子（一级分类行）：`_archive/sql/0017_product_categories_hierarchy.sql:L8-13`、`_archive/sql/0029_product_kind_enum.sql:L4-17`
- 一次性结构迁移（旧→新表数据搬运）：`_archive/sql/0012_product_mall_split.sql:L51-85` — SKU 继承 product 字段、product_categories.sales_category 聚合、mall_categories 1:1 复制
- capability 列回填：`db/migrations/0014_broad_thunderbolt.sql:L7-27`（is_card_kind / display_color / requires_shengmei_flag）
- 充值卡虚拟商品 seed：`db/scripts/seed-recharge-virtual-product.js`（写 `prod-recharge-virtual` / `sku-recharge-virtual`）

**PG 现状**（5434/fengyu，2026-04-26 探查）：
| 表 | 总行数 | 备注 |
|----|--------|------|
| product_categories | 55 | 9 行一级（productKind=NULL）+ 46 行二级 |
| product_skus | 1720 | product_type 分布：单品 927 / 疗程卡 769 / 家居产品 24 |
| mall_categories | 49 | 11 一级（categoryGroup=NULL）+ 38 二级 |
| products | 960 | 14 行用 `prod-` 前缀（admin 手工命名），946 行 16 字符 hash（可能为旧脚本残留） |
| mall_product_skus | 1748 | 26 行带 bundle_group_id |
| mall_bundle_groups | 6 | 全部 6 行 pick_count 非 NULL |

**WorkFine 端有效行数**（满足同步脚本 WHERE 条件）：
| WF 表 | 总数 | valid 数 | 推测对应 PG 实体 |
|------|------|---------|-----------------|
| UDT_M_1281 | 798 | 794 | product_skus（全国可售，疗程卡/单品） |
| UDT_M_1383 | 504 | 199 | product_skus（门店自定义，UDF_M_17415='是'） |
| UDT_M_1460 | 754 | 137 | product_skus（仅当前生效促销，27 个 active 促销方案） |
| UDT_M_341  | 2043 | 22  | product_skus（仅 UDF_M_7494='是' 即"可报货"，**WF 端 99% 院装数据未对接**） |

> **关键判断**：PG 1720 SKU ≈ 794+199+137+22 = 1152？**不匹配**。若 v2.1 后管理面手工增补，差额 568 行均为 admin 后台录入。这与 sku_id 前缀分布（仅 20 行用 `sku-` 前缀，其余 1700 行用 16 字符 hash）一致 — 大部分行是历史脚本生成的 hash ID 残留，与当前 admin 手写的 `sku-` 命名空间不同源。

---

## 表 1：`product_categories`（品项分类，2 层：一级 productKind=NULL / 二级带值）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| category_id | text (PK) | WorkFine 派生 / 新系统独立 | ① 历史脚本：`generateId(name, category)` 取 sha256 前 16 字符（`sync-products-from-workfine.js:L36-39, L216`，但写入的是已 DROP 的 product_spu，不应在当前 product_categories 出现）；② 一级行 5 个用硬编码 `cat-cz-01`/`cat-jc-01` 等命名（`seed-recharge-virtual-product.js` 暗示存在）；③ admin 新建：`crypto.randomUUID()`（products.ts:L203, L331） | products.ts:L203 / archive 0017+0029 | PG 现状混合：11 行 `cat-` 前缀（命名空间）+ 44 行 16 字符 hash 残留 |
| category_name | text | WorkFine 派生 / 新系统独立 | ① 二级行（旧）：`UDT_M_1281.UDF_M_14504` / `UDT_M_1383.UDF_M_14504` / `UDT_M_1460.UDF_M_17164` 经过一次性脚本搬入；② 一级行 9 个：archive 0017 硬编码 `福利活动/护理项目/家居产品/充值卡`，archive 0029 改 `福利活动→组合套餐` 并新增 `体验卡`（PG 当前未见 `组合套餐` 一级行，已被改名为 `福利活动`？） | archive 0017:L10-13, 0029:L4-17 | `productKind=NULL` 时为一级类目 |
| product_kind | text | WorkFine 派生 / 新系统独立 | ① 历史 mapBigCategory 派生（`sync-products-from-workfine.js:L61-82`）：`UDT_M_1281.UDF_M_17783`（生美/非生美/是/否） → `'护理项目'`（脚本把所有非家居都归并到护理项目）+ source='UDT_M_341' → `'家居产品'`；② baseline 0000 创建为 enum NOT NULL，0017 改 nullable text，0029 又改 enum 5 值 [组合套餐/护理项目/家居产品/充值卡/体验卡]，0008 现行 schema 又改回 text；③ admin 新建一级行强制 NULL（products.ts:L207），二级行手填 | sync-products:L61-82 + archive 0017/0029 + 0008_aspiring_pride.sql | **数据失真**：WF UDT_M_1281.UDF_M_17783 4 个原值（生美 396/非生美 222/否 157/是 23）全部坍缩为 `'护理项目'`，"生美/非生美"区分丢失 |
| sales_category | sales_category enum | 默认值/NULL / 新系统独立 | ① archive 0012:L59-65 一次性聚合：`UPDATE product_categories pc SET sales_category = (SELECT DISTINCT ON p.category_id p.sales_category FROM products p WHERE p.sales_category IS NOT NULL)` — 当时 products 表还有 sales_category 列；② 之后由 admin 手工编辑 | archive 0012:L59-65 | enum 4 值（自销自耗/他销自耗/他销他耗/生态合作）；archive 0009 把 `自采自销 → 自销自耗`；PG 现状 32/55 行非 NULL |
| sort_order | integer | WorkFine 直拷 / 默认值 | 历史脚本固定 `0`；admin 手填 | sync-products:L227 / products.ts:L208 | |
| is_valid | boolean | 默认值 | 默认 `true`；admin 软删除时改 false | schema:L24 | PG 现状 1/55 行 false |
| is_card_kind | boolean | 默认值 + 一次性回填 | 默认 false；migration 0014:L8-10 把一级行 `category_name IN ('充值卡','体验卡')` 设 true | 0014:L8-10 | PG 现状 2 行 true |
| display_color | text | 默认值 + 一次性回填 | 默认 NULL；migration 0014:L13-22 一级行按 category_name 写死 5 个色值（组合套餐 #C0322A / 护理项目 #1989FA / 家居产品 #5AACA5 / 充值卡 #D4820A / 体验卡 #8B5CF6） | 0014:L13-22 | PG 现状 4/55 行非 NULL（archive 0029 把"福利活动"改成"组合套餐"，但本次 0014 回填使用新名字。"福利活动"一级行未匹配上，**display_color 为 NULL**） |
| display_icon | text | 新系统独立 | NULL / admin 手填 | — | PG 现状 0/55 行非 NULL |
| requires_shengmei_flag | boolean | 默认值 + 一次性回填 | 默认 false；0014:L25-28 把一级行 `category_name='护理项目'` 设 true | 0014:L25-28 | PG 现状 1/55 行 true |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L29 | |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L30 | |

### 已被脚本读但未对接的 WorkFine 列

- ⚠️ **整张 UDT_S_1280 / UDT_S_1382 / UDT_S_1459 主表数据丢弃**：sync-products 仅 JOIN 取 plan_name/market_restriction，主表的 `UDF_S_14497 起始日期` / `UDF_S_14498 是否启用` / `UDF_S_14499 截止日期` 全部未对接，PG 没有有效期版本概念。
- `UDT_M_1281.UDF_M_14502` 产品库（疗程卡/单品） — 同步映射到 SKU 的 product_type，但在 product_categories 上无承载

---

## 表 2：`product_skus`（商品规格，1720 行）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| sku_id | text (PK) | WorkFine 派生 / 新系统独立 | ① 历史脚本：`generateId(spuId, workfine_item_id, source)` sha256 前 16 字符（`sync-products-from-workfine.js:L36-39, L236`），后被 archive 0012 跨表搬来；② admin 新建：调用方传入（products.ts:L571 直接 `data.skuId`） | sync-products:L236 / products.ts:L571 | 1700 行 16 字符 hash + 20 行 `sku-` 前缀 |
| category_id | text (FK→product_categories) | WorkFine 派生 / 新系统独立 | ① archive 0012:L51-56 一次性回填：`UPDATE product_skus sk SET category_id = p.category_id FROM products p WHERE sk.product_id = p.product_id` — 从老 products 继承；② admin 新建直接传入（products.ts:L571） | archive 0012:L51-56 | NOT NULL；33 个 distinct categories |
| product_type | product_type enum | WorkFine 派生 | `mapProductType(UDT_M_1281.UDF_M_14502 / UDT_M_1383.UDF_M_14502 / UDT_M_1460.UDF_M_17162)`：包含 "疗程卡" → `'疗程卡'`；包含 "单品" → `'单品'`；UDT_M_341 source 强制 → `'家居产品'`；其他 → `'疗程卡'` 兜底 | sync-products:L53-58, L232 | enum 3 值（疗程卡/单品/家居产品）；migration 0015 把 `院装产品 → 家居产品` |
| spec_name | text | WorkFine 派生 | ① 老脚本生成 `generateSkuDisplayName()`（"10次卡"/"单次体验"/"院装"）+ archive 0012:L83-85 合并完整名 `p.name + ' ' + sk.spec_name` — **此处把 product 名称塞进了 spec_name**；② admin 新建直接传入 | sync-products:L42-50 + archive 0012:L83-85 | NOT NULL；存的是商品+规格合并字符串 |
| price | numeric(10,2) | WorkFine 派生 | 来自老 product_skus 的 price 列（baseline 已存在，archive 0012 时未改）；老脚本期间从 `UDT_M_1281.UDF_M_14508 / UDT_M_1383.UDF_M_14508 / UDT_M_1460.UDF_M_17171（促销售价）` 抽 | （脚本路径不在 sync-products，应在已删除的旧 SKU INSERT 路径） | NOT NULL；CHECK price >= 0 |
| special_price | numeric(10,2) | 新系统独立 | NULL / admin 手填 | — | PG 现状 12/1720 行非 NULL |
| session_count | integer | WorkFine 直拷 | `UDT_M_1281.UDF_M_14506` / `UDT_M_1383.UDF_M_14506` / `UDT_M_1460.UDF_M_17167`（疗程服务次数） | sync-products:L92, L113, L132 | PG 现状 1697/1720 非 NULL；CHECK >= 1 |
| sort_order | integer | 默认值 | 0 | sync-products:L243 / schema:L55 | |
| service_fee | numeric(10,2) | 默认值/NULL / 新系统独立 | 默认 0；archive 0018_green_rogue.sql 做过 sale_items.service_fee 回填，但 product_skus.service_fee 本身无 WF 来源 | schema:L56 | PG 现状 12/1720 行 > 0 |
| is_shengmei | boolean | WorkFine 派生 | archive 0012:L51-56 从老 products.is_shengmei 继承；老路径推测来自 `UDT_M_1281.UDF_M_17783 = '生美'` → true / `'非生美'` → false / 其他 → NULL（具体脚本未保留） | archive 0012:L51-56 | PG 现状 1003/1720 行非 NULL |
| market_scope | text | WorkFine 派生 | archive 0012:L51-56 从老 products.market_scope 继承；老来源是 `UDT_S_1382.UDF_S_15997`（适用市场/门店）+ `UDT_S_1459.UDF_S_17793`（促销范围）— 全国通用项目 NULL | sync-products:L116, L134, L203, L207 + archive 0012 | PG 现状 335/1720 行非 NULL |
| is_enabled | boolean | 默认值 + 一次性派生 | archive 0021_product_enabled_visible.sql:L11-15 一次性按 `valid_start > now OR valid_end < now → false`，之后 valid_* 列 DROP；现 admin 维护 | archive 0021 | PG 现状 1/1720 行 false |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L62 | INSERT 时间，与业务无关 |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L63 | |

### 已被脚本读但未对接的 WorkFine 列

- ⚠️ `UDT_M_1281.UDF_M_14502` 产品库 — 已用于 product_type，但原值"易大师疗程"被 mapProductType 兜底吞掉
- `UDT_M_1281.UDF_M_14507` 单位（次/瓶/支）— 未对接，PG 无 unit 列
- `UDT_M_1281.UDF_M_14569` 品项细分（三级）— 未对接，PG 仅 2 层分类
- `UDT_M_1281.UDF_M_17411` 外围市场是否可用 — 未对接
- `UDT_M_1281.UDF_M_17477` 招牌定位（明星/招牌/王牌）— 未对接，**PG 损失招牌标签信息**
- `UDT_M_1281.UDF_M_17478 / UDT_M_1383.UDF_M_17479` 昌九贡是否可用 — 未对接
- `UDT_M_1281.UDF_M_20688` 产品无提成 — 未对接（影响提成计算）
- `UDT_M_1383.UDF_M_17415` 是否可用 — 仅作为 WHERE 过滤未写库
- `UDT_M_1460.UDF_M_17170` 折扣金额 — 未对接（PG 无 discount_amount）
- `UDT_M_1460.UDF_M_17174` 是否赠送 — 未对接（**业务关键**，赠品 SKU 与正常 SKU 同等存在）
- `UDT_M_1460.UDF_M_17166` 单位 / `UDT_M_1460.UDF_M_17176/17177` 含义不明 — 未对接

---

## 表 3：`mall_categories`（商城分类，49 行）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| category_id | text (PK) | WorkFine 派生 / 新系统独立 | ① archive 0012:L68-70 一次性 INSERT：`'mall-' \|\| product_categories.category_id`；② admin 新建：用户传入（products.ts:L1228）；③ 套餐分组特例：`mgrp-${Date.now()}`（products.ts:L935） | archive 0012:L68-70 | PG 现状 11 行 `mall-cat-` 前缀 + 11 行 `mall-grou`/`mall-mgrp` + 27 行 `mall-` + 16 字符 hash |
| category_name | text | WorkFine 派生 / 新系统独立 | archive 0012:L68-70 从 product_categories 继承；admin 编辑 | archive 0012:L68-70 / products.ts:L1228 | |
| category_group | text | 默认值/NULL / 新系统独立 | archive 0018_mall_categories_hierarchy.sql 加列默认 NULL；NULL=一级 Tab，非 NULL=二级，值是父 categoryName | archive 0018 + schema 注释 | PG 现状 38/49 行非 NULL（11 行一级 + 38 行二级） |
| sort_order | integer | WorkFine 派生 / 新系统独立 | archive 0012:L68-70 从 product_categories 继承；admin 编辑 | archive 0012 | |
| created_at | timestamp | 新系统独立 | archive 0012 INSERT 时取当时 `product_categories.created_at`；admin 用 `defaultNow()` | archive 0012:L68-70 | |
| updated_at | timestamp | 新系统独立 | 同上 | | |

> archive 0019_mall_categories_drop_is_valid.sql 把原本继承的 `is_valid` 列删除（无软删除）。

### 已被脚本读但未对接的 WorkFine 列

- mall_categories 是**纯展示分类**，与 WF 无映射；只是借了 product_categories 一次性种子。所有 admin 手填字段（如商品分类的实际名称、分组归属）都需要业务侧重新规划。

---

## 表 4：`products`（商城商品，960 行）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| product_id | text (PK) | WorkFine 派生 / 新系统独立 | ① 已废弃路径：`generateId(name, category)`（旧 product_spu.spu_id），archive 0012 之前老 products 表已存在；② 新建：admin 传入或前端用 `prod-` 前缀 | sync-products:L216（已废弃） | PG 现状 14 行 `prod-` 前缀 + 946 行 16 字符 hash |
| category_id | text (FK→mall_categories) | WorkFine 派生 / 新系统独立 | archive 0012:L80 一次性把老 product_id 改为 `'mall-' \|\| category_id`；admin 新建直接传入 mall_categories.categoryId | archive 0012:L78-80 | NOT NULL |
| name | text | WorkFine 派生 / 新系统独立 | 旧路径来自 `UDT_M_1281.UDF_M_14505 / UDT_M_1383.UDF_M_14505 / UDT_M_1460.UDF_M_17165 / UDT_M_341.UDF_M_1871` 的 RTRIM 项目名称；admin 手编 | sync-products:L91, L110, L129, L147 | NOT NULL |
| cover_image | text | 新系统独立 | NULL / admin 上传 | — | PG 现状 1/960 行非 NULL |
| detail_images | text[] | 新系统独立 | NULL / admin 上传 | — | PG 现状 1/960 行非 NULL |
| description | text | 新系统独立 | NULL / admin 手填（sync-products L226 写死 NULL） | sync-products:L226 | PG 现状 10/960 行非 NULL |
| is_bundle | boolean | 默认值 / 新系统独立 | 默认 false；archive 0029 之前没有 bundle 概念，admin 创建时勾选 | schema:L104 | PG 现状 151/960 行 true |
| price | numeric(10,2) | WorkFine 派生 / 新系统独立 | 旧路径：`UDT_M_1281.UDF_M_14508 / UDT_M_1383.UDF_M_14508 / UDT_M_1460.UDF_M_17171（促销售价）/ UDT_M_341.UDF_M_1875`；admin 手编 | sync-products:L101, L114, L132, L151 | NOT NULL |
| special_price | numeric(10,2) | 新系统独立 | NULL / admin 手填 | — | PG 现状 9/960 行非 NULL |
| manage_scope | text | 新系统独立 | NULL=总部；admin 手填 | schema:L108-109 | PG 现状 148/960 行非 NULL |
| market_scope | text | WorkFine 派生 / 新系统独立 | archive 0012 时从老 products 继承的字段；老路径来源同 product_skus.market_scope | archive 0012 | PG 现状 177/960 行非 NULL |
| sort_order | integer | 默认值 | 0；admin 编辑 | schema:L112 | |
| is_enabled | boolean | 默认值 + 一次性派生 | archive 0021:L4-6 一次性按 valid_start/valid_end 派生；admin 维护 | archive 0021 | PG 现状 2/960 行 false |
| is_visible | boolean | 默认值 + seed | 默认 true；seed-recharge-virtual-product.js 把虚拟充值卡设 false（双重隐藏） | seed-recharge-virtual:L83-87 | PG 现状 2/960 行 false（含虚拟充值卡） |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L115 | |
| updated_at | timestamp | 新系统独立 | `defaultNow()` + onUpdate | schema:L116 | |

### 已被脚本读但未对接的 WorkFine 列

- 旧 sync-products 写老 product_spu 时丢弃的字段，archive 0012 已 DROP product_spu，全部丢失。最终迁移如要重做须从 sync-products L86-159 的 4 段 SQL 再抽。
- ⚠️ **UDT_M_341 99% 数据未导入**：valid 仅 22/2043 行（依赖 `UDF_M_7494='是'`），其余 2021 行院装产品 PG 无承载。WF 字段 `UDF_M_1872 规格`/`UDF_M_1873 供货商`/`UDF_M_12636 品牌`/`UDF_M_1874 产品系列`/`UDF_M_1876-1880 多层价格`/`UDF_M_4795/4796 员工购`/`UDF_M_7541 公司进货价` 均**完全丢失**。
- ⚠️ **UDT_S_1280/UDT_S_1382/UDT_S_1459 主表 `UDF_S_14497-14499` 有效期版本** — 完全丢失，PG 没有版本概念。
- ⚠️ **UDT_S_1459 促销方案级字段** `UDF_S_17191 附带现金券金额` / `UDF_S_17193 促销方案套餐售价` / `UDF_S_17175 促销方案名` — 仅 plan_name 进 product_categories.category_name，其余整套促销语义（套餐价/赠券面值）丢失。

---

## 表 5：`mall_product_skus`（商城商品-SKU 多对多关联，1748 行）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial (PK) | 新系统独立 | 自增 | schema:L152 | |
| product_id | text (FK→products) | WorkFine 派生 / 新系统独立 | archive 0012:L73-75 一次性 `INSERT INTO mall_product_skus (product_id, sku_id, sort_order) SELECT product_id, sku_id, sort_order FROM product_skus` — 从老 product_skus 表的 product_id 列搬过来；admin 新建调 addSkuToProduct（products.ts:L668） | archive 0012:L73-75 / products.ts:L668 | 老脚本回填导致 PG mall_product_skus.product_id 实际是历史的 spu_id（hash） |
| sku_id | text (FK→product_skus) | 同上 | 同上 | archive 0012:L73-75 | |
| bundle_group_id | bigint (FK→mall_bundle_groups, nullable) | 新系统独立 | NULL / admin addSkuToProduct 时传 | archive 0020 + products.ts:L668 | PG 现状 26/1748 行非 NULL |
| bundle_price | numeric(10,2) | 新系统独立 | NULL / admin updateSkuBundlePrice 写入 | products.ts:L719 | PG 现状 9/1748 行非 NULL |
| sort_order | integer | 默认值 | 0；admin 编辑 | schema:L163 | |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L164 | |

### 已被脚本读但未对接的 WorkFine 列

- WF 端**没有"商城商品-SKU 多对多关联"概念**。这张表完全是新系统抽象（将 SPU 拆 SKU 后的关联表），无 WF 映射，最终迁移可保持空白后由 admin 维护。

---

## 表 6：`mall_bundle_groups`（套餐分组，6 行）

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial (PK) | 新系统独立 | 自增 | schema:L128 | |
| product_id | text (FK→products) | 新系统独立 | admin 调用 createBundleGroup 传入 | products.ts:L771 | |
| group_name | text | 新系统独立 | admin 手填 | products.ts:L771 | UNIQUE(product_id, group_name) |
| pick_count | integer (nullable) | 新系统独立 | NULL=全选；admin 手填 | schema:L134 | PG 6/6 行非 NULL |
| sort_order | integer | 默认值 | 0 | schema:L135 | |
| created_at | timestamp | 新系统独立 | `defaultNow()` | schema:L136 | |

### 已被脚本读但未对接的 WorkFine 列

- 套餐分组是 v2.1 重构的新概念（archive 0020 加表），WF 没有套餐内"N 选 M"语义。整表完全新系统独立，PG 现状仅 6 行（开发期手工创建），最终迁移留空。

---

## 关键决策摘要

1. **v2.1 商品域重构后，运行时 100% admin 后台维护**：sync-products-from-workfine.js 是已废弃的旧版（写 product_spu / product_spu_sku_map，archive 0012 已 DROP）。WorkFine 数据通过 archive 0012 一次性结构搬运（product_skus.category_id 从老 products 继承、mall_categories 1:1 复制 product_categories）后断开同步链。
2. **product_kind 的 4 次反复**：baseline 0000 enum NOT NULL → archive 0017 nullable text → archive 0029 enum 5 值（含组合套餐/体验卡） → migration 0008 又改回 text。这导致 product_categories.product_kind 的语义随时间漂移，旧二级行的 product_kind 是改名后的字符串。
3. **archive 0012:L83-85 把 product.name 塞进了 spec_name**：`UPDATE product_skus sk SET spec_name = p.name || ' ' || sk.spec_name` —— 现 PG product_skus.spec_name 包含完整商品名+规格组合（如"蜜语水润嫩肤护理 10次卡"），不可拆。最终迁移做 SKU 命名时要意识到这是合并字段。
4. **WF 数据完全丢失字段**：
   - 招牌定位（UDF_M_17477：明星/招牌/王牌）
   - 是否赠送（UDF_M_17174）
   - 单位（UDF_M_14507）
   - 三级品项细分（UDF_M_14569）
   - 院装产品 99%（UDT_M_341 仅 22/2043 valid）
   - UDT_S_1280/1382/1459 主表的有效期版本（UDF_S_14497-14499）
5. **migration 0014 capability 列回填基于"组合套餐"硬编码，但实际 PG 一级行名为"福利活动"**：display_color 仅命中 4/5 个一级行，**福利活动行 display_color 为 NULL**（PG 现状已确认）。
6. **mall_product_skus 行数 (1748) 大于 product_skus (1720)**：archive 0012:L73-75 时直接从老 product_skus 表（含 product_id 列）回填，但 1748 行说明后续 admin 又添加了 28 个 SKU 关联到现有商品（多对多场景），符合预期。
7. **充值卡虚拟商品** `prod-recharge-virtual` / `sku-recharge-virtual` 是 seed 脚本新建的固定行，绑定 `mall-cat-cz-01` / `cat-cz-01`，is_visible=false / is_enabled=false 双重隐藏。最终迁移须保留该行（用于 client.card.recharge 走销售单模型）。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- **product_kind 数据失真**：UDT_M_1281.UDF_M_17783 4 个原值（生美/非生美/是/否）全部坍缩为 `'护理项目'`，生美/非生美区分丢失
- **display_color 一级行 5 中 4**：migration 0014 用"组合套餐"匹配，PG 实际名为"福利活动"，导致该行 display_color 为 NULL
- **product_skus.special_price / service_fee / market_scope** 大量 NULL，无 WF 映射
- **products.cover_image / detail_images / description** 几乎全 NULL，依赖 admin 后续录入
- **UDT_M_341 99% 数据未导入**（valid 仅 22/2043 行），院装产品多层价格/品牌/系列/规格全部丢失
- **UDT_M_1281.UDF_M_17477 招牌定位**（明星/招牌/王牌）未对接，PG 无 banner_position 列
- **UDT_M_1460.UDF_M_17174 是否赠送** 未对接，赠品 SKU 与正常 SKU 无法区分
- **UDT_M_1281.UDF_M_14507 单位**（次/瓶/支）未对接，PG 无 unit 列
- **UDT_M_1281.UDF_M_14569 品项三级细分** 未对接，PG 仅 2 层分类
- **UDT_M_1460.UDF_M_17170 折扣金额** 未对接
- **UDT_M_1281.UDF_M_20688 产品无提成** 未对接（影响提成计算）
- **UDT_S_1280/1382/1459 有效期版本（UDF_S_14497-14499）** 完全丢失
- **UDT_S_1459 促销方案级字段**（UDF_S_17191 附带现金券、UDF_S_17193 套餐售价）未对接
- **product_categories.category_id / products.product_id / product_skus.sku_id 命名混杂**：早期 16 字符 sha256 hash + 后期 admin 手写 `cat-`/`prod-`/`sku-` 命名空间 + 套餐分组 `mgrp-${Date.now()}`，最终迁移需统一规范
- **mall_product_skus.product_id 实际指向历史 spu_id**：archive 0012:L73-75 一次性回填，**最终迁移如重写 product_id 编号需同步更新此表**

---

## Review 报告（2026-04-26）

**复核者**：fresh agent（独立调研后比对，5434/fengyu 与 WorkFine 抽样验证）
**Verdict**：**minor-fix**（主体结构与字段映射正确，存在若干叙述错误与统计不准）

### 总览

- 一致项：≈ 38（6 张表的列字段清单、WF 来源映射、archive 0012 跨表搬运、0014 capability 回填硬编码命中失败的关键判断、虚拟充值卡 seed、archive 0021 valid_start/end 派生 → is_enabled、archive 0020 套餐分组架构、`mgrp-${Date.now()}` 实际未在数据中出现、mall_product_skus 1748 > product_skus 1720 的多对多新增解释，等）
- 不一致项：**8**（其中 1 项错位归类、3 项叙事错误、3 项统计偏差、1 项缺漏的 seed 入口）

### 偏差明细

#### A. 缺漏

1. **`fengyu-admin/src/db/seed.ts` 完全未提及**（doc"主要写入入口"小节遗漏）。这是 admin 端核心 seed 文件，按 FK 顺序写：
   - `productCategories`：5 个一级行（`kind-combo/kind-care/kind-home/kind-card/kind-trial`）+ 11 个二级行（`cat-hl-01..03 / cat-hr-01..03 / cat-jj-01..02 / cat-cz-01..02`）— 含 capability 列直接硬编码
   - `mallCategories`：4 个一级分组（`mall-group-care/mall-group-combo/mall-group-home/mall-group-card`）+ 10 个二级（`mall-cat-*`）
   - `products`：14 行（`prod-001..014`）— 解释了 doc 提到的 "14 行 prod- 前缀"
   - `productSkus`：14+ 行（`sku-001-01..` 等）— 解释了 doc 提到的 "20 行 sku- 前缀"
   - 该 seed 的存在解释了 doc 表 1 中 "11 行 cat- 前缀" 一级行列表前缀分布的真实来源（其中 `kind-*` 5 行未出现在 PG 现状中，因为生产库使用了 admin 后台手建+UUID）。
2. admin 写入入口未列：`removeSkuFromProduct`（products.ts:L687）、`updateMallBundleGroupId`（products.ts:L843）、`createMallCategoryGroup`（products.ts:L935）、`createMallCategory`（products.ts:L1218，**注意 categoryId 由调用方传入，非自动生成**）、`updateMallCategory` / `deleteMallCategory` 等 — 仅举一处 `addSkuToProduct/createBundleGroup/updateSkuBundlePrice` 不完整。

#### B. 错配（最严重一项）

3. **`mgrp-${Date.now()}` 张冠李戴**：doc 表 1 product_categories.category_id 备注里写 "套餐分组特例：`mgrp-${Date.now()}`（products.ts:L935）"。
   - 实际 products.ts:L935 是 `createMallCategoryGroup` 写入 **mall_categories**（**商城一级分组 / Tab**），与 product_categories 完全无关。
   - 套餐分组 `mall_bundle_groups` 用 **bigserial 自增 PK**（schema:L128），**根本不是 text**，更没有 mgrp- 前缀。
   - 而且实测 PG 49 行 mall_categories 中 0 行匹配 `mgrp-` 前缀（11 行 `mall-group-*` 是 admin 通过 `createMallCategory`（L1218）传入的自定义 ID）—— `mgrp-${Date.now()}` 这个生成路径目前在数据上未被触发。
4. **product_kind 演化时间线 4 次反复叙述错误**（doc 关键决策 #2）：
   - doc 写"baseline 0000 enum NOT NULL → archive 0017 → archive 0029 enum 5 值 → migration 0008 又改回 text"。
   - 实测 baseline 0000.sql:L18 = `CREATE TYPE product_kind AS ENUM('护理项目', '家居产品', '充值卡', '体验卡')`（4 值，**non-NOT NULL**），列定义 `"product_kind" "product_kind"` 也是 nullable（baseline 0000:L92）。
   - baseline 0000 之后，把 enum → text 的是 **migration 0005**（true_doctor_faustus.sql：`ALTER TABLE product_categories ALTER COLUMN product_kind SET DATA TYPE text; DROP TYPE product_kind;`），**不是 0008**。0008 是 `aspiring_pride.sql`，加 old_member_level / sale_items.is_shengmei / service_items.is_shengmei，与 product_kind 无关。
   - 此外 archive 0017/0029 是 baseline-pre 历史，baseline reset 后已被 0000 一次性吸收，doc 的"4 次反复"叙事在当前 schema 链上不成立。
5. **product_categories.category_id 前缀分布说错**：doc 表 1 备注 "PG 现状混合：11 行 cat- 前缀（命名空间）+ 44 行 16 字符 hash 残留"。
   - 实测 55 行 = **11 行 cat- + 11 行 UUID（admin via crypto.randomUUID）+ 33 行 hash16**（其中 9 一级行全部是 UUID，包括 admin 后加的"222/招牌/王牌/明星"4 行）。
   - 漏掉了 11 行 UUID 这一支。
6. **mall_categories.category_id 前缀分布说错**：doc 表 3 写 "11 行 mall-cat- 前缀 + 11 行 mall-grou/mall-mgrp + 27 行 mall- + 16 字符 hash"。
   - 实测 49 行 = **11 行 mall-cat- + 11 行 mall-group- + 27 行 mall-{16char-hash}**，**没有任何 mall-mgrp- 或 mgrp- 行**（11 行 mall-group-* 是 admin 通过 createMallCategory 手动传入，对应分组 care/combo/home/card/custom/intimate/jlf/other/shengmei/tech/welfare/wellness）。

#### C. 数据不一致（PG 抽样事实纠正）

7. **product_categories.is_valid=false 行数严重低报**：doc 表 1 备注 "PG 现状 1/55 行 false"。
   - 实测 **14/55 行 is_valid=false**：13 个二级 hash16 行（"娇莉芙-生美/盛泰/合作美芯/合作医美/七维/KS/家居产品/对外合作/招牌/基础生美/改变/王牌" + "其他"，全部 product_kind='护理项目'）+ 1 个一级行（"222"，product_kind=NULL）。
   - 这意味着开单页 / 商城展示需要排除的"已停用"分类比 doc 描述的多 13 倍。
8. **PG 实际 9 个一级行的清单未列全**：doc 表 1 顶部说 "9 行一级"，但叙述里仅枚举 5 个标准一级（福利活动/护理项目/家居产品/充值卡/体验卡）。实测 9 行 = 上述 5 个 + admin 后加的 **"222"（is_valid=false）/ "招牌" / "王牌" / "明星"** 4 个 capability 全 NULL 的临时类目（sort_order 6/7/8/8）。这些行 0014 capability 回填全部未命中，存在前端渲染兜底依赖。

#### D. 过时事实

（无新增 — doc 中关于 `sync-products-from-workfine.js` 写已 DROP 表的描述、archive 0012 跨表搬运、virtual recharge seed 等都仍准确。）

### 一致项（高保真）

- 6 张表的字段清单与类型 100% 匹配 schema/product.ts
- WorkFine 各源表 valid 行数（798/794, 504/199, 754/137, 2043/22）与 MSSQL 抽样完全一致
- UDT_M_1281.UDF_M_17783 4 个原值分布（生美 392 / 非生美 222 / 否 157 / 是 23）→ 全部坍缩 '护理项目' 的"数据失真"判断正确
- mbg_total=6 / pickcount 全填 / mps_bundle_grp=26 / mps_bundle_price=9 / products.is_visible=false=2 / sku.is_enabled=false=1 / sku_distinct_cat=33 — 全部匹配
- 0014 capability 回填用"组合套餐"导致"福利活动"行 display_color=NULL 的关键判断已被 PG 现状证实（PG 一级行 "福利活动" display_color 实测 NULL）
- 虚拟充值卡 SKU `sku-recharge-virtual` 现状 (`spec_name='预付充值卡（虚拟）'`, product_type='家居产品', is_enabled=false) 与 doc 描述一致
- archive 0012 SQL 行号引用（L51-56 / L59-65 / L68-70 / L73-75 / L78-80 / L83-85）全部精确

### 建议修复（minor-fix）

1. 在"主要写入入口"补一行 `fengyu-admin/src/db/seed.ts`（kind-* / cat-hr-* / mall-group-* / prod-001..014 / sku-001-01..）
2. 表 1 product_categories.category_id 备注修正为 "11 cat- + 11 UUID + 33 hash16"
3. 表 1 product_categories.is_valid 备注修正为 "PG 现状 14/55 行 false（13 二级 + 1 一级）"
4. 表 1 顶部一级行枚举补全 "+ 222/招牌/王牌/明星"，并标注后 4 行 capability 全 NULL
5. 表 1 删掉 "套餐分组特例：mgrp-${Date.now()}（products.ts:L935）" — 这是 mall_categories 一级分组的特例，应移到表 3 mall_categories
6. 表 3 mall_categories.category_id 备注修正为 "11 mall-cat- + 11 mall-group- + 27 mall-{16char}"，**删掉 mall-mgrp** 提法
7. 关键决策 #2 "product_kind 4 次反复" 改写为：baseline 0000 = enum nullable 4 值 → migration 0005 enum→text DROP TYPE → migration 0014 capability 列回填使用现行 5 个一级名（含"组合套餐"）。archive 0017/0029 移入"历史背景注释"。

### Verdict

**minor-fix** — 字段血缘与映射准确度高，但 6-8 处叙述/统计偏差影响可信度，建议按上述 7 点修订。无 P0 业务/资损/越权问题。

---

## Edge Case 报告 R2（2026-04-26）

**复核者**：fresh agent（独立 8 维风险维度主动挖掘，5434/fengyu + WorkFine MSSQL 抽样验证）
**Verdict**：**serious-edge-cases**

8 类风险维度命中：**8/8**（FK 孤立 ✓ / NULL 极值 ✓ / enum 漂移 ✓ / unique 守住 ✓ / 跨模块一致性 ✓ / 死代码 ✓ / dump-restore 残留 ✓ / 运行时安全 ✓）

### 高危发现（按严重度排序）

#### P0 — 466 行疗程卡 SKU `session_count < 2` 违反 schema 业务语义（CHECK 约束有缝隙）

- 位置：`db/schema/product.ts:69` `check('chk_sku_session_count', sql`${session_count} IS NULL OR ${session_count} >= 1`)`
- schema 注释 line 53：**"疗程卡≥2，单品=1，家居产品=null"**
- 实测：`product_type='疗程卡' AND (session_count IS NULL OR session_count<2)` = **466/769 行（60.6%）**
- 根因：CHECK 仅守 `>= 1`，但业务约束是疗程卡 `>= 2`；老脚本 `mapProductType` 把 "易大师疗程"/单品被误判等都兜底为疗程卡（原 `UDT_M_1281.UDF_M_14502 含'疗程卡'`），但 SKU 实际只有 1 次（即"单次体验"），数据写入时 session_count=1 也通过了 CHECK
- 实数据样例：`spec_name='深V文胸 单次体验'`、`'紫熏之花文胸 单次体验'`，product_type 全是 `'疗程卡'`
- 业务影响：开单页/服务核销/卡明细各处都按 `product_type='疗程卡'` 二分逻辑取 `session_count` 做"剩余次数"快照；**这 466 个 SKU 实际是单品被误打成疗程卡，下游会把 1 次卡的 spec 当作多次疗程卡处理**（remaining_sessions=1 但 UI 称"疗程卡剩余 1 次"）
- 修复：
  - A 修 product_type：批量把 spec_name LIKE '%单次体验%' 且 session_count=1 的 466 行 → product_type='单品'
  - B 严化 CHECK：`(product_type='疗程卡' AND session_count >= 2) OR (product_type='单品' AND session_count = 1) OR (product_type='家居产品' AND session_count IS NULL)`

#### P0 — `mall_product_skus` 17 行 `bundle_group_id` 非空但 `bundle_price` 为 NULL（套餐内"N 选 M"价格丢失）

- 位置：admin `products.ts:706` `updateSkuBundlePrice` 与 `addSkuToProduct` 解耦，先建分组再单独编辑价格
- 实测（B9_bundle_inconsistency）：`grp_no_price=17, price_no_grp=0, both=9`
- 业务影响：套餐结算时该 SKU 命中分组但取价 fallback 到 `product_skus.price`（标价），用户预期套餐内优惠价但实际收全价 → 资损
- 修复：
  - A 立即：补 `bundle_price = product_skus.price` 或显式 0；admin 强制 addSkuToProduct 时同时填 bundle_price（合并入参）
  - B schema：加 CHECK `(bundle_group_id IS NULL) OR (bundle_price IS NOT NULL)`

#### P0 — `products.is_bundle=true` 但 0 个 `mall_bundle_groups` 行：149/151 套餐缺分组（98.7% 套餐无 N 选 M 配置）

- 实测（A10_bundle_no_groups）：`is_bundle=true 共 151 行，其中 149 行 NOT EXISTS bundle_groups`；同时 18 行 `is_bundle=true` 但 mall_product_skus 关联 ≤1 个 SKU（K1_bundle_with_only_1_sku）
- 业务影响：客户端 `clientApi/order.create` / `staffApi/order.create` 套餐分组逻辑（pickCount 校验）会因 0 行 group 而静默放过；前端展示套餐结构靠 mall_bundle_groups → mall_product_skus 链，149 个套餐前端"分组选项"为空
- 修复：
  - A 数据：149 个套餐补一个默认 `groupName='全选'` + `pickCount=NULL`（语义 = 全选）
  - B schema 一致性约束：CHECK `(is_bundle=false) OR EXISTS (SELECT 1 FROM mall_bundle_groups WHERE product_id=...)` —— PG 不支持子查询 CHECK，改为应用层守卫或 DEFERRABLE FK trigger
  - C admin createProduct 标记 isBundle=true 时强制在同一事务内创建至少 1 个 bundle_group

#### P1 — 204 行 `product_skus.price = 0` 通过了 `chk_sku_price >= 0` 但语义异常

- 实测（B2_skus_negative_or_zero_price）：`zero_price=204, negative_price=0, max_price=108000.00`
- 同时 `products.price=0` 也有 4 行
- 来源：admin 创建 SKU 时未填价格 / 旧脚本 fallback 0；CHECK 仅守非负
- 业务影响：开单时取 unit_price=0 → 客户免单；折扣引擎计算可能除零
- 修复：
  - A schema：CHECK `price > 0 OR product_kind='福利活动'`（福利项目可能合法零价）
  - B admin 表单：禁止 price=0 提交，给"赠品"打 is_gift 标志位（参见字段扩展候选 #5）

#### P1 — 10 个 dropped column 残留 attisdropped=true（4 张表 baseline reset 没真重建）

- 实测（G1_dropped_columns）：products(5) / mall_categories(1) / product_skus(4) — 共 **10 个 ghost 列**
- 与 01-order 同类问题（sale_orders 1 个 ghost），全表 dump 时数据冗余 + 可能影响 `pg_dump` 顺序
- 影响：表元数据不干净，无业务影响但 baseline reset 不彻底
- 修复：`pg_repack` 或 `VACUUM FULL product_skus, products, mall_categories`

#### P1 — `product_categories.product_kind` 与列名 enum 漂移 — schema 已是 text 但仅 5 个值流通

- 实测（C3_product_kind_distinct）：`护理项目=39, NULL=9, 家居产品=4, 充值卡=2, 体验卡=1`
- 共 5 个值（含 NULL）；但 schema 是 text **无任何约束**
- 历史枚举曾包含 `福利活动 / 组合套餐` 但现状 0 行；F2 一级行 9 行中 4 行（"222/招牌/王牌/明星"）capability 全 NULL，是 admin 后台手填测试残留
- 影响：mgmt-product.js / order.js / card.js 各处 SQL `WHERE product_kind = '充值卡'` 等于硬编码字面量；任何 admin 错填 product_kind（如打错字"护理项目 "带尾空格）会导致整片业务消失
- 修复：
  - A schema：恢复 enum 5 值（护理项目/家居产品/充值卡/体验卡）+ 单独 NULL 表示一级行
  - B admin 表单：product_kind 改为下拉枚举选择，禁止自由文本

#### P1 — `product_skus.spec_name` 严重重复（`深V文胸 单次体验` 1 个 SKU 出现 31 次！）

- 实测（D2_dup_spec_name）：top 5 重复全是"单次体验"类（深V文胸 31, 紫熏之花文胸 31, 微雕聚拢文胸黑 15, 优弧微雕黑 12 ...）
- products 重名也严重：`测试1` 3 次、`法米索持妆美颜乳/T65橙红` 2 次（D3）
- 来源：早期脚本 generateId(name, category) hash 把不同 SPU 的同名"单次体验"区分为不同 sku_id，但 spec_name 文本相同；archive 0012 把 product.name 拼到 spec_name 后没去重
- 影响：开单/前端搜索"深V文胸"列出 31 行价格 quantity 全相同的"伪 SKU"，员工无法区分
- 修复：
  - A 数据：合并 spec_name 相同+price 相同的 SKU，迁移 sale_items.sku_id 引用
  - B schema：UNIQUE INDEX(spec_name, price) 禁止后续重复

#### P1 — `bound_employee_id`-style 误用：`product_skus.market_scope` 数据失真

- 实测（C4）：market_scope 非空 335 行，集中在 `南昌市场2`(182)、`九江市场`(56) 等，但同样有 `Y九江市场`(9) — `Y-` 前缀是 sync-workfine 区分"新建 vs 老门店"的内部标记，**不是合法的市场名**
- 同样 products.market_scope = "Y九江市场"(1)、manage_scope=南昌市场2(137)
- 影响：当 SKU 的 market_scope = "Y九江市场" 时，前端按"南昌市场"筛选会漏掉这 9 行；按"Y九江市场"筛选 0 行（前端不会暴露 Y- 选项）
- 修复：sync 脚本写库前去 Y- 前缀，或一次性 UPDATE 修

#### P2 — 1674/1720 行 `product_skus` 在 `sale_items` 中**从未被引用**（97.3% SKU 是死数据）

- 实测（E2_skus_unused_in_sale）：1674 行 SKU 在 PG 任何 sale_items 都没出现
- 推测：迁移期一次性灌入了所有 WF 历史 SKU（含早已停售/促销过期），但实际生产订单只用到 46 个活跃 SKU
- 影响：admin 商品列表/前端搜索 SKU 时充斥大量历史死数据；但本身无 FK 风险（FK is_enabled 没设置）
- 修复：长尾批量 is_enabled=false；或定义清理规则（创建 > 6 个月且无销售记录）

#### P2 — `products` 6 行无任何 `mall_product_skus` 关联（products.product_id 在 mall_product_skus 中 0 行）

- 实测（E4_products_no_sku）：6 行 products 没 SKU 关联
- 含义：商城展示有商品行但点进去没 SKU 可买；客户端 product.skuList 返回空数组
- 修复：业务侧补关联或软删商品

#### P2 — 19 行 `product_skus`、11 行 `products` 自创建后从未更新（updated_at = created_at）

- 实测（I1/I2）：19 + 11 行自创建以来从未编辑
- 含义：dropped column 残留以外，updated_at trigger 工作正常但这部分历史行用 archive 0012 INSERT 时一次性写入，从未被 admin 编辑过
- 风险低：纯 cold data，但意味着商品没经管理员审过

#### P3 — `category_id` 三套命名空间混存：UUID(11) + sha16(33) + cat-(11)

- 实测（G2）：product_categories 55 行 = 11 cat- + 33 hex16 + 11 UUID
- doc R1 表 1 备注只说"11 cat- + 44 hash"，**漏掉 11 行 UUID**（admin via crypto.randomUUID()）
- 修复：见原 doc R1 修复点 #2

### 8 类维度详细命中

| # | 维度 | 探针 | 关键命中 |
|---|------|------|---------|
| 1 | FK 孤立 | A1-A11 | A10=149 行 is_bundle 无 group / A9=17 行 grp 无 price / 6 行 products 无 SKU；FK 完整性本身（PG 强制）OK |
| 2 | NULL/极值 | B1-B8 | B4 疗程卡 466 行 session_count<2（P0）/ B2 204 SKU price=0 / B3 4 products price=0 |
| 3 | enum 漂移 | C1-C7 | C3 product_kind 5 值 schema 无约束 / C4 market_scope `Y九江市场` 残留 |
| 4 | unique | D1-D4 | D1 5 组分类同名 / D2 spec_name 重复达 31 行 / D3 product name 重复 |
| 5 | 跨模块 | E1-E4 | E2 1674 行 SKU 是死数据 / E4 6 products 无 SKU |
| 6 | 死代码 | F1-F5 | F2 9 行一级行中 4 行 capability 全 NULL（admin 测试残留 222/招牌/王牌/明星） / display_icon 整列 0 行 |
| 7 | drift | G1-G5 | G1 10 个 dropped column 残留 / G3 sku_id 命名混杂（hex16=1700 + sku-=20）|
| 8 | 运行时安全 | — | admin/products.ts 写入路径全部走 db.transaction（OK）；批量编辑 mallProductSkus 已用参数化；无 SQL 注入位点 |

### Verdict

**serious-edge-cases** — 4 个 P0 + 4 个 P1，主要集中在：① 疗程卡/单品类型混用导致 466 行 SKU 业务语义失真 ② 套餐数据骨架缺失（149 套餐缺分组 + 17 套餐 SKU 缺优惠价）③ 列约束太松导致脏数据通过（price=0、session_count=1 在疗程卡）。修复优先级：业务 P0（套餐缺分组、bundle_price 缺）→ 数据清洗（疗程卡 vs 单品分裂）→ schema 加严（CHECK + enum）。

---

## 字段扩展建议 R2（2026-04-26）

用户明确要求"迁移数据覆盖更多字段"。以下为基于 04-product.md doc 体的"已被脚本读但未对接"清单 + R2 探针在 WorkFine MSSQL 端实际验证后产出的候选字段（按优先级排序）。

### 候选字段表

| # | WorkFine 源 | PG 应新增列 | 类型 | 优先级 | 业务理由 | 抽取式 | PG 数据量 | 依赖 |
|---|------------|------------|------|-------|---------|-------|---------|------|
| 1 | `UDT_M_1281.UDF_M_20688` 提成分类（5 值：自销自耗/他销自耗/他销他耗/生态合作/产品无提成）填充率 798/798=100% | `product_skus.commission_class` | text (NOT NULL，default '自销自耗') | **P0** | **影响提成计算**：commission_rate_matrix 已按 sales_category 路由提成比例，但目前 PG sales_category 在 product_categories 层（粗粒度，55 行），SKU 层细粒度的 `commission_class` 缺失。R2 实测 174 行 SKU = "产品无提成"，按现行逻辑这 174 个 SKU 的销售员仍会拿到提成 — **资损隐患** | `RTRIM(UDF_M_20688)` 直拷 | 1720 SKU 全部回填 | 加列 + 同步脚本扩 + commission 计算路径加分支 |
| 2 | `UDT_M_1460.UDF_M_17174` 是否赠送（'是'=202 / '否'=549 / 空=3） | `product_skus.is_gift` | boolean (NOT NULL，default false) | **P0** | **赠品 SKU 与正常 SKU 同等存在**：当前促销方案明细共 754 行其中 202 行是赠品，PG 没有任何标志位，开单 / 财务对账 / 提成计算时无法区分"卖出品 vs 赠出品" — 直接资损 + 财务记账错误 | `RTRIM(UDF_M_17174) = '是'` | 仅 754 行促销 SKU 有源；其他 default false | 加列 + admin 表单加 isGift checkbox + order.create 提成跳过 is_gift |
| 3 | `UDT_M_1281.UDF_M_14507` 单位（次=600/件=116/瓶=21/只=16/支=12/台=7 等 17 distinct，填充率 798/798=100%） | `product_skus.unit` | text (nullable) | **P1** | 开单页明细行展示"× 1 次/瓶/支"，目前所有 product_type='单品' 的家居产品都用硬编码"件"展示，导致客户看到"水分精华乳 × 1 件"实际应是"× 1 支"；财务报表也需要单位用作库存折算 | `RTRIM(UDF_M_14507)` | 1720 SKU；UDT_M_341 院装产品需补"件"等 default | 加列 + sale_items 快照同步加 unit_snapshot |
| 4 | `UDT_M_1281.UDF_M_17477` 招牌定位（明星=379 / 王牌=140 / 招牌=28 / 否=23 / 绝对招牌=3，填充率 573/798=72%） | `product_skus.banner_label` | text (nullable) | **P1** | 业务侧"招牌项目""明星项目"在前端有专门的标签栏（小程序首页/活动推荐位），目前完全靠 admin 后台手动维护一级类目"招牌/明星/王牌"3 行 capability 全 NULL 的临时类目（R2 F2 已证）；正确路径应是 SKU 级别打 banner_label 标签 | `CASE RTRIM(UDF_M_17477) WHEN '否' THEN NULL ELSE RTRIM(UDF_M_17477) END` | 798 行有源，1720 SKU 填充率 ~36% | 加列 + 前端 promotion 模块改用该列 |
| 5 | `UDT_S_1280.UDF_S_14497` 起始日期 / `UDF_S_14499` 截止日期（datetime2，填充率 100%）+ `UDF_S_14498` 是否启用（"是"/"否"） | `product_skus.valid_start` (date) / `valid_end` (date) | date (nullable) | **P1** | 当前 PG 的 `is_enabled` 是 archive 0021 一次性按 valid_start/valid_end 派生后**列已 DROP**，运行时无版本控制能力。但 WF 端有 798(M) + 504(M_1383) + 754(M_1460) ≈ 2056 个 SKU 都有有效期，未来"促销自动上下架""疗程卡到期"等业务无依据 | UDT_S_1280 LEFT JOIN，`UDF_S_14497::date / UDF_S_14499::date`；过滤 `UDF_S_14498='是'` | 1720 SKU 主要从 1280/1382/1459 LEFT JOIN | 加 2 列 + cron-worker 加 STEP 6 自动按 valid_end 翻 is_enabled |
| 6 | `UDT_M_341.UDF_M_1872` 规格（如"40g/瓶""15ml/支"）+ `UDF_M_1873` 供货商（康能内衣 832 / 广州纤姿美 311 ...）+ `UDF_M_12636` 品牌（悠妃曼 146 / 法米索 50 / 安吉丽美颜之爱 26 ...）+ `UDF_M_1874` 产品系列（生育光线系列 179 / 工作服 90 / ...） | `products.spec_text` text / `products.supplier` text / `products.brand` text / `products.series` text | text (nullable) ×4 | **P1** | UDT_M_341 共 2043 行院装产品，sync 仅过滤 valid=22 进 PG，**99% 信息丢失**：spec/supplier/brand/series 4 列共同决定库存盘点、采购计划、品牌专区展示。最终迁移需把这 2043 行全部回填，否则家居产品域几乎不可用 | 直拷 RTRIM | 全表回填 ~2000 行（products 当前 960，需扩至 ~3000） | 4 个新列 + 同步脚本 LIFT WHERE 条件；admin 商品编辑表单加 4 字段 |
| 7 | `UDT_M_341.UDF_M_4795` 员工购入价 / `UDF_M_4796` 员工折扣（"0.4" 等）/ `UDF_M_7541` 公司进货价 | `products.employee_price` numeric / `products.cost_price` numeric | numeric(10,2) ×2 | **P1** | 财务报表 / 利润分析依赖进货价；员工内购特价是凤御内部福利政策的核心激励手段，目前完全无 PG 承载 → 内购走线下记账 | 直拷 (4795 → employee_price; 7541 → cost_price); 4796 (折扣率) 派生 | 仅 2043 行家居产品有源 | 加 2 列 + 财务页面加"利润率"展示 |
| 8 | `UDT_S_1459.UDF_S_17175` 促销方案名 (如"安吉丽净肤疗法") + `UDF_S_17191` 现金券面值 + `UDF_S_17193` 套餐总价 | 新表 `promotion_schemes` (scheme_id, scheme_name, voucher_amount, bundle_total_price, valid_start, valid_end) + `product_skus.promotion_scheme_id` FK | 新表 + FK 列 | **P1** | 当前 promo 方案名仅作为分类名进 product_categories，附带的 cash_voucher（赠送现金券）/ bundle_total（套餐总价）丢失。是 sale_items 折扣字段（unit_real_price < unit_price）背后的原始语义（参见 _gaps 01 模块 P3 "31780 行 unit_real_price > unit_price 折扣字段语义颠倒"） | 抽 1459 主表 137 行 → promotion_schemes；UDT_M_1460 通过 RID 关联 | 137 个促销方案 → 754 个 SKU 行 | 新表 + FK + admin 促销管理页面 |
| 9 | `UDT_M_1281.UDF_M_14569` 三级品项细分（体型健康管理=121 / 基础养生=58 / 光泽医疗-注射类=47 / 美卿医疗-手术类=39 ... 30+ distinct 值，填充率 755/798=94.6%） | `product_categories` 加第三级或 `product_skus.sub_category` text | text (nullable) | **P1** | PG 当前仅 2 层分类（一级 productKind + 二级 categoryName），WF 端有 30+ 个三级细分，是新人培训 / 数据看板按"治疗大类"切片的关键维度 | `RTRIM(UDF_M_14569)` 直拷 | 1720 SKU 中 ~970 有源 | 加 sub_category 列 + admin 编辑表单 + 报表筛选器 |
| 10 | `UDT_M_1281.UDF_M_17411` 外围市场是否可用（是=509 / 否=289）+ `UDF_M_17478` 昌九贡是否可用（是=568 / 否=230）+ `UDT_M_1383.UDF_M_17479` 同（是=8 / 否=193） | `product_skus.outer_market_enabled` boolean / `product_skus.changjiugong_enabled` boolean | boolean (NOT NULL default true) ×2 | **P2** | 业务侧"外围市场"（非凤御自营市场）和"昌九贡"（特殊政策市场）有不同的可售品集合，目前 PG 的 market_scope 是"白名单"模式但缺这 2 类"特殊市场"的开关 | `RTRIM(UDF_M_17411) = '是'`、`RTRIM(UDF_M_17478) = '是'` | 798 SKU 有源；其他 default true | 2 个新列 + 售点过滤 |
| 11 | `UDT_S_1459.UDF_S_17157` 促销开始 / `UDF_S_17158` 促销结束（datetime2）| `product_skus.promo_start` / `promo_end` | date (nullable) | **P2** | 与 #5 类似但仅针对促销 SKU；当前 PG sync-products L137 写死 "仅当前生效促销" 27 个，未来历史促销复盘需要 | `UDF_S_17157::date / UDF_S_17158::date` | 137 行促销 | 见 #8 promotion_schemes 表 |
| 12 | `UDT_M_1383.UDF_M_17415` 是否可用（与现行 sync 是 WHERE 条件） | `product_skus.is_in_use` boolean | boolean (NOT NULL default true) | **P2** | 现行同步用作 WHERE 过滤，但门店端"产品下架"操作可能与 is_enabled 语义冲突；分开 2 个语义清晰 | `RTRIM(UDF_M_17415) = '是'` | 504 行门店自定义有源 | 加列 |
| 13 | `UDT_M_1460.UDF_M_17170` 折扣金额（min=-300.1 / max=1500 / avg=98.07，填充率 754/754=100%）| `product_skus.discount_amount` numeric(10,2) | numeric(10,2) (nullable) | **P2** | 促销方案的"减多少元"原始数据，与 sale_items.unit_real_price 互算可校验；现有 admin 编辑促销价是单值（special_price）丢失了"原价 - 折扣 = 现价"这条三元关系 | `UDF_M_17170` 直拷 | 754 行促销有源 | 加列 |
| 14 | `UDT_M_341.UDF_M_1876-1880` 多层批发价（5 个 decimal）| `products.tier_prices` jsonb | jsonb (nullable) | **P2** | 院装产品按经销商等级有 5 档价；当前完全丢失，影响渠道经销 | `jsonb_build_object('p1', UDF_M_1876, 'p2', UDF_M_1877, ...)` | 2043 行院装 | 加 jsonb 列 |
| 15 | `UDT_M_1281` description / 产品介绍（schema 见 R2 M19 — UDT_M_1281 实际只有 14 个 UDF 列，**无描述字段**）| — | — | — | 经探针验证，UDT_M_1281 schema 不含描述列；`products.description` 必须由 admin 后续手填，**无 WorkFine 来源** | — | — | 该候选**无源**，建议放弃 |

### 优先级汇总

- **P0（业务依赖）**：3 个 — `commission_class`（资损）、`is_gift`（资损）+ 已记入 _gaps 的 R2 高危 P0（466 疗程卡误判 / 149 套餐缺分组 / 17 套餐缺 bundle_price，这 3 个不是字段扩展是数据修复）
- **P1（信息流失）**：6 个 — `unit` / `banner_label` / `valid_start+end` / `spec+supplier+brand+series`（合并算 1）/ `employee_price+cost_price`（合并算 1）/ `promotion_schemes` 新表 / `sub_category`（三级细分）
- **P2（nice-to-have）**：5 个 — `outer_market_enabled` / `changjiugong_enabled` / `promo_start+end` / `is_in_use` / `discount_amount` / `tier_prices`
- **无源放弃**：1 个 — `description`（WF 无对应字段）

### 实施依赖

- **必须先加 PG 列**：所有 P0/P1 都需先 `db:generate` + `db:migrate`，再写一次性回填脚本
- **必须 admin UI 配套**：`is_gift / commission_class / banner_label / unit / 4 列家居 spec` — 这些是新增可编辑字段
- **批量回填**：UDT_M_341 全量（2043 行）需重写 sync-products 同步脚本（去 `WHERE UDF_M_7494='是'` 过滤）
- **新表**：`promotion_schemes` 是从 product_categories 中分离出"促销方案"实体，会影响 product_categories.category_name 当前承载的混合语义（既有"分类"又有"促销方案名"）


