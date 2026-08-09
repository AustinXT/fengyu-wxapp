import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const limit = vi.fn()
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const updateWhere = vi.fn()
  const updateSet = vi.fn(() => ({ where: updateWhere }))
  return {
    getSession: vi.fn(),
    deleteByCloudPaths: vi.fn(),
    getTempFileUrl: vi.fn(),
    limit,
    where,
    from,
    select: vi.fn(() => ({ from })),
    updateWhere,
    updateSet,
    update: vi.fn(() => ({ set: updateSet })),
    eq: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
  }
})

vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }))
vi.mock('@/lib/cloudbase', () => ({
  deleteByCloudPaths: mocks.deleteByCloudPaths,
  getTempFileUrl: mocks.getTempFileUrl,
}))
vi.mock('@/db', () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
  },
}))
vi.mock('@db/export-job', () => ({
  adminExportJobs: {
    id: 'id',
    status: 'status',
    fileCloudPath: 'fileCloudPath',
    fileName: 'fileName',
    expiresAt: 'expiresAt',
    requestedByEmployeeId: 'requestedByEmployeeId',
    updatedAt: 'updatedAt',
  },
}))
vi.mock('drizzle-orm', () => ({ and: mocks.and, eq: mocks.eq }))

import { GET } from './route'

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/exports/[id]/download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ employeeId: 'EMP-1' })
    mocks.deleteByCloudPaths.mockResolvedValue(undefined)
  })

  it('rejects unauthenticated requests before reading the job', async () => {
    mocks.getSession.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost/api/exports/1/download'), context('1'))

    expect(response.status).toBe(401)
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('does not reveal a job outside the current submitter scope', async () => {
    mocks.limit.mockResolvedValue([])

    const response = await GET(new Request('http://localhost/api/exports/1/download'), context('1'))

    expect(response.status).toBe(404)
    expect(mocks.eq).toHaveBeenCalledWith('requestedByEmployeeId', 'EMP-1')
  })

  it('deletes an expired file before marking its task expired', async () => {
    mocks.limit.mockResolvedValue([{
      id: 8,
      status: 'ready',
      fileCloudPath: 'cloud://expired.xlsx',
      fileName: 'expired.xlsx',
      expiresAt: new Date(Date.now() - 1_000),
    }])

    const response = await GET(new Request('http://localhost/api/exports/8/download'), context('8'))

    expect(response.status).toBe(410)
    expect(mocks.deleteByCloudPaths).toHaveBeenCalledWith(['cloud://expired.xlsx'])
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'expired',
      fileCloudPath: null,
    }))
  })

  it('redirects the submitter to a short-lived CloudBase URL for a ready file', async () => {
    mocks.limit.mockResolvedValue([{
      id: 9,
      status: 'ready',
      fileCloudPath: 'cloud://ready.xlsx',
      fileName: '订单.xlsx',
      expiresAt: new Date(Date.now() + 60_000),
    }])
    mocks.getTempFileUrl.mockResolvedValue('https://download.example/ready.xlsx')

    const response = await GET(new Request('http://localhost/api/exports/9/download'), context('9'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://download.example/ready.xlsx')
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent('订单.xlsx'))
  })
})
