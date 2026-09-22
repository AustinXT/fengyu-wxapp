import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  normalizePage,
  resolvePaging,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MAX_PAGE_SIZE_CEILING,
} from './paging'

/**
 * URL query 可直接构造的恶意/边界页码入参。
 * 每个都对应一个真实可打的 URL（`?page=<raw>`），不是假想值。
 */
const HOSTILE_PAGES: Array<[label: string, raw: unknown]> = [
  ['小数 2.5（两个夹子双双失效的区间）', 2.5],
  ['小数 1.3（offset 会带浮点尾巴 3.0000000000000004）', 1.3],
  ['0.5（恰好被 Math.max(1,…) 兜住，容易误以为安全）', 0.5],
  ['1e21（有限但超安全整数，String() 输出指数记法）', 1e21],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['NaN', NaN],
  ['0', 0],
  ['负数', -5],
  ['Number.MAX_SAFE_INTEGER（安全整数但乘法会溢出）', Number.MAX_SAFE_INTEGER],
  ['Number.MAX_VALUE', Number.MAX_VALUE],
  ['undefined', undefined],
  ['null', null],
  ['空串', ''],
  ['非数字串', 'abc'],
  ['数字串 "3"（URL 来的都是串）', '3'],
  ['数组', [1, 2]],
  ['对象', {}],
]

describe('normalizePage', () => {
  it('取整而不是原样放行小数', () => {
    // 这是与 `Math.max(1, page || 1)` 的核心差异：后者让 2.5 原样进 offset 计算。
    expect(normalizePage(2.5)).toBe(2)
    expect(normalizePage(1.3)).toBe(1)
    expect(normalizePage(99.999)).toBe(99)
  })

  it('非安全整数一律回落 1（Number.isFinite 不够，1e21 会漏过去）', () => {
    // `Number.isFinite(1e21)` 为 true —— 用它当判据时 1e21 会进 offset，
    // `String(1e21 * 20)` 得 "2e+22"，PG int8in 直接报错。
    expect(normalizePage(1e21)).toBe(1)
    expect(normalizePage(Infinity)).toBe(1)
    expect(normalizePage(-Infinity)).toBe(1)
    expect(normalizePage(NaN)).toBe(1)
    expect(normalizePage(Number.MAX_VALUE)).toBe(1)
  })

  it('0 / 负数 / 非数字回落 1', () => {
    expect(normalizePage(0)).toBe(1)
    expect(normalizePage(-5)).toBe(1)
    expect(normalizePage(undefined)).toBe(1)
    expect(normalizePage(null)).toBe(1)
    expect(normalizePage('abc')).toBe(1)
    expect(normalizePage({})).toBe(1)
  })

  it('数字串按数字解（URL query 过来的都是串）', () => {
    expect(normalizePage('3')).toBe(3)
    expect(normalizePage('2.5')).toBe(2)
  })

  it('超 MAX_PAGE 夹到 MAX_PAGE —— 安全整数对乘法不封闭，靠这道夹子压住 offset', () => {
    expect(normalizePage(MAX_PAGE + 1)).toBe(MAX_PAGE)
    // MAX_SAFE_INTEGER 自己是安全整数，但 × pageSize 之后就不是了
    expect(normalizePage(Number.MAX_SAFE_INTEGER)).toBe(MAX_PAGE)
  })

  it('出口恒为 [1, MAX_PAGE] 区间内的安全整数', () => {
    for (const [label, raw] of HOSTILE_PAGES) {
      const page = normalizePage(raw)
      expect(Number.isSafeInteger(page), label).toBe(true)
      expect(page >= 1 && page <= MAX_PAGE, label).toBe(true)
    }
  })

  it('兜住 Number(raw) 抛 TypeError 的入参', () => {
    // `JSON.parse('{"toString": null}')` 是**普通 JSON 对象**，不需要用户代码：
    // ToPrimitive 先试 valueOf（返回对象本身，非原始值）再试 toString（被遮蔽成 null，
    // 不可调用）→ TypeError。URL 路径不可达（query 都是串），但 **Server Action
    // 直调路径可达**：action 可被客户端任意构造调用，这个形状能过 RSC 序列化边界。
    const hostile = JSON.parse('{"toString": null}')
    // ⓘ 下面这行断的是 V8 的 ToPrimitive 语义、与 paging.ts 实现无关，**不是守护**，
    //    只是把「这个入参确实会抛」这个前提钉在测试里，免得日后有人以为用例在测假想场景。
    expect(() => Number(hostile)).toThrow(TypeError)
    // 这行才是守护
    expect(normalizePage(hostile)).toBe(1)
    expect(normalizePage(Symbol('x'))).toBe(1)
  })
})

