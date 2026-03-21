import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUnsavedChanges } from './use-unsaved-changes'

describe('useUnsavedChanges', () => {
  let addSpy: ReturnType<typeof vi.spyOn>
  let removeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    addSpy = vi.spyOn(window, 'addEventListener')
    removeSpy = vi.spyOn(window, 'removeEventListener')
  })

  afterEach(() => {
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('isDirty=false 时不注册 beforeunload', () => {
    renderHook(() => useUnsavedChanges(false))
    const beforeunloadCalls = addSpy.mock.calls.filter(([event]: [string, ...unknown[]]) => event === 'beforeunload')
    expect(beforeunloadCalls).toHaveLength(0)
  })

  it('isDirty=true 时注册 beforeunload', () => {
    renderHook(() => useUnsavedChanges(true))
    const beforeunloadCalls = addSpy.mock.calls.filter(([event]: [string, ...unknown[]]) => event === 'beforeunload')
    expect(beforeunloadCalls).toHaveLength(1)
  })

  it('isDirty 从 true 变 false 时移除 beforeunload', () => {
    const { rerender } = renderHook(
      ({ dirty }) => useUnsavedChanges(dirty),
      { initialProps: { dirty: true } }
    )
    // 先注册
    expect(addSpy.mock.calls.filter(([e]: [string, ...unknown[]]) => e === 'beforeunload')).toHaveLength(1)

    // 变为 false → cleanup 移除
    rerender({ dirty: false })
    const removeCalls = removeSpy.mock.calls.filter(([e]: [string, ...unknown[]]) => e === 'beforeunload')
    expect(removeCalls).toHaveLength(1)
  })

  it('handler 调用 e.preventDefault()', () => {
    renderHook(() => useUnsavedChanges(true))
    const handler = addSpy.mock.calls.find(([e]: [string, ...unknown[]]) => e === 'beforeunload')?.[1] as EventListener
    expect(handler).toBeDefined()

    const event = new Event('beforeunload', { cancelable: true })
    const preventSpy = vi.spyOn(event, 'preventDefault')
    handler(event)
    expect(preventSpy).toHaveBeenCalled()
  })

  it('unmount 时清理 listener', () => {
    const { unmount } = renderHook(() => useUnsavedChanges(true))
    unmount()
    const removeCalls = removeSpy.mock.calls.filter(([e]: [string, ...unknown[]]) => e === 'beforeunload')
    expect(removeCalls).toHaveLength(1)
  })
})
