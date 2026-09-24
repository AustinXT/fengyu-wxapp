import { notFound } from 'next/navigation'
import {
  INVENTORY_GENERIC_DOC_TYPES,
  type InventoryDocType,
  type InventoryLocationType,
} from '@/lib/inventory/types'
import type { AuthSession } from '@/lib/types'
import { hasPermission } from '@/lib/permissions'

export const INVENTORY_BUSINESS_LEVELS = ['supply-chain', 'market', 'store'] as const
export type InventoryBusinessLevel = (typeof INVENTORY_BUSINESS_LEVELS)[number]

const LEVEL_ACTION_ACCESS: Record<InventoryBusinessLevel, readonly string[]> = {
  'supply-chain': ['inventory:supply_chain_operate', 'inventory:supply_chain_approve'],
  market: ['inventory:market_operate', 'inventory:market_approve'],
  store: ['inventory:store_operate'],
}

export function canAccessInventoryBusinessLevel(session: AuthSession, level: InventoryBusinessLevel): boolean {
  return LEVEL_ACTION_ACCESS[level].some((action) => hasPermission(session, action))
}

export function requireInventoryBusinessLevel(
  session: AuthSession | null,
  level: InventoryBusinessLevel,
): asserts session is AuthSession {
  if (!session || !canAccessInventoryBusinessLevel(session, level)) notFound()
}

const LEVEL_OPERATE_ACTION: Record<InventoryBusinessLevel, string> = {
  'supply-chain': 'inventory:supply_chain_operate',
  market: 'inventory:market_operate',
  store: 'inventory:store_operate',
}

/**
 * 层级 → 该层级的库存操作权限。
 *
 * 这份对应关系原先散在四处（engine 的建单校验、办理台页面的 operateAction 三元、
 * 办理台组件、以及本文件的 LEVEL_ACTION_ACCESS），新增层级或改 action 名要改四处，
 * 漂移了也没有任何测试会红。收敛到这里当单源。
 */
export function inventoryLevelOperateAction(level: InventoryBusinessLevel): string {
  return LEVEL_OPERATE_ACTION[level]
}

/**
 * 代建层级序：**从上级到下级**。数组位置即层级深度，`slice(0, idx + 1)` 取到的就是
 * 「本层级 + 它全部的上级」—— 其中哪些上级真的能代建，再由
 * `LEVEL_SCOPE_EXPANDS_DOWNWARD` 过滤一道。
 *
 * 导出仅供单测钉住「与 INVENTORY_BUSINESS_LEVELS 成员一致」（漏一个层级立刻红），
 * 业务代码请走 `inventoryDelegatableOperateActions`。
 */
export const LEVEL_DELEGATION_ORDER = [
  'supply-chain',
  'market',
  'store',
] as const satisfies readonly InventoryBusinessLevel[]

/**
 * 该层级的库存 scope 是否会**向下展开到后代主体**。
 *
 * 直接决定「持有本层级 operate 的账号能不能替下级建单」—— scope 不展开的话，代建放开了
 * 也选不出下级主体，只会在建单下拉里堆一串必然 403 的死路选项（服务端的
 * assertOrgNodeVisible 照样拒）。
 *
 * ⚠️ 与 access.ts 的 `inventoryScopedOrgNodeIds` 是**同一条规则的两处表述**：那里对
 * `scopeType === '总部'` 的绑定只计入 `role.scopeId` 本身、不展开后代，市场/门店绑定才用
 * 展开后的 `role.scopeOrgNodeIds`。改那边必须同步这里。
 *
 * 将来若把总部 scope 改成展开后代，只要把这里的 `'supply-chain'` 翻成 true，
 * 总部代建（服务端闸 + UI 下拉）自动生效，不必再动别的代码。
 */
const LEVEL_SCOPE_EXPANDS_DOWNWARD: Record<InventoryBusinessLevel, boolean> = {
  'supply-chain': false, // 总部 scope 不展开后代：总部账号根本选不出市场/门店主体
  market: true, // 市场 scope 含下属门店
  store: true, // 最底层，无下级
}

/**
 * 某个业务层级的单据，允许由**哪些层级**的 operate 来建 —— 本层级 ∪「scope 会向下展开的上级层级」。
 *
 * 门店单 → [market, store]；市场单 → [market]；供应链单 → [supply-chain]。
 *
 * 只放开「scope 会向下展开」的上级，是为了让代建能力与 access.ts 的真实可见范围对齐：
 * 总部 scope 不展开后代（见 LEVEL_SCOPE_EXPANDS_DOWNWARD），所以总部代建是死路，
 * 与其让它在 UI 里挂着、在服务端被 assertOrgNodeVisible 拒，不如在层级闸就明确拒掉。
 *
 * 传入非法层级（类型系统之外的脏值）时 indexOf 返回 -1 → slice(0, 0) → 空数组，fail-closed。
 */
export function inventoryDelegatableLevels(level: InventoryBusinessLevel): InventoryBusinessLevel[] {
  const idx = LEVEL_DELEGATION_ORDER.indexOf(level)
  return LEVEL_DELEGATION_ORDER.slice(0, idx + 1).filter(
    // 本层级永远在候选里（它是否展开只影响它能不能替**下级**建单）；
    // 严格上级只有 scope 会向下展开的才入选。
    (candidate) => candidate === level || LEVEL_SCOPE_EXPANDS_DOWNWARD[candidate],
  )
}

