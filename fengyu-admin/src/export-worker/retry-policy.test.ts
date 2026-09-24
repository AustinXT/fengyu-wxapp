import { describe, expect, it } from 'vitest'
import { shouldRetryExportFailure } from './retry-policy'

describe('shouldRetryExportFailure', () => {
  it('确定性错误（入参 / 状态）首次即失败，不白跑重试', () => {
    expect(shouldRetryExportFailure('INVALID_STATE', 1, 3)).toBe(false)
    expect(shouldRetryExportFailure('INVALID_PARAMS', 1, 3)).toBe(false)
  })

  it('瞬态 / 未分类错误按次数重试，用满即停', () => {
    expect(shouldRetryExportFailure('EXPORT_FAILED', 1, 3)).toBe(true)
    expect(shouldRetryExportFailure('CONFLICT', 2, 3)).toBe(true)
    expect(shouldRetryExportFailure('EXPORT_FAILED', 3, 3)).toBe(false)
  })
})
