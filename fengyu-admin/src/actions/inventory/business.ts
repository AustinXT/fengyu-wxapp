'use server'

import {
  approveItemCompanyShipmentCancellation as approveItemCompanyShipmentCancellationImpl,
  approveReturnForRestock as approveReturnForRestockImpl,
  cancelSupplyChainPurchaseOrder as cancelSupplyChainPurchaseOrderImpl,
  createExternalMarketOutbound as createExternalMarketOutboundImpl,
  createItemCompanyShipment as createItemCompanyShipmentImpl,
  createItemCompanyReplenishment as createItemCompanyReplenishmentImpl,
  createInventoryConversion as createInventoryConversionImpl,
  createMarketReplenishment as createMarketReplenishmentImpl,
  deleteMarketReplenishmentDraft as deleteMarketReplenishmentDraftImpl,
  saveMarketReplenishmentDraft as saveMarketReplenishmentDraftImpl,
  createMarketReportSummary as createMarketReportSummaryImpl,
  resolveInventorySkuSupplierStatus as resolveInventorySkuSupplierStatusImpl,
  createMarketStaffPurchase as createMarketStaffPurchaseImpl,
  createSupplyChainStaffPurchase as createSupplyChainStaffPurchaseImpl,
  createPurchaseOrder as createPurchaseOrderImpl,
  createReturnForRestock as createReturnForRestockImpl,
  createSelfPurchasedReceipt as createSelfPurchasedReceiptImpl,
  createStoreAllocation as createStoreAllocationImpl,
  createStoreReplenishmentRequest as createStoreReplenishmentRequestImpl,
  getShipmentReceiptProgress as getShipmentReceiptProgressImpl,
  listMarketEmployeeOptions as listMarketEmployeeOptionsImpl,
  listSupplyChainEmployeeOptions as listSupplyChainEmployeeOptionsImpl,
  quoteMarketReplenishmentPrice as quoteMarketReplenishmentPriceImpl,
  quoteMarketReplenishmentPrices as quoteMarketReplenishmentPricesImpl,
  receiveItemCompanyShipment as receiveItemCompanyShipmentImpl,
  receiveItemCompanyShipmentInFull as receiveItemCompanyShipmentInFullImpl,
  receiveSupplyChainPurchaseOrder as receiveSupplyChainPurchaseOrderImpl,
  receiveStoreAllocation as receiveStoreAllocationImpl,
  receiveStoreAllocationInFull as receiveStoreAllocationInFullImpl,
  rejectItemCompanyShipmentCancellation as rejectItemCompanyShipmentCancellationImpl,
  rejectReturnForRestock as rejectReturnForRestockImpl,
  requestItemCompanyShipmentCancellation as requestItemCompanyShipmentCancellationImpl,
  summarizeMarketReplenishmentRequests as summarizeMarketReplenishmentRequestsImpl,
  summarizeStoreReplenishmentRequests as summarizeStoreReplenishmentRequestsImpl,
  type CreateItemCompanyShipmentInput,
  type CreateMarketReportSummaryInput,
  type CreateItemCompanyReplenishmentInput,
  type CancelSupplyChainPurchaseOrderInput,
  type CreateExternalMarketOutboundInput,
  type CreateInventoryConversionInput,
  type CreateMarketReplenishmentInput,
  type SaveMarketReplenishmentDraftInput,
  type MarketPromotionSelectionInput,
  type CreateMarketStaffPurchaseInput,
  type CreateSupplyChainStaffPurchaseInput,
  type CreateMergedPurchaseOrderInput,
  type CreateReturnForRestockInput,
  type CreateSelfPurchasedReceiptInput,
  type CreateStoreAllocationInput,
  type CreateStoreReplenishmentInput,
  type ReceiveShipmentInFullInput,
  type ReceiveShipmentInput,
  type ReceiveSupplyChainPurchaseOrderInput,
  type RequestItemCompanyShipmentCancellationInput,
  type ResolveItemCompanyShipmentCancellationInput,
} from '@/lib/inventory/business'
import { withAllPermissions, withAnyPermission, withPermission } from '@/lib/with-permission'

export const createStoreReplenishmentRequest = withPermission(
  'inventory:store_operate',
  async (session, input: CreateStoreReplenishmentInput) =>
    createStoreReplenishmentRequestImpl(session, input),
)

