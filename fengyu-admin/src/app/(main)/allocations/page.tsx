import { getOrdersPaginated } from '@/actions/orders'
import { getServiceOrdersPaginated } from '@/actions/services'
import { getStores } from '@/actions/stores'
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

  const allocStatus = params.allocStatus || undefined
  const storeId = params.store || undefined
  const dateFrom = params.from || undefined
  const dateTo = params.to || undefined
  const search = params.q || undefined

  const stores = await getStores()

  if (tab === 'service') {
    const { data: serviceOrders, total } = await getServiceOrdersPaginated({
      status: '已完成',
      commissionStatus: allocStatus,
      storeId,
      dateFrom,
      dateTo,
      search,
      page,
      pageSize,
    })
    return (
      <AllocationsPageClient
        tab="service"
        stores={stores}
        serviceOrders={serviceOrders}
        serviceTotal={total}
      />
    )
  }

  const { data: orders, total } = await getOrdersPaginated({
    status: '已支付',
    allocationStatus: allocStatus,
    storeId,
    dateFrom,
    dateTo,
    search,
    page,
    pageSize,
  })
  return (
    <AllocationsPageClient
      tab="sale"
      stores={stores}
      orders={orders}
      saleTotal={total}
    />
  )
}
