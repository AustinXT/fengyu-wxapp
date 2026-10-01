/**
 * 日常数据一览表（#369）与销售板的口径同源守护。
 *
 * 验收要求「业绩合计 = 销售板总业绩、服务合计 = 销售板总实耗，逐店成立」。两处 SQL 各写一份（按子项拆分的
 * 查询没法直接复用销售板的标量查询），靠这里做**整段等值**比对：只允许约定好的那一处差异，
 * 其余任何谓词增删改（比如顺手加一个 so.status='已支付'、改一个 change_type）都会红。
 *
 * 为什么整段比而不是逐条 toMatch：逐条匹配只能证明「某条谓词在」，证明不了「没有多出一条」——
 * 多出的过滤恰恰是两边对不上的常见成因（见 memory feedback-literal-guard-whole-segment-equality）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const SALES = path.resolve(__dirname, '../sales.ts')
const DAILY = path.resolve(__dirname, '../../../lib/data-center/daily-overview-sql.ts')

/** 取 marker 之后第一个 sql`...` 模板的正文（这些 SQL 里没有嵌套反引号），压缩空白 */
function sqlAfter(src: string, marker: string): string {
  const at = src.indexOf(marker)
  expect(at, `找不到定位标记：${marker}`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('sql`', at)
  const close = src.indexOf('`', open + 4)
  expect(open, `${marker} 之后没有 sql 模板`).toBeGreaterThan(at)
  // 区间变量名不同（标量 runner 用 range、逐店明细用 cur）不算口径差异，统一成 ${start} / ${end}
  return src.slice(open + 4, close).replace(/\s+/g, ' ').replace(/\$\{(?:range|cur)\.(start|end)\}/g, '${$1}').trim()
}

/** WHERE 子句按 AND 拆成谓词列表（首项是 scope 过滤） */
function predicates(body: string): string[] {
  const where = body.slice(body.indexOf('WHERE ') + 'WHERE '.length).replace(/ GROUP BY .*$/, '')
  return where.split(' AND ').map((part) => part.trim())
}

let sales = ''
let daily = ''

beforeAll(() => {
  sales = fs.readFileSync(SALES, 'utf-8')
  daily = fs.readFileSync(DAILY, 'utf-8')
})

describe('业绩合计 = 销售板总业绩', () => {
  it('较上期基期的业绩合计 SQL 与 sales.ts runStoreRevenue 整段相同', () => {
    expect(sqlAfter(daily, 'function performanceTotalSql')).toBe(sqlAfter(sales, 'const runStoreRevenue'))
  })

  it('拆分用的款项集合（pay CTE）只把单据类型收窄为「销售单 + 转换单」，其余谓词与总业绩逐条相同', () => {
    const base = predicates(sqlAfter(sales, 'const runStoreRevenue'))
    const pay = predicates(sqlAfter(daily, '// 销售单 + 转换单业绩').replace(/ \), receipt AS .*$/, ''))
    const typeLine = "spe.sale_order_type IN ('销售单', '转换单', '充值单')"
    expect(base).toContain(typeLine)
    expect(pay).toEqual(base.map((line) => (line === typeLine ? "spe.sale_order_type IN ('销售单', '转换单')" : line)))
  })

  it('充值列只把单据类型收窄为「充值单」，其余谓词与总业绩逐条相同', () => {
    const base = predicates(sqlAfter(sales, 'const runStoreRevenue'))
    const recharge = predicates(sqlAfter(daily, '// 充值单：没有商品明细'))
    const typeLine = "spe.sale_order_type IN ('销售单', '转换单', '充值单')"
    expect(recharge).toEqual(base.map((line) => (line === typeLine ? "spe.sale_order_type = '充值单'" : line)))
  })

  it('三类单据类型恰好拆成「销售单 + 转换单」与「充值单」两段，不重不漏', () => {
    const typesOf = (line: string) => [...line.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const pay = predicates(sqlAfter(daily, '// 销售单 + 转换单业绩').replace(/ \), receipt AS .*$/, ''))
    const recharge = predicates(sqlAfter(daily, '// 充值单：没有商品明细'))
    const split = [
      ...typesOf(pay.find((line) => line.startsWith('spe.sale_order_type'))!),
      ...typesOf(recharge.find((line) => line.startsWith('spe.sale_order_type'))!),
    ].sort()
    expect(split).toEqual(['充值单', '转换单', '销售单'].sort())
  })

  it('拆分不丢钱：分母为 0 / 无 receipts 整笔进未分类，sale_items / product_skus 一律 LEFT JOIN', () => {
    const body = sqlAfter(daily, '// 销售单 + 转换单业绩')
    expect(body).toContain('JOIN receipt rc ON rc.sale_payment_id = pay.sale_payment_id AND rc.denominator <> 0')
    expect(body).toContain('LEFT JOIN sale_items si ON si.sale_item_id = rc.sale_item_id')
    expect(body).toContain('LEFT JOIN product_skus sku ON sku.sku_id = si.sku_id')
    expect(body).toContain(
      'WHERE NOT EXISTS ( SELECT 1 FROM receipt rc WHERE rc.sale_payment_id = pay.sale_payment_id AND rc.denominator <> 0 )',
    )
    // 缩放必须除以「该款项全部 receipts 之和」，不能用 NULLIF 把分母为 0 的整笔吞成 NULL
    expect(body).toContain('SUM(r.amount::numeric) OVER (PARTITION BY r.sale_payment_id) AS denominator')
    expect(body).toContain('SUM(rc.amount * pay.amount / rc.denominator)')
    expect(body).not.toMatch(/NULLIF/i)
  })
})

