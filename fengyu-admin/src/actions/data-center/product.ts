'use server'

/**
 * 数据中心 — 品项板块取数 action（getProductBoard）
 *
 * 口径权威：notes/references/metrics.md
 *   - §「品项顾客周期子页（mgmt-product-cycle）」（持卡截面 + daily_agg→qualifying_days /
 *     repurchase_qualifying_days→first_entry→period_agg→xinzeng/fugou/tiyan CTE 链）
 *   - §「品项顾客周期子页 → 3. 二级品项（category_name）粒度」（admin 独有的二级下钻扩展）
 *   - §「品项维度汇总」（一级=product_kind，二级=category_name）
 *
 * 移植源（CloudBase 纯 JS 原生 SQL，禁止 import，照搬口径成 admin Drizzle raw SQL）：
 *   fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js
 *     - cardHolders：持卡人数 + 占比（截面快照，不随 period 变化）
 *     - cycleStats：体验/新增/复购全套 CTE（区间维度，时间轴为支付事件业绩归属日）
 *
 * ★ 口径红线（consistency.product.test.ts 字面量守护，禁止偏离）：
 *   - 持卡 = si.paid_sessions > 0。不再按 product_type 过滤。
 *   - 持卡 sale_order_type IN ('销售单','转换单','寄存单')（寄存单为 WorkFine 剩余次数初始化纳入）。
 *   - 占比分母 = memberCount（client_wechat_users.became_member_at IS NOT NULL ∩ scope by bound_store_id，
 *     持卡为截面，不带 $date 守卫）。
 *   - ★★ **持卡占比的分子必须与分母同源，两个维度都要同**（#287，2026-09-24 拍板）：
 *       ① 人群：分子也只算会员（became_member_at IS NOT NULL），不是全部顾客
 *       ② 归店：分子的 scope / 分组键也用 c.bound_store_id，不是 so.store_id
 *     两条合起来 ⇒ 分子人群 ⊆ 分母人群、归店键相同 ⇒ 占比数学上恒 ≤ 100%。
 *     此前两条都不满足：集团恒 253%、单店最高 2600%、40 家在营门店 36 家 > 100%。
 *     **只修 ① 不够** —— 实测仍有 7 家 > 100%、最高 104.55%。
 *   - 进入达标日 = 销售单/转换单/寄存单的 SUM(sale_item_performance_events.amount) 在
 *     (client_user_id, store_id, 分组键, purchase_date) 分组下 >= threshold。
 *   - 复购达标日与区间业绩只统计销售单/转换单；寄存单只作为进入基线，不能触发复购。
 *   - ★ 区间业绩是**净额**（#288）：退款负数冲销逐笔抵减，净额为负的日子不得整组丢弃；
 *     只剔除纯寄存日（purchase_received = 0）。体验判定与人数归店只认正数购买日（day_received > 0），
 *     负数行只进业绩、不造人。
 *   - purchase_date = sale_item_performance_events.performance_date。
 *   - entry_date = 全历史（截至 endDate）最早达标日，跨店合并；新增 = entry_date 落区间；
 *     复购 = 区间内 entry_date 后再次达标（threshold 共用）；体验 = 区间内有购买但全历史无达标日。
 *   - cycleStats 基础过滤 sale_order_type IN ('销售单','转换单','寄存单') ∩ 排除已关闭/已作废/未审核/待审批/支付失败；
 *     不要求 status='已支付'，received 达标即计入。
 *   - scope：cycleStats 用 so.store_id；**持卡分子与 memberCount 分母都用 c.bound_store_id**
 *     （#287 起，见上面那条同源红线 —— 这里曾写作「scope 用 so.store_id」，是缺陷的来源之一）。
 *
 * ★ 一级/二级筛选（admin 独有，staff 仅一级 product_kind）：
 *   - 都不选 / 仅选一级 → 分组键 = pc.product_kind（仅选一级时额外 WHERE pc.product_kind = $kind）
 *   - 选到二级 → 分组键 = pc.category_name（WHERE pc.product_kind = $kind AND pc.category_name = $name）
 *   口径与一级完全同构，唯一差异是分组键（daily_agg/first_entry 的 GROUP BY 维度同步替换）。
 *
 * 性能：daily_agg 全历史扫描（purchase_date <= endDate 无下界）；持卡截面 + cycle 区间分多查询。
 */

import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { withComparison } from '@/lib/data-center/comparison'
import { getMemberThreshold } from '@/lib/member-threshold'
import type { AuthSession } from '@/lib/types'
import type {
  BreakdownRow,
  DataCenterScope,
  KpiCell,
  ProductBoardParams,
  ProductBoardResult,
  ResolvedRange,
} from '@/lib/data-center/types'

