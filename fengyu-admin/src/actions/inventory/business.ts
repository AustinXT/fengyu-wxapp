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
  createMarketStaffPurchase as createMarketStaffPurchaseImpl,
  createPurchaseOrderFromItemCompanyReplenishment as createPurchaseOrderFromItemCompanyReplenishmentImpl,
  createPurchaseOrderFromMarketReplenishment as createPurchaseOrderFromMarketReplenishmentImpl,
  createReturnForRestock as createReturnForRestockImpl,
  createSelfPurchasedReceipt as createSelfPurchasedReceiptImpl,
  createStoreAllocation as createStoreAllocationImpl,
  createStoreReplenishmentRequest as createStoreReplenishmentRequestImpl,
  getShipmentReceiptProgress as getShipmentReceiptProgressImpl,
  listMarketEmployeeOptions as listMarketEmployeeOptionsImpl,
  quoteMarketReplenishmentPrice as quoteMarketReplenishmentPriceImpl,
  quoteMarketReplenishmentPrices as quoteMarketReplenishmentPricesImpl,
  receiveItemCompanyShipment as receiveItemCompanyShipmentImpl,
  receiveSupplyChainPurchaseOrder as receiveSupplyChainPurchaseOrderImpl,
  receiveStoreAllocation as receiveStoreAllocationImpl,
  rejectItemCompanyShipmentCancellation as rejectItemCompanyShipmentCancellationImpl,
  rejectReturnForRestock as rejectReturnForRestockImpl,
  requestItemCompanyShipmentCancellation as requestItemCompanyShipmentCancellationImpl,
  summarizeStoreReplenishmentRequests as summarizeStoreReplenishmentRequestsImpl,
  type CreateItemCompanyShipmentInput,
  type CreateItemCompanyReplenishmentInput,
  type CreateCompanyPurchaseOrderInput,
  type CancelSupplyChainPurchaseOrderInput,
  type CreateExternalMarketOutboundInput,
  type CreateInventoryConversionInput,
  type CreateMarketReplenishmentInput,
  type MarketPromotionSelectionInput,
  type CreateMarketStaffPurchaseInput,
  type CreatePurchaseOrderInput,
  type CreateReturnForRestockInput,
  type CreateSelfPurchasedReceiptInput,
  type CreateStoreAllocationInput,
  type CreateStoreReplenishmentInput,
  type ReceiveShipmentInput,
  type ReceiveSupplyChainPurchaseOrderInput,
  type RequestItemCompanyShipmentCancellationInput,
  type ResolveItemCompanyShipmentCancellationInput,
} from '@/lib/inventory/business'
import { withAllPermissions, withPermission } from '@/lib/with-permission'

export const createStoreReplenishmentRequest = withPermission(
  'inventory:create_doc',
  async (session, input: CreateStoreReplenishmentInput) =>
    createStoreReplenishmentRequestImpl(session, input),
)

export const summarizeStoreReplenishmentRequests = withPermission(
  'inventory:list',
  async (session, input: { marketId: string; startDate?: string | null; endDate?: string | null }) =>
    summarizeStoreReplenishmentRequestsImpl(session, input),
)

export const quoteMarketReplenishmentPrice = withPermission(
  'inventory:price_view',
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
  'inventory:price_view',
  async (session, input: {
    marketId: string
    items: Array<{ skuId: string; quantity: number }>
    docDate?: string | null
    selections?: MarketPromotionSelectionInput[]
  }) => quoteMarketReplenishmentPricesImpl(session, input),
)

export const createMarketReplenishment = withPermission(
  'inventory:create_doc',
  async (session, input: CreateMarketReplenishmentInput) =>
    createMarketReplenishmentImpl(session, input),
)

export const createItemCompanyReplenishment = withPermission(
  'inventory:create_doc',
  async (session, input: CreateItemCompanyReplenishmentInput) =>
    createItemCompanyReplenishmentImpl(session, input),
)

export const createPurchaseOrderFromMarketReplenishment = withPermission(
  'inventory:create_doc',
  async (session, input: CreatePurchaseOrderInput) =>
    createPurchaseOrderFromMarketReplenishmentImpl(session, input),
)

export const createPurchaseOrderFromItemCompanyReplenishment = withPermission(
  'inventory:create_doc',
  async (session, input: CreateCompanyPurchaseOrderInput) =>
    createPurchaseOrderFromItemCompanyReplenishmentImpl(session, input),
)

