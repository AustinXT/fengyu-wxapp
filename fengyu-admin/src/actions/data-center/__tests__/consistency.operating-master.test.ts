/**
 * 经营数据主表（#372）与销售板的口径同源守护。
 *
 * 验收要求 P / W / X 与销售板「门店」明细的「总业绩」「总实耗」「生美实耗」同月逐店相等。
 * 两边各写一份 SQL（主表不改 sales.ts，免得牵动销售板的既有守护），所以这里按**整段模板等值**比对：
 * 抽出两边的 sql`...` 模板，把 `${...}` 插值统一成占位符、压空白后必须逐字相等。
 * 只逐条 toMatch 几个关键谓词挡不住「多加一个条件」「少一个 JOIN」这类漂移（见 memory
 * feedback-literal-guard-whole-segment-equality）。
 *
 * V 生美项目数没有销售板对应物：钉成「X 生美实耗的模板，只把求和表达式换成 SUM(sit.session_used)」。
 *
 * #373 增量：
 *   - E 保有会员 = 客量板「有效保有会员」（customer.ts queryRetainedMembers）：WHERE 整段等值（只归一时点变量名）；
 *   - K / L 被经营的款项 WHERE = P 的 WHERE，只把 sale_order_type 收窄为 ('销售单', '转换单')、再加「挂了顾客」一条。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SALES = fs.readFileSync(path.resolve(__dirname, '../sales.ts'), 'utf8')
const CUSTOMER = fs.readFileSync(path.resolve(__dirname, '../customer.ts'), 'utf8')
const MASTER = fs.readFileSync(path.resolve(__dirname, '../operating-master.ts'), 'utf8')

function slice(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  if (from === -1) throw new Error(`找不到切片起点：${start}`)
  const to = src.indexOf(end, from + start.length)
  if (to === -1) throw new Error(`找不到切片终点：${end}`)
  return src.slice(from, to)
}

/**
 * 切片内唯一一段 sql`...` 模板，空白压缩。插值**只归一区间变量**（两边变量名不同：`cur` / `range`），
 * 其余插值原文保留——scope 过滤的列、寄存退款过滤的别名一旦不同必须变红。
 */
function template(section: string): string {
  const matches = [...section.matchAll(/sql`([\s\S]*?)`/g)]
  if (matches.length !== 1) throw new Error(`切片里应恰有 1 段 sql 模板，实际 ${matches.length} 段`)
  return matches[0][1]
    .replace(/\$\{(?:cur|range)\.(start|end)\}/g, '${$1}')
    .replace(/\s+/g, ' ')
    .trim()
}

const sales = {
  revenue: template(slice(SALES, '// 业绩（付款流水现金流）', '// 生美业绩')),
  consume: template(slice(SALES, '      // 实耗\n', '// 生美实耗')),
  shengmeiConsume: template(slice(SALES, '      // 生美实耗\n', '    ])')),
}
const master = {
  revenue: template(slice(MASTER, 'function revenueByStoreSql', 'function managedByStoreSql')),
  project: template(slice(MASTER, '// V 生美项目数', '// W 实耗')),
  consume: template(slice(MASTER, '// W 实耗', '// X 生美实耗')),
  shengmeiConsume: template(slice(MASTER, '// X 生美实耗', '// E 保有会员')),
}

/** 模板里第一个 WHERE 到其后第一个终止串之间（即过滤谓词整段）；终止串缺省 GROUP BY，传 null 取到模板末尾 */
function whereClause(body: string, end: string | null = ' GROUP BY '): string {
  const from = body.indexOf(' WHERE ')
  const to = end === null ? body.length : body.indexOf(end, from)
  if (from === -1 || to === -1) throw new Error(`模板里找不到 WHERE … ${end}`)
  return body.slice(from, to).trim()
}

/** 多段 sql 模板的切片：取第一段（E 的 CTE 里嵌了 visitDaysSql 插值，模板本身只有一段） */
function firstTemplate(section: string): string {
  const match = section.match(/sql`([\s\S]*?)`/)
  if (!match) throw new Error('切片里没有 sql 模板')
  return match[1].replace(/\s+/g, ' ').trim()
}