export const summarizeStoreReplenishmentRequests = withPermission(
  'inventory:market_operate',
  async (session, input: { marketId: string; startDate?: string | null; endDate?: string | null }) =>
    summarizeStoreReplenishmentRequestsImpl(session, input),
)

export const quoteMarketReplenishmentPrice = withPermission(
  'inventory:market_price_view',
  async (session, input: {
    marketId: string
    skuId: string
    quantity: number
    docDate?: string | null
    basketItems?: Array<{ skuId: string; quantity: number }>
  }) =>
    quoteMarketReplenishmentPriceImpl(session, input),
)

export const quoteMarketReplenishmentPrices = withPermission(
  'inventory:market_price_view',
  async (session, input: {
    marketId: string
    items: Array<{ skuId: string; quantity: number }>
    docDate?: string | null
    selections?: MarketPromotionSelectionInput[]
  }) => quoteMarketReplenishmentPricesImpl(session, input),
)

export const createMarketReplenishment = withPermission(
  'inventory:market_operate',
  async (session, input: CreateMarketReplenishmentInput) =>
    createMarketReplenishmentImpl(session, input),
)

/** 市场报货草稿（#348）：与新建 / 提交同一权限，草稿本身不占用门店报货。 */
export const saveMarketReplenishmentDraft = withPermission(
  'inventory:market_operate',
  async (session, input: SaveMarketReplenishmentDraftInput) =>
    saveMarketReplenishmentDraftImpl(session, input),
)

export const deleteMarketReplenishmentDraft = withPermission(
  'inventory:market_operate',
  async (session, input: { draftId: string }) =>
    deleteMarketReplenishmentDraftImpl(session, input),
)

export const createItemCompanyReplenishment = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateItemCompanyReplenishmentInput) =>
    createItemCompanyReplenishmentImpl(session, input),
)

export const summarizeMarketReplenishmentRequests = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: {
    supplyChainLocationId: string
    startDate?: string | null
    endDate?: string | null
    marketIds?: string[] | null
  }) => summarizeMarketReplenishmentRequestsImpl(session, input),
)

export const createMarketReportSummary = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateMarketReportSummaryInput) =>
    createMarketReportSummaryImpl(session, input),
)

export const resolveInventorySkuSupplierStatus = withPermission(
  'inventory:supply_chain_operate',
  async (session, skuIds: string[]) => resolveInventorySkuSupplierStatusImpl(session, skuIds),
)

export const createPurchaseOrder = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateMergedPurchaseOrderInput) =>
    createPurchaseOrderImpl(session, input),
)

export const createItemCompanyShipment = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateItemCompanyShipmentInput) =>
    createItemCompanyShipmentImpl(session, input),
)

export const receiveItemCompanyShipment = withPermission(
  'inventory:market_operate',
  async (session, input: ReceiveShipmentInput) =>
    receiveItemCompanyShipmentImpl(session, input),
)

export const receiveSupplyChainPurchaseOrder = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: ReceiveSupplyChainPurchaseOrderInput) =>
    receiveSupplyChainPurchaseOrderImpl(session, input),
)

export const createStoreAllocation = withPermission(
  'inventory:market_operate',
  async (session, input: CreateStoreAllocationInput) =>
    createStoreAllocationImpl(session, input),
)

export const receiveStoreAllocation = withPermission(
  'inventory:store_operate',
  async (session, input: ReceiveShipmentInput) =>
    receiveStoreAllocationImpl(session, input),
)

/*
 * ────────── 待办区「一键收货」（#192） ──────────
 *
 * 两个入口的权限必须与上面**带明细的**同类收货入口逐字一致：
 * 品项公司发货 → `inventory:market_operate`（对齐 `receiveItemCompanyShipment`）、
 * 分院配货   → `inventory:store_operate`（对齐 `receiveStoreAllocation`）。
 *
 * ⚠️ **绝不能**合并成一个
 * `withAnyPermission(['inventory:market_operate','inventory:store_operate'], …)`
 * 再在内部按 `progress.docType` 分发：impl 调的是 lib 层函数，lib 层只有
 * `assertLocationWritable`（scope 校验）没有 action 级校验，聚合写法会让只持有
 * market_operate 的市场角色在 scope 覆盖下属门店时替门店收货 —— 而现有
 * `receiveStoreAllocation` 是单权限 store_operate，市场角色本来是被拒的。
 * 这条边界有 actions/inventory/business.test.ts 的权限回归用例钉住。
 */
