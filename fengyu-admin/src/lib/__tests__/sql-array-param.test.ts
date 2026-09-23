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
 * - 列引用 `${table.column}::text[]` —— 那是列，不是数组值
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
 * 匹配「`${` 里是个裸标识符（或 `a.b` 之外的表达式）+ 紧跟 `::<type>[]`」。
 *
 * 刻意排除两种：
 * - `${sql.param(...)}` / `${sql.join(...)}` / `${sql.raw(...)}` —— 正确写法
 * - `${someTable.someColumn}` —— 列引用（drizzle 会渲染成列名，不是参数）
 */
const BAD_ARRAY_PARAM = /\$\{\s*(?!sql\.)(?![A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\})([^}]+?)\s*\}\s*::\s*\w+\[\]/g

describe('sql 模板里的数组参数必须走 sql.param()', () => {
  it('全仓没有裸数组 + ::T[] 的写法', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      // 先剥注释 —— 注释里写「`${数组}::text[]` 是错的」这种说明不该被当成违规
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
      for (const m of src.matchAll(BAD_ARRAY_PARAM)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${relative(SRC, file)}:${line} → ${m[0].trim()}`)
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
    const good1 = "const q = sql`WHERE t.c = ANY(${sql.param(scopeTypes)}::text[])`"
    const good2 = "const q = sql`WHERE t.c && ARRAY[${sql.join(parts, sql.raw(', '))}]::text[]`"
    const good3 = "const q = sql`WHERE ${staffWechatUsers.skills}::text[] IS NOT NULL`"

    expect([...bad.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(1)
    expect([...good1.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(0)
    expect([...good2.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(0)
    expect([...good3.matchAll(BAD_ARRAY_PARAM)]).toHaveLength(0)
  })
})
