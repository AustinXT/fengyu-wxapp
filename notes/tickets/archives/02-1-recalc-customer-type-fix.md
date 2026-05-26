# 02-1 `recalcCustomerType` 死分支修复方案

> 生成日期：2026-04-10
> 关联适配计划：`notes/adapt-plans/02-customer-classification.md` §1.5
> 关联决策：`notes/adapt-plans/00-decisions.md` §1（customerTypeEnum 保持 4 档）+ §2 Q1（4 档权威定义）
> 关联 Bug 报告：`notes/tickets/bug-recalc-customer-type-dead-branch.md`（§1–6 现象/根因分析仍然有效，本文档取代其 §7 修复方案）
> 执行优先级：P0-5
> 严重级别：低（语义缺陷，无数据损坏）

---

## 1 本方案的取代关系

`bug-recalc-customer-type-dead-branch.md` §7 原方案基于"5 档枚举重构（注册/体验客/流量客/会员/新客）"。该方案已在 `00-decisions.md` §1 被业务方取消，并在 §2 Q2 明确"没有'注册'，只有'流量客'"。本文档是**无结构性变更**的等价纯逻辑修复方案。

`bug-recalc-customer-type-dead-branch.md` §1–6 的位置定位、缺陷代码展示、短路证明、根因溯源（migration 0028–0031 删除 `'体验单'` 枚举后批量 find-replace 把 `sale_order_type='体验单'` 改成 `sale_order_type='销售单'` 导致 ③ 与 ② 字节相同）、可观测影响这些内容继续有效，不重复引用。

---

## 2 Q1 权威定义（2026-04-10 澄清）

| 档位 | 定义 |
|---|---|
| **流量客** | 仅注册账户，未进行任何消费 |
| **体验客** | 售前体验卡（68/99/线上体验等） |
| **小美客** | 单笔消费 < 1990 元（销售单） |
| **会员客** | 单笔消费 ≥ 1990 元（订单款清达标也算）（销售单） |

1990 是从 systemConfig 中获取的 new_member_threshold
关键转换：由于 `sale_order_type` 的 `'体验单'` 枚举值已被 migration 0028–0031 删除，"体验客"的判定维度**从 `sale_order_type` 改为 `products.category → product_categories.product_kind = '体验卡'`**。这是本次修复与原旧 SQL 的唯一业务判据差异。

---

## 3 约束清单（不能违反）

来自 `00-decisions.md` 和已完成 commit 的约束：

1. **`customerTypeEnum` 不变**：保持 `[流量客, 体验客, 小美客, 会员客]`，不新增不删除（§1 决策表 #1）
2. **无 migration、无列增删、无枚举改动**（§1.1 收窄到逻辑层）
3. **阈值走 `getMemberThreshold()` helper**：已在 P1-10（commit `49e3c9b` + `b6b97e6` + `d30f848`）完成，从 `system_configs.new_member_threshold` 读取，fallback 1980
4. **`became_member_at` 升级写入逻辑保持不变**：已在 commit `381ba61` 就绪，位于 `staffApi/routes/order.js:130-136` 和 `payNotify/index.js` 镜像位置，只在 UPDATE 真正将顾客升级为 `'会员客'` 时才写 NOW()
5. **"只升不降"排序保持不变**：`流量客=0 < 体验客=1 < 小美客=2 < 会员客=3`
6. **两处 SQL 镜像必须同步**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`（店长开单路径）+ `fengyu-client/cloudfunctions/clientApi/payNotify/index.js`（微信支付回调路径），**逐字节一致**
7. **无历史数据兼容/回填要求**（遵循 `feedback_no_legacy_compat`）

---

## 4 表结构核对（写 SQL 前确认）

已核对 `db/schema/product.ts` 与 `db/schema/order.ts`：

| 表 | 关键字段 |
|---|---|
| `sale_orders` | PK `sale_order_id`，`client_user_id`, `status`, `sale_order_type`, `total_amount`, `ref_sale_order_id` |
| `sale_items` | PK `sale_item_id`，FK `sale_order_id` → sale_orders，FK `sku_id` → product_skus（**nullable**） |
| `product_skus` | PK `sku_id`，FK `category_id` → **product_categories.category_id**（非 mall_categories） |
| `product_categories` | PK `category_id`，**`product_kind`** 枚举列 `[护理项目, 家居产品, 充值卡, 体验卡]` |

⚠ 注意：`product_kind` 挂在 `product_categories` 表上，**不是** `products` 表上。`products` 是商城展示侧的表，走 `mall_categories`，与 SKU 所属的品项分类是两条平行线。

因此"判定某 sale_item 是否体验卡"的 JOIN 链是：

```
sale_items.sku_id
  → product_skus.sku_id
  → product_skus.category_id
  → product_categories.category_id
  → product_categories.product_kind = '体验卡'
