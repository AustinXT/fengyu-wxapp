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
 * 2. **清单钉死**：#282 修的 18 处逐条断言。防已修的被改回去。
 *
 * ⚠️ 数字变过两次，别照 issue 正文的「16 处」：
 *   - `engine.ts` 的 `productCode` 撤销（它有全表唯一索引，补 tie-break 是冗余）→ −1
 *   - 评审发现 3 处**内存分页**同样受影响（coupons / products / mall 页 force-dynamic，
 *     翻页走 router.replace **重新执行查询**，不是「单次全量切片」）→ +3
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
  [/asc\(inventorySkus\.productCode\)$/,
    'db/schema/inventory.ts:108 `uniqueIndex(uq_inventory_skus_product_code)` + notNull，'
    + '迁移 0007_moaning_salo.sql:498 无 WHERE 条件 —— 全表唯一，本身即全序。'
    + '#282 初版给它补过 skuId，评审指出冗余后撤掉：补了不但多余，还会让这条'
    + '**唯一有精确匹配索引**的查询从 Index Scan 退化成 Index Scan + Incremental Sort'],
]

/**
 * 找包含 `pos` 的**最内层** VariableDeclaration 的变量名（deferred 写法靠它关联）。
 */
function enclosingVarName(sf: ts.SourceFile, pos: number): string | null {
  let name: string | null = null
  const visit = (node: ts.Node) => {
    if (node.getStart(sf) > pos || pos >= node.getEnd()) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) name = node.name.text
    node.forEachChild(visit)
  }
  visit(sf)
  return name
}

