import { getOrdersPaginated } from '@/actions/orders'
import AllocationsPageClient from './_components/allocations-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const { data: orders, total } = await getOrdersPaginated({
    status: '已支付',
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  })

  return <AllocationsPageClient orders={orders} total={total} />
}
