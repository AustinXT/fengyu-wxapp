# Ticket: 管理层"品项数据"子页"复购情况"显示空 — 根因排查与口径调整

> 生成日期：2026-04-25
> 严重级别：P2（管理层数据看板信息缺失，业务感知度强，不阻塞业务流程）
> 端：fengyu-staff（mgmt-product-cycle 子页 + staffApi.mgmtProduct.cycleStats）
> 影响面：
> - 排查：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js` 中 `cycleStats` 的 fugou CTE
> - 可能修订：`notes/references/metrics.md` "品项顾客周期子页 §2" 口径定义
> - 可能修改：UI 空态文案 / system_configs 新 key（取决于决策结论）
> - 不影响：持卡人数 / 体验情况 / 新增情况（同 SQL 但不同 CTE，独立判断空态）
> 前置：排查阶段需要 PG 访问（dev 5433/fengyu_wxapp 或 test 5434/fengyu）+ 业务方对"复购"定义对齐
> 并行：与其他 ticket 完全独立，可单线推进
>
> **一句话目标**：把首页 → "品项数据" → "复购情况"从"暂无数据"修复为可读的真实复购指标；
> 若数据确实稀疏，则在 UI 区分"暂无复购客"与"渲染异常"两种空态，并将口径表与文案一并固化。
>
> **决策（2026-04-25）**：选 **方案 C**（取消 `<> entry_date` 约束），threshold 共用 1980，period 默认本月，UI 文案保持"暂无数据"。其他方案均否决。

---

## 0 一句话背景

入口：员工端管理层 Hub（`/pages/mgmt-dashboard`） → 顶部入口卡 "品项数据"
（`onEntryTap('products')`） → 跳转分包 `/packageMgmt/mgmt-product-cycle`。

子页结构（`mgmt-product-cycle.wxml`，4 个 `pc-subsection`）：
1. 持卡人数（截面）
2. 体验情况
3. 新增情况
4. **复购情况** ← 当前**全部 product_kind 行为空**，UI 渲染兜底文案 "暂无数据"

接口：`mgmtProduct.cycleStats`（`mgmt-product.js`），返回 `{ trial[], newEntry[], repurchase[] }`。
`repurchase[]` 来自单次 SQL 的 `UNION ALL` 第三段（`group_kind = 'repurchase'`），由 `fugou` CTE 喂数。

现行口径（`metrics.md` §"品项-顾客周期" + cycleStats SQL）：
- `daily_agg` = `(client_user_id, store_id, product_kind, paid_at::date)` 分组的 SUM(received)，全历史截至 endDate
- `qualifying_days` = `daily_agg` 中 `day_received >= threshold` 的行（threshold 来自 `system_configs.new_member_threshold`，FALLBACK = 1980）
- `first_entry` = 每客每品项的最早达标日 entry_date（跨店合并）
- **`fugou` = 期内 qualifying_days，且 `purchase_date <> first_entry.entry_date`**

---

## 1 现象拆解：复购为空可能的 6 个原因

将 6 个候选根因明示，避免一上来就改 SQL：

| # | 候选原因 | 业务含义 | 验证手段 |
|---|---------|---------|---------|
| A | period 内出现的顾客都是该品项的"首次达标"（即都是"新增"，没有"老客") | 数据期短 + 客户库年轻 | 查 first_entry 中 entry_date < period.startDate 的客数 |
| B | 老客在 period 内未达到 daily threshold（消费分散，单日累计 < 1980） | threshold 太高、复购客单价低 | 把 threshold 调到 [500/1000/1980/3000] 多档对照 |
| C | 老客在 period 内的达标日恰好 = entry_date（同日内被同时算 xinzeng 也满足 fugou 的潜在交集，但被 `<> entry_date` 排除） | "非首日"约束误伤当月新客次日仍未消费的情形 | 临时去掉 `<> entry_date` 约束跑一次对比 |
| D | product_kind 4 类粒度过粗（"充值卡 / 体验卡 / 家居产品" 难形成"达标日"，"护理项目"才有量） | 维度选错 | 按 product_kind 看 daily_agg / qualifying_days 分布 |
| E | scope 默认 'all'，但 market 账号被 `validateScope` 收敛到所属市场 → 单一市场样本极少 | 视角差异 | 用 headquarters 账号或临时改 scope='all' 复测 |
| F | 真·业务现状（复购客群本来就稀疏，特别是非头部品项）；2026-04-16 起 WorkFine 同步已停用，历史 entry_date 仅截至迁移点 | 数据真稀疏 | A-E 均否定后认定 |

> 不要直接跳到方案，先按 §2 跑诊断 SQL，得到候选根因表后再选方案。

---

## 2 诊断 SQL（先跑这一套，把结果贴回本 ticket）

针对当月（2026-04-01 ~ 今天）+ scope='all'，按下面顺序跑。每条用 `psql -h 127.0.0.1 -p 5433 -U postgres -d fengyu_wxapp -c "..."`：

### 2.1 三个 CTE 中间量

```sql
WITH daily_agg AS (
  SELECT so.client_user_id, so.store_id, pc.product_kind,
         so.paid_at::date AS purchase_date,
         SUM(si.received::numeric) AS day_received
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    JOIN product_skus sk ON sk.sku_id = si.sku_id
    JOIN product_categories pc ON pc.category_id = sk.category_id
   WHERE so.sale_order_type IN ('销售单','转换单')
     AND so.status = '已支付'
     AND so.client_user_id IS NOT NULL
     AND pc.product_kind IS NOT NULL
     AND so.paid_at::date <= CURRENT_DATE
   GROUP BY so.client_user_id, so.store_id, pc.product_kind, so.paid_at::date
)
SELECT
  COUNT(*)                                                 AS daily_agg_rows,
  COUNT(*) FILTER (WHERE day_received >= 1980)             AS qualifying_rows,
  COUNT(*) FILTER (WHERE day_received >= 500)              AS qualifying_if_500,
  COUNT(*) FILTER (WHERE day_received >= 1000)             AS qualifying_if_1000,
  ROUND(AVG(day_received)::numeric, 0)                     AS avg_day_received,
  PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY day_received)::int AS p50,
  PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY day_received)::int AS p90
