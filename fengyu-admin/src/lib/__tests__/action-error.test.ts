import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthSession } from '../types'

// withPermission 的依赖：仅为「服务端抛 → 客户端显示」整链路用例服务。
const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))

import { actionErrorMessage } from '../action-error'
import { ApiError, CODE_MAP, ERROR_PREFIXES } from '../api-error'
import { withPermission } from '../with-permission'

const FALLBACK = '加载市场员工失败'

/** Next 生产构建对 Server Action / Server Component 错误 message 的脱敏话术。 */
const NEXT_SANITIZED_MESSAGE =
  'An error occurred in the Server Components render. The specific message is omitted in ' +
  'production builds to avoid leaking sensitive details. A digest property is included on this ' +
  'error instance which may provide additional details about the nature of the error.'

/**
 * `UNREADABLE_FRAGMENTS` 的逐条实测样本：`[片段, 该片段在真实世界里的文案形态]`。
 * 顺序必须与实现里的表一致 —— 下面有一条守护用例拿它跟源码逐项比对。
 *
 * ⚠️ 别高估这组 `it.each` 的守护力：其中 errno 族（ECONNRESET / ESOCKET / ETIMEDOUT
 * 与 5 条 LAKALA 样本）在 `isOpaque` 里会先被 `NODE_ERRNO_RE` / `JS_ERROR_NAME_RE` 短路，
 * 把对应片段从表里删掉这几条照样绿。真正钉住片段表的是下面那条「列表逐项相等」守护。
 */
const FRAGMENT_SAMPLES: readonly [string, string][] = [
  ['server components render', 'An error occurred in the Server Components render.'],
  ['omitted in production', 'The specific message is omitted in production builds.'],
  ['unexpected response', 'An unexpected response was received from the server.'],
  ['failed to fetch', 'Failed to fetch'],
  ['network request failed', 'Network request failed'],
  ['networkerror', 'NetworkError when attempting to fetch resource.'],
  ['econnreset', 'read ECONNRESET'],
  ['esocket', 'Error: connect ESOCKET 10.0.0.1:1433'],
  ['etimedout', 'connect ETIMEDOUT 10.0.0.1:1433'],
  ['econnrefused', 'INVALID_STATE: LAKALA_REQUEST_FAILED: connect ECONNREFUSED 10.0.0.5:443'],
  ['enotfound', 'INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo ENOTFOUND api.example.com'],
  ['ehostunreach', 'INVALID_STATE: LAKALA_REQUEST_FAILED: connect EHOSTUNREACH 10.0.0.5:443'],
  ['eai_again', 'INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo EAI_AGAIN api.example.com'],
  ['epipe', 'INVALID_STATE: LAKALA_REQUEST_FAILED: write EPIPE'],
  ['the network connection was lost', 'The network connection was lost.'],
  ['connection appears to be offline', 'The Internet connection appears to be offline.'],
  // 「中文字段名 + 上游原始 message」的拼装（lakala-onboarding.ts:1130 是真实来源），
  // 中文包装会让结构规则放行，只能按句式认
  ['syntax error at or near', 'INVALID_STATE: 营业执照：syntax error at or near "SELECT"'],
  ['duplicate key value', 'INVALID_STATE: 保存失败：duplicate key value'],
  ['violates unique constraint', 'INVALID_STATE: 保存失败：violates unique constraint'],
  ['violates foreign key constraint', 'INVALID_STATE: 保存失败：violates foreign key constraint'],
  ['relation does not exist', 'INVALID_STATE: 查询失败：relation does not exist'],
  ['column does not exist', 'INVALID_STATE: 查询失败：column does not exist'],
  ['cannot read properties of', 'INVALID_STATE: 营业执照：Cannot read properties of undefined'],
  ['is not a function', 'INVALID_STATE: 营业执照：x is not a function'],
  ['is not defined', 'INVALID_STATE: 营业执照：x is not defined'],
]



/**
 * `next/dist/compiled/string-hash` 的本地副本 —— 只用于「造出与线上同形的自动 digest」。
 * 与 Next 真实实现的一致性由本文件末尾的漂移守护用例盯着（不一致立即报错）。
 */
function stringHash(str: string): number {
  let hash = 5381
  let i = str.length
  while (i) hash = (hash * 33) ^ str.charCodeAt(--i)
  return hash >>> 0
}

type ClientError = Error & { digest?: string }

/**
 * 模拟 Next **生产构建**把服务端抛出的错误送到客户端后的形态：
 * message 被换成脱敏话术；digest 原样转发，原本没有 digest 的补一个自动编号。
 * issue #133 的两个复现场景都发生在这一形态下。
 */
function asProductionError(thrown: unknown): ClientError {
  const source = thrown as ClientError
  const client = new Error(NEXT_SANITIZED_MESSAGE) as ClientError
  client.digest = source.digest ?? stringHash(`${source.message}${source.stack ?? ''}`).toString()
  return client
}

/** 模拟**开发构建**：message 保留原文，digest 同样会被补上。 */
function asDevError(thrown: unknown): ClientError {
  const source = thrown as ClientError
  const client = new Error(source.message) as ClientError
  client.digest = source.digest ?? stringHash(`${source.message}${source.stack ?? ''}`).toString()
  return client
}

function makeSession(actions: string[]): AuthSession {
  return {
    employeeId: 'EMP-001',
    name: '测试用户',
    phone: '13800138000',
    roles: [{ role: 'admin', scopeId: 'hq-1', scopeType: '总部' }],
    permissions: { actions, scopeStoreIds: [] },
  }
}

/** 跑一次真实的 withPermission，把它抛出来的错误原样交回。 */
async function throwThroughWithPermission(thrower: () => never): Promise<unknown> {
  mockGetSession.mockResolvedValue(makeSession(['employee:update']))
  const wrapped = withPermission('employee:update', async () => thrower())
  try {
    await wrapped()
  } catch (e) {
    return e
  }
  throw new Error('期望抛错但没有抛')
}

