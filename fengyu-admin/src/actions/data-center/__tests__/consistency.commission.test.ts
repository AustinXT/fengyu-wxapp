/**
 * 员工提成日报（#375）与 staff 管理层「员工收入」的取数口径一致性守护。
 *
 * 验收要求：同一门店同一天的业绩 / 消耗提成分别等于 staff「员工收入」日卡的销售 / 服务两部分。
 * 两端 SQL 形态不同（Drizzle sql`` vs 原生 pg；admin 按 BETWEEN 区间、staff 按 timeWindow），
 * 所以不比整条 SQL，而是把决定口径的两部分**整段等值**比对（逐条禁写法必被绕过，见
 * feedback-literal-guard-whole-segment-equality / feedback-guard-closed-set-not-open-set）：
 *   1. 取数链：FROM … JOIN … 整段（表、别名、连接键）归一化后逐字相等
 *   2. 静态谓词：两端 WHERE 里所有「列 与 字面量」比较组成的**闭集**逐项相等（多一条、少一条、改一个值都红）
 *   3. 归日列：业绩 = spe.performance_date、消耗 = so.service_date
 * 任一端改动，本测试即变红。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ADMIN_SQL = path.resolve(__dirname, '../../../lib/data-center/commission-sql.ts')
const STAFF_MGMT_DASHBOARD = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** 按首尾锚点切片（fail-closed：任一锚点未命中直接失败，不退化成空串或整文件） */
function sliceOrFail(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  expect(from, `切片起点锚未命中：${start}`).toBeGreaterThan(-1)
  const to = src.indexOf(end, from + start.length)
  expect(to, `切片终点锚未命中：${end}`).toBeGreaterThan(-1)
  return normalize(stripComments(src.slice(from, to)))
}

/** 取数链：从 `FROM <主表>` 到 WHERE 之前（或片段结尾） */
function fromChain(segment: string, mainTable: string): string {
  const match = new RegExp(`FROM ${mainTable} \\w+ (?:JOIN [^]*?)(?= WHERE|\`|$)`).exec(segment)
  expect(match, `未找到 ${mainTable} 取数链`).not.toBeNull()
  return match![0].trim()
}

/** 静态谓词闭集：`别名.列 = FALSE` / `= '字面量'` / `IN ('…', …)`，插值（${…}）的动态条件不在其内 */
function staticPredicates(segment: string): string[] {
  const pattern = /\b[a-z_0-9]+\.[a-z_]+ (?:= FALSE|= TRUE|= '[^']*'|IN \((?:'[^']*'(?:, )?)+\))/g
  return (segment.match(pattern) ?? []).sort()
}

const admin = fs.readFileSync(ADMIN_SQL, 'utf8')
const staff = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf8')

describe('业绩提成：admin commission-sql ↔ staff querySalesCommissionIncome', () => {
  const adminChain = sliceOrFail(admin, 'const SALE_FROM = sql`', '`\n')
  const adminWhere = sliceOrFail(admin, 'function saleWhere(', '\n}\n')
  const staffSegment = sliceOrFail(staff, 'async function querySalesCommissionIncome', 'async function queryServiceCommissionIncome')

  it('取数链整段相等', () => {
    expect(fromChain(adminChain, 'sale_payment_item_allocations')).toBe(fromChain(staffSegment, 'sale_payment_item_allocations'))
  })

  it('静态谓词闭集相等（is_void / 单据类型 / 款项状态）', () => {
    const expected = ["so.sale_order_type IN ('销售单', '转换单')", "spe.status = '已支付'", 'spia.is_void = FALSE'].sort()
    expect(staticPredicates(adminWhere)).toEqual(expected)
    expect(staticPredicates(staffSegment)).toEqual(expected)
  })

  it('归日列 = 款项归属日期 spe.performance_date', () => {
    expect(adminWhere).toContain('AND spe.performance_date BETWEEN ${filters.range.start} AND ${filters.range.end}')
    expect(staffSegment).toContain("timeWindow('spe.performance_date'")
  })

  it('提成额取落库的 commission_amount（不重算）', () => {
    expect(staffSegment).toContain('SUM(spia.commission_amount::numeric)')
    expect(normalize(admin)).toContain('COALESCE(spia.commission_amount::numeric, 0) AS sale_commission')
  })
})

describe('消耗提成：admin commission-sql ↔ staff queryServiceCommissionIncome', () => {
  const adminChain = sliceOrFail(admin, 'const SERVICE_FROM = sql`', '`\n')
  const adminWhere = sliceOrFail(admin, 'function serviceWhere(', '\n}\n')
  // staff 这段用 sc2 作别名，归一到 sc 后比较
  const staffSegment = sliceOrFail(staff, 'async function queryServiceCommissionIncome', '\n}\n').replace(/\bsc2\b/g, 'sc')

  it('取数链整段相等', () => {
    expect(fromChain(adminChain, 'service_commissions')).toBe(fromChain(staffSegment, 'service_commissions'))
  })

  it('静态谓词闭集相等（is_void / 服务单已完成）', () => {
    const expected = ["so.status = '已完成'", 'sc.is_void = FALSE'].sort()
    expect(staticPredicates(adminWhere)).toEqual(expected)
    expect(staticPredicates(staffSegment)).toEqual(expected)
  })

  it('归日列 = 服务日期 so.service_date', () => {
    expect(adminWhere).toContain('AND so.service_date BETWEEN ${filters.range.start} AND ${filters.range.end}')
    expect(staffSegment).toContain("timeWindow('so.service_date'")
  })

  it('提成额取落库的 commission_amount（不重算）', () => {
    expect(staffSegment).toContain('SUM(sc.commission_amount::numeric)')
    expect(normalize(admin)).toContain('sc.commission_amount::numeric AS service_commission')
  })
})

describe('明细与汇总复用同一取数链与条件（不另写一份）', () => {
  const body = normalize(stripComments(admin))

  it('除 SALE_FROM / SERVICE_FROM 定义本身外，不再出现手写的取数链', () => {
    // 待分配提示里的 NOT EXISTS 子查询也读 spia，但不带 JOIN 链，不算取数链
    expect(body.match(/FROM sale_payment_item_allocations spia JOIN/g)).toHaveLength(1)
    expect(body.match(/FROM service_commissions sc JOIN/g)).toHaveLength(1)
  })

  it('不加 >0 / HAVING >0 过滤（#290）：唯一的 HAVING 是隐藏 0 行的 <> 0', () => {
    expect(body.match(/HAVING .*?(?= \))/g)).toEqual(['HAVING SUM(sale_commission + service_commission) <> 0'])
  })
})