FROM daily_agg;
```

### 2.2 first_entry / 老客客数

```sql
-- 在 §2.1 daily_agg 基础上 + qualifying_days + first_entry，看老客数（entry_date < period.startDate）
WITH daily_agg AS ( /* 同 §2.1 */ ),
qualifying_days AS (
  SELECT * FROM daily_agg WHERE day_received >= 1980
),
first_entry AS (
  SELECT client_user_id, product_kind, MIN(purchase_date) AS entry_date
    FROM qualifying_days
   GROUP BY client_user_id, product_kind
)
SELECT
  COUNT(*)                                                                              AS first_entry_total,
  COUNT(*) FILTER (WHERE entry_date <  date_trunc('month', CURRENT_DATE))                AS old_clients_kinds,
  COUNT(*) FILTER (WHERE entry_date >= date_trunc('month', CURRENT_DATE))                AS new_clients_kinds_this_month,
  product_kind
FROM first_entry
GROUP BY ROLLUP(product_kind);
```

### 2.3 fugou 客群（去/带 `<> entry_date` 对比）

```sql
WITH daily_agg AS ( /* 同 §2.1 */ ),
qualifying_days AS ( /* 同 §2.2 */ ),
first_entry AS ( /* 同 §2.2 */ ),
fugou_strict AS (   -- 现行口径
  SELECT DISTINCT q.client_user_id, q.product_kind
    FROM qualifying_days q
    JOIN first_entry f ON f.client_user_id = q.client_user_id
                      AND f.product_kind   = q.product_kind
   WHERE q.purchase_date BETWEEN date_trunc('month', CURRENT_DATE)::date AND CURRENT_DATE
     AND q.purchase_date <> f.entry_date
),
fugou_loose AS (    -- 去掉"非首日"约束
  SELECT DISTINCT q.client_user_id, q.product_kind
    FROM qualifying_days q
    JOIN first_entry f ON f.client_user_id = q.client_user_id
                      AND f.product_kind   = q.product_kind
   WHERE q.purchase_date BETWEEN date_trunc('month', CURRENT_DATE)::date AND CURRENT_DATE
)
SELECT
  (SELECT COUNT(*) FROM fugou_strict) AS strict_fugou_count,
  (SELECT COUNT(*) FROM fugou_loose)  AS loose_fugou_count,
  -- 各 product_kind 分布
  (SELECT json_object_agg(product_kind, n)
     FROM (SELECT product_kind, COUNT(*)::int AS n FROM fugou_strict GROUP BY product_kind) x) AS strict_by_kind,
  (SELECT json_object_agg(product_kind, n)
     FROM (SELECT product_kind, COUNT(*)::int AS n FROM fugou_loose GROUP BY product_kind) x)  AS loose_by_kind;
