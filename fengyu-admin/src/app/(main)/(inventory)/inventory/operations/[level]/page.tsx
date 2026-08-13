import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import { listInventoryLocations } from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import {
  INVENTORY_BUSINESS_LEVELS,
  genericDocBusinessLevel,
  inventoryBusinessLocationType,
  requireInventoryBusinessLevel,
  type InventoryBusinessLevel,
} from '@/lib/inventory/business-level'
import { INVENTORY_GENERIC_DOC_TYPES, type InventoryDocType } from '@/lib/inventory/types'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryOperationsPage from '../../_components/inventory-operations-page'
import InventoryDocsPage from '../../_components/inventory-docs-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ level: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { level: rawLevel } = await params
  const query = await searchParams
  if (!INVENTORY_BUSINESS_LEVELS.includes(rawLevel as InventoryBusinessLevel)) notFound()
  const level = rawLevel as InventoryBusinessLevel
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  requireInventoryBusinessLevel(session, level)
  const createType = query.create as InventoryDocType | undefined
  const validCreateType = createType &&
    (INVENTORY_GENERIC_DOC_TYPES as readonly string[]).includes(createType) &&
    genericDocBusinessLevel(createType) === level
      ? createType
      : undefined
  const view = query.view === 'docs' || validCreateType ? 'docs' : 'operations'
  const page = query.page ? Number(query.page) : 1
  const pageSize = query.size ? Number(query.size) : 20
  const [locations, skus, suppliers, workflowDocs, recordDocs] = await Promise.all([
    listInventoryLocations(),
    listInventorySkus({ page: 1, pageSize: 100, onlyActive: true }),
    listInventorySuppliers({ onlyActive: true }),
    listInventoryCoreDocs({ page: 1, pageSize: 100 }),
    listInventoryCoreDocs({
      locationType: inventoryBusinessLocationType(level),
      docType: query.docType as never,
      status: query.status as never,
      keyword: query.q,
      page,
      pageSize,
    }),
  ])
  const actions = session.permissions.actions
  const allowedCreateDocTypes = INVENTORY_GENERIC_DOC_TYPES.filter(
    (docType) => genericDocBusinessLevel(docType) === level,
  )

  return (
    <div className="p-6">
      <div role="tablist" aria-label="库存业务" className="mb-5 flex border-b border-[var(--border)]">
        <Link
          href={`/inventory/operations/${level}`}
          role="tab"
          aria-selected={view === 'operations'}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${view === 'operations' ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-transparent text-[var(--muted-foreground)]'}`}
        >
          业务办理
        </Link>
        <Link
          href={`/inventory/operations/${level}?view=docs`}
          role="tab"
          aria-selected={view === 'docs'}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${view === 'docs' ? 'border-[var(--primary)] text-[var(--primary)]' : 'border-transparent text-[var(--muted-foreground)]'}`}
        >
          单据记录
        </Link>
      </div>
      <Suspense>
        {view === 'docs' ? (
          <InventoryDocsPage
            rows={recordDocs.data}
            total={recordDocs.total}
            locations={locations}
            skuOptions={skus.data}
            canCreate={hasUiCapability(actions, 'inventory:create_doc')}
            canApprove={hasUiCapability(actions, 'inventory:approve')}
            canViewPrice={recordDocs.canViewPrice}
            initialDocType={validCreateType}
            lockedLevel={level}
            allowedCreateDocTypes={allowedCreateDocTypes}
          />
        ) : (
          <InventoryOperationsPage
            level={level}
            locations={locations}
            skuOptions={skus.data}
            suppliers={suppliers}
            workflowDocs={workflowDocs.data}
            canCreate={hasUiCapability(actions, 'inventory:create_doc')}
            canApprove={hasUiCapability(actions, 'inventory:approve')}
            canSelfPurchase={hasUiCapability(actions, 'inventory:self_purchase_receive')}
            canRequestShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_request')}
            canApproveShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_approve')}
            canViewPrice={workflowDocs.canViewPrice}
          />
        )}
      </Suspense>
    </div>
  )
}
