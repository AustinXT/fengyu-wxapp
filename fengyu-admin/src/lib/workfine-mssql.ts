/**
 * WorkFine MSSQL 只读客户端（仅供 admin manual pull 历史订单使用）
 *
 * 严格只读，所有查询用参数化 input，不允许任何 INSERT/UPDATE/DELETE。
 * 模块级 lazy singleton 连接池，跨 Next.js HMR 用 globalThis 复用。
 *
 * 测试夹具：设置 MOCK_WORKFINE=1 可走 fixtures 而不连真 MSSQL。
 */

import mssql from 'mssql'
import { WORKFINE_CONNECT_ERROR_MSG } from './workfine-constants'

/**
 * 解析 ADO.NET 风格连接字符串（`Server=host,port;Database=..;User Id=..;Password=..`）。
 * 与全项目 env 约定对齐（envs/*.env / staffApi 都用 MSSQL_CONNECTION_STRING）。
 * key 大小写不敏感；Server 的 `host,port` 拆出端口。返回的字段用于覆盖 MSSQL_CONFIG。
 */
export function parseMssqlConnString(connStr: string): {
  server?: string
  port?: number
  database?: string
  user?: string
  password?: string
} {
  const out: { server?: string; port?: number; database?: string; user?: string; password?: string } = {}
  for (const pair of connStr.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim().toLowerCase()
    const value = pair.slice(idx + 1).trim()
    if (!value) continue
    switch (key) {
      case 'server':
      case 'data source': {
        const [host, port] = value.split(',')
        out.server = host.trim()
        if (port) out.port = parseInt(port.trim(), 10)
        break
      }
      case 'database':
      case 'initial catalog':
        out.database = value
        break
      case 'user id':
      case 'uid':
        out.user = value
        break
      case 'password':
      case 'pwd':
        out.password = value
        break
    }
  }
  return out
}

// 优先连接字符串（与 envs/*.env、staffApi 约定一致），缺失则 fallback 分离变量。
const CONN_STRING = process.env.MSSQL_CONNECTION_STRING
const PARSED = CONN_STRING ? parseMssqlConnString(CONN_STRING) : {}

// 超时：WorkFine 仅历史数据，绝不能成为 admin 硬阻塞。MSSQL 不可用（断网/凭证过期/
// 服务下线）时必须秒级快速失败而非无限 hang，让上层 Dialog/页面立刻显示友好提示。
//   - connectionTimeout：建连（TCP/登录）超时，默认 15s 太长，收紧到 8s
//   - requestTimeout：单条查询超时，默认 15s，收紧到 10s
//   - pool.acquireTimeoutMillis：从池里取连接的等待上限，避免连接已挂时排队卡死
const CONNECT_TIMEOUT_MS = parseInt(process.env.MSSQL_CONNECT_TIMEOUT_MS || '8000', 10)
const REQUEST_TIMEOUT_MS = parseInt(process.env.MSSQL_REQUEST_TIMEOUT_MS || '10000', 10)

const MSSQL_CONFIG: mssql.config = {
  user: PARSED.user || process.env.MSSQL_USER || 'admin',
  password: PARSED.password || process.env.MSSQL_PASSWORD || '',
  database: PARSED.database || process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: PARSED.server || process.env.MSSQL_SERVER || '',
  port: PARSED.port || parseInt(process.env.MSSQL_PORT || '1433', 10),
  // min:1 常驻一条健康连接——WorkFine 是跨公网远程库，min:0 时池空闲 30s 后清空，
  // 下次首请求要重新付 TCP+登录建连成本（命中 8s 建连超时即偶发"闲一阵再搜失败"）。
  pool: { max: 3, min: 1, idleTimeoutMillis: 30_000, acquireTimeoutMillis: CONNECT_TIMEOUT_MS },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  connectionTimeout: CONNECT_TIMEOUT_MS,
  requestTimeout: REQUEST_TIMEOUT_MS,
}

// WORKFINE_CONNECT_ERROR_MSG 定义在 ./workfine-constants（纯文案、无 Node 依赖），server / client
// 共享同一 source：本模块用于 digest 透传，前端 PullWorkfineDialog 的 catch fallback 也从那里
// import——避免在 client component 误 import 本模块（含 mssql Node-only 依赖）拉崩浏览器 bundle。

/** server 日志用：带 WORKFINE_UNAVAILABLE 子标签便于故障归类排查 */
const WORKFINE_UNAVAILABLE_LOG_MSG = `INVALID_STATE: WORKFINE_UNAVAILABLE: ${WORKFINE_CONNECT_ERROR_MSG}`

