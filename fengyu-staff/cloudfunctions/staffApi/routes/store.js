/**
 * 门店模块路由（员工端）
 * store.list — 从 WorkFine 查询营业中的门店
 */

const mssql = require('../db/mssql')

/**
 * 门店列表
 * 从 WorkFine UDT_M_219 查询营业中门店，带市场信息
 */
async function list(ctx) {
  const storeRows = await mssql.query(`
    SELECT
      UDF_M_437 AS market_name,
      UDF_M_438 AS store_name,
      UDF_M_1777 AS open_date,
      UDF_M_8590 AS bed_count
    FROM UDT_M_219
    WHERE (UDF_M_11956 IS NULL OR UDF_M_11956 != '是')
    ORDER BY UDF_M_437, UDF_M_438
  `)

  ctx.result = storeRows.map(r => ({
    storeId: r.store_name ? r.store_name.trim() : '',
    storeName: r.store_name ? r.store_name.trim() : '',
    marketName: r.market_name ? r.market_name.trim() : '',
  }))
}

module.exports = { list }
