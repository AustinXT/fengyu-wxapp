const DEFAULT_SLOW_QUERY_MS = 500

function slowQueryThreshold(): number {
  const configured = Number(process.env.ANALYST_SLOW_QUERY_MS)
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SLOW_QUERY_MS
}

export function logAnalystDataLoad(event: {
  metric: "repurchase" | "penetration" | "new-customer-funnel"
  query: string
  scopeKey: string
  durationMs: number
  rows?: number
}): void {
  if (event.durationMs < slowQueryThreshold()) return
  console.warn("[analyst:slow-data-load]", JSON.stringify(event))
}

