const DEFAULT_DETAIL = '请查看对应服务日志。'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

/**
 * 将底层探测异常映射成可向管理员展示的脱敏说明。
 * 不直接回显 SDK / 网络原始错误，避免泄露路径、账号或请求参数。
 */
export function diagnosticErrorDetail(error: unknown, fallback = DEFAULT_DETAIL): string {
  const message = errorMessage(error)

  if (/timeout|aborted|aborterror/i.test(message)) return '检查超时，请稍后重试。'
  if (/HEALTH_SIGNATURE_INVALID|health signature is invalid/i.test(message)) {
    return '健康检查签名不一致，请核对 Admin 与云函数的 CLIENT_SECRET。'
  }
  if (/HEALTH_SECRET_MISSING|CLIENT_SECRET is not configured/i.test(message)) {
    return '健康检查密钥未配置，请为目标服务补齐 CLIENT_SECRET。'
  }
  if (/未知的 action:\s*system\.health|缺少 orderNo|unknown action:\s*system\.health/i.test(message)) {
    return '目标云函数尚未部署 system.health，请更新云函数代码。'
  }
  if (/FUNCTION_NOT_FOUND|FunctionName parameter could not be found/i.test(message)) {
    return '目标云函数不存在或当前腾讯云账号无权访问，请核对环境与账号。'
  }
  if (/ANALYST_UNAUTHORIZED/i.test(message)) {
    return '数据分析系统健康检查签名不一致，请核对两端 JWT_SECRET。'
  }
  if (/ANALYST_UNAVAILABLE/i.test(message)) {
    return '数据分析系统当前不可达或业务主库检查失败。'
  }
  if (/gateway unavailable|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return fallback === DEFAULT_DETAIL ? '目标服务或网关当前不可达。' : fallback
  }

  return fallback
}
