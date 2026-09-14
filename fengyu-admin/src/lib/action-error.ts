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
  // PG / JS 引擎原文。这类「中文字段名 + 上游原始 message」的拼装在仓内真实存在
  // （如 lakala-onboarding.ts:1130），中文包装会让结构规则放行，只能按句式认。
  'syntax error at or near',
  'duplicate key value',
  'violates unique constraint',
  'violates foreign key constraint',
  'relation does not exist',
  'column does not exist',
  'cannot read properties of',
  'is not a function',
  'is not defined',
] as const


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
 * 调 `revalidatePath`）几乎都打了这个码，所以后缀必须一起认。
 * 我们自己补的业务 digest 不带 `__NEXT_ERROR_CODE`，不会被加后缀。
 *
 * 后缀不限于 `E+数字`：Next 里还有 `__NEXT_ERROR_CODE = 'TurbopackInternalError'` 这种
 * 直接赋值的标识符形态（漂移守护扫出来的，不是猜的），所以按「@ + 标识符」认。
 */
const NEXT_AUTO_DIGEST_RE = /^\d{1,10}(?:@[A-Za-z][\w-]*)?$/

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
 * 不在本文件留副本（增删白名单会自动跟着走）；拼进正则前做转义，免得将来白名单里
 * 出现正则元字符时静默改变匹配语义。
 */
const LEVEL1_PREFIX_RE = new RegExp(
  `^(?:${ERROR_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):\\s*`,
)

/**
 * 二级子标签串，形如 `REFERENCE_EXISTS: ` / `OVERPAY:123.45: ` /
 * `OVERPAY_ITEM:SI-8801:NOT_FOUND: `（标签后可挂若干段无空格载荷，以「冒号+空白」收尾）。
 *
 * 根 CLAUDE.md 约定子标签「仅供日志归类，不计入白名单」→ 展示侧一律剥掉。
 * 收尾必须是「冒号 + 空白」或**行尾**（行尾那支用于把 `REFERENCE_EXISTS:` 这种无正文的
 * 裸子标签整段剥干净后判空回退）：`OVERPAY:123.45:` 中间那个冒号后面紧跟数字，不能被当成结束，
 * 否则会剥成「123.45: 本次回款金额超过订单欠款」，比不剥还难看。
 *
 * 首段允许是**纯数字**：`INSUFFICIENT_BALANCE:${余额}: 顾客储值卡余额不足…`（orders.ts:3496，
 * `confirmOfflinePayment` 直抛、无服务端预解析，客户端真能看到）与 `NO_CARD` 是同族写法。
 *
 * **只在一级前缀真的被剥掉之后才尝试**：二级子标签按定义就只存在于一级前缀之后。
 * **字母型**标签要求 ≥5 字符：仓内真实子标签最短的是 `NO_CARD` / `OVERPAY`（7 字符），
 * 而 `ID:` / `SKU:` / `URL:` 这类业务语义标签都 ≤3 —— 用长度把两者分开，
 * 免得 `NOT_FOUND: SKU: S-001 不存在` 被剥成「S-001 不存在」丢掉上下文。
 * **数字载荷段不受这条长度限制**（`INSUFFICIENT_BALANCE:0: …` 里的 `0` 是金额位）。
 */
const TAG_RUN_SOURCE = String.raw`(?:[A-Z][A-Z0-9_]{4,}|\d+(?:\.\d+)?)(?::[^\s:]+)*`
const LEVEL2_SUBTAG_RE = new RegExp(`^${TAG_RUN_SOURCE}:(?:\\s+|$)`)

/**
 * 中日韩**表意文字/假名**。业务文案必含，技术串必不含 —— 这是本模块做结构判定的地基。
 *
 * 刻意**不含**全角标点（U+3000-303F 的「：」「（」等、U+FF00-FFEF 的全角形式）：
 * 那些只是标点，不构成「这是人话」的证据。否则
 * `PARSE_FAILED: Unexpected token <（position 0）` 只因带一对全角括号就被放行。
 */
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/