```

`sale_items.sku_id` 可空（migration 历史数据），但这类行本来就无法参与 product_kind 判定，JOIN 会自然过滤，语义正确。

---

## 5 新 `recalcCustomerType` CASE SQL

```sql
SELECT CASE
  -- ① 会员客: 存在一笔销售单 total_amount ≥ 阈值，
  --         或该销售单 total_amount + 其全部关联回款单 SUM ≥ 阈值（"订单款清达标"）
  WHEN EXISTS (
    SELECT 1 FROM sale_orders o
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND (
        o.total_amount >= $2
        OR (o.total_amount + COALESCE((
          SELECT SUM(r.total_amount)
          FROM sale_orders r
          WHERE r.ref_sale_order_id = o.sale_order_id
            AND r.sale_order_type = '回款单'
            AND r.status IN ('已支付','已完成')
        ), 0)) >= $2
      )
  ) THEN '会员客'

  -- ② 小美客: 存在"非体验卡"销售单（至少一行 sale_items 的 product_kind <> '体验卡'），
  --         且未命中①（即所有单笔 + 回款累计均 < 阈值）
  WHEN EXISTS (
    SELECT 1
    FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind <> '体验卡'
  ) THEN '小美客'

  -- ③ 体验客: 仅买过 product_kind = '体验卡' 的销售单
  --         （走到这里说明 ① ② 都 false，即无非体验卡销售单且未达会员阈值）
  WHEN EXISTS (
    SELECT 1
    FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind = '体验卡'
  ) THEN '体验客'

  -- ④ 流量客: 无任何销售单
  ELSE '流量客'
