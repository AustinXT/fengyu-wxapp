/**
 * #282 · 分页查询的 ORDER BY 必须带唯一键 tie-break
 *
 * ## 这条守护为什么是**源码字面量扫描**而不是造数据翻页
 *
 * 「造数据翻两页、断言无重复」这类用例对 tie-break **零保护**：单测里的 pg 是 mock、
 * 不执行 SQL，返回顺序完全由 mock 数组决定 —— 把 `ORDER BY` 整条删掉照样绿。
 * #181 / #239 都踩过这个。真正的护栏只能是 SQL 字面量断言。
 *
 * ## 缺陷是什么
 *
 * `LIMIT`/`OFFSET` 分页**每翻一页都是一次独立执行**。PG 对**非唯一**排序键不保证
 * 跨次返回同序（并发写、autovacuum、plan 变化都会改物理扫描顺序）→ 两次翻页切出的页
 * 可能重复或漏掉某条记录。
 *
 * 两种最骗人的情形：
 *   - `created_at DESC` —— 看着够细，但同事务写入的多行 `NOW()` 逐微秒相同，必然并列
 *   - `ORDER BY name`   —— 重名即并列
 *
 * ## 两层守护
 *
 * 1. **通用规则**：凡是 `ORDER BY … LIMIT/OFFSET` 的语句，最外层 ORDER BY 的**末位键**
 *    必须长得像唯一键（`id` / `*_id`）。这一层防的是**将来新增**的分页查询忘了加。
 * 2. **清单钉死**：#282 修的 6 处逐条断言完整子句。这一层防的是**已修的被改回去**。
 *
 * 不在守护范围（issue 已声明）：翻页期间行集本身增删导致的跨调用快照不一致 ——
 * 那是 OFFSET 分页的固有属性，任何 tie-break 都救不了，根治要上 keyset/游标分页。
 */

const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, resolve, relative } = require('node:path')

const ROUTES_DIR = resolve(__dirname, '../../routes')
const ROOT = resolve(__dirname, '../..')

/**
 * 取**最外层**（括号深度 0）的 ORDER BY 子句，返回归一化后的文本；没有则 null。
 *
 * 实现抄自 `staff.test.js` 的 `orderByClause`（#239 在双谱系评审下逐个被攻破后加固的），
 * 抗以下四种削弱：
 *   ① 直接删末位键 —— 取整条子句比对，不是子串存在性
 *   ② 内层 CTE 的**注释**里写着期望文本、外层没有 → 先剥 SQL 注释
 *   ③ 把带 tie-break 的 ORDER BY **下沉进子查询**，外层弱排序
 *      （PG 会忽略子查询内排序，缺陷复活）→ 按括号深度只认最外层
 *   ④ `WHERE x <> ')'` 让括号深度提前归零 → 扫描时识别单引号字符串
 *
 * 边界（刻意 fail-closed —— 下列情形返回 null 或不等值而**变红**，绝不放行）：
 * 不支持 dollar-quote（`$$…$$`）、转义串（`E'\''`）、字符串内的 `--`、
 * 双引号标识符、小写 `order by`。本仓 SQL 都是手写模板且格式统一，
 * 误报红时人工确认一眼即可；反过来放行才是真风险。
 */
function orderByClause(sql) {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
  let depth = 0
  let inStr = false
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]
    if (ch === "'") { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && stripped.startsWith('ORDER BY', i)) {
      const rest = stripped.slice(i + 'ORDER BY'.length)
      const end = rest.search(/\n\s*(?:LIMIT|OFFSET)\b|\)|$/)
      return rest.slice(0, end).replace(/\s+/g, ' ').trim()
    }
  }
  return null
}

/**
 * 末位排序键是否长得像唯一键。
 *
 * ⚠️ 这是**启发式**，不是「真的查了 schema」：它认 `id` / `x.id` / `x.foo_id`。
 * 代价是 `ORDER BY o.store_id`（外键，对本表不唯一）也会被放行 ——
 * 所以第 2 层的清单钉死不能省，两层各管一段。
 */
function looksUnique(key) {
  const col = key.trim().replace(/\s+(ASC|DESC)$/i, '').replace(/\s+NULLS\s+(FIRST|LAST)$/i, '')
  return /(^|\.)(id|[a-z0-9_]+_id)$/i.test(col)
}

/** 递归收集 routes 下的 .js */
function collectRoutes(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectRoutes(full, acc)
    else if (entry.endsWith('.js')) acc.push(full)
  }
  return acc
}

