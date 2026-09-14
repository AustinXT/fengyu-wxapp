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
 * 全都判不出来才回退调用方给的业务兜底文案 —— 绝不把编号 / 内部枚举 / 英文技术串
 * 端给用户（issue #133）。
 *
 * 取值顺序：`err.digest` → `err.message` → `fallback`。
 *
 * ## 两道闸门
 *
 * **闸门一 · 来源**：digest 只认带 9 项白名单前缀的串，外加 `PERMISSION_DENIED` /
 * `UNAUTHORIZED` 两个裸 token（`PermissionError` 专用）。这是 fail-closed —— 我们自己写的
 * digest 一定带前缀，所以「不带前缀 = 不是我们写的 = 不给看」零损失，且对 Next 未来新增的
 * digest 形态天然免疫（15.5 已出 `<数字>@E<码>` 变体，黑名单枚举不全）。
 * message 则是 fail-open：它是 dev 构建与前端本地 throw（如 `lib/recharge-tier.ts` 的
 * `matchTier`）的通道，要求带前缀会把可读中文误降级成兜底文案。
 *
 * **闸门二 · 内容**（`presentable`）：**前缀合法 ≠ 正文能给人看**。剥完前缀后还要过
 * 内容闸门——这是本模块最关键的一条，`INVALID_STATE: ANALYST_UNAUTHORIZED: 401`、
 * `INVALID_STATE: LAKALA_NOT_CONFIGURED`、`INVALID_STATE: 同步失败 connect ETIMEDOUT 10.0.0.1:1433`
 * 三者前缀都合法，正文却分别是 HTTP 码 / 内部枚举 / 内网地址。
 */
import { parseErrorPrefix, type ErrorPrefix } from '@/lib/api-error'

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
  // 底层网络错（与 lib/workfine-mssql.ts 的瞬态码表保持同一套）
  'econnreset',
  'econnrefused',
  'esocket',
  'etimedout',
  'epipe',
] as const

/**
 * 日志子标签：**含下划线**的全大写 token + 冒号，如
 * `INVALID_STATE: CARD_EXHAUSTED: 储值卡剩余次数为 0` 里的 `CARD_EXHAUSTED:`。
 * 按根 CLAUDE.md「子标签仅供日志归类，不计入白名单」，展示侧剥掉不给用户看。
 *
 * **形状要求「含下划线 或 长度 ≥6」**，而不是宽泛的 `[A-Z_]+:`：否则
 * `NOT_FOUND: ID: 123 的订单不存在`、`INVALID_PARAMS: SKU: 缺货`、`HTTP: 500` 这类
 * 「看着像标签、其实是正文」的串会被吃掉半句。仓内真实子标签要么含下划线
 * （`CARD_EXHAUSTED` / `OUT_OF_SCOPE` / `STATE_TRANSITION_BLOCKED` / `NO_CARD`…），
 * 要么是长描述性单词（`OVERPAY`，见 actions/orders.ts:7153）；正文里的缩写前缀则都很短。
 * 这是**外观启发式**不是契约，判错的代价上限是多显示/少显示一个标签，不构成泄漏
 * （安全性由下面的中文闸门与噪声表保证）。
 * 全角冒号一并认，防中文输入法写错一个冒号就把 token 漏给用户。
 */
const LOG_TAG_RE = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][A-Z0-9]{5,})\s*[:：]\s*/

/** 中日韩统一表意文字。本产品所有面向用户的文案都是中文，这是最稳的「给人看的」判据。 */
const CJK_RE = /[一-鿿]/

/** 展示长度上限：toast / alert / 内联红字都撑不住长文本，超出截断。 */
const MAX_DISPLAY_LENGTH = 120

/**
 * 裸 token → 中文说法。只收录**确实会以裸 token 形态出现在 digest 里**的两个：
 * `lib/permissions.ts` 的 `PermissionError`（`digest = 'PERMISSION_DENIED'`，
 * 供 `(main)/error.tsx` 判 403 用）与其 401 对应物。
 *
 * ⚠️ 与 `(main)/error.tsx:24,27` 的同名字面量是**同一套约定的两份硬编码**，改一处必改另一处。
 * 用 Map 而非对象字面量：对象查表会命中 `Object.prototype`，`digest='toString'` 会返回函数而非字符串。
 *
 * 业务侧抛的 `ApiError('PERMISSION_DENIED', '具体原因')` 走 `rethrowWithDigest`，
 * digest 是**带前缀的完整 message**，不会落到这里。
 */
const OPAQUE_TOKEN_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['PERMISSION_DENIED', '无权执行该操作'],
  ['UNAUTHORIZED', '登录已过期，请重新登录'],
])

