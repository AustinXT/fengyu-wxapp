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
    // 不可调用）→ TypeError。admin 当前入参都来自 URL query（都是串），这条不可达，
    // 但本文件是该缺陷类的抄写模板，破口会跟着模板扩散。
    const hostile = JSON.parse('{"toString": null}')
    expect(() => Number(hostile)).toThrow(TypeError)
    expect(normalizePage(hostile)).toBe(1)
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
    // 这里穷举 hostile page × hostile pageSize × 两种模式。
    const hostileSizes: unknown[] = [
      2.5, 0, -1, NaN, Infinity, 1e21, Number.MAX_SAFE_INTEGER, '50', null, undefined, {}, [],
    ]
    for (const [label, page] of HOSTILE_PAGES) {
      for (const pageSize of hostileSizes) {
        for (const opts of [
          { defaultPageSize: 20, allowedPageSizes: [10, 20, 50] as const },
          { defaultPageSize: 20, maxPageSize: 100 },
          { defaultPageSize: 20 },
        ]) {
          const r = resolvePaging({ ...opts, page, pageSize })
          const at = `${label} × ${String(pageSize)} × ${JSON.stringify(opts)}`
          expect(Number.isSafeInteger(r.page), at).toBe(true)
          expect(Number.isSafeInteger(r.pageSize), at).toBe(true)
          expect(Number.isSafeInteger(r.offset), at).toBe(true)
          expect(r.page >= 1, at).toBe(true)
          expect(r.pageSize >= 1, at).toBe(true)
          expect(r.offset >= 0, at).toBe(true)
          // offset 是 String() 后按文本传给 PG 的 —— 指数记法就是本 issue 那个 500
          expect(String(r.offset), at).not.toMatch(/e/i)
          expect(String(r.pageSize), at).not.toMatch(/e/i)
        }
      }
    }
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

describe('防复发守护（#281 的 38 处改完后不能再长回来）', () => {
  const SRC = resolve(__dirname, '..')

  it('src/actions 与 src/app 下不得再出现不取整的页码写法', () => {
    // ⚠️ 必须**剥掉注释**再扫：本次改动在 engine.ts / paging.ts 的说明里复述了旧写法当反例，
    // 不剥的话这条断言会被自己的注释绊倒，而不是被真实复发绊倒。
    const offenders: string[] = []
    for (const file of [...collectSources(join(SRC, 'actions')), ...collectSources(join(SRC, 'app'))]) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
        .replace(/^\s*\/\/.*$/gm, '')        // 行注释
      // 只认「页码」语义的那几种：`.page` 字段 与 `get('page', …)` URL 取值。
      // 数量夹取（`Math.max(1, Number(item.quantity) || 1)`）不在此列。
      if (/Math\.max\(\s*1\s*,\s*\w+\.page\b/.test(code)) offenders.push(`${file} (filters.page)`)
      if (/Math\.max\(\s*1\s*,\s*Number\(\s*\w+\.page\b/.test(code)) offenders.push(`${file} (Number(params.page))`)
      if (/Math\.max\(\s*1\s*,\s*Number\(\s*get\(\s*['"]page['"]/.test(code)) offenders.push(`${file} (get('page'))`)
    }
    expect(offenders).toEqual([])
  })

  it('每个自己算 offset 的地方都得是 resolvePaging 给的', () => {
    // `const offset = (page - 1) * pageSize` 手算一次，契约就退化成
    // 「靠调用点两个入参都恰好正确」—— 这正是 #281 的成因。
    const offenders: string[] = []
    for (const file of collectSources(join(SRC, 'actions'))) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (/const offset = \(page - 1\) \* pageSize/.test(code)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('17 处 action 调用点全部在位（少一处就是有人改回内联写法）', () => {
    const files = collectSources(join(SRC, 'actions'))
    const hits = files.flatMap((f) => {
      const m = readFileSync(f, 'utf8').match(/resolvePaging\(\{/g)
      return m ? [[f, m.length] as const] : []
    })
    const total = hits.reduce((s, [, n]) => s + n, 0)
    // issue 正文记的是「17 处 page + 1 处 pageSize」，但那 1 处 pageSize
    // （allocations）与它的 page 是**同一个调用点** —— 合并后是 17 个，不是 18 个。
    // 构成：16 处白名单型（15 个文件 + messages 第 2 处）+ allocations 的 1 处 clamp 型。
    expect(total, `实际分布: ${hits.map(([f, n]) => `${f.split('/').pop()}×${n}`).join(', ')}`).toBe(17)
  })

  it('20 处组件调用点全部在位', () => {
    const files = collectSources(join(SRC, 'app'))
    const total = files.reduce((s, f) => {
      const m = readFileSync(f, 'utf8').match(/normalizePage\(get\(/g)
      return s + (m ? m.length : 0)
    }, 0)
    expect(total).toBe(20)
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
