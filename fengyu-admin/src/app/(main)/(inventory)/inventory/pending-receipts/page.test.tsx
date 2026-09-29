import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ApiError } from '@/lib/api-error'
const { list, options, getSession, guard, captured } = vi.hoisted(() => ({ list: vi.fn(), options: vi.fn(), getSession: vi.fn(), guard: vi.fn(), captured: { props: {} as Record<string, unknown> } }))
vi.mock('@/actions/inventory/pending-receipts', () => ({ listPendingReceipts: list, pendingReceiptOptions: options }))
vi.mock('@/lib/auth', () => ({ getSession }))
vi.mock('@/lib/page-capability', () => ({ requireAllUiPageCapabilities: guard }))
vi.mock('../_components/pending-receipts-page', () => ({ default: (props: Record<string, unknown>) => { captured.props = props; return <div /> } }))
import Page from './page'

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20 })
  options.mockResolvedValue({ markets: [], stores: [] })
  getSession.mockResolvedValue({ permissions: { actions: ['inventory:list'] } })
})

describe('#361 SSR', () => {
  it('页面守inventory:list，完整透传筛选，导出独立授权', async () => {
    render(await Page({ searchParams: Promise.resolve({ kind: 'market', market: 'M1', start: '2026-09-01' }) }))
    expect(guard).toHaveBeenCalledWith(expect.anything(), ['inventory:list'])
    expect(options).toHaveBeenCalledWith('market')
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'market', market: 'M1', start: '2026-09-01' }))
    expect(captured.props).toMatchObject({ kind: 'market', canExport: false, error: null })
  })
  it('重复参数不查询，非法日期显示可读提示，权限错误继续抛', async () => {
    render(await Page({ searchParams: Promise.resolve({ start: ['A', 'B'] }) }))
    expect(list).not.toHaveBeenCalled()
    expect(captured.props.error).toContain('查询参数重复')
    list.mockRejectedValueOnce(new ApiError('INVALID_PARAMS', '开始日期不是有效的日历日期'))
    render(await Page({ searchParams: Promise.resolve({ start: '2026-02-30' }) }))
    expect(captured.props.error).toBe('开始日期不是有效的日历日期')
    list.mockRejectedValueOnce(new ApiError('PERMISSION_DENIED', '无权查询'))
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('PERMISSION_DENIED')
  })
})