describe('resolvePaging · 白名单模式（16 处列表 action 用的口径）', () => {
  const base = { defaultPageSize: 20, allowedPageSizes: [10, 20, 50] as const }

  it('白名单内原样放行', () => {
    expect(resolvePaging({ ...base, page: 2, pageSize: 50 }))
      .toEqual({ page: 2, pageSize: 50, offset: 50 })
  })

  it('白名单外一律回落 defaultPageSize（?size=2.5 / 7 / 1e21 都进不来）', () => {
    for (const bad of [2.5, 7, 1e21, Infinity, NaN, 0, -10, '20', null, undefined]) {
      expect(resolvePaging({ ...base, page: 1, pageSize: bad }).pageSize, String(bad)).toBe(20)
    }
  })

  it('page 侧非法值不影响 pageSize，反之亦然', () => {
    expect(resolvePaging({ ...base, page: 'abc', pageSize: 50 }))
      .toEqual({ page: 1, pageSize: 50, offset: 0 })
    expect(resolvePaging({ ...base, page: 3, pageSize: 999 }))
      .toEqual({ page: 3, pageSize: 20, offset: 40 })
  })

  it('logs 的 [20,50,100] 口径同样成立', () => {
    const logs = { defaultPageSize: 20, allowedPageSizes: [20, 50, 100] as const }
    expect(resolvePaging({ ...logs, page: 1, pageSize: 100 }).pageSize).toBe(100)
    expect(resolvePaging({ ...logs, page: 1, pageSize: 10 }).pageSize).toBe(20)
  })
})

describe('resolvePaging · clamp 模式（allocations 用的口径）', () => {
  const base = { defaultPageSize: 20, maxPageSize: 100 }

  it('?pageSize=2.5 被取整，不再原样进 LIMIT', () => {
    // 改造前 `Math.min(100, Math.max(1, Number(2.5) || 20))` = 2.5 → PG int8in 报错。
    expect(resolvePaging({ ...base, page: 1, pageSize: 2.5 }).pageSize).toBe(2)
  })

  it('超上限夹到 maxPageSize，非法值回落 defaultPageSize', () => {
    expect(resolvePaging({ ...base, page: 1, pageSize: 1000 }).pageSize).toBe(100)
    for (const bad of [0, -10, NaN, Infinity, 1e21, 'abc', null, undefined]) {
      expect(resolvePaging({ ...base, page: 1, pageSize: bad }).pageSize, String(bad)).toBe(20)
    }
  })

  it('maxPageSize 这个参数**自身**也过归一', () => {
    // 不校验第 4 参，`Math.min(cap, n)` 会把 cap 的小数/负数/NaN 直接吐出出口。
    // `-10` 还恰好满足 isSafeInteger，说明光靠「是安全整数」不够，还得 ≥ 1。
    for (const badCap of [0.5, NaN, -10, Infinity, undefined, 'x']) {
      const { pageSize } = resolvePaging({
        page: 1, pageSize: 9999, defaultPageSize: 20, maxPageSize: badCap as number,
      })
      expect(Number.isSafeInteger(pageSize), String(badCap)).toBe(true)
      expect(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE_CEILING, String(badCap)).toBe(true)
    }
    // 合法但离谱的上限被 CEILING 压住 —— 否则 offset 会越过 2^53
    expect(resolvePaging({
      page: 1, pageSize: 1e9, defaultPageSize: 20, maxPageSize: 1e9,
    }).pageSize).toBe(MAX_PAGE_SIZE_CEILING)
  })

  it('defaultPageSize 非法时兜到 1，绝不吐出 undefined', () => {
    // `undefined` 会被 pg 序列化成 `null`，而 `LIMIT NULL` 在 PG 等于**不限行数**（静默全表返回）。
    const { pageSize } = resolvePaging({
      page: 1, pageSize: 'abc', defaultPageSize: undefined as unknown as number,
    })
    expect(pageSize).toBe(1)
    expect(Number.isSafeInteger(pageSize)).toBe(true)
  })

  it('缺省 maxPageSize 时用 MAX_PAGE_SIZE', () => {
    expect(resolvePaging({ page: 1, pageSize: 9999, defaultPageSize: 20 }).pageSize)
      .toBe(MAX_PAGE_SIZE)
  })
})

