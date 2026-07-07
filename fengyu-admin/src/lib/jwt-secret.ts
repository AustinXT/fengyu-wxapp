

const DEV_ONLY_FALLBACK = 'fengyu-admin-jwt-secret-dev-only'

function resolveSecret(): string {
  const secret = process.env.JWT_SECRET
  if (secret && secret.length > 0) {
    return secret
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[security] JWT_SECRET 未设置：生产环境必须配置 JWT_SECRET 环境变量，' +
        '禁止回退到弱默认密钥。请在部署环境中设置一个高强度随机值。',
    )
  }
  
  return DEV_ONLY_FALLBACK
}


export const JWT_SECRET = new TextEncoder().encode(resolveSecret())
