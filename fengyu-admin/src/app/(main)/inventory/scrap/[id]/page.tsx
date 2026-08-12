import { notFound } from 'next/navigation'
import { getScrapOrderById } from '@/actions/inventory/scrap'
import { getSession } from '@/lib/auth'
import { requireUiPageCapability } from '@/lib/page-capability'
import InventoryDetailView from '../../_components/inventory-detail-view'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  requireUiPageCapability(await getSession(), 'inventory:list')
  const order = await getScrapOrderById(id)
  if (!order) notFound()
  return <InventoryDetailView category="scrap" title={`报损出库 ${order.id}`} order={order} />
}
