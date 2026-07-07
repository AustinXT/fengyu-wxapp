import { getStores } from '@/actions/stores'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRechargeConfig } from '@/actions/cards'
import { mergeEmployeesById } from '@/lib/merge-employees'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'


export default async function Page() {
  const [stores, scopedEmployees, tripEmployees, rechargeConfig] = await Promise.all([
    getStores(),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRechargeConfig().catch(() => null),
  ])
  
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)
  return <OrderCreatePageClient stores={stores} employees={employees} rechargeConfig={rechargeConfig} />
}
