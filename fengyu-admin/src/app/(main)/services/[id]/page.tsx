import { notFound } from 'next/navigation'
import { getServiceOrderById } from '@/actions/services'
import ServiceDetailPageClient from '../_components/service-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const serviceOrder = await getServiceOrderById(id)

  if (!serviceOrder) notFound()

  return <ServiceDetailPageClient serviceOrder={serviceOrder} />
}