/**
 * 即便整句包着中文也必须挡掉的技术痕迹。
 *
 * 「含中文」只是「可能是人话」的**必要条件**，不是充分条件：拉卡拉进件失败会生成
 * `INVALID_STATE: 营业执照：Lakala https://…/file/upload failed with 500`（lakala-onboarding.ts:470
 * → actions/lakala-onboarding.ts:1130），中文包装 + 接口地址 + HTTP 状态一起端给用户；
 * 备份失败的 `open EACCES /srv/backups/db.dump` 同理。
 */
/**
 * ⚠️ 这组规则**只作用在剥完业务前缀之后的正文**上：一级前缀本身
 * （`INVALID_STATE` 等）与二级子标签就是 SCREAMING_SNAKE 形态，
 * 在整串上跑会把每一条业务错误都杀掉。
 */
const TECH_ARTIFACT_RES: readonly RegExp[] = [
  /\bhttps?:\/\/\S/i, // 接口地址
  /(?:^|[\s（(:：])\/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/, // Unix 绝对路径
  /(?:^|[\s（(:：])[A-Za-z]:\\[^\s]/, // Windows 绝对路径
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/, // IPv4（可带端口）
  /\[[0-9a-fA-F:]{2,}\]:\d{2,5}/, // IPv6:端口
  // 主机名:端口 —— 要求含点**且首段以字母开头**。只要求含点的话，
  // 「稀释比例 1.5:30 不合法」「工时 0.5:15 记录异常」这类小数写法会被误杀。
  /\b[A-Za-z][\w-]*(?:\.[A-Za-z0-9][\w-]*)+:\d{2,5}\b/,
  // 环境变量名 / 内部常量这类 SCREAMING_SNAKE token（必须含下划线，
  // 免得误杀 SKU、OEM 这类单词型业务缩写）。真实来源：
  // `actions/lakala-onboarding.ts:1492` 的「缺少电子合同回调地址：LAKALA_ECONTRACT_CALLBACK_URL」
  // 尾巴允许挂小写单位（`LAKALA_TIMEOUT_30000ms`）；整体 ≥6 字符。
  // **前后不能紧贴中日韩、也不能被中式括号裹着**：商品名是无格式限制的 text 且会被直接
  // 拼进错误文案 —— `ABC_DEF款精华液`（`business.ts:1535`）与 `商品「ABC_DEF」每单最多…`
  // （`orders.ts:194` 的 `purchaseLimitExceededMessage`、`pickup-records.ts:272` 等）都不是配置名。
  // 括号单独列而不并进 `CJK_RE`：后者刻意排除全角标点（否则 `（position 0）` 会被放行），
  // 且 `地址：LAKALA_ECONTRACT_CALLBACK_URL` 的全角冒号必须仍然算「被隔开」。
  new RegExp(
    `(?<![\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\u300C\u300D\u300E\u300F\uFF08\uFF09\u3010\u3011\u300A\u300B\u3008\u3009\u3014\u3015])\\b(?=[A-Z][A-Z0-9_]{5,}[a-z]*\\b)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+[a-z]*\\b(?![\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\u300C\u300D\u300E\u300F\uFF08\uFF09\u3010\u3011\u300A\u300B\u3008\u3009\u3014\u3015])`,
    'u',
  ),
  // 单标签主机:端口（`postgres:5433` / `redis:6379`）。要求小写字母开头 + 主机名 ≥5 字符：
  // 前者避开「稀释比例 1.5:30」这类小数，后者避开「门店 sku:10086 已停用」这类短业务标签
  /\b[a-z][a-z0-9-]{4,}:\d{2,5}\b/,
  // 裸 IPv6（无端口无方括号）。要求出现 `::`，免得把 `09:00:00` 这类时间写法当地址
  /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4})*::[0-9a-f]{0,4}(?::[0-9a-f]{0,4})*\b/i,
  // URI scheme（`file:///srv/…`、`postgres://…`、`redis://…`）
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  // 句中出现的内建异常名（`操作失败：TypeError: Cannot read …`），不只句首。
  // 冒号后空格可选：`String(err)` 几乎都带空格，但 `Error:boom` 这种拼法也要认
  // 类名前缀可有可无：裸 `Error:boom` / `Exception:boom` 也要认
  /\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception):\s?/,
]