/**
 * WorkFine 不可用时统一抛出的友好错误。
 *
 * 关键：必须带自定义 `digest` 才能扛住 Next.js 生产构建对 Server Action `error.message`
 * 的脱敏——普通 `Error` 在 prod 只剩通用「Server Components render」文案，前端
 * `actionErrorMessage`（lib/action-error.ts）拿不到友好提示，会退化成无意义哈希/兜底文案。
 * 仿 legacy-orders.ts 的 LegacyOrderError，但 `digest` 刻意**不含** WORKFINE_UNAVAILABLE
 * 子标签：前端剥一级前缀 `INVALID_STATE:` 后即得干净文案；子标签仅留在 `message` 供 server 日志归类。
 */
export class WorkfineUnavailableError extends Error {
  readonly digest = `INVALID_STATE: ${WORKFINE_CONNECT_ERROR_MSG}`
  constructor() {
    super(WORKFINE_UNAVAILABLE_LOG_MSG)
    this.name = 'WorkfineUnavailableError'
  }
}

type GlobalWithMssql = typeof globalThis & {
  __workfineMssqlPool?: mssql.ConnectionPool | null
  __workfineMssqlPoolPromise?: Promise<mssql.ConnectionPool> | null
}
const g = globalThis as GlobalWithMssql

async function getPool(): Promise<mssql.ConnectionPool> {
  if (g.__workfineMssqlPool?.connected) return g.__workfineMssqlPool
  if (g.__workfineMssqlPoolPromise) return g.__workfineMssqlPoolPromise

  g.__workfineMssqlPoolPromise = (async () => {
    const pool = new mssql.ConnectionPool(MSSQL_CONFIG)
    pool.on('error', (err) => {
      console.error('[workfine-mssql] pool error', err)
    })
    await pool.connect()
    g.__workfineMssqlPool = pool
    return pool
  })()

  try {
    const pool = await g.__workfineMssqlPoolPromise
    return pool
  } catch (err) {
    // 关键：连接失败必须清空缓存的 rejected promise，否则后续每次调用都会
    // 复用同一个失败 promise，永远不再重试（一次断网卡死整个功能）。
    g.__workfineMssqlPool = null
    g.__workfineMssqlPoolPromise = null
    console.error('[workfine-mssql] 连接 WorkFine MSSQL 失败', err)
    throw new WorkfineUnavailableError()
  } finally {
    // 成功时也清掉 promise 引用（pool 已存入 __workfineMssqlPool）
    if (g.__workfineMssqlPool) g.__workfineMssqlPoolPromise = null
  }
}

/**
 * 关闭并丢弃当前缓存的池（若有），强制下次 getPool 重新建连。
 * 用于查询命中"池级致命错"（整个池已不可用）时清理僵尸池，避免后续请求持续命中同一坏池。
 */
function resetPool(): void {
  const pool = g.__workfineMssqlPool
  g.__workfineMssqlPool = null
  g.__workfineMssqlPoolPromise = null
  if (pool) {
    pool.close().catch((err) => console.error('[workfine-mssql] pool.close 失败', err))
  }
}

/**
 * 判定 MSSQL 错误是否为"瞬态"（重试有望成功）：跨公网链路上 NAT/防火墙静默丢弃空闲
 * TCP 连接后，下一条查询命中死连接会报这些错。重试时 mssql 池会销毁坏连接，常拿到健康连接。
 *
 * node-mssql(tedious) 的典型瞬态信号：
 *   - err.name 含 ConnectionError / ConnectionLost
 *   - err.code: ECONNRESET / ESOCKET / ETIMEDOUT / EPIPE / ECONNREFUSED（底层 socket）
 *   - message 含 "connection lost" / "socket hang up" / "read econnreset"
 *
 * 导出供单测覆盖判定矩阵。
 */
