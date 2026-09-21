/**
 * 员工指派资格分为三个显式场景：
 * - localOnly（默认）：仅本门店员工，用于开单等普通指派；
 * - allocationSupport：本门店员工或任意已开启出差支援的员工，仅用于营业额/服务提成分配；
 * - marketSupport：本门店员工，或「锚定市场 = 目标门店所属市场」且已开启出差支援的员工，
 *   用于服务单创建（issue #210：出差支援的养生师/品项老师也能接服务单）。
 *
 * 技能白名单按场景区分（不要就地改 DEFAULT）：
 * - 开单指定美容师仍限 DEFAULT_ASSIGNABLE_SKILLS 两项；
 * - 服务单扩至 SERVICE_ORDER_ASSIGNABLE_SKILLS 四项，数组顺序即候选列表的角色排序优先级。
 */

/** 开单等普通指派的服务技能白名单 */
const DEFAULT_ASSIGNABLE_SKILLS = ['美容师', '养生师']

/**
 * 服务单可指派的技能白名单（issue #210）。
 * ⚠️ 数组顺序即前端候选列表的角色排序优先级（店经理 → 美容师 → 养生师 → 品项老师），
 *    与 skill_tags.sort_order 当前取值一致；调序请同步 routes/staff.js 的 ORDER BY 注释。
 */
const SERVICE_ORDER_ASSIGNABLE_SKILLS = ['店经理', '美容师', '养生师', '品项老师']

/**
 * 员工「锚定市场」JOIN 片段：优先取门店父级市场；门店为空（直挂市场/部门节点，
 * 如各市场养生部、品项公司）时沿 org_nodes 向上取最近市场节点。依赖调用方把员工表别名为 u。
 *
 * ⚠️ 两处**刻意保留**的宽松语义（与既有 3 份分配候选副本一致，勿单边收紧造成漂移）：
 *   1. COALESCE 是「门店线优先、否则走个人组织节点线」，不是按 store_id IS NULL 二分 ——
 *      store_id 非空但该门店未挂组织节点时会回退到个人 org_node 线锚定。
 *      db/migrations/0009 的 inventory_sync_location_from_store 触发器强制门店必挂节点
 *      且父级为市场，故该回退分支在真实数据上不可达。
 *   2. 部门只支持**一层**：d.type='部门' 时只看其直接父级是市场还是门店，
 *      「部门挂部门」的深层嵌套会落到 ELSE NULL 被静默排除（生产 org_nodes 无此形态）。
 *
 * ⚠️ 跨端副本（**语义同义**；别名与操作数顺序按各端既有副本保留，
 * 漂移由 __tests__/routes/anchor-market-sql-snapshot.test.js 归一化后比对守护）：
 *   - fengyu-staff/cloudfunctions/staffApi/routes/allocation.js（营业额分配候选）
 *   - fengyu-staff/cloudfunctions/staffApi/routes/serviceCommission.js（服务提成候选）
 *   - fengyu-staff/cloudfunctions/staffApi/routes/staff.js（服务单候选，直接 require 本常量）
 *   - fengyu-admin/src/lib/employee-anchor-market-sql.ts + src/actions/employees.ts
 */
const EMPLOYEE_ANCHOR_MARKET_JOIN = `
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    LEFT JOIN org_nodes employee_org_parent ON employee_org_parent.id = d.parent_id
    LEFT JOIN org_nodes employee_market ON employee_market.id = COALESCE(
      so.parent_id,
      CASE
        WHEN d.type = '市场' THEN d.id
        WHEN d.type = '门店' THEN d.parent_id
        WHEN d.type = '部门' AND employee_org_parent.type = '市场' THEN employee_org_parent.id
        WHEN d.type = '部门' AND employee_org_parent.type = '门店' THEN employee_org_parent.parent_id
        ELSE NULL
      END
    ) AND employee_market.type = '市场'`

/**
 * 目标门店所属市场 JOIN 片段；storeParam 为目标门店的参数占位符（如 '$1'）。
 *
 * ⚠️ 全程 LEFT JOIN（既有分配候选副本用的是 INNER JOIN）：`stores.org_node_id` 在 schema 上可空，
 * 一旦目标门店没挂组织节点，INNER JOIN 会让整条查询返回 0 行 ——
 * 候选列表空事小，**校验侧会把本店员工也判成非法**，该门店服务单直接开不出来。
 * 用 LEFT JOIN 则 target_market.id 为 NULL，出差分支自然不成立，本店分支照常放行（优雅降级）。
 *
 * ⚠️ 第三条刻意保留的宽松语义：target_market **不加** `AND type='市场'` 守卫（employee_market 侧有）。
 * 与既有 3 份分配候选副本保持一致；org_nodes.id 唯一，最坏情况只是外援整体不出现，不会误放行。
 */
