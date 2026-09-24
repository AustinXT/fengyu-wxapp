import { Suspense } from 'react'
import { listInventoryCoreDocs } from '@/actions/inventory/docs'
import {
  listInventoryDocLocationFilterOptions,
  listInventoryLocations,
  listInventoryMarketTransferTargets,
} from '@/actions/inventory/locations'
import { getSession } from '@/lib/auth'
import { scopeSessionToActions } from '@/lib/action-scope'
import { inventoryScopedOrgNodeIds } from '@/lib/inventory/access'
import { INVENTORY_CORE_RECEIVE_ACTIONS, inventoryCreatableGenericDocTypes } from '@/lib/inventory/business-level'
import { resolveInventoryFilterLocationId } from '@/lib/inventory/location-filter'
import { type InventoryDocType } from '@/lib/inventory/types'
import { hasUiCapability } from '@/lib/permission-contract'
import { canOpenOrderDetail } from '@/lib/order-detail-access'
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
   * 代建，市场账号的下拉里还是看不到门店类型（#350 起 4 种），等于什么都没发生。
   * 反过来也一样：总部 scope 不展开后代（access.ts 的 inventoryScopedOrgNodeIds），
   * 所以只有 supply_chain_operate 的账号这里只拿到「内部领用」一种，而不是 9 种里
   * 有 8 种点进去必 403 的死路。
   */
  const allowedCreateDocTypes = inventoryCreatableGenericDocTypes(
    (action) => hasUiCapability(actions, action),
  )
  /*
   * 收货**不随代建放开**：#191 放开的只是「替下级建单」，收货仍只认市场 / 门店自己的
   * operate 权限。别顺手把它也统一成 inventoryCreatableGenericDocTypes 那套层级函数 ——
   * 两者原本共用同一个 operateByLevel 对象，拆开正是为了让口径分叉显式可见。
   */
  const canReceive = INVENTORY_CORE_RECEIVE_ACTIONS.some((action) => hasUiCapability(actions, action))
  /*
   * 「收货」按钮是**行级**判据（#340 评审 P1）：`confirmInventoryCoreReceive` 断的是
   * `assertOrgNodeVisible(按收货权限收窄后的 session, target)`。单据列表按「source 或 target 在 scope」
   * 可见，调出方（市场间调货的发起市场、门店调拨的发货门店）也看得到自己的待收货单 ——
   * 只按会话级 canReceive 渲染，它们就会拿到一个点了必 PERMISSION_DENIED 的按钮。
   * 这里用与服务端同一套收窄（scopeSessionToActions + inventoryScopedOrgNodeIds）算出
   * 「能收哪些 target」；null = 不受限（超管）。
   */
  const receivableTargetOrgNodeIds = canReceive
    ? inventoryScopedOrgNodeIds(scopeSessionToActions(session, INVENTORY_CORE_RECEIVE_ACTIONS))
    : []
  const requestedCreateType = params.create as InventoryDocType | undefined
  const initialDocType = requestedCreateType && allowedCreateDocTypes.includes(requestedCreateType)
    ? requestedCreateType
    : undefined

  // SKU 候选不再预加载（#339）：建单表单里的商品选择按关键词走服务端分页检索
  const [filterOptions, locations, marketTransferTargets] = await Promise.all([
    listInventoryDocLocationFilterOptions(),
    allowedCreateDocTypes.length > 0 ? listInventoryLocations() : Promise.resolve([]),
    // 市场间调货出库的接收主体候选（#340）：不按 scope，只在能建这种单时取
    allowedCreateDocTypes.includes('市场间调货出库') ? listInventoryMarketTransferTargets() : Promise.resolve([]),
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
          marketTransferTargets={marketTransferTargets}
          canCreate={allowedCreateDocTypes.length > 0}
          canApprove={hasUiCapability(actions, 'inventory:supply_chain_approve') || hasUiCapability(actions, 'inventory:market_approve')}
          canReceive={canReceive}
          receivableTargetOrgNodeIds={receivableTargetOrgNodeIds}
          // 「关联销售单」链接：与 /orders/[id] 页面守卫同源（#350）
          canOpenOrderDetail={canOpenOrderDetail(actions)}
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
