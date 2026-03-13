import { getAppointments } from '@/actions/appointments'
import AppointmentsPageClient from './_components/appointments-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const appointments = await getAppointments()
  return <AppointmentsPageClient appointments={appointments} />
}
