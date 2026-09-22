/**
 * 「所属组织 ⇄ 所属门店」双向联动在**两个页面上都接了线**的守护。
 *
 * `org-ancestry-form.test.ts` 测的是 `applyOrgNodeSelection` / `applyStoreSelection` 这两个
 * 「旧表单 + 用户选择 → 新表单补丁」的纯函数。把页面里的调用整个删掉，那些测试**照样全绿**，
 * 而两个方向的联动会一起回归，用户重新撞服务端的归属自洽拒绝（codex 谱系第 5/6 轮）。
 *
 * ⚠️ 上一版守的是「算出一个值」的 helper，codex 第 6 轮给了两种绕过：
 * `if (next !== undefined) void next`（算了不用）、或保留 `findAncestorStoreNodeId(...)`
 * 却删掉 `handleChange("orgNodeId", ...)`（只改一半）。现在两个方向都改成返回**整份补丁**、
 * 页面只做一次 spread —— 断言「调用结果被展开进 setForm」就同时覆盖了「算了」和「用了」，
 * 上面那两种绕过都会变红。真正的联动口径也已进单测，不再只靠这里的正则。
 *
 * ⚠️ 已知上限：断言的是**源码里有这个 spread 写法**，不是运行时真的改了状态 ——
 * 把 `setForm` 换成一个空实现、或让 `onChange` 永远挂不上去，这里依然全绿。
 * 换一种等价写法（先存成变量再 `{...prev, ...patch}`）也会漏。
 * 这是辅助红检，不是完整保证；要提高保障等级应上 Playwright 交互用例，而不是继续加正则
 * （同一取舍在 `lib/inventory/business.test.ts` 的威胁模型里写过）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const PAGES = {
  详情页: 'src/app/(main)/(organization)/employees/[id]/_components/employee-detail-page.tsx',
  新建页: 'src/app/(main)/(organization)/employees/create/_components/employee-create-page.tsx',
} as const

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

describe.each(Object.entries(PAGES))('%s — 归属双向联动已接线（#259）', (_label, path) => {
  it.each([
    ['改组织 → 跟改门店', 'applyOrgNodeSelection'],
    ['改门店 → 跟改组织', 'applyStoreSelection'],
  ])('%s：调用结果被展开进 setForm', (_direction, fn) => {
    const src = source(path)
    /**
     * 断言「`...fn(...)` 出现在一个对象字面量展开里」——
     * 只调不用（`void applyStoreSelection(...)`）或把结果丢给临时变量都不满足。
     * 换行写法也能匹配（`[\s\S]` 跨行），但缩进风格变了仍可能漏，见文件头的已知上限。
     */
    const spread = new RegExp(`\\.\\.\\.\\s*${fn}\\(`)
    expect(src, `${fn} 的结果必须合并进表单状态，只调不用等于没联动`).toMatch(spread)
  })

  /**
   * 「改门店 → 跟改组织」是生产两条脏数据的直接成因：同市场内改门店、没动「所属组织」，
   * 于是 store 指向新店而 org_node 还指着旧店。收紧校验后同一操作会被服务端直接拒。
   */
  it('两个 Select 的 onChange 各自只做一次 spread，不再手工逐字段 set', () => {
    const src = source(path)
    expect(src, '归属联动的口径应全部在 apply* 里，页面不该再出现零散的 orgNodeId 赋值')
      .not.toMatch(/handle(Form)?Change\(\s*["'`]orgNodeId["'`]/)
  })
})