// ── 工具 ──────────────────────────────────────────────────────────────
const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100
/** 取数组首行（db.execute 返回数组） */
const first = (rows: unknown): Record<string, unknown> =>
  ((rows as unknown[])[0] as Record<string, unknown>) ?? {}
/** 安全除法（分母 <= 0 → null，前端 '--'） */
const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null)

/**
 * 品项分组键 + WHERE 过滤片段（一级 product_kind / 二级 category_name 切换）。
 *   - categoryName 非空（必附 productKind）→ 分组键 pc.category_name，过滤一级+二级
 *   - productKind 非空 → 分组键 pc.product_kind，过滤一级
 *   - 都不选 → 分组键 pc.product_kind，无品项过滤（仅守卫 product_kind IS NOT NULL）
 */
function resolveGrouping(params: ProductBoardParams): { groupCol: SQL; filter: SQL } {
  const kind = params.productKind?.trim() || ''
  const category = params.categoryName?.trim() || ''
  if (category) {
    return {
      groupCol: sql.raw('pc.category_name'),
      filter: sql`pc.product_kind = ${kind} AND pc.category_name = ${category}`,
    }
  }
  if (kind) {
    return {
      groupCol: sql.raw('pc.product_kind'),
      filter: sql`pc.product_kind = ${kind}`,
    }
  }
  return {
    groupCol: sql.raw('pc.product_kind'),
    filter: sql`pc.product_kind IS NOT NULL`,
  }
}

// =====================================================================
// 筛选器数据源：一级品项 + 其下二级品项名
// =====================================================================
async function queryFilterOptions(): Promise<Array<{ kind: string; categories: string[] }>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT pc.product_kind AS kind, pc.category_name AS category
    FROM product_categories pc
    WHERE pc.product_kind IS NOT NULL
    ORDER BY pc.product_kind, pc.category_name
  `)
  const map = new Map<string, string[]>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const kind = String(r.kind ?? '')
    const category = String(r.category ?? '')
    if (!kind) continue
    if (!map.has(kind)) map.set(kind, [])
    if (category && !map.get(kind)!.includes(category)) map.get(kind)!.push(category)
  }
  return Array.from(map.entries()).map(([kind, categories]) => ({ kind, categories }))
}

// =====================================================================
// 持卡人数（截面快照，不随 period 变化）
// =====================================================================

/**
 * 持卡人数（占比分子）：**会员** ∩ 买过带次数商品 ∩ scope（`c.bound_store_id`）∩ 品项过滤。
 * 截面快照，无时间区间。
 *
 * ★ **口径红线：分子必须与分母 `queryMemberCount` 同源**（#287）。
 *
 * 写法上用「分母的壳 + `EXISTS`」而不是「JOIN 顾客表再加条件」，是为了让
 * **分子 ⊆ 分母** 成为结构性事实而非巧合 —— 两者共用同一个
 * `FROM client_wechat_users c WHERE <scope on bound_store_id> AND became_member_at IS NOT NULL`
 * 前缀，`EXISTS` 只做收窄。**改这里时务必保持这个形状**，`consistency.product.test.ts` 有断言锁它。
 *
 * ⚠️ **两处曾经不同源，2026-09-22 审计时占比恒 253%、单店最高 2600%**：
 *   1. **人群**：分子统计全部顾客（不限客型）、分母只统计会员 —— 分子里有 60.8% 的人
 *      永不可能进分母
 *   2. **归店**：分子按 `so.store_id`（**订单所属门店**）、分母按 `c.bound_store_id`
 *      （**顾客绑定门店**）—— 绑在 B 店的会员在 A 店买卡，会进 A 的分子、B 的分母
 *
 * 只修 ①（issue #287 原推荐）实测仍有 **7 家门店 > 100%、最高 104.55%**；
 * ① ② 都修后 **0 家 > 100%、最高正好 100.00%**（集团 1917 / 1931 = 99.27%，2026-09-24 实测）。
 *
 * ⚠️ 绝对值每日漂移，**别写进断言** —— 可锁的是「0 家 > 100%」这个结构性不变量。
 *
 * ⚠️ **该列已失去区分度，勿用于门店排名**：修正后各店在 **95.83% ~ 100%** 之间。
 * 此前的全部店间方差都来自「非会员数量」，按旧列排名会得到与事实相反的结论。
 */
async function queryCardHolders(
  session: AuthSession,
  scope: DataCenterScope,
  filter: SQL,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.became_member_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM sale_items si
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN product_skus sk ON sk.sku_id = si.sku_id
        JOIN product_categories pc ON pc.category_id = sk.category_id
        WHERE so.client_user_id = c.user_id
          AND si.paid_sessions > 0
          AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
          AND so.status = '已支付'
          AND ${filter}
      )
  `)
  return num(first(rows).v)
}

