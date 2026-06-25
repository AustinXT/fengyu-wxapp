import { getPendingPayments } from '@/actions/allocations'
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

  // 销售提成改「回款维度」：按每笔回款（sale_payment_id）逐笔分配。
  // getPendingPayments 仅认 待分配/已分配 两态（缺省=待分配），且不支持日期区间过滤。
  const { data: payments, total } = await getPendingPayments({
    allocationStatus:
      allocStatus === '已分配' ? '已分配' : allocStatus === '待分配' ? '待分配' : undefined,
    storeId,
    search,
    page,
    pageSize,
  })
  return (
    <AllocationsPageClient
      tab="sale"
      stores={stores}
      payments={payments}
      saleTotal={total}
    />
  )
}