export const receiveItemCompanyShipmentInFull = withPermission(
  'inventory:market_operate',
  async (session, input: ReceiveShipmentInFullInput) =>
    receiveItemCompanyShipmentInFullImpl(session, input),
)

export const receiveStoreAllocationInFull = withPermission(
  'inventory:store_operate',
  async (session, input: ReceiveShipmentInFullInput) =>
    receiveStoreAllocationInFullImpl(session, input),
)

export const createReturnForRestock = withAnyPermission(
  ['inventory:market_operate', 'inventory:store_operate'],
  async (session, input: CreateReturnForRestockInput) =>
    createReturnForRestockImpl(session, input),
)

export const approveReturnForRestock = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (session, input: { returnDocId: string; auditRemark?: string | null }) =>
    approveReturnForRestockImpl(session, input),
)

export const rejectReturnForRestock = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (session, input: { returnDocId: string; auditRemark: string }) =>
    rejectReturnForRestockImpl(session, input),
)

export const requestItemCompanyShipmentCancellation = withAllPermissions(
  ['inventory:market_operate', 'inventory:shipment_cancel_request'],
  async (session, input: RequestItemCompanyShipmentCancellationInput) =>
    requestItemCompanyShipmentCancellationImpl(session, input),
)

export const approveItemCompanyShipmentCancellation = withAllPermissions(
  ['inventory:supply_chain_approve', 'inventory:shipment_cancel_approve'],
  async (session, input: ResolveItemCompanyShipmentCancellationInput) =>
    approveItemCompanyShipmentCancellationImpl(session, input),
)

export const rejectItemCompanyShipmentCancellation = withAllPermissions(
  ['inventory:supply_chain_approve', 'inventory:shipment_cancel_approve'],
  async (session, input: ResolveItemCompanyShipmentCancellationInput & { auditRemark: string }) =>
    rejectItemCompanyShipmentCancellationImpl(session, input),
)

/** 兼容已打开的旧后台页面；调用后仅提交申请，不会直接撤回。 */
export const cancelItemCompanyShipment = withAllPermissions(
  ['inventory:market_operate', 'inventory:shipment_cancel_request'],
  async (session, input: RequestItemCompanyShipmentCancellationInput) =>
    requestItemCompanyShipmentCancellationImpl(session, input),
)

export const cancelSupplyChainPurchaseOrder = withPermission(
  'inventory:supply_chain_approve',
  async (session, input: CancelSupplyChainPurchaseOrderInput) =>
    cancelSupplyChainPurchaseOrderImpl(session, input),
)

export const getShipmentReceiptProgress = withPermission(
  'inventory:list',
  async (session, shipmentId: string) => getShipmentReceiptProgressImpl(session, shipmentId),
)

export const createMarketStaffPurchase = withPermission(
  'inventory:market_operate',
  async (session, input: CreateMarketStaffPurchaseInput) =>
    createMarketStaffPurchaseImpl(session, input),
)

export const listMarketEmployeeOptions = withPermission(
  'inventory:market_operate',
  async (session, marketId: string) => listMarketEmployeeOptionsImpl(session, marketId),
)

export const createSupplyChainStaffPurchase = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateSupplyChainStaffPurchaseInput) =>
    createSupplyChainStaffPurchaseImpl(session, input),
)

export const listSupplyChainEmployeeOptions = withPermission(
  'inventory:supply_chain_operate',
  async (session, locationId: string) => listSupplyChainEmployeeOptionsImpl(session, locationId),
)

export const createSelfPurchasedReceipt = withAllPermissions(
  ['inventory:market_operate', 'inventory:self_purchase_receive'],
  async (session, input: CreateSelfPurchasedReceiptInput) =>
    createSelfPurchasedReceiptImpl(session, input),
)

export const createExternalMarketOutbound = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateExternalMarketOutboundInput) =>
    createExternalMarketOutboundImpl(session, input),
)

// 库存转换仅供应链可做（#343，9/18 会议 §2.15），市场/门店权限不再放行。
export const createInventoryConversion = withPermission(
  'inventory:supply_chain_operate',
  async (session, input: CreateInventoryConversionInput) =>
    createInventoryConversionImpl(session, input),
)
