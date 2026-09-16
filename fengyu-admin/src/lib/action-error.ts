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
 * message 则视通道而定：客户端展示 fail-open（前端本地 throw 如 `lib/recharge-tier.ts` 的
 * `matchTier` 没有前缀但完全可读），服务端返回值 fail-closed。
 *
 * **闸门二 · 内容**（`presentable`）：**前缀合法 ≠ 正文能给人看**。剥完前缀后还要过
 * 内容闸门——这是本模块最关键的一条，`INVALID_STATE: ANALYST_UNAUTHORIZED: 401`、
 * `INVALID_STATE: LAKALA_NOT_CONFIGURED`、`INVALID_STATE: 同步失败 connect ETIMEDOUT 10.0.0.1:1433`
 * 三者前缀都合法，正文却分别是 HTTP 码 / 内部枚举 / 内网地址。
 *
 * ## 本文件是两条分支各自实现一遍后的合并产物（2026-09-16 main→dev）
 *
 * issue #133 在 dev（PR #165，自走 10 轮评审）与 test/main（PR #170，双谱系 7 轮）上
 * **各被修了一遍**，两版能力互补、不是新旧关系：
 * - 来自 test/main 侧：`businessErrorMessage`（返回值通道）、`actionErrorType`、
 *   长度上限与码点安全截断、`Map` 形态的裸 token 表、`parseErrorPrefix` 单源前缀
 * - 来自 dev 侧：带载荷的二级子标签整段剥离、内网主机名 / 裸 IPv6 / Windows 路径 /
 *   URI scheme、Node errno 成句式、按 `err.name` 认 JS 内建异常、更宽的 CJK 判据、
 *   空 fallback 兜底
 * 两套测试文件（`action-error.test.ts` 与 `__tests__/action-error.test.ts`）一并保留，
 * 合起来才是本模块的完整规格；删掉任一套都会让对应那半边的防护无人看守。
 */
import { parseErrorPrefix, type ErrorPrefix } from '@/lib/api-error'

/**
 * Next.js / 网络层 / 上游原文里"不可读"的文案片段（大小写不敏感匹配）。
 * 命中任一即视为脱敏/框架级异常，回退到调用方业务 fallback。
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
  // 底层网络错（与 lib/workfine-mssql.ts 的瞬态码表保持同一套）。
  // `lakala-client.ts:222` 会把 `err.message` 原文拼进白名单前缀 message，
  // 剥完子标签后只剩 `connect ECONNREFUSED 10.0.0.5:443` —— 内网 IP + 端口，
  // 看着还挺像人话，必须挡掉。
  'econnreset',
  'esocket',
  'etimedout',
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
 *
 * issue #133 场景 B 就是它：员工购加载失败时 toast 里显示的 `1956068727`。它是
 * 给运维对服务端日志用的编号，对用户零信息量 → 判为不可读，继续往 message 找。
 * 同一条规则也挡住剥完子标签后剩下的裸数字（`ANALYST_UNAUTHORIZED: 401` → `401`）。
 *
 * ⚠️ 送到客户端的不是 `err.digest` 本身，而是
 * `createDigestWithErrorCode(thrownValue, err.digest)`（`next/dist/lib/error-telemetry-utils.js`）：
 * 抛出物带 `__NEXT_ERROR_CODE` 时会拼成 `1956068727@E263`。后缀不限于 `E+数字` ——
 * Next 里还有 `__NEXT_ERROR_CODE = 'TurbopackInternalError'` 这种标识符形态（漂移守护
 * 扫出来的，不是猜的），所以按「@ + 标识符」认，而不是只认 `@E\d+`。
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
 * 典型来源是 `lib/permissions.ts` 的 `PermissionError`（`digest = 'PERMISSION_DENIED'`）、
 * Next 的 `DYNAMIC_SERVER_USAGE`，以及剥完一级前缀后剩下的裸子标签
 * （`INSUFFICIENT_BALANCE:NO_CARD` → `NO_CARD`）。
 * 它是**信号量不是文案**，直接展示就是把内部枚举端给用户。
 */
