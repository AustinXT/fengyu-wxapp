/**
 * 「所属组织 ⇄ 所属门店」双向联动在**两个页面上都接了线**的守护。
 *
 * `org-ancestry-form.test.ts` 那 13 条只测 `resolveStoreIdForOrgNode` /
 * `findAncestorStoreNodeId` 这两个纯函数 —— 把页面里的调用整个删掉，13 条**照样全绿**，
 * 而两个方向的联动会一起回归，用户重新撞服务端的归属自洽拒绝（codex 谱系第 5 轮 P2）。
 *
 * 为什么用结构守护而不是交互测试：这两个页面各要 mock 十几个 props（员工档案、组织树、
 * 门店列表、技能标签、权限角色…）才能挂载，而要守的只是「两个 Select 的 onChange 里
 * 确实调了那两个 helper」。成本与它能捕获的缺陷不成比例 —— 同一取舍已在
 * `employee-detail-toast.test.ts` 里写过。
 *
 * ⚠️ 已知上限：它只认「函数名出现在该文件里」，认不出「调了但把结果丢掉」。
 * 这是辅助红检，不是完整保证。要提高保障等级应上 Playwright 交互用例，而不是继续加正则。
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
  it('改组织 → 跟改门店：调了 resolveStoreIdForOrgNode 并消费其返回值', () => {
    const src = source(path)
    expect(src, '组织变更时必须重算门店，否则同市场内改到另一门店的子树会被服务端拒')
      .toMatch(/resolveStoreIdForOrgNode\(/)
    // 返回 undefined 表示「不动」，必须判过才 set —— 否则会把门店无条件清空
    expect(src).toMatch(/!==\s*undefined/)
  })

  it('改门店 → 跟改组织：调了 findAncestorStoreNodeId', () => {
    /**
     * 这个方向是生产两条脏数据的直接成因：同市场内改门店、没动「所属组织」，
     * 于是 store 指向新店而 org_node 还指着旧店。收紧校验后同一操作会被直接拒掉。
     */
    expect(source(path), '门店变更时必须重算组织节点（#259 的联动，缺了合法操作会被拒）')
      .toMatch(/findAncestorStoreNodeId\(/)
  })
})