describe('resolvePaging · 无条件契约', () => {
  it('任意入参组合下，page / pageSize / offset 三者均为安全整数', () => {
    // 验收标准：「断言传给 Drizzle 的 limit/offset 均 Number.isSafeInteger 为真」。
    //
    // ⚠️ 第 3/4 参（defaultPageSize / allowedPageSizes / maxPageSize）**也必须敌意化**。
    // 第一版矩阵只变 page × pageSize，三组 opts 里的第 3/4 参全是固定合法值 ——
    // 「白名单 × maxPageSize 同传时出口落在白名单外」与「空白名单 truthy」这两个真缺陷
    // 正好落在那个盲区里，648 组合一个都没碰到。
    const hostileSizes: unknown[] = [
      2.5, 0, -1, NaN, Infinity, 1e21, Number.MAX_SAFE_INTEGER, '50', null, undefined, {}, [],
    ]
    const hostileOpts: Array<Record<string, unknown>> = [
      { defaultPageSize: 20, allowedPageSizes: [10, 20, 50] },
      { defaultPageSize: 20, maxPageSize: 100 },
      { defaultPageSize: 20 },
      // —— 以下是第 3/4 参的敌意集 ——
      { defaultPageSize: 20, allowedPageSizes: [] },                        // 空白名单（truthy 陷阱）
      { defaultPageSize: 20, allowedPageSizes: [0, -5, NaN] },              // 白名单全是非法值
      { defaultPageSize: 20, allowedPageSizes: [10, 20.5] },                // 白名单含小数
      { defaultPageSize: 20, allowedPageSizes: [10, 1e21] },                // 白名单含超安全整数
      { defaultPageSize: 20, allowedPageSizes: [10, 20, 50], maxPageSize: 30 }, // 白名单 × cap 同传
      { defaultPageSize: 0 },
      { defaultPageSize: -5 },
      { defaultPageSize: 20.7 },
      { defaultPageSize: 5000 },                                            // 超 CEILING
      { defaultPageSize: undefined },
      { defaultPageSize: 20, maxPageSize: 0.5 },
      { defaultPageSize: 20, maxPageSize: -10 },
      { defaultPageSize: 20, maxPageSize: NaN },
      { defaultPageSize: 20, maxPageSize: 1e21 },
    ]
    for (const [label, page] of HOSTILE_PAGES) {
      for (const pageSize of hostileSizes) {
        for (const opts of hostileOpts) {
          const r = resolvePaging({ ...opts, page, pageSize } as Parameters<typeof resolvePaging>[0])
          const at = `${label} × ${String(pageSize)} × ${JSON.stringify(opts)}`
          expect(Number.isSafeInteger(r.page), at).toBe(true)
          expect(Number.isSafeInteger(r.pageSize), at).toBe(true)
          expect(Number.isSafeInteger(r.offset), at).toBe(true)
          expect(r.page >= 1, at).toBe(true)
          expect(r.pageSize >= 1, at).toBe(true)
          expect(r.offset >= 0, at).toBe(true)
          // offset 是 String() 后按文本传给 PG 的 —— 指数记法就是本 issue 那个 500。
          // （pageSize 侧不断言这条：它被 cap ≤ 1000 压着，距指数记法阈值 1e21 有 18 个
          //   数量级，那条断言实质不可证伪 —— 把 clampInt 换成裸 Math.min 它照样绿。）
          expect(String(r.offset), at).not.toMatch(/e/i)
        }
      }
    }
  })

  it('白名单模式的出口一定落在白名单里（cap 在这个模式下无话语权）', () => {
    // 反例来自边界评审：命中白名单后若再夹 cap，`maxPageSize:30` 会把 50 压成 30，
    // 而 30 不是任何一个 UI 选项 —— 服务端每页 30 条、UI 按 50 算页数，尾部数据够不到。
    expect(resolvePaging({
      page: 1, pageSize: 50, defaultPageSize: 10,
      allowedPageSizes: [10, 20, 50], maxPageSize: 30,
    }).pageSize).toBe(50)
  })

  it('空白名单退回 clamp 模式，不是「白名单永远 miss」', () => {
    // `allowedPageSizes: []` 是 truthy —— 判真值会让它走白名单模式且**永远 miss**，
    // pageSize 入参被静默忽略；判 `?.length` 才会退回 clamp。
    //
    // ⚠️ 这里的 `pageSize` 必须**不等于** `defaultPageSize`，否则两种实现返回值相同、
    // 断言区分不出来 —— 第一版就写成了 `pageSize: 20, defaultPageSize: 20`，
    // 红检时把 `?.length` 改回 `allowedPageSizes` 竟然全绿（恒真断言）。
    const r = resolvePaging({ page: 2, pageSize: 50, defaultPageSize: 20, allowedPageSizes: [] })
    expect(Number.isSafeInteger(r.pageSize)).toBe(true)
    expect(r.pageSize).toBe(50)
  })

  it('白名单含非法常量时不破契约（宁可回落也不吐出去）', () => {
    // 白名单是代码常量，但它若被写成 `[10, 20.5]` / `[10, 1e21]`，
    // 「出口恒为安全整数」就会从白名单这一侧破掉。
    expect(resolvePaging({ page: 1, pageSize: 20.5, defaultPageSize: 10, allowedPageSizes: [10, 20.5] }).pageSize).toBe(10)
    expect(resolvePaging({ page: 1, pageSize: 1e21, defaultPageSize: 10, allowedPageSizes: [10, 1e21] }).pageSize).toBe(10)
  })

  it('offset 与归一后的 page/pageSize 自洽', () => {
    const r = resolvePaging({ page: 2.9, pageSize: 50, defaultPageSize: 20, allowedPageSizes: [10, 20, 50] })
    expect(r).toEqual({ page: 2, pageSize: 50, offset: 50 })
  })
})

