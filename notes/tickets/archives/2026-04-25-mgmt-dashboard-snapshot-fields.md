# Ticket 1: 数据中心统计所需的 3 个快照字段

> 生成日期：2026-04-25
> 严重级别：P1（数据中心 8 卡片中 4 张依赖这些字段，未做则统计无法上线）
> 端：DB schema + staffApi 云函数（写入路径）+ cronTask 云函数（会员等级跳档）+ admin actions（同步逻辑）
> 影响面：3 张表新增列 / 3 处写入路径 / 1 处历史回填脚本
> 前置：无
> 后置：Ticket 2（dashboardSummary 接口）依赖本 ticket 的字段
>
> **一句话目标**：为"管理层数据中心首页"的 8 卡片统计补 3 个快照列 —
> `sale_items.is_shengmei` / `service_items.is_shengmei` / `client_wechat_users.old_member_level`，
> 并在所有写入路径上把快照值落库；同时回填历史数据，使统计 SQL 不依赖跨表 JOIN。

---

## 0 一句话背景

管理层数据中心首页（`pages/mgmt-dashboard` 的 `dashboard` tab，目前是 placeholder）需要展示：

- **生美业绩**（今日/本月/月店均）— `sale_items.received` SUM，限定 `is_shengmei = true`
- **生美实耗**（今日/本月/月店均）— `service_items.unit_real_price * session_used` SUM，限定 `is_shengmei = true`
- **新会员**（今日/本月）— `client_wechat_users.member_level_upgraded_at` 命中所选日期 / 月份 **且** `old_member_level IS NULL`

`is_shengmei` 当前**只有 `product_skus` 表有**（`db/schema/product.ts:47`），sale 和 service 链路下游无法直接判定一行明细是不是生美。
`member_level_upgraded_at` 当前**已有**（`db/schema/user.ts:40`），但**没有** `old_member_level` 列，无法区分"新升上来的"和"维持本级的"。

如果不补快照，统计 SQL 必须跨表 JOIN 到 `product_skus` / 跨多笔历史订单推断"是不是首次升级"，性能差且语义脆弱（`product_skus.is_shengmei` 一旦后台被改，历史订单的统计口径会随之漂移）。

---

## 1 字段定义

### 1.1 `sale_items.is_shengmei`（新增列）

```ts
// db/schema/order.ts，加在 saleItems 中（建议放在 productType 附近，line ~152）
isShengmei: boolean('is_shengmei'),
```

- 类型：`boolean`，**可空**（历史数据回填后再考虑能否 NOT NULL；首版保持 nullable 以容忍 sku_id 为 null 的边界）
- 来源：开单时从 `product_skus.is_shengmei` 拷贝快照
- 不可变：开单后不再修改（即使 sku 被改也不动历史行）

### 1.2 `service_items.is_shengmei`（新增列）

```ts
// db/schema/service.ts，加在 serviceItems 中（建议放在 unitRealPrice 附近，line ~60）
isShengmei: boolean('is_shengmei'),
```

- 类型：`boolean`，**可空**
- 来源：service.create 时从对应 `sale_items.is_shengmei` 拷贝快照（**注意是从 sale_items 拷，不是再 JOIN 一次 product_skus**，避免 sku 改动后语义漂移）

### 1.3 `client_wechat_users.old_member_level`（新增列）

```ts
// db/schema/user.ts，加在 memberLevel 附近（line ~36）
oldMemberLevel: memberLevelEnum('old_member_level'),
```

- 类型：`member_level` 枚举（与 `member_level` 同枚举），**可空**
- 语义：上一级；`null` 表示该顾客是从"无等级"首次升上来的（即首次成为会员）
- 写入时机：每次 `member_level` 发生变化时一并更新（升级或降级）；不变化时不动

> **新会员判定 SQL**：
> ```sql
> SELECT COUNT(*) FROM client_wechat_users
> WHERE member_level_upgraded_at::date = $1
>   AND old_member_level IS NULL
> ```
> 这覆盖"今日"；本月把 `::date = $1` 换成 `date_trunc('month', member_level_upgraded_at) = date_trunc('month', $1)`。

---

## 2 Migration

### 2.1 生成

```bash
cd db && npm run db:generate
```

drizzle-kit 应产出形如 `migrations/0008_<adjective>_<noun>.sql`：

```sql
ALTER TABLE "sale_items" ADD COLUMN "is_shengmei" boolean;
ALTER TABLE "service_items" ADD COLUMN "is_shengmei" boolean;
ALTER TABLE "client_wechat_users" ADD COLUMN "old_member_level" "member_level";
```

### 2.2 历史数据回填（追加在生成的 .sql 末尾）

按 `db/CLAUDE.md` 第 §2 约定，**只能追加**手写 UPDATE/INSERT，不能修改 drizzle-kit 生成的 ALTER：

