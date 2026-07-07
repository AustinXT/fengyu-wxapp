

const pg = require('../db/pg')


async function list(ctx) {
  const { storeId } = ctx.event.payload || {}

  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  
  
  
  
  const rows = await pg.query(`
    SELECT
      sw.employee_id AS staff_id,
      sw.name,
      sw.position_name AS position,
      sw.phone,
      sw.avatar_url,
      sw.skills,
      to_char(sw.leave_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS leave_start,
      to_char(sw.leave_end,   'YYYY-MM-DD"T"HH24:MI:SS') AS leave_end,
      r.avg_rating,
      r.review_count
    FROM staff_wechat_users sw
    LEFT JOIN (
      SELECT employee_id,
             ROUND(AVG(rating)::numeric, 1) AS avg_rating,
             COUNT(*)::int AS review_count
      FROM service_reviews
      GROUP BY employee_id
    ) r ON r.employee_id = sw.employee_id
    WHERE sw.store_id = $1
      AND sw.is_resigned = false
      AND sw.skills && ARRAY['美容师','养生师']::text[]
    ORDER BY sw.name
  `, [storeId])

  const staffList = rows.map(r => ({
    staff_id: r.staff_id,
    name: r.name,
    position: r.position,
    skills: r.skills || [],
    phone: r.phone,
    avatarUrl: r.avatar_url || null,
    
    leaveStart: r.leave_start || null,
    leaveEnd: r.leave_end || null,
    avgRating: r.avg_rating !== null ? Number(r.avg_rating) : null,
    reviewCount: r.review_count || 0,
  }))

  ctx.result = { staffList }
}


async function defaultStaff(ctx) {
  const { userId, phone } = ctx.auth

  
  if (!phone) {
    ctx.result = {
      mainStaffId: null,
      mainStaffName: null,
      storeName: null
    }
    return
  }

  
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


async function detail(ctx) {
  const { employeeId } = ctx.event.payload || {}
  if (!employeeId) throw new Error('INVALID_PARAMS: 缺少 employeeId')

  
  const staffRows = await pg.query(`
    SELECT s.employee_id, s.name, s.position_name, s.skills, s.gender, s.avatar_url,
           s.store_id, st.store_name,
           to_char(s.leave_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS leave_start,
           to_char(s.leave_end,   'YYYY-MM-DD"T"HH24:MI:SS') AS leave_end
    FROM staff_wechat_users s
    LEFT JOIN stores st ON s.store_id = st.store_id
    WHERE s.employee_id = $1 AND s.is_resigned = false
  `, [employeeId])

  if (staffRows.length === 0) throw new Error('INVALID_PARAMS: 美容师不存在')

  const staff = staffRows[0]

  
  const [countRows, todayRows, reviewRows] = await Promise.all([
    pg.query(
      "SELECT COUNT(*)::int AS count FROM service_orders WHERE assigned_employee_id = $1 AND status = '已完成'",
      [employeeId]
    ),
    pg.query(
      "SELECT COUNT(*)::int AS count FROM appointments WHERE employee_id = $1 AND appointment_time::date = CURRENT_DATE AND status IN ('待确认', '已确认')",
      [employeeId]
    ),
    pg.query(
      "SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*)::int AS review_count FROM service_reviews WHERE employee_id = $1",
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
    
    leaveStart: staff.leave_start || null,
    leaveEnd: staff.leave_end || null,
    storeId: staff.store_id,
    storeName: staff.store_name,
    serviceCount: countRows[0]?.count || 0,
    isBusy: (todayRows[0]?.count || 0) > 0,
    todayAppointments: todayRows[0]?.count || 0,
    avgRating: reviewRows[0]?.avg_rating !== null && reviewRows[0]?.avg_rating !== undefined
      ? Number(reviewRows[0].avg_rating)
      : null,
    reviewCount: reviewRows[0]?.review_count || 0,
  }
}

module.exports = {
  list,
  defaultStaff,
  detail
}