```

### 2.4 "宽松复购" — 老客在期内有任何购买

> 用于验证候选根因 C（"非首日"约束误伤）+ 候选方案 C。

```sql
WITH daily_agg AS ( /* 同 §2.1 */ ),
qualifying_days AS ( /* 同 §2.2 */ ),
first_entry AS ( /* 同 §2.2 */ ),
fugou_loose2 AS (   -- 老客在期内有任何购买（不要求再次达标）
  SELECT DISTINCT pa.client_user_id, pa.product_kind
    FROM daily_agg pa
    JOIN first_entry f ON f.client_user_id = pa.client_user_id
                      AND f.product_kind   = pa.product_kind
   WHERE pa.purchase_date BETWEEN date_trunc('month', CURRENT_DATE)::date AND CURRENT_DATE
     AND f.entry_date < date_trunc('month', CURRENT_DATE)::date
)
SELECT product_kind, COUNT(*)::int FROM fugou_loose2 GROUP BY product_kind;
```

### 2.5 结果填表（跑完后填这里）

| 指标 | 当月 (本月) | 上月 | 本年 |
|---|---|---|---|
| daily_agg 行数 | _待填_ | | |
| qualifying_days @ 1980 | _待填_ | | |
| qualifying_days @ 1000 | _待填_ | | |
| qualifying_days @ 500 | _待填_ | | |
| first_entry 总数 | _待填_ | | |
| 老客（entry_date < period.startDate）数 | _待填_ | | |
| `fugou_strict`（现行口径） | _待填_ | | |
| `fugou_loose`（去 ≠entry_date） | _待填_ | | |
| `fugou_loose2`（老客期内任何购买） | _待填_ | | |
| 各 product_kind 复购客数（strict） | _待填_ | | |

> 跑完后**先在本 ticket 写入数据**，再回到 §3 选方案；不要跳过排查直接改 SQL。

---

## 3 候选方案（按 §2 数据结论选 1-2 个）

每个方案给出：触发条件、修改面、metrics.md 是否要改、回归代价。

### 方案 A：保持 SQL 现状 + UI 空态文案细化（结论 = F 或 A）

**触发条件**：§2 显示 `fugou_strict = 0` 且 `loose_by_kind` 也很小（< 5 客）→ 数据真稀疏。

**修改**：
- `mgmt-product-cycle.wxml` 复购 subsection 空态文案：
  - 现：`暂无数据`
  - 改：`暂无复购客（统计区间：${startDate} ~ ${endDate}）`
- 可选：在 subsection-title 旁加副文案 "需老客重复达标后才计入"（hover/tap 提示）。
- 不改 SQL、不改 metrics.md。

**代价**：极低（仅 wxml + i18n）。

### 方案 B：threshold 调档 + 复购独立 threshold（结论 = B）

**触发条件**：§2 显示 `qualifying_if_500 / qualifying_if_1000` 比 `qualifying_rows` 大一个数量级，且 fugou_strict @ 500 后非空。

**修改**：
- `db/schema/system-configs.ts` 新增 key：`repurchase_threshold`（int，默认 500 或参考 §2 数据中位数）
- `cycleStats` SQL：复购 CTE 用独立 threshold（保留体验/新增的 1980 不变；或全表统一阈值，由业务决策）
- `metrics.md` §"品项-顾客周期"：在"达标日"定义后追加"复购达标日（repurchase_threshold）"独立 key
- admin 设置页（`fengyu-admin/src/app/admin/settings`）暴露该 key 给运营调

**代价**：中等（schema + 路由 + admin UI + metrics.md + 单测）。

### 方案 C：取消 `<> entry_date` 约束（结论 = C）

**触发条件**：§2 显示 `fugou_loose >> fugou_strict`，且 `fugou_loose - fugou_strict` 主要由"当月新增 + 当月再次达标"客户构成。

**修改**：
- `cycleStats` SQL 中 `fugou` CTE 去掉 `AND q.purchase_date <> f.entry_date`
- `metrics.md` §"品项-顾客周期" 表格：把"复购"定义改成"在期内有达标日"，删除"与首购同日不算复购"那条
- `metrics.md` "三类关系" 注释保留：体验 ∩ 复购 = ∅；**新增 ⊆ 复购**（变化点：新增成为复购的子集）
- 单测 `mgmt-product.cycleStats` 增加 case：
  - 客户 A 仅在 entry_date 当天达标 → 应同时计入 xinzeng + fugou
  - 客户 B 仅在 entry_date 当天达标，但 entry_date < period.startDate → 仅在 xinzeng 不出现，period 内若再次达标计 fugou

**代价**：中等（SQL 一行 + metrics.md + 既有 5 个测试 case 需重新核对）。

### 方案 D：fugou 改为"已 entry 老客在期内任何购买"（结论 = C 进阶版）

**触发条件**：§2 §2.4 显示 `fugou_loose2 >> fugou_strict`，业务方认可"老客本月任何消费即算复购"。

**修改**：
- `cycleStats` SQL 中 `fugou` CTE 改为：
  ```sql
  fugou AS (
    SELECT DISTINCT pa.client_user_id, pa.product_kind
      FROM period_agg pa
      JOIN first_entry f ON f.client_user_id = pa.client_user_id
                        AND f.product_kind   = pa.product_kind
     WHERE f.entry_date < $1  -- entry 在 period 之前
  )
  ```
- 此口径下 fugou 与 xinzeng **互斥**（fugou 仅老客；xinzeng 仅期内首次达标客）
- `metrics.md` 同步更新；"复购客单价"分母换为 fugou_loose2

**代价**：偏高（SQL 改写 + 既有测试假设全改 + 业务沟通成本）。

### 方案 E：默认 period 改"本年" 或"全期"（结论 = A 或 F）

**触发条件**：§2 显示当月很稀疏但本年/全期数据量充足。

**修改**：
- 顶部 chip 默认值从 `month` 改为 `year`
- 或新增 `all` 选项（与 backend.pr.spec sales-data 页一致与否需评估）
- `metrics.md` 时间窗口表追加 `all` 维度

**代价**：低-中（前端 1 行改 + 后端 period 校验扩 1 项）。

### 方案 F：product_kind 粒度下沉到二级品类（结论 = D）

**触发条件**：§2 显示 4 类 product_kind 中只有"护理项目"有 fugou 数据，"家居产品 / 体验卡 / 充值卡" 长期空。

**修改**：
- 表头从单层 product_kind 4 行改为二级展开（product_kind → product_categories.name）
- SQL `GROUP BY` 加一级
- UI 表格组件改为可展开行
- metrics.md 重写一段

**代价**：高（UI 改动较大），暂不推荐为第一版方案。

---

## 4 决策点（业务/产品需明确的 4 个 Y/N 问题）

| ID | 问题 | 候选 | 决策人 | 当前默认 | **已决（2026-04-25）** |
|---|---|---|---|---|---|
| Q1 | "复购"严格定义：是"该品项已 entry 的老客在期内**再次达到 threshold**"，还是"该品项已 entry 的老客在期内**有任何购买**"？ | 严格 / 宽松 | 业务方 | 严格（现行） | **B 中庸** — 保留 threshold，去掉"非首日"约束 |
| Q2 | 是否允许"复购 threshold"独立于"新增 threshold"（如新增 1980 / 复购 500）？ | 是 / 否 | 业务方 | 否（共用） | **共用 1980** |
| Q3 | 当 fugou_strict = 0 时空态文案是否需要细化为"暂无复购客"？ | 是 / 否 | UI / PM | 否（暂无数据） | **保持"暂无数据"** |
| Q4 | 顶部 period 默认是否扩成"本年"？ | 改 / 不改 | 业务方 / PM | 不改（本月） | **不改（本月）** |

> 选定方案：§3 **方案 C**（取消 `<> entry_date` 约束）。其他方案均否决。
> 副作用注记：**新增（xinzeng）⊆ 复购（fugou）** —— 同 period 内首次达标且当日购买金额本身就 ≥ threshold 时，该客户同时被计入新增与复购（与现行 metrics.md 中"新增 ∩ 复购 可有交集"一致，但区别在于现行口径下交集仅由"次日再次达标"贡献，新口径下首日同样贡献）。

---

## 5 实施步骤（待 §4 决策后填具体代码 diff）

### STEP A：排查（必做，无依赖）
1. 跑 §2.1 ~ §2.4 诊断 SQL，把数据填回 §2.5
2. 在本 ticket 注明根因结论（A-F）
3. 把诊断结果发业务方/PM 确认 Q1-Q4

### STEP B：决策（须 §A 数据 + 业务方对齐）
- 选定方案（A 单独 / B+C / D / E / F 任一组合）
- 把决策记录追加到本 ticket §4 "已决"区块

### STEP C：编码（按选定方案）
- 改 `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js`（SQL）
- 改 `notes/references/metrics.md`（口径表 + 三类关系注释）
- 视方案改 `mgmt-product-cycle.wxml`（空态文案）/ `db/schema/system-configs.ts`（新 key）
- 跑 `tsc --noEmit`（admin 若改设置页）+ 云函数 lint

### STEP D：测试
- 既有单测 `cycleStats` 5 case 全部回归
- 按方案新增 case：
  - 方案 C：xinzeng ∩ fugou 非空场景
  - 方案 D：fugou 与 xinzeng 互斥场景
  - 方案 B：双 threshold 各自校验
- dev / test 双库手动跑"本月/上月/本年" × scope 三档（all / market / store）

### STEP E：部署
- `cloudbase-deploy` 触发 staffApi 重新部署
- 部署后用管理层账号登录验证"品项数据"页 → "复购情况"行数 > 0 或文案细化

### STEP F：归档
- 本 ticket 移入 `notes/tickets/archives/`
- `metrics.md` 顶部"决策日志"行追加：`2026-04-25 复购口径修订 …`

---

## 6 不在本 ticket 范围

- **体验情况 / 新增情况** 若也"暂无数据"：本 ticket §2 诊断 SQL 顺带覆盖，但口径修复另开 ticket
- **持卡人数（截面）** 显示问题独立（口径不依赖 threshold/fugou）
- **多市场 scope picker** 越权排查独立
- **复购指标的趋势图 / 同比环比**：当前页只展示截面值，趋势化是另一阶段
- **顾客侧推送复购提醒**：营销范畴，与本"看板信息缺失"无关

---

## 7 交付物清单

### 7.1 排查产物（必出）
- [ ] §2.5 数据表填齐
- [ ] 候选根因结论（A-F）写入本 ticket
- [ ] Q1-Q4 决策结论写入本 ticket

### 7.2 编码（按决策方案）
- [ ] `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js`（cycleStats SQL）
- [ ] `notes/references/metrics.md` "品项-顾客周期" 章节口径修订
- [ ] `fengyu-staff/miniprogram/packageMgmt/mgmt-product-cycle/mgmt-product-cycle.wxml`（空态文案，方案 A 必做）
- [ ] `db/schema/system-configs.ts` + `fengyu-admin/src/app/admin/settings`（仅方案 B）
- [ ] `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-product.test.js`（按方案新增 case）

### 7.3 验证
- [ ] 排查前后"复购情况"各 product_kind 行数对比表（贴在本 ticket §2.5）
- [ ] route 单测全绿
- [ ] dev/test 双库 × scope 三档手测通过
- [ ] 管理层账号端到端复测：mgmt-dashboard → 品项数据 → 复购情况 显示符合预期
