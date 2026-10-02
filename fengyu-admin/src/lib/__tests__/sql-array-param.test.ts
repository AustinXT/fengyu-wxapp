/**
 * # 全仓守护：往 `sql` 模板里传数组必须用 `sql.param()`
 *
 * ## 这不是风格问题，是**运行时必崩**
 *
 * drizzle 的 `sql` 模板遇到裸 JS 数组会把元素**摊开**成多个占位符，而不是绑成一个数组参数：
 *
 * ```ts
 * sql`... = ANY(${['总部', '市场']}::text[])`   // → ANY(($1, $2)::text[])  ← 语法错
 * sql`... = ANY(${['总部']}::text[])`           // → ANY(($1)::text[])      ← 22P02 malformed array literal
 * sql`... = ANY(${sql.param(['总部'])}::text[])` // → ANY($1::text[])        ← 正确
 * ```
 *
 * 上面三行是 2026-09-23 拿一次性 PG 实测出来的（issue #318 顺手发现）：
 * 前两种形态在**任何**数组长度下都炸，也就是说走到那条 SQL 的 action 100% 抛错。
 * 当时仓里有两处这样写：`role-definitions.hasConflictingScopeAssignment`
 * （每次编辑角色定义都会走到）与 `pickup-records` 的可用量查询。两处单测都把
 * `db.execute` 换成了替身 —— **SQL 本身从不被执行**，所以一直绿着。
 *
 * ## 为什么用源码守护
 *
 * 这类缺陷的特征是「单测永远发现不了，一上真库就 100% 崩」，而受影响的语句分散在十几个
 * action 里，逐个补真库冒烟成本太高。按形态一次钉住全仓，新写的也跑不掉。
 *
 * 白名单形态（不匹配本规则）：
 * - `sql.param(x)::text[]`      —— 正确写法
 * - `ARRAY[${sql.join(...)}]`   —— 把每个元素单独参数化再拼 ARRAY 构造器，也对
 *
 * ## ⚠️ 已知盲区（别把「这条绿」当成「数组参数一定对」）
 *
 * 1. **不带 cast 的形态抓不到**：`= ANY(${ids})` / `IN (${ids})` 同样会被摊开、同样必崩，
 *    但静态上与 `ANY(${子查询})` 这类合法写法不可分，所以不扫。
 * 2. **列引用会被误报**：`${table.column}::text[]` 是列而不是数组值，本规则会把它算成违规。
 *    当前全仓**零**这种写法（2026-09-23 实测），所以刻意**不**给 `a.b` 开白名单 ——
 *    开了会把 `${opts.ids}::text[]`（对象属性、真数组、真必崩）一起放过，
 *    那正是本守护要抓的形态。将来真出现列引用时，把它加进 `ALLOWED` 显式登记，
 *    比一条看不见的正则例外可审计得多。
 * 3. 注释与字符串字面量在扫描前被遮蔽（见下面 `maskNonCode`）；遮蔽用的是逐字符扫描而不是
 *    正则 —— 正则版会被字符串里的 `//` 或 `/*` 带偏，把同一行/后续几百行的真代码一起抹掉，
 *    那是**单向 fail-open**（GLM 第 4 轮 P3）。
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const SRC = resolve(__dirname, '..', '..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
}

/**
 * 匹配「`${` 里的表达式 + 紧跟 `::<type>[]`」，只放过 `${sql.*}`（`param` / `join` / `raw`）。
 * 不给 `a.b` 开例外 —— 理由见文件头「已知盲区」第 2 条。
 */
const BAD_ARRAY_PARAM = /\$\{\s*(?!sql\.)([^}]+?)\s*\}\s*::\s*\w+\[\]/g

/** 确实是列引用、不是数组值的位置，逐条登记（当前为空 —— 全仓没有这种写法） */
const ALLOWED: ReadonlySet<string> = new Set<string>()

