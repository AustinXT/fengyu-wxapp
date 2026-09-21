/**
 * 「返回XX办理台」的点击行为（#190）。
 *
 * 甲方要的是字面意义的「返回到原来的页面」：办理台表单填了一半，单据号在新标签打开，
 * 返回后原标签必须原封不动 —— 所以优先 window.close()。但 window.close() 对
 * **非 script 打开**的标签在 Chrome/Edge 被静默忽略（不抛错、不报警），
 * 降级路径漏掉的话，那些浏览器里这个按钮点了什么都不会发生。这里钉的就是降级。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import { InventoryDocReturnLink } from './inventory-doc-return-link'

const HREF = '/inventory/operations/market?op=market-report&tab=docs'

function setOpener(value: unknown) {
  Object.defineProperty(window, 'opener', { value, writable: true, configurable: true })
}

function renderLink() {
  render(<InventoryDocReturnLink href={HREF} label="返回市场办理台" />)
  return screen.getByRole('link', { name: /返回市场办理台/ })
}

describe('InventoryDocReturnLink（#190 返回入口）', () => {
  let closeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockPush.mockClear()
    closeSpy = vi.fn()
    vi.stubGlobal('close', closeSpy)
    setOpener(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('href 始终指向办理台（可复制、可中键打开）', () => {
    expect(renderLink().getAttribute('href')).toBe(HREF)
  })

  it('有存活的 opener 时先关标签页，真正回到原来的页面', () => {
    const focus = vi.fn()
    setOpener({ closed: false, focus })
    const notPrevented = fireEvent.click(renderLink())

    expect(notPrevented).toBe(false)   // 拦下了默认导航
    expect(focus).toHaveBeenCalled()
    expect(closeSpy).toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('close() 被浏览器忽略时降级导航（页面还在就说明没关掉）', () => {
    setOpener({ closed: false, focus: vi.fn() })
    fireEvent.click(renderLink())
    expect(mockPush).not.toHaveBeenCalled()   // 先给浏览器一点时间真的关掉

    vi.advanceTimersByTime(200)
    expect(mockPush).toHaveBeenCalledWith(HREF)
  })

  it('opener 已被用户关掉时不试图 close，直接走链接默认导航', () => {
    setOpener({ closed: true, focus: vi.fn() })
    const notPrevented = fireEvent.click(renderLink())

    expect(closeSpy).not.toHaveBeenCalled()
    expect(notPrevented).toBe(true)   // 交还 <Link>，不自己 push（避免双重导航）
  })

  it('没有 opener（直接敲 URL / 从收藏进来）时同样走默认导航', () => {
    setOpener(null)
    const notPrevented = fireEvent.click(renderLink())

    expect(closeSpy).not.toHaveBeenCalled()
    expect(notPrevented).toBe(true)
  })

  it('Cmd / Ctrl / 中键点击交还浏览器原生行为', () => {
    setOpener({ closed: false, focus: vi.fn() })
    const link = renderLink()

    expect(fireEvent.click(link, { metaKey: true })).toBe(true)
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true)
    expect(fireEvent.click(link, { shiftKey: true })).toBe(true)
    expect(fireEvent.click(link, { button: 1 })).toBe(true)
    expect(closeSpy).not.toHaveBeenCalled()
  })
})
