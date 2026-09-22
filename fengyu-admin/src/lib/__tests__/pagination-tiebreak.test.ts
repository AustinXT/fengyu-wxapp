import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import ts from 'typescript'

/**
 * #282 · 分页查询的 `.orderBy(...)` 必须带唯一键 tie-break（admin 侧）
 *
 * ## 为什么是源码字面量扫描而不是造数据翻页
 *
 * 「造数据翻两页、断言无重复」这类用例对 tie-break **零保护**：单测里 db 是 mock、
 * 不执行 SQL，返回顺序完全由 mock 数组决定 —— 把 `.orderBy(...)` 整条删掉照样绿。
 * #181 / #239 都踩过。真正的护栏只能是源码字面量断言。
 *
 * ## 缺陷是什么
 *
 * `.limit()/.offset()` 分页**每翻一页都是一次独立执行**。PG 对**非唯一**排序键
 * 不保证跨次返回同序（并发写、autovacuum、plan 变化都会改物理扫描顺序）
 * → 两次翻页切出的页可能重复或漏掉某条记录。
 *
 * 两种最骗人的情形：
 *   - `desc(createdAt)` —— 看着够细，但同事务写入的多行 `NOW()` 逐微秒相同
 *   - `asc(name)`       —— 重名顾客即并列
 *
 * ## 两层守护
 *
 * 1. **通用规则**：凡是 `.orderBy(...)` 后面跟着 `.limit(` + `.offset(` 的链，
 *    `orderBy` 的**末位参数**必须含唯一键。防将来新增的分页查询忘了加。
 * 2. **清单钉死**：#282 修的 16 处逐条断言。防已修的被改回去。
 *
 * ## 与云函数侧的关系
 *
 * staffApi / clientApi 各有一份同名守护（`__tests__/routes/pagination-tiebreak.test.js`），
 * 那边解析的是 SQL 字符串、这边解析的是 Drizzle 链式调用，**实现必然不同**，
 * 但**判据一致**（末位排序键必须唯一）。三份是刻意的独立副本
 * （CLAUDE.md：禁止跨端共享代码目录），改一处记得看另两处。
 */

const SRC = resolve(__dirname, '../..')

/** 剥注释（用 TS parser，不手写词法器——理由见 `src/lib/paging.test.ts` 的同名函数） */
function stripComments(source: string, fileName: string): string {
  const sf = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const holes: Array<[number, number]> = []
  const visit = (node: ts.Node) => {
    for (const r of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) holes.push([r.pos, r.end])
    for (const r of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) holes.push([r.pos, r.end])
    node.getChildren(sf).forEach(visit)
  }
  visit(sf)
  // 按 UTF-16 code unit 挖空（TS 的 range 是 UTF-16 偏移；码点下标会让 emoji 之后错位）
  const chars = source.split('')
  for (const [from, to] of holes) {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' '
  }
  return chars.join('')
}

/** 递归收集 .ts/.tsx（跳过测试） */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSources(full, acc)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/**
 * 从 `.orderBy(` 起按括号深度切出完整参数列表（**不能用正则**：参数里嵌套
 * `desc(x.y)` / `sql\`…\`` 的括号会让「匹配到第一个 `)`」切错）。
 */
function orderByArgs(code: string, at: number): string | null {
  const open = code.indexOf('(', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return code.slice(open + 1, i).replace(/\s+/g, ' ').trim()
    }
  }
  return null
}

/**
 * 末位排序参数是否含唯一键。
 *
 * ⚠️ 启发式，不是「真的查了 schema」：认 `xxxId` / `.id`。
 * 代价是 `desc(o.storeId)`（外键，对本表不唯一）也会被放行 ——
 * 所以第 2 层的清单钉死不能省，两层各管一段。
 */
function looksUnique(arg: string): boolean {
  return /\.\s*(id|[a-zA-Z0-9]*Id)\s*\)?\s*$/.test(arg.trim())
}

/**
 * 从 `end` 位置起，吃掉**同一条链**上后续的 `.method(...)`，遇到非链式 token 即停。
 *
 * ⚠️ 不能用「往后取 N 个字符/行」当窗口：第一版取 1200 字符，
 * `logs.ts` 里一个**不分页**的 `.orderBy()` 因此扫到了**下一个函数**的 `.offset(`，
 * 被误判成缺 tie-break 的分页查询。链式边界必须精确。
 */
function chainTail(code: string, end: number): string {
  let i = end
  let out = ''
  while (i < code.length) {
    while (i < code.length && /\s/.test(code[i])) i++
    if (code[i] !== '.') break
    const open = code.indexOf('(', i)
    if (open < 0) break
    // 方法名里不能有别的 `.`，否则是新语句
    if (/[^\w.]/.test(code.slice(i + 1, open))) break
    let depth = 0
    let j = open
    for (; j < code.length; j++) {
      if (code[j] === '(') depth++
      else if (code[j] === ')') { depth--; if (depth === 0) break }
    }
    if (j >= code.length) break
    out += code.slice(i, j + 1)
    i = j + 1
  }
  return out
}

