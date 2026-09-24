import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, selectLimit, updateWhere } = vi.hoisted(() => ({
  execute: vi.fn(),
  selectLimit: vi.fn(),
  updateWhere: vi.fn(),
}))

vi.mock('@/db', () => ({
  db: {
    execute,
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
  },
}))

import { POST } from './route'

const originalOrgId = process.env.LAKALA_ORG_CODE

describe('电子合同回调', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LAKALA_ORG_CODE = '10001'
    execute.mockResolvedValue([])
    updateWhere.mockResolvedValue({ count: 1 })
  })

  afterEach(() => {
    if (originalOrgId === undefined) delete process.env.LAKALA_ORG_CODE
    else process.env.LAKALA_ORG_CODE = originalOrgId
  })

  it('机构号不匹配时拒绝且不执行运行时 DDL', async () => {
    const response = await POST(new Request('http://localhost/api/lakala/e-contract/callback', {
      method: 'POST',
      body: JSON.stringify({ orderNo: 'EC-1', orgId: 'wrong', ecStatus: 'COMPLETED' }),
    }))
    expect(response.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
  })

  it('按交接格式更新已完成合同', async () => {
    selectLimit.mockResolvedValue([{
      id: 'onb-1',
      eContractNo: null,
      eContractSignedAt: null,
    }])
    const response = await POST(new Request('http://localhost/api/lakala/e-contract/callback', {
      method: 'POST',
      body: JSON.stringify({ orderNo: 'EC-1', orgId: '10001', ecStatus: 'COMPLETED', ecNo: 'C-1' }),
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: '000000', msg: 'SUCCESS' })
    expect(execute).toHaveBeenCalledTimes(6)
    expect(updateWhere).toHaveBeenCalledOnce()
  })
})
