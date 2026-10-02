const INTERNAL_ORIGIN = "https://fengyu-admin.internal"

export const RETURN_TO_PARAM = "returnTo"

export function buildCurrentPath(pathname: string, searchParams: URLSearchParams): string {
  const query = searchParams.toString()
  return `${pathname}${query ? `?${query}` : ""}`
}

export function resolveReturnTo(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return fallback
  }

  try {
    const target = new URL(raw, INTERNAL_ORIGIN)
    if (target.origin !== INTERNAL_ORIGIN) return fallback
    // 点段归一化会把 `/..//evil.com`、`/.//evil.com`、`/%2e%2e//evil.com` 折成 pathname `//evil.com`，
    // 原样返回就是协议相对 URL（浏览器解析到站外）。入口的 `//` 检查只看原始串，这里再挡一次。
    const path = `${target.pathname}${target.search}${target.hash}`
    if (path.startsWith("//")) return fallback
    return path
  } catch {
    return fallback
  }
}

export function withReturnTo(href: string, returnTo: string): string {
  const target = new URL(href, INTERNAL_ORIGIN)
  if (target.origin !== INTERNAL_ORIGIN) return href
  target.searchParams.set(RETURN_TO_PARAM, returnTo)
  return `${target.pathname}${target.search}${target.hash}`
}
