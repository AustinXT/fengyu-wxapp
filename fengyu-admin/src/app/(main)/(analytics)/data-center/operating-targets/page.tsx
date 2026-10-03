import { getOwnOperatingTarget } from '@/actions/operating-targets'
import { TargetEntry } from './view'
export const dynamic = 'force-dynamic'
export default async function Page() {
  return <TargetEntry initial={await getOwnOperatingTarget()} />
}