/** 从 unknown 错误上取一格字段；非字符串或空串一律当没有。 */
function pick(err: unknown, key: 'digest' | 'message'): string | null {
  const value = (err as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string') return null
  return value.trim() || null
}

/** 噪声扫描上限：message 通道长度无上界，不能对整串做 toLowerCase + 子串扫描。 */
const NOISE_SCAN_LIMIT = 2000

/**
 * 内容闸门：把一段候选正文收敛成「能端给用户的话」，收敛不出来返回 null。
 *
 * 顺序有讲究：
 * 1. 取首行 —— 多行错误从第二行起通常是 SQL / 堆栈 / 文件路径
 * 2. 剥日志子标签
 * 3. **噪声判定在截断之前**做 —— 若先截断，「内网地址在第 50 字、ETIMEDOUT 在第 150 字」
 *    这种串会把地址露出去而噪声词检测不到（双谱系评审 round 1 指出）。对无上界输入
 *    设 NOISE_SCAN_LIMIT 扫描上限兜住开销
 * 4. 码点安全截断 —— `slice` 会切断 emoji 代理对
 * 5. **中文判定在「展示文本」上**做 —— 中文若只出现在截断点之后，露出去的仍是英文技术串
 */
function presentable(raw: string): string | null {
  const newline = raw.indexOf('\n')
  const line = (newline === -1 ? raw : raw.slice(0, newline)).replace(LOG_TAG_RE, '').trim()
  if (!line) return null

  const scanned = line.length > NOISE_SCAN_LIMIT ? line.slice(0, NOISE_SCAN_LIMIT) : line
  const lower = scanned.toLowerCase()
  if (UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))) return null

  const chars = Array.from(line)
  const truncated = chars.length > MAX_DISPLAY_LENGTH
  const display = truncated ? chars.slice(0, MAX_DISPLAY_LENGTH).join('') : line
  // 不含中文 ⇒ 错误编号 / 内部枚举 / HTTP 码 / 英文技术串，一律不给看
  if (!CJK_RE.test(display)) return null
  return truncated ? `${display}…` : display
}

/**
 * 取一格候选值里的用户文案，取不出返回 null。
 *
 * `failOpen` 就是上面说的两道来源口径：
 * - `false`（digest 通道）：必须带白名单前缀，或整串是那两个裸 token 之一
 * - `true`（message 通道）：不带前缀的可读中文也放行
 *
 * 两条通道都要过 `presentable` 内容闸门。
 */
function readable(value: string, failOpen: boolean): string | null {
  const parsed = parseErrorPrefix(value)
  if (parsed) return presentable(parsed.displayMessage)
  return OPAQUE_TOKEN_MESSAGES.get(value) ?? (failOpen ? presentable(value) : null)
}

/**
 * digest → message → fallback 三级取值。
 *
 * 本函数绝不能抛：它被 200+ 个 catch 块调用，digest/message 可能是抛异常的 getter 或 Proxy，
 * 一次逃逸就是整页白屏。
 */
function extract(err: unknown, fallback: string, failOpenMessage: boolean): string {
  try {
    const digest = pick(err, 'digest')
    const fromDigest = digest ? readable(digest, false) : null
    if (fromDigest) return fromDigest
    const message = pick(err, 'message')
    return (message ? readable(message, failOpenMessage) : null) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * 【客户端展示用】从 Server Action 抛出的错误里取用户文案。
 *
 * message 通道 fail-open：客户端 catch 里也会接到前端本地 throw（如 `lib/recharge-tier.ts`
 * 的 `matchTier`），那些 message 没有前缀但完全可读。
 */
export function actionErrorMessage(err: unknown, fallback: string): string {
  return extract(err, fallback, true)
}

/**
 * 【服务端返回值用】同上，但 message 通道也 fail-closed。
 *
 * Server Action 的**返回值**不经 Next 脱敏，`catch { return { message: err.message } }` 会把
 * 原始 PG 报错（约束名 / SQL 片段）原样送到前端 toast —— 这是 digest 之外的**第二条泄漏通道**，
 * 双谱系评审 round 1 两个谱系都指了出来。服务端 catch 到的错误没有「本地可读 throw」这一类，
 * 因此这里要求必须带 9 项白名单前缀，不带就一律用调用方的中文兜底文案。
 */
export function businessErrorMessage(err: unknown, fallback: string): string {
  return extract(err, fallback, false)
}

/**
 * 取业务错误类型（9 项白名单前缀之一），供前端按类型分支渲染，取不到返回 null。
 *
 * 生产构建下 `err.message` 已被脱敏，`msg.startsWith('PERMISSION_DENIED:')` 这类判断线上
 * 恒不成立；本函数从 digest 侧取，dev / prod 行为一致。`(main)/error.tsx` 判 401/403、
 * `employees/[id]` 与 `org` 的专属文案分支都走它。
 *
 * 注意与 `actionErrorMessage` 的可达面刻意保持一致：裸 token 只认
 * `OPAQUE_TOKEN_MESSAGES` 里那两个（= 实际会被产出的那两个），不放行其余 7 项前缀的裸形态。
 */
export function actionErrorType(err: unknown): ErrorPrefix | null {
  try {
    const digest = pick(err, 'digest')
    if (digest) {
      const parsed = parseErrorPrefix(digest)
      if (parsed) return parsed.prefix
      // `PermissionError` 的裸 token 形态：digest 整串就是类型本身
      if (OPAQUE_TOKEN_MESSAGES.has(digest)) return digest as ErrorPrefix
    }
    const message = pick(err, 'message')
    if (!message) return null
    const parsed = parseErrorPrefix(message)
    if (parsed) return parsed.prefix
    // 与 actionErrorMessage 的可达面对齐：message 整串是裸 token 时它会给出中文说法，
    // 这里也必须判得出类型，否则 error.tsx 会把该判 403 的渲染成 500（评审 round 1）
    return OPAQUE_TOKEN_MESSAGES.has(message) ? (message as ErrorPrefix) : null
  } catch {
    return null
  }
}