export function isTransientMssqlError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; name?: string; message?: string }
  const code = (e.code ?? '').toUpperCase()
  const name = (e.name ?? '').toUpperCase()
  const msg = (e.message ?? '').toLowerCase()
  if (name.includes('CONNECTION')) return true
  if (['ECONNRESET', 'ESOCKET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(code)) return true
  if (msg.includes('connection lost') || msg.includes('socket hang up') || msg.includes('read econnreset')) {
    return true
  }
  return false
}

/**
 * 判定是否为"池级致命错"——整个池已不可用，保留它只会让后续请求持续命中同一坏池。
 * 典型：pool 已断开（connected=false）且错误是 ConnectionError/PoolError。普通单条查询的
 * RequestError 不算（池本身仍健康，mssql 内部会自愈该连接）。
 */
function isFatalPoolError(err: unknown, pool: mssql.ConnectionPool): boolean {
  if (pool.connected) return false
  const name = (err as { name?: string } | null)?.name ?? ''
  return name.includes('ConnectionError') || name.includes('PoolError')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 瞬态错误重试次数（WorkFine 全只读、查询幂等，重试安全）。 */
const TRANSIENT_RETRY = 1
/** 瞬态错误重试前的等待（ms），给 mssql 池一点时间销毁坏连接。 */
const TRANSIENT_RETRY_DELAY_MS = 200

/**
 * 包裹查询执行：把任何 MSSQL 连接/查询/超时错误转成统一的 WorkfineUnavailableError，
 * 让上层 action 抛出可读消息（Dialog 显示「连接 WorkFine 数据库出错」），而不是 raw 500 / 卡死。
 *
 * 对瞬态错误（死连接 / ECONNRESET / 超时）自动重试 1 次——跨公网 WorkFine 的"偶尔失败"
 * 大多是这类，重试一次往往就成功。已经是 WorkfineUnavailableError（来自 getPool）的错误
 * 原样透传，不重复包裹。重试耗尽或非瞬态错时，若判定为池级致命错则 resetPool() 清理僵尸池。
 */
async function runQuery<T>(fn: (pool: mssql.ConnectionPool) => Promise<T>): Promise<T> {
  // getPool 失败时已抛出 WorkfineUnavailableError，直接透传。
  const pool = await getPool()
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= TRANSIENT_RETRY; attempt++) {
    try {
      return await fn(pool)
    } catch (err) {
      if (err instanceof WorkfineUnavailableError) throw err
      lastErr = err
      // 瞬态错误且仍有重试额度：短暂等待后重试（mssql 池内部会销毁坏连接）
      if (attempt < TRANSIENT_RETRY && isTransientMssqlError(err)) {
        await sleep(TRANSIENT_RETRY_DELAY_MS)
        continue
      }
      break
    }
  }
  console.error('[workfine-mssql] 查询 WorkFine MSSQL 失败', lastErr)
  if (lastErr && isFatalPoolError(lastErr, pool)) resetPool()
  throw new WorkfineUnavailableError()
}

function trim(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * 还原 WorkFine 金额：WorkFine MSSQL 所有金额列按真实金额的 1/10 存储
 *（系统固有缩放约定，非个别数据脏值），凡是从 WorkFine 取金额一律 ×10
 * 还原为真实业务金额。
 *
 * 用整数运算（先 ×1000 再 /100）规避 IEEE 754 浮点末位误差；对负数 /
 * NaN / 非数字 fallback 0（WorkFine 不应出现负金额，防御性兜底以免溢出
 * PG numeric(10,2)）。
 *
 * 凡是从 workfine-mssql 取金额的代码必须经过此函数。
 */
export function normalizeWorkfineAmount(raw: number | string | null | undefined): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 1000) / 100
}

export interface WorkfineCustomer {
  customerId: string
  name: string | null
  phone: string | null
}

export interface WorkfineOrder {
  legacyOrderNo: string
  saleDate: string
  marketName: string | null
  storeName: string | null
  customerName: string | null
  amount: number
  legacyCustomerId: string | null
  phone: string | null
  /**
   * WorkFine 来源单据类型（销售单 UDT_S_209 / 转换单 UDT_S_570 / 回款单 UDT_S_261）。
   * 仅用于 legacy_raw_snapshot.source_type 备查——PG 一律标 sale_order_type='销售单'，
   * 靠单号前缀（FY-XSD / FY-ABZH / FY-HKD）与该字段区分来源。
   */
  sourceType: '销售单' | '转换单' | '回款单'
  /** 回款单引用的原销售单/转换单号（UDT_S_261.UDF_S_917）；仅回款单有值，存 snapshot 备查 */
  originalOrderNo: string | null
}

const USE_MOCK = process.env.MOCK_WORKFINE === '1'

