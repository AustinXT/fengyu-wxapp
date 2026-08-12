import { notFound } from 'next/navigation'
import { getTransferOrderById } from '@/actions/inventory/transfer'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import InventoryDetailView from '../../_components/inventory-detail-view'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  requireUiPageCapability(await getSession(), 'inventory:list')
  const order = await getTransferOrderById(id)
  if (!order) notFound()
  return <InventoryDetailView category="transfer" title={`门店调拨 ${order.id}`} order={order} />
}
