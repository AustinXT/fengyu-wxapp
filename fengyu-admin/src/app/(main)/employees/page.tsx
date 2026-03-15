import { Suspense } from 'react'
import { getEmployees } from '@/actions/employees'
import { getStores } from '@/actions/stores'
import EmployeesPage from './_components/employees-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const [employees, stores] = await Promise.all([getEmployees(), getStores()])
  return (
    <Suspense>
      <EmployeesPage employees={employees} stores={stores} />
    </Suspense>
  )
}
