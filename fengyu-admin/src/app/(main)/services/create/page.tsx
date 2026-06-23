import { getStores } from '@/actions/stores'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { mergeEmployeesById } from '@/lib/merge-employees'
import ServiceCreatePageClient from '../_components/service-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [stores, scopedEmployees, tripEmployees] = await Promise.all([
    getStores(),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
  ])
  // 跨门店共享（2026-06-24）：scope 内员工 ∪ 全公司出差员工
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)

  return (
    <ServiceCreatePageClient
      stores={stores}
      employees={employees}
    />
  )
}