const OPAQUE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * 二级子标签串，形如 `REFERENCE_EXISTS: ` / `OVERPAY:123.45: ` /
 * `OVERPAY_ITEM:SI-8801:NOT_FOUND: `（标签后可挂若干段无空格载荷，以「冒号+空白」收尾）。
 *
 * 根 CLAUDE.md 约定子标签「仅供日志归类，不计入白名单」→ 展示侧一律剥掉。
 * 收尾必须是「冒号 + 空白」或**行尾**（行尾那支用于把 `REFERENCE_EXISTS:` 这种无正文的
 * 裸子标签整段剥干净后判空回退）：`OVERPAY:123.45:` 中间那个冒号后面紧跟数字，不能被当成结束，
 * 否则会剥成「123.45: 本次回款金额超过订单欠款」，比不剥还难看。
 *
 * 首段允许是**纯数字**：`INSUFFICIENT_BALANCE:${余额}: 顾客储值卡余额不足…`（orders.ts
 * `confirmOfflinePayment` 直抛、无服务端预解析，客户端真能看到）与 `NO_CARD` 是同族写法。
 *
 * **只在一级前缀真的被剥掉之后才尝试**：二级子标签按定义就只存在于一级前缀之后。
 * **字母型**标签要求 ≥5 字符：仓内真实子标签最短的是 `NO_CARD` / `OVERPAY`（7 字符），
 * 而 `ID:` / `SKU:` / `URL:` 这类业务语义标签都 ≤3 —— 用长度把两者分开，
 * 免得 `NOT_FOUND: SKU: S-001 不存在` 被剥成「S-001 不存在」丢掉上下文。
 * **数字载荷段不受这条长度限制**（`INSUFFICIENT_BALANCE:0: …` 里的 `0` 是金额位）。
 *
 * 全角冒号一并认作收尾，防中文输入法写错一个冒号就把 token 漏给用户 —— 但它**不要求
 * 后面跟空白**：「冒号 + 空白」那条门槛是为了把终结冒号与 `OVERPAY:123.45:` 里的载荷
 * 冒号区分开，而载荷分隔符只会是半角；全角冒号后面按中文习惯本就不空格
 * （`PERMISSION_DENIED：无权执行该操作`）。
 */
const TAG_RUN_SOURCE = String.raw`(?:[A-Z][A-Z0-9_]{4,}|\d+(?:\.\d+)?)(?::[^\s:]+)*`
const LEVEL2_SUBTAG_RE = new RegExp(`^${TAG_RUN_SOURCE}(?::(?:\\s+|$)|：\\s*)`)

/**
 * 中日韩**表意文字/假名**。本模块的地基：一整串一个都没有，它就不是给用户看的文案。
 * （反过来不成立 —— 中文包着技术痕迹的串照样要挡，那由下面的 `TECH_ARTIFACT_RES` 负责。）
 *
 * 刻意**不含**全角标点（U+3000-303F 的「：」「（」等、U+FF00-FFEF 的全角形式）：
 * 那些只是标点，不构成「这是人话」的证据。否则
 * `PARSE_FAILED: Unexpected token <（position 0）` 只因带一对全角括号就被放行。
 */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/

/** 展示长度上限：toast / alert / 内联红字都撑不住长文本，超出截断。 */
const MAX_DISPLAY_LENGTH = 120

/**
 * 首行长度硬上限：超过即 fail-closed。
 *
 * 一行 2000 字以上的「错误信息」不可能是给人看的业务提示，只会是 SQL / 堆栈 / dump。
 * 直接判死而不是「扫前 2000 字」——后者会被「噪声词放在 2000 字之后」绕过。
 * 同时它也给下面的码点迭代兜住了上界。
 */
const MAX_SCANNABLE_LENGTH = 2000

/**
 * 裸 token → 中文说法。只收录**确实会以裸 token 形态出现在 digest 里**的两个：
 * `lib/permissions.ts` 的 `PermissionError`（`digest = 'PERMISSION_DENIED'`，
 * 供 `(main)/error.tsx` 判 403 用）与其 401 对应物。
 *
 * ⚠️ `(main)/error.tsx` 判 401/403 经 `actionErrorType` **间接依赖本 Map**（字面量副本已收掉）。
 * 因此从这里删掉任一 token 会连带杀死错误页的 403/401 分级，由
 * `src/app/(main)/error.test.tsx` 守护。
 * 用 Map 而非对象字面量：对象查表会命中 `Object.prototype`，`digest='toString'` 会返回函数而非字符串。
 *
 * ⚠️ 这张表**只对整串原值生效**，不对剥完前缀的残串生效：`CONFLICT: PERMISSION_DENIED`
 * 的语义是「并发冲突」不是「无权限」，把残串翻译成「无权执行该操作」会张冠李戴。
 */