/**
 * 某个业务层级的单据，允许**哪些** operate 权限来建。
 *
 * 门店单 → [market_operate, store_operate]；
 * 市场单 → [market_operate]；
 * 供应链单 → [supply_chain_operate]。
 *
 * 甲方 2026-09-21 拍板：生产存在「市场人员替门店建单」的工作流，显式放开**向下**代建；
 * **向上**（门店建市场单 / 市场建供应链单）仍然 fail-closed。总部替市场/门店代建今天
 * **不放开** —— 总部 scope 不展开后代，放开了也选不出主体（见 LEVEL_SCOPE_EXPANDS_DOWNWARD）。
 *
 * ⚠️ 与上面的 LEVEL_ACTION_ACCESS 是**两套语义不同**的层级表，别合并：
 *   - LEVEL_ACTION_ACCESS  → 「能进哪个办理台页面」（含 approve 类 action，不含代建方向）
 *   - 本函数               → 「能替哪一层建单」（只看 operate，且只沿 scope 能展开的方向放开）
 */
export function inventoryDelegatableOperateActions(level: InventoryBusinessLevel): string[] {
  return inventoryDelegatableLevels(level).map((l) => LEVEL_OPERATE_ACTION[l])
}

/**
 * 通用待收货单（分院调货出库 / 市场间调货出库）确认收货的权限门，单源。
 * `confirmInventoryCoreReceive` 与单据中心「收货」按钮的行级判据都从这里取 ——
 * 两边一旦各写一份，按钮就会比服务端宽或窄一档（#340 评审 P1）。
 * 收货不随代建放开，只认市场 / 门店自己的 operate（见单据中心 page.tsx 的 canReceive 注释）。
 */
export const INVENTORY_CORE_RECEIVE_ACTIONS = ['inventory:market_operate', 'inventory:store_operate'] as const

const LEVEL_LABEL: Record<InventoryBusinessLevel, string> = {
  'supply-chain': '供应链',
  market: '市场',
  store: '门店',
}

/**
 * 层级 action 闸的拒绝文案 —— 由候选层级集直接生成，不手写「或其上级层级」。
 *
 * 供应链是最顶层，没有上级；市场单的候选集里也只剩市场自己（总部不展开 scope）。
 * 写死「或其上级层级」会让用户去找一个根本不存在 / 帮不上忙的权限。文案随
 * LEVEL_SCOPE_EXPANDS_DOWNWARD 自动跟着变，改表不必再改这句话。
 *
 * 本层级排在最前（「缺少门店或市场库存操作权限」），先说本该由谁建，再说谁能代建。
 */
export function inventoryLevelOperateDeniedMessage(level: InventoryBusinessLevel): string {
  const delegatable = inventoryDelegatableLevels(level)
  const ordered = [level, ...delegatable.filter((candidate) => candidate !== level)]
  return `缺少${ordered.map((candidate) => LEVEL_LABEL[candidate]).join('或')}库存操作权限`
}

export function inventoryBusinessPath(level: InventoryBusinessLevel): string {
  return `/inventory/operations/${level}`
}

export function inventoryBusinessLocationType(level: InventoryBusinessLevel): InventoryLocationType {
  return level === 'supply-chain' ? '总部' : level === 'market' ? '市场' : '门店'
}

const GENERIC_DOC_BUSINESS_LEVEL: Partial<Record<InventoryDocType, InventoryBusinessLevel>> = {
  内部领用: 'supply-chain',
  市场间调货出库: 'market',
  市场产品报损: 'market',
  市场产品盘溢: 'market',
  市场库存盘点: 'market',
  分院调货出库: 'store',
  院顾客产品出库: 'store',
  院顾客退货: 'store',
  院产品报损: 'store',
  分院库存盘点: 'store',
}

export function genericDocBusinessLevel(docType: InventoryDocType): InventoryBusinessLevel | null {
  return GENERIC_DOC_BUSINESS_LEVEL[docType] ?? null
}

/**
 * 当前会话能建哪些通用单据类型（UI 侧建单下拉的唯一口径）。
 *
 * 与服务端 createInventoryCoreDoc 的层级 action 闸同源：都走
 * `genericDocBusinessLevel` + `inventoryDelegatableOperateActions`，UI 不再手搓三元映射。
 * 服务端仍会独立复核，这里只负责「别让用户点一个必然 403 的选项」——
 * 这也正是代建候选集要按 `LEVEL_SCOPE_EXPANDS_DOWNWARD` 收紧的原因：总部 scope 不展开
 * 后代，把总部塞进候选集会让只有 supply_chain_operate 的账号在下拉里看到 10 种单据，
 * 其中 9 种建到一半必被 assertOrgNodeVisible 拒。
 *
 * `has` 由调用方注入（页面侧一般是 `(action) => hasUiCapability(actions, action)`），
 * 本函数因而保持纯函数、可单测。空权限 → 空数组（fail-closed）。
 */
export function inventoryCreatableGenericDocTypes(has: (action: string) => boolean): InventoryDocType[] {
  return INVENTORY_GENERIC_DOC_TYPES.filter((docType) => {
    const level = genericDocBusinessLevel(docType)
    return !!level && inventoryDelegatableOperateActions(level).some(has)
  })
}

export function getDefaultInventoryBusinessLevel(session: AuthSession): InventoryBusinessLevel {
  if (canAccessInventoryBusinessLevel(session, 'supply-chain')) return 'supply-chain'
  if (canAccessInventoryBusinessLevel(session, 'market')) return 'market'
  return 'store'
}
