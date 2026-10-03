import { getOperatingProgress } from '@/actions/operating-targets'
import { OperatingView } from './view'
export const dynamic = 'force-dynamic'
export default async function Page() {
  return <OperatingView initial={await getOperatingProgress()} />
}
