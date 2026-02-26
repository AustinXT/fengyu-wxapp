/**
 * 门店模块路由
 * 从 WorkFine 查询门店列表(只读)
 */

const mssql = require('../db/mssql')
const sql = require('mssql')

/**
 * 格式化开业时间: datetime → "yyyy年M月"
 */
function formatOpenDate(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

/**
 * 门店列表
 * 从 WorkFine UDT_M_219 查询,排除已停止营业的门店及市场/管理中心
 */
async function list(ctx) {
  const querySql = `
    SELECT
      UDF_M_437 AS market_name,
      UDF_M_438 AS store_name,
      UDF_M_1777 AS open_date,
      UDF_M_8590 AS available_beds,
      UDF_M_12033 AS store_region
    FROM UDT_M_219
    WHERE UDF_M_11956 != '是'
      AND UDF_M_437 NOT IN ('市场', '管理中心')
      AND UDF_M_438 NOT LIKE '%市场'
      AND UDF_M_438 NOT LIKE '%管理中心'
    ORDER BY UDF_M_437, UDF_M_438
  `

  const stores = await mssql.query(querySql)

  stores.forEach(s => {
    s.open_date = formatOpenDate(s.open_date)
  })

  ctx.result = {
    stores
  }
}

/**
 * 门店详情
 * 按 storeName 查询单条门店记录，并行查询员工数和顾客数
 */
async function detail(ctx) {
  const { storeName } = ctx.event.payload || {}
  if (!storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeName')
  }

  const pool = await mssql.getPool()

  // 并行查询：门店基本信息、在职员工数、顾客数
  const [storeResult, staffResult, customerResult] = await Promise.all([
    pool.request()
      .input('storeName', sql.NVarChar, storeName)
      .query(`
        SELECT TOP 1
          UDF_M_437 AS market_name,
          UDF_M_438 AS store_name,
          UDF_M_1777 AS open_date,
          UDF_M_8590 AS available_beds,
          UDF_M_12033 AS store_region
        FROM UDT_M_219
        WHERE UDF_M_11956 != '是'
          AND UDF_M_438 = @storeName
      `),
    pool.request()
      .input('storeName', sql.NVarChar, storeName)
      .query(`
        SELECT COUNT(*) AS staff_count
        FROM UDT_S_287
        WHERE UDF_S_1163 = @storeName
          AND UDF_S_1624 = '否'
      `),
    pool.request()
      .input('storeName', sql.NVarChar, storeName)
      .query(`
        SELECT COUNT(*) AS customer_count
        FROM UDT_S_311
        WHERE UDF_S_6443 = @storeName
      `)
  ])

  if (!storeResult.recordset || storeResult.recordset.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在')
  }

  const store = storeResult.recordset[0]
  store.open_date = formatOpenDate(store.open_date)
  store.staff_count = staffResult.recordset[0]?.staff_count || 0
  store.customer_count = customerResult.recordset[0]?.customer_count || 0

  ctx.result = {
    store
  }
}

module.exports = {
  list,
  detail
}
