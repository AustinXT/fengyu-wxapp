import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems, getServiceReview } from '@/actions/services'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import ServiceDetailPageClient from '../_components/service-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  const [serviceOrder, serviceItems, serviceReview] = await Promise.all([
    getServiceOrderById(id),
    getServiceItems(id),
    getServiceReview(id),
  ])

  if (!serviceOrder) notFound()

  
  const canDelete = !!(session && isAdminScope(session))

  return <ServiceDetailPageClient serviceOrder={serviceOrder} serviceItems={serviceItems} serviceReview={serviceReview} canDelete={canDelete} />
}
