import { isValidInventoryCalendarDate } from '@/lib/calendar-date'
import { db } from '@/db'
import 'server-only'
import { ApiError } from '@/lib/api-error'
import { shanghaiToday } from '@/lib/datetime'
import { withPermission } from '@/lib/with-permission'
import { sql, type SQL } from 'drizzle-orm'
import type { InventorySettlementReport, InventorySettlementRow } from './types'
import {
  inventoryPriceScopeByTier,
  inventoryPriceVisibility,
  inventoryScopedOrgNodeIds,
  inventoryTierRestrictedOrgNodeIds,
} from './access'

export type SettlementSegment = 'market' | 'store'

/**
 * 结算单据类型表（**单源**）：把「符号 / 归期口径 / 是否交换端点 / 计价列」数据化，
 * 汇总、下钻明细、异步导出三处共用同一份，让「哪类单据怎么并入」成为可断言的常量，
 * 而不是散在 SQL 里的 CASE 约定。
 *
 * ⚠️ 端点方向**不是**统一的：`院退货` 是反向单（source=门店、target=市场，`business.ts:5274-5281`），
 * 需要交换；而 `市场退货` 与 `市场报货` **同向**（报货 source=marketId、target=供应链主体，
 * `business.ts:2933-2934`；退货 source=市场、target=总部，`:5282-5285`），不能交换 ——
 * 早期方案「退货一律交换」会把市场退货送进 `(总部, 市场)` 这个语义相反的分组。
 *
 * ⚠️ 归期：正向单用 `doc_date`；退货单用**审批日** —— 退货建单时是 `待审批`、审批才置 `已完成`
 * （`business.ts:5311` / `:5442-5447`），若按申请日归期，10 月的审批会**改写已出的 9 月凭证**
 * 且不留痕迹。`approved_at` 是 timestamptz 且由 `NOW()` 写入，必须转上海时区截断。
 * 已驳回单 `approved_at` 为 NULL，天然落在期间之外。
 *
 * ⚠️ 计价：`市场退货` 用**市场价**而非批次门店价。若沿用批次快照（`store_actual_unit_price`），
 * 供应链价格档（市场段对其可见）可由「金额 ÷ 数量」反推出门店结算价，违反 §9.5。
 */
const SETTLEMENT_DOC_KINDS = [
  { segment: 'market', docType: '市场报货', status: '已完成', sign: 1, swapped: false, marketPrice: false },
  { segment: 'market', docType: '市场退货', status: '已完成', sign: -1, swapped: false, marketPrice: true },
  { segment: 'store', docType: '分院配货', status: '待收货', sign: 1, swapped: false, marketPrice: false },
  { segment: 'store', docType: '分院配货', status: '已完成', sign: 1, swapped: false, marketPrice: false },
  { segment: 'store', docType: '院退货', status: '已完成', sign: -1, swapped: true, marketPrice: false },
] as const satisfies ReadonlyArray<{
  segment: SettlementSegment
  docType: string
  status: string
  sign: number
  swapped: boolean
  marketPrice: boolean
}>

/** 供测试与文档引用的只读视图。 */
export const settlementDocKinds = SETTLEMENT_DOC_KINDS

/**
 * 门店间调货（`分院调货出库/入库`）**刻意不在表内**：它两端同属一个市场
 * （`engine.ts:708-722` 强制同一 `parentLocationId`），净额为 0，并入只会破坏
 * 「下钻明细合计 = 汇总行」而不产生任何金额信息。市场间调货同理（与门店应付无关）。
 */

/** 保留库存 0001–9999 年口径，复用 calendar-date 单源，非法值在 SQL 前拒绝。 */
export function assertRealCalendarDate(value: string, label: string): void {
  if (!isValidInventoryCalendarDate(value)) {
    throw new ApiError('INVALID_PARAMS', `${label}不是有效的日历日期`)
  }
}

/** 期间归一（默认本月 01 ~ 今天）。下钻明细复用同一份，日期口径不会分叉。 */
export function normalizeSettlementPeriod(filters: { startDate?: string | null; endDate?: string | null }) {
  if ((filters.startDate != null && typeof filters.startDate !== 'string')
    || (filters.endDate != null && typeof filters.endDate !== 'string')) {
    throw new ApiError('INVALID_PARAMS', '结算期间日期格式必须为 YYYY-MM-DD')
  }
  const today = shanghaiToday()
  const startDate = filters.startDate?.trim() || `${today.slice(0, 8)}01`
  const endDate = filters.endDate?.trim() || today
  assertRealCalendarDate(startDate, '结算开始日期')
  assertRealCalendarDate(endDate, '结算结束日期')
  if (startDate > endDate) {
    throw new ApiError('INVALID_PARAMS', '结算开始日期不能晚于结束日期')
  }
  return { startDate, endDate }
}

