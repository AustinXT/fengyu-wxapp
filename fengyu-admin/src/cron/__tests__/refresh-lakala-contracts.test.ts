import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const { queryContract, downloadContract, savePrivateFile, bufferToFile } = vi.hoisted(() => ({
  queryContract: vi.fn(),
  downloadContract: vi.fn(),
  savePrivateFile: vi.fn(),
  bufferToFile: vi.fn(),
}))

vi.mock('@/lib/lakala-onboarding', () => ({
  lakalaQueryElectronicContract: queryContract,
  lakalaDownloadElectronicContract: downloadContract,
}))
vi.mock('@/lib/upload-file', () => ({
  savePrivateOnboardingFile: savePrivateFile,
  bufferToUploadFileLike: bufferToFile,
  getPrivateUploadRoot: vi.fn(() => '/private'),
}))

import { refreshLakalaContracts } from '../steps/refresh-lakala-contracts'

const originalEnabled = process.env.LAKALA_ONBOARDING_ENABLED

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 'onb_contract_1',
    eContractOrderNo: 'order-private',
    eContractApplyId: 'apply-private',
    eContractNo: null,
    status: 'FILES_READY',
    channelData: {},
    createdAt: new Date(),
    updatedAt: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  }
}

function makeDb(applications: unknown[], affectedRows = 1) {
  const limit = vi.fn().mockResolvedValue(applications)
  const orderBy = vi.fn(() => ({ limit }))
  const whereSelect = vi.fn(() => ({ orderBy }))
  const from = vi.fn(() => ({ where: whereSelect }))
  const select = vi.fn(() => ({ from }))

  const updateWhere = vi.fn().mockResolvedValue({ count: affectedRows })
  const updateSet = vi.fn(() => ({ where: updateWhere }))
  const update = vi.fn(() => ({ set: updateSet }))
  const insertValues = vi.fn().mockResolvedValue({ count: 1 })
  const insert = vi.fn(() => ({ values: insertValues }))
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ update, insert }))

  return {
    db: { select, update, insert, transaction },
    select,
    whereSelect,
    updateSet,
    updateWhere,
    insertValues,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.LAKALA_ONBOARDING_ENABLED
})

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.LAKALA_ONBOARDING_ENABLED
  else process.env.LAKALA_ONBOARDING_ENABLED = originalEnabled
})

describe('cron-worker STEP - refreshLakalaContracts', () => {
  it('功能关闭时不读取申请也不调用拉卡拉', async () => {
    const fixture = makeDb([])

    await expect(refreshLakalaContracts(fixture.db as never)).resolves.toMatchObject({
      eligible: 0,
      checked: 0,
      skippedDisabled: true,
    })
    expect(fixture.select).not.toHaveBeenCalled()
    expect(queryContract).not.toHaveBeenCalled()
  })

  it('候选查询在 LIMIT 前排除已完成、超时或已取消的合同轮询', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    const fixture = makeDb([])

    await refreshLakalaContracts(fixture.db as never)

    const condition = (fixture.whereSelect.mock.calls as unknown as Array<[SQL]>)[0]?.[0]
    const query = new PgDialect().sqlToQuery(condition!)
    expect(query.sql).toContain('electronicContractPolling')
    expect(query.sql).toContain("NOT IN ('DONE', 'TIMEOUT')")
    expect(query.params).toContain('CANCELLED')
  })

  it('已取消的申请不会查询或推进电子合同', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    const fixture = makeDb([application({ status: 'CANCELLED' })])

    const result = await refreshLakalaContracts(fixture.db as never)

    expect(result).toMatchObject({ eligible: 0, checked: 0, completed: 0, pending: 0, failed: 0 })
    expect(queryContract).not.toHaveBeenCalled()
    expect(downloadContract).not.toHaveBeenCalled()
    expect(fixture.updateSet).not.toHaveBeenCalled()
  })

  it('完成签约后只写脱敏调用摘要并私有保存 PDF', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    const fixture = makeDb([application()])
    queryContract.mockResolvedValue({
      success: true,
      status: 'COMPLETED',
      contractNo: 'contract-private',
      raw: { contract_no: 'contract-private' },
    })
    downloadContract.mockResolvedValue({
      success: true,
      contractNo: 'contract-private',
      pdfBytes: Buffer.from('%PDF-1.7\nprivate'),
      raw: { file_base64: 'private-base64' },
    })
    bufferToFile.mockReturnValue({ name: 'contract.pdf', type: 'application/pdf', size: 16, arrayBuffer: vi.fn() })
    savePrivateFile.mockResolvedValue({
      storageKey: 'lakala-onboarding/onb_contract_1/0123456789abcdef0123456789abcdef.pdf',
      originalFilename: 'contract.pdf',
      fileExt: 'pdf',
      fileSizeBytes: 16,
      contentType: 'application/pdf',
      contentSha256: 'a'.repeat(64),
    })

    const result = await refreshLakalaContracts(fixture.db as never)

    expect(result).toMatchObject({ eligible: 1, checked: 1, completed: 1, failed: 0 })
    expect(queryContract).toHaveBeenCalledWith({ orderNo: 'order-private', applyId: 'apply-private' })
    expect(downloadContract).toHaveBeenCalledWith({ orderNo: 'order-private', contractNo: 'contract-private' })
    expect(savePrivateFile).toHaveBeenCalledOnce()
    const logValues = fixture.insertValues.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => value.apiName)
    expect(JSON.stringify(logValues)).not.toContain('contract-private')
    expect(JSON.stringify(logValues)).not.toContain('private-base64')
    expect(logValues).toHaveLength(2)
  })

  it('超过 72 小时未完成时停止轮询且不调用供应商', async () => {
    process.env.LAKALA_ONBOARDING_ENABLED = 'true'
    const old = new Date(Date.now() - 73 * 60 * 60 * 1000)
    const fixture = makeDb([application({ createdAt: old, updatedAt: old })])

    const result = await refreshLakalaContracts(fixture.db as never)

    expect(result).toMatchObject({ eligible: 1, checked: 0, timedOut: 1 })
    expect(queryContract).not.toHaveBeenCalled()
    const timeoutPayload = (fixture.updateSet.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
    expect(timeoutPayload).toMatchObject({ lastErrorCode: 'ECONTRACT_POLL_TIMEOUT' })
  })
})
