# Ticket: products.category_id 全部 `mall-` 前缀，但 product_categories 没有任何 `mall-` 前缀行（FK 全断）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待排查 + 紧急修复 |
| 优先级 | **P0**（全部 961 / 962 个商品对应不到任何分类 → admin 开单页按分类 Tab 浏览拿不到 SKU；客户端商城同样受影响）|
| 端 | fengyu-admin + fengyu-client + db |
| 修复成本 | **M**（一次性数据修正 + 排查源头 + 防回归）|
| 来源 | 2026-05-18 e2e-chains 跑批 link-21 "无法加入 SKU 法米索深层清洁啫喱（分类: 歆笙泰妍）" |
| 关联表 | `products`、`product_categories` |

---

## 0 一句话

`products.category_id` 全部用 `mall-` 前缀（如 `mall-cat-home-supplies` / `mall-d303ac8871eafd97`），但 `product_categories.category_id` **没有任何 `mall-` 前缀**（用裸前缀 `cat-home-supplies` / `d0ea5cbccb07d5de`）。FK JOIN 全断 → 任何"按分类列出商品" UI 全失效。

---

## 1 实证

### 1.1 5434 主库（今日 06:51）

```sql
SELECT 'products', count(*) FILTER (WHERE category_id LIKE 'mall-%') AS mall_prefix, count(*) AS total FROM products
UNION ALL
SELECT 'product_categories', count(*) FILTER (WHERE category_id LIKE 'mall-%'), count(*) FROM product_categories;

     table_name     | mall_prefix | total
--------------------+-------------+-------
 products           |         962 |   962
 product_categories |           0 |    61
```

### 1.2 5433 测试库（同时间）

```
     table_name     | mall_prefix | null_cat | total
--------------------+-------------+----------+-------
 products           |         961 |        0 |   961
 product_categories |           0 |          |    55
```

**→ 两库都炸**（说明不是某一库的局部污染，而是同源问题；可能 db/scripts/migrate-* 脚本 import 数据时把 product 表挂上了带 `mall-` 前缀的 category_id，但忘了同步把 product_categories 也加 `mall-` 前缀 / 没把 product 改成裸前缀）。

### 1.3 单条样本

```sql
SELECT name, category_id FROM products WHERE name='法米索深层清洁啫喱';
 法米索深层清洁啫喱 | mall-cat-home-supplies
 法米索深层清洁啫喱 | mall-d303ac8871eafd97
```

`product_categories` 里有 `cat-home-supplies`（裸前缀）但**没有** `mall-cat-home-supplies`。
`product_categories` 里有 `d0ea5cbccb07d5de`（歆笙泰妍-护理项目）但**没有** `mall-d303ac8871eafd97`。

→ 即便剥掉 `mall-` 前缀也对不上。两套 ID 体系彻底脱钩。

---

## 2 嫌疑根因

A. **某次商品导入脚本（疑似 `db/scripts/migrate-*.js` 或 sync-workfine 流程的支线）把商城（mall）侧分类 ID 沿用 `mall-` 命名空间，但没把 product_categories 同步迁过来**。

B. **重构遗留**：曾经 product_categories 和 products 都用 `mall-` 前缀，后来 product_categories 改裸前缀的 migration 跑了，但 products 表迁数据没改。

C. **小程序商城与 admin 用了两套 category 体系**：小程序 mall 数据进 `products` 表时挂的是 mall 侧 category_id；admin 在维护 `product_categories` 时用裸前缀；两套从未合并。

---

## 3 排查（10 分钟内可完成）

1. `git log -p db/migrations/ | grep -i "mall-"` 看历史里有没有显式 ALTER 加前缀
2. `grep -rn "mall-" db/scripts/` 找导入脚本
3. `git log --all --oneline db/schema/product*.ts | head -20` 看商品域 schema 历史
4. `SELECT DISTINCT substring(category_id from '^[^-]+') FROM products` 看是否还有别的前缀
5. `SELECT * FROM products WHERE category_id IN (SELECT category_id FROM product_categories) LIMIT 3` ← 看是否有"碰巧匹配"的好行

---

## 4 决策点

### 选项 A：剥前缀 — 一行 SQL 修复

```sql
UPDATE products SET category_id = substring(category_id from 6) -- strip 'mall-'
WHERE category_id LIKE 'mall-%' AND substring(category_id from 6) IN (SELECT category_id FROM product_categories);
```

跑前先看下匹配率（步骤 3.5）。如果 100% 匹配，秒级修复。

**风险**：低；可回滚（备一份 product 表）

### 选项 B：给 product_categories 加 `mall-` 前缀

反向操作。但 product_categories 主键改名连带 FK 改写工作量大。

### 选项 C：补一个 mapping 表（products.category_id → product_categories.category_id）

适用于两套体系确实需要保留的情况。代价高。

### 选项 D：先查清根因再定方案

如果第 3 节排查发现这是某个未完成的 mall 商城功能的中间态，不能贸然剥前缀。

---

## 5 我需要你判断的

**Q1**：先选 A 拼图（最快），还是先选 D 排查（最稳）？

**Q2**：这个 bug 影响范围有多大？我看到 link-21 拿不到家居 SKU；其他链路 link-1 / link-7 / link-14 等开单都能成功——说明开单页 UI 至少**不是完全按分类 Tab 才能找 SKU**（可能还有"搜索"入口或"近期"列表）。需要你确认产品上"按分类浏览"是不是关键路径。

**Q3**：5433 / 5434 是同步坏的，修一边还是修两边？

---

## 6 关联引用

- `tests/e2e-chains/link-21-pickup-records.spec.ts:140`
- `db/schema/product.ts`（products / product_categories）
- 各 sync / migrate 脚本：`db/scripts/migrate-*.js`
- 商城同步：`db/scripts/sync-workfine.js`（如有）
