import { notFound } from 'next/navigation'
import { getSaleOrderById } from '@/actions/inventory/sale'
import InventoryDetailView from '../../_components/inventory-detail-view'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const order = await getSaleOrderById(id)
  if (!order) notFound()
  return <InventoryDetailView category="sale" title={`销售出库 ${order.id}`} order={order} />
}