describe('服务合计 = 销售板总实耗', () => {
  it('较上期基期的服务合计 SQL 与 sales.ts runStoreConsume 整段相同', () => {
    expect(sqlAfter(daily, 'function serviceTotalSql')).toBe(sqlAfter(sales, 'const runStoreConsume'))
  })

  it('按经营类型分组的服务 SQL：FROM / JOIN / WHERE 与总实耗整段相同，只多分组维度', () => {
    const fromWhere = (body: string) => body.slice(body.indexOf(' FROM ')).replace(/ GROUP BY .*$/, '')
    expect(fromWhere(sqlAfter(daily, '// 服务（实耗）按经营类型'))).toBe(fromWhere(sqlAfter(sales, 'const runStoreConsume')))
    expect(sqlAfter(daily, '// 服务（实耗）按经营类型')).toMatch(/GROUP BY so\.store_id, sit\.sales_category$/)
  })
})

describe('逐店口径：销售板逐店 SQL 与标量 SQL 谓词相同（验收要求「逐店 = 销售板」，传递到本页）', () => {
  it('销售板逐店业绩（GROUP BY spe.store_id）与 runStoreRevenue 谓词逐条相同', () => {
    expect(predicates(sqlAfter(sales, '// 业绩（付款流水现金流）'))).toEqual(predicates(sqlAfter(sales, 'const runStoreRevenue')))
  })

  it('销售板逐店实耗（GROUP BY so.store_id）与 runStoreConsume 谓词逐条相同', () => {
    expect(predicates(sqlAfter(sales, '      // 实耗\n'))).toEqual(predicates(sqlAfter(sales, 'const runStoreConsume')))
  })
})