```sql
-- 历史回填：sale_items.is_shengmei ← product_skus.is_shengmei
UPDATE sale_items si
SET is_shengmei = sk.is_shengmei
FROM product_skus sk
WHERE si.sku_id = sk.sku_id
  AND si.is_shengmei IS NULL;

-- 历史回填：service_items.is_shengmei ← sale_items.is_shengmei（已经回填过）
UPDATE service_items sit
SET is_shengmei = si.is_shengmei
FROM sale_items si
WHERE sit.sale_item_id = si.sale_item_id
  AND sit.is_shengmei IS NULL;

-- 历史回填：old_member_level
-- 现状：所有当前有等级的客户都视为"首次升级"，old_member_level 保留 NULL
-- 即"是新会员"。这与产品对"新会员"定义一致（见 ticket 0 背景）。
-- 不做任何 UPDATE，让历史保持 NULL 即可。
```

> **本地验证**：按 `db/CLAUDE.md` §2.1 步骤 3，临时起 docker PG 跑一次空库 migrate 确认。

### 2.3 部署

按 `db/CLAUDE.md` §3 强制要求：**5434/fengyu** 和 **5433/fengyu_wxapp** 都跑 `db:migrate`，缺一会再次 drift。

---

## 3 写入路径修改

### 3.1 `staffApi/routes/order.js` — 开单写 `sale_items.is_shengmei`

定位：搜 `INSERT INTO sale_items`（开单事务内）；当前 SQL 应该 SELECT 了 product_skus 的字段拼快照，把 `is_shengmei` 一并加进去。

预期改动：

```js
// 取 sku 快照时（已有的 SELECT product_skus）多取一列：
const { rows: [sku] } = await client.query(
  `SELECT spec_name, price, special_price, service_fee, is_shengmei,
          session_count, product_type, ...
   FROM product_skus WHERE sku_id = $1`,
  [skuId],
)

// INSERT sale_items 时多写一列：
await client.query(
  `INSERT INTO sale_items (
     sale_item_id, sale_order_id, store_id, sku_id, product_name,
     sku_spec_name, product_type, session_count, remaining_sessions,
     unit_price, quantity, unit_real_price, sale_amount, received,
     service_fee, is_shengmei, ...
   ) VALUES ($1, $2, ..., $N)`,
  [..., sku.is_shengmei, ...],
)
```

> **注意**：开单还包括"回款单"（`createRepayment`）、"转换单"（`createConversion`）、"退款单"（`createRefund`）三种单据，
> 它们也走 `INSERT INTO sale_items`，**全部都要带上 `is_shengmei`**。
> 回款/退款的 sale_item 引用原销售行（`ref_sale_item_id`），可以直接拷原行的 `is_shengmei`；转换单则按转换后的新 sku 取。

### 3.2 `staffApi/routes/service.js` — 写 `service_items.is_shengmei`

定位：`service.create` 内 `INSERT INTO service_items`。

```js
// 已经会 SELECT sale_items 取 unit_real_price 快照；多取一列：
const { rows: [item] } = await client.query(
  `SELECT unit_real_price, is_shengmei, product_type, remaining_sessions, ...
   FROM sale_items WHERE sale_item_id = $1`,
  [saleItemId],
)

// INSERT service_items 时多写：
await client.query(
  `INSERT INTO service_items (
     service_item_id, service_order_id, sale_item_id,
     unit_real_price, is_shengmei, session_used, employee_id, service_duration
   ) VALUES (..., $N)`,
  [..., item.is_shengmei, ...],
)
```

### 3.3 会员等级跳档时写 `old_member_level`

会员等级有两条更新路径：

1. **`cloudfunctions/cronTask/index.js`** — 每日扫消费额、按规则升降级（运行时）
2. **`db/utils/member-level.ts`** — admin 侧共享判定工具（无写入）

需修改的是 **cronTask** 内的 `UPDATE client_wechat_users SET member_level = ...`。把 SQL 改成把当前 member_level 复制到 old_member_level：

```sql
-- 升级路径（locked_until = NOW + 150 days）
UPDATE client_wechat_users
SET old_member_level = member_level,   -- 新增：先快照旧等级
    member_level = $1,
    member_level_upgraded_at = NOW(),
    member_level_locked_until = NOW() + INTERVAL '150 days'
WHERE user_id = $2
  AND member_level IS DISTINCT FROM $1; -- 仅在等级真的变化时更新

-- 降级路径（locked_until = NULL）
UPDATE client_wechat_users
SET old_member_level = member_level,
    member_level = $1,
    member_level_upgraded_at = NOW(),
    member_level_locked_until = NULL
WHERE user_id = $2
  AND member_level IS DISTINCT FROM $1;
```

> **关键**：`old_member_level = member_level` 这一句要在 `member_level = $1` **之前**写（同一个 SET 子句里 PG 是按列名读旧值，顺序不影响语义；但注释和顺序应清晰）。
>
> **注意 IS DISTINCT FROM**：避免对没有变化的行（例如脚本重复执行）覆盖掉真实的 old_member_level。

### 3.4 admin actions 一致性

