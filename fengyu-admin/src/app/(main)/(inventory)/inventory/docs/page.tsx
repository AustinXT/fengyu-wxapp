import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { getSession } from '@/lib/auth'
import { genericDocBusinessLevel } from '@/lib/inventory/business-level'
import { INVENTORY_GENERIC_DOC_TYPES, type InventoryDocType } from '@/lib/inventory/types'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryDocsPage from '../_components/inventory-docs-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const createType = params.create as InventoryDocType | undefined
  if (createType && (INVENTORY_GENERIC_DOC_TYPES as readonly string[]).includes(createType)) {
    const level = genericDocBusinessLevel(createType)
    if (level) redirect(`/inventory/operations/${level}?view=docs&create=${encodeURIComponent(createType)}`)
  }
  const page = params.page ? Number(params.page) : 1
  const pageSize = params.size ? Number(params.size) : 20
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  const docs = await listInventoryCoreDocs({
    locationId: params.location,
    locationType: params.level === 'supply-chain' ? '总部' : params.level === 'market' ? '市场' : params.level === 'store' ? '门店' : undefined,
    docType: params.docType as never,
    status: params.status as never,
    keyword: params.q,
    page,
    pageSize,
  })

  return (
    <div className="p-6">
      <Suspense>
        <InventoryDocsPage
          rows={docs.data}
          total={docs.total}
          locations={[]}
          skuOptions={[]}
          canCreate={false}
          canApprove={false}
          canViewPrice={docs.canViewPrice}
          readOnly
        />
      </Suspense>
    </div>
  )
}
