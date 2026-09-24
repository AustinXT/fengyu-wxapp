import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import {
  listInventoryDocLocationFilterOptions,
  listInventoryLocations,
} from '@/actions/inventory/locations'
import { listInventorySkus } from '@/actions/inventory/skus'
import { getSession } from '@/lib/auth'
import { inventoryCreatableGenericDocTypes } from '@/lib/inventory/business-level'
import { resolveInventoryFilterLocationId } from '@/lib/inventory/location-filter'
import { type InventoryDocType } from '@/lib/inventory/types'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryDocsPage from '../_components/inventory-docs-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const page = params.page ? Number(params.page) : 1
  const pageSize = params.size ? Number(params.size) : 20
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])

  const actions = session.permissions.actions
  /*
   * 建单下拉走「本层级 ∪ scope 能向下展开的上级层级」的代建口径（#191，甲方 2026-09-21 拍板）。
   * 层级表的单源在 business-level.ts —— 这里不再手搓一份三元映射，否则服务端放开了
   * 代建，市场账号的下拉里还是看不到 5 种门店类型，等于什么都没发生。
   * 反过来也一样：总部 scope 不展开后代（access.ts 的 inventoryScopedOrgNodeIds），
   * 所以只有 supply_chain_operate 的账号这里只拿到「内部领用」一种，而不是 10 种里
   * 有 9 种点进去必 403 的死路。
   */
  const allowedCreateDocTypes = inventoryCreatableGenericDocTypes(
    (action) => hasUiCapability(actions, action),
  )
  /*
   * 收货**不随代建放开**：#191 放开的只是「替下级建单」，收货仍只认市场 / 门店自己的
   * operate 权限。别顺手把它也统一成 inventoryCreatableGenericDocTypes 那套层级函数 ——
   * 两者原本共用同一个 operateByLevel 对象，拆开正是为了让口径分叉显式可见。
   */
  const canReceive = hasUiCapability(actions, 'inventory:market_operate')
    || hasUiCapability(actions, 'inventory:store_operate')
  const requestedCreateType = params.create as InventoryDocType | undefined
  const initialDocType = requestedCreateType && allowedCreateDocTypes.includes(requestedCreateType)
    ? requestedCreateType
    : undefined

  const [filterOptions, locations, skus] = await Promise.all([
    listInventoryDocLocationFilterOptions(),
    allowedCreateDocTypes.length > 0 ? listInventoryLocations() : Promise.resolve([]),
    allowedCreateDocTypes.length > 0
      ? listInventorySkus({ page: 1, pageSize: 100, onlyActive: true })
      : Promise.resolve({ data: [], total: 0 }),
  ])
  const selectedOrgNodeId = resolveInventoryFilterLocationId(filterOptions, params.orgNodeId)
  const docs = selectedOrgNodeId
    ? await listInventoryCoreDocs({
        orgNodeId: selectedOrgNodeId,
        docType: params.docType as never,
        status: params.status as never,
        keyword: params.q,
        page,
        pageSize,
      })
    : {
        data: [],
        total: 0,
        canViewPrice: hasUiCapability(actions, 'inventory:supply_chain_price_view')
          || hasUiCapability(actions, 'inventory:market_price_view'),
      }

  return (
    <div className="p-6">
      <Suspense>
        <InventoryDocsPage
          rows={docs.data}
          total={docs.total}
          locations={locations}
          skuOptions={skus.data}
          canCreate={allowedCreateDocTypes.length > 0}
          canApprove={hasUiCapability(actions, 'inventory:supply_chain_approve') || hasUiCapability(actions, 'inventory:market_approve')}
          canReceive={canReceive}
          canViewPrice={docs.canViewPrice}
          initialDocType={initialDocType}
          allowedCreateDocTypes={allowedCreateDocTypes}
          locationFilterOptions={filterOptions}
          selectedOrgNodeId={selectedOrgNodeId}
        />
      </Suspense>
    </div>
  )
}