`fengyu-admin/src/actions/refunds.ts:282-290`、`customers.ts` 等多处 SELECT `memberLevelUpgradedAt`，**不需要改**（只是读）。
但若任何 admin action 也走"手动升降级"路径（grep `member_level\s*=`），同样需要把 old_member_level 一并写入。
当前 grep 结果显示 admin 没有手动升降级路径，全部走 cronTask。**待二次确认**。

---

## 4 类型与代码生成

```bash
cd db && npm run db:generate              # 生成 migration
cd fengyu-admin && npx tsc --noEmit       # 确认 admin 端类型可编译（schema 增列不会破坏现有 types）
```

---

## 5 测试与验收

### 5.1 单元/集成测试

- `db/scripts/verify-member-level-cron.js` 已存在，扩充：
  - 升级用例：升级前 set `member_level = '初钻'` → 跑 cron → 断言 `old_member_level = '初钻', member_level = '星钻'`
  - 首次升级用例：`member_level IS NULL` 的客户跑 cron 升到初钻 → 断言 `old_member_level IS NULL`
  - 降级用例：`member_level = '星钻'` 且 lock 过期、消费不足 → 跑 cron 降到初钻 → 断言 `old_member_level = '星钻'`
- staffApi 单测（如 `routes/order.test.js`、`routes/service.test.js`）补 1 个 case：
  - 给 sku 设 `is_shengmei = true`，create order → 查 sale_items → 断言 `is_shengmei = true`
  - service.create 引用该 sale_item → 查 service_items → 断言 `is_shengmei = true`

### 5.2 数据完整性 SQL（部署后跑一次）

```sql
-- 1. 历史 sale_items 回填覆盖率
SELECT COUNT(*) AS total,
       COUNT(is_shengmei) AS filled,
       COUNT(*) FILTER (WHERE sku_id IS NULL) AS no_sku
FROM sale_items;
-- 期望：filled + no_sku = total（仅 sku_id IS NULL 的行允许 is_shengmei IS NULL）

-- 2. 历史 service_items 回填覆盖率
SELECT COUNT(*) AS total, COUNT(is_shengmei) AS filled FROM service_items;
-- 期望：filled = total（所有 service_items 都引用了 sale_items）

-- 3. old_member_level 当前应全部 NULL（与"首次升级=新会员"定义一致）
SELECT COUNT(*) FILTER (WHERE old_member_level IS NOT NULL) FROM client_wechat_users;
-- 期望：0（migration 后只有未来升级才会写入非空值）
```

---

## 6 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 历史 sale_items 中 sku_id 为 null（古老的录入数据）回填不到 is_shengmei | 影响"生美业绩"统计准确度（少算/多算） | grep `sku_id IS NULL` 行数 → 评估比例；若 < 1% 可接受 NULL 视为"非生美"；> 5% 需要业务侧明确补救 |
| `old_member_level` 历史全部为 NULL，意味着所有现存有等级的客户在统计上"都不算新会员" | 短期符合预期（产品定义就是首次升级才算新会员）；但若运营要把"过去某月新升级的客户"也统计进来，会缺数据 | 已与本 ticket 范围对齐；若有需求另开 ticket 用 operation_logs 反推历史 |
| `cronTask` 的写入是异步的，与 staffApi 的写入路径分离 | 短时间窗口内，前端拿到的 `member_level` 与 `old_member_level` 会不一致（cron 还没跑到） | cron 每日凌晨跑一次，业务可接受 T+1 延迟 |
| 转换单/退款单的 is_shengmei 来源不清晰 | 业绩统计口径偏 | 转换单：按转换后的新 sku 取（"客户从此用的是新生美卡"）；退款单：按原行（即被退掉的销售行）取，统计时 received 是负数，自动抵掉 |

---

## 7 不在本 ticket 范围

- 任何新统计接口（在 Ticket 2 实现）
- 任何前端展示（在 Ticket 3/4 实现）
- 把字段从 nullable 改 NOT NULL（首次回填后另开 P3 ticket，需先确认覆盖率）
- 重构 `member-level.ts` 共享逻辑（cronTask 自己有副本，本 ticket 仅在 cronTask 改 SQL）

---

## 8 交付物

- [ ] `db/schema/order.ts` saleItems 加 `isShengmei`
- [ ] `db/schema/service.ts` serviceItems 加 `isShengmei`
- [ ] `db/schema/user.ts` clientWechatUsers 加 `oldMemberLevel`
- [ ] `db/migrations/0008_*.sql`（drizzle 生成 + 末尾追加 2 条回填 UPDATE）
- [ ] 5434 + 5433 双库 `db:migrate` 跑完
- [ ] `staffApi/routes/order.js` create / createRepayment / createConversion / createRefund 4 个写入路径补 is_shengmei
- [ ] `staffApi/routes/service.js` create 路径补 is_shengmei
- [ ] `cloudfunctions/cronTask/index.js` 升级/降级 SQL 加 `old_member_level = member_level`
- [ ] `db/scripts/verify-member-level-cron.js` 扩充 3 个用例
- [ ] §5.2 数据完整性 SQL 全部通过
