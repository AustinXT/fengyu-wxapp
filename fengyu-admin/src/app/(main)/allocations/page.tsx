import { getOrdersPaginated } from '@/actions/orders'
import { getServiceOrdersPaginated } from '@/actions/services'
import AllocationsPageClient from './_components/allocations-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const tab = params.tab || 'sale'
  const page = params.page ? Number(params.page) : undefined
  const pageSize = params.size ? Number(params.size) : undefined

  if (tab === 'service') {
    const { data: serviceOrders, total } = await getServiceOrdersPaginated({
      status: '已完成',
      page,
      pageSize,
    })
    return <AllocationsPageClient tab="service" serviceOrders={serviceOrders} serviceTotal={total} />
  }

  const { data: orders, total } = await getOrdersPaginated({
    status: '已支付',
    page,
    pageSize,
  })
  return <AllocationsPageClient tab="sale" orders={orders} saleTotal={total} />
}