export interface SettlementProjectionParams {
  segment: SettlementSegment
  startDate: string
  endDate: string
  scopedOrgNodeIds: string[] | null
  /** 市场筛选：用 `inventory_docs.market_id`（由 DB 触发器统一派生，四类单据都正确）。 */
  market?: string
}

function kindValuesSql(segment: SettlementSegment): SQL {
  const kinds = SETTLEMENT_DOC_KINDS.filter((kind) => kind.segment === segment)
  return sql.join(
    kinds.map((kind) => sql`(${kind.docType}, ${kind.status}, ${kind.sign}::int, ${kind.swapped}::boolean, ${kind.marketPrice}::boolean)`),
    sql`, `,
  )
}

/**
 * 归一化投影：把四类单据投影成 `(市场主体, 对方主体, 符号, 归期, 带符号金额)`。
 *
 * **汇总、下钻、导出三处必须全部从这个投影取数** —— 这是「下钻明细合计 = 汇总行」的
 * 结构性保证。不能用"共用同一 where 工厂"来替代：WHERE 是行过滤，而交换端点是**投影**，
 * 下钻按本行的两个端点过滤时，原始列反向的退货行一条都查不到（汇总净额 0、明细合计却非 0）。
 */
export function settlementProjectionSql(params: SettlementProjectionParams): SQL {
  const conditions: SQL[] = []
  if (params.scopedOrgNodeIds !== null) {
    if (params.scopedOrgNodeIds.length === 0) {
      conditions.push(sql`FALSE`)
    } else {
      // scope 作用在**原始列**上（两端 OR）。档位收窄也走同一条路 —— 退货单的原始端点是反的，
      // 但"任一端在范围内即可见"对正反两类都成立。
      const ids = sql.join(params.scopedOrgNodeIds.map((id) => sql`${id}`), sql`, `)
      conditions.push(sql`(d.source_org_node_id IN (${ids}) OR d.target_org_node_id IN (${ids}))`)
    }
  }
  if (params.market) conditions.push(sql`d.market_id = ${params.market}`)

  return sql`
    SELECT p.*,
           COALESCE(market_loc.name, p.market_node) AS market_name,
           COALESCE(party_loc.name, p.party_node) AS party_name
      FROM (
        SELECT
          CASE WHEN kind.swapped THEN d.target_org_node_id ELSE d.source_org_node_id END AS market_node,
          CASE WHEN kind.swapped THEN d.source_org_node_id ELSE d.target_org_node_id END AS party_node,
          kind.sign,
          kind.swapped,
          kind.market_price,
          d.market_id,
          d.doc_type,
          d.id AS doc_id,
          d.status,
          i.id AS item_id,
          i.sku_id,
          i.sku_name,
          i.spec_name,
          i.batch_no,
          i.is_gift,
          i.quantity,
          i.standard_unit_price,
          i.unit_discount,
          i.actual_unit_price,
          i.amount,
          i.market_standard_unit_price,
          i.market_unit_discount,
          i.market_actual_unit_price,
          i.store_standard_unit_price,
          i.store_unit_discount,
          i.store_actual_unit_price,
          -- 市场退货按市场价计价；其余按触发器算好的 amount（赠送行为 0）。
          -- 市场价缺失时回退供应链成本价，都缺则记 0（不冲减），绝不回落到门店价。
          -- 赠送行一律不冲减：与「赠送行 amount = 0」的不变量对齐（市场退货也要判 is_gift，
          -- 否则它会按市场价×数量算出非零冲减，而对应的正向赠送行金额是 0）。
          kind.sign * (
            CASE WHEN kind.market_price
                 THEN CASE WHEN i.is_gift THEN 0
                           ELSE COALESCE(i.market_actual_unit_price, i.supply_chain_unit_cost, 0) * i.quantity
                      END
                 ELSE COALESCE(i.amount, 0) END
          ) AS signed_amount,
          CASE WHEN kind.swapped OR kind.market_price
               THEN (d.approved_at AT TIME ZONE 'Asia/Shanghai')::date
               ELSE d.doc_date END AS effective_date
          FROM inventory_docs d
          JOIN inventory_doc_items i ON i.doc_id = d.id
          JOIN (VALUES ${kindValuesSql(params.segment)})
            AS kind(doc_type, status, sign, swapped, market_price)
            ON kind.doc_type = d.doc_type AND kind.status = d.status
         WHERE ${conditions.length ? sql.join(conditions, sql` AND `) : sql`TRUE`}
      ) AS p
      -- org_node_id 唯一；LEFT JOIN 不漏掉缺主体档案的历史行，也不放大行数
      LEFT JOIN inventory_locations market_loc ON market_loc.org_node_id = p.market_node
      LEFT JOIN inventory_locations party_loc ON party_loc.org_node_id = p.party_node
     WHERE p.effective_date >= ${params.startDate}::date
       AND p.effective_date <= ${params.endDate}::date
  `
}

