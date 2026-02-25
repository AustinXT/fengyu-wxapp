/**
 * 美容师模块路由
 * 从 WorkFine 查询美容师列表(只读)
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireFields } = require('../middleware/validate')

/**
 * 美容师列表
 * 从 WorkFine UDT_S_287 查询,在职美容师
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

/**
 * 获取默认美容师
 * 从顾客档案 UDT_S_311.UDF_S_6444 获取主美容师
 * 需要用户已绑定手机号
 */
async function defaultStaff(ctx) {
  const { phone } = ctx.auth

  // 未绑定手机号时直接返回空结果
  if (!phone) {
    ctx.result = {
      mainStaffId: null,
      mainStaffName: null,
      storeName: null
    }
    return
  }

  // 从顾客档案查询主美容师
  const customerSql = `
    SELECT
      UDF_S_6444 AS main_staff_id,
      UDF_S_6443 AS store_name
    FROM UDT_S_311
    WHERE UDF_S_1478 = '${phone.replace(/'/g, "''")}'
  `

  const customers = await mssql.query(customerSql)

  if (customers.length === 0) {
    // 顾客档案不存在,返回空
    ctx.result = {
      mainStaffId: null,
      mainStaffName: null,
      storeName: null
    }
    return
  }

  const mainStaffId = customers[0].main_staff_id
  const storeName = customers[0].store_name

  if (!mainStaffId) {
    // 未设置主美容师
    ctx.result = {
      mainStaffId: null,
      mainStaffName: null,
      storeName: storeName
    }
    return
  }

  // 查询美容师姓名
  const staffSql = `
    SELECT
      UDF_S_1147 AS staff_id,
      UDF_S_1155 AS name,
      UDF_S_1161 AS position
    FROM UDT_S_287
    WHERE UDF_S_1147 = '${mainStaffId.replace(/'/g, "''")}'
      AND UDF_S_1624 = '否'
  `

  const staffList = await mssql.query(staffSql)

  ctx.result = {
    mainStaffId: mainStaffId,
    mainStaffName: staffList.length > 0 ? staffList[0].name : null,
    mainStaffPosition: staffList.length > 0 ? staffList[0].position : null,
    storeName: storeName
  }
}

module.exports = {
  list,
  defaultStaff
}
