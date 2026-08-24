import "server-only"

const DEV_ONLY_FALLBACK = "fengyu-admin-jwt-secret-dev-only"

function resolveSecret(): string {
  const secret = process.env.JWT_SECRET
  if (secret && secret.length > 0) {
    return secret
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production")
  }
  return DEV_ONLY_FALLBACK
}

export const JWT_SECRET = new TextEncoder().encode(resolveSecret())