const SETTLEMENT_DOC_TYPES = [...new Set(SETTLEMENT_DOC_KINDS.map((kind) => kind.docType))]

/**
 * 市场筛选下拉的选项：scope 内的全部市场，**不受期间与当前 market 筛选影响**。
 *
 * 不能从 `marketRows` 派生 —— 报表行已按 market 过滤，再从它派生会让「筛一次就只剩当前市场、
 * 回不去」（来源明细组件用 `marketOptions` 取自全量行的写法规避了同一坑，这里走服务端下发）。
 */
async function listSettlementMarketOptions(scopedOrgNodeIds: string[] | null): Promise<Array<{ id: string; name: string }>> {
  if (scopedOrgNodeIds !== null && scopedOrgNodeIds.length === 0) return []
  const conditions: SQL[] = [
    sql`d.market_id IS NOT NULL`,
    sql`d.doc_type IN (${sql.join(SETTLEMENT_DOC_TYPES.map((docType) => sql`${docType}`), sql`, `)})`,
  ]
  if (scopedOrgNodeIds !== null) {
    const ids = sql.join(scopedOrgNodeIds.map((id) => sql`${id}`), sql`, `)
    conditions.push(sql`(d.source_org_node_id IN (${ids}) OR d.target_org_node_id IN (${ids}))`)
  }
  const rows = await db.execute(sql`
    SELECT DISTINCT d.market_id AS id, COALESCE(loc.name, d.market_id) AS name
      FROM inventory_docs d
      LEFT JOIN inventory_locations loc ON loc.org_node_id = d.market_id
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY name
  `) as unknown as Array<{ id: string; name: string }>
  return rows.map((row) => ({ id: row.id, name: row.name }))
}

interface RawSummaryRow {
  market_node: string | null
  market_name: string | null
  party_node: string | null
  party_name: string | null
  doc_count: number
  return_doc_count: number
  total_quantity: string | number
  returned_quantity: string | number
  payable_amount: string | number
}

async function summarizeSettlementDocs(params: SettlementProjectionParams): Promise<InventorySettlementRow[]> {
  // 空 scope = fail-closed 且**不发查询**（不是查出来再过滤掉）：历史/兼容会话没有 org 绑定时
  // 一次 PG 往返都不该花。投影里的 FALSE 分支仍保留，兜住下钻/导出那些直接调投影的路径。
  if (params.scopedOrgNodeIds !== null && params.scopedOrgNodeIds.length === 0) return []
  const projection = settlementProjectionSql(params)
  const rows = await db.execute(sql`
    SELECT p.market_node, p.market_name, p.party_node, p.party_name,
           COUNT(DISTINCT CASE WHEN p.sign > 0 THEN p.doc_id END)::int AS doc_count,
           COUNT(DISTINCT CASE WHEN p.sign < 0 THEN p.doc_id END)::int AS return_doc_count,
           COALESCE(SUM(CASE WHEN p.sign > 0 THEN p.quantity ELSE 0 END), 0) AS total_quantity,
           COALESCE(SUM(CASE WHEN p.sign < 0 THEN p.quantity ELSE 0 END), 0) AS returned_quantity,
           COALESCE(SUM(p.signed_amount), 0) AS payable_amount
      FROM (${projection}) AS p
     GROUP BY p.market_node, p.market_name, p.party_node, p.party_name
     ORDER BY p.market_name, p.party_name
  `) as unknown as RawSummaryRow[]
  return rows.map((row) => ({
    sourceOrgNodeId: row.market_node,
    sourceOrgNodeName: row.market_name,
    targetOrgNodeId: row.party_node,
    targetOrgNodeName: row.party_name,
    docCount: Number(row.doc_count ?? 0),
    returnDocCount: Number(row.return_doc_count ?? 0),
    totalQuantity: Number(row.total_quantity ?? 0),
    returnedQuantity: Number(row.returned_quantity ?? 0),
    payableAmount: Number(row.payable_amount ?? 0),
  }))
}

