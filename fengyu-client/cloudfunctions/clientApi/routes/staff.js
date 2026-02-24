/**
 * 美容师模块路由
 * 从 WorkFine 查询美容师列表(只读)
 */

const mssql = require('../db/mssql')
const { requireFields } = require('../middleware/validate')

/**
 * 美容师列表
 * 从 WorkFine UDT_S_287 查询,按门店过滤在职美容师
 */
async function list(ctx) {
  const { storeName } = ctx.event.payload || {}

  // 参数校验
  if (!storeName) {
    throw new Error('INVALID_PARAMS: 缺少 storeName 参数')
  }

  const sql = `
    SELECT
      UDF_S_1147 AS staff_id,
      UDF_S_1155 AS name,
      UDF_S_1163 AS store_name,
      UDF_S_1161 AS position,
      UDF_S_1513 AS department,
      UDF_S_1152 AS phone
    FROM UDT_S_287
    WHERE UDF_S_1624 = '否'
      AND UDF_S_1163 = '${storeName.replace(/'/g, "''")}'
      AND (UDF_S_1513 = '美容部' OR UDF_S_1161 = '美容师')
    ORDER BY UDF_S_1155
  `

  const staffList = await mssql.query(sql)

  ctx.result = {
    staffList
  }
}

module.exports = {
  list
}
