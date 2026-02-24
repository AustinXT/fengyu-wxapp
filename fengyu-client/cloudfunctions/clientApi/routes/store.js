/**
 * 门店模块路由
 * 从 WorkFine 查询门店列表(只读)
 */

const mssql = require('../db/mssql')

/**
 * 门店列表
 * 从 WorkFine UDT_M_219 查询,排除已停止营业的门店
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
    ORDER BY UDF_M_437, UDF_M_438
  `

  const stores = await mssql.query(sql)

  ctx.result = {
    stores
  }
}

module.exports = {
  list
}
