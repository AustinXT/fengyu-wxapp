import { ERROR_PREFIXES } from './api-error'

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
 * **剥完前缀后要再判一次**：`INSUFFICIENT_BALANCE:NO_CARD` 剥完剩 `NO_CARD`、
 * `INVALID_STATE: ANALYST_UNAUTHORIZED: 401` 剥完剩 `401`，都是同一类技术串，
 * 只在剥之前判会让它们从后门溜出去。
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
  // 以下为 #133 评审补入：Node errno 会被 `INVALID_STATE: LAKALA_REQUEST_FAILED: ${err.message}`
  // 这类写法拼进白名单前缀 message（lakala-client.ts:222），剥完子标签后只剩
  // `connect ECONNREFUSED 10.0.0.5:443` —— 内网 IP + 端口，看着还挺像人话，必须挡掉。
  'econnrefused',
  'enotfound',
  'ehostunreach',
  'eai_again',
  'epipe',
  // Safari 的 fetch 失败文案（Chrome 走上面的 failed to fetch）
  'the network connection was lost',
  'connection appears to be offline',
] as const

/**
 * JS 内建错误名前缀（`TypeError: …` / `AbortError: …` / `RangeError: …`）。
 *
 * 客户端组件自己抛的异常**不经 Next 脱敏**——`await action()` 之后的解构、日期转换、
 * router.push 抛错时，`err.message` 会原样到用户面前。这类是给开发看控制台的，不是文案。
 * 注意形状要求「驼峰 + Error + 冒号 + 空白」：业务里的 `throw new Error('顾客不存在')`
 * message 是 `顾客不存在`（不带 `Error: ` 头），不会被误伤。
 */
const JS_ERROR_NAME_RE = /^[A-Z][A-Za-z]*Error:\s/

/**
 * Next.js 自动生成的**错误编号**（不是文案）。
 *
 * `next/dist/server/app-render/create-error-handler.js` 在 `!err.digest` 时写入
 * `stringHash(err.message + err.stack).toString()`，而 `next/dist/compiled/string-hash`
 * 末位做 `>>> 0` → 恒为无符号 32 位整数的十进制串，1~10 位纯数字。
 * （形态漂移由 `__tests__/action-error.test.ts` 的守护用例盯着。）
 *
 * issue #133 场景 B 就是它：员工购加载失败时 toast 里显示的 `1956068727`。它是
 * 给运维对服务端日志用的编号，对用户零信息量 → 判为不可读，继续往 message 找。
 *
 * 同一条规则也挡住剥完子标签后剩下的裸数字（`ANALYST_UNAUTHORIZED: 401` → `401`）。
 *
 * ⚠️ 送到客户端的不是 `err.digest` 本身，而是
 * `createDigestWithErrorCode(thrownValue, err.digest)`（`next/dist/lib/error-telemetry-utils.js`）：
 * 抛出物带 `__NEXT_ERROR_CODE` 时会拼成 `1956068727@E263`。Next 内部错误（如 render phase 里
 * 调 `revalidatePath`）几乎都打了这个码，所以 `@E###` 后缀必须一起认。
 * 我们自己补的业务 digest 不带 `__NEXT_ERROR_CODE`，不会被加后缀。
 */
const NEXT_AUTO_DIGEST_RE = /^\d{1,10}(?:@E\d+)?$/

/**
 * Next 内部路由/渲染信号，以 `NEXT_` 开头且可带分号载荷
 * （如 `NEXT_REDIRECT;replace;/login?expired=1;307;`、`NEXT_HTTP_ERROR_FALLBACK;404`）。
 * 这类 digest 一旦被调用方的 try/catch 捞到就会原样显示，必须挡掉。
 */
const NEXT_ROUTER_SIGNAL_RE = /^NEXT_[A-Z_]+/

/**
 * 裸技术 token：全大写、无冒号无空格的标识符。
 * 典型来源是 `lib/permissions.ts` 的 `PermissionError`（`digest = 'PERMISSION_DENIED'`，
 * 供 `(main)/error.tsx` 判 403 用）、Next 的 `DYNAMIC_SERVER_USAGE`，以及剥完一级前缀后
 * 剩下的裸子标签（`INSUFFICIENT_BALANCE:NO_CARD` → `NO_CARD`）。
 * 它是**信号量不是文案**，直接展示就是把内部枚举端给用户。
 */
const OPAQUE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * 裸 token 里有公认中文说法的，给说法；其余一律回退调用方 fallback。
 *
 * 只收录「确实会以裸 token 形态出现在 digest 里」的两个 —— 与
 * `(main)/error.tsx` 判 401/403 用的那两个常量同源（测试里有守护用例断言两处不漂移）。
 * 业务 action 抛的 `ApiError('PERMISSION_DENIED', '具体原因')` 走的是 rethrowWithDigest，
 * digest 是**带前缀的完整 message**，不会落到这里。
 *
 * ⚠️ 这张表**只对整串原值生效**，不对剥完前缀的残串生效：`CONFLICT: PERMISSION_DENIED`
 * 的语义是「并发冲突」不是「无权限」，把残串翻译成「无权执行该操作」会张冠李戴。
 */