/** 会员数（占比分母）：became_member_at IS NOT NULL ∩ scope（bound_store_id），截面（不带 $date 守卫）。 */
async function queryMemberCount(session: AuthSession, scope: DataCenterScope): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.became_member_at IS NOT NULL
  `)
  return num(first(rows).v)
}

// =====================================================================
// 体验 / 新增 / 复购（区间维度，时间轴 purchase_date）
// 单标量 runner（供 withComparison 跑本期/上期/去年同期）。
// 每个 range 自包含：daily_agg 用 purchase_date <= range.end（全历史下界），period_agg 用 BETWEEN。
// =====================================================================

type CycleGroup = 'trial' | 'new' | 'repurchase'

/**
 * 单一品项粒度（已被 filter 收窄为单组）的体验/新增/复购人数 + 业绩。
 * 返回 { count, revenue }（按 group 取对应段）。
 */
async function queryCycle(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  threshold: number,
  groupCol: SQL,
  filter: SQL,
  group: CycleGroup,
  metric: 'count' | 'revenue',
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             ${groupCol} AS grp,
             sipe.performance_date AS purchase_date,
             SUM(sipe.amount::numeric) AS day_received,
             COALESCE(
               SUM(sipe.amount::numeric) FILTER (
                 WHERE so.sale_order_type IN ('销售单', '转换单')
               ),
               0
             ) AS purchase_received
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
        AND so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND sipe.performance_date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, sipe.performance_date
      -- #288：只剔除「两列都为 0」的空组（如当日销售与退款恰好抵平）。负数净额组必须保留 ——
      -- 退款走负数冲销、不删行，此前「> 0」把净额为负的日子整组丢掉，冲销被吞、业绩只进不出。
      -- 也不能只判 day_received <> 0：寄存单金额恰好抵平销售单/转换单净额的日子（day_received = 0、
      -- purchase_received <> 0）仍会被误丢。FILTER 无行时为 NULL，NULL <> 0 不成立，与 0 同待遇。
      HAVING SUM(sipe.amount::numeric) <> 0
          OR SUM(sipe.amount::numeric) FILTER (WHERE so.sale_order_type IN ('销售单', '转换单')) <> 0
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    repurchase_qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE purchase_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, grp
    ),
    -- 区间业绩行（#288）：纳入负数净额日，退款冲销逐笔抵减业绩；只排除纯寄存日（purchase_received = 0）。
    -- ⚠️ 负数行只能进业绩、不能「造人」：凡从这里判定人数或归店，都必须再加 day_received > 0。
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, purchase_received AS day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
        AND purchase_received <> 0
    ),
    xinzeng AS (
      SELECT client_user_id, grp, entry_date
      FROM first_entry
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.grp
      FROM repurchase_qualifying_days q
      JOIN xinzeng x ON x.client_user_id = q.client_user_id AND x.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
        AND q.purchase_date > x.entry_date
    ),
    tiyan AS (
      SELECT DISTINCT pa.client_user_id, pa.grp
      FROM period_agg pa
      WHERE pa.day_received > 0
        AND NOT EXISTS (
          SELECT 1 FROM first_entry f
          WHERE f.client_user_id = pa.client_user_id AND f.grp = pa.grp
        )
    ),
    cohort AS (
      ${
        group === 'trial'
          ? sql`SELECT client_user_id, grp FROM tiyan`
          : group === 'new'
            ? sql`SELECT client_user_id, grp FROM xinzeng`
            : sql`SELECT client_user_id, grp FROM fugou`
      }
    )
    SELECT
      COUNT(DISTINCT c.client_user_id) AS count,
      COALESCE(SUM(pa.day_received), 0) AS revenue
    FROM cohort c
    LEFT JOIN period_agg pa
      ON pa.client_user_id = c.client_user_id AND pa.grp = c.grp
  `)
  const r = first(rows)
  return metric === 'count' ? num(r.count) : round2(r.revenue)
}

// =====================================================================
// 明细表（byMarket / byStore）：scope 骨架逐组聚合，不做同比环比
// =====================================================================

interface ProductStoreAgg {
  cardHolders: number
  trialCount: number
  newCount: number
  newRevenue: number
  repurchaseCount: number
  repurchaseRevenue: number
}