const retained = {
  customerBoard: template(slice(CUSTOMER, 'async function queryRetainedMembers', '// ====')),
  master: firstTemplate(slice(MASTER, '// E 保有会员', '// L 被经营当月')),
}
const managed = template(slice(MASTER, 'function managedByStoreSql', 'export const getOperatingMaster'))

describe('经营数据主表 × 销售板门店明细 口径同源（#372）', () => {
  it('P 当月完成 / R 年度累计 = 销售板门店「总业绩」整段模板', () => {
    expect(master.revenue).toBe(sales.revenue)
    // R 走同一个函数，只换区间
    expect(MASTER.match(/revenueByStoreSql\(session, scope, (cur|ytd)\)/g)).toEqual([
      'revenueByStoreSql(session, scope, cur)',
      'revenueByStoreSql(session, scope, ytd)',
    ])
  })

  it('W 当月总实耗 = 销售板门店「总实耗」整段模板', () => {
    expect(master.consume).toBe(sales.consume)
  })

  it('X 当月生美实耗 = 销售板门店「生美实耗」整段模板', () => {
    expect(master.shengmeiConsume).toBe(sales.shengmeiConsume)
  })

  it('V 生美项目数 = X 的模板只换求和表达式', () => {
    expect(master.project).toBe(
      master.shengmeiConsume.replace('SUM(sit.unit_real_price::numeric * sit.session_used)', 'SUM(sit.session_used)'),
    )
    expect(master.project).not.toBe(master.shengmeiConsume)
  })

  it('W / X / V 只取当月区间（不是年度累计区间）', () => {
    for (const body of [master.consume, master.shengmeiConsume, master.project]) {
      expect(body).toContain('so.service_date BETWEEN ${start} AND ${end}')
      expect(body).toContain("${scopeFilterSql(session, scope, 'so.store_id')}")
      expect(body).toContain("${excludeDepositRefundSql('so')}")
    }
    expect(slice(MASTER, '// W 实耗', '      ])')).not.toMatch(/ytd\./)
  })

  it('E 保有会员 = 客量板「有效保有会员」WHERE 整段（按绑定门店 scope、90 天窗口、became_member_at 守卫）', () => {
    const board = whereClause(retained.customerBoard, null).replace(/\$\{sc\}/, "${scopeFilterSql(session, scope, 'c.bound_store_id')}")
      .replace(/\$\{end\}/g, '${T}') // template() 已把 range.end 归一成 end
    // 客量板的 scope 片段是先赋给 sc 再插值：确认 sc 就是按绑定门店过滤
    expect(slice(CUSTOMER, 'async function queryRetainedMembers', '// ====')).toContain(
      "const sc = scopeFilterSql(session, scope, 'c.bound_store_id')",
    )
    const master = whereClause(retained.master, ' ), month_visits AS')
      .replace(/\$\{asOf\}/g, '${T}')
    expect(master).toBe(board)
    expect(board).toContain("INTERVAL '90 days'")
  })

  it('K / L 款项 WHERE = P 的 WHERE，只把类型收窄为销售单 + 转换单、再要求挂了顾客', () => {
    const p = whereClause(master.revenue)
    const expected = p.replace("spe.sale_order_type IN ('销售单', '转换单', '充值单')", "spe.sale_order_type IN ('销售单', '转换单')")
      + ' AND so.client_user_id IS NOT NULL'
    expect(expected).not.toBe(p + ' AND so.client_user_id IS NOT NULL')
    expect(whereClause(managed)).toBe(expected)
  })

  it('守护自检：切到的模板确实是承重谓词（防切片漂移后两边一起变成空串也相等）', () => {
    expect(sales.revenue).toContain("spe.sale_order_type IN ('销售单', '转换单', '充值单')")
    expect(sales.consume).toContain("so.status = '已完成'")
    expect(sales.shengmeiConsume).toContain('sit.is_shengmei = TRUE')
    expect(sales.consume).not.toContain('is_shengmei')
  })
})
