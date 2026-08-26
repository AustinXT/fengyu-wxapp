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
    return `${target.pathname}${target.search}${target.hash}`
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
