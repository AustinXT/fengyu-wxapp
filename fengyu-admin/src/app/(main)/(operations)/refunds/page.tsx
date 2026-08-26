import { listRefunds } from '@/actions/refunds'
import RefundsPageClient from './_components/refunds-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const rawStatus = params.status
  const status =
    rawStatus === '待审批' || rawStatus === '已支付' || rawStatus === '已关闭'
      ? rawStatus
      : undefined

  const result = await listRefunds({
    status,
    q: params.q,
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  })

  return (
    <RefundsPageClient
      refunds={result.refunds}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
    />
  )
}
