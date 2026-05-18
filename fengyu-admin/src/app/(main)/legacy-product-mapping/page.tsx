import { Suspense } from 'react'
import { listLegacyProductMappings } from '@/actions/legacy-product-mapping'
import LegacyProductMappingPageClient from './_components/legacy-product-mapping-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const sourceParam = params.source
  const source =
    sourceParam === 'ai_inferred' ||
    sourceParam === 'business_confirmed' ||
    sourceParam === 'manual_override'
      ? sourceParam
      : undefined

  const { data, total } = await listLegacyProductMappings({
    search: params.q,
    source,
    onlyUnmapped: params.unmapped === '1',
    onlyUnconfirmed: params.unconfirmed === '1',
    page: params.page ? Number(params.page) : undefined,
    pageSize: params.size ? Number(params.size) : undefined,
  })

  return (
    <Suspense>
      <LegacyProductMappingPageClient initialRows={data} initialTotal={total} />
    </Suspense>
  )
}