describe('actionErrorMessage', () => {
  beforeEach(() => {
    mockRedirect.mockClear()
    mockGetSession.mockReset()
  })

  describe('业务文案透出', () => {
    it('digest 带白名单前缀：剥前缀后原样展示', () => {
      const err = { digest: 'INVALID_STATE: 库存期初尚未导入并核验完成，暂不可办理库存业务' }
      expect(actionErrorMessage(err, FALLBACK)).toBe(
        '库存期初尚未导入并核验完成，暂不可办理库存业务',
      )
    })

    it('二级前缀：一级前缀与子标签都剥掉（子标签按约定仅供日志归类）', () => {
      const err = { digest: 'INVALID_STATE: REFERENCE_EXISTS: 该分类下还有 3 个 SKU，无法删除；请先停用' }
      expect(actionErrorMessage(err, FALLBACK)).toBe('该分类下还有 3 个 SKU，无法删除；请先停用')
    })

    // 仓内真实**抛出形态**（orders.ts:7030/7043/7047/7456 等）：子标签后面挂着无空格载荷，
    // 以「冒号+空格」收尾。必须整段剥掉，只剥到第一个冒号会把载荷剩在句首。
    // 注：OVERPAY 族那几条在 recordPayment 里被服务端预解析收敛成返回值，走不到 toast；
    // 此处测的是剥壳逻辑本身。真正客户端可达的是下面 confirmOfflinePayment 的数字族。
    it.each([
      [
        'CONFLICT: OVERPAY:123.45: 本次回款金额超过订单欠款',
        '本次回款金额超过订单欠款',
      ],
      [
        'INVALID_PARAMS: OVERPAY_ITEM:SI-8801:NOT_FOUND: 回款明细行不存在于该订单',
        '回款明细行不存在于该订单',
      ],
      [
        'CONFLICT: OVERPAY_ITEM:SI-8801:12.00: 该明细行回款金额超过可回款额',
        '该明细行回款金额超过可回款额',
      ],
      // 一级前缀后面不带空格（orders.ts:700 的真实写法）
      ['INSUFFICIENT_BALANCE:NO_CARD: 顾客无储值卡账户', '顾客无储值卡账户'],
      // 子标签首段是**纯数字**的同族写法（orders.ts:3496，confirmOfflinePayment 直抛、
      // 无服务端预解析 → 客户端真能看到）。大写族修了、数字族漏了就是修了一半。
      [
        'INSUFFICIENT_BALANCE:123.45: 顾客储值卡余额不足，期望扣 150，实际 123.45',
        '顾客储值卡余额不足，期望扣 150，实际 123.45',
      ],
      ['INSUFFICIENT_BALANCE:0: 顾客储值卡余额不足', '顾客储值卡余额不足'],
    ])('带载荷的子标签整段剥掉：%s', (digest, expected) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(expected)
    })

    it.each([
      ['SKU: FY-001 库存不足', 'SKU: FY-001 库存不足'],
      ['ID: 123 的订单不存在', 'ID: 123 的订单不存在'],
      ['SN: A-100 已被占用', 'SN: A-100 已被占用'],
    ])('非白名单的业务语义标签不剥（%s）', (message, expected) => {
      // 一级前缀走 9 项白名单精确匹配，不做形状匹配 —— 否则 ID/URL/SKU 这类标签会被误吃
      expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(expected)
    })

    it.each(['ID: 123', 'URL: https://example.com/a'])(
      '但整串没有一个中文字的，一律不是给用户看的文案（%s）',
      (message) => {
        expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
      },
    )

    // 「含中文」只是必要条件不是充分条件：包一层中文就放行，等于给技术细节开了后门。
    it.each([
      // lakala-onboarding.ts:470 → actions/lakala-onboarding.ts:1130 的真实拼装形态
      'INVALID_STATE: 营业执照：Lakala https://test.example.cn/api/v3/file/upload failed with 500',
      'INVALID_STATE: 备份失败：open EACCES /srv/backups/db.dump',
      'INVALID_STATE: 数据库连接失败：10.0.0.5:5433 不可达',
      // 全角括号不是「这是人话」的证据
      'INVALID_STATE: PARSE_FAILED: Unexpected token <（position 0）',
    ])('中文包着的技术痕迹照样挡住：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      // actions/lakala-onboarding.ts:1492 的真实文案：中文包着环境变量名
      'INVALID_STATE: 缺少电子合同回调地址：LAKALA_ECONTRACT_CALLBACK_URL',
      // 主机名:端口（IPv4 之外的形态）
      'INVALID_STATE: 数据库连接失败：postgres.internal:5433 不可达',
      // IPv6:端口
      'INVALID_STATE: 数据库连接失败：[fd00::5]:5433 不可达',
      // Windows 绝对路径
      'INVALID_STATE: 备份文件 C:\\srv\\backups\\db.dump 写入失败',
    ])('内网拓扑 / 环境变量名不随中文一起漏出：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      // 单标签主机（Docker 服务名）
      'INVALID_STATE: 服务连接失败：postgres:5433 不可达',
      // URI scheme
      'INVALID_STATE: 读取失败：file:///srv/backups/db.dump',
      // 无端口的 IPv6
      'INVALID_STATE: 服务连接失败：[fd00::5] 不可达',
      // 带引号的库表/约束名
      'INVALID_STATE: 数据库错误：duplicate key value violates unique constraint "uq_sop_txn"',
      // 尾巴带小写单位的内部标识（SCREAMING_SNAKE 规则吃不到，靠结构兜底）
      'INVALID_STATE: 请求失败：LAKALA_TIMEOUT_30000ms',
      // 句中而非句首的内建异常名
      'INVALID_STATE: 操作失败：TypeError: Cannot read properties of undefined',
    ])('中文包着的第二批技术痕迹也挡住：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      // 内网域名（不带端口）
      'INVALID_STATE: 营业执照：upstream.internal connection timeout',
      'INVALID_STATE: 数据库连接失败：db-primary.internal 不可达',
      'INVALID_STATE: 网关返回 merchant.example.com 无响应',
      // 裸 IPv6（无端口无方括号）
      'INVALID_STATE: 营业执照：fd00::5 不可达',
    ])('内网主机名 / 裸 IPv6 也挡住：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      // 仓内真实文案（merchants/onboarding）
      ['INVALID_PARAMS: 身份证仅支持 JPG/PNG 图片', '身份证仅支持 JPG/PNG 图片'],
      // 商品名会被直接插进错误文案（business.ts:1535），规格里带 / 和 _ 都是合法写法
      ['INVALID_STATE: SKU 洗发水500ml/瓶 未设置市场进货价', 'SKU 洗发水500ml/瓶 未设置市场进货价'],
      ['INVALID_STATE: A_B款精华液 未设置市场进货价', 'A_B款精华液 未设置市场进货价'],
      ['INVALID_PARAMS: 仅 PC/H5 端支持该操作', '仅 PC/H5 端支持该操作'],
      ['INVALID_PARAMS: 支持 iOS/Android 双端', '支持 iOS/Android 双端'],
      ['INVALID_PARAMS: 门店 sku:10086 已停用', '门店 sku:10086 已停用'],
      // 版本号不是域名
      ['INVALID_STATE: 版本 v1.2.3 不受支持', '版本 v1.2.3 不受支持'],
      // 文件名不是域名
      ['INVALID_STATE: 报表 report.xlsx 生成失败', '报表 report.xlsx 生成失败'],
      // 时间不是 IPv6
      ['INVALID_PARAMS: 预约时间 09:00:00 已过期', '预约时间 09:00:00 已过期'],
    ])('这些真实业务写法一个都不能误杀：%s', (digest, expected) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(expected)
    })

    it.each([
      // 小数比例：单标签主机规则要求字母开头，不会误伤
      ['INVALID_PARAMS: 稀释比例 1.5:30 不合法', '稀释比例 1.5:30 不合法'],
      ['INVALID_PARAMS: 工时 0.5:15 记录异常', '工时 0.5:15 记录异常'],
      ['INVALID_PARAMS: 预约时段 09:00-18:00 不可用', '预约时段 09:00-18:00 不可用'],
      // 结构兜底按「空白+中日韩」切段，`/` 两侧是中文时切出来只有一个字符
      ['INVALID_PARAMS: 单价/数量 不匹配', '单价/数量 不匹配'],
      ['CONFLICT: 订单 FY-XSD-WX-2609140001 已被他人处理', '订单 FY-XSD-WX-2609140001 已被他人处理'],
    ])('这批真实业务写法不能被误杀：%s', (digest, expected) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(expected)
    })

    it('SCREAMING_SNAKE 规则不误杀单词型业务缩写', () => {
      // 要求至少一个下划线 —— SKU / OEM / VIP 这类单词不受影响
      expect(actionErrorMessage({ digest: 'NOT_FOUND: SKU 编码 FY-001 不存在' }, FALLBACK)).toBe(
        'SKU 编码 FY-001 不存在',
      )
      expect(actionErrorMessage({ digest: 'CONFLICT: VIP 客户不可合并' }, FALLBACK)).toBe(
        'VIP 客户不可合并',
      )
    })

    it('正常中文业务文案不受技术痕迹规则影响', () => {
      expect(
        actionErrorMessage({ digest: 'CONFLICT: 订单 FY-XSD-WX-2609140001 已被他人处理' }, FALLBACK),
      ).toBe('订单 FY-XSD-WX-2609140001 已被他人处理')
      expect(
        actionErrorMessage({ digest: 'INVALID_PARAMS: 折扣需在 0.1~1.0 之间' }, FALLBACK),
      ).toBe('折扣需在 0.1~1.0 之间')
    })

    it.each([
      ['NOT_FOUND: SKU: S-001 不存在', 'SKU: S-001 不存在'],
      ['INVALID_PARAMS: ID: 123 不合法', 'ID: 123 不合法'],
      ['NOT_FOUND: SN: A-100 不存在', 'SN: A-100 不存在'],
    ])('短标签（≤3 字符）不当子标签剥：%s', (digest, expected) => {
      // 仓内真实子标签最短 7 字符（NO_CARD / OVERPAY），用长度把它们与 ID/SKU/URL 分开
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(expected)
    })

    it('无 digest 但 message 可读（dev 构建）：原样展示', () => {
      expect(actionErrorMessage(new Error('该顾客未绑定门店'), FALLBACK)).toBe('该顾客未绑定门店')
    })

    it('业务里裸抛的中文 message 不带 Error 头，不会被内建错误名规则误伤', () => {
      expect(actionErrorMessage(new Error('该顾客未绑定门店，无法开单'), FALLBACK)).toBe(
        '该顾客未绑定门店，无法开单',
      )
    })

    it('不误剥含连字符的业务标识', () => {
      const err = { digest: 'CONFLICT: FY-XSD-WX-2609140001 已存在' }
      expect(actionErrorMessage(err, FALLBACK)).toBe('FY-XSD-WX-2609140001 已存在')
    })

    it('剥前缀后首尾空白被清掉', () => {
      expect(actionErrorMessage({ digest: '  NOT_FOUND:   订单不存在  ' }, FALLBACK)).toBe(
        '订单不存在',
      )
    })
  })

  describe('#133 场景 B：Next 自动生成的 digest 不得当成文案', () => {
    it('纯数字 digest + 脱敏 message → 回退调用方 fallback', () => {
      // 线上实际观测到的那一串：办理台员工购加载失败时 toast 显示 1956068727
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest: '1956068727' })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it.each(['0', '5', '42', '4294967295'])(
      '纯数字 digest %s 一律判为编号而非文案',
      (digest) => {
        const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
        expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
      },
    )

    it('纯数字 digest + 可读 message（dev 构建）：落到 message，不回退', () => {
      const err = Object.assign(new Error('该分院不在你的管辖范围内'), { digest: '1956068727' })
      expect(actionErrorMessage(err, FALLBACK)).toBe('该分院不在你的管辖范围内')
    })

    it('纯数字串一律不是文案：超出 Next digest 上限的长数字同样回退', () => {
      // 早先的期望是「11 位以上按文案处理」。评审指出这自相矛盾：`ANALYST_UNAUTHORIZED: 401`
      // 剥完剩的 401 要挡，凭什么整串 12345678901 就能端给用户？一串裸数字对用户零信息量。
      expect(actionErrorMessage({ digest: '12345678901' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: '12.50' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: '1200:300' }, FALLBACK)).toBe(FALLBACK)
    })

    // Next 把带 __NEXT_ERROR_CODE 的内部错误 digest 拼成 `<hash>@E<code>`
    // （createDigestWithErrorCode，error-telemetry-utils.js）。admin 19 个 action 模块大量
    // 调 revalidatePath，这条支路是真的会走到的。
    it.each(['1956068727@E263', '0@E1', '4294967295@E999'])(
      '带 Next 错误码后缀的自动 digest %s 也判为编号',
      (digest) => {
        const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
        expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
      },
    )
  })

  describe('客户端自抛的异常不经 Next 脱敏，同样不能端给用户', () => {
    // ⚠️ 真实的原生异常 message **不含错误名**（`new TypeError('x').message === 'x'`），
    // 所以「拿 new Error('TypeError: …') 当 fixture」是假的 —— 它只覆盖了被 String() 过的形态。
    // 下面这组是真抛出来的。
    it('真实 TypeError：属性名不会被端给用户', () => {
      let caught: unknown
      try {
        ;(undefined as unknown as { id: string }).id
      } catch (e) {
        caught = e
      }
      expect((caught as Error).message).toContain('Cannot read properties of undefined')
      expect(actionErrorMessage(caught, FALLBACK)).toBe(FALLBACK)
    })

    it('真实 RangeError：Invalid time value 不会被端给用户', () => {
      let caught: unknown
      try {
        new Date('x').toISOString()
      } catch (e) {
        caught = e
      }
      expect(actionErrorMessage(caught, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      new TypeError('x is not a function'),
      new ReferenceError('x is not defined'),
      new SyntaxError('Unexpected token <'),
      new RangeError('Invalid array length'),
      Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' }),
      Object.assign(new Error("Failed to execute 'fetch'"), { name: 'DOMException' }),
    ])('内建异常 $name → 回退 fallback', (err) => {
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('项目自己的错误类不受影响（name 不在内建集合里）', () => {
      const permissionLike = Object.assign(new Error('NOT_FOUND: 该分院不存在'), {
        name: 'PermissionError',
      })
      expect(actionErrorMessage(permissionLike, FALLBACK)).toBe('该分院不存在')
      // ApiError 没改 name，仍是 'Error'
      expect(new ApiError('NOT_FOUND', 'x').name).toBe('ApiError')
    })

    it.each([
      "TypeError: Cannot read properties of undefined (reading 'id')",
      'Error: boom',
      "DOMException: Failed to execute 'fetch' on 'Window'",
    ])('被字符串化过的形态 %s 也回退', (message) => {
      expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
    })
  })

  describe('技术 token 不得端给用户', () => {
    it('digest = PERMISSION_DENIED（PermissionError 的裸 token）→ 给标准中文说法', () => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest: 'PERMISSION_DENIED' })
      expect(actionErrorMessage(err, FALLBACK)).toBe('无权执行该操作')
    })

    it('digest = UNAUTHORIZED → 给标准中文说法', () => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest: 'UNAUTHORIZED' })
      expect(actionErrorMessage(err, FALLBACK)).toBe('登录已过期，请重新登录')
    })

    it.each([
      'DYNAMIC_SERVER_USAGE',
      'BAILOUT_TO_CLIENT_SIDE_RENDERING',
      'NEXT_NOT_FOUND',
      'NEXT_HTTP_ERROR_FALLBACK;404',
      'NEXT_REDIRECT;replace;/login?expired=1;307;',
    ])('Next 内部信号 %s → 回退 fallback', (digest) => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('整串只有前缀没有正文 → 回退 fallback', () => {
      expect(actionErrorMessage({ digest: 'CONFLICT:' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: 'INVALID_STATE: REFERENCE_EXISTS:' }, FALLBACK)).toBe(
        FALLBACK,
      )
    })
  })

  describe('剥完前缀后必须再判一次（否则技术串从后门溜出去）', () => {
    it.each([
      // orders.ts:7079 —— 只有前缀 + 裸子标签，没有人话
      ['INSUFFICIENT_BALANCE:NO_CARD', '剥完剩裸 token NO_CARD'],
      // system-diagnostics.ts:169/170 —— 子标签后面挂的是 HTTP 状态码
      ['INVALID_STATE: ANALYST_UNAUTHORIZED: 401', '剥完剩纯数字 401'],
      ['INVALID_STATE: ANALYST_UNAVAILABLE: 500', '剥完剩纯数字 500'],
      // lakala-onboarding.ts:1590/1637 把网关的 errorMessage 直通进前缀，可能是纯码
      ['INVALID_STATE: SYSTEM_ERROR', '剥完剩裸 token SYSTEM_ERROR'],
      ['INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH', '剥完剩裸 token'],
      // 整串从头到尾都是标签、没有正文
      ['INSUFFICIENT_BALANCE:12.50', '剥完剩纯金额 12.50'],
      ['CONFLICT: OVERPAY:123', '剥完剩标签串 OVERPAY:123'],
      ['CONFLICT: OVERPAY_ITEM:SI-8801:12.00', '剥完剩标签串（无正文）'],
    ])('%s（%s）→ 回退 fallback', (digest) => {
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })

    it('残串是裸 token 时不套用中文说法表（语义会张冠李戴）', () => {
      // 「并发冲突」不等于「无权限」——不能因为剥完剩 PERMISSION_DENIED 就翻译成「无权执行该操作」
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), {
        digest: 'CONFLICT: PERMISSION_DENIED',
      })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    })
  })

  describe('脱敏 / 网络层文案回退', () => {
    it('脱敏话术且无 digest → 回退 fallback', () => {
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), FALLBACK)).toBe(FALLBACK)
    })

    // ⚠️ fixture 必须用「带小写/空格的真实文案」，不能用裸的 ESOCKET / ETIMEDOUT ——
    // 那种形态会先被「裸技术 token」规则短路。（errno 族另有 NODE_ERRNO_RE 兜着，
    // 片段表本身由下面那条列表相等守护钉死，见 FRAGMENT_SAMPLES 的说明。）
    it.each(FRAGMENT_SAMPLES)(
      '片段 %s（实测文案「%s」）→ 回退 fallback（大小写不敏感）',
      (_fragment, message) => {
        expect(actionErrorMessage(new Error(message), FALLBACK)).toBe(FALLBACK)
      },
    )

    it('片段表逐条都有真红检守着（改坏任一条都会有用例转红）', () => {
      const src = readFileSync(resolve(import.meta.dirname, '../action-error.ts'), 'utf8')
      const block = src.match(/const UNREADABLE_FRAGMENTS = \[([\s\S]*?)\] as const/)?.[1]
      expect(block, '找不到 UNREADABLE_FRAGMENTS').toBeTruthy()
      const fragments = [...block!.matchAll(/'([^']+)'/g)].map((m) => m[1])
      // covered 直接取自上面 it.each 的实测样本，不再手抄一份 —— 否则往表里加一条
      // 再同步加进硬编码数组，测试照样绿，而那一条其实一个用例都没跑到。
      const covered = FRAGMENT_SAMPLES.map(([fragment]) => fragment)
      expect(fragments, '片段表变了但本文件的实测文案没跟上').toEqual(covered)
    })

    // 拉卡拉链路会把 Node errno 原文拼进白名单前缀 message（lakala-client.ts:222），
    // 剥完子标签后剩下的就是这些串 —— 内网 IP / 端口 / 内部域名，绝不能端给用户。
    it.each([
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: connect ECONNREFUSED 10.0.0.5:443', 'econnrefused'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo ENOTFOUND api.example.com', 'enotfound'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: connect EHOSTUNREACH 10.0.0.5:443', 'ehostunreach'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo EAI_AGAIN api.example.com', 'eai_again'],
      ['INVALID_STATE: LAKALA_REQUEST_FAILED: write EPIPE', 'epipe'],
      ['The network connection was lost.', 'the network connection was lost'],
      ['The Internet connection appears to be offline.', 'connection appears to be offline'],
    ])('errno / 浏览器网络文案不泄露内网信息：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    // errno 种类枚举不完（lakala-client.ts:222 把 err.message 原文拼进白名单前缀），
    // 所以按结构认：`connect|getaddrinfo|read|write + E大写码`。下面这批**不在**片段表里。
    it.each([
      'INVALID_STATE: LAKALA_REQUEST_FAILED: connect ENETUNREACH 10.0.0.5:443',
      'INVALID_STATE: LAKALA_REQUEST_FAILED: read ECONNABORTED',
      'INVALID_STATE: LAKALA_REQUEST_FAILED: getaddrinfo ENODATA api.example.com',
    ])('未列入片段表的 errno 也被结构规则挡住：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      // 无空白无中文 → 不是人话
      'INVALID_STATE: LAKALA_TIMEOUT_30000ms',
      'INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH',
      'INVALID_STATE: SYSTEM_ERROR',
      // 解析错误的英文技术句
      'INVALID_STATE: LAKALA_RESPONSE_NOT_JSON: Unexpected token < at position 0',
    ])('内部标识与解析细节不外泄：%s', (digest) => {
      expect(actionErrorMessage({ digest }, FALLBACK)).toBe(FALLBACK)
    })
  })

  describe('入参防御', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['字符串', 'boom'],
      ['数字', 500],
      ['空对象', {}],
    ])('非 Error 入参（%s）→ 回退 fallback', (_label, input) => {
      expect(actionErrorMessage(input, FALLBACK)).toBe(FALLBACK)
    })

    it('digest 为空串 / 空白串 → 落到 message', () => {
      expect(actionErrorMessage(Object.assign(new Error('余额不足'), { digest: '' }), FALLBACK)).toBe(
        '余额不足',
      )
      expect(
        actionErrorMessage(Object.assign(new Error('余额不足'), { digest: '   ' }), FALLBACK),
      ).toBe('余额不足')
    })

    it('digest 非字符串（防御 Next 改类型）→ 落到 message', () => {
      const err = Object.assign(new Error('余额不足'), { digest: 1956068727 })
      expect(actionErrorMessage(err, FALLBACK)).toBe('余额不足')
    })

    it('message 为空且无 digest → 回退 fallback', () => {
      expect(actionErrorMessage(new Error(''), FALLBACK)).toBe(FALLBACK)
    })

    it.each([
      ['空数组', [] as unknown],
      ['无原型对象', Object.create(null) as unknown],
      ['Symbol', Symbol('x') as unknown],
    ])('异形入参（%s）→ 回退 fallback，且不抛', (_label, input) => {
      expect(() => actionErrorMessage(input, FALLBACK)).not.toThrow()
      expect(actionErrorMessage(input, FALLBACK)).toBe(FALLBACK)
    })

    it('digest 是会抛异常的 getter → 只丢 digest 这一格，message 照常用', () => {
      const err = new Error('余额不足')
      Object.defineProperty(err, 'digest', {
        get() {
          throw new TypeError('digest trap')
        },
      })
      expect(() => actionErrorMessage(err, FALLBACK)).not.toThrow()
      // digest 读不到就只放弃 digest 这一格，不该把明明可读的 message 一起拖下水
      expect(actionErrorMessage(err, FALLBACK)).toBe('余额不足')
    })

    it('原型链上的键不算映射命中', () => {
      // OPAQUE_TOKEN_MESSAGES 用 Object.hasOwn 判定，constructor / toString 这类不会误命中
      expect(actionErrorMessage({ digest: 'CONSTRUCTOR' }, FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage({ digest: 'TOSTRING' }, FALLBACK)).toBe(FALLBACK)
    })

    it('fallback 本身为空 / 全空白 → 给通用兜底文案，不弹空白 toast', () => {
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), '')).toBe('操作失败')
      expect(actionErrorMessage(new Error(NEXT_SANITIZED_MESSAGE), '   ')).toBe('操作失败')
    })
  })

  describe('9 项错误前缀白名单整链路透出（服务端 throw → 生产脱敏 → 客户端展示）', () => {
    // 前缀清单从 api-error.ts 直接取，不在此处硬编码副本：白名单增删会自动带进本用例。
    // 文案里不能带 prefix 本身：那是 SCREAMING_SNAKE 形态，会被「技术痕迹」规则正确杀掉，
    // 但那是 fixture 的问题不是实现的问题（真实业务文案不会把错误前缀写进正文）。
    it.each([...ERROR_PREFIXES])('%s：生产构建下文案仍原样到达用户', async (prefix) => {
      const copy = `这是一条需要原样透出的业务说明（${CODE_MAP[prefix]}）`
      const thrown = await throwThroughWithPermission(() => {
        throw new ApiError(prefix, copy)
      })
      expect(actionErrorMessage(asProductionError(thrown), FALLBACK)).toBe(copy)
      expect(actionErrorMessage(asDevError(thrown), FALLBACK)).toBe(copy)
      // 上面两条走的都是 digest 格（dev 下 Next 同样会挂 digest）。这条才真的走 message 格：
      // 模拟「digest 通道没了」（比如错误没经 rethrowWithDigest）时仍能从 message 取到文案。
      expect(actionErrorMessage(new Error(`${prefix}: ${copy}`), FALLBACK)).toBe(copy)
    })

    it('非白名单系统错误：prod 与 dev 都回退 fallback，技术原文只留给控制台', async () => {
      // 取舍：早先让 dev 透出英文原文「便于排查」，评审指出这条在 prod 同样生效
      //（客户端自抛的异常不经 Next 脱敏），等于把 SQL 约束名之类的细节端给用户。
      // 现在统一按「无中文即非用户文案」回退 —— 开发排查走浏览器控制台与 Next 错误浮层，
      // 那两处拿到的是完整原文，信息并没有丢。
      const thrown = await throwThroughWithPermission(() => {
        throw new Error('invalid reference to FROM-clause entry for table "parent"')
      })
      expect(actionErrorMessage(asProductionError(thrown), FALLBACK)).toBe(FALLBACK)
      expect(actionErrorMessage(asDevError(thrown), FALLBACK)).toBe(FALLBACK)
    })

    it('#133 场景 A：期初门禁的 ApiError 在生产构建下原样到达用户', async () => {
      const gate = '库存期初尚未导入并核验完成，暂不可办理库存业务'
      const thrown = await throwThroughWithPermission(() => {
        throw new ApiError('INVALID_STATE', gate)
      })
      expect(actionErrorMessage(asProductionError(thrown), '创建单据失败')).toBe(gate)
    })
  })
})