const OPAQUE_TOKEN_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PERMISSION_DENIED: '无权执行该操作',
  UNAUTHORIZED: '登录已过期，请重新登录',
})

/**
 * 一级业务前缀，形如 `INVALID_STATE: ` / `INSUFFICIENT_BALANCE:`（冒号后空格可有可无，
 * `orders.ts:700` 的 `INSUFFICIENT_BALANCE:NO_CARD: …` 就没空格）。
 *
 * 用 9 项白名单精确匹配而非形状匹配：`ID: 123` / `URL: https://…` / `SKU: FY-001 库存不足`
 * 这类业务语义标签不是错误前缀，剥掉会丢上下文。白名单从 `api-error.ts` 取单源，
 * 不在本文件留副本（增删白名单会自动跟着走）。
 */
const LEVEL1_PREFIX_RE = new RegExp(`^(?:${ERROR_PREFIXES.join('|')}):\\s*`)

/**
 * 二级子标签串，形如 `REFERENCE_EXISTS: ` / `OVERPAY:123.45: ` /
 * `OVERPAY_ITEM:SI-8801:NOT_FOUND: `（标签后可挂若干段无空格载荷，以「冒号+空白」收尾）。
 *
 * 根 CLAUDE.md 约定子标签「仅供日志归类，不计入白名单」→ 展示侧一律剥掉。
 * 收尾必须是 `:\s+`：`OVERPAY:123.45:` 中间那个冒号后面紧跟数字，不能被当成结束，
 * 否则会剥成「123.45: 本次回款金额超过订单欠款」，比不剥还难看。
 *
 * **只在一级前缀真的被剥掉之后才尝试**：二级子标签按定义就只存在于一级前缀之后。
 * 标签本身要求 ≥5 字符：仓内真实子标签最短的是 `NO_CARD` / `OVERPAY`（7 字符），
 * 而 `ID:` / `SKU:` / `URL:` 这类业务语义标签都 ≤3 —— 用长度把两者分开，
 * 免得 `NOT_FOUND: SKU: S-001 不存在` 被剥成「S-001 不存在」丢掉上下文。
 */
const LEVEL2_SUBTAG_RE = /^[A-Z][A-Z0-9_]{4,}(?::[^\s:]+)*:(?:\s+|$)/

/** 纯判定：这一串是不是「技术串而非文案」。不负责翻译，翻译只在整串原值那一层做。 */
function isOpaque(value: string): boolean {
  if (NEXT_AUTO_DIGEST_RE.test(value)) return true
  if (NEXT_ROUTER_SIGNAL_RE.test(value)) return true
  if (OPAQUE_TOKEN_RE.test(value)) return true
  if (JS_ERROR_NAME_RE.test(value)) return true
  const lower = value.toLowerCase()
  return UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))
}

function stripBusinessPrefix(value: string): string {
  const level1 = value.match(LEVEL1_PREFIX_RE)
  if (!level1) return value
  return value.slice(level1[0].length).replace(LEVEL2_SUBTAG_RE, '')
}

/**
 * 判一格候选值是不是「能端给用户看的业务文案」。
 * 是 → 返回剥完前缀的文案；不是 → 返回 null，由调用方继续找下一格。
 */
function readableMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  // 整串就是个有公认说法的裸 token（PermissionError 的 digest）→ 给说法
  // 用 hasOwn 而非下标直取：`constructor` / `toString` 这类原型键不能被当成映射命中
  if (OPAQUE_TOKEN_RE.test(value)) {
    return Object.hasOwn(OPAQUE_TOKEN_MESSAGES, value) ? OPAQUE_TOKEN_MESSAGES[value] : null
  }
  if (isOpaque(value)) return null
  // 剥完再判一次：剥出来的残串可能又是编号 / 裸 token
  const text = stripBusinessPrefix(value).trim()
  if (!text || isOpaque(text)) return null
  return text
}

export function actionErrorMessage(err: unknown, fallback: string): string {
  const safeFallback = typeof fallback === 'string' && fallback.trim() ? fallback : '操作失败'
  // 整体兜一层：本函数是全站 200+ 处 catch 的文案出口，自身一旦抛异常就会把原始错误
  // 顶掉、连 toast 都出不来。`err` 可能是 Proxy / throwing getter，读 digest 就可能抛。
  try {
    return (
      readableMessage((err as { digest?: unknown } | null | undefined)?.digest) ??
      readableMessage(err instanceof Error ? err.message : null) ??
      safeFallback
    )
  } catch {
    return safeFallback
  }
}
