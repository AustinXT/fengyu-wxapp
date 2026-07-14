

const UNREADABLE_FRAGMENTS = [
  
  'server components render',
  'omitted in production',
  
  
  'unexpected response',
  
  'failed to fetch',
  'network request failed',
  'networkerror',
  
  'econnreset',
  'esocket',
  'etimedout',
] as const

export function actionErrorMessage(err: unknown, fallback: string): string {
  const digest = (err as { digest?: unknown } | null)?.digest
  const raw =
    (typeof digest === "string" && digest) ||
    (err instanceof Error ? err.message : "")
  if (!raw) return fallback
  const lower = raw.toLowerCase()
  if (UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))) return fallback
  return raw.replace(/^[A-Z_]+:\s*/, "")
}
