

import mssql from 'mssql'
import { WORKFINE_CONNECT_ERROR_MSG } from './workfine-constants'


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


const CONN_STRING = process.env.MSSQL_CONNECTION_STRING
const PARSED = CONN_STRING ? parseMssqlConnString(CONN_STRING) : {}






const CONNECT_TIMEOUT_MS = parseInt(process.env.MSSQL_CONNECT_TIMEOUT_MS || '8000', 10)
const REQUEST_TIMEOUT_MS = parseInt(process.env.MSSQL_REQUEST_TIMEOUT_MS || '10000', 10)

const MSSQL_CONFIG: mssql.config = {
  user: PARSED.user || process.env.MSSQL_USER || 'admin',
  password: PARSED.password || process.env.MSSQL_PASSWORD || '',
  database: PARSED.database || process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: PARSED.server || process.env.MSSQL_SERVER || '',
  port: PARSED.port || parseInt(process.env.MSSQL_PORT || '1433', 10),
  
  
  pool: { max: 3, min: 1, idleTimeoutMillis: 30_000, acquireTimeoutMillis: CONNECT_TIMEOUT_MS },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  connectionTimeout: CONNECT_TIMEOUT_MS,
  requestTimeout: REQUEST_TIMEOUT_MS,
}






const WORKFINE_UNAVAILABLE_LOG_MSG = `INVALID_STATE: WORKFINE_UNAVAILABLE: ${WORKFINE_CONNECT_ERROR_MSG}`


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
    
    
    g.__workfineMssqlPool = null
    g.__workfineMssqlPoolPromise = null
    console.error('[workfine-mssql] 连接 WorkFine MSSQL 失败', err)
    throw new WorkfineUnavailableError()
  } finally {
    
    if (g.__workfineMssqlPool) g.__workfineMssqlPoolPromise = null
  }
}


function resetPool(): void {
  const pool = g.__workfineMssqlPool
  g.__workfineMssqlPool = null
  g.__workfineMssqlPoolPromise = null
  if (pool) {
    pool.close().catch((err) => console.error('[workfine-mssql] pool.close 失败', err))
  }
}


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


function isFatalPoolError(err: unknown, pool: mssql.ConnectionPool): boolean {
  if (pool.connected) return false
  const name = (err as { name?: string } | null)?.name ?? ''
  return name.includes('ConnectionError') || name.includes('PoolError')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


const TRANSIENT_RETRY = 1

const TRANSIENT_RETRY_DELAY_MS = 200


async function runQuery<T>(fn: (pool: mssql.ConnectionPool) => Promise<T>): Promise<T> {
  
  const pool = await getPool()
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= TRANSIENT_RETRY; attempt++) {
    try {
      return await fn(pool)
    } catch (err) {
      if (err instanceof WorkfineUnavailableError) throw err
      lastErr = err
      
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
  
  sourceType: '销售单' | '转换单' | '回款单'
  
  originalOrderNo: string | null
}

const USE_MOCK = process.env.MOCK_WORKFINE === '1'


const MOCK_CUSTOMERS: WorkfineCustomer[] = [
  { customerId: 'WF-MOCK-001', name: '测试顾客 A', phone: '13800138000' },
  { customerId: 'WF-MOCK-002', name: '测试顾客 B', phone: '13800138001' },
]
const MOCK_ORDERS: WorkfineOrder[] = [
  {
    legacyOrderNo: 'WF-ORD-001',
    saleDate: '2023-06-15T10:00:00.000Z',
    marketName: '南昌市场',
    
    
    
    
    storeName: '南昌旗舰店（E2E）',
    customerName: '测试顾客 A',
    amount: 998,
    legacyCustomerId: 'WF-MOCK-001',
    phone: '13800138000',
    sourceType: '销售单',
    originalOrderNo: null,
  },
  
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
