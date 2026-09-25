import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import {
  listInventoryLocations,
  listInventoryMarketTransferTargets,
  listInventoryShipmentMarketTargets,
} from '@/actions/inventory/locations'
import { listInventorySuppliers } from '@/actions/inventory/suppliers'
import { getSession } from '@/lib/auth'
import { inventoryPriceScopeByTier, inventoryPriceVisibility } from '@/lib/inventory/access'
import { scopeSessionToAllActions } from '@/lib/action-scope'
import {
  INVENTORY_BUSINESS_LEVELS,
  genericDocBusinessLevel,
  inventoryLevelOperateAction,
  requireInventoryBusinessLevel,
  type InventoryBusinessLevel,
} from '@/lib/inventory/business-level'
import { asGenericDocType, genericOperationId } from '@/lib/inventory/operation-doc-types'
import { hasUiCapability } from '@/lib/permission-contract'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import InventoryOperationsPage from '../../_components/inventory-operations-page'

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
  /*
   * `?view=docs` 仍跳单据中心（那是"我要看单据列表"的意图）。
   * 而 `?create=<docType>` 从 #191 起**留在办理台**：通用业务已经能在工作区里内嵌建单，
   * 再跳走就等于把刚做完的改造绕过去了。单据中心自己的 `?create=` 深链不受影响。
   */
  if (query.view === 'docs') {
    const target = new URLSearchParams()
    for (const key of ['docType', 'status', 'q', 'orgNodeId']) {
      if (query[key]) target.set(key, query[key]!)
    }
    redirect(`/inventory/docs${target.size > 0 ? `?${target.toString()}` : ''}`)
  }
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  requireInventoryBusinessLevel(session, level)
  const actions = session.permissions.actions
  const operateAction = inventoryLevelOperateAction(level)
  const canCreate = hasUiCapability(actions, operateAction)
  // SKU 候选不再预加载前 100 条（#339）：各明细行的商品选择按关键词走服务端分页检索，
  // 业务过滤（可报货 / 市场归属 / 供应链来源）也在服务端做，见 InventorySkuSearchSelect。
  // 来源单 / 待处理单候选同样不再预加载（#338）：原先这里拉「全类型混排最近 100 张」，
  // 老单在各表单里选不到；现在各表单按用途走服务端检索 + 分页，见 InventoryDocCandidatePicker。
  const [locations, marketTransferTargets, shipmentMarketTargets, suppliers] = await Promise.all([
    listInventoryLocations(),
    /*
     * 市场间调货卡的接收主体候选（#340）：不按 scope 的全部启用市场。只在市场层、且能建单时取 ——
     * 那张卡只挂在市场层，别的层级 / 只读账号拿它没用，也不该多看到一份市场名单。
     */
    level === 'market' && canCreate ? listInventoryMarketTransferTargets() : Promise.resolve([]),
    /*
     * 品项公司发货的收货市场候选（#336b）：同样越过 scope（总部 scope 不展开市场）。
     * 只在供应链层、且能建单时取；权限门与发货 action 同为 supply_chain_operate。
     */
    level === 'supply-chain' && canCreate ? listInventoryShipmentMarketTargets() : Promise.resolve([]),
    // 刻意不传 pageSize：办理台的供应商下拉要的是整份名单，
    // 跟着列表页分页走会把靠后的供应商静默漏掉（#135）。
    listInventorySuppliers({ onlyActive: true }),
  ])
  const approveAction = level === 'supply-chain'
    ? 'inventory:supply_chain_approve'
    : level === 'market'
      ? 'inventory:market_approve'
      : null
  const canApprove = approveAction ? hasUiCapability(actions, approveAction) : false

  /*
   * 深链 `?create=<docType>` → 直接打开对应的通用业务工作区。
   * 三道闸都在服务端过：类型必须是通用建单类型（parseGenericOperationId 的白名单）、
   * 必须属于当前层级（否则市场的深链能在门店台打开门店建不了的单）、
   * 且当前账号得有本层级的 operate 权限。任一不过就当没带参数。
   */
  const requestedDocType = asGenericDocType(query.create)
  const initialOperationId = requestedDocType
    && genericDocBusinessLevel(requestedDocType) === level
    && canCreate
      ? genericOperationId(requestedDocType)
      : undefined

  return (
    <div className="p-6">
      <Suspense>
        <InventoryOperationsPage
          level={level}
          locations={locations}
          marketTransferTargets={marketTransferTargets}
          shipmentMarketTargets={shipmentMarketTargets}
          suppliers={suppliers.data}
          canCreate={canCreate}
          canApprove={canApprove}
          canSelfPurchase={hasUiCapability(actions, 'inventory:self_purchase_receive')}
          canRequestShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_request')}
          canApproveShipmentCancellation={hasUiCapability(actions, 'inventory:shipment_cancel_approve')}
          // 与单据列表查询回传的 canViewPrice 同一判据
          canViewPrice={inventoryPriceVisibility(session) !== 'none'}
          // 入库单价优惠（#346）与服务端 receiveSupplyChainPurchaseOrder 同判据：办理权与供应链价格权
          // 落在同一条角色绑定上，按总部节点判；null = 不受节点限制（admin）
          receiptDiscountOrgNodeIds={receiptDiscountOrgNodeIds(session)}
          // 「顾客产品出库」跳转卡（#350）：与提货录入页 requireUiPageCapability 同一判据
          canCreatePickupRecord={hasUiCapability(actions, 'pickup_record:create')}
          initialOperationId={initialOperationId}
        />
      </Suspense>
    </div>
  )
}

function receiptDiscountOrgNodeIds(session: NonNullable<Awaited<ReturnType<typeof getSession>>>): string[] | null {
  const tiers = inventoryPriceScopeByTier(
    scopeSessionToAllActions(session, ['inventory:supply_chain_operate', 'inventory:supply_chain_price_view']),
  )
  return tiers.supplyChain === null ? null : [...tiers.supplyChain]
}