/**
 * 持卡人数（截面）按门店归组 —— **归店键必须是 `c.bound_store_id`，与分母
 * `queryMemberCountByStore` 完全一致**（#287）。
 *
 * 归店键一致 + 人群是分母的子集 ⇒ **每个门店的占比数学上恒 ≤ 100%**，不靠数据侥幸。
 * 此前按 `so.store_id` 归店，同一顾客跨店各算一次，单店占比可以超过 100%（实测最高 2600%）。
 *
 * 代价：语义从「在本店买过卡的人」变成「本店绑定会员里持卡的人」。
 * 受影响的是**买卡门店 ≠ 绑定门店**的那批人（2026-09-24 实测 11 人，占分子 0.57%）——
 * 他们从「买卡那家店」挪到「绑定那家店」，不是被丢弃。2026-09-24 拍板取后者。
 */
async function queryCardHoldersByStore(
  session: AuthSession,
  scope: DataCenterScope,
  filter: SQL,
): Promise<Map<string, number>> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT c.bound_store_id AS store_id, COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.bound_store_id IS NOT NULL
      AND c.became_member_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM sale_items si
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN product_skus sk ON sk.sku_id = si.sku_id
        JOIN product_categories pc ON pc.category_id = sk.category_id
        WHERE so.client_user_id = c.user_id
          AND si.paid_sessions > 0
          AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
          AND so.status = '已支付'
          AND ${filter}
      )
    GROUP BY c.bound_store_id
  `)
  const m = new Map<string, number>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.store_id ?? '')
    if (id) m.set(id, num(r.v))
  }
  return m
}

/** 会员数按 store_id 归组（占比分母，bound_store_id）。 */
async function queryMemberCountByStore(
  session: AuthSession,
  scope: DataCenterScope,
): Promise<Map<string, number>> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT c.bound_store_id AS store_id, COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.bound_store_id IS NOT NULL
      AND c.became_member_at IS NOT NULL
    GROUP BY c.bound_store_id
  `)
  const m = new Map<string, number>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.store_id ?? '')
    if (id) m.set(id, num(r.v))
  }
  return m
}

/**
 * 体验/新增/复购人数 + 新增业绩 + 复购业绩，按 store_id 归组（单查，全套 CTE）。
 *
 * **人数归店规则**（#286 修正后；#288 起只认正数购买日 `day_received > 0`）：
 *   - 体验 / 复购：期内正数购买日所在门店。这两类人必然有正数 `period_agg` 行 ——
 *     `tiyan` 本就从正数行派生，`fugou` 要求 `purchase_received >= threshold > 0`。
 *   - **新增**：`COALESCE(正数行.store_id, xinzeng.entry_store_id)` —— 期内有销售单/转换单
 *     正数消费的落消费门店，**没有的落「进入达标日所在门店」**。
 *
 * **业绩归店规则**（#288）：`period_agg` 全部行（含负数冲销日）按其 `store_id` 求净额。
 * 人数与业绩分两套口径是刻意的：退款必须逐笔抵减业绩，但「期内只有退款」不代表该店有这位顾客的消费 ——
 * 若让负数行参与归店，2026-09 prod 实测会凭空多出 60 名体验顾客、133 个新增归店组合。
 * 于是新增拆成 `new_store`（人数）与 `new_revenue_store`（业绩）两个 CTE。
 *
 * ⚠️ 为什么新增必须兜底（#286，实测漏 **65.5%**）：`period_agg` 要求
 * `purchase_received > 0`，而 `purchase_received` 只统计销售单/转换单、**不含寄存单**；
 * 而进入达标（`first_entry` → `entry_store` → `xinzeng`）走的是 `day_received`，**含寄存单**。
 * 于是「进入达标日金额全部来自寄存单」的顾客在 `xinzeng` 里有、在 `period_agg` 里没有 ——
 * 旧实现以 `period_agg` 作主表再内连接回来，把他们整体丢弃，
 * 派生的新增客单价与复购率因此双双虚高 **2.90 倍**。
 *
 * **与 KPI 总量的关系**：明细是组内 DISTINCT、KPI 是全局 DISTINCT，
 * 所以 **明细各门店人数相加 ≥ KPI 总量**，差额 = Σ(每位顾客落的门店数 − 1)。
 * 这是归组语义决定的、与 sales 板块一致。**单店 scope 下二者严格相等**（跨店重复不存在）。
 *
 * **为什么不让集团也严格相等**：只要给每个 `(client, grp)` 强行保留一家门店即可做到，
 * 但那样**人数与业绩会归到不同门店**（顾客在 A 店花的钱记在 A 店，人却可能计到 B 店），
 * 该店的「新增客单价 = 新增业绩 ÷ 新增人数」随即失真，且与 sales 板的归组语义分叉。
 * 权衡后保留「可多店」，由 UI/文档说明差额来源。
 *
 * 业绩不受 #286 影响（它只丢人、不丢钱）：KPI 与明细的新增业绩都是 xinzeng 在 `period_agg` 上的净额。
 *
 * ⚠️ 新形态：「本期只有寄存单进入、零销售单消费」的门店会出现
 * `新增人数 N > 0` 而 `新增业绩 = 0` ⇒ 客单价显示 `0.00` 而非 `--`（`safeDiv` 分母 > 0）。
 * 数值是诚实的，不是 bug。同理（#288），退款冲销大于期内消费的门店新增/复购业绩可以为**负**。
 *
 * 具体数字（会随数据漂移）一律见 `_tmp/issue-286/verify.md`，不写进本注释。
 */
