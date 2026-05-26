import type { Employee } from '@/lib/types'

/**
 * 按 employeeId 去重合并多个员工列表，保留首次出现的记录，结果按 name 升序。
 * 用于营业额/服务提成分配页把 scope 内员工与全公司品项老师候选池合并。
 */
export function mergeEmployeesById(...lists: Employee[][]): Employee[] {
  const map = new Map<string, Employee>()
  for (const list of lists) {
    for (const e of list) {
      if (!map.has(e.employeeId)) map.set(e.employeeId, e)
    }
  }
  return [...map.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}
