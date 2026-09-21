import { db } from '@/db'
import { sql } from 'drizzle-orm'
import {
  DEFAULT_ASSIGNABLE_SKILLS,
  EMPLOYEE_ANCHOR_MARKET_JOIN,
  SERVICE_ORDER_ASSIGNABLE_SKILLS,
  marketSupportCondition,
  targetMarketJoin,
} from '@/lib/employee-anchor-market-sql'

/**
 * 员工指派资格分为三个显式场景（与 staffApi utils/employee-assignment.js 同源）：
 * - localOnly（默认）：仅本门店员工，用于开单等普通指派；
 * - allocationSupport：本门店员工或任意已开启出差支援的员工，仅用于营业额/服务提成分配；
 * - marketSupport：本门店员工，或「锚定市场 = 目标门店所属市场」且已开启出差支援的员工，
 *   用于服务单创建（issue #210）。
 *
 * 技能白名单由 options.skills 传入（默认仅美容师/养生师），服务单场景须显式传四项白名单。
 */
export async function getInvalidEmployeeAssignmentId(
  employeeIds: string[],
  targetStoreId: string,
  options: {
    requireServiceSkills?: boolean
    assignmentScope?: 'localOnly' | 'allocationSupport' | 'marketSupport'
    skills?: string[]
  } = {},
): Promise<string | null> {
  const ids = [...new Set(employeeIds.filter(Boolean))]
  if (ids.length === 0) return null
  const employeeIdParams = sql.join(ids.map((id) => sql`${id}`), sql`, `)
  const isMarketSupport = options.assignmentScope === 'marketSupport'
  // marketSupport 强制带技能过滤：候选侧一定按四项白名单筛，校验侧若不筛就比候选**宽松**，
  // 无服务技能的同市场出差员工能绕过前端直接提交。技能门控与白名单默认值必须对称。
  const requireServiceSkills = isMarketSupport || options.requireServiceSkills === true
  // 默认白名单跟着场景走：marketSupport（服务单）默认四项，其余默认两项。
  // 否则「传了 marketSupport 却忘了传 skills」会静默退回两项 → 前端选得到、提交被拒。
  const skills = options.skills?.length
    ? options.skills
    : (isMarketSupport ? SERVICE_ORDER_ASSIGNABLE_SKILLS : DEFAULT_ASSIGNABLE_SKILLS)
  const anchorJoin = isMarketSupport
    ? sql`${EMPLOYEE_ANCHOR_MARKET_JOIN}${targetMarketJoin(targetStoreId)}`
    : sql``
  const assignmentCondition = isMarketSupport
    ? marketSupportCondition(targetStoreId)
    : options.assignmentScope === 'allocationSupport'
      ? sql`(u.store_id = ${targetStoreId} OR u.is_on_business_trip = true)`
      : sql`u.store_id = ${targetStoreId}`

  const rows = (await db.execute(sql`
    SELECT u.employee_id
    FROM staff_wechat_users u${anchorJoin}
    WHERE u.employee_id IN (${employeeIdParams})
      AND u.is_resigned = false
      AND ${assignmentCondition}
      AND (${requireServiceSkills} = false
        OR u.skills && ${sql.param(skills)}::text[])
  `)) as unknown as Array<{ employee_id: string }>

  const validIds = new Set(rows.map((row) => row.employee_id))
  return ids.find((id) => !validIds.has(id)) ?? null
}
