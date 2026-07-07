

const PG_CODE_RE = /^\d{5}$/

function walkCause(err: unknown, visit: (e: Record<string, unknown>) => string | undefined): string | undefined {
  let current: unknown = err
  
  for (let depth = 0; depth < 10 && current && typeof current === 'object'; depth++) {
    const hit = visit(current as Record<string, unknown>)
    if (hit !== undefined) return hit
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}


export function pgErrorCode(err: unknown): string | undefined {
  return walkCause(err, (e) => {
    const code = e.code
    return typeof code === 'string' && PG_CODE_RE.test(code) ? code : undefined
  })
}


export function pgErrorConstraint(err: unknown): string | undefined {
  return walkCause(err, (e) => {
    const c = e.constraint_name ?? e.constraint
    return typeof c === 'string' && c.length > 0 ? c : undefined
  })
}


export function pgErrorDetail(err: unknown): string | undefined {
  return walkCause(err, (e) => {
    const d = e.detail
    return typeof d === 'string' && d.length > 0 ? d : undefined
  })
}