END AS computed_type
```

### 5.1 短路逻辑证明

| 顾客状态 | ① | ② | ③ | 结果 |
|---|---|---|---|---|
| 无任何销售单 | F | F | F | 流量客 ✓ |
| 只买过体验卡 58 元 | F | F | T | 体验客 ✓ |
| 只买过体验卡 2500 元（极端） | T | — | — | 会员客 ✓（会员门槛不区分 product_kind，符合 Q1 "单笔消费 ≥ 1990 元"） |
| 只买过非体验卡 500 元 | F | T | — | 小美客 ✓ |
| 买体验卡 68 + 非体验卡 500 | F | T | — | 小美客 ✓（升级覆盖体验客） |
| 买非体验卡 3000 元 | T | — | — | 会员客 ✓ |
| 买非体验卡 500 元 + 回款 1500 元 | T | — | — | 会员客 ✓（订单款清达标） |
| 买两笔非体验卡 800+800（无回款） | F | T | — | 小美客 ✓（会员门槛是"单笔 ≥ 1990"，不是"累计"） |

③ 分支 `pc.product_kind = '体验卡'` 条件理论上可省（因为前两档都 false 时只剩体验卡），但保留是为了**显式语义断言**，同时防御 `sku_id=NULL` 的脏数据：如果顾客所有 sale_items 的 `sku_id` 都为 NULL，JOIN 全部过滤，① ② ③ 全 false，归入 ④ 流量客 —— 这对无法追溯品类的脏数据是安全的降级。

### 5.2 与旧 SQL 的逐字节 diff

旧 ② `小美客` 分支：
```sql
WHEN EXISTS (
  SELECT 1 FROM sale_orders
  WHERE client_user_id = $1
    AND status IN ('已支付','已完成')
    AND sale_order_type = '销售单'
) THEN '小美客'
```

新 ② `小美客` 分支：
```sql
WHEN EXISTS (
  SELECT 1 FROM sale_orders o
  JOIN sale_items si ON si.sale_order_id = o.sale_order_id
  JOIN product_skus sk ON sk.sku_id = si.sku_id
  JOIN product_categories pc ON pc.category_id = sk.category_id
  WHERE o.client_user_id = $1
    AND o.status IN ('已支付','已完成')
    AND o.sale_order_type = '销售单'
    AND pc.product_kind <> '体验卡'
) THEN '小美客'
```

核心变化：**增加 JOIN 链 + `pc.product_kind <> '体验卡'` 过滤**，让 ② 只在"存在非体验卡销售单"时命中，从而为 ③ 的"仅体验卡"场景让出路径。

旧 ③ 是 ② 的字节级拷贝，死分支；新 ③ 改为 `pc.product_kind = '体验卡'`，与 ② 互斥，语义上正确映射"体验客 = 只买过体验卡"。

---

## 6 修改文件清单（无结构变更）

| # | 文件 | 动作 | 参考行号 |
|---|---|---|---|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 替换 `recalcCustomerType` 函数体内的 CASE SQL | 第 78-111 行（`client.query` 调用，`SELECT CASE ... END AS computed_type`） |
| 2 | `fengyu-client/cloudfunctions/payNotify/index.js` | 镜像同步 CASE SQL（逐字节一致） | 约第 141-208 行的 `recalcCustomerType` 镜像；具体行号以文件当前状态为准 |

> **路径订正（执行时发现）**：`payNotify` 是与 `clientApi` **平级**的独立云函数，不在 `clientApi/` 嵌套下。本 ticket 原 §6 写作 `fengyu-client/cloudfunctions/clientApi/payNotify/index.js` 有误，实际路径为 `fengyu-client/cloudfunctions/payNotify/index.js`（参见 `fengyu-client/CLAUDE.md` 云函数列表）。修复 commit `be89af7` 已按实际路径落地。

**不动的内容**：
- `getMemberThreshold()` 调用（第 76 行）保持
- 短路 return `'会员客'` 的 pre-check 保持（第 70-74 行）
- `UPDATE ... CASE ... END < CASE ...` 的"只升不降"排序保持（第 114-128 行）
- `became_member_at` NOW() 写入保持（第 130-136 行）
- payNotify 镜像的对应逻辑保持

### 6.1 可选重构（scope out）

当前 staffApi 与 payNotify 两处 SQL 镜像通过"双边同时修改"保持一致，存在漂移风险。**本 fix 不涉及重构**，仅要求两处同步更新。若将来希望收敛，可抽 `utils/customer-type-sql.js` 共享常量导出 CASE SQL 字符串，但需跨云函数共享（CloudBase 约束），列为独立改造任务，不纳入本次 commit。

---

## 7 验证清单

### 7.1 单元测试

**`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js`** 新增 case：

- [ ] `recalcCustomerType` — 无销售单 → 流量客
- [ ] `recalcCustomerType` — 只买体验卡 68 元 → 体验客
- [ ] `recalcCustomerType` — 只买体验卡 + 非体验卡 500（均 < 1990）→ 小美客（升级覆盖体验客）
- [ ] `recalcCustomerType` — 非体验卡单笔 3000 → 会员客
- [ ] `recalcCustomerType` — 非体验卡单笔 500 + 关联回款 1500 → 会员客（订单款清达标）
- [ ] `recalcCustomerType` — 两笔非体验卡 800+800（无回款） → 小美客（不累加）
- [ ] `recalcCustomerType` — 体验卡单笔 2500（极端） → 会员客（会员门槛不区分品类）
- [ ] `recalcCustomerType` — 顾客当前已是会员客 → 短路 return，不改写
- [ ] `recalcCustomerType` — 顾客当前是小美客，重算得到"小美客" → 无变化，不回降
- [ ] `recalcCustomerType` — 顾客当前是小美客，重算得到"会员客" → 升级并写 `became_member_at`
- [ ] `recalcCustomerType` — `sale_items.sku_id = NULL` 的脏数据顾客 → 归入流量客（安全降级）

**`fengyu-client/cloudfunctions/clientApi/payNotify/__tests__/*.test.js`**（若已存在）：

- [ ] payNotify 镜像 SQL 与 staffApi 逐字节一致（可通过快照测试或共享固件）

### 7.2 数据校验（开发库）

```sql
-- 校验 1: 当前 customer_type='体验客' 的顾客应只买过体验卡（零条非体验卡销售单）
SELECT cw.user_id, cw.phone, cw.customer_type
FROM client_wechat_users cw
WHERE cw.customer_type = '体验客'
  AND EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = cw.user_id
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind <> '体验卡'
  )
-- 预期返回 0 行；非零说明旧 SQL 下某些"体验客"被误设（或手工改写），
-- 上线新 SQL 后会在下次 recalc 自动升级到小美客/会员客
```

```sql
-- 校验 2: 当前 customer_type='小美客' 或 '流量客' 的顾客中，有多少本应是"体验客"
-- （只有体验卡销售单，无其他 product_kind 销售单）
SELECT COUNT(*) AS should_be_experience
FROM client_wechat_users cw
WHERE cw.customer_type IN ('小美客', '流量客')
  AND EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = cw.user_id
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind = '体验卡'
  )
  AND NOT EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = cw.user_id
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind <> '体验卡'
  )
-- 该数即历史被死分支吞掉的"体验客"群体大小，仅做统计观测，不做回填
```

### 7.3 手工回归（开发环境）

- [ ] staffApi `order.create` 路径：店长开体验卡 68 元订单 → 支付完成 → 查 `client_wechat_users.customer_type = '体验客'`
- [ ] staffApi `order.create` 路径：店长为同一顾客开普通商品 500 元订单 → 支付完成 → `customer_type` 升级为 `'小美客'`
- [ ] staffApi `order.create` 路径：店长为同一顾客开 3000 元订单 → 支付完成 → `customer_type` 升级为 `'会员客'`，`became_member_at` 被写入 NOW()
- [ ] clientApi 微信支付回调 `payNotify` 路径：客户自己下单 → 支付完成 → 触发 payNotify → `customer_type` 按相同规则更新（验证两处镜像等价）
- [ ] 幂等性：对同一顾客连续调两次 `recalcCustomerType`，结果稳定，不来回跳档

### 7.4 部署验证

- [ ] staffApi 部署后，调用 `staffApi.order.create` 走一遍完整流程
- [ ] clientApi `payNotify` 函数同步部署（**不要 `tcb fn deploy --force`**，用 `tcb fn code update`，参考 `project_cloudbase_envvar_risk` memory）
- [ ] 环境变量无变动（本次修改不涉及新增环境变量）

---

## 8 Commit 建议

单 commit 独立发布，便于 review 和 cherry-pick。

**Subject**：
```
fix(customer-type): recalcCustomerType 按 product_kind 区分体验客/小美客
```

**Body**：
```
migration 0028-0031 删除 sale_order_type='体验单' 后，旧 CASE SQL
的 ② ③ 分支字节级相同，导致 '体验客' 死分支永不可达（Bug 详情见
notes/tickets/bug-recalc-customer-type-dead-branch.md）。

按 notes/adapt-plans/00-decisions.md §2 Q1 的 4 档权威定义：
- 流量客：无任何销售单
- 体验客：仅买过 product_kind='体验卡' 的销售单
- 小美客：有非体验卡销售单且未达会员阈值
- 会员客：单笔销售单或订单款清累计 ≥ getMemberThreshold()

新 CASE SQL 通过 JOIN sale_items → product_skus → product_categories
的链路读取 product_kind，在 ② 排除体验卡、在 ③ 断言体验卡，与 ①
（会员阈值）和 ④（ELSE 流量客）短路互斥。

无 schema 变更、无 enum 变更、无新增列。
becameAt 写入、只升不降排序、getMemberThreshold helper 全部保持。

两处镜像同步：
- fengyu-staff/cloudfunctions/staffApi/routes/order.js
- fengyu-client/cloudfunctions/clientApi/payNotify/index.js

验证清单见 notes/tickets/02-1-recalc-customer-type-fix.md §7
```

---

## 9 定义完成（DoD）

- [ ] 新 CASE SQL 在两处代码同步落地并通过 lint
- [ ] `order.test.js` 11 个新 case 全部通过
- [ ] payNotify 镜像的一致性测试（快照或手动 diff）通过
- [ ] 数据校验 §7.2 查询 1 返回 0 行，查询 2 的结果数记录在本 ticket 的"执行记录"章节
- [ ] 开发环境手工回归 §7.3 全部通过
- [ ] staffApi + clientApi 双函数部署并冒烟
- [ ] commit 合并到 dev
- [ ] 00-decisions.md §3 P0-5 状态更新为"已完成"
- [ ] 在 `bug-recalc-customer-type-dead-branch.md` 末尾补一行"已由 `02-1-recalc-customer-type-fix.md` 修复，commit <hash>"

---

## 10 执行记录

### 代码落地

- **修复 commit**: `be89af7` fix(customer-type): recalcCustomerType 按 product_kind 区分体验客/小美客
- **合并 commit**: `385c631` merge: 02-1 recalcCustomerType 按 product_kind 区分体验客/小美客（`--no-ff` merge 到 `dev`）
- **落地日期**: 2026-04-15
- **执行方式**: 通过 `.claude/skills/worktree-flow` 在隔离 worktree 内由子 Agent 完成修复 + diff 自检 + schema 核对后 merge
- **文件改动**: 2 个文件，+36 / −16
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js` — 函数 `recalcCustomerType` 内 CASE SQL
  - `fengyu-client/cloudfunctions/payNotify/index.js` — 镜像位置的 CASE SQL（路径订正见 §6 注）

### 单测

- **新增测试文件**: `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recalc-customer-type-sql.test.js`
- **测试性质**: 源文件文本结构守卫（非行为单测）。vitest 下 pg 被 mock，SQL 语义正确性无法用单元测试验证，故采用"反回归断言"策略：
  1. 两处 CASE SQL 必须同时存在 `pc.product_kind <> '体验卡'` 与 `pc.product_kind = '体验卡'`（反死分支回归）
  2. 会员客 ① 分支必须含 `ref_sale_order_id` 回款累计
  3. ELSE 兜底必须是 `'流量客'`
  4. 两处 CASE SQL 规范化空白后逐字一致（镜像守卫，防止单边漂移）
  5. 不能再出现旧"② ③ 分支只查 sale_orders 无 JOIN"的死分支模式
- **结果**: 11 个断言全通过，执行时间 ~110ms
- **§7.1 清单映射**: ticket §7.1 列出的 11 个数据场景（"无销售单 → 流量客"、"仅体验卡 → 体验客"等）本质上是集成测试，需连真实 PG 灌数据跑。本次落地仅做了源文件守卫，**11 个数据场景的集成测试单独追加为后续任务**。

### 已知 pre-existing 测试故障（与本修复无关）

跑 staffApi 全量 vitest 时，`allocation` / `product` / `service` 三个文件共 7 个测试失败。通过在 pre-fix 版本上跑同一批测试确认结果**完全一致**，属于 baseline 故障，非本修复引入。本 ticket 不处理，独立清理。

### §7.2 数据校验（待手动执行）

本地 PG 5433/fengyu_wxapp 在执行时未运行（docker daemon 未启动），两条校验 SQL 未自动执行。需在**部署前后各跑一次**并回填结果：

```bash
# 示例命令（替换为实际连接参数）
psql "$DEV_PG_URL" <<'SQL'
-- 查询 1: 当前 customer_type='体验客' 的顾客应只买过体验卡（预期 0 行）
SELECT cw.user_id, cw.phone, cw.customer_type
FROM client_wechat_users cw
WHERE cw.customer_type = '体验客'
  AND EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = cw.user_id
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind <> '体验卡'
  );

-- 查询 2: 当前 '小美客'/'流量客' 中本应是"体验客"的顾客数（历史被死分支吞掉的群体）
SELECT COUNT(*) AS should_be_experience
FROM client_wechat_users cw
WHERE cw.customer_type IN ('小美客','流量客')
  AND EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = cw.user_id
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind = '体验卡'
  )
  AND NOT EXISTS (
    SELECT 1 FROM sale_orders o
    JOIN sale_items si ON si.sale_order_id = o.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
    WHERE o.client_user_id = cw.user_id
      AND o.status IN ('已支付','已完成')
      AND o.sale_order_type = '销售单'
      AND pc.product_kind <> '体验卡'
  );
SQL
```

| 时机 | 查询 1 结果 | 查询 2 结果 |
|---|---|---|
| 部署前 | _待填_ | _待填_ |
| 部署后 | _待填_（应仍为 0） | _待填_（应与部署前一致，修复不回填历史，只在下次 recalc 时自动升级） |

### 部署（待执行）

- [ ] staffApi 部署（`tcb fn code update`，**不要 `--force`**，参考 `project_cloudbase_envvar_risk`）
- [ ] payNotify 部署（同上）
- [ ] 环境变量无变动本次无需校验
- 部署时间: _待填_
- 部署方式: _待填（cloudbase-mcp / tcb CLI）_

### 手工回归（待执行）

按 §7.3 清单：

- [ ] staffApi `order.create` 体验卡 68 元 → `customer_type = '体验客'`
- [ ] staffApi `order.create` 普通 500 元 → 升级为 `'小美客'`
- [ ] staffApi `order.create` 3000 元 → 升级为 `'会员客'`，`became_member_at = NOW()`
- [ ] clientApi 微信支付回调 → payNotify 镜像等价验证
- [ ] 幂等性：同一顾客连续重算 2 次结果稳定

### 相关 PR / cnb MR

_待填_
