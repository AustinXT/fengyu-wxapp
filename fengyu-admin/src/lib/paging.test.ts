import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import ts from 'typescript'
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
          // ⓘ 这里**刻意不再断言**「String(offset) 不含指数记法」：
          //    `Number.isSafeInteger` 已保证 |offset| ≤ 9.0e15，而 JS 转指数记法的阈值
          //    是 1e21 —— 差 5 个数量级，该断言在上面那行通过后**恒真、不可证伪**。
          //    指数记法这条风险由「isSafeInteger + MAX_PAGE × CEILING 双上限」真正守住，
          //    下面那条常量断言才是它的守护。
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

  it('白名单模式的**回落路径**也不受 maxPageSize 影响', () => {
    // 评审反例：第一版只修了「命中路径不夹 cap」，回落值仍走 `clampInt(default, cap, 1)`，
    // 于是 `maxPageSize:5` 会把 fallback 20 压成 5 —— 5 不在白名单，
    // 服务端每页 5 条而 UI 按 20 算页数，尾部数据够不到，且零报错。
    expect(resolvePaging({
      page: 1, pageSize: 7, defaultPageSize: 20,
      allowedPageSizes: [10, 20, 50], maxPageSize: 5,
    })).toEqual({ page: 1, pageSize: 20, offset: 0 })
  })

  it('defaultPageSize 不在白名单时退到白名单首个合法值，而不是吐出白名单外的数', () => {
    // 调用点把 default 写错（不在自己的白名单里）也不能让出口逃出白名单 ——
    // 否则「服务端页长 ∈ UI 选项」这条不变量就从回落路径破了。
    expect(resolvePaging({
      page: 1, pageSize: 7, defaultPageSize: 33, allowedPageSizes: [10, 20, 50],
    }).pageSize).toBe(10)
    // 白名单整个不可用 → 兜 1（宁可一页少返回，也不放任失控值进 LIMIT）
    expect(resolvePaging({
      page: 1, pageSize: 7, defaultPageSize: 33, allowedPageSizes: [0, -5, NaN],
    }).pageSize).toBe(1)
  })

  it('非数组 allowedPageSizes 不抛异常（.includes is not a function → 500）', () => {
    // 评审 fuzz 实测：`{length: 2}` 能过 `?.length` 判真却没有 `.includes`，
    // 抛 TypeError → 全局 catch → 500，正是本 issue 要消灭的降级类。
    // TS 类型挡编译期，挡不住 Server Action 直调。
    for (const notArray of [{ length: 2 }, '1020', 42, true]) {
      const r = resolvePaging({
        page: 1, pageSize: 50, defaultPageSize: 20,
        allowedPageSizes: notArray as unknown as number[],
      })
      expect(Number.isSafeInteger(r.pageSize), String(notArray)).toBe(true)
      // 不止「不抛」，还要钉死**退回 clamp 模式**：
      // 只断言「不抛 + ≥1」的话，判据退回 `allowedPageSizes?.includes` 后
      // `'1020'` 会走子串语义（`'1020'.includes(50)` 为 false）→ 回落 20，
      // 断言照样绿。取 50（≠ default 20）才区分得出来。
      expect(r.pageSize, String(notArray)).toBe(50)
    }
  })

  it('clamp 模式对 (0,1) 小数与负数的行为 delta 已钉死（与改造前不逐值等价）', () => {
    // 这两条是**刻意**的行为变更，评审要求显式声明而非留白：
    //   旧 `Math.min(100, Math.max(1, Number(x) || 20))` 把 0.5 / -5 抬成 1
    //   新实现回落到调用点默认值 20
    // 方向无风险（两者都不报错），但要有用例钉住，避免日后被当成 bug「修回去」。
    const base = { page: 1, defaultPageSize: 20, maxPageSize: 100 }
    expect(resolvePaging({ ...base, pageSize: 0.5 }).pageSize).toBe(20)
    expect(resolvePaging({ ...base, pageSize: -5 }).pageSize).toBe(20)
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
 *
 * ⚠️ 块注释也**不能**用 `/\*[\s\S]*?\*\/` 一把梭：那会把字符串里的开闭符当成注释，
 * `const a = "(左星号)"; const offset = (page - 1) * pageSize; const b = "(右星号)"`
 * 整段被吃掉，真违规反而被藏起来（评审给的反例）。所以走逐字符状态机。
 *
 * **已知局限（如实记下，不假装完备）**：字符串内容是保留的，所以字符串字面量里
 * 真写了 `"Math.max(1, filters.page)"` 会误报。当前代码库无此形状；
 * 若将来撞上，在那一处加 `eslint-disable` 式的豁免注释比放宽守护更安全。
 */
function stripComments(source: string, fileName: string): string {
  // 用 TypeScript 自己的 parser 定位注释区间，**不要手写词法状态机**。
  // 手写版在这里翻过两次车：先是用 `/\*[\s\S]*?\*\//` 一把梭，把字符串里的
  // 开闭符当注释、整段吃掉真违规；改成逐字符状态机后又栽在**正则字面量**
  // （`const re = /['"]/` 的引号翻转字符串态）、**模板插值** `${...}` 里的双斜杠、
  // 以及 JSX 文本里的撇号（`<div>don't</div>`）上 —— 每一种都能造成漏报或误报。
  // ts.createSourceFile 处理这些上下文是它的本职，借它的力比自己造词法器可靠得多。
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const holes: Array<[number, number]> = []
  const visit = (node: ts.Node) => {
    for (const r of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      holes.push([r.pos, r.end])
    }
    for (const r of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) {
      holes.push([r.pos, r.end])
    }
    // ⚠️ 必须用 `getChildren()` 递归到 **token 级**，不能用 `forEachChild`（只走 AST node）。
    // 注释挂在「下一个 token 的 leading」上，而 JSX 表达式容器 `{/* … */}`、
    // 空数组 `[/* … */]`、空对象 `{ /* … */ }`、参数间 `call(/* … */ 1, 2)` 这几种形状里，
    // 注释后面跟的是 `}` / `]` / `1` 这类**标点或字面量 token**，不是 AST node ——
    // `forEachChild` 走不到它们，注释就采集不到、留在原地被守护正则当代码命中（误报变红）。
    node.getChildren(sf).forEach(visit)
  }
  visit(sf)
  // 挖空而不是删除：保留换行与字符偏移，行号定位与 wrappedByNormalizePage 的
  // 「往前跳空白」才不会被打乱。
  //
  // ⚠️ 必须用 `split('')`（按 **UTF-16 code unit**）而不是 `[...source]`（按码点）——
  // TS 的 comment range 是 UTF-16 偏移，而 `[...]` 会把一个 emoji 当 1 个元素、
  // 其后所有下标整体左移，挖空位置随之错位：实测
  // `const e = "(emoji)(emoji)"; // x` 之后那行的首字母 `M` 被擦成空格，
  // `Math.max(1, filters.page)` 直接漏报。扫描根内 refunds.ts / orders.ts 等**确实有 emoji**，
  // 这不是理论问题。
  const chars = source.split('')
  for (const [from, to] of holes) {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

/**
 * 判断 `source[idx]` 这个位置是否被 `normalizePage(` 直接包裹。
 *
 * ⚠️ 不能用「字符偏移相减 ≤ N」来配对 —— 第一版写的是 `+14±2`，
 * `normalizePage(\n  get("page", "1")\n)` 这种完全合法的换行写法会同时
 * 被「未归一」守护误报、又被配对逻辑漏掉。往前跳空白再比字面量对格式免疫。
 */
function wrappedByNormalizePage(source: string, idx: number): boolean {
  let i = idx - 1
  while (i >= 0 && /\s/.test(source[i])) i--
  // 先认左括号，再跨过「函数名与括号之间的空白」—— `normalizePage (get(…))` 是合法写法，
  // 直接比 `normalizePage(` 会把它误判成未包裹（fail-closed 误报，CI 会红但很费解）。
  if (source[i] !== '(') return false
  i--
  while (i >= 0 && /\s/.test(source[i])) i--
  const NAME = 'normalizePage'
  if (source.slice(i - NAME.length + 1, i + 1) !== NAME) return false
  // ⚠️ 后缀比对会把 `denormalizePage(` / `myNormalizePage(` 也算命中 —— 前者的后 14 个
  // 字符恰好就是 `normalizePage(`。必须确认它是**独立标识符**而不是别的函数的词尾。
  const before = source[i - NAME.length]
  // 边界字符集要含 `.` —— 否则 `fake.normalizePage(get('page'))` 也算命中，
  // 而那个方法可能只是 `x => x`，页码根本没归一（漏报方向）。
  return before === undefined || !/[\w$.]/.test(before)
}

/**
 * 页码反模式清单 —— **守护与灵敏度用例共用的唯一一份**。
 *
 * ⚠️ 别在用例里另写一份正则副本：评审实测过，把守护里的 `RECEIVER` 退回 `\w+\.`
 * 之后，用例因为用的是自己那份增强版正则、照样全绿 —— 灵敏度回退**完全不可见**，
 * 「有灵敏度用例」反而成了安慰剂。单源之后，改坏守护必然同时打红灵敏度用例。
 *
 * receiver 写成 `[\w$]+(?:\??\.[\w$]+)*\??\.` 而不是 `\w+\.`：后者对**可选链**
 * （`filters?.page`）与**带命名空间的 receiver**（`searchParams.get('page')`）双双失明，
 * 而这两种恰恰是最可能的真实复发形态。
 */
const RECEIVER = String.raw`[\w$]+(?:\??\.[\w$]+)*\??\.`

const PAGE_ANTIPATTERNS: Array<[re: RegExp, label: string, mustHit: string]> = [
  [new RegExp(String.raw`Math\.max\(\s*1\s*,\s*(?:Number\(\s*)?${RECEIVER}page\b`),
    'Math.max(1, x.page)',
    'const page = Math.max(1, filters?.page ?? 1)'],
  [new RegExp(String.raw`Math\.max\(\s*1\s*,\s*Number\(\s*(?:${RECEIVER})?get\(\s*['"]page['"]`),
    "Math.max(1, Number(get('page')))",
    `const page = Math.max(1, Number(searchParams.get('page')) || 1)`],
  // 裸 `Number(get('page'))`（连 Math.max 都没有）—— 三个 reviewer 独立发现的那 4 处
  // 正是这个形状，第一版三条正则全要求 `Math.max` 前缀，对它完全失明。
  [new RegExp(String.raw`(?<!normalizePage\()\bNumber\(\s*(?:${RECEIVER})?get\(\s*['"]page['"]`),
    "裸 Number(get('page'))",
    `const page = Number(searchParams.get('page'))`],
  // ⚠️ 这条只认「结果**直接当页码变量用**」的形状（`const page = Number(x.page)`），
  // 不能写成泛泛的 `Number(<receiver>.page)` —— 那会把 19 个 `page.tsx` 里的
  // `page: params.page ? Number(params.page) : undefined` 一起抓进来，
  // 而那些值是**传给已归一 action 的入参**，不是页码本身，归一在 action 内做。
  [new RegExp(String.raw`const\s+[\w$]*[Pp]age[\w$]*\s*=\s*Number\(\s*${RECEIVER}page\b`),
    'const page = Number(x.page)',
    'const currentPage = Number(filters.page) || 1'],
]

/** 手算 offset 的两种等价写法。同样是守护与灵敏度用例共用的单源。 */
const OFFSET_ANTIPATTERNS: Array<[re: RegExp, mustHit: string]> = [
  [/\(\s*[\w$.?]*[Pp]age[\w$]*\s*-\s*1\s*\)\s*\*/, 'const offset = (page - 1) * pageSize'],
  [/[\w$.?]*[Pp]age[\w$]*\s*\*\s*([\w$.?]*[Pp]ageSize[\w$]*)\s*-\s*\1\b/, 'const offset = page * pageSize - pageSize'],
]

describe('守护的底层工具自身（这两个函数错了，上面所有守护都失真）', () => {
  // 这一组是**对守护的守护**。两次评审各抓出一批 stripComments 的翻车形状，
  // 每修一次就把反例钉在这里 —— 否则下一次「顺手简化成正则」会把坑原样刨回来。
  const OFFSET_RE = /\(\s*[\w$.?]*[Pp]age[\w$]*\s*-\s*1\s*\)\s*\*/
  const BAD_RE = /Math\.max\(\s*1\s*,\s*(?:Number\(\s*)?[\w$]+(?:\??\.[\w$]+)*\??\.page\b/

  it.each([
    // [场景, 源码, 文件名, 正则, 期望命中]
    ['正则字面量里的引号不该翻转字符串态（否则后面的真违规被吞）',
      `const re = /['"]/;\nconst s = '/*';\nconst offset = (page - 1) * pageSize;\nconst t = '*/';`,
      'a.ts', OFFSET_RE, true],
    ['模板插值里的双斜杠不是行注释',
      'const x = `${`//`}`; const offset = (page - 1) * pageSize',
      'b.ts', OFFSET_RE, true],
    ['插值内的块注释要剥掉（否则误报）',
      'const x = `${1 /* Math.max(1, filters.page) */}`',
      'c.ts', BAD_RE, false],
    // ⚠️ 这条的断言必须是 **BAD_RE 不命中**，不能是 OFFSET_RE 命中。
    // 撇号翻车的真实失败方向是：`don'` 让旧状态机进字符串态且永不闭合，
    // 于是下一行的 `// Math.max(1, filters.page)` **作为「字符串内容」被保留** →
    // BAD_RE 误报变红。而 OFFSET_RE 那句在旧实现下同样完好 → 断言 true 恒绿、
    // 钉不住这条回归（GLM 逐字复刻旧状态机实测确认）。
    ['JSX 文本里的撇号不该进入字符串态（否则后续注释存活→误报）',
      `const A = () => <div>don't</div>\n// Math.max(1, filters.page)\nconst offset = (page - 1) * pageSize`,
      'd.tsx', BAD_RE, false],
    ['JSX 表达式容器里的注释要剥掉（forEachChild 走不到 } token）',
      `const A = () => (<div>{/* (page - 1) * pageSize */}</div>)`,
      'd2.tsx', OFFSET_RE, false],
    ['空容器 / 参数间的注释同样要剥掉',
      `const a = [/* (page - 1) * pageSize */]; call(/* (page - 1) * pageSize */ 1, 2)`,
      'd3.ts', OFFSET_RE, false],
    ['行尾注释里的反模式要剥掉（#250 踩过的误报）',
      'const x = 1 // Math.max(1, filters.page || 1)',
      'e.ts', BAD_RE, false],
    ['字符串夹注释符不能吃掉中间的真违规',
      `const a = "/*"; const offset = (page - 1) * pageSize; const b = "*/"`,
      'f.ts', OFFSET_RE, true],
    ['真实违规照常命中',
      'const page = Math.max(1, filters.page || 1)',
      'g.ts', BAD_RE, true],
    // ⚠️ 挖空必须按 **UTF-16 code unit**（`split('')`）而不是码点（`[...source]`）——
    // TS 的 comment range 是 UTF-16 偏移，用码点下标会让 emoji 之后的所有位置左移，
    // 挖空错位一格，把下一行的首字母吃掉 → 真违规漏报。
    // 扫描根内 refunds.ts / orders.ts 等确实含 emoji，不是理论问题。
    // ⚠️ 挖空必须按 **UTF-16 code unit**（`split('')`）而不是码点（`[...source]`）：
    // TS 的 comment range 是 UTF-16 偏移，而码点下标会让每个 emoji 把其后位置压缩 1 位，
    // 于是挖空区间整体**向后错位 N 格**（N = 之前的 emoji 个数）——
    // 注释被擦掉的同时，紧随其后的真代码也被啃掉 N 个字符，真违规随之漏报。
    // 扫描根内 refunds.ts / orders.ts 等确实含 emoji，不是理论问题。
    //
    // 这个用例的形状是调出来的：emoji 数要够多（3 个）、反模式要**紧贴注释下一行行首**，
    // 错位才啃得到 `(page` 这几个字符。放宽任一条件都会让断言恒绿
    // ——「emoji 放注释后面」「反模式不在行首」两种写法都试过，码点版照样命中。
    ['emoji 造成的挖空错位会啃掉紧邻的真代码（UTF-16 偏移 vs 码点下标）',
      'const e = "\u{1F600}\u{1F600}\u{1F600}"\n// xx\n(page - 1) * pageSize',
      'h.ts', OFFSET_RE, true],
  ])('stripComments: %s', (_label, src, fileName, re, hit) => {
    expect((re as RegExp).test(stripComments(src as string, fileName as string))).toBe(hit)
  })

  it.each([
    ['normalizePage(get(…))', `normalizePage(get('page', '1'))`, true],
    ['换行写法也算包裹', `normalizePage(\n  get('page', '1')\n)`, true],
    // 后缀比对的经典漏报：`denormalizePage(` 的后 14 个字符恰好是 `normalizePage(`
    ['denormalizePage(get(…)) 不算', `denormalizePage(get('page', '1'))`, false],
    ['myNormalizePage(get(…)) 不算', `myNormalizePage(get('page', '1'))`, false],
    ['名与括号间有空格也算包裹', `normalizePage (get('page', '1'))`, true],
    // 边界字符集必须含 `.`，否则成员访问能冒充：`fake.normalizePage` 可能只是 `x => x`
    ['fake.normalizePage(get(…)) 不算', `fake.normalizePage(get('page', '1'))`, false],
    ['obj?.normalizePage(get(…)) 不算', `obj?.normalizePage(get('page', '1'))`, false],
    ['裸 get 不算', `const p = get('page', '1')`, false],
  ])('wrappedByNormalizePage: %s', (_label, src, expected) => {
    const idx = (src as string).indexOf("get('page'")
    expect(wrappedByNormalizePage(src as string, idx)).toBe(expected)
  })
})

describe('防复发守护（#281 改完后不能再长回来）', () => {
  const SRC = resolve(__dirname, '..')
  // ⚠️ 扫描根必须含 `lib` —— 第一版只扫 actions + app，而 `lib/inventory/engine.ts`
  // 当时正逐字匹配「手算 offset」那条正则，守护恒绿**不是因为没有违规，
  // 是因为扫描根避开了现场**。
  const ROOTS = ['actions', 'app', 'lib']

  it('守护正则本身有灵敏度（放宽/收窄了会被这条抓住）', () => {
    // ⚠️ 这里断言的是**模块级单源**里那几条正则，不是另抄一份 ——
    // 评审实测：用例若持有自己的增强版副本，把守护里的 RECEIVER 退回 `\w+\.`
    // 之后用例照样全绿，灵敏度回退完全不可见，这条用例就成了安慰剂。
    // ⚠️ 断言方向是「**样本必须被某条 pattern 抓住**」，不是「遍历 pattern 逐条自测」。
    // 后者对**删除**零保护：删掉一条 pattern，循环就少跑一次，用例照样全绿
    // （红检实测踩到过）。样本清单独立于数组，删 pattern 必然让对应样本无人命中。
    const PAGE_MUST_BE_CAUGHT = [
      'const page = Math.max(1, filters?.page ?? 1)',
      `const page = Math.max(1, Number(searchParams.get('page')) || 1)`,
      `const page = Number(searchParams.get('page'))`,
      'const currentPage = Number(filters.page) || 1',
    ]
    for (const sample of PAGE_MUST_BE_CAUGHT) {
      expect(PAGE_ANTIPATTERNS.some(([re]) => re.test(sample)), `无人命中: ${sample}`).toBe(true)
    }
    const OFFSET_MUST_BE_CAUGHT = [
      'const offset = (page - 1) * pageSize',
      'const offset = page * pageSize - pageSize',
    ]
    for (const sample of OFFSET_MUST_BE_CAUGHT) {
      expect(OFFSET_ANTIPATTERNS.some(([re]) => re.test(sample)), `无人命中: ${sample}`).toBe(true)
    }
    // 每条 pattern 自带的 mustHit 也要各自成立（防某条被改成永不命中的死正则）
    for (const [re, label, mustHit] of PAGE_ANTIPATTERNS) {
      expect(re.test(mustHit), `${label} 应命中自己的样本: ${mustHit}`).toBe(true)
    }
    // 反向：正常写法不得命中（防把守护放宽成「什么都报」）
    const CLEAN = [
      'const { page, pageSize, offset } = resolvePaging({ page: filters.page, pageSize: filters.pageSize, defaultPageSize: 20 })',
      `const currentPage = normalizePage(get('page', '1'))`,
      'const quantity = Math.max(1, Number(item.quantity) || 1)',
      'page: params.page ? Number(params.page) : undefined',
    ]
    for (const clean of CLEAN) {
      for (const [re, label] of PAGE_ANTIPATTERNS) {
        expect(re.test(clean), `${label} 不该命中: ${clean}`).toBe(false)
      }
    }
  })

  it('全仓不得再出现不取整的页码写法', () => {
    // 正则来自模块级 PAGE_ANTIPATTERNS 单源（与灵敏度用例同一份）。
    // 只认「页码」语义：`.page` 字段与 `get('page', …)` URL 取值；
    // 数量夹取（`Math.max(1, Number(item.quantity) || 1)`）不在此列。
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of collectSources(join(SRC, root))) {
        const code = stripComments(readFileSync(file, 'utf8'), file)
        for (const [re, label] of PAGE_ANTIPATTERNS) {
          if (re.test(code)) offenders.push(`${file} (${label})`)
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
        const code = stripComments(readFileSync(file, 'utf8'), file)
        // 覆盖两种等价写法（来自 OFFSET_ANTIPATTERNS 单源）。
        // ⚠️ 这条守护**挡的是「顺手改回去」，挡不住蓄意等价改写** —— 字面量扫描的
        // 固有局限，任何算术恒等式都能绕过（`--page * size`、`page * size - size * 1` …）。
        // 真正的兜底是 `resolvePaging` 的出口契约用例，这条只是让回退有摩擦。
        if (OFFSET_ANTIPATTERNS.some(([re]) => re.test(code))) offenders.push(file)
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
      const code = stripComments(readFileSync(file, 'utf8'), file)
      if (!/\.offset\(/.test(code)) continue
      // 导出走 keyset / 专用 helper，不经 resolvePaging
      if (/resolveExport(Keyset|Offset)Page|nonNegativeOffset/.test(code) && !/resolvePaging/.test(code)) continue
      // ⚠️ 只查「文件里出现过 resolvePaging」是**存在性**，不是「这个 .offset() 用的是它给的值」。
      // 一个 import 了 resolvePaging 却在别处手算 offset 的文件能同时骗过本条与上一条
      // （评审给的反例：`const offset = page * pageSize - pageSize`）。
      // 上一条已补上该等价式，但字面量守护无法穷尽 —— 这里如实记下局限，
      // 不假装它是完备的。
      if (!/resolvePaging/.test(code)) missing.push(file)
    }
    expect(missing, `用了 .offset() 却没走 resolvePaging:\n${missing.join('\n')}`).toEqual([])
  })

  it('所有从 URL 读页码的组件都走 normalizePage，一个不漏', () => {
    // 不写死数字，改成「读 page 的地方 == 走 normalizePage 的地方」的**等式**：
    // 第一版守护写死 20，恰好漏掉了 products / stores / coupons / legacy-orders 四处
    // ——它们的写法是 `Number(get("page","1"))`（连 Math.max 都没有），
    // 计数型断言对「本来就没数到」的遗漏零保护，等式型才抓得住。
    // 配对方式：对每个 `get('page'` 匹配点，往前跳空白看是不是紧跟在 `normalizePage(`
    // 后面。⚠️ **不要用字符偏移相减**（第一版是 `+14±2`）——
    // `normalizePage(\n  get("page", "1")\n)` 这种合法换行会让偏移超差，
    // 于是守护既误报「未归一」又漏配对。往前跳空白再比字面量对格式免疫。
    const unguarded: string[] = []
    let total = 0
    for (const file of collectSources(join(SRC, 'app'))) {
      const code = stripComments(readFileSync(file, 'utf8'), file)
      for (const m of code.matchAll(/get\(\s*['"]page['"]/g)) {
        total++
        if (!wrappedByNormalizePage(code, m.index!)) {
          const line = code.slice(0, m.index).split('\n').length
          unguarded.push(`${file}:${line}`)
        }
      }
    }
    expect(unguarded, `未走归一的页码读取点:\n${unguarded.join('\n')}`).toEqual([])
    // 下界防「守护自己被掏空」：若哪天 collectSources 或正则改坏导致一个都扫不到，
    // `unguarded` 会是空数组而恒绿 —— 这行让那种失效可见。
    expect(total).toBeGreaterThanOrEqual(24)
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
