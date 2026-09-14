/**
 * 从 Server Action 抛出的错误中取可读文案（客户端组件用）。
 *
 * Next.js 生产构建会把 Server Action 抛出的 `error.message` 脱敏成通用的
 * 「An error occurred in the Server Components render…」文案，但**原样转发自定义
 * `digest`**。因此业务 action 把可读 message 同时写入 digest（见
 * legacy-orders.ts 的 LegacyOrderError、with-permission.ts 的 rethrowWithDigest），
 * 前端优先读 digest、剥业务前缀（`CONFLICT:` / `INVALID_PARAMS:` 等）后展示。
 *
 * 但 digest 这个字段是**两用**的：业务侧往里写可读文案，Next 自己也往里写
 * 「错误编号」与内部路由信号。所以取文案必须逐级判定「这一格到底是文案还是编号」，
 * 判不出来就往下一格走，全都判不出来才回退调用方给的业务兜底文案 —— 绝不
 * 把编号 / 技术 token / 英文脱敏话术直接端给用户（issue #133）。
 *
 * 取值顺序：`err.digest` → `err.message` → `fallback`。
 */

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
 * Next.js 自动生成的**错误编号**（不是文案）。
 *
 * `next/dist/server/app-render/create-error-handler.js` 在 `!err.digest` 时写入
 * `stringHash(err.message + err.stack).toString()`，而 `next/dist/compiled/string-hash`
 * 末位做 `>>> 0` → 恒为无符号 32 位整数的十进制串，1~10 位纯数字。
 * （形态漂移由同目录 `__tests__/action-error.test.ts` 的守护用例盯着。）
 *
 * issue #133 场景 B 就是它：员工购加载失败时 toast 里显示的 `1956068727`。它是
 * 给运维对服务端日志用的编号，对用户零信息量 → 判为不可读，继续往 message 找。
 */
const NEXT_AUTO_DIGEST_RE = /^\d{1,10}$/

/**
 * Next 内部路由/渲染信号，以 `NEXT_` 开头且可带分号载荷
 * （如 `NEXT_REDIRECT;replace;/login?expired=1;307;`、`NEXT_HTTP_ERROR_FALLBACK;404`）。
 * 这类 digest 一旦被调用方的 try/catch 捞到就会原样显示，必须挡掉。
 */
const NEXT_ROUTER_SIGNAL_RE = /^NEXT_[A-Z_]+/

/**
 * 裸技术 token：全大写、无冒号无空格的标识符。
 * 典型来源是 `lib/permissions.ts` 的 `PermissionError`（`digest = 'PERMISSION_DENIED'`，
 * 供 `(main)/error.tsx` 判 403 用），以及 Next 的 `DYNAMIC_SERVER_USAGE` 等。
 * 它是**信号量不是文案**，直接展示就是把内部枚举端给用户。
 */
const OPAQUE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * 裸 token 里有公认中文说法的，给说法；其余一律回退调用方 fallback。
 *
 * 只收录「确实会以裸 token 形态出现在 digest 里」的两个 —— 与
 * `(main)/error.tsx` 判 401/403 用的那两个常量同源。业务 action 抛的
 * `ApiError('PERMISSION_DENIED', '具体原因')` 走的是 rethrowWithDigest，
 * digest 是**带前缀的完整 message**，不会落到这里。
 */
const OPAQUE_TOKEN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PERMISSION_DENIED: '无权执行该操作',
  UNAUTHORIZED: '登录已过期，请重新登录',
})

/**
 * 业务前缀 / 二级子标签，如 `INVALID_STATE: ` 与 `INVALID_STATE: REFERENCE_EXISTS: `。
 * 子标签按根 CLAUDE.md 的约定「仅供日志归类，不计入白名单」，故展示侧两级都剥。
 * 注意用的是全大写+数字+下划线的形状，`TypeError: xxx` 这种驼峰不会被误剥。
 */
const ERROR_PREFIX_RE = /^[A-Z][A-Z0-9_]*:\s*/

/**
 * 判一格候选值是不是「能端给用户看的业务文案」。
 * 是 → 返回剥完前缀的文案；不是 → 返回 null，由调用方继续找下一格。
 */
function readableMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  // ① Next 自动生成的错误编号
  if (NEXT_AUTO_DIGEST_RE.test(value)) return null
  // ② Next 内部路由/渲染信号
  if (NEXT_ROUTER_SIGNAL_RE.test(value)) return null
  // ③ 裸技术 token：有公认说法的给说法，没有的回退
  if (OPAQUE_TOKEN_RE.test(value)) return OPAQUE_TOKEN_MESSAGES[value] ?? null
  // ④ 脱敏话术 / 网络层错误
  const lower = value.toLowerCase()
  if (UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))) return null
  // ⑤ 剥一级前缀 + 可选二级子标签；剥完为空说明整串都是前缀，同样不可读
  const text = value.replace(ERROR_PREFIX_RE, '').replace(ERROR_PREFIX_RE, '').trim()
  return text || null
}

export function actionErrorMessage(err: unknown, fallback: string): string {
  const digest = (err as { digest?: unknown } | null | undefined)?.digest
  return (
    readableMessage(digest) ??
    readableMessage(err instanceof Error ? err.message : null) ??
    fallback
  )
}
