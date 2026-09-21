/**
 * 办理台 ⇄ 单据详情 的「来源参数」白名单（#190）。
 *
 * 甲方原话：「点单据号、新标签打开，返回要求仍然可以返回到原来的页面」。实现是混合方案 ——
 * 单据号仍是原生 `<a target="_blank" rel="opener">`（保留中键 / Cmd+点击 / 复制链接地址），
 * href 上带两个**闭集枚举**当来源；详情页据此渲染「返回XX办理台」，点击时优先
 * `window.close()` 回到原标签（表单一个字不丢），关不掉再降级导航到本模块拼出的路径。
 *
 * ⚠️ 安全要点：本模块**不接收也不回显完整 URL**。外部能注入的只有 level 与 operationId
 * 两个闭集枚举值，返回路径由本模块自行拼装 —— 开放重定向从源头上就没有入口面。
 * 不要为了「更通用」把它改成吃 `returnTo=<完整路径>`。
 *
 * ⚠️ 模块纯净度：对 `./business-level` **只能 `import type`**。business-level 运行时会拖
 * `@/lib/permissions` → `@/db`，值导入会把服务端模块打进客户端 bundle（本模块被
 * `'use client'` 的 inventory-operations-page.tsx 值导入）。这类回归 tsc 不报、单测不报，
 * 只有 `bun run build` 才炸 —— operation-return.test.ts 里有一条源码守护钉住它。
 *
 * ⚠️ 办理台链接**不要**再叠加 `?returnTo=`：详情页的 ReturnContextLink 里 returnTo 优先级更高
 * （components/return-context.tsx:41-44），叠上去会让文案（办理台）与落点（单据中心）打架。
 */
import {
  INVENTORY_OPERATION_IDS,
  parseGenericOperationId,
  type InventoryAnyOperationId,
} from './operation-doc-types'
import type { InventoryBusinessLevel } from './business-level'

/**
 * level → 中文名。`Record<联合类型, …>` 已经给了编译期穷尽性，
 * 所以 level 白名单直接由这张表的 own key 派生，不需要运行时再导入常量数组。
 */
export const INVENTORY_BUSINESS_LEVEL_LABELS: Record<InventoryBusinessLevel, string> = {
  'supply-chain': '供应链',
  market: '市场',
  store: '门店',
}

/** 来源标记。参数名刻意避开 `create` / `view`：办理台页面会把带那两个键的请求整体重定向。 */
export const INVENTORY_DOC_RETURN_FROM = 'operations'

export interface InventoryDocReturnQuery {
  from?: string
  level?: string
  op?: string
}

export interface InventoryDocReturn {
  href: string
  label: string
}

function isBusinessLevel(value: string | undefined | null): value is InventoryBusinessLevel {
  // 用 hasOwnProperty 而不是 `in`：`in` 会走原型链，`level=toString` / `level=__proto__`
  // 能直接命中 Object.prototype 上的成员混过白名单。
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(INVENTORY_BUSINESS_LEVEL_LABELS, value)
}

function isOperationId(value: string | undefined | null): value is InventoryAnyOperationId {
  if (!value) return false
  if ((INVENTORY_OPERATION_IDS as readonly string[]).includes(value)) return true
  // 通用建单卡的 id 形如 `generic:<docType>`，docType 再过 INVENTORY_GENERIC_DOC_TYPES 白名单。
  return parseGenericOperationId(value) !== null
}

/** 把任意字符串收窄成合法业务卡片 id，非法一律 null（办理台恢复侧与详情页共用同一道白名单）。 */
export function parseInventoryOperationId(
  value: string | undefined | null,
): InventoryAnyOperationId | null {
  return isOperationId(value) ? value : null
}

/** 返回落点停在哪个 Tab。只认 `docs`，其余（含缺省、脏值）一律回「填报表单」。 */
export function parseInventoryOperationsTab(value: string | undefined | null): 'form' | 'docs' {
  return value === 'docs' ? 'docs' : 'form'
}

/**
 * 办理台单据 Tab 里的单据号 href。
 *
 * `docId` 形如 `CGD-20260916-0001`（ASCII），`encodeURIComponent` 是防御性的，
 * 与详情页血缘链接的现有写法对齐。
 */
export function inventoryOperationDocHref(
  docId: string,
  level: InventoryBusinessLevel,
  operationId: InventoryAnyOperationId,
): string {
  const query = new URLSearchParams({ from: INVENTORY_DOC_RETURN_FROM, level, op: operationId })
  return `/inventory/docs/${encodeURIComponent(docId)}?${query.toString()}`
}

/**
 * 详情页 searchParams → 「返回XX办理台」的落点与文案。
 *
 * 非法 / 缺省一律返回 `null`＝**不渲染办理台返回入口**（页面回落到既有的
 * 「返回单据中心」ReturnContextLink），而不是拿着脏值拼一个路径出去。
 */
export function resolveInventoryDocReturn(
  query: InventoryDocReturnQuery | undefined | null,
): InventoryDocReturn | null {
  if (!query || query.from !== INVENTORY_DOC_RETURN_FROM) return null
  const level = query.level
  const op = query.op
  if (!isBusinessLevel(level) || !isOperationId(op)) return null
  const target = new URLSearchParams({ op, tab: 'docs' })
  return {
    href: `/inventory/operations/${level}?${target.toString()}`,
    label: `返回${INVENTORY_BUSINESS_LEVEL_LABELS[level]}办理台`,
  }
}

/**
 * 把校验过的来源参数透传给另一张单（血缘跳转用）。
 *
 * 回显的是**校验后**的值，不是原始 query —— 直接回显原始输入等于把未过滤的字符串写进 href。
 * 当前详情页刻意不调用它（链路深了之后「返回办理台」会跨过好几张单，反而困惑）；
 * 留作单源，将来要接时不必再手搓一份拼装逻辑。
 */
export function forwardInventoryDocReturn(
  docId: string,
  query: InventoryDocReturnQuery | undefined | null,
): string {
  const base = `/inventory/docs/${encodeURIComponent(docId)}`
  if (!query || query.from !== INVENTORY_DOC_RETURN_FROM) return base
  const level = query.level
  const op = query.op
  if (!isBusinessLevel(level) || !isOperationId(op)) return base
  return inventoryOperationDocHref(docId, level, op)
}