/**
 * 内网主机名 / 域名（**不带端口**的那一半攻击面）。
 *
 * 只认两类，避开真实业务写法：
 * - 三段以上且不是纯数字尾巴：`merchant.lakala.com` ✅，而版本号 `v1.2.3` 的尾段全是数字 → 放行
 * - 二段但后缀是内网惯用域：`postgres.internal` / `db-primary.local` ✅，
 *   而 `报表 report.xlsx 生成失败` 的 `.xlsx` 不在名单里 → 放行
 */
const INTERNAL_TLD_RE = /\.(?:internal|local|svc|lan|intranet|corp)$/i
const DOMAIN_LIKE_RE = /\b[A-Za-z][\w-]*(?:\.[A-Za-z0-9][\w-]*)+\b/g

function hasHostname(text: string): boolean {
  for (const m of text.matchAll(DOMAIN_LIKE_RE)) {
    const token = m[0]
    if (INTERNAL_TLD_RE.test(token)) return true
    const parts = token.split('.')
    // 三段以上，且不是「首段 + 全数字尾段」的版本号形态
    if (parts.length >= 3 && !parts.slice(1).every((p) => /^\d+$/.test(p))) return true
  }
  return false
}

/**
 * 「整串一个空白都没有、且不含中日韩」= 它不是人话，是标识符/编号/技术串。
 *
 * 这一条替代了原先按形态逐类枚举的做法（纯数字、裸标签串、`OVERPAY:123`…），
 * 顺带覆盖了枚举不完的那些：`LAKALA_TIMEOUT_30000ms`、`SYSTEM_ERROR`、`12.50`、
 * `1956068727@E263`、`NEXT_HTTP_ERROR_FALLBACK;404`。
 *
 * 误伤面只有「整条文案就是一个 ASCII 标识符」，例如剥完只剩一个订单号 —— 那种串本来
 * 对用户也零信息量，回退到调用方 fallback 反而更有用。真业务文案必含中文或空格。
 */
function isProseless(value: string): boolean {
  return /^\S+$/.test(value) && !CJK_RE.test(value)
}

/**
 * Node errno 的成句形态：`connect ECONNREFUSED 10.0.0.5:443` / `getaddrinfo EAI_AGAIN api.x.com`。
 * 这类有空格、逃得过 `isProseless`，而 errno 种类枚举不完（`lakala-client.ts:222` 会把
 * `err.message` 原文拼进白名单前缀），所以按结构认而不是按清单认。
 */
const NODE_ERRNO_RE =
  /\b(?:connect|getaddrinfo|read|write|listen|bind|socket|open|unlink|mkdir|rmdir|rename|stat|lstat|scandir|readdir|access|chmod|chown|copyfile|spawn|watch)\s+E[A-Z_]{2,}\b/

/**
 * 原生异常被字符串化后的形态（`String(err)` / `new Error(String(e))`）。
 *
 * ⚠️ 真正的原生异常**不长这样**：`new TypeError('x').message` 就是 `'x'`，错误名只在
 * `err.name` 里。所以光靠这条正则拦不住 `(undefined).id` 抛出的
 * `Cannot read properties of undefined (reading 'id')` —— 那条走下面的 `NATIVE_ERROR_NAMES`。
 */
const JS_ERROR_NAME_RE = /^(?:[A-Z][A-Za-z]*)?(?:Error|Exception):\s/

/**
 * JS / Web 平台内建异常的 `name`。命中即说明这是**客户端自己的编程错误或平台错误**，
 * message 是给开发看控制台的（属性名、变量名、英文技术句），不能端给用户。
 *
 * 只列内建名：本项目自己的 `ApiError`（name 是 `'ApiError'`）、`PermissionError`、
 * `LegacyOrderError` 等都不在其中，业务文案照常透出。
 */
const NATIVE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'NotAllowedError',
  'SecurityError',
  'QuotaExceededError',
  'InvalidStateError',
  'NotFoundError',
])

