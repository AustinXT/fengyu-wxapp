import type { InventoryCoreDocStatus, InventoryDocType, InventoryLocationType } from './types'

/**
 * 办理台业务卡片 id（#190）。
 *
 * 原先定义在 `inventory-operations-page.tsx` 内部，移到这里是为了让映射表能用
 * `Record<InventoryOperationId, …>` 把「新增业务卡片必须补单据映射」变成编译期约束 ——
 * 漏一条 TS 直接报错，不靠人记。
 */
export const INVENTORY_OPERATION_IDS = [
  'store-request',
  'market-report',
  'item-company-request',
  'purchase-order',
  'supply-chain-purchase-order',
  'company-shipment',
  'market-receipt',
  'supply-chain-receipt',
  'supply-chain-purchase-cancel',
  'store-allocation',
  'store-receipt',
  'store-return',
  'market-return',
  'store-return-approval',
  'market-return-approval',
  'staff-purchase',
  'supply-chain-staff-purchase',
  'self-purchase',
  'external-outbound',
  'supply-chain-conversion',
  'market-conversion',
  'store-conversion',
  'shipment-cancel',
  'shipment-cancel-approval',
] as const
export type InventoryOperationId = (typeof INVENTORY_OPERATION_IDS)[number]

export interface InventoryOperationDocQuery {
  /** 本业务产出的单据类型。多个时合并展示（转换类一次产出出库 + 入库两张）。 */
  docTypes: readonly InventoryDocType[]
  /**
   * 状态收窄。只给「本身不产出新单、只改目标单状态」的业务用（关闭采购、审批撤回），
   * 其余业务不限状态 —— 产出单从草稿到已完成都该在自己的 Tab 里看得到。
   */
  statuses?: readonly InventoryCoreDocStatus[]
  /**
   * 层级收窄。`库存转换出库` / `库存转换入库` 是供应链、市场、门店三层**共用**的
   * docType（`business.ts` 的 createInventoryConversion 不按层级分单据类型），
   * 只按 docType 查会让市场办理台看到门店的转换单。
   */
  locationType?: InventoryLocationType
  /**
   * 仅保留发起过撤回申请的单据（`cancellation_request_reason` 非空）。
   * 撤回类业务不产出新单，靠这个标记把「被本业务经手过的发货单」跟普通发货单区分开。
   *
   * 类型是 `true` 而非 `boolean`：这个条件只有收窄一个方向，写 `false` 在 engine 里
   * 会退化成不过滤（放宽），与字面意思相反 —— 从类型上堵掉这个三态陷阱。
   */
  cancellationRequested?: true
}

/**
 * 业务 → 本业务产出单据类型（#190，口径 2026-09-19 拍板：只显示产出单，不列上游单）。
 *
 * 每条都对齐 `src/lib/inventory/business.ts` 里该业务 `insertDocHeader` 实际写入的
 * `docType`，不是按卡片标题猜的。改业务的产出单据类型时必须同步这里。
 */
export const INVENTORY_OPERATION_DOC_QUERY: Record<InventoryOperationId, InventoryOperationDocQuery> = {
  // —— 供应链 ——
  'item-company-request': { docTypes: ['品项公司报货需求'] },
  'supply-chain-purchase-order': { docTypes: ['供应链采购订单'] },
  'purchase-order': { docTypes: ['采购订单'] },
  'company-shipment': { docTypes: ['品项公司发货'] },
  'supply-chain-receipt': { docTypes: ['供应链采购入库'] },
  // 关闭采购不产出新单，只把采购订单置为已取消。
  'supply-chain-purchase-cancel': { docTypes: ['供应链采购订单'], statuses: ['已取消'] },
  // 审批市场退货 → 货回供应链库，产出供应链退货入库单（business.ts: approveReturnForRestock）。
  'market-return-approval': { docTypes: ['供应链退货入库'] },
  /*
   * 撤回审批的两个产出：通过 → 发货单变「已取消」；驳回 → status 改回「待收货」
   * （`business.ts` rejectItemCompanyShipmentCancellation，不清 reason）。
   * 两个都要显示，审批人得能复核自己刚驳回的单 —— 只留「已取消」的话，
   * 驳回动作做完单子立刻从视野里消失，而它在申请人那边还看得见，同一条链两端口径相反。
   * 「待审批」不在列：那是**待办**不是产出，按口径不进本 Tab。
   * 叠 cancellationRequested 是为了排除其它途径取消的发货单。
   */
  'shipment-cancel-approval': {
    docTypes: ['品项公司发货'],
    statuses: ['已取消', '待收货'],
    cancellationRequested: true,
  },
  'supply-chain-conversion': {
    docTypes: ['库存转换出库', '库存转换入库'],
    locationType: '总部',
  },
  'external-outbound': { docTypes: ['非凤御市场出库'] },
  'supply-chain-staff-purchase': { docTypes: ['供应链员工购出库'] },

  // —— 市场 ——
  'market-report': { docTypes: ['市场报货'] },
  'market-receipt': { docTypes: ['市场采购入库'] },
  'store-allocation': { docTypes: ['分院配货'] },
  // 审批门店退货 → 货回市场库，产出市场退货入库单。
  'store-return-approval': { docTypes: ['市场退货入库'] },
  'market-return': { docTypes: ['市场退货'] },
  /*
   * 申请撤回不产出新单，只把发货单打上撤回申请标记（status → 待审批）。
   * 这里**刻意不限状态**：驳回时 `business.ts` 只把 status 改回「待收货」，
   * 不清 `cancellation_request_reason`，所以申请过的单（待审批 / 已取消 / 被驳回）
   * 都还认得出来，申请人本来就该看到自己申请的全部结果。
   */
  'shipment-cancel': { docTypes: ['品项公司发货'], cancellationRequested: true },
  'staff-purchase': { docTypes: ['员工购出库'] },
  'self-purchase': { docTypes: ['自采产品入库'] },
  'market-conversion': {
    docTypes: ['库存转换出库', '库存转换入库'],
    locationType: '市场',
  },

  // —— 门店 ——
  'store-request': { docTypes: ['门店报货'] },
  'store-receipt': { docTypes: ['院入库'] },
  'store-return': { docTypes: ['院退货'] },
  'store-conversion': {
    docTypes: ['库存转换出库', '库存转换入库'],
    locationType: '门店',
  },
}