/**
 * 提取源文件里所有模板串的内容（**正确处理嵌套模板**）。
 *
 * ⚠️ 不能用 `/`([^`]*)`/g` 按文档顺序配对反引号 —— 评审实测两种漏扫：
 *   ① 嵌套模板 `` `… ${cond ? `A` : `B`} …` `` 会把一条 SQL 切成两段，
 *      含 ORDER BY 的那段没有 OFFSET → **静默跳过**（fail-open，不变红）
 *   ② 转义反引号会让其后所有模板配对错位
 * 本仓 staffApi `routes/order.js` 就有两处嵌套模板（5821 / 6872 的文案拼接），
 * 位置在该文件的分页 SQL **之前** —— 正则版会让 order.js 的两条分页 SQL 整个漏扫。
 *
 * 这里跟踪 `${}` 深度逐字符扫，嵌套模板整段并入外层 body（对"找含 OFFSET 的 SQL"
 * 这个目的足够），转义序列原样跳过。
 */
function extractTemplates(source) {
  const out = []
  let i = 0
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue }
    if (source[i] !== '`') { i++; continue }
    let j = i + 1
    let braceDepth = 0
    let body = ''
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') { body += source.slice(j, j + 2); j += 2; continue }
      if (braceDepth === 0 && c === '`') break
      if (c === '$' && source[j + 1] === '{') { braceDepth++; body += '${'; j += 2; continue }
      if (braceDepth > 0 && c === '}') { braceDepth--; body += '}'; j++; continue }
      if (braceDepth > 0 && c === '`') {
        // 插值里的嵌套模板：整段吞掉，别让它的反引号闭合外层
        let k = j + 1
        let d2 = 0
        while (k < source.length) {
          if (source[k] === '\\') { k += 2; continue }
          if (d2 === 0 && source[k] === '`') break
          if (source[k] === '$' && source[k + 1] === '{') { d2++; k += 2; continue }
          if (d2 > 0 && source[k] === '}') { d2--; k++; continue }
          k++
        }
        body += source.slice(j, k + 1)
        j = k + 1
        continue
      }
      body += c
      j++
    }
    out.push(body)
    i = j + 1
  }
  return out
}

/**
 * 从源文件里切出所有「带 LIMIT/OFFSET 的 SQL 模板」。
 *
 * 按反引号模板串切：本仓云函数的 SQL 一律写在 `pg.query(\`…\`)` 的模板串里。
 * 只保留同时含 ORDER BY 与 LIMIT/OFFSET 的那些 —— 不分页的查询不在本 issue 范围
 * （顺序不稳定不会造成翻页重复/漏行）。
 */
function pagedSqlTemplates(source) {
  const out = []
  for (const body of extractTemplates(source)) {
    // ⚠️ **不能**先过滤掉「没有 ORDER BY 的模板」—— 那正好放过最坏的情形：
    // 有人把整条 ORDER BY 删了，查询从「排序键非唯一」变成「完全无序」，
    // 而守护因为扫不到 ORDER BY 就不纳入统计、offenders 恒空（评审实测：
    // 删掉 `allocation.js:269` 整条 ORDER BY，scanned 17→16，`16 > 10` 仍绿）。
    // 改成只按 OFFSET 筛，无 ORDER BY 的交给下游 `clause === null` 分支报出来。
    //
    // 翻页的标志是 **OFFSET**，不是 LIMIT。
    // `LIMIT N` 无 OFFSET 是「取前 N 条」（如 `LIMIT 1` 取最新一条、员工搜索 `LIMIT 20`），
    // 不存在「第二页」，也就没有跨次执行的重复/漏行问题。
    // 那类查询的结果确定性问题属 **#251** 那一族（`LIMIT 1` 缺确定性 ORDER BY），
    // 与本 issue 的翻页 tie-break 是两回事，不在这里管。
    if (!/\bOFFSET\b/i.test(body)) continue
    out.push(body)
  }
  return out
}

