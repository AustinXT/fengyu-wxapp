import { notFound } from 'next/navigation'
import { getProcurementOrderById } from '@/actions/inventory/procurement'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import InventoryDetailView from '../../_components/inventory-detail-view'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  requireUiPageCapability(await getSession(), 'inventory:list')
  const order = await getProcurementOrderById(id)
  if (!order) notFound()
  return (
    <InventoryDetailView category="procurement" title={`采购入库 ${order.id}`} order={order} />
  )
}
