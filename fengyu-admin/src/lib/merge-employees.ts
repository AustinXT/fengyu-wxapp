import type { Employee } from '@/lib/types'


export function mergeEmployeesById(...lists: Employee[][]): Employee[] {
  const map = new Map<string, Employee>()
  for (const list of lists) {
    for (const e of list) {
      if (!map.has(e.employeeId)) map.set(e.employeeId, e)
    }
  }
  return [...map.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}
