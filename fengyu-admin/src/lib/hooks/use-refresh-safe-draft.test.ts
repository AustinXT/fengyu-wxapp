import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRefreshSafeDraft } from './use-refresh-safe-draft'

type Draft = { subjectName: string }

describe('useRefreshSafeDraft', () => {
  it('服务端刷新版本时保留未保存的 OCR 结果', () => {
    const { result, rerender } = renderHook(
      ({ identity, version, serverValue }: { identity: string; version: string; serverValue: Draft }) =>
        useRefreshSafeDraft({ identity, version, serverValue }),
      {
        initialProps: {
          identity: 'application-1',
          version: 'v1',
          serverValue: { subjectName: '' },
        },
      },
    )

    act(() => result.current.setDraft({ subjectName: 'OCR 识别结果' }))
    rerender({
      identity: 'application-1',
      version: 'v2',
      serverValue: { subjectName: '' },
    })

    expect(result.current.draft.subjectName).toBe('OCR 识别结果')
    expect(result.current.dirty).toBe(true)
  })

  it('草稿保存或切换申请后重新同步服务端数据', () => {
    const { result, rerender } = renderHook(
      ({ identity, version, serverValue }: { identity: string; version: string; serverValue: Draft }) =>
        useRefreshSafeDraft({ identity, version, serverValue }),
      {
        initialProps: {
          identity: 'application-1',
          version: 'v1',
          serverValue: { subjectName: '' },
        },
      },
    )

    act(() => result.current.setDraft({ subjectName: 'OCR 识别结果' }))
    act(() => result.current.markClean())
    rerender({
      identity: 'application-1',
      version: 'v2',
      serverValue: { subjectName: '已保存结果' },
    })
    expect(result.current.draft.subjectName).toBe('已保存结果')

    act(() => result.current.setDraft({ subjectName: '另一个未保存结果' }))
    rerender({
      identity: 'application-2',
      version: 'v1',
      serverValue: { subjectName: '新申请数据' },
    })
    expect(result.current.draft.subjectName).toBe('新申请数据')
    expect(result.current.dirty).toBe(false)
  })
})