/** 递归收集目录下的 .ts / .tsx（跳过测试与 node_modules） */
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
 * 剥掉 JS/TS 注释，供源码字面量守护用。
 *
 * ⚠️ 必须剥**行尾**注释而不只是整行注释 —— 本仓 `a85cb17e`（#250）就因同型疏漏返工过一次：
 * `const x = 1 // Math.max(1, filters.page || 1)` 这种写法下，只剥「整行注释」的正则
 * 会把它原样留下 → 守护正则命中 → **误报变红**（不是被绕过，是反向踩雷）。
 * 同时要跳过引号内的双斜杠，否则 `'https://x'` 会被从协议分隔符处截断。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // 找第一个不是 `://` 一部分、且不在引号内的 `//`
      let inSingle = false, inDouble = false, inTick = false
      for (let i = 0; i < line.length - 1; i++) {
        const c = line[i]
        if (c === '\\') { i++; continue }
        if (!inDouble && !inTick && c === "'") inSingle = !inSingle
        else if (!inSingle && !inTick && c === '"') inDouble = !inDouble
        else if (!inSingle && !inDouble && c === '`') inTick = !inTick
        else if (!inSingle && !inDouble && !inTick && c === '/' && line[i + 1] === '/') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

describe('防复发守护（#281 改完后不能再长回来）', () => {
  const SRC = resolve(__dirname, '..')
  // ⚠️ 扫描根必须含 `lib` —— 第一版只扫 actions + app，而 `lib/inventory/engine.ts`
  // 当时正逐字匹配「手算 offset」那条正则，守护恒绿**不是因为没有违规，
  // 是因为扫描根避开了现场**。
  const ROOTS = ['actions', 'app', 'lib']

  it('全仓不得再出现不取整的页码写法', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of collectSources(join(SRC, root))) {
        const code = stripComments(readFileSync(file, 'utf8'))
        // 只认「页码」语义的那几种：`.page` 字段 与 `get('page', …)` URL 取值。
        // 数量夹取（`Math.max(1, Number(item.quantity) || 1)`）不在此列。
        if (/Math\.max\(\s*1\s*,\s*\w+\.page\b/.test(code)) offenders.push(`${file} (filters.page)`)
        if (/Math\.max\(\s*1\s*,\s*Number\(\s*\w+\.page\b/.test(code)) offenders.push(`${file} (Number(params.page))`)
        // 裸 `Number(get('page'))`（连 Math.max 都没有）——三个 reviewer 独立发现的那 4 处
        // 正是这个形状，第一版三条正则全要求 `Math.max` 前缀，对它完全失明。
        if (/(?<!normalizePage\()\bNumber\(\s*get\(\s*['"]page['"]/.test(code)) {
          offenders.push(`${file} (裸 Number(get('page')))`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('服务端不得手算 offset —— 只能由 resolvePaging 给出', () => {
    // `const offset = (page - 1) * pageSize` 手算一次，契约就退化成
    // 「靠调用点两个入参都恰好正确」—— 这正是 #281 的成因。
    //
    // ⚠️ 只管**服务端**（actions + lib）：`src/app` 下客户端组件的
    // `filtered.slice((page - 1) * pageSize, …)` 是内存分页，不进 PG，
    // 其安全性由「page 走 normalizePage + pageSize 走白名单」保证，
    // 已由本文件另两条守护覆盖。把它们一起禁掉是过度收紧（第一版正则就是这么误伤的）。
    //
    // ⚠️ 扫描根必须含 `lib` —— 更早一版只扫 actions，而 `lib/inventory/engine.ts`
    // 当时正逐字匹配这条正则，守护恒绿**不是因为没有违规，是因为扫描根避开了现场**。
    const offenders: string[] = []
    for (const root of ['actions', 'lib']) {
      for (const file of collectSources(join(SRC, root))) {
        if (file.endsWith('/lib/paging.ts')) continue   // 单源自身就是算 offset 的地方
        const code = stripComments(readFileSync(file, 'utf8'))
        if (/\(\s*\w*[Pp]age\w*\s*-\s*1\s*\)\s*\*/.test(code)) offenders.push(file)
      }
    }
    expect(offenders, `手算 offset 的文件:\n${offenders.join('\n')}`).toEqual([])
  })

  it('每个做 SQL 分页的 action 都调了 resolvePaging（存在性，不是计数）', () => {
    // 计数型断言（`toBe(17)`）的毛病：合法新增第 18 个分页 action 时它变红，
    // 维护者被训练成「直接把 17 改成 18」，守护退化成计数器。
    // 改成存在性：**凡是出现 `.offset(` 的 action 文件，必须同时出现 `resolvePaging`**。
    const missing: string[] = []
    for (const file of collectSources(join(SRC, 'actions'))) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (!/\.offset\(/.test(code)) continue
      // 导出走 keyset / 专用 helper，不经 resolvePaging
      if (/resolveExport(Keyset|Offset)Page|nonNegativeOffset/.test(code) && !/resolvePaging/.test(code)) continue
      if (!/resolvePaging/.test(code)) missing.push(file)
    }
    expect(missing, `用了 .offset() 却没走 resolvePaging:\n${missing.join('\n')}`).toEqual([])
  })

  it('所有从 URL 读页码的组件都走 normalizePage，一个不漏', () => {
    // 不写死数字，改成「读 page 的地方 == 走 normalizePage 的地方」的**等式**：
    // 第一版守护写死 20，恰好漏掉了 products / stores / coupons / legacy-orders 四处
    // ——它们的写法是 `Number(get("page","1"))`（连 Math.max 都没有），
    // 计数型断言对「本来就没数到」的遗漏零保护，等式型才抓得住。
    const reading: string[] = []
    const normalized: string[] = []
    for (const file of collectSources(join(SRC, 'app'))) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const m of code.matchAll(/get\(\s*['"]page['"]/g)) {
        reading.push(`${file}@${m.index}`)
      }
      for (const m of code.matchAll(/normalizePage\(\s*get\(\s*['"]page['"]/g)) {
        normalized.push(`${file}@${m.index}`)
      }
    }
    const unguarded = reading.filter((r) => {
      const [file, idx] = r.split('@')
      // normalizePage( 比 get( 早 14 个字符起头，用「同文件且偏移接近」配对
      return !normalized.some((n) => n.split('@')[0] === file
        && Math.abs(Number(n.split('@')[1]) + 14 - Number(idx)) <= 2)
    })
    expect(unguarded, `未走归一的页码读取点:\n${unguarded.join('\n')}`).toEqual([])
    expect(reading.length).toBeGreaterThanOrEqual(24)
  })

  it('paging.ts 的两道防线都在（取整 + 安全整数判据 + 双上限）', () => {
    const source = readFileSync(resolve(__dirname, 'paging.ts'), 'utf8')
    // 右锚用函数体自身的收尾 `\n}`，不要拿后面某个无关声明当锚 ——
    // 日后有人在两者之间插入任何东西，slice 会把那段也吃进来，断言照绿、守护悄悄失效。
    const fnStart = source.indexOf('function clampInt')
    expect(fnStart).toBeGreaterThan(-1)
    const fn = source.slice(fnStart, source.indexOf('\n}', fnStart) + 2)
    expect(fn).toMatch(/Math\.trunc/)
    // 判据必须是 isSafeInteger 而不是 isFinite —— 后者放行 1e21
    expect(fn).toMatch(/Number\.isSafeInteger/)
    expect(fn).not.toMatch(/Number\.isFinite/)
    expect(fn).toMatch(/n >= 1/)
    expect(source).toMatch(/export const MAX_PAGE = /)
    expect(source).toMatch(/export const MAX_PAGE_SIZE_CEILING = /)
    // 乘法不封闭那条的前提：(MAX_PAGE - 1) × CEILING 必须落在安全整数内
    expect(Number.isSafeInteger((MAX_PAGE - 1) * MAX_PAGE_SIZE_CEILING)).toBe(true)
  })

  it('不跨端 import（CLAUDE.md：禁止跨端共享代码目录）', () => {
    // 剥注释后再扫 —— 文件顶部**故意**写了 staffApi / clientApi 两份副本的路径当索引，
    // 不剥的话这条断言会被那段指路注释绊倒，而不是被真实的跨端 import 绊倒。
    const code = readFileSync(resolve(__dirname, 'paging.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\brequire\(/)
    expect(code).not.toMatch(/from ['"]\.\.\/\.\.\/\.\./)
    expect(code).not.toMatch(/cloudfunctions/)
    // 正面：这个文件必须零依赖（客户端组件也 import 它，混进 server-only 会炸构建）
    expect(code).not.toMatch(/^import /m)
  })
})
