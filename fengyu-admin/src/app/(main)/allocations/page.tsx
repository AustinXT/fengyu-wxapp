import { getPendingPayments } from '@/actions/allocations'
import { getServiceOrdersPaginated } from '@/actions/services'
import { getMarketStoreFilterOptions } from '@/actions/stores'
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
  const marketId = params.market || undefined
  const storeId = params.store || undefined
  const dateFrom = params.from || undefined
  const dateTo = params.to || undefined
  const search = params.q || undefined

  const filterOptions = await getMarketStoreFilterOptions()

  if (tab === 'service') {
    const { data: serviceOrders, total } = await getServiceOrdersPaginated({
      status: '已完成',
      commissionStatus: allocStatus,
      marketId,
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
        filterOptions={filterOptions}
        serviceOrders={serviceOrders}
        serviceTotal={total}
      />
    )
  }

  // 销售提成「回款维度」：按每笔回款（sale_payment_id）逐笔分配。
  // allocationStatus 缺省=「全部状态」（已分配 + 待分配）；支持按下单日期区间过滤。
  const { data: payments, total } = await getPendingPayments({
    allocationStatus:
      allocStatus === '已分配' ? '已分配' : allocStatus === '待分配' ? '待分配' : undefined,
    marketId,
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
      filterOptions={filterOptions}
      payments={payments}
      saleTotal={total}
    />
  )
}