/**
 * 把注释与字符串字面量替换成等长空格，保留换行（行号不变）。
 *
 * 逐字符扫描而不是正则：正则版遇到字符串里的 `//` 会把该行剩余部分（含真代码）一起抹掉，
 * 遇到 glob 里的 `/*` 会与几百行后的 `*​/` 配对，整段抹掉 —— 都是 fail-open 的假阴性。
 */
function maskNonCode(src: string): string {
  const out = src.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      blank(i, j); i = j; continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const j = end === -1 ? src.length : end + 2
      blank(i, j); i = j; continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      blank(i + 1, j); i = j + 1; continue
    }
    if (c === '`') {
      /**
       * 模板字符串**整段保留**，一个字符都不遮。
       *
       * 这里踩过一次：第一版只保留 `${...}` 里的表达式、遮掉静态片段 —— 可 `::text[]`
       * 恰恰长在静态片段里，遮完规则就什么都匹配不到了（而且是静默的）。
       * 保留整段的代价是：模板表达式内部的真 JS 注释不会被遮 —— 可以接受。
       */
      let j = i + 1
      let depth = 0
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue }
        if (depth > 0) { if (src[j] === '}') depth--; j++; continue }
        if (src[j] === '`') break
        j++
      }
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

describe('sql 模板里的数组参数必须走 sql.param()', () => {
  it('全仓没有裸数组 + ::T[] 的写法', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      // 遮蔽注释与字符串 —— 注释里写「`${数组}::text[]` 是错的」这种说明不该被当成违规
      const src = maskNonCode(readFileSync(file, 'utf8'))
      for (const m of src.matchAll(BAD_ARRAY_PARAM)) {
        const line = src.slice(0, m.index).split('\n').length
        const where = `${relative(SRC, file)}:${line}`
        if (ALLOWED.has(where)) continue
        offenders.push(`${where} → ${m[0].trim()}`)
      }
    }
    expect(
      offenders,
      '这些地方把裸数组塞进了 sql 模板 —— drizzle 会摊开成 ($1, $2)，真库上 100% 报错。'
      + '改成 sql.param(数组)，或用 ARRAY[${sql.join(...)}]',
    ).toEqual([])
  })

  /** 反向验证：正则确实能抓到坏形态，否则上面那条是重言式 */
  it('正则能抓到坏形态（否则上一条是空断言）', () => {
    const bad = "const q = sql`WHERE t.c = ANY(${scopeTypes}::text[])`"
    // 对象属性也是真数组、也必崩 —— 这条是刻意不给 `a.b` 开白名单换来的
    const badProp = "const q = sql`WHERE t.c = ANY(${opts.ids}::text[])`"
    const good1 = "const q = sql`WHERE t.c = ANY(${sql.param(scopeTypes)}::text[])`"
    const good2 = "const q = sql`WHERE t.c && ARRAY[${sql.join(parts, sql.raw(', '))}]::text[]`"

    expect([...bad.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(1)
    expect([...badProp.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(1)
    expect([...good1.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(0)
    expect([...good2.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(0)
  })

  /**
   * 遮蔽器的反向验证：字符串里的 `//` 与 `/*` 不能把后面的真代码一起抹掉
   * （正则版遮蔽正是这么 fail-open 的）。
   */
  it('字符串里的注释符不会遮蔽掉同行/后续的真代码', () => {
    const src = [
      "const glob = 'src/**/*.ts'",
      "const url = 'https://x//y'; const q = sql`ANY(${ids}::text[])`",
      'const kept = 1',
    ].join('\n')

    const masked = maskNonCode(src)

    expect([...masked.matchAll(BAD_ARRAY_PARAM)], '第 2 行的违规必须仍被看见').toHaveLength(1)
    expect(masked).toContain('const kept = 1')
  })

  it('注释与字符串里的坏形态被遮蔽掉（不误报）', () => {
    const src = [
      '// 反例：sql`ANY(${arr}::text[])`',
      '/* 反例：sql`ANY(${arr}::text[])` */',
      "const msg = 'ANY(${arr}::text[])'",
    ].join('\n')

    expect([...maskNonCode(src).matchAll(BAD_ARRAY_PARAM)]).toHaveLength(0)
  })
})
