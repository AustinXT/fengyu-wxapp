import type { InventoryCoreDocStatus, InventoryDocRow, InventoryDocType } from './types'

/**
 * 办理台「来源单 / 待处理单」候选的用途白名单（#338）。
 *
 * 原先候选来自页面服务端预加载的**全类型混排最近 100 张**单据，前端再按类型 filter ——
 * 更老的单在下拉里翻不出来、选不到。现在改由服务端按用途出候选（检索 + 分页）。
 *
 * 客户端只传用途 id，单据类型 / 状态 / 方向 / 剩余量口径一律在服务端查本表解析，
 * 不让客户端直接指定 docType（与 #192 `resolveOperationDocQuery` 同一思路）。
 *
 * 每条都对齐对应建单 / 动作函数在事务内的断言（`src/lib/inventory/business.ts`），
 * 不是按卡片标题猜的 —— 候选比服务端宽，就会列出点了必拒的单；比服务端窄，就会有单选不到。
 */
export const INVENTORY_DOC_CANDIDATE_PURPOSES = [
  'purchase-order-source',
  'company-shipment-source',
  'store-allocation-source',
  'market-receipt',
  'store-receipt',
  'supply-chain-receipt',
  'supply-chain-purchase-cancel',
  'shipment-cancel-request',
  'shipment-cancel-approval',
  'store-return-approval',
  'market-return-approval',
] as const
export type InventoryDocCandidatePurpose = (typeof INVENTORY_DOC_CANDIDATE_PURPOSES)[number]

/**
 * 进度 / 剩余量口径。每种都与对应守卫**逐字同口径**：
 * - `ordered`：来源行 `fulfilled_quantity` = 已下单量（createPurchaseOrder 的未下单守卫）
 * - `shipped`：采购订单**市场行**经「采购订单发货」血缘的已发量，目标单已取消的不算
 *   （createItemCompanyShipment 的 `orderItem.quantity - shipped`；无市场归属的自用行不参与）
 * - `allocated`：门店报货行经「门店报货配货」血缘的已配量，目标单已取消的不算
 *   （createStoreAllocation 的 `requestItem.quantity - allocated`）
 * - `received`：行 `fulfilled_quantity` = 已收 / 已入库量（getShipmentReceiptProgress 同口径）
 * - `none`：审批类，只展示总数量
 */
export type InventoryDocCandidateProgressKind = 'ordered' | 'shipped' | 'allocated' | 'received' | 'none'

export interface InventoryDocCandidateDocRule {
  docType: InventoryDocType
  /** 不写 = 排除「已取消」的全部状态（建单类守卫只拦已取消） */
  statuses?: readonly InventoryCoreDocStatus[]
}

export interface InventoryDocCandidateDefinition {
  rules: readonly InventoryDocCandidateDocRule[]
  /** 对应动作在服务端拿哪一端做 `assertLocationWritable`，语义同 `InventoryOperationDocFilter.scopeRole` */
  scopeRole: 'source' | 'target'
  progress: InventoryDocCandidateProgressKind
  /**
   * 建单类来源：默认只列仍有剩余量的单，允许切到「显示全部」（赠送可在正常量配完后单独补）。
   * 状态类候选（收货 / 审批）不给切换 —— 状态本身就是服务端的硬条件。
   */
  remainingToggle: boolean
  /**
   * 状态类候选也要求有剩余：供应链采购入库只收还有未入库行的采购订单
   * （与 inbox 的 pendingItemScope 同口径）。
   */
  requireRemaining?: true
  /** 撤回审批：服务端 `required(cancellationRequestReason)`，marker 为空必拒 */
  cancellationRequested?: true
  /** 撤回申请：任一行已有实收（fulfilled_quantity > 0）服务端直接 CONFLICT，候选同样排除 */
  requireNoReceipt?: true
}