function targetMarketJoin(storeParam) {
  return `
    LEFT JOIN stores target_store ON target_store.store_id = ${storeParam}
    LEFT JOIN org_nodes target_store_node ON target_store_node.id = target_store.org_node_id
    LEFT JOIN org_nodes target_market ON target_market.id = target_store_node.parent_id`
}

/**
 * 「本店 ∪ 同市场出差支援」WHERE 条件；storeParam 为目标门店的参数占位符。
 * employee_market.id 为空（组织树上挂不到市场）的员工一律排除，避免 NULL = NULL 误放行。
 */
function marketSupportCondition(storeParam) {
  return `(u.store_id = ${storeParam} OR (u.is_on_business_trip = true
        AND employee_market.id IS NOT NULL AND employee_market.id = target_market.id))`
}

function rowsOf(result) {
  return Array.isArray(result) ? result : (result?.rows || [])
}

function normalizeScope(scope) {
  return scope === 'allocationSupport' || scope === 'marketSupport' ? scope : 'localOnly'
}

async function getAssignableEmployeeIds(queryable, employeeIds, targetStoreId, options = {}) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))]
  if (ids.length === 0) return new Set()

  const assignmentScope = normalizeScope(options.assignmentScope)
  // marketSupport 强制带技能过滤：候选侧一定按四项白名单筛，校验侧若不筛就比候选**宽松**，
  // 无服务技能的同市场出差员工能绕过前端直接提交。技能门控与白名单默认值必须对称。
  const requireServiceSkills = assignmentScope === 'marketSupport' || options.requireServiceSkills === true
  // 默认白名单跟着场景走：marketSupport（服务单）默认四项，其余默认两项。
  // 否则「传了 marketSupport 却忘了传 skills」会静默退回两项 → 前端选得到、提交被拒。
  const skills = Array.isArray(options.skills) && options.skills.length > 0
    ? options.skills
    : (assignmentScope === 'marketSupport' ? SERVICE_ORDER_ASSIGNABLE_SKILLS : DEFAULT_ASSIGNABLE_SKILLS)

  let joinSql = ''
  let assignmentCondition = 'u.store_id = $2'
  if (assignmentScope === 'allocationSupport') {
    assignmentCondition = '(u.store_id = $2 OR u.is_on_business_trip = true)'
  } else if (assignmentScope === 'marketSupport') {
    joinSql = `${EMPLOYEE_ANCHOR_MARKET_JOIN}${targetMarketJoin('$2')}`
    assignmentCondition = marketSupportCondition('$2')
  }

  const result = await queryable.query(`
    SELECT u.employee_id
    FROM staff_wechat_users u${joinSql}
    WHERE u.employee_id = ANY($1::text[])
      AND u.is_resigned = false
      AND ${assignmentCondition}
      AND ($3::boolean = false OR u.skills && $4::text[])
  `, [ids, targetStoreId, requireServiceSkills, skills])

  return new Set(rowsOf(result).map((row) => row.employee_id))
}

async function isEmployeeAssignableToStore(queryable, employeeId, targetStoreId, options = {}) {
  if (!employeeId || !targetStoreId) return false
  const validIds = await getAssignableEmployeeIds(queryable, [employeeId], targetStoreId, options)
  return validIds.has(employeeId)
}

// marketSupport 的拒因有两种（归属不符 / 技能不在白名单），查询无法区分，文案须同时覆盖，
// 否则技能不符的人被拒时会得到「未开启出差支援」这种指向错误的提示
const SCOPE_ERROR_MESSAGE = {
  localOnly: '所选员工不属于本门店',
  allocationSupport: '所选员工不属于本门店且未开启出差支援',
  marketSupport: '所选员工不可指派：须是本店人员或本门店所属市场内的出差支援人员，且具备服务技能标签',
}

async function assertEmployeesAssignableToStore(queryable, employeeIds, targetStoreId, options = {}) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))]
  if (ids.length === 0) return
  const validIds = await getAssignableEmployeeIds(queryable, ids, targetStoreId, options)
  const invalidId = ids.find((id) => !validIds.has(id))
  if (invalidId) {
    throw new Error(`INVALID_PARAMS: ${SCOPE_ERROR_MESSAGE[normalizeScope(options.assignmentScope)]}`)
  }
}

module.exports = {
  DEFAULT_ASSIGNABLE_SKILLS,
  SERVICE_ORDER_ASSIGNABLE_SKILLS,
  EMPLOYEE_ANCHOR_MARKET_JOIN,
  targetMarketJoin,
  marketSupportCondition,
  getAssignableEmployeeIds,
  isEmployeeAssignableToStore,
  assertEmployeesAssignableToStore,
}
