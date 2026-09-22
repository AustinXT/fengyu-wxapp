/**
 * 两个员工页面都把归属字段**委托给** `EmployeeOwnershipFields` 的守护（#259）。
 *
 * 联动这件事现在分三层，各管一段：
 *   1. 口径 —— `applyOrgNodeSelection` / `applyStoreSelection` 纯函数，
 *      由 `lib/org-ancestry-form.test.ts` 逐分支钉住
 *   2. 接线 —— `EmployeeOwnershipFields` 真渲染 + 真触发两个 Select，
 *      由 `components/employee-ownership-fields.test.tsx` 断言另一字段的受控值
 *   3. 采用 —— 两个页面确实用了那个组件，而不是各自手搓一份，本文件负责
 *
 * 第 3 层仍是源码结构守护，但它要守的命题已经退化到极简：**页面里出现该组件**。
 * 前两版守护的是「算出的值有没有被用掉」这种运行时语义，codex 谱系连着两轮给出绕过
 * （`void applyX(...)`、只接一个方向、`{...patch, orgNodeId: prev.orgNodeId}` 把补丁覆盖回去），
 * 那类绕过现在会被第 2 层的交互测试当场打红 —— 不需要正则再去猜了。
 *
 * ⚠️ 已知上限：认不出「页面引了组件但渲染在永假分支里」。真要覆盖那种需要页面级渲染测试
 * （两页各要 mock 十几个 props）。这是辅助红检，不是完整保证。
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
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

describe.each(Object.entries(PAGES))('%s — 归属字段委托给共用组件（#259）', (_label, path) => {
  it('渲染 EmployeeOwnershipFields，并把回传的补丁合进表单', () => {
    const src = source(path)
    expect(src, '归属字段必须走共用组件 —— 手搓一份就绕过了它的交互测试')
      .toMatch(/<EmployeeOwnershipFields/)
    // 补丁必须被展开进 setForm，只调不用等于没联动
    expect(src).toMatch(/\.\.\.\s*patch/)
  })

  /**
   * 页面不该再自己碰这两个字段的联动 —— 那会造出第二份口径，
   * 而「只修一侧等于没修」在本 PR 里已经重复出现过（#228 的教训）。
   */
  it('页面不再自行计算归属联动', () => {
    const src = source(path)
    expect(src, '联动口径只应存在于 applyOrgNodeSelection / applyStoreSelection')
      .not.toMatch(/apply(OrgNode|Store)Selection\(/)
    expect(src, '页面不该再出现零散的 orgNodeId 赋值')
      .not.toMatch(/handle(Form)?Change\(\s*["'`]orgNodeId["'`]/)
  })
})
