import type { AllocationEmployeeCandidate } from '@/lib/types'
import { SERVICE_ORDER_ASSIGNABLE_SKILLS } from '@/lib/service-staff-skills'

/**
 * 服务单「服务人员」picker 的统一显示文案（issue #210）。
 *
 * 口径与员工端 `service-create.ts` 的 picker label **严格对齐**（验收标准第 2 条要求
 * admin 与 staff 的候选、排序、标签一致），格式：
 *   `姓名（角色·部门）（外援）`
 * - 角色取员工技能中命中白名单的项，按白名单顺序拼接（一人多技能时如「店经理/美容师」）
 * - 角色与部门都缺失时退化成「未分组」
 * - 本门店人员不加后缀；本门店所属市场内出差支援来的人员加「（外援）」，
 *   便于店长核对营业额分配时一眼分辨
 *
 * 开单（销售单）指定美容师仍走 `order-service-staff.ts` 的 formatOrderServiceStaffOption，
 * 那条路径的候选恒为本店人员，没有外援概念，口径不变。
 */
export function formatServiceStaffOption(
  candidate: Pick<
    AllocationEmployeeCandidate,
    'employeeId' | 'name' | 'skills' | 'departmentName' | 'assignmentScope'
  >,
): string {
  // 档案缺姓名时兜底工号，避免渲染出无法分辨的空白项
  const name = candidate.name?.trim() || candidate.employeeId
  const roleTag = SERVICE_ORDER_ASSIGNABLE_SKILLS
    .filter((skill) => candidate.skills?.includes(skill))
    .join('/')
  const group = [roleTag, candidate.departmentName?.trim()].filter(Boolean).join('·') || '未分组'
  // 判「truthy 且非 local」而不是「!== 'local'」：字段缺失时按「不是外援」处理，
  // 与员工端 supportTag 同义，避免同一候选在两端一个标外援一个不标
  const suffix = candidate.assignmentScope && candidate.assignmentScope !== 'local' ? '（外援）' : ''
  return `${name}（${group}）${suffix}`
}
