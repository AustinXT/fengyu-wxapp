import { notFound } from 'next/navigation'
import { getServiceOrderById, getServiceItems, getServiceReview } from '@/actions/services'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireUiPageCapability } from '@/lib/page-capability'
import ServiceDetailPageClient from '../_components/service-detail-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getSession()
  requireUiPageCapability(session, 'service:list')
  const [serviceOrder, serviceItems, serviceReview] = await Promise.all([
    getServiceOrderById(id),
    getServiceItems(id),
    getServiceReview(id),
  ])

  if (!serviceOrder) notFound()

  // 物理删除服务单：仅系统管理员（service:delete）
  const canDelete = !!(session && hasUiCapability(session.permissions.actions, 'service:delete') && isAdminScope(session))

  return <ServiceDetailPageClient serviceOrder={serviceOrder} serviceItems={serviceItems} serviceReview={serviceReview} canDelete={canDelete} />
}
