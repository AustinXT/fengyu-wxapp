import { getBeautyOperatingProgress } from '@/actions/operating-targets'
import { OperatingView } from './view'
export const dynamic = 'force-dynamic'
export default async function Page() {
  return <OperatingView initial={await getBeautyOperatingProgress({ dimension: 'personal' })} dimension="personal" />
}
