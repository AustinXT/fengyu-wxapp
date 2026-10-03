import { getOperatingPk } from '@/actions/operating-targets'
import { OperatingView } from '../operating-progress/view'
export const dynamic = 'force-dynamic'
export default async function Page() {
  return <OperatingView initial={await getOperatingPk()} pk />
}
