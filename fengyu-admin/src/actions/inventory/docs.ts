'use server'

import {
  approveInventoryCoreDoc as approveInventoryCoreDocImpl,
  confirmInventoryCoreReceive as confirmInventoryCoreReceiveImpl,
  createInventoryCoreDoc as createInventoryCoreDocImpl,
  getInventoryCoreDocById as getInventoryCoreDocByIdImpl,
  listInventoryCoreDocs as listInventoryCoreDocsImpl,
  rejectInventoryCoreDoc as rejectInventoryCoreDocImpl,
} from '@/lib/inventory/engine'
import type { CreateInventoryDocInput, InventoryCoreDocStatus, InventoryDocType, InventoryLocationType } from '@/lib/inventory/types'
import { INVENTORY_CORE_RECEIVE_ACTIONS } from '@/lib/inventory/business-level'
import { resolveOperationDocQuery } from '@/lib/inventory/operation-doc-types'
import type { InventoryOperationDocFilter } from '@/lib/inventory/operation-doc-types'
import { ApiError } from '@/lib/api-error'
import { withAnyPermission, withPermission } from '@/lib/with-permission'

export const listInventoryCoreDocs = withPermission(
  'inventory:list',
  async (
    _session,
    filters: {
      orgNodeId?: string
      locationType?: InventoryLocationType
      docType?: InventoryDocType
      status?: InventoryCoreDocStatus
      startDate?: string
      endDate?: string
      keyword?: string
      page?: number
      pageSize?: number
    } = {},
  ) => listInventoryCoreDocsImpl(filters),
)

/**
 * 办理台业务工作区「单据」Tab 的数据源（#190 单段 → #192 两段）。
 *
 * 客户端只传业务卡片 id，**单据类型 / 状态 / 层级收窄一律在服务端查映射表解析** ——
 * 不让客户端直接指定 docType，省得日后有人从这个入口拼出一份绕过办理台语义的查询。
 * 可见范围完全沿用 `listInventoryCoreDocs` 的 scope 过滤，不另起一套口径。
 *
 * 返回两段：`produced`（本业务产出的单）与 `inbox`（本业务要处理的上游待办单，
 * 没有待办语义的业务恒为 `null`）。两段**各自分页**（`page` / `inboxPage`），
 * 共用同一个 `pageSize`，并各自回传 engine 夹过白名单后的实际页长 ——
 * 前端必须按各自返回的 `pageSize` 算总页数，别共用一个 state。
 *
 * ⚠️ 有 inbox 的业务每次加载是 **2 次** engine 调用（各带一次 COUNT +
 * syncInventoryLocations + getSession，因为 `listInventoryCoreDocs` 自身是
 * withPermission 包装的）。没有 inbox 的 17 个业务仍只查 1 次 —— 别图省事无条件查两次。
 */
export const listInventoryOperationDocs = withPermission(
  'inventory:list',
  async (
    _session,
    input: { operationId: string; page?: number; inboxPage?: number; pageSize?: number },
  ) => {
    /*
     * `resolveOperationDocQuery` 内部先过白名单再查表，**不能**退回成
     * `MAP[input.operationId]` —— 映射表是普通对象字面量，`constructor` / `toString` /
     * `__proto__` 这些原型链上的键取出来都是 truthy，`if (!query) throw` 拦不住；
     * 而它们的 produced.docTypes/statuses 全是 undefined（连 produced 本身都是 undefined，
     * 直接读会 TypeError），engine 里那几个 `if (filters.xxx)` 分支一个都不进，
     * 结果就是**返回 scope 内全部库存单据**，收窄承诺整个失效。
     * 通用业务（`generic:<docType>`）同样只认 INVENTORY_GENERIC_DOC_TYPES 白名单。
     */
    const query = resolveOperationDocQuery(input.operationId)
    if (!query) throw new ApiError('INVALID_PARAMS', '未知的库存业务')
    // 显式逐字段转发（不用 spread）：映射表哪天多一个字段，这里不改就传不过去，
    // 比 spread 悄悄把无关字段混进 engine filters 更好排查。
    const toFilters = (filter: InventoryOperationDocFilter, page?: number) => ({
      docTypes: filter.docTypes,
      statuses: filter.statuses,
      locationType: filter.locationType,
      // 漏转 scopeRole 不会报错，只会让待办区回到「双端 OR」：对端拿到一排
      // 点了必 PERMISSION_DENIED 的行内按钮（#192 P1）。
      scopeRole: filter.scopeRole,
      cancellationRequested: filter.cancellationRequested,
      pendingItemScope: filter.pendingItemScope,
      page,
      pageSize: input.pageSize,
    })
    const produced = await listInventoryCoreDocsImpl(toFilters(query.produced, input.page))
    const inbox = query.inbox
      ? await listInventoryCoreDocsImpl(toFilters(query.inbox, input.inboxPage))
      : null
    return { produced, inbox }
  },
)

export const getInventoryCoreDocById = withPermission(
  'inventory:list',
  async (_session, id: string) => getInventoryCoreDocByIdImpl(id),
)

export const createInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_operate', 'inventory:market_operate', 'inventory:store_operate'],
  async (_session, input: CreateInventoryDocInput) => createInventoryCoreDocImpl(input),
)

export const approveInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (_session, id: string, auditRemark?: string | null) =>
    approveInventoryCoreDocImpl(id, auditRemark),
)

export const rejectInventoryCoreDoc = withAnyPermission(
  ['inventory:supply_chain_approve', 'inventory:market_approve'],
  async (_session, id: string, auditRemark?: string | null) =>
    rejectInventoryCoreDocImpl(id, auditRemark),
)

export const confirmInventoryCoreReceive = withAnyPermission(
  // 与 engine 内层闸、单据中心收货按钮的行级判据同一单源（#340）
  [...INVENTORY_CORE_RECEIVE_ACTIONS],
  async (_session, outboundDocId: string, remark?: string | null) =>
    confirmInventoryCoreReceiveImpl(outboundDocId, remark),
)
