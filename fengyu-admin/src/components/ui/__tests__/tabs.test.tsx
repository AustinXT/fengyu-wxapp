/**
 * Tabs 的 keepMounted 语义（#190）。
 *
 * 办理台把「填报表单」和「单据」并成两个 Tab 后，表单面板必须在切走时保留 DOM：
 * 默认的卸载语义会把受控表单的 useState 一起清掉，用户去看一眼单据回来就得重填。
 * 这里钉的是两件事：**状态真的还在**，以及**隐藏面板不会被读屏和 Tab 键捡到**。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs'

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      计数 {count}
    </button>
  )
}

function Fixture({ keepMounted }: { keepMounted: boolean }) {
  return (
    <Tabs defaultValue="form">
      <TabsList>
        <TabsTrigger value="form">填报表单</TabsTrigger>
        <TabsTrigger value="docs">单据</TabsTrigger>
      </TabsList>
      <TabsContent value="form" keepMounted={keepMounted}>
        <Counter />
      </TabsContent>
      <TabsContent value="docs">
        <p>单据列表</p>
      </TabsContent>
    </Tabs>
  )
}

describe('Tabs keepMounted', () => {
  it('keepMounted 时切走再切回，面板内的状态还在', () => {
    render(<Fixture keepMounted />)
    fireEvent.click(screen.getByRole('button', { name: /计数/ }))
    fireEvent.click(screen.getByRole('button', { name: /计数/ }))
    expect(screen.getByRole('button', { name: '计数 2' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '单据' }))
    fireEvent.click(screen.getByRole('tab', { name: '填报表单' }))

    expect(screen.getByRole('button', { name: '计数 2' })).toBeTruthy()
  })

  it('不加 keepMounted 时维持原有的卸载行为（状态重置）', () => {
    // 其余 9 个调用点都依赖这个默认行为，不能被顺手改掉。
    render(<Fixture keepMounted={false} />)
    fireEvent.click(screen.getByRole('button', { name: /计数/ }))
    expect(screen.getByRole('button', { name: '计数 1' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '单据' }))
    expect(screen.queryByRole('button', { name: /计数/ })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: '填报表单' }))
    expect(screen.getByRole('button', { name: '计数 0' })).toBeTruthy()
  })

  it('隐藏的 keepMounted 面板带 hidden，不进可访问性树也不占 Tab 键序', () => {
    // 只用 CSS 藏起来的话，读屏会把两个面板的内容连着念，键盘焦点也会掉进看不见的表单里。
    const { container } = render(<Fixture keepMounted />)
    fireEvent.click(screen.getByRole('tab', { name: '单据' }))

    const panels = container.querySelectorAll('[role="tabpanel"]')
    expect(panels.length).toBe(2)
    const hiddenPanel = container.querySelector<HTMLElement>('[role="tabpanel"][hidden]')
    expect(hiddenPanel).not.toBeNull()
    expect(hiddenPanel!.textContent).toContain('计数')
    // 可见的那个不能被误标
    expect(screen.getByText('单据列表').closest('[role="tabpanel"]')!.hasAttribute('hidden')).toBe(false)
  })

  it('隐藏靠内联 display:none —— 调用方传 flex 也压得住', () => {
    // ⚠️ 这里不能用 `hidden` 工具类：cn() 走 twMerge，`hidden` 与 `flex`/`grid`/`block`
    // 是同一个 display 冲突组，调用方的类会把它**合并掉**，而 `[hidden]` 的 UA 样式
    // 特异性低于任何作者类也压不住 —— 结果是两个面板同时显示，且很难联想到 twMerge。
    const { container } = render(
      <Tabs defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">填报表单</TabsTrigger>
          <TabsTrigger value="docs">单据</TabsTrigger>
        </TabsList>
        <TabsContent value="form" keepMounted className="flex gap-2">
          <span>表单内容</span>
        </TabsContent>
        <TabsContent value="docs">单据列表</TabsContent>
      </Tabs>,
    )
    fireEvent.click(screen.getByRole('tab', { name: '单据' }))

    const hiddenPanel = container.querySelector<HTMLElement>('[role="tabpanel"][hidden]')
    expect(hiddenPanel).not.toBeNull()
    expect(hiddenPanel!.style.display).toBe('none')
    // 激活时不留下 display:none 残留
    fireEvent.click(screen.getByRole('tab', { name: '填报表单' }))
    const activePanel = screen.getByText('表单内容').closest('[role="tabpanel"]') as HTMLElement
    expect(activePanel.style.display).toBe('')
    expect(activePanel.hasAttribute('hidden')).toBe(false)
  })
})
