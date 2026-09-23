/**
 * #249 的核心闭环在 UI 上的唯一落点守护。
 *
 * 「调店不自动搬迁角色」这个决定成立的前提是**操作者当场看到需要跟进的事** ——
 * 服务端把它放进 `result.message`，分三种：旧店在 scope 内且查到绑定 → 附角色清单；
 * 旧店超出 scope → 刻意不查不披露角色名、只给降级复核提示；确实无绑定 → 普通成功文案。
 * 页面原先写的是硬编码 `toast.success("保存成功")`，把这三种**全部**吞掉
 * （codex 谱系第 3 轮指出，它当时的判断是「本 PR 的核心闭环在真实 UI 中仍未成立」，
 * 属合并阻断项）。
 *
 * 为什么用结构守护而不是渲染测试：这个页面要 mock 十几个 props（员工档案、组织树、
 * 门店列表、技能标签、权限角色…）才能跑起来，而要守的只是「成功分支的 toast 用
 * result.message」这一件事。渲染测试的成本与它能捕获的缺陷不成比例。
 * ⚠️ 已知上限：它只认 `toast.success(result.message)` 这一种写法 ——
 * 换成中间变量或包一层函数都会漏。这是辅助红检，不是完整保证。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const PAGE = 'src/app/(main)/(organization)/employees/[id]/_components/employee-detail-page.tsx'

function pageSource(): string {
  return readFileSync(resolve(process.cwd(), PAGE), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

describe('员工详情页保存成功的 toast（#249 的 UI 闭环）', () => {
  it('成功分支必须显示 result.message，不能硬编码文案', () => {
    const src = pageSource()
    // updateEmployee 的成功分支
    expect(src, 'updateEmployee 的成功提示必须用服务端 message —— 它可能带着旧店角色清单，'
      + '也可能是不披露角色名的权限复核提示（见文件头三种分支）')
      .toMatch(/toast\.success\(result\.message\)/)
    /**
     * 同一文件里还有 handleSaveRoles 的 `toast.success('权限角色已更新')` ——
     * 那是另一条独立流程（保存角色），硬编码合理，不在本守护范围内。
     * 所以这里断言的是「不存在硬编码的保存成功类文案」，而不是「没有任何字面量 toast」。
     */
    expect(src, '不得把 updateEmployee 的成功提示写成硬编码「保存成功」')
      .not.toMatch(/toast\.success\(\s*["'`]保存成功["'`]\s*\)/)
  })

  it('失败分支仍显示服务端 message（归属校验的拒绝文案靠它送达）', () => {
    // #228/#259 的拒绝文案（无权调至该门店 / 所选组织节点属于另一个门店…）都走这条
    expect(pageSource()).toMatch(/toast\.error\(result\.message\)/)
  })
})