export const createItemCompanyShipment = withPermission(
  'inventory:create_doc',
  async (session, input: CreateItemCompanyShipmentInput) =>
    createItemCompanyShipmentImpl(session, input),
)

export const receiveItemCompanyShipment = withPermission(
  'inventory:create_doc',
  async (session, input: ReceiveShipmentInput) =>
    receiveItemCompanyShipmentImpl(session, input),
)

export const receiveSupplyChainPurchaseOrder = withPermission(
  'inventory:create_doc',
  async (session, input: ReceiveSupplyChainPurchaseOrderInput) =>
    receiveSupplyChainPurchaseOrderImpl(session, input),
)

export const createStoreAllocation = withPermission(
  'inventory:create_doc',
  async (session, input: CreateStoreAllocationInput) =>
    createStoreAllocationImpl(session, input),
)

export const receiveStoreAllocation = withPermission(
  'inventory:create_doc',
  async (session, input: ReceiveShipmentInput) =>
    receiveStoreAllocationImpl(session, input),
)

export const createReturnForRestock = withPermission(
  'inventory:create_doc',
  async (session, input: CreateReturnForRestockInput) =>
    createReturnForRestockImpl(session, input),
)

export const approveReturnForRestock = withPermission(
  'inventory:approve',
  async (session, input: { returnDocId: string; auditRemark?: string | null }) =>
    approveReturnForRestockImpl(session, input),
)

export const rejectReturnForRestock = withPermission(
  'inventory:approve',
  async (session, input: { returnDocId: string; auditRemark: string }) =>
    rejectReturnForRestockImpl(session, input),
)

export const requestItemCompanyShipmentCancellation = withAllPermissions(
  ['inventory:create_doc', 'inventory:shipment_cancel_request'],
  async (session, input: RequestItemCompanyShipmentCancellationInput) =>
    requestItemCompanyShipmentCancellationImpl(session, input),
)

export const approveItemCompanyShipmentCancellation = withAllPermissions(
  ['inventory:approve', 'inventory:shipment_cancel_approve'],
  async (session, input: ResolveItemCompanyShipmentCancellationInput) =>
    approveItemCompanyShipmentCancellationImpl(session, input),
)

export const rejectItemCompanyShipmentCancellation = withAllPermissions(
  ['inventory:approve', 'inventory:shipment_cancel_approve'],
  async (session, input: ResolveItemCompanyShipmentCancellationInput & { auditRemark: string }) =>
    rejectItemCompanyShipmentCancellationImpl(session, input),
)

/** 兼容已打开的旧后台页面；调用后仅提交申请，不会直接撤回。 */
export const cancelItemCompanyShipment = withAllPermissions(
  ['inventory:create_doc', 'inventory:shipment_cancel_request'],
  async (session, input: RequestItemCompanyShipmentCancellationInput) =>
    requestItemCompanyShipmentCancellationImpl(session, input),
)

export const cancelSupplyChainPurchaseOrder = withPermission(
  'inventory:approve',
  async (session, input: CancelSupplyChainPurchaseOrderInput) =>
    cancelSupplyChainPurchaseOrderImpl(session, input),
)

export const getShipmentReceiptProgress = withPermission(
  'inventory:list',
  async (session, shipmentId: string) => getShipmentReceiptProgressImpl(session, shipmentId),
)

export const createMarketStaffPurchase = withPermission(
  'inventory:create_doc',
  async (session, input: CreateMarketStaffPurchaseInput) =>
    createMarketStaffPurchaseImpl(session, input),
)

export const listMarketEmployeeOptions = withPermission(
  'inventory:create_doc',
  async (session, marketId: string) => listMarketEmployeeOptionsImpl(session, marketId),
)

export const createSelfPurchasedReceipt = withAllPermissions(
  ['inventory:create_doc', 'inventory:self_purchase_receive'],
  async (session, input: CreateSelfPurchasedReceiptInput) =>
    createSelfPurchasedReceiptImpl(session, input),
)

export const createExternalMarketOutbound = withPermission(
  'inventory:create_doc',
  async (session, input: CreateExternalMarketOutboundInput) =>
    createExternalMarketOutboundImpl(session, input),
)

export const createInventoryConversion = withPermission(
  'inventory:create_doc',
  async (session, input: CreateInventoryConversionInput) =>
    createInventoryConversionImpl(session, input),
)
