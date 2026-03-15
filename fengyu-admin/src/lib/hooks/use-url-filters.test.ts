import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock next/navigation
const mockReplace = vi.fn()
let mockSearchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/orders',
}))

import { useUrlFilters } from './use-url-filters'

describe('useUrlFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
  })

  it('get 返回空字符串当参数不存在', () => {
    const { result } = renderHook(() => useUrlFilters())
    expect(result.current.get('status')).toBe('')
  })

  it('get 返回 URL 中的参数值', () => {
    mockSearchParams = new URLSearchParams('status=待支付&q=test')
    const { result } = renderHook(() => useUrlFilters())
    expect(result.current.get('status')).toBe('待支付')
    expect(result.current.get('q')).toBe('test')
  })

  it('get 支持默认值', () => {
    const { result } = renderHook(() => useUrlFilters())
    expect(result.current.get('page', '1')).toBe('1')
  })

  it('set 更新 URL 参数', () => {
    const { result } = renderHook(() => useUrlFilters())
    act(() => result.current.set('status', '待支付'))
    expect(mockReplace).toHaveBeenCalledWith('/orders?status=%E5%BE%85%E6%94%AF%E4%BB%98', { scroll: false })
  })

  it('set 空值删除参数', () => {
    mockSearchParams = new URLSearchParams('status=待支付')
    const { result } = renderHook(() => useUrlFilters())
    act(() => result.current.set('status', ''))
    expect(mockReplace).toHaveBeenCalledWith('/orders', { scroll: false })
  })

  it('setMany 批量更新参数', () => {
    const { result } = renderHook(() => useUrlFilters())
    act(() => result.current.setMany({ status: '已支付', type: '普通' }))
    expect(mockReplace).toHaveBeenCalled()
    const url = mockReplace.mock.calls[0][0] as string
    expect(url).toContain('status=')
    expect(url).toContain('type=')
  })

  it('setMany 空值删除、非空设置', () => {
    mockSearchParams = new URLSearchParams('status=待支付&type=普通')
    const { result } = renderHook(() => useUrlFilters())
    act(() => result.current.setMany({ status: '', type: '体验' }))
    const url = mockReplace.mock.calls[0][0] as string
    expect(url).not.toContain('status=')
    expect(url).toContain('type=')
  })
})
