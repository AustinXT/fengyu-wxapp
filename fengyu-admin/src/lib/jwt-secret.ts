/**
 * JWT 签名密钥（单源）
 *
 * 安全要求：生产环境（NODE_ENV === 'production'）必须显式设置 JWT_SECRET，
 * 否则 fail-fast 抛错，绝不回退到公开的弱默认值（防止 token 伪造）。
 * 开发 / 测试环境允许回退到固定 dev-only 默认值，保证本地 dev server 与 vitest 可跑。
 *
 * 该模块必须保持 edge runtime 兼容：仅依赖 Web API（TextEncoder / process.env），
 * 不得引入任何 node-only API（fs/crypto/Buffer 等），因为 middleware 在 edge 运行。
 */

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
  // 仅开发 / 测试环境
  return DEV_ONLY_FALLBACK
}

/** 编码后的 JWT 密钥，供 jose 的 SignJWT / jwtVerify 使用 */
export const JWT_SECRET = new TextEncoder().encode(resolveSecret())
