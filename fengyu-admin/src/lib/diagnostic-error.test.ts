import { describe, expect, it } from 'vitest'
import { diagnosticErrorDetail } from './diagnostic-error'

describe('diagnosticErrorDetail', () => {
  it.each([
    ['HEALTH_SIGNATURE_INVALID: invalid', '健康检查签名不一致'],
    ['HEALTH_SECRET_MISSING: missing', '健康检查密钥未配置'],
    ['未知的 action: system.health', '尚未部署 system.health'],
    ['FunctionName parameter could not be found. FUNCTION_NOT_FOUND', '当前腾讯云账号无权访问'],
    ['ANALYST_UNAUTHORIZED: 401', 'JWT_SECRET'],
    ['timeout', '检查超时'],
  ])('将 %s 映射为脱敏说明', (message, expected) => {
    expect(diagnosticErrorDetail(new Error(message))).toContain(expected)
  })

  it('未知错误使用调用方提供的安全兜底，不回显原始消息', () => {
    expect(diagnosticErrorDetail(new Error('secret path /root/private'), '仅校验网关可达性。'))
      .toBe('仅校验网关可达性。')
  })
})