/**
 * 兜底结构判定：把文案按「空白 + 中日韩」切开，看有没有哪一段长得像技术串。
 *
 * - 含 `_ \ " [ ]` 之一且长度 ≥4：带引号的库表/约束名、IPv6、内部标识符
 * - **斜杠要求出现 ≥2 次**：路径与 URI 天然多段（`file:///srv/backups/db.dump`）。
 *   只要求一个的话，`仅 PC/H5 端支持`、`支持 iOS/Android 双端` 这类产品文案会被误杀 ——
 *   仓内现在没有这种写法，但新文案一写就踩。
 *
 * 放行的真实业务写法：订单号 `FY-XSD-WX-2609140001`（只有连字符）、`0.1~1.0`、
 * `SKU: FY-001 库存不足`、`单价/数量 不匹配`、`PC/H5`、
 * `身份证仅支持 JPG/PNG 图片`（仓内真实文案）、`洗发水500ml/瓶`（商品名直接插进错误文案）。
 */
const PROSE_SEPARATOR_RE = /[\s\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]+/u
const TECHNICAL_RUN_CHARS_RE = /[\\"[\]]/

function hasTechnicalRun(text: string): boolean {
  return text.split(PROSE_SEPARATOR_RE).some((token) => {
    if (token.length < 4) return false
    if (TECHNICAL_RUN_CHARS_RE.test(token)) return true
    return (token.match(/\//g)?.length ?? 0) >= 2
  })
}

/** 纯判定：这一串是不是「技术串而非文案」。不负责翻译，翻译只在整串原值那一层做。 */
function isOpaque(value: string): boolean {
  if (NEXT_AUTO_DIGEST_RE.test(value)) return true
  if (NEXT_ROUTER_SIGNAL_RE.test(value)) return true
  if (OPAQUE_TOKEN_RE.test(value)) return true
  if (isProseless(value)) return true
  if (NODE_ERRNO_RE.test(value)) return true
  if (JS_ERROR_NAME_RE.test(value)) return true
  const lower = value.toLowerCase()
  if (UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))) return true
  // 兜底：本项目所有面向用户的文案都是中文（根 CLAUDE.md 的硬规定）。一整串一个中日韩
  // 字符都没有，它就不是给用户看的 —— 无论是 `Unexpected token < at position 0` 这种解析
  // 细节，还是没来得及枚举进上面规则的新形态。上面那些具体规则不因此冗余：它们负责
  // **带中文但仍不可读**的情形（如「连接失败 Failed to fetch」），也把已知病因写在了明处。
  return !CJK_RE.test(value)
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
  // 剥完再判一次：剥出来的残串可能又是编号 / 裸 token，也可能是「中文包着的技术痕迹」
  const text = stripBusinessPrefix(value).trim()
  if (!text || isOpaque(text)) return null
  if (TECH_ARTIFACT_RES.some((re) => re.test(text)) || hasTechnicalRun(text) || hasHostname(text))
    return null
  return text
}

export function actionErrorMessage(err: unknown, fallback: string): string {
  const safeFallback = typeof fallback === 'string' && fallback.trim() ? fallback : '操作失败'
  // 整体兜一层：本函数是全站 200+ 处 catch 的文案出口，自身一旦抛异常就会把原始错误
  // 顶掉、连 toast 都出不来。`err` 可能是 Proxy / throwing getter，读 digest 就可能抛。
  // 内建异常（TypeError / RangeError / DOMException…）的 message 是纯技术细节，
  // 而且**不带错误名**（`new TypeError('x').message === 'x'`），只能按 name 判。
  let fromDigest: string | null = null
  try {
    // digest 可能是 Proxy / throwing getter；单独兜一层，别把 message 通道一起拖下水
    fromDigest = readableMessage((err as { digest?: unknown } | null | undefined)?.digest)
  } catch {
    fromDigest = null
  }
  try {
    const fromMessage =
      err instanceof Error && !NATIVE_ERROR_NAMES.has(err.name) ? err.message : null
    return fromDigest ?? readableMessage(fromMessage) ?? safeFallback
  } catch {
    return safeFallback
  }
}
