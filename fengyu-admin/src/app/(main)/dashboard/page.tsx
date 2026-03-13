import { getDashboardStats } from '@/actions/dashboard'
import DashboardPage from './_components/dashboard-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const stats = await getDashboardStats()
  return <DashboardPage stats={stats} />
}
