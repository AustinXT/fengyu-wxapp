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

  // "美容师"身份按 skills 数组判定，不按 position_name —— 因为店长 / 高级美容师 / 资深美容师
  // 等岗位的人也可能在技能上标"美容师"对外接单，反之新人挂"美容师"岗位但 skills 为空也不应入选。
  // 与 staffApi/routes/mgmt-dashboard.js 的 `s.skills && ARRAY['美容师','养生师']::text[]` 同源约定。
  const rows = await pg.query(`
    SELECT
      employee_id AS staff_id,
      name,
      position_name AS position,
      phone,
      avatar_url,
      skills
    FROM staff_wechat_users
    WHERE store_id = $1
      AND is_resigned = false
      AND '美容师' = ANY(skills)
    ORDER BY name
  `, [storeId])

  const staffList = rows.map(r => ({
    staff_id: r.staff_id,
    name: r.name,
    position: r.position,
    phone: r.phone,
    avatarUrl: r.avatar_url || null,
  }))

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
      mainStaffAvatarUrl: null,
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
      position_name AS position,
      avatar_url
    FROM staff_wechat_users
    WHERE employee_id = $1 AND is_resigned = false
  `, [mainStaffId])

  ctx.result = {
    mainStaffId,
    mainStaffName: staffList.length > 0 ? staffList[0].name : null,
    mainStaffPosition: staffList.length > 0 ? staffList[0].position : null,
    mainStaffAvatarUrl: staffList.length > 0 ? (staffList[0].avatar_url || null) : null,
    storeName
  }
}

/**
 * 美容师详情
 * 包含服务次数和忙碌状态
 */
async function detail(ctx) {
  const { employeeId } = ctx.event.payload || {}
  if (!employeeId) throw new Error('INVALID_PARAMS: 缺少 employeeId')

  // Basic info
  const staffRows = await pg.query(`
    SELECT s.employee_id, s.name, s.position_name, s.skills, s.gender, s.avatar_url,
           s.store_id, st.store_name
    FROM staff_wechat_users s
    LEFT JOIN stores st ON s.store_id = st.store_id
    WHERE s.employee_id = $1 AND s.is_resigned = false
  `, [employeeId])

  if (staffRows.length === 0) throw new Error('INVALID_PARAMS: 美容师不存在')

  const staff = staffRows[0]

  // Service count + today's active appointments (parallel)
  const [countRows, todayRows] = await Promise.all([
    pg.query(
      "SELECT COUNT(*)::int AS count FROM service_orders WHERE assigned_employee_id = $1 AND status = '已完成'",
      [employeeId]
    ),
    pg.query(
      "SELECT COUNT(*)::int AS count FROM appointments WHERE employee_id = $1 AND appointment_time::date = CURRENT_DATE AND status IN ('待确认', '已确认')",
      [employeeId]
    ),
  ])

  ctx.result = {
    employeeId: staff.employee_id,
    name: staff.name,
    position: staff.position_name,
    skills: staff.skills || [],
    gender: staff.gender,
    avatarUrl: staff.avatar_url || null,
    storeId: staff.store_id,
    storeName: staff.store_name,
    serviceCount: countRows[0]?.count || 0,
    isBusy: (todayRows[0]?.count || 0) > 0,
    todayAppointments: todayRows[0]?.count || 0,
  }
}

module.exports = {
  list,
  defaultStaff,
  detail
}
