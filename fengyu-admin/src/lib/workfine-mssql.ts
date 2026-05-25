/**
 * WorkFine MSSQL 只读客户端（仅供 admin manual pull 历史订单使用）
 *
 * 严格只读，所有查询用参数化 input，不允许任何 INSERT/UPDATE/DELETE。
 * 模块级 lazy singleton 连接池，跨 Next.js HMR 用 globalThis 复用。
 *
 * 测试夹具：设置 MOCK_WORKFINE=1 可走 fixtures 而不连真 MSSQL。
 */

import mssql from 'mssql'

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

const MSSQL_CONFIG: mssql.config = {
  user: PARSED.user || process.env.MSSQL_USER || 'admin',
  password: PARSED.password || process.env.MSSQL_PASSWORD || '',
  database: PARSED.database || process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: PARSED.server || process.env.MSSQL_SERVER || '47.96.87.33',
  port: PARSED.port || parseInt(process.env.MSSQL_PORT || '1433', 10),
  pool: { max: 3, min: 0, idleTimeoutMillis: 30_000 },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  requestTimeout: 30_000,
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
    g.__workfineMssqlPoolPromise = null
    return pool
  })()
  return g.__workfineMssqlPoolPromise
}

function trim(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
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
    // 与 fengyu-admin/tests/e2e-chains/_helpers/seed-scope-fixtures.sql 一致，
    // 选 e2e 测试 PG 中真实存在的 store_name，否则 import 时会被 skippedNoStore=1 跳过。
    storeName: '南昌旗舰店',
    customerName: '测试顾客 A',
    amount: 998,
    legacyCustomerId: 'WF-MOCK-001',
    phone: '13800138000',
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

  const pool = await getPool()
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

  const pool = await getPool()
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
}

/**
 * 按 WorkFine 顾客编号拉该顾客全部销售订单。
 * SELECT shape 与 db/scripts/import-workfine-legacy.js 一致（4 字段最小化），
 * 仅 WHERE 改为参数化按 customer_id。
 */
export async function queryOrdersByCustomerId(customerId: string): Promise<WorkfineOrder[]> {
  const normalized = trim(customerId)
  if (!normalized) return []
  if (USE_MOCK) return MOCK_ORDERS.filter((o) => o.legacyCustomerId === normalized)

  const pool = await getPool()
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
    }>(`
      SELECT
        RTRIM(s.UDF_S_372)  AS legacy_order_no,
        s.UDF_S_350          AS sale_date,
        RTRIM(s.UDF_S_348)  AS market_name,
        RTRIM(s.UDF_S_349)  AS store_name,
        RTRIM(s.UDF_S_1485) AS legacy_customer_id,
        RTRIM(s.UDF_S_370)  AS customer_name,
        s.UDF_S_507          AS amount,
        RTRIM(k.UDF_S_1478) AS phone
      FROM UDT_S_209 s
      LEFT JOIN UDT_S_311 k ON RTRIM(s.UDF_S_1485) = RTRIM(k.UDF_S_1475)
      WHERE RTRIM(s.UDF_S_1485) = @customerId
        AND s.UDF_S_372 IS NOT NULL AND RTRIM(s.UDF_S_372) != ''
      ORDER BY s.UDF_S_350
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
        amount: typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount)) || 0,
        legacyCustomerId: trim(r.legacy_customer_id),
        phone: trim(r.phone),
      } satisfies WorkfineOrder
    })
    .filter((x): x is WorkfineOrder => x !== null)
}