// ---- Mock fixtures（仅 CI / 无 MSSQL 网络时启用）----
const MOCK_CUSTOMERS: WorkfineCustomer[] = [
  { customerId: 'WF-MOCK-001', name: '测试顾客 A', phone: '13800138000' },
  { customerId: 'WF-MOCK-002', name: '测试顾客 B', phone: '13800138001' },
]
const MOCK_ORDERS: WorkfineOrder[] = [
  {
    legacyOrderNo: 'WF-ORD-001',
    saleDate: '2023-06-15T10:00:00.000Z',
    marketName: '南昌市场',
    // 与 fengyu_e2e 测试 PG 的 seed 命名口径一致：门店名带「（E2E）」后缀
    // （store-nc01 = '南昌旗舰店（E2E）'）。storeMatched / 默认勾选 / storeMapping
    // 均按 store_name 精确反查 stores 表，故 mock storeName 必须与库内字面完全一致，
    // 否则 storeMatched=false、行不默认勾选、import 时被 skippedNoStore=1 跳过。
    storeName: '南昌旗舰店（E2E）',
    customerName: '测试顾客 A',
    amount: 998,
    legacyCustomerId: 'WF-MOCK-001',
    phone: '13800138000',
    sourceType: '销售单',
    originalOrderNo: null,
  },
  // 转换单（UDT_S_570 / FY-ABZH）：补差价，amount 为 WorkFine 缩放值，×10 还原
  {
    legacyOrderNo: 'WF-ABZH-MOCK-001',
    saleDate: '2024-01-10T10:00:00.000Z',
    marketName: '南昌市场',
    storeName: '南昌旗舰店（E2E）',
    customerName: '测试顾客 A',
    amount: 10,
    legacyCustomerId: 'WF-MOCK-001',
    phone: '13800138000',
    sourceType: '转换单',
    originalOrderNo: null,
  },
  // 回款单（UDT_S_261 / FY-HKD）：补交欠款；originalOrderNo 引用原销售单（UDF_S_917）
  {
    legacyOrderNo: 'WF-HKD-MOCK-001',
    saleDate: '2024-03-20T10:00:00.000Z',
    marketName: '南昌市场',
    storeName: '南昌旗舰店（E2E）',
    customerName: '测试顾客 A',
    amount: 20,
    legacyCustomerId: 'WF-MOCK-001',
    phone: '13800138000',
    sourceType: '回款单',
    originalOrderNo: 'WF-ORD-001',
  },
]

/**
 * 按手机号搜索 WorkFine 顾客（UDT_S_311.UDF_S_1478）
 * 可能多结果（同手机号绑定多个顾客编号是少数极端场景）
 */
export async function searchCustomersByPhone(phone: string): Promise<WorkfineCustomer[]> {
  const normalized = trim(phone)
  if (!normalized) return []
  if (USE_MOCK) return MOCK_CUSTOMERS.filter((c) => c.phone === normalized)

  return runQuery(async (pool) => {
    const result = await pool
      .request()
      .input('phone', mssql.NVarChar(50), normalized)
      .query<{ customer_id: string; name: string | null; phone: string | null }>(`
        SELECT
          RTRIM(UDF_S_1475) AS customer_id,
          RTRIM(UDF_S_1476) AS name,
          RTRIM(UDF_S_1478) AS phone
        FROM UDT_S_311
        WHERE RTRIM(UDF_S_1478) = @phone
      `)
    return result.recordset.map((r) => ({
      customerId: r.customer_id,
      name: trim(r.name),
      phone: trim(r.phone),
    }))
  })
}

/**
 * 按 WorkFine 顾客编号精确查询（UDT_S_311.UDF_S_1475）
 */
export async function searchCustomerByCustomerId(
  customerId: string,
): Promise<WorkfineCustomer | null> {
  const normalized = trim(customerId)
  if (!normalized) return null
  if (USE_MOCK) return MOCK_CUSTOMERS.find((c) => c.customerId === normalized) ?? null

  return runQuery(async (pool) => {
    const result = await pool
      .request()
      .input('customerId', mssql.NVarChar(50), normalized)
      .query<{ customer_id: string; name: string | null; phone: string | null }>(`
        SELECT TOP 1
          RTRIM(UDF_S_1475) AS customer_id,
          RTRIM(UDF_S_1476) AS name,
          RTRIM(UDF_S_1478) AS phone
        FROM UDT_S_311
        WHERE RTRIM(UDF_S_1475) = @customerId
      `)
    if (result.recordset.length === 0) return null
    const r = result.recordset[0]
    return {
      customerId: r.customer_id,
      name: trim(r.name),
      phone: trim(r.phone),
    }
  })
}

/**
 * 按 WorkFine 顾客编号拉该顾客全部历史订单（销售单 / 转换单 / 回款单）。
 *
 * WorkFine 中三类单据各自独立存储：销售单 UDT_S_209（FY-XSD）、转换单 UDT_S_570
 * （FY-ABZH）、回款单 UDT_S_261（FY-HKD），核心字段（UDF_S_372 单号 / 350 日期 /
 * 348 市场 / 349 门店 / 370 姓名 / 507 金额）同名同义，故 UNION ALL 合并拉取。
 * 唯一差异：回款单顾客编号字段是 UDF_S_1488（非 1485），其 WHERE/JOIN 单独用 1488；
 * 回款单额外取 UDF_S_917（原销售单/转换单号）作 original_order_no 备查。
 *
 * 金额取主表 UDF_S_507 订单级汇总（= 顾客实付：销售单收款合计 / 转换单补差价 /
 * 回款单补交欠款），统一 normalizeWorkfineAmount ×10 还原。
 */
