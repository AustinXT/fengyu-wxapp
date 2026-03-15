import { Suspense } from 'react'
import { getCustomersPaginated } from '@/actions/customers'
import { getStores } from '@/actions/stores'
import CustomersPageClient from './_components/customers-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const [{ data: customers, total }, stores] = await Promise.all([
    getCustomersPaginated({
      storeId: params.store,
      memberLevel: params.level,
      search: params.q,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getStores(),
  ])

  return (
    <Suspense>
      <CustomersPageClient customers={customers} stores={stores} total={total} />
    </Suspense>
  )
}