/**
 * 末位排序键**已知唯一**的豁免清单（带理由，不是随手放行）。
 *
 * 启发式 `looksUnique` 只认 `xxxId` / `.id`，不知道哪些普通列带唯一索引。
 * 这里显式登记那些**查过 schema 确认有 UNIQUE 约束**的列。
 */
const UNIQUE_BY_INDEX: Array<[pattern: RegExp, why: string]> = [
  [/asc\(inventorySuppliers\.name\)$/,
    'db/schema/inventory.ts:345 `uniqueIndex(uq_inventory_suppliers_name).on(table.name)` '
    + '—— 全表唯一索引（非部分索引），ORDER BY name 本身即全序，不需要 tie-break'],
]

/** 切出「`.orderBy(` 且同一条链上有 `.offset(`」的调用点 */
function pagedOrderBys(code: string): Array<{ index: number; args: string }> {
  const out: Array<{ index: number; args: string }> = []
  for (const m of code.matchAll(/\.orderBy\s*\(/g)) {
    const at = m.index!
    const args = orderByArgs(code, at)
    if (args === null) continue
    // `.orderBy(<args>)` 的右括号位置 = at + '.orderBy('.length + args 原文长度…
    // 原文可能含换行，不能用归一后的 args 长度算，重新扫一遍拿准确 end。
    const open = code.indexOf('(', at)
    let depth = 0
    let end = open
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++
      else if (code[end] === ')') { depth--; if (depth === 0) break }
    }
    // 翻页的标志是 **offset**：只有 `.limit()` 是「取前 N 条」，不存在第二页，
    // 也就没有跨次执行的重复/漏行问题（那类确定性问题属 #251 那一族）。
    if (!/\.offset\s*\(/.test(chainTail(code, end + 1))) continue
    out.push({ index: at, args })
  }
  return out
}

describe('#282 · admin 分页查询的 orderBy 必须带唯一键 tie-break', () => {
  describe('第 1 层 · 通用规则（防将来新增的分页查询忘了加）', () => {
    it('每个带 .offset() 的 .orderBy() 末位参数都含唯一键', () => {
      const offenders: string[] = []
      let scanned = 0
      for (const root of ['actions', 'lib']) {
        for (const file of collectSources(join(SRC, root))) {
          const code = stripComments(readFileSync(file, 'utf8'), file)
          for (const { index, args } of pagedOrderBys(code)) {
            scanned++
            // 按顶层逗号切参数（`desc(a.b)` 内部没有逗号，但 `sql\`…\`` 可能有）
            let depth = 0
            let last = ''
            let cur = ''
            for (const ch of args) {
              if (ch === '(' || ch === '[') depth++
              else if (ch === ')' || ch === ']') depth--
              if (ch === ',' && depth === 0) { last = cur; cur = ''; continue }
              cur += ch
            }
            last = cur || last
            const exempt = UNIQUE_BY_INDEX.some(([re]) => re.test(last.trim()))
            if (!looksUnique(last) && !exempt) {
              const line = code.slice(0, index).split('\n').length
              offenders.push(`${relative(SRC, file)}:${line} · 末位「${last.trim()}」不像唯一键\n    orderBy(${args})`)
            }
          }
        }
      }
      expect(offenders, `缺 tie-break 的分页查询:\n${offenders.join('\n')}`).toEqual([])
      // 下界防「守护被掏空」：切片逻辑若改坏，一个都扫不到、offenders 恒空而断言恒绿
      expect(scanned).toBeGreaterThan(10)
    })
  })

  describe('第 2 层 · #282 修的 16 处逐条钉死（防被改回去）', () => {
    // 通用规则是启发式，已修的这几处要把**完整参数列表**钉住。
    const EXPECTED: Array<[file: string, args: string, why: string]> = [
      ['actions/appointments.ts', 'desc(appointments.appointmentTime), desc(appointments.appointmentId)',
        '整点预约大量并列'],
      ['actions/card-transactions.ts', 'desc(cardTransactions.createdAt), desc(cardTransactions.id)',
        '一次结算可写多笔'],
      ['actions/cards.ts', 'desc(saleOrders.paidAt), desc(saleItems.createdAt), desc(saleItems.saleItemId)',
        '⚠️ FROM 是 saleItems 不是 saleOrders，主键取 saleItemId'],
      ['actions/coupons.ts', 'asc(clientWechatUsers.name), asc(clientWechatUsers.userId)',
        '⚠️ 重名顾客即并列'],
      ['actions/customers.ts', 'asc(clientWechatUsers.name), asc(clientWechatUsers.userId)',
        '⚠️ 重名顾客即并列'],
      ['actions/legacy-orders.ts', 'desc(saleOrders.saleOrderDatetime), desc(saleOrders.saleOrderId)',
        'saleOrderDatetime 是业务日期，同日多单'],
      ['actions/logs.ts', 'desc(operationLogs.createdAt), desc(operationLogs.id)',
        '批量操作同秒写多行日志'],
      ['actions/merchants.ts', 'desc(lakalaMerchants.updatedAt), desc(lakalaMerchants.id)',
        '⚠️ JOIN 方向是反的（stores.lakalaMerchantId = lakalaMerchants.id，一商户多门店），'
        + '靠 .groupBy(lakalaMerchants.id) 折叠回一行/商户才不扇出 —— 去掉 groupBy 这条 tie-break 会连同失效'],
      ['actions/messages.ts', 'desc(messages.createdAt), desc(messages.id)',
        '群发消息同秒写入'],
      ['actions/messages.ts', 'asc(clientWechatUsers.name), asc(clientWechatUsers.userId)',
        '⚠️ 收件人选择器，重名即并列'],
      ['actions/orders.ts', 'desc(saleOrders.saleOrderDatetime), desc(saleOrders.saleOrderId)',
        '同日多单'],
      ['actions/pickup-records.ts', 'desc(pickupRecords.createdAt), desc(pickupRecords.id)',
        '一次提货写多行'],
      ['actions/points.ts', 'desc(pointTransactions.createdAt), desc(pointTransactions.id)',
        '⚠️ 一单多笔积分同事务写入，必然并列'],
      ['actions/services.ts', 'desc(serviceOrders.updatedAt), desc(serviceOrders.createdAt), desc(serviceOrders.serviceOrderId)',
        '同批更新的服务单 updatedAt 相同'],
      ['lib/inventory/engine.ts', 'asc(inventorySkus.productCode), asc(inventorySkus.skuId)',
        'productCode 可重复（不同市场同码）'],
      ['lib/inventory/engine.ts',
        'asc(inventoryLocations.locationType), asc(inventoryLocations.name), asc(inventoryStockLots.skuName), asc(inventoryStockLots.batchNo), asc(inventoryStockLots.id)',
        '同库位同 SKU 同批次可以有多个 lot 行'],
    ]

    it.each(EXPECTED)('%s 的「%s」在位', (file, args) => {
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'), file)
      const all = pagedOrderBys(code).map((x) => x.args)
      expect(all, `${file} 的分页 orderBy 实际有:\n${all.join('\n')}`).toContain(args)
    })

    it('已确认安全的那些不许被「统一风格」删掉', () => {
      // issue #282 的「已确认安全」清单 —— 本来就有 tie-break，列此防重构抹平。
      const SAFE: Array<[string, RegExp]> = [
        ['actions/employees.ts', /asc\(staffWechatUsers\.employeeId\)/],
        ['actions/allocations.ts', /desc\(saleOrderPayments\.id\)/],
        ['lib/inventory/engine.ts', /desc\(inventoryDocs\.docDate\), desc\(inventoryDocs\.createdAt\), desc\(inventoryDocs\.id\)/],
      ]
      for (const [file, re] of SAFE) {
        const code = stripComments(readFileSync(join(SRC, file), 'utf8'), file).replace(/\s+/g, ' ')
        expect(re.test(code), `${file} 丢了本来就有的 tie-break: ${re}`).toBe(true)
      }
    })
  })

  describe('解析工具自身（这两个错了，上面两层都失真）', () => {
    it.each([
      ['嵌套括号不切错', '.orderBy(desc(a.b), asc(c.d))', 'desc(a.b), asc(c.d)'],
      ['跨行归一空白', '.orderBy(\n  desc(a.b),\n  asc(c.id),\n)', 'desc(a.b), asc(c.id),'],
      ['单参数', '.orderBy(asc(t.id))', 'asc(t.id)'],
    ])('orderByArgs: %s', (_l, code, expected) => {
      expect(orderByArgs(code, 0)).toBe(expected)
    })

    it.each([
      ['desc(t.id)', true], ['asc(clientWechatUsers.userId)', true],
      ['desc(saleItems.saleItemId)', true], ['asc(inventoryStockLots.id)', true],
      ['desc(t.createdAt)', false], ['asc(u.name)', false],
      ['desc(saleOrders.paidAt)', false],
    ])('looksUnique(%s) = %s', (arg, expected) => {
      expect(looksUnique(arg)).toBe(expected)
    })

    it('只认带 .offset() 的分页链，不误伤「取前 N 条」', () => {
      const paged = '.orderBy(desc(t.createdAt))\n  .limit(20)\n  .offset(40)'
      const topN = '.orderBy(desc(t.createdAt))\n  .limit(1)'
      expect(pagedOrderBys(paged)).toHaveLength(1)
      expect(pagedOrderBys(topN)).toHaveLength(0)
    })

    it('剥注释：注释里的假 orderBy 不算数', () => {
      const code = stripComments(
        'const x = 1 // .orderBy(desc(t.createdAt)).limit(1).offset(2)\n',
        'a.ts',
      )
      expect(pagedOrderBys(code)).toHaveLength(0)
    })
  })
})