export async function queryOrdersByCustomerId(customerId: string): Promise<WorkfineOrder[]> {
  const normalized = trim(customerId)
  if (!normalized) return []
  if (USE_MOCK) {
    return MOCK_ORDERS
      .filter((o) => o.legacyCustomerId === normalized)
      .map((o) => ({ ...o, amount: normalizeWorkfineAmount(o.amount) }))
  }

  return runQuery(async (pool) => {
    const result = await pool
      .request()
      .input('customerId', mssql.NVarChar(50), normalized)
      .query<{
        legacy_order_no: string
        sale_date: Date | string
        market_name: string | null
        store_name: string | null
        legacy_customer_id: string | null
        customer_name: string | null
        amount: number | string
        phone: string | null
        src_type: '销售单' | '转换单' | '回款单'
        original_order_no: string | null
      }>(`
        SELECT
          RTRIM(s.UDF_S_372)  AS legacy_order_no,
          s.UDF_S_350          AS sale_date,
          RTRIM(s.UDF_S_348)  AS market_name,
          RTRIM(s.UDF_S_349)  AS store_name,
          RTRIM(s.UDF_S_1485) AS legacy_customer_id,
          RTRIM(s.UDF_S_370)  AS customer_name,
          s.UDF_S_507          AS amount,
          RTRIM(k.UDF_S_1478) AS phone,
          '销售单'             AS src_type,
          CAST(NULL AS NVARCHAR(30)) AS original_order_no
        FROM UDT_S_209 s
        LEFT JOIN UDT_S_311 k ON RTRIM(s.UDF_S_1485) = RTRIM(k.UDF_S_1475)
        WHERE RTRIM(s.UDF_S_1485) = @customerId
          AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
        UNION ALL
        SELECT
          RTRIM(s.UDF_S_372)  AS legacy_order_no,
          s.UDF_S_350          AS sale_date,
          RTRIM(s.UDF_S_348)  AS market_name,
          RTRIM(s.UDF_S_349)  AS store_name,
          RTRIM(s.UDF_S_1485) AS legacy_customer_id,
          RTRIM(s.UDF_S_370)  AS customer_name,
          s.UDF_S_507          AS amount,
          RTRIM(k.UDF_S_1478) AS phone,
          '转换单'             AS src_type,
          CAST(NULL AS NVARCHAR(30)) AS original_order_no
        FROM UDT_S_570 s
        LEFT JOIN UDT_S_311 k ON RTRIM(s.UDF_S_1485) = RTRIM(k.UDF_S_1475)
        WHERE RTRIM(s.UDF_S_1485) = @customerId
          AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
        UNION ALL
        SELECT
          RTRIM(s.UDF_S_372)  AS legacy_order_no,
          s.UDF_S_350          AS sale_date,
          RTRIM(s.UDF_S_348)  AS market_name,
          RTRIM(s.UDF_S_349)  AS store_name,
          RTRIM(s.UDF_S_1488) AS legacy_customer_id,
          RTRIM(s.UDF_S_370)  AS customer_name,
          s.UDF_S_507          AS amount,
          RTRIM(k.UDF_S_1478) AS phone,
          '回款单'             AS src_type,
          RTRIM(s.UDF_S_917)  AS original_order_no
        FROM UDT_S_261 s
        LEFT JOIN UDT_S_311 k ON RTRIM(s.UDF_S_1488) = RTRIM(k.UDF_S_1475)
        WHERE RTRIM(s.UDF_S_1488) = @customerId
          AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
        ORDER BY sale_date
      `)

    return result.recordset
      .map((r) => {
        const legacyOrderNo = trim(r.legacy_order_no)
        if (!legacyOrderNo) return null
        const saleDate =
          r.sale_date instanceof Date
            ? r.sale_date.toISOString()
            : String(r.sale_date ?? new Date().toISOString())
        return {
          legacyOrderNo,
          saleDate,
          marketName: trim(r.market_name),
          storeName: trim(r.store_name),
          customerName: trim(r.customer_name),
          amount: normalizeWorkfineAmount(r.amount),
          legacyCustomerId: trim(r.legacy_customer_id),
          phone: trim(r.phone),
          sourceType: r.src_type,
          originalOrderNo: trim(r.original_order_no),
        } satisfies WorkfineOrder
      })
      .filter((x): x is WorkfineOrder => x !== null)
  })
}