const OPAQUE_TOKEN_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['PERMISSION_DENIED', '无权执行该操作'],
  ['UNAUTHORIZED', '登录已过期，请重新登录'],
])

/**
 * 即便整句包着中文也必须挡掉的技术痕迹。
 *
 * 「含中文」只是「可能是人话」的**必要条件**，不是充分条件：拉卡拉进件失败会生成
 * `INVALID_STATE: 营业执照：Lakala https://…/file/upload failed with 500`，
 * 中文包装 + 接口地址 + HTTP 状态一起端给用户；备份失败的
 * `open EACCES /srv/backups/db.dump` 同理。
 *
 * ⚠️ 这组规则**只作用在剥完业务前缀之后的正文**上 —— 一级前缀与二级子标签本来就是
 * 技术标识，放进来一起判没有意义（一级前缀自己就是 SCREAMING_SNAKE）。
 *
 * ⚠️ 这里**没有**「配置名 / 环境变量名」规则，是有意的。
 * `缺少后台入网配置：LAKALA_ECONTRACT_CALLBACK_URL` 与 `SKU ABC_DEF 未设置市场员工购价格`
 * （`business.ts`，商品名是**无格式限制的 text**）在语法上完全同形。两条分支的评审
 * 各自栽过：加长度门槛 → 加「紧贴中文」豁免 → 加「中式括号」豁免 → 加「配置语境词」
 * 第二条件，每次都被举出新的真实反例（最后一次是 `商品「ABC_DEF」尚未配置库存组成`，
 * 「尚未配置」正好撞上语境词）。全仓扫描显示这条规则唯一的实际效果是吞掉 4 条
 * **故意提示配置缺失**的运维文案，而它想挡的泄漏形态已由「必须含中文」那道闸门兜住，
 * 配置键泄漏的也只是**变量名**不是值。治本在抛错处，不该由收口点的黑名单硬猜。
 */
