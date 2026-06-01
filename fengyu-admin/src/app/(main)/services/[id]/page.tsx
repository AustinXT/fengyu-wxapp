import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems } from '@/actions/services'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import ServiceDetailPageClient from '../_components/service-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  const [serviceOrder, serviceItems] = await Promise.all([
    getServiceOrderById(id),
    getServiceItems(id),
  ])

  if (!serviceOrder) notFound()

  // 物理删除服务单：仅系统管理员（service:delete）
  const canDelete = !!(session && hasPermission(session, 'service:delete'))

  return <ServiceDetailPageClient serviceOrder={serviceOrder} serviceItems={serviceItems} canDelete={canDelete} />
}
