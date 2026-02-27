/**
 * 员工模块路由（员工端）
 * staff.list — 门店员工列表
 * staff.departments — 部门列表（含可分配员工）
 */

const mssql = require('../db/mssql')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 员工列表
 * 从 WorkFine UDT_S_287 查询指定门店的在职员工
 * 美容师不可看到客户完整手机号，此接口不返回手机号
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeName } = ctx.event.payload || {}

  // 默认用当前员工的门店
  const targetStore = storeName || ctx.auth.storeName
  if (!targetStore) {
    throw new Error('INVALID_PARAMS: 缺少 storeName 参数')
  }

  const esc = (v) => String(v).replace(/'/g, "''")

  const staffRows = await mssql.query(`
    SELECT
      UDF_S_1147 AS staff_wf_id,
      UDF_S_1155 AS name,
      UDF_S_1161 AS position,
      UDF_S_1513 AS department,
      UDF_S_1163 AS store_name,
      UDF_S_1160 AS market_name
    FROM UDT_S_287
    WHERE UDF_S_1624 NOT IN ('是', '离职')
      AND UDF_S_1163 = '${esc(targetStore)}'
    ORDER BY UDF_S_1513, UDF_S_1155
  `)

  ctx.result = {
    staffList: staffRows.map(r => ({
      staffWfId: r.staff_wf_id,
      name: r.name ? r.name.trim() : '',
      position: r.position ? r.position.trim() : '',
      department: r.department ? r.department.trim() : '',
      storeName: r.store_name ? r.store_name.trim() : '',
      marketName: r.market_name ? r.market_name.trim() : '',
      isManager: r.position === '门店经理'
    }))
  }
}

/**
 * 部门列表（含可分配业绩员工）
 * 用于营业额分配界面的员工选择
 * 按部门分组返回员工列表
 */
async function departments(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeName } = ctx.event.payload || {}
  const targetStore = storeName || ctx.auth.storeName

  if (!targetStore) {
    throw new Error('INVALID_PARAMS: 缺少 storeName 参数')
  }

  const esc = (v) => String(v).replace(/'/g, "''")

  // 查询美容部（含店长）
  const beautyRows = await mssql.query(`
    SELECT
      UDF_S_1147 AS staff_wf_id,
      UDF_S_1155 AS name,
      UDF_S_1161 AS position,
      UDF_S_1513 AS department
    FROM UDT_S_287
    WHERE UDF_S_1624 NOT IN ('是', '离职')
      AND UDF_S_1163 = '${esc(targetStore)}'
      AND UDF_S_1513 = '美容部'
    ORDER BY UDF_S_1155
  `)

  // 查询其他部门（推广部等，按市场查询）
  // 推广部等从市场维度查询，不限门店
  const marketName = ctx.auth.marketName
  let otherDeptRows = []

  if (marketName) {
    otherDeptRows = await mssql.query(`
      SELECT
        UDF_S_1147 AS staff_wf_id,
        UDF_S_1155 AS name,
        UDF_S_1161 AS position,
        UDF_S_1513 AS department,
        UDF_S_1163 AS store_name
      FROM UDT_S_287
      WHERE UDF_S_1624 NOT IN ('是', '离职')
        AND UDF_S_1160 = '${esc(marketName)}'
        AND UDF_S_1513 != '美容部'
        AND UDF_S_1513 IS NOT NULL
        AND UDF_S_1513 != ''
      ORDER BY UDF_S_1513, UDF_S_1155
    `)
  }

  // 按部门分组
  const deptMap = {}

  // 美容部
  if (beautyRows.length > 0) {
    deptMap['美容部'] = beautyRows.map(r => ({
      staffWfId: r.staff_wf_id,
      name: r.name ? r.name.trim() : '',
      position: r.position ? r.position.trim() : '',
      department: '美容部'
    }))
  }

  // 其他部门
  for (const r of otherDeptRows) {
    const dept = r.department ? r.department.trim() : '其他'
    if (!deptMap[dept]) deptMap[dept] = []
    deptMap[dept].push({
      staffWfId: r.staff_wf_id,
      name: r.name ? r.name.trim() : '',
      position: r.position ? r.position.trim() : '',
      department: dept,
      storeName: r.store_name ? r.store_name.trim() : ''
    })
  }

  const departments = Object.entries(deptMap).map(([name, members]) => ({
    departmentName: name,
    members
  }))

  ctx.result = { departments }
}

module.exports = { list, departments }