describe('全文快照：拆分维度（SELECT / GROUP BY）同样是承重口径', () => {
  // 上面的谓词比对锁不住投影与分组：把 sku.category_id 换成 si.sku_id、或把 si.sales_category 换成 NULL，
  // 过滤条件一条没动、lib 单测吃的又是手工构造的输入，全绿之下视角②③会整列落进「未分类」。
  // 这里钉住整段 SQL 文本；有意改口径时连同 PR 说明一起改这三段期望值（实跑验证见 PR「未分类兜底实测」）。
  it.each([
    ['// 销售单 + 转换单业绩',
    "WITH pay AS ( SELECT spe.sale_payment_id, spe.store_id, spe.amount::numeric AS amount FROM sale_order_performance_events spe WHERE ${scopeFilterSql(session, scope, 'spe.store_id')} AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.sale_order_type IN ('销售单', '转换单') AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${start} AND ${end} ), receipt AS ( SELECT r.sale_payment_id, r.sale_item_id, r.amount::numeric AS amount, SUM(r.amount::numeric) OVER (PARTITION BY r.sale_payment_id) AS denominator FROM sale_payment_item_receipts r WHERE r.sale_payment_id IN (SELECT sale_payment_id FROM pay) ) SELECT 'total' AS kind, pay.store_id, NULL::text AS sales_category, NULL::text AS category_id, SUM(pay.amount)::text AS amount FROM pay GROUP BY pay.store_id UNION ALL SELECT 'part' AS kind, pay.store_id, si.sales_category::text AS sales_category, sku.category_id, SUM(rc.amount * pay.amount / rc.denominator)::text AS amount FROM pay JOIN receipt rc ON rc.sale_payment_id = pay.sale_payment_id AND rc.denominator <> 0 LEFT JOIN sale_items si ON si.sale_item_id = rc.sale_item_id LEFT JOIN product_skus sku ON sku.sku_id = si.sku_id GROUP BY pay.store_id, si.sales_category, sku.category_id UNION ALL SELECT 'part' AS kind, pay.store_id, NULL::text AS sales_category, NULL::text AS category_id, SUM(pay.amount)::text AS amount FROM pay WHERE NOT EXISTS ( SELECT 1 FROM receipt rc WHERE rc.sale_payment_id = pay.sale_payment_id AND rc.denominator <> 0 ) GROUP BY pay.store_id",
    ],
    ['// 充值单：没有商品明细',
    "SELECT spe.store_id, SUM(spe.amount::numeric)::text AS amount FROM sale_order_performance_events spe WHERE ${scopeFilterSql(session, scope, 'spe.store_id')} AND spe.status = '已支付' AND spe.change_type IN ('首次支付', '回款', '退款') AND spe.sale_order_type = '充值单' AND spe.legacy_source IS DISTINCT FROM 'workfine' AND spe.performance_date BETWEEN ${start} AND ${end} GROUP BY spe.store_id",
    ],
    ['// 服务（实耗）按经营类型',
    "SELECT so.store_id, sit.sales_category::text AS sales_category, SUM(sit.unit_real_price::numeric * sit.session_used)::text AS amount FROM service_orders so JOIN service_items sit ON sit.service_order_id = so.service_order_id JOIN sale_items si ON si.sale_item_id = sit.sale_item_id WHERE ${scopeFilterSql(session, scope, 'so.store_id')} AND so.status = '已完成' AND so.service_date BETWEEN ${start} AND ${end} AND ${excludeDepositRefundSql('so')} GROUP BY so.store_id, sit.sales_category",
    ],
  ])('%s 整段与快照一致', (marker, expected) => {
    expect(sqlAfter(daily, marker)).toBe(expected)
  })
})

describe('横切约束', () => {
  const code = () => daily.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  it('不带「父订单已结清」过滤（与 #300 同方向；staff 端同名汇总带该过滤，口径不同）', () => {
    expect(code()).not.toMatch(/so\.status\s*=\s*'已支付'/)
  })

  it('不加 >0 / HAVING 过滤（#290/#288）：负数原样显示', () => {
    expect(code()).not.toMatch(/HAVING/i)
    // `<> 0` 是缩放分母判零（分母为 0 的款项走 NOT EXISTS 分支整笔进未分类），不是金额过滤
    expect(code()).not.toMatch(/(?<![<])>=?\s*0\b/)
  })
})