/** 找包含 `pos` 的**最内层**函数体范围（限定 deferred 关联的搜索窗口） */
function enclosingFunctionRange(sf: ts.SourceFile, pos: number): [number, number] {
  let range: [number, number] = [0, sf.getEnd()]
  const visit = (node: ts.Node) => {
    if (node.getStart(sf) > pos || pos >= node.getEnd()) return
    if (
      ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
    ) {
      range = [node.getStart(sf), node.getEnd()]
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return range
}

/**
 * 切出所有**分页**的 `.orderBy(` 调用点。
 *
 * ⚠️ 判据有两条，缺一不可（第一版只有第 1 条，对本仓 **42% 的分页查询失明**）：
 *
 *   1. **同链**：`.orderBy(...).limit(...).offset(...)` —— 直连写法
 *   2. **deferred**：`const query = db…orderBy(...)` 之后
 *      `await query.limit(n).offset(m)` —— 这是本仓**导出/可选分页**的主流写法，
 *      33 处 `.offset(` 里有 14 处是它。只认第 1 条时这 14 处完全隐形：
 *      删掉它们的 tie-break，76 条用例全绿。
 *
 * deferred 关联用 **AST 取变量名 + 限定在最内层函数体内**搜索，
 * 不能用「往后取 N 个字符」当窗口 —— 第一版取 1200 字符，`logs.ts` 里一个
 * **不分页**的 `.orderBy()` 因此扫到了下一个函数的 `.offset(`，误判成分页查询。
 */
function pagedOrderBys(code: string, fileName = 'x.ts'): Array<{ index: number; args: string }> {
  const out: Array<{ index: number; args: string }> = []
  const sf = ts.createSourceFile(
    fileName, code, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  for (const m of code.matchAll(/\.orderBy\s*\(/g)) {
    const at = m.index!
    const args = orderByArgs(code, at)
    // ⚠️ 解析不出参数时**不能 continue**（那是 fail-open，整条查询被静默丢弃）——
    // 推进 offenders 让人来看一眼，与云函数侧 `clause === null` 的 fail-closed 姿态对齐。
    if (args === null) { out.push({ index: at, args: '<解析失败>' }); continue }

    const open = code.indexOf('(', at)
    let depth = 0
    let end = open
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++
      else if (code[end] === ')') { depth--; if (depth === 0) break }
    }

    // 判据 1：同链
    if (/\.offset\s*\(/.test(chainTail(code, end + 1))) { out.push({ index: at, args }); continue }

    // 判据 2：deferred —— 同函数体内，该变量（或它的别名）被 `.offset(` 调用
    const varName = enclosingVarName(sf, at)
    if (varName) {
      const [fnStart, fnEnd] = enclosingFunctionRange(sf, at)
      const body = code.slice(fnStart, fnEnd)
      // 跟踪一层别名：`const q = …orderBy(…); const p = q.limit(10); p.offset(20)`
      // 不跟的话这种写法会静默漏掉（评审反例）。一层足够覆盖本仓写法，
      // 再深就该考虑换 AST 数据流分析了 —— 那超出字面量守护的定位。
      const names = new Set([varName])
      for (let round = 0; round < 3; round++) {
        for (const m2 of body.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?([\w$]+)\s*\./g)) {
          if (names.has(m2[2])) names.add(m2[1])
        }
      }
      const hit = [...names].some((n) => new RegExp(
        String.raw`\b${n}\s*(?:\.\s*\w+\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*)*\.\s*offset\s*\(`,
      ).test(body))
      if (hit) { out.push({ index: at, args }); continue }
    }
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
          for (const { index, args } of pagedOrderBys(code, file)) {
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
      // 下界防「守护被掏空」：切片逻辑若改坏，一个都扫不到、offenders 恒空而断言恒绿。
      //
      // ⚠️ 这个数字要与 **`src/` 下 `.offset(` 的实际总数**对齐（当前 33，
      // `grep -rn "\.offset(" src --include="*.ts" | grep -v "\.test\." | wc -l`）。
      // 初版判据只认同链写法，只扫到 19 —— 14 处 deferred 写法
      // （`const query = …orderBy(…)` + `await query.limit().offset()`，本仓导出的主流写法）
      // 完全隐形，删掉它们的 tie-break 全套用例照样绿。补上 deferred 关联后才是 100%。
      const totalOffsetCalls = 33
      expect(scanned, '扫到的分页查询数与 src 里 .offset( 的总数不符 —— 判据可能又漏了某种写法')
        .toBe(totalOffsetCalls)
    })
  })

  describe('第 2 层 · #282 修的 18 处逐条钉死（防被改回去）', () => {
    // 通用规则是启发式，已修的这几处要把**完整参数列表**钉住。
    const EXPECTED: Array<[file: string, args: string, why: string]> = [
      ['actions/appointments.ts', 'desc(appointments.appointmentTime), desc(appointments.appointmentId)',
        '整点预约大量并列'],
      ['actions/card-transactions.ts', 'desc(cardTransactions.createdAt), desc(cardTransactions.id)',
        '一次结算可写多笔'],
      ['actions/cards.ts', 'desc(saleOrders.paidAt), desc(saleItems.createdAt), asc(saleItems.saleItemId)',
        '⚠️ FROM 是 saleItems 不是 saleOrders，主键取 saleItemId；'
        + '末位用 **asc** 是为了与同文件导出侧 `exportCards` 同向 —— 否则并列组在页面与 CSV 里顺序相反，对账会逐行错位'],
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
      // ⓘ `lib/inventory/engine.ts` 的 SKU 列表**刻意不在这张清单里**：
      //    它的 `asc(inventorySkus.productCode)` 有全表唯一索引兜底，走 UNIQUE_BY_INDEX 豁免。
      //    初版误判成「productCode 可重复（不同市场同码）」给它补了 skuId，与 schema 直接矛盾，
      //    评审指出后已撤销 —— 这条注释留着，免得下次又被"补全"。
      ['lib/inventory/engine.ts',
        'asc(inventoryLocations.locationType), asc(inventoryLocations.name), asc(inventoryStockLots.skuName), asc(inventoryStockLots.batchNo), asc(inventoryStockLots.id)',
        '同库位同 SKU 同批次可以有多个 lot 行'],
      // —— 以下 3 处是**内存分页**（取回后在组件里 slice），评审发现同样受影响：
      //    这三个页面都是 force-dynamic，翻页走 useUrlFilters 的 router.replace
      //    → Server Component **重新执行查询** → 两次翻页是两次独立执行，
      //    不是「对单次全量结果切片」。第一轮把它们当豁免是错的。
      ['actions/coupons.ts',
        'desc(couponTemplates.updatedAt), desc(couponTemplates.createdAt), asc(couponTemplates.templateId)',
        '优惠券模板列表：同批创建的模板 updatedAt/createdAt 都并列'],
      ['actions/products.ts',
        'asc(productSkus.sortOrder), asc(productSkus.skuId)',
        '⚠️ `sort_order` 默认 0 —— **未手工排序的 SKU 全部并列**，本次并列面最大的一处'],
      ['actions/products.ts',
        'asc(products.sortOrder), asc(products.productId)',
        '⚠️ 同上（mall 页）；同文件 getProductsByKind 的同款 orderBy 刻意不改 —— 那是开单 picker 一次性全量加载，不翻页'],
    ]

    it.each(EXPECTED)('%s 的「%s」在位', (file, args) => {
      const code = stripComments(readFileSync(join(SRC, file), 'utf8'), file)
      const all = pagedOrderBys(code, file).map((x) => x.args)
      expect(all, `${file} 的分页 orderBy 实际有:\n${all.join('\n')}`).toContain(args)
    })

    it('已确认安全的那些不许被「统一风格」删掉', () => {
      // issue #282 的「已确认安全」清单 —— 本来就有 tie-break，列此防重构抹平。
      //
      // ⚠️ 断言对象必须是 **`pagedOrderBys` 提取出的分页参数列表**，
      // 不能是 `re.test(整份源码)` —— 后者在同一子句**重复出现**时对目标位置失效：
      // `asc(staffWechatUsers.employeeId)` 在 `employees.ts` 出现两次
      // （`:402` 分页 / `:484` keyset 导出），把 :402 改成外键 `asc(storeId)` 之后，
      // 第 1 层因 `storeId` 长得像唯一键而放行、SAFE 又被 :484 满足 → 两层皆绿（评审实测）。
      const SAFE: Array<[file: string, args: string, why: string]> = [
        // ⚠️ 写**完整参数列表**而不是子串 —— 改成 toContain 之后，
        // 子串（如单写 `asc(staffWechatUsers.employeeId)`）不会匹配到任何一条。
        ['actions/employees.ts',
          'desc(staffWechatUsers.updatedAt), desc(staffWechatUsers.createdAt), asc(staffWechatUsers.employeeId)',
          '员工列表分页（:402；同文件 :484 的 keyset 导出也有 employeeId，正是它让旧的 re.test 失效）'],
        ['actions/allocations.ts',
          'desc(saleOrderPayments.paidAt), desc(saleOrderPayments.id)',
          '营业额分配待办列表'],
        ['lib/inventory/engine.ts',
          'desc(inventoryDocs.docDate), desc(inventoryDocs.createdAt), desc(inventoryDocs.id)',
          '库存单据列表'],
      ]
      for (const [file, args, why] of SAFE) {
        const code = stripComments(readFileSync(join(SRC, file), 'utf8'), file)
        const all = pagedOrderBys(code, file).map((x) => x.args)
        expect(all, `${file} 丢了本来就有的 tie-break（${why}）`).toContain(args)
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