describe('Next digest 形态漂移守护（#133）', () => {
  const require_ = createRequire(import.meta.url)
  const nextRoot = require_.resolve('next/package.json').replace(/package\.json$/, '')
  // 统一相对本文件定位，不依赖运行目录（从 monorepo 根跑 vitest 时 process.cwd() 会指错）
  const adminSrc = resolve(import.meta.dirname, '../..')

  it('create-error-handler 仍以 stringHash(...).toString() 生成 digest，且尊重已有 digest', () => {
    const src = readFileSync(`${nextRoot}dist/server/app-render/create-error-handler.js`, 'utf8')
    // 「已有 digest 不覆盖」是业务文案能穿透脱敏的前提，与 rethrowWithDigest 配对
    expect(src).toContain('if (!err.digest)')
    expect(src).toMatch(/err\.digest = \(0, _stringhash\.default\)\([\s\S]{0,120}?\)\.toString\(\)/)
    // 送到客户端的是被 createDigestWithErrorCode 包过一层的值，不是 err.digest 本身
    expect(src).toContain('createDigestWithErrorCode')
  })

  it('Next 的错误码后缀用真实实现造一遍，仍被判为不可读', () => {
    const { createDigestWithErrorCode } = require_(`${nextRoot}dist/lib/error-telemetry-utils`) as {
      createDigestWithErrorCode: (thrownValue: unknown, originalDigest: string) => string
    }
    const base = stringHash('boom').toString()
    const thrown = Object.assign(new Error('boom'), { __NEXT_ERROR_CODE: 'E263' })
    const digest = createDigestWithErrorCode(thrown, base)
    expect(digest, 'Next 的错误码拼接形态变了').toBe(`${base}@E263`)
    const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
    expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)

    // 没打错误码的错误不加后缀 —— 我们自己补的业务 digest 走的正是这一支
    expect(createDigestWithErrorCode(new Error('boom'), 'CONFLICT: 单据已被他人处理')).toBe(
      'CONFLICT: 单据已被他人处理',
    )
  })

  /** 去掉行注释与块注释，免得把文档里的举例当成真实抛点。 */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const listSourceFiles = (root: string): string[] => {
    const out: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name))
          out.push(full)
      }
    }
    walk(root)
    return out
  }

  it('全仓写 digest 的生产者就是已知那几处（改动这张名单必须同步中文说法表）', () => {
    // 早先这条只扫 `digest = '字面量'`，`const D = 'PHONE_REQUIRED'; readonly digest = D`
    // 这种间接写法绕得过去。改为守「**哪些文件在写 digest**」这个更粗但绕不过的不变量：
    // 任何新的 digest 生产者都会让文件集变化 → 红 → 逼着来这里决定要不要配中文说法。
    const files = listSourceFiles(adminSrc)
    expect(files.length).toBeGreaterThan(100)

    const producers = new Set<string>()
    const bareTokens = new Set<string>()
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'))
      // 写入形态：`x.digest = …` / `readonly digest = …` / `digest = …`（无 readonly 的字段）
      // / 对象字面量里任意位置的 `digest:` / `['digest'] =` / `defineProperty(…, 'digest', …)`
      if (
        /\.digest\s*=(?!=)|(?:readonly\s+)?\bdigest\s*=(?!=)|\bdigest\s*:\s*\S|\[\s*['"`]digest['"`]\s*\]\s*=|defineProperty\s*\([^,]+,\s*['"`]digest['"`]/.test(
          text,
        )
      ) {
        producers.add(file.slice(adminSrc.length + 1))
      }
      // 取值形态要与上面的写入形态一一对应，否则「文件集不变、新增一个裸 token」会静默放过
      const valuePatterns = [
        /\bdigest\s*[=:]\s*['"`]([^'"`]+)['"`]/g,
        /\[\s*['"`]digest['"`]\s*\]\s*=\s*['"`]([^'"`]+)['"`]/g,
        /defineProperty\s*\([^,]+,\s*['"`]digest['"`]\s*,\s*\{[^}]*value\s*:\s*['"`]([^'"`]+)['"`]/g,
      ]
      for (const re of valuePatterns) {
        for (const m of text.matchAll(re)) {
          if (/^[A-Z][A-Z0-9_]*$/.test(m[1])) bareTokens.add(m[1])
        }
      }
    }
    // 覆盖边界（诚实声明）：认的是「直接写 digest」的几种常见形态。
    // 彻底闭合（`Object.assign(err, {digest: D})` 之类的间接写法）需要 AST/ESLint，已登记跟进。
    expect([...producers].sort(), 'digest 生产者变了').toEqual([
      'actions/legacy-orders.ts',
      'lib/permissions.ts',
      'lib/with-permission.ts',
      'lib/workfine-mssql.ts',
    ])

    // 其中写「裸 token」的只有 permissions.ts 的 PermissionError
    expect([...bareTokens].sort()).toEqual(['PERMISSION_DENIED'])
    const src = readFileSync(resolve(adminSrc, 'lib/action-error.ts'), 'utf8')
    const mapped = [
      ...(src.match(/const OPAQUE_TOKEN_MESSAGES[\s\S]*?\}\)/)?.[0] ?? '').matchAll(
        /^\s{2}([A-Z][A-Z0-9_]*):/gm,
      ),
    ].map((m) => m[1])
    for (const token of bareTokens) {
      expect(mapped, `裸 token digest ${token} 没有对应的中文说法，用户会拿到通用兜底文案`).toContain(
        token,
      )
    }
  })

  it('仓内真实二级子标签（字母型）都 ≥5 字符（长度启发式的前提，破了就要改判定）', () => {
    // LEVEL2_SUBTAG_RE 用「标签 ≥5 字符」把日志子标签与 ID:/SKU:/URL: 这类展示标签分开。
    // 这是启发式不是协议 —— 语法上二者没法区分。所以把前提本身钉住：一旦有人写出
    // `CONFLICT: LOCK: …` 这种短子标签，这条立刻红，逼着重新决定判定方式。
    //
    // 已知覆盖边界（诚实声明）：扫的是**源码里直接写出来的字面量**。把子标签先赋给常量
    // 再拼（`const d = 'LOCK: …'; throw new ApiError('CONFLICT', d)`）绕得过去 ——
    // 要闭合这个口子得上 AST/ESLint 规则，已登记为跟进项。
    const escaped = (ERROR_PREFIXES as readonly string[]).map((p) =>
      p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    const re = new RegExp(`(?:${escaped.join('|')})['"\`]?\\s*[,:]\\s*['"\`]?\\s*([A-Z][A-Z0-9_]*):`, 'g')
    const found = new Map<string, string>()
    for (const file of listSourceFiles(adminSrc)) {
      // 跳过本模块与 api-error.ts：它们的注释被剥掉后仍会留下举例用的字符串
      if (/lib\/(?:action-error|api-error)\.ts$/.test(file)) continue
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const m of text.matchAll(re)) found.set(m[1], file)
    }
    expect(found.size).toBeGreaterThan(5)
    const tooShort = [...found].filter(([tag]) => tag.length < 5)
    expect(
      tooShort,
      `这些二级子标签短于 5 字符，会被 LEVEL2_SUBTAG_RE 漏剥：${JSON.stringify(tooShort)}`,
    ).toEqual([])
  })

  it('Next 的内部错误码形态仍是 E+数字（@E 正则的前提）', () => {
    // 不截断样本数、不限目录深度：早先取到 41 个就停、只走三层，第 42 个之后变形态照样绿。
    const samples = new Set<string>()
    const unparsed: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.js')) {
          const text = readFileSync(full, 'utf8')
          if (!text.includes('__NEXT_ERROR_CODE')) continue
          // 形态是 `Object.defineProperty(err, "__NEXT_ERROR_CODE", {\n  value: "E263", …})`
          // 只统计「定义点」（后面紧跟 descriptor 的那种），跳过纯读取用法
          const defs = [...text.matchAll(/__NEXT_ERROR_CODE["']?\s*,\s*\{/g)]
          const parsed = [...text.matchAll(/__NEXT_ERROR_CODE[\s\S]{0,120}?value:\s*["']([^"']+)["']/g)]
          for (const m of parsed) samples.add(m[1])
          if (parsed.length < defs.length) {
            unparsed.push(`${full.slice(nextRoot.length)}（${defs.length - parsed.length} 处）`)
          }
        }
      }
    }
    // 扫 dist 根：全树 573 个文件含 __NEXT_ERROR_CODE，分布在 13 个顶层目录，
    // 其中 dist/esm 就占 269 个（库入口，最可能先变形态）。只挑几个子目录会守不住。
    walk(`${nextRoot}dist`)
    expect(samples.size, '没在 next/dist 里找到 __NEXT_ERROR_CODE 样本').toBeGreaterThan(300)
    // 每个写入点都要能被解析出错误码 —— 否则「新写法不匹配 → 不计入失败 → 照样绿」
    expect(unparsed, `有 ${unparsed.length} 个 __NEXT_ERROR_CODE 写入点没能解析出错误码`).toEqual([])
    for (const code of samples) {
      expect(code, `Next 错误码形态变了：${code}，NEXT_AUTO_DIGEST_RE 的 @E\\d+ 需要跟着改`).toMatch(
        /^E\d+$/,
      )
    }
  })

  it('9 项白名单里每个前缀，要么有裸 token 中文说法，要么确认不会以裸 token 出现', () => {
    const src = readFileSync(resolve(adminSrc, 'lib/action-error.ts'), 'utf8')
    const mapped = [
      ...(src.match(/const OPAQUE_TOKEN_MESSAGES[\s\S]*?\}\)/)?.[0] ?? '').matchAll(
        /^\s{2}([A-Z][A-Z0-9_]*):/gm,
      ),
    ].map((m) => m[1])
    expect(mapped).toEqual(['PERMISSION_DENIED', 'UNAUTHORIZED'])

    // 全仓只有 permissions.ts 的 PermissionError 会写裸 token digest（= 'PERMISSION_DENIED'）；
    // with-permission.ts 的 rethrowWithDigest 写的是带前缀的完整 message。
    // 将来若有人照着加 `PhoneRequiredError { digest = 'PHONE_REQUIRED' }`，用户会静默拿到
    // 通用兜底文案而不知道要去绑手机号 —— 那时下面这份「确认不会裸出现」的名单就该更新。
    const knownNotBare = ERROR_PREFIXES.filter((p) => !mapped.includes(p))
    expect(knownNotBare).toEqual([
      'PHONE_REQUIRED',
      'INVALID_PARAMS',
      'NOT_FOUND',
      'INSUFFICIENT_BALANCE',
      'CONFLICT',
      'INVALID_STATE',
      'CLIENT_NOT_REGISTERED',
    ])
    const permissionsSrc = readFileSync(resolve(adminSrc, 'lib/permissions.ts'), 'utf8')
    expect(permissionsSrc).toContain("readonly digest = 'PERMISSION_DENIED'")
  })

  it('error.tsx 判 401/403 用的裸 token 与本模块的说法表同源', () => {
    const errorPageSrc = readFileSync(resolve(adminSrc, 'app/(main)/error.tsx'), 'utf8')
    // 它靠 `digest === "PERMISSION_DENIED"` / `=== "UNAUTHORIZED"` 渲染 403/401 页；
    // 本模块把同样这两个裸 token 翻成中文。两处漂移会让同一个 digest 在页面级与 toast 级判定不一致。
    expect(errorPageSrc).toContain('error.digest === "PERMISSION_DENIED"')
    expect(errorPageSrc).toContain('error.digest === "UNAUTHORIZED"')
  })

  it('本地 stringHash 副本与 Next 编译内置实现逐样本一致', () => {
    const nextStringHash = require_(`${nextRoot}dist/compiled/string-hash`) as (s: string) => number
    const samples = [
      '',
      'a',
      'invalid reference to FROM-clause entry for table "parent"',
      '库存期初尚未导入并核验完成，暂不可办理库存业务',
      'Error: boom\n    at foo (/app/.next/server/chunks/1.js:1:1)',
      'x'.repeat(5000),
    ]
    for (const s of samples) {
      expect(nextStringHash(s)).toBe(stringHash(s))
    }
  })

  it('自动 digest 恒为 1~10 位纯数字，且一律被判为不可读', () => {
    const samples = [
      '',
      'boom',
      '库存期初尚未导入并核验完成，暂不可办理库存业务',
      'x'.repeat(10000),
      '\u0000\uFFFF',
    ]
    for (const s of samples) {
      const digest = stringHash(s).toString()
      expect(digest).toMatch(/^\d{1,10}$/)
      expect(Number(digest)).toBeLessThanOrEqual(4294967295)
      const err = Object.assign(new Error(NEXT_SANITIZED_MESSAGE), { digest })
      expect(actionErrorMessage(err, FALLBACK)).toBe(FALLBACK)
    }
  })
})
