/**
 * 门店模块路由
 * 从 WorkFine 查询门店列表(只读)
 */

const mssql = require('../db/mssql')
const sql = require('mssql')

/**
 * 门店列表
 * 从 WorkFine UDT_M_219 查询,排除已停止营业的门店及市场/管理中心
 */
async function list(ctx) {
  const sql = `
    SELECT
      UDF_M_437 AS market_name,
      UDF_M_438 AS store_name,
      UDF_M_1777 AS open_date,
      UDF_M_8590 AS available_beds,
      UDF_M_12033 AS store_region
    FROM UDT_M_219
    WHERE UDF_M_11956 != '是'
      AND UDF_M_437 NOT IN ('市场', '管理中心')
    ORDER BY UDF_M_437, UDF_M_438
  `

  const stores = await mssql.query(sql)

  ctx.result = {
    stores
  }
}

/**
 * 门店详情
 * 按 storeName 查询单条门店记录
 */
async function detail(ctx) {
  const { storeName } = ctx.event.payload || {}
  if (!storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeName')
  }

  const pool = await mssql.getPool()
  const result = await pool.request()
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
    `)

  if (!result.recordset || result.recordset.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在')
  }

  ctx.result = {
    store: result.recordset[0]
  }
}

module.exports = {
  list,
  detail
}
