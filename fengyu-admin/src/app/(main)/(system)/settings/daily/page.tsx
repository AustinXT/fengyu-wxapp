import { getDailyConfiguration } from '@/actions/daily-config'
import DailyConfiguration from './configuration'
export const dynamic = 'force-dynamic'
export default async function Page() {
  return <DailyConfiguration initial={await getDailyConfiguration()} />
}