describe('#282 · clientApi 分页 SQL 的 ORDER BY 必须带唯一键 tie-break', () => {
  describe('第 1 层 · 通用规则（防将来新增的分页查询忘了加）', () => {
    test('routes 下每条带 LIMIT/OFFSET 的 SQL，最外层 ORDER BY 末位键都像唯一键', () => {
      const offenders = []
      let scanned = 0
      for (const file of collectRoutes(ROUTES_DIR)) {
        const source = readFileSync(file, 'utf8')
        for (const sql of pagedSqlTemplates(source)) {
          scanned++
          const clause = orderByClause(sql)
          if (clause === null) {
            offenders.push(`${relative(ROOT, file)} · 取不到最外层 ORDER BY（可能被下沉进子查询）\n    ${sql.replace(/\s+/g, ' ').slice(0, 120)}`)
            continue
          }
          // ⚠️ 按裸逗号切末位键**对含逗号的括号表达式是 fail-open**（评审反例）：
          // `ORDER BY COALESCE(t.amount, t.id) DESC, t.created_at DESC` 会先在第一个 `)`
          // 处被 orderByClause 截断成 `COALESCE(t.amount, t.id`，再按逗号切出末位 ` t.id`
          // → `looksUnique` 为真 → 放行，而真实末位是非唯一的 `t.created_at`。
          // 所以**只要子句里有不配对的括号就直接报**，不再猜末位键。
          const balanced = (clause.match(/\(/g) || []).length === (clause.match(/\)/g) || []).length
          if (!balanced) {
            offenders.push(`${relative(ROOT, file)} · ORDER BY 含括号表达式，解析不可靠（刻意 fail-closed）\n    ORDER BY ${clause}`)
            continue
          }
          const last = clause.split(',').pop()
          if (!looksUnique(last)) {
            offenders.push(`${relative(ROOT, file)} · 末位键「${last.trim()}」不像唯一键\n    ORDER BY ${clause}`)
          }
        }
      }
      expect(offenders, `缺 tie-break 的分页 SQL:\n${offenders.join('\n')}`).toEqual([])
      // 下界防「守护被掏空」：模板提取若手误失效，一条都扫不到、offenders 恒空而断言恒绿。
      //
      // ⚠️ 不要写死 `> 5`（初版如此，而实测恰为 6，余量仅 1）——
      // 本文件自己写着「根治要上 keyset/游标分页」，**只要有人把任意一条列表改成游标分页**
      // （去掉 OFFSET），scanned 掉到 5 就会以「守护被掏空」的名义变红，
      // 等于为做对的事惩罚。改成与第 2 层 EXPECTED 清单联动：
      // 清单里每条都必须能被扫到，删接口时两处一起改，语义自洽。
      // ⚠️ 用**精确值**而不是「≥ EXPECTED 条数」的联动下界 —— 后者是**弱断言**：
      // 提取器只要还能扫到 EXPECTED+SAFE 那几条就绿，漏掉其余几条完全不可见
      // （评审实测）。精确值的代价是「合法改成 keyset 分页时要同步改这个数」，
      // 但那本来就该是一次有意识的改动（改的人正好该看一眼守护还覆不覆盖）。
      // admin 侧同姿态（`toBe(33)`）。
      //
      // routes 下共 6 条带 OFFSET 的分页 SQL
      expect(scanned, '扫到的分页 SQL 数与 routes 下 OFFSET 的实际条数不符 —— 提取器可能漏了某种写法')
        .toBe(6)
    })
  })

  describe('第 2 层 · #282 修的 6 处逐条钉死（防被改回去）', () => {
    // 通用规则是启发式（`ORDER BY o.store_id` 这种外键也会放行），
    // 所以已修的这几处要把**完整子句**钉住。
    const EXPECTED = [
      ['appointment.js', 'a.appointment_time DESC, a.appointment_id DESC',
        '⚠️ 碰撞率最高：整点预约大量并列（9:00 那一批 appointment_time 完全相同）'],
      ['card.js', 'ct.created_at DESC, ct.id DESC',
        '储值卡流水：一次结算可写多笔'],
      ['message.js', 'created_at DESC, id DESC',
        '⚠️ 群发消息同秒写入，整批 created_at 逐微秒相同'],
      ['order.js', 'o.created_at DESC, o.sale_order_id DESC',
        '订单列表：同事务多单'],
      ['points.js', 'pt.created_at DESC, pt.id DESC',
        '⚠️ 一单多笔积分同事务写入，必然并列'],
      ['service.js', 'so.created_at DESC, so.service_order_id DESC',
        '服务单列表：同上'],
    ]

    test.each(EXPECTED)('%s 的「%s」在位', (fileName, expectedClause, _why) => {
      const source = readFileSync(join(ROUTES_DIR, fileName), 'utf8')
      const clauses = pagedSqlTemplates(source).map(orderByClause)
      expect(clauses).toContain(expectedClause)
    })

    test('本来就正确的 ORDER BY 不许被「统一风格」改坏', () => {
      // ⚠️ 初版这里钉的是 `order.js:400/:412` 的
      // `o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC` ——
      // 那是 `UPDATE … SET … = (SELECT … LIMIT 1)` 的**子查询，不翻页**，
      // 属 #251 那一族，放在「#282 分页 tie-break 守护」的 SAFE 清单里会误导后人
      // （评审实测指出）。clientApi 侧本来就没有「已有 tie-break 的分页查询」，
      // 6 处全是本 PR 新补的 —— 那 6 条已由上面的 EXPECTED 清单钉死。
      //
      // 这条改为守 `o.paid_at ASC NULLS LAST` 这个 **NULLS 姿态**：
      // 它是本仓对 paid_at 少见的显式 NULLS LAST 写法，改成默认（DESC→NULLS FIRST）
      // 会让未支付单跳到结果顶部，静默改变业务语义。
      // ⚠️ 断言**出现次数**而不是 `re.test(整份源码)`：这个子句在 `order.js` 的
      // 两个 UPDATE 子查询里重复出现，改坏一处、另一处保留则 `re.test` 仍为 true。
      const source = readFileSync(join(ROUTES_DIR, 'order.js'), 'utf8')
      const hits = (source.match(
        /o\.paid_at ASC NULLS LAST, o\.created_at ASC, o\.sale_order_id ASC/g,
      ) || []).length
      expect(hits, 'order.js 的 paid_at NULLS LAST 姿态被改了（非分页查询，但会改变业务语义）')
        .toBe(2)
    })
  })

  describe('orderByClause 自身（这个函数错了，上面两层都失真）', () => {
    test.each([
      ['最外层直取',
        'SELECT 1 FROM t\n ORDER BY a, t.id\n LIMIT 10 OFFSET 20', 'a, t.id'],
      // ② 内层注释里写着期望文本，真正的外层没有 tie-break
      ['剥掉注释里的伪 ORDER BY',
        'SELECT 1 FROM (SELECT 2 /* ORDER BY x, y.id */) s\n ORDER BY a\n LIMIT 10 OFFSET 0', 'a'],
      ['剥掉行注释',
        'SELECT 1 FROM t -- ORDER BY fake.id\n ORDER BY a\n LIMIT 1 OFFSET 0', 'a'],
      // ③ tie-break 被下沉进子查询，外层弱排序（PG 会忽略子查询内排序）
      ['只认最外层，不认子查询内的',
        'SELECT 1 FROM (SELECT 2 FROM t ORDER BY t.id) s\n ORDER BY a\n LIMIT 10 OFFSET 0', 'a'],
      // ④ 字符串里的右括号让深度提前归零
      ['字符串里的括号不算结构括号',
        "SELECT 1 FROM (SELECT 2 FROM t WHERE x <> ')' ORDER BY t.id) s\n ORDER BY a\n LIMIT 5 OFFSET 0", 'a'],
      ['无 ORDER BY 返回 null', 'SELECT 1 FROM t\n LIMIT 10 OFFSET 0', null],
    ])('%s', (_label, sql, expected) => {
      expect(orderByClause(sql)).toBe(expected)
    })

    test.each([
      // 评审实测的漏扫形状：嵌套模板把 SQL 切成两段，含 ORDER BY 的那段没有 OFFSET
      ['嵌套模板不再把 SQL 切碎',
        'pg.query(`SELECT 1 FROM t ${w} ORDER BY t.created_at DESC ${d ? `A` : `B`} LIMIT $1 OFFSET $2`, p)', 1],
      // 本仓 staffApi routes/order.js 的真实形状：文案拼接用了嵌套模板，
      // 位置在该文件的分页 SQL **之前** —— 正则版会让后面所有 SQL 配对错位
      ['嵌套模板在前、分页 SQL 在后，后者仍能被扫到',
        'const msg = `a${x ? `b` : `c`}d`\npg.query(`SELECT 1 FROM t\n ORDER BY t.created_at DESC, t.id DESC\n LIMIT $1 OFFSET $2`, p)', 1],
      ['无 OFFSET 的模板不算分页', 'pg.query(`SELECT 1 FROM t ORDER BY a LIMIT 1`, p)', 0],
    ])('extractTemplates/pagedSqlTemplates: %s', (_label, source, expected) => {
      expect(pagedSqlTemplates(source)).toHaveLength(expected)
    })

    test('已知局限：ORDER BY 里含括号表达式会被截断（刻意 fail-closed）', () => {
      // `ORDER BY (u.store_id = $1) DESC, u.name` 这种写法会在第一个 `)` 处截断，
      // 拿到的是 `(u.store_id = $1` —— 末位键判定必然失败 → 变红。
      // 这是**刻意的**：与其猜一个可能放行错误的解析，不如让人来看一眼。
      // 本仓唯一这么写的是 staffApi `customer.js` 的员工搜索，它 `LIMIT 20` 无 OFFSET、
      // 不翻页，已被 pagedSqlTemplates 的 OFFSET 过滤排除在外。
      expect(orderByClause('SELECT 1 FROM t\n ORDER BY (a = $1) DESC, b.id\n LIMIT 5 OFFSET 0'))
        .toBe('(a = $1')
    })

    test.each([
      ['t.id', true], ['id', true], ['sop.id DESC', true], ['a.appointment_id DESC', true],
      ['st.batch_no', false], ['created_at DESC', false], ['u.name', false],
      ['cnt DESC', false],
    ])('looksUnique(%s) = %s', (key, expected) => {
      expect(looksUnique(key)).toBe(expected)
    })
  })
})