/**
 * 货款结算只读报表：
 * - 市场结算（市场应付供应链，已冲减期间内已完成的「市场退货」）随供应链/市场价格档可见
 *   （§9.5 供应链可见市场结算价、市场可见本市场进货价）；
 * - 分院结算（门店应付市场，已冲减期间内已完成的「院退货」）仅市场价格档可见；
 * - none 档（门店库存员）两段均不可见，服务端不返回任何金额字段；
 * - scope 复用 inventoryScopedOrgNodeIds：库存总部不展开后代，市场含本市场及门店。
 *
 * ⚠️ 金额是**净额**（正向 − 退货），可为负（上月配货本月退货）；数量与单据数**不净额化**：
 * 「0 件」既可能是一配一退、也可能是本来没单，净掉就说不清了。
 */
export const listInventorySettlements = withPermission(
  'inventory:list',
  async (
    session,
    filters: { startDate?: string; endDate?: string; market?: string } = {},
  ): Promise<InventorySettlementReport> => {
    const { startDate, endDate } = normalizeSettlementPeriod(filters)
    const market = typeof filters.market === 'string' ? filters.market.trim() || undefined : undefined
    const priceVisibility = inventoryPriceVisibility(session)
    const canViewMarketSettlement = priceVisibility !== 'none'
    const canViewStoreSettlement = priceVisibility === 'all' || priceVisibility === 'market'
    if (!canViewMarketSettlement && !canViewStoreSettlement) {
      // 门店价格档：金额一律不出服务端，直接返回空报表。
      return {
        startDate,
        endDate,
        priceVisibility,
        marketOptions: [],
        canViewMarketSettlement: false,
        canViewStoreSettlement: false,
        marketRows: [],
        storeRows: [],
      }
    }
    const scopedOrgNodeIds = inventoryScopedOrgNodeIds(session)
    // 行级档位（§9.3/§9.5）：结算行整行即金额，按「scope ∩ 对应档位绑定的 org 集合」
    // 收紧查询范围——混合绑定会话（门店 A + 市场 B 财务）不得借市场 B 的价格权
    // 汇总门店 A 所在市场的货款。单绑定会话两集合一致，行为与现状相同。
    const priceTiers = inventoryPriceScopeByTier(session)
    const marketScopedOrgNodeIds = inventoryTierRestrictedOrgNodeIds(
      scopedOrgNodeIds,
      [priceTiers.supplyChain, priceTiers.market],
    )
    const storeScopedOrgNodeIds = inventoryTierRestrictedOrgNodeIds(
      scopedOrgNodeIds,
      [priceTiers.market],
    )
    // 选项按**两段收窄后的并集**生成，与会话能看到的行保持一致 ——
    // 用未收窄的 scoped 会列出「选了却是空表」的市场（混合绑定会话尤其明显）。
    const optionScopedOrgNodeIds = marketScopedOrgNodeIds === null || storeScopedOrgNodeIds === null
      ? null
      : [...new Set([...marketScopedOrgNodeIds, ...storeScopedOrgNodeIds])]
    const [marketOptions, marketRows, storeRows] = await Promise.all([
      listSettlementMarketOptions(optionScopedOrgNodeIds),
      canViewMarketSettlement
        ? summarizeSettlementDocs({ segment: 'market', startDate, endDate, scopedOrgNodeIds: marketScopedOrgNodeIds, market })
        : Promise.resolve([]),
      canViewStoreSettlement
        ? summarizeSettlementDocs({ segment: 'store', startDate, endDate, scopedOrgNodeIds: storeScopedOrgNodeIds, market })
        : Promise.resolve([]),
    ])
    return {
      startDate,
      endDate,
      priceVisibility,
      marketOptions,
      canViewMarketSettlement,
      canViewStoreSettlement,
      marketRows,
      storeRows,
    }
  },
)