const TECH_ARTIFACT_RES: readonly RegExp[] = [
  // SQL 与 PG 报错术语。`does not exist` 单列一条：PG 的 relation/column/type/function
  // 全用这句收尾，只枚举 relation 会漏掉 `column "customer_id" does not exist`。
  /\b(?:select|insert into|update\s+\w+\s+set|delete from|relation|constraint|duplicate key|violates|syntax error at|invalid input syntax|out of range)\b/i,
  /\bdoes not exist\b/i,
  /\bhttps?:\/\/\S/i, // 接口地址
  // Unix 绝对路径。要求左界是「行首 / 空白 / 中式括号 / 冒号」：否则
  // 「仅支持 JPG/PNG/WebP/GIF」这类斜杠分隔的业务选项会被当成路径吞掉。
  /(?:^|[\s（(:：])\/(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+/,
  /(?:^|[\s（(:：])[A-Za-z]:\\[^\s]/, // Windows 绝对路径
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/, // IPv4（可带端口）
  /\[[0-9a-fA-F:]{2,}\]:\d{2,5}/, // IPv6:端口
  // 主机名:端口 —— 要求含点**且首段以字母开头**。只要求含点的话，
  // 「稀释比例 1.5:30 不合法」「工时 0.5:15 记录异常」这类小数写法会被误杀。
  /\b[A-Za-z][\w-]*(?:\.[A-Za-z0-9][\w-]*)+:\d{2,5}\b/,
  // 单标签主机:端口（`postgres:5433` / `redis:6379`）。要求小写字母开头 + 主机名 ≥5 字符：
  // 前者避开「稀释比例 1.5:30」这类小数，后者避开「门店 sku:10086 已停用」这类短业务标签
  /\b[a-z][a-z0-9-]{4,}:\d{2,5}\b/,
  // 裸 IPv6（无端口无方括号）。要求出现 `::`，免得把 `09:00:00` 这类时间写法当地址
  /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4})*::[0-9a-f]{0,4}(?::[0-9a-f]{0,4})*\b/i,
  // URI scheme（`file:///srv/…`、`postgres://…`、`redis://…`）
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  // 句中出现的内建异常名（`操作失败：TypeError: Cannot read …`），不只句首。
  // 冒号后空格可选（`String(err)` 几乎都带空格，但 `Error:boom` 这种拼法也要认），
  // 类名前缀可有可无（裸 `Error:boom` / `Exception:boom` 也要认）
  /\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception):\s?/,
  // 堆栈帧
  /\bat\s+\w+\s*\(/,
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
 * Node errno 的成句形态：`connect ECONNREFUSED 10.0.0.5:443` / `getaddrinfo EAI_AGAIN api.x.com`。
 * 这类有空格、逃得过「无中文即不可读」的兜底，而 errno 种类枚举不完（`lakala-client.ts` 会把
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
 * - 含 `\ " [ ]` 之一且长度 ≥4：带引号的库表/约束名、IPv6、内部标识符。
 *   **不含 `_`** —— 商品名带下划线是合法写法（`A_B款精华液`、`ABC_DEF款精华液`）。
 *
 * ⚠️ 这里**不再按斜杠个数判**（dev 侧原有「≥2 个斜杠即技术串」那条已撤）：
 * 合并两条分支的正例后立刻暴露真实反例 —— `不支持的文件类型，仅支持 JPG/PNG/WebP/GIF`
 * 有三个斜杠却是纯业务文案（`action-error.test.ts` 的正例）。路径与 URI 已由
 * `TECH_ARTIFACT_RES` 里那三条按结构认（Unix 路径要求以 `/` 起段、Windows 路径要求
 * 盘符 + 反斜杠、URI 要求 `scheme://`），不需要靠数斜杠兜。
 *
 * 放行的真实业务写法：订单号 `FY-XSD-WX-2609140001`（只有连字符）、`0.1~1.0`、
 * `SKU: FY-001 库存不足`、`单价/数量 不匹配`、`PC/H5`、
 * `仅支持 JPG/PNG/WebP/GIF`、`洗发水500ml/瓶`（商品名直接插进错误文案）。
 */
const PROSE_SEPARATOR_RE = /[\s぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]+/u
const TECHNICAL_RUN_CHARS_RE = /[\\"[\]]/

function hasTechnicalRun(text: string): boolean {
  return text
    .split(PROSE_SEPARATOR_RE)
    .some((token) => token.length >= 4 && TECHNICAL_RUN_CHARS_RE.test(token))
}

/** 从 unknown 错误上取一格字段；非字符串或空串一律当没有。 */
function pick(err: unknown, key: 'digest' | 'message'): string | null {
  const value = (err as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string') return null
  return value.trim() || null
}

/** 形态判定：这一串是不是「编号 / 内部信号 / 裸 token / 框架噪声」而非文案。 */
function isOpaqueShape(value: string): boolean {
  if (NEXT_AUTO_DIGEST_RE.test(value)) return true
  if (NEXT_ROUTER_SIGNAL_RE.test(value)) return true
  if (OPAQUE_TOKEN_RE.test(value)) return true
  if (NODE_ERRNO_RE.test(value)) return true
  if (JS_ERROR_NAME_RE.test(value)) return true
  const lower = value.toLowerCase()
  return UNREADABLE_FRAGMENTS.some((f) => lower.includes(f))
}

/**
 * 内容闸门：把一段候选正文收敛成「能端给用户的话」，收敛不出来返回 null。
 *
 * 顺序有讲究：
 * 1. 取首行 —— 多行错误从第二行起通常是 SQL / 堆栈 / 文件路径
 * 2. 剥标签串 —— **两条通道都要剥**。剥完一级前缀后的二级子标签固然要剥；
 *    未命中一级前缀的串也得剥，否则 `PERMISSION_DENIED：无权执行该操作`（全角冒号，
 *    `parseErrorPrefix` 只认半角）会把内部枚举整段漏给用户。标签形状要求
 *    「≥5 字符大写 token 或纯数字载荷」，所以 `SKU: ` / `ID: ` / `URL: ` 这类
 *    业务语义标签不会被误剥（`NOT_FOUND: SKU: S-001 不存在` 里的 `SKU:` 留着）。
 * 3. **噪声与技术特征判定在截断之前**做 —— 若先截断，「内网地址在第 50 字、ETIMEDOUT
 *    在第 150 字」这种串会把地址露出去而噪声词检测不到；超长首行直接判死而不是
 *    「只扫前 N 字」，否则噪声词挪到 N 之后照样绕过
 * 4. 码点安全截断 —— `slice` 会切断 emoji 代理对
 * 5. **中文判定在「展示文本」上**做 —— 中文若只出现在截断点之后，露出去的仍是英文技术串
 */
function presentable(raw: string): string | null {
  const newline = raw.indexOf('\n')
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim()
  const line = firstLine.replace(LEVEL2_SUBTAG_RE, '').trim()
  if (!line) return null
  // 超长首行直接判死（见 MAX_SCANNABLE_LENGTH），顺带给下面的码点迭代兜住上界
  if (line.length > MAX_SCANNABLE_LENGTH) return null

  if (isOpaqueShape(line)) return null
  if (TECH_ARTIFACT_RES.some((re) => re.test(line))) return null
  if (hasTechnicalRun(line) || hasHostname(line)) return null

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
 * - `false`（digest 通道、服务端返回值通道）：必须带白名单前缀，或整串是那两个裸 token 之一
 * - `true`（客户端 message 通道）：不带前缀的可读中文也放行
 *
 * 裸 token 不在说法表里时**一律返回 null，连 fail-open 也不放行** —— 裸的内部枚举
 * 在任何通道下都不是用户文案。
 */
function readable(value: string, failOpen: boolean): string | null {
  const parsed = parseErrorPrefix(value)
  if (parsed) return presentable(parsed.displayMessage)
  if (OPAQUE_TOKEN_RE.test(value)) return OPAQUE_TOKEN_MESSAGES.get(value) ?? null
  return failOpen ? presentable(value) : null
}

/**
 * digest → message → fallback 三级取值。
 *
 * 本函数绝不能抛：它被 200+ 个 catch 块调用，digest/message 可能是抛异常的 getter 或 Proxy，
 * 一次逃逸就是整页白屏。digest 那一格**单独兜一层**，别让它把 message 通道一起拖下水。
 *
 * 内建异常（TypeError / RangeError / DOMException…）的 message 是纯技术细节，
 * 而且**不带错误名**（`new TypeError('x').message === 'x'`），只能按 `name` 判 —— 所以
 * 命中 `NATIVE_ERROR_NAMES` 时直接跳过 message 通道。
 */
function extract(err: unknown, fallback: string, failOpenMessage: boolean): string {
  const safeFallback = typeof fallback === 'string' && fallback.trim() ? fallback : '操作失败'
  let fromDigest: string | null = null
  try {
    const digest = pick(err, 'digest')
    fromDigest = digest ? readable(digest, false) : null
  } catch {
    fromDigest = null
  }
  if (fromDigest) return fromDigest
  try {
    if (err instanceof Error && NATIVE_ERROR_NAMES.has(err.name)) return safeFallback
    const message = pick(err, 'message')
    return (message ? readable(message, failOpenMessage) : null) ?? safeFallback
  } catch {
    return safeFallback
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
 * 原始 PG 报错（约束名 / SQL 片段）原样送到前端 toast —— 这是 digest 之外的**第二条泄漏通道**。
 * 服务端 catch 到的错误没有「本地可读 throw」这一类，因此这里要求必须带 9 项白名单前缀，
 * 不带就一律用调用方的中文兜底文案。
 */
export function businessErrorMessage(err: unknown, fallback: string): string {
  const shown = extract(err, fallback, false)
  // 「被吞掉的必须落日志」：改造前原始报错至少随 toast 充当穷人日志，现在用户侧只剩兜底文案，
  // 服务端若也没落点，线上排查就彻底断线。只在真的退回兜底时记，
  // 正常业务拒绝（有可读文案）不产生噪声。
  if (shown === (typeof fallback === 'string' && fallback.trim() ? fallback : '操作失败')) {
    console.error('[businessErrorMessage] 非业务错误已对用户隐藏，原始错误：', err)
  }
  return shown
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
    // 这里也必须判得出类型，否则 error.tsx 会把该判 403 的渲染成 500
    return OPAQUE_TOKEN_MESSAGES.has(message) ? (message as ErrorPrefix) : null
  } catch {
    return null
  }
}
