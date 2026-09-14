/**
 * 从 Server Action 抛出的错误中取可读文案（客户端组件用）。
 *
 * Next.js 生产构建会把 Server Action / RSC 抛出的 `error.message` 脱敏成通用的
 * 「An error occurred in the Server Components render…」文案，但**原样转发自定义
 * `digest`**。因此业务侧把可读 message 同时写入 digest（`with-permission.ts` 的
 * `rethrowWithDigest`、`legacy-orders.ts` 的 `LegacyOrderError`、`workfine-mssql.ts`），
 * 前端优先读 digest。
 *
 * 但 digest 这一格是**两用**的：业务侧往里写可读文案，Next 自己也往里写错误编号与
 * 内部信号。所以取值必须逐级判定「这一格到底是文案还是编号」，判不出来就往下一格走，
 * 全都判不出来才回退调用方给的业务兜底文案 —— 绝不把编号 / 内部枚举 / 英文脱敏话术
 * 端给用户（issue #133）。
 *
 * 取值顺序：`err.digest` → `err.message` → `fallback`。
 *
 * 两条通道的判定策略**刻意不对称**：
 * - **digest 走白名单（fail-closed）**：我们自己产出的 digest 全部带 9 项白名单前缀
 *   （唯一例外是 `PermissionError` 的裸 token，下面显式映射），所以「不带前缀 = 不是我们写的
 *   = 不给看」零损失，且对 Next 未来新增的 digest 形态天然免疫。黑名单做不到这点：
 *   Next 15.5 已经会把 digest 拼成 `1956068727@E394`（见 `lib/error-telemetry-utils.js`），
 *   只挡纯数字就会漏。
 * - **message 走黑名单（fail-open）**：它是 dev 构建与前端本地 throw（如 `lib/recharge-tier.ts`
 *   的 `matchTier`）的通道，改成白名单会把没带前缀的可读中文误降级成兜底文案。
 */
import { ERROR_PREFIXES, parseErrorPrefix, type ErrorPrefix } from '@/lib/api-error'

/**
 * Next.js / 网络层"不可读"文案片段（大小写不敏感匹配）。
 * 命中任一即视为脱敏/框架级异常，前端回退到调用方业务 fallback，
 * 不把英文技术文案或通用脱敏话术直接展示给用户。
 */
const UNREADABLE_FRAGMENTS = [
  // Next.js 生产构建对 Server Action error.message 的脱敏
  'server components render',
  'omitted in production',
  // Next.js 客户端：Server Action 的 POST 响应不是合法 RSC 响应时自抛的框架级错误
  // （社区讨论 vercel/next.js#87651）。WorkFine 远程 MSSQL 偶发慢/抖动触发的正是这类。
  'unexpected response',
  // fetch / 网络层错误
  'failed to fetch',
  'network request failed',
  'networkerror',
  // 底层网络错（通常在服务端日志，偶现于脱敏 message 时兜底）
  'econnreset',
  'esocket',
  'etimedout',
] as const

/**
 * 二级子标签，如 `INVALID_STATE: CARD_EXHAUSTED: 储值卡剩余次数为 0` 里的 `CARD_EXHAUSTED:`。
 * 按根 CLAUDE.md 的约定「子标签仅供日志归类，不计入白名单」，展示侧剥掉不给用户看。
 * 形状限定全大写+数字+下划线，`TypeError: …` 这类驼峰不会被误剥。
 */
const SUB_LABEL_RE = /^[A-Z][A-Z0-9_]*:\s*/

/**
 * 裸技术 token：全大写、无冒号无空格的标识符，是**信号量不是文案**。
 * 典型来源是 `lib/permissions.ts` 的 `PermissionError`（`digest = 'PERMISSION_DENIED'`，
 * 供 `(main)/error.tsx` 判 403 用），以及 Next 的 `DYNAMIC_SERVER_USAGE` 等。
 */
const OPAQUE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * 裸 token 里有公认中文说法的，给说法；其余一律回退调用方 fallback。
 *
 * 只收录「确实会以裸 token 形态出现在 digest 里」的两个 —— 与 `(main)/error.tsx`
 * 判 401/403 用的那两个常量同源。业务侧抛的 `ApiError('PERMISSION_DENIED', '具体原因')`
 * 走的是 `rethrowWithDigest`，digest 是**带前缀的完整 message**，不会落到这里。
 */
const OPAQUE_TOKEN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PERMISSION_DENIED: '无权执行该操作',
  UNAUTHORIZED: '登录已过期，请重新登录',
})

/**
 * 命中 9 项白名单前缀则返回剥完前缀（含可选二级子标签）的用户文案，否则 null。
 */
function businessMessage(value: string): string | null {
  const parsed = parseErrorPrefix(value)
  if (!parsed) return null
  const text = parsed.displayMessage.replace(SUB_LABEL_RE, '').trim()
  return text || null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** digest 通道：只认白名单前缀与两个裸 token，其余（Next 的错误编号/内部信号）一律判为不可读。 */
function readableFromDigest(digest: unknown): string | null {
  const value = nonEmptyString(digest)
  if (!value) return null
  return businessMessage(value) ?? OPAQUE_TOKEN_MESSAGES[value] ?? null
}

/** message 通道：先按业务前缀解析，再挡脱敏话术/网络错/裸 token，剩下的按可读文案放行。 */
function readableFromMessage(message: unknown): string | null {
  const value = nonEmptyString(message)
  if (!value) return null
  const business = businessMessage(value)
  if (business) return business
  const lower = value.toLowerCase()
  if (UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))) return null
  if (OPAQUE_TOKEN_RE.test(value)) return OPAQUE_TOKEN_MESSAGES[value] ?? null
  return value
}

export function actionErrorMessage(err: unknown, fallback: string): string {
  const digest = (err as { digest?: unknown } | null | undefined)?.digest
  return (
    readableFromDigest(digest) ??
    readableFromMessage(err instanceof Error ? err.message : null) ??
    fallback
  )
}

/**
 * 取业务错误类型（9 项白名单前缀之一），供前端按类型分支渲染，取不到返回 null。
 *
 * 生产构建下 `err.message` 已被脱敏，`msg.startsWith('PERMISSION_DENIED:')` 这类判断线上
 * 恒不成立；本函数从 digest 侧取，dev / prod 行为一致。
 */
export function actionErrorType(err: unknown): ErrorPrefix | null {
  const digest = nonEmptyString((err as { digest?: unknown } | null | undefined)?.digest)
  if (digest) {
    const parsed = parseErrorPrefix(digest)
    if (parsed) return parsed.prefix
    // `PermissionError` 的裸 token 形态：digest 整串就是类型本身
    if ((ERROR_PREFIXES as readonly string[]).includes(digest)) return digest as ErrorPrefix
  }
  const message = nonEmptyString(err instanceof Error ? err.message : null)
  return message ? (parseErrorPrefix(message)?.prefix ?? null) : null
}
