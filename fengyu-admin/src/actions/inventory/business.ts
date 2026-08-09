'use server'

import {
  approveReturnForRestock as approveReturnForRestockImpl,
  cancelItemCompanyShipment as cancelItemCompanyShipmentImpl,
  createExternalMarketOutbound as createExternalMarketOutboundImpl,
  createItemCompanyShipment as createItemCompanyShipmentImpl,
  createInventoryConversion as createInventoryConversionImpl,
  createMarketReplenishment as createMarketReplenishmentImpl,
  createMarketStaffPurchase as createMarketStaffPurchaseImpl,
  createPurchaseOrderFromMarketReplenishment as createPurchaseOrderFromMarketReplenishmentImpl,
  createReturnForRestock as createReturnForRestockImpl,
  createSelfPurchasedReceipt as createSelfPurchasedReceiptImpl,
  createStoreAllocation as createStoreAllocationImpl,
  createStoreReplenishmentRequest as createStoreReplenishmentRequestImpl,
  getShipmentReceiptProgress as getShipmentReceiptProgressImpl,
  quoteMarketReplenishmentPrice as quoteMarketReplenishmentPriceImpl,
  receiveItemCompanyShipment as receiveItemCompanyShipmentImpl,
  receiveStoreAllocation as receiveStoreAllocationImpl,
  rejectReturnForRestock as rejectReturnForRestockImpl,
  summarizeStoreReplenishmentRequests as summarizeStoreReplenishmentRequestsImpl,
  type CreateItemCompanyShipmentInput,
  type CreateExternalMarketOutboundInput,
  type CreateInventoryConversionInput,
  type CreateMarketReplenishmentInput,
  type CreateMarketStaffPurchaseInput,
  type CreatePurchaseOrderInput,
  type CreateReturnForRestockInput,
  type CreateSelfPurchasedReceiptInput,
  type CreateStoreAllocationInput,
  type CreateStoreReplenishmentInput,
  type ReceiveShipmentInput,
} from '@/lib/inventory/business'
import { withPermission } from '@/lib/with-permission'

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
  async (session, input: { marketId: string; skuId: string; quantity: number; docDate?: string | null }) =>
    quoteMarketReplenishmentPriceImpl(session, input),
)

export const createMarketReplenishment = withPermission(
  'inventory:create_doc',
  async (session, input: CreateMarketReplenishmentInput) =>
    createMarketReplenishmentImpl(session, input),
)

export const createPurchaseOrderFromMarketReplenishment = withPermission(
  'inventory:create_doc',
  async (session, input: CreatePurchaseOrderInput) =>
    createPurchaseOrderFromMarketReplenishmentImpl(session, input),
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

export const cancelItemCompanyShipment = withPermission(
  'inventory:approve',
  async (session, input: { shipmentId: string; cancellationReason: string }) =>
    cancelItemCompanyShipmentImpl(session, input),
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

export const createSelfPurchasedReceipt = withPermission(
  'inventory:create_doc',
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
