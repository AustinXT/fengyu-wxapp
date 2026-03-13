/**
 * 美容师模块路由
 * 从 PG staff_wechat_users 查询美容师列表(只读)
 */

const pg = require('../db/pg')

/**
 * 美容师列表
 * 从 PG staff_wechat_users 查询在职美容师
 */
async function list(ctx) {
  const { storeId } = ctx.event.payload || {}

  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  const staffList = await pg.query(`
    SELECT
      employee_id AS staff_id,
      name,
      position_name AS position,
      phone
    FROM staff_wechat_users
    WHERE store_id = $1
      AND is_resigned = false
      AND position_name IN ('美容师', '高级美容师', '资深美容师')
    ORDER BY name
  `, [storeId])

  ctx.result = { staffList }
}

/**
 * 获取默认美容师
 * 从 client_wechat_users.bound_employee_id 获取绑定美容师
 * 需要用户已绑定手机号
 */
async function defaultStaff(ctx) {
  const { userId, phone } = ctx.auth

  // 未绑定手机号时直接返回空结果
  if (!phone) {
    ctx.result = {
      mainStaffId: null,
      mainStaffName: null,
      storeName: null
    }
    return
  }

  // 从 client_wechat_users 查询绑定美容师
  const customers = await pg.query(`
    SELECT
      u.bound_employee_id AS main_staff_id,
      u.bound_store_id,
      s.store_name
    FROM client_wechat_users u
    LEFT JOIN stores s ON u.bound_store_id = s.store_id
    WHERE u.user_id = $1
  `, [userId])

  if (customers.length === 0 || !customers[0].main_staff_id) {
    ctx.result = {
      mainStaffId: null,
      mainStaffName: null,
      storeName: customers.length > 0 ? customers[0].store_name : null
    }
    return
  }

  const mainStaffId = customers[0].main_staff_id
  const storeName = customers[0].store_name

  // 查询美容师信息
  const staffList = await pg.query(`
    SELECT
      employee_id AS staff_id,
      name,
      position_name AS position
    FROM staff_wechat_users
    WHERE employee_id = $1 AND is_resigned = false
  `, [mainStaffId])

  ctx.result = {
    mainStaffId,
    mainStaffName: staffList.length > 0 ? staffList[0].name : null,
    mainStaffPosition: staffList.length > 0 ? staffList[0].position : null,
    storeName
  }
}

module.exports = {
  list,
  defaultStaff
}