export const INVENTORY_DOC_CANDIDATES: Record<InventoryDocCandidatePurpose, InventoryDocCandidateDefinition> = {
  /*
   * createPurchaseOrder：汇总单只拦已取消；需求单必须「已完成」；
   * `header.targetOrgNodeId !== supplyChain.orgNodeId` + `assertLocationWritable(supplyChain)` → target。
   */
  'purchase-order-source': {
    rules: [{ docType: '市场报货汇总' }, { docType: '品项公司报货需求', statuses: ['已完成'] }],
    scopeRole: 'target',
    progress: 'ordered',
    remainingToggle: true,
  },
  // createItemCompanyShipment：`order.status === '已取消'` 拒；发货主体 = order.target 且可写。
  'company-shipment-source': {
    rules: [{ docType: '采购订单' }],
    scopeRole: 'target',
    progress: 'shipped',
    remainingToggle: true,
  },
  // createStoreAllocation：`request.status === '已取消'` 拒；配货市场 = request.target 且可写。
  // 报货单可选（#337），表单选了收货门店后按 sourceOrgNodeId 收窄到该门店的单。
  'store-allocation-source': {
    rules: [{ docType: '门店报货' }],
    scopeRole: 'target',
    progress: 'allocated',
    remainingToggle: true,
  },
  // 以下与 operation-doc-types 的 inbox 段逐条同口径（行号注释见该文件）。
  'market-receipt': {
    rules: [{ docType: '品项公司发货', statuses: ['待收货'] }],
    scopeRole: 'target',
    progress: 'received',
    remainingToggle: false,
  },
  'store-receipt': {
    rules: [{ docType: '分院配货', statuses: ['待收货'] }],
    scopeRole: 'target',
    progress: 'received',
    remainingToggle: false,
  },
  'supply-chain-receipt': {
    rules: [{ docType: '采购订单', statuses: ['待收货'] }],
    scopeRole: 'target',
    progress: 'received',
    remainingToggle: false,
    requireRemaining: true,
  },
  // 关闭作用于整单，与 inbox 同样刻意不要求剩余（见 operation-doc-types 同名条目）。
  'supply-chain-purchase-cancel': {
    rules: [{ docType: '采购订单', statuses: ['待收货'] }],
    scopeRole: 'target',
    progress: 'received',
    remainingToggle: false,
  },
  /*
   * requestItemCompanyShipmentCancellation：待收货 + `assertLocationWritable(target)`，
   * 且任一行已有实收就拒（「已有实收记录的发货单不可申请撤回」）。
   */
  'shipment-cancel-request': {
    rules: [{ docType: '品项公司发货', statuses: ['待收货'] }],
    scopeRole: 'target',
    progress: 'received',
    remainingToggle: false,
    requireNoReceipt: true,
  },
  // 撤回审批回滚的是总部发货方库存：全表唯一的 source。
  'shipment-cancel-approval': {
    rules: [{ docType: '品项公司发货', statuses: ['待审批'] }],
    scopeRole: 'source',
    progress: 'none',
    remainingToggle: false,
    cancellationRequested: true,
  },
  'store-return-approval': {
    rules: [{ docType: '院退货', statuses: ['待审批'] }],
    scopeRole: 'target',
    progress: 'none',
    remainingToggle: false,
  },
  'market-return-approval': {
    rules: [{ docType: '市场退货', statuses: ['待审批'] }],
    scopeRole: 'target',
    progress: 'none',
    remainingToggle: false,
  },
}

/**
 * 白名单解析。**不能**写成 `INVENTORY_DOC_CANDIDATES[purpose]`：映射表是普通对象字面量，
 * `constructor` / `__proto__` 这类原型链键取出来是 truthy，校验会被绕过（同 #192 教训）。
 */
export function resolveInventoryDocCandidate(purpose: unknown): InventoryDocCandidateDefinition | null {
  if (typeof purpose !== 'string') return null
  if (!(INVENTORY_DOC_CANDIDATE_PURPOSES as readonly string[]).includes(purpose)) return null
  return INVENTORY_DOC_CANDIDATES[purpose as InventoryDocCandidatePurpose]
}

export const INVENTORY_DOC_CANDIDATE_PROGRESS_LABEL: Record<InventoryDocCandidateProgressKind, string> = {
  ordered: '已下单',
  shipped: '已发',
  allocated: '已配',
  received: '已收',
  none: '数量',
}

/**
 * 一键带出的单据张数上限。带出后采购表单要装载每张单的明细（批量接口一次取回，服务端逐张查），
 * 一个批次正常是十几个市场的汇总 + 若干需求单，100 张足够；再多提示缩小日期区间。
 */
export const INVENTORY_DOC_CANDIDATE_BULK_LIMIT = 100

export interface InventoryDocCandidateRow extends InventoryDocRow {
  /** done 为 null 表示该用途不计进度（审批类） */
  progress: { done: number | null; total: number }
}

export interface InventoryDocCandidateFilters {
  purpose: InventoryDocCandidatePurpose
  keyword?: string
  startDate?: string
  endDate?: string
  /** 只看某一收 / 发端（采购订单表单选了供应链主体后收窄到该总部） */
  targetOrgNodeId?: string
  /** 只看某一发起端（分院配货表单选了收货门店后收窄到该门店的报货单，#337） */
  sourceOrgNodeId?: string
  /** 建单类来源：true = 连已无剩余量的也列出 */
  includeExhausted?: boolean
  page?: number
  pageSize?: number
}

/**
 * 门店仍有未配报货的 SKU（#337 拍板 A）：分院配货自选行命中时提示「建议引用报货单」，不拦截。
 * 口径与 `store-allocation-source` 候选的 `allocated` 进度逐字同源。
 */
export interface StoreUnallocatedRequestSku {
  skuId: string
  remainingQuantity: number
  docIds: string[]
}