async function queryCycleByStore(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  threshold: number,
  groupCol: SQL,
  filter: SQL,
): Promise<
  Map<
    string,
    {
      trialCount: number
      newCount: number
      newRevenue: number
      repurchaseCount: number
      repurchaseRevenue: number
    }
  >
> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             ${groupCol} AS grp,
             sipe.performance_date AS purchase_date,
             SUM(sipe.amount::numeric) AS day_received,
             COALESCE(
               SUM(sipe.amount::numeric) FILTER (
                 WHERE so.sale_order_type IN ('销售单', '转换单')
               ),
               0
             ) AS purchase_received
      FROM sale_item_performance_events sipe
      JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
      WHERE ${sc}
        AND so.sale_order_type IN ('销售单', '转换单', '寄存单')
        AND so.status NOT IN ('已关闭', '已作废', '未审核', '待审批', '支付失败')
        AND so.client_user_id IS NOT NULL
        AND ${filter}
        AND sipe.performance_date <= ${range.end}
      GROUP BY so.client_user_id, so.store_id, ${groupCol}, sipe.performance_date
      -- #288：只剔除「两列都为 0」的空组（如当日销售与退款恰好抵平）。负数净额组必须保留 ——
      -- 退款走负数冲销、不删行，此前「> 0」把净额为负的日子整组丢掉，冲销被吞、业绩只进不出。
      -- 也不能只判 day_received <> 0：寄存单金额恰好抵平销售单/转换单净额的日子（day_received = 0、
      -- purchase_received <> 0）仍会被误丢。FILTER 无行时为 NULL，NULL <> 0 不成立，与 0 同待遇。
      HAVING SUM(sipe.amount::numeric) <> 0
          OR SUM(sipe.amount::numeric) FILTER (WHERE so.sale_order_type IN ('销售单', '转换单')) <> 0
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE day_received >= ${threshold}
    ),
    repurchase_qualifying_days AS (
      SELECT client_user_id, store_id, grp, purchase_date
      FROM daily_agg
      WHERE purchase_received >= ${threshold}
    ),
    first_entry AS (
      SELECT client_user_id, grp, MIN(purchase_date) AS entry_date
      FROM qualifying_days
      GROUP BY client_user_id, grp
    ),
    -- 区间业绩行（#288）：纳入负数净额日，退款冲销逐笔抵减业绩；只排除纯寄存日（purchase_received = 0）。
    -- ⚠️ 负数行只能进业绩、不能「造人」：凡从这里判定人数或归店，都必须再加 day_received > 0。
    period_agg AS (
      SELECT client_user_id, store_id, grp, purchase_date, purchase_received AS day_received
      FROM daily_agg
      WHERE purchase_date BETWEEN ${range.start} AND ${range.end}
        AND purchase_received <> 0
    ),
    -- 进入达标日 + 当日所在门店，一次取齐（#286）。
    --
    -- entry_store_id 是新增人数在「期内无销售单/转换单消费」时的归店兜底。
    -- ⚠️ 这是主干不是边角：归店按 (顾客, 品项) 匹配，生产实测约 **四分之三** 的
    -- (顾客, 品项) 组合在期内没有销售单/转换单消费，全靠这一列归店
    -- （按人计：约六成顾客期内完全无此类消费）。一旦它为 NULL，那批人会静默丢三次（COALESCE 得 NULL 组
    -- → store_ids 排除 NULL → 最终 LEFT JOIN 永不匹配），与 #286 本身是同一个失败模式。
    --
    -- 所以刻意用 DISTINCT ON 让 entry_date 与 entry_store_id **出自同一行**：二者同生共死，
    -- 结构上不存在「有日期却没门店」的组合，也不依赖任何等值匹配 —— 从而绕开了
    -- grp 可空（product_categories.product_kind 在 schema 里可空）带来的 NULL 不安全等值陷阱。
    -- 先前写成「先算 entry_date、再用 qd.grp = fe.grp 回查门店」的版本除了这个 NULL 洞，
    -- 还是 O(|xinzeng| × |qualifying_days|) 的相关子查询，生产实测把本查询拖慢 **+177%**，
    -- 且两个因子都随历史数据线性增长（具体耗时见 _tmp/issue-286/verify.md）。
    --
    -- ORDER BY purchase_date 取最早达标日，与 first_entry 的 MIN(purchase_date) 等价；
    -- 同日跨多店达标时按 store_id 兜底排序（store_id 形如 store-<建店毫秒时间戳>，
    -- 字典序≈建店先后，**无业务含义，仅为结果确定不随执行计划漂**）。
    --
    -- ⚠️ MATERIALIZED 不是装饰：不加的话 planner 对 CTE 的行数估计失真上千倍，
    -- 会选 nested loop 把大部分收益吃掉（consistency.product.test.ts 有断言锁住它）。
    entry_store AS MATERIALIZED (
      SELECT DISTINCT ON (client_user_id, grp)
             client_user_id,
             grp,
             purchase_date AS entry_date,
             store_id AS entry_store_id
      FROM qualifying_days
      ORDER BY client_user_id, grp, purchase_date, store_id
    ),
    xinzeng AS (
      SELECT client_user_id, grp, entry_date, entry_store_id
      FROM entry_store
      WHERE entry_date BETWEEN ${range.start} AND ${range.end}
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.grp
      FROM repurchase_qualifying_days q
      JOIN xinzeng x ON x.client_user_id = q.client_user_id AND x.grp = q.grp
      WHERE q.purchase_date BETWEEN ${range.start} AND ${range.end}
        AND q.purchase_date > x.entry_date
    ),
    tiyan AS (
      SELECT DISTINCT pa.client_user_id, pa.grp
      FROM period_agg pa
      WHERE pa.day_received > 0
        AND NOT EXISTS (
          SELECT 1 FROM first_entry f
          WHERE f.client_user_id = pa.client_user_id AND f.grp = pa.grp
        )
    ),
    -- 期内每个门店每个客群的人数（DISTINCT client per store）+ 业绩（该门店该客群消费）。
    -- ⚠️ 人数与业绩的归店口径不同（#288）：人数只认正数购买日（day_received > 0），
    -- 业绩按 period_agg 全部行求净额。只有退款冲销、没有购买的门店 —— 业绩照扣，但不计人。
    trial_store AS (
      SELECT pa.store_id,
             COUNT(DISTINCT pa.client_user_id) AS cnt
      FROM period_agg pa
      JOIN tiyan t ON t.client_user_id = pa.client_user_id AND t.grp = pa.grp
      WHERE pa.day_received > 0
      GROUP BY pa.store_id
    ),
    -- ⚠️ 主表必须是 xinzeng（#286）：反过来 FROM period_agg JOIN xinzeng 是内连接，
    -- 「进入达标日金额全部来自寄存单」的顾客不在 period_agg 里，会被整体丢弃（实测漏 65.5%）。
    -- 期内无正数购买日的新增顾客落回 entry_store_id。
    -- ON 里的 day_received > 0 只决定人落在哪家店（#288）；它不影响业绩，业绩见 new_revenue_store。
    new_store AS (
      SELECT COALESCE(pa.store_id, x.entry_store_id) AS store_id,
             COUNT(DISTINCT x.client_user_id) AS cnt
      FROM xinzeng x
      LEFT JOIN period_agg pa
        ON pa.client_user_id = x.client_user_id AND pa.grp = x.grp AND pa.day_received > 0
      GROUP BY COALESCE(pa.store_id, x.entry_store_id)
    ),
    -- 新增业绩按消费（含退款冲销）发生的门店归组，净额可为负。
    -- xinzeng 每个 (client_user_id, grp) 恰一行（entry_store 的 DISTINCT ON），内连接不扇出。
    new_revenue_store AS (
      SELECT pa.store_id,
             SUM(pa.day_received) AS revenue
      FROM xinzeng x
      JOIN period_agg pa
        ON pa.client_user_id = x.client_user_id AND pa.grp = x.grp
      GROUP BY pa.store_id
    ),
    repurchase_store AS (
      SELECT pa.store_id,
             COUNT(DISTINCT pa.client_user_id) FILTER (WHERE pa.day_received > 0) AS cnt,
             COALESCE(SUM(pa.day_received), 0) AS revenue
      FROM period_agg pa
      JOIN fugou fg ON fg.client_user_id = pa.client_user_id AND fg.grp = pa.grp
      GROUP BY pa.store_id
    ),
    -- 出行门店骨架（并集），LEFT JOIN 各客群聚合避免 FULL OUTER 链路漏行。
    -- ⚠️ 必须并上 xinzeng 的 entry 门店（#286）：只取 period_agg 的话，
    -- 「期内只有寄存单进入、无销售单/转换单消费」的门店不会出现在骨架里，
    -- new_store 算出来的人数又会在最后一步 JOIN 时丢掉。
    store_ids AS (
      SELECT DISTINCT store_id FROM period_agg
      UNION
      SELECT DISTINCT entry_store_id FROM xinzeng WHERE entry_store_id IS NOT NULL
    )
    SELECT
      s.store_id AS store_id,
      COALESCE(t.cnt, 0) AS trial_count,
      COALESCE(n.cnt, 0) AS new_count,
      COALESCE(nr.revenue, 0) AS new_revenue,
      COALESCE(r.cnt, 0) AS repurchase_count,
      COALESCE(r.revenue, 0) AS repurchase_revenue
    FROM store_ids s
    LEFT JOIN trial_store t ON t.store_id = s.store_id
    LEFT JOIN new_store n ON n.store_id = s.store_id
    LEFT JOIN new_revenue_store nr ON nr.store_id = s.store_id
    LEFT JOIN repurchase_store r ON r.store_id = s.store_id
  `)
  const m = new Map<
    string,
    {
      trialCount: number
      newCount: number
      newRevenue: number
      repurchaseCount: number
      repurchaseRevenue: number
    }
  >()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.store_id ?? '')
    if (!id) continue
    m.set(id, {
      trialCount: num(r.trial_count),
      newCount: num(r.new_count),
      newRevenue: round2(r.new_revenue),
      repurchaseCount: num(r.repurchase_count),
      repurchaseRevenue: round2(r.repurchase_revenue),
    })
  }
  return m
}

/** 组装一行 metrics（持卡/体验/新增/复购 + 派生客单价/占比/复购率） */
function buildMetrics(agg: ProductStoreAgg, memberCount: number): Record<string, number | null> {
  return {
    cardHolders: agg.cardHolders,
    cardHolderRate: safeDiv(agg.cardHolders, memberCount),
    trialCount: agg.trialCount,
    newCount: agg.newCount,
    newRevenue: agg.newRevenue,
    newAvgTicket: safeDiv(round2(agg.newRevenue), agg.newCount),
    repurchaseCount: agg.repurchaseCount,
    repurchaseRevenue: agg.repurchaseRevenue,
    repurchaseRate: safeDiv(agg.repurchaseCount, agg.newCount),
  }
}

// =====================================================================
// 入口
// =====================================================================

export const getProductBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: ProductBoardParams): Promise<ProductBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope, comparison, enabled } = ctx
    const cur = comparison.current

    const { groupCol, filter } = resolveGrouping(params)
    const threshold = await getMemberThreshold()

    // ── 筛选器数据源（独立查询，与 scope 无关）────────────────────
    const filterOptions = await queryFilterOptions()

    // ── KPI ────────────────────────────────────────────────────
    // 持卡 / 占比为截面快照（不随 period 变化），不走 withComparison（只出 value）。
    // 体验 / 新增 / 复购为区间维度，走 withComparison（同比/环比）。
    const cycleRunner =
      (group: CycleGroup, metric: 'count' | 'revenue') => (r: ResolvedRange) =>
        queryCycle(session, scope, r, threshold, groupCol, filter, group, metric)

    const [
      cardHoldersTotal,
      memberCountTotal,
      trialCount,
      newCount,
      newRevenue,
      repurchaseCount,
      repurchaseRevenue,
    ] = await Promise.all([
      queryCardHolders(session, scope, filter),
      queryMemberCount(session, scope),
      withComparison(cycleRunner('trial', 'count'), comparison, 'count', enabled),
      withComparison(cycleRunner('new', 'count'), comparison, 'count', enabled),
      withComparison(cycleRunner('new', 'revenue'), comparison, 'amount', enabled),
      withComparison(cycleRunner('repurchase', 'count'), comparison, 'count', enabled),
      withComparison(cycleRunner('repurchase', 'revenue'), comparison, 'amount', enabled),
    ])

    // 持卡 / 占比（截面，仅 value）
    const cardHolders: KpiCell = { value: cardHoldersTotal, unit: 'count' }
    const cardHolderRate: KpiCell = {
      value: safeDiv(cardHoldersTotal, memberCountTotal),
      unit: 'percent',
    }
    // 客单价 / 复购率派生（自上面已算的 value；防除零 → null）
    const newAvgTicket: KpiCell = {
      value: safeDiv(round2(newRevenue.value ?? 0), newCount.value ?? 0),
      unit: 'amount',
    }
    const repurchaseAvgTicket: KpiCell = {
      value: safeDiv(round2(repurchaseRevenue.value ?? 0), repurchaseCount.value ?? 0),
      unit: 'amount',
    }
    // 复购率 = 复购人数 / 品项进入人数
    const repurchaseRate: KpiCell = {
      value: safeDiv(repurchaseCount.value ?? 0, newCount.value ?? 0),
      unit: 'percent',
    }

    const kpis: Record<string, KpiCell> = {
      cardHolders,
      cardHolderRate,
      trialCount,
      newCount,
      newRevenue,
      newAvgTicket,
      repurchaseCount,
      repurchaseRevenue,
      repurchaseAvgTicket,
      repurchaseRate,
    }

    // ── 明细表（byMarket / byStore，仅当期）────────────────────────
    const skelRows = (await db.execute(scopeStoreSkeletonSql(session, scope))) as unknown[]
    const skeleton = skelRows.map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        marketId: String(r.market_id ?? ''),
        marketName: String(r.market_name ?? ''),
        storeId: String(r.store_id ?? ''),
        storeName: String(r.store_name ?? ''),
      }
    })

    const [cardByStore, memberByStore, cycleByStore] = await Promise.all([
      queryCardHoldersByStore(session, scope, filter),
      queryMemberCountByStore(session, scope),
      queryCycleByStore(session, scope, cur, threshold, groupCol, filter),
    ])

    // 门店级聚合
    const storeAggs = skeleton.map((s) => {
      const cyc = cycleByStore.get(s.storeId)
      const agg: ProductStoreAgg = {
        cardHolders: cardByStore.get(s.storeId) ?? 0,
        trialCount: cyc?.trialCount ?? 0,
        newCount: cyc?.newCount ?? 0,
        newRevenue: cyc?.newRevenue ?? 0,
        repurchaseCount: cyc?.repurchaseCount ?? 0,
        repurchaseRevenue: cyc?.repurchaseRevenue ?? 0,
      }
      return { ...s, agg, memberCount: memberByStore.get(s.storeId) ?? 0 }
    })

    const byStore: BreakdownRow[] = storeAggs.map((s) => ({
      groupId: s.storeId,
      groupName: s.storeName,
      marketName: s.marketName,
      metrics: buildMetrics(s.agg, s.memberCount),
    }))

    // 按市场聚合（在 JS 内按 marketId 求和；占比/客单价/复购率重新派生）
    type MarketAcc = { name: string; agg: ProductStoreAgg; memberCount: number }
    const marketMap = new Map<string, MarketAcc>()
    for (const s of storeAggs) {
      let m = marketMap.get(s.marketId)
      if (!m) {
        m = {
          name: s.marketName,
          agg: {
            cardHolders: 0,
            trialCount: 0,
            newCount: 0,
            newRevenue: 0,
            repurchaseCount: 0,
            repurchaseRevenue: 0,
          },
          memberCount: 0,
        }
        marketMap.set(s.marketId, m)
      }
      m.agg.cardHolders += s.agg.cardHolders
      m.agg.trialCount += s.agg.trialCount
      m.agg.newCount += s.agg.newCount
      m.agg.newRevenue += s.agg.newRevenue
      m.agg.repurchaseCount += s.agg.repurchaseCount
      m.agg.repurchaseRevenue += s.agg.repurchaseRevenue
      m.memberCount += s.memberCount
    }

    const byMarket: BreakdownRow[] = Array.from(marketMap.entries()).map(([id, m]) => ({
      groupId: id,
      groupName: m.name,
      metrics: buildMetrics(
        { ...m.agg, newRevenue: round2(m.agg.newRevenue), repurchaseRevenue: round2(m.agg.repurchaseRevenue) },
        m.memberCount,
      ),
    }))

    // 稳定排序：按 groupName
    byStore.sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-Hans-CN'))
    byMarket.sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-Hans-CN'))

    return {
      ...ctx.meta,
      filterOptions,
      selected: {
        productKind: params.productKind?.trim() || null,
        categoryName: params.categoryName?.trim() || null,
      },
      kpis,
      byMarket,
      byStore,
    }
  },
)
