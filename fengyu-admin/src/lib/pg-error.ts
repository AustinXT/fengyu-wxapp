/**
 * PostgreSQL 错误码/约束名提取工具
 *
 * 背景：drizzle-orm 0.44+ 把驱动错误包进 `DrizzleQueryError`（message=`Failed query: ...`），
 * 真正的 pg 错误码落在 `err.cause.code`，而非 `err.code`。直接写 `err?.code === '23505'`
 * 在新版 drizzle 下永远不命中 → 友好提示退化成未捕获 500。
 *
 * 这两个函数沿 `err → err.cause → …` 链向下找，兼容「扁平错误（旧）」与「任意层包装（新）」。
 */

const PG_CODE_RE = /^\d{5}$/

function walkCause(err: unknown, visit: (e: Record<string, unknown>) => string | undefined): string | undefined {
  let current: unknown = err
  // 防御循环引用 / 超深链
  for (let depth = 0; depth < 10 && current && typeof current === 'object'; depth++) {
    const hit = visit(current as Record<string, unknown>)
    if (hit !== undefined) return hit
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** 取 pg 错误码（如 '23505'），沿 cause 链查找；找不到返回 undefined。 */
export function pgErrorCode(err: unknown): string | undefined {
  return walkCause(err, (e) => {
    const code = e.code
    return typeof code === 'string' && PG_CODE_RE.test(code) ? code : undefined
  })
}

/** 取违反的约束名（postgres.js 用 `constraint_name`，部分场景是 `constraint`），沿 cause 链查找。 */
export function pgErrorConstraint(err: unknown): string | undefined {
  return walkCause(err, (e) => {
    const c = e.constraint_name ?? e.constraint
    return typeof c === 'string' && c.length > 0 ? c : undefined
  })
}

/** 取错误详情（pg `detail` 字段，如 `Key (phone)=(...) already exists.`），沿 cause 链查找。 */
export function pgErrorDetail(err: unknown): string | undefined {
  return walkCause(err, (e) => {
    const d = e.detail
    return typeof d === 'string' && d.length > 0 ? d : undefined
  })
}

/**
 * 取 PL/pgSQL `RAISE EXCEPTION` 的原文（SQLSTATE `P0001`），沿 cause 链找 —— 外层 DrizzleQueryError 的
 * message 是 `Failed query: ...`，不是触发器给的原文。P0001 含字母，不匹配上面的纯数字 PG_CODE_RE，所以单独判。
 */
export function pgRaiseMessage(err: unknown): string | undefined {
  return walkCause(err, (e) => (
    e.code === 'P0001' && typeof e.message === 'string' ? e.message : undefined
  ))
}
