import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrgNode } from "@/lib/types"
import { fmtDate, fmtDateTime } from "@/lib/datetime"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number | string | null | undefined): string {
  // 历史 WorkFine 拉取的订单/明细金额字段可能为 NULL；空串/非数值同样兜底，
  // 避免 num.toFixed() 在渲染期抛错导致整页白屏（React #419）。
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (num == null || Number.isNaN(num)) return '¥0.00'
  return `¥${num.toFixed(2)}`
}

/**
 * @deprecated 仅对 11 位手机号脱敏，其他长度返回明文。新代码请用
 * `import { formatPhoneSafe } from '@/lib/format'`（基于 pii.maskPhone，全长度统一脱敏）。
 */
export function formatPhone(phone: string): string {
  if (!phone || phone.length !== 11) return phone
  return `${phone.slice(0, 3)}****${phone.slice(7)}`
}

/**
 * 日期：YYYY-MM-DD（Asia/Shanghai 固定时区）。
 * 转调 lib/datetime 收口实现，避免本地时区方法在非北京浏览器下偏移。
 */
export function formatDate(date: string | Date | null | undefined): string {
  return fmtDate(date)
}

/**
 * 日期时间：YYYY-MM-DD HH:mm:ss（Asia/Shanghai 固定时区）。
 * 转调 lib/datetime 收口实现。
 */
export function formatDateTime(date: string | Date | null | undefined): string {
  return fmtDateTime(date)
}

/**
 * 计算给定订单金额下，优惠券的实际抵扣金额。
 * - 现金券/品项券：min(discountValue, totalAmount)
 * - 折扣券：totalAmount × (1 - discountValue)，可选 maxDiscount 封顶
 */
export function calcCouponDiscount(
  couponType: string,
  discountValue: string,
  maxDiscount: string | null,
  totalAmount: number,
): number {
  const dv = parseFloat(discountValue)
  if (couponType === '折扣券') {
    const saved = totalAmount * (1 - dv)
    return maxDiscount ? Math.min(saved, parseFloat(maxDiscount)) : saved
  }
  return Math.min(dv, totalAmount)
}

/** 构建组织节点的完整路径（跳过 headquarters 根节点），用 "/" 拼接 */
export function buildOrgPath(nodeId: string | null, orgNodes: OrgNode[]): string {
  if (!nodeId || orgNodes.length === 0) return ""
  const map = new Map(orgNodes.map((n) => [n.id, n]))
  const names: string[] = []
  const visited = new Set<string>()
  let current = map.get(nodeId)
  while (current && !visited.has(current.id)) {
    if (names.length === 0 || current.type !== "总部") {
      names.unshift(current.name)
    }
    visited.add(current.id)
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return names.join("/")
}

/**
 * 找 `nodeId` 自身及祖先里最近的「门店」型节点（#259）。
 *
 * 与服务端 `assertOwnershipConsistent` 的递归 CTE 同口径 —— 两处都是「向上最近的门店祖先」。
 * 用途：员工调店时若 `orgNodeId` 归属于**旧**门店，前端要跟着改成新门店的节点，
 * 否则提交上去会被服务端的归属自洽校验拦住（而这正是生产两条脏数据的成因：
 * 同市场内改门店、没动「所属组织」，于是 store 指向新店而 org_node 还指着旧店）。
 *
 * 挂在市场下的部门（养生部 / 财智部那类矩阵归属）没有门店祖先 → 返回 null → 不联动。
 */
export function findAncestorStoreNodeId(nodeId: string | null, orgNodes: OrgNode[]): string | null {
  if (!nodeId || orgNodes.length === 0) return null
  const map = new Map(orgNodes.map((n) => [n.id, n]))
  const visited = new Set<string>()
  let current = map.get(nodeId)
  while (current && !visited.has(current.id)) {
    if (current.type === "门店") return current.id
    visited.add(current.id)
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return null
}

/** 员工表单里这两个字段是联动的一对；两个方向的联动函数都返回要合并进 form 的**补丁** */
export type OwnershipFields = { storeId: string; orgNodeId: string }

/**
 * 用户改了「所属组织」→ 返回该合并进 form 的补丁。
 *
 * ## 为什么做成「旧状态 + 选择 → 新状态」的纯函数
 *
 * 上一版导出的是 `resolveStoreIdForOrgNode(...)` 这种「算出一个值」的 helper，联动的**接线**
 * （拿到值以后有没有真的 setState）只能靠页面源码的结构守护去认。codex 谱系第 6 轮给了具体绕过：
 * 把调用改成 `if (next !== undefined) void next`，或者门店方向保留 `findAncestorStoreNodeId(...)`
 * 但删掉 `handleChange("orgNodeId", ...)`，结构守护照样全绿而真实页面重新提交不自洽归属。
 *
 * 改成返回整份补丁后，页面只剩一行 `setForm(prev => ({ ...prev, ...patch }))`，
 * **联动逻辑本身**（包括「改门店时组织跟着变成什么」——那段以前只活在页面里、从未被测过）
 * 进入单测覆盖。与两条递归 CTE 的处理同源：要提高保障等级就让它可测，而不是继续加断言。
 *
 * 规则：
 *   - 新节点有门店祖先，且该门店在可选列表里 → 门店设成它（节点已明确指向某门店，无歧义）
 *   - 有门店祖先但被 scope 过滤掉了 → 清空门店，让用户自己选
 *   - 无门店祖先（市场下的部门等矩阵归属）→ 退回市场口径：当前门店不在新市场下才清空，
 *     否则保留（门店是工作地点、部门是专业归属，两者本就可以并存）
 */
export function applyOrgNodeSelection(
  form: OwnershipFields,
  nextOrgNodeId: string,
  orgNodes: OrgNode[],
  stores: { storeId: string; orgNodeId: string | null }[],
): Partial<OwnershipFields> {
  const patch: Partial<OwnershipFields> = { orgNodeId: nextOrgNodeId }

  const storeAncestor = findAncestorStoreNodeId(nextOrgNodeId, orgNodes)
  if (storeAncestor) {
    const target = stores.find((s) => s.orgNodeId === storeAncestor)
    const nextStoreId = target ? target.storeId : ''
    if (nextStoreId !== form.storeId) patch.storeId = nextStoreId
    return patch
  }

  const nextMarketId = findAncestorMarketId(nextOrgNodeId, orgNodes)
  const storeMarketId = findAncestorMarketId(
    stores.find((s) => s.storeId === form.storeId)?.orgNodeId ?? null,
    orgNodes,
  )
  if (nextMarketId !== storeMarketId && form.storeId !== '') patch.storeId = ''
  return patch
}

/**
 * 用户改了「所属门店」→ 返回该合并进 form 的补丁。
 *
 * 所属组织若归属于**旧**门店，跟着改成新门店的节点。不联动的话「同市场内改门店、不动所属组织」
 * 会提交 `{新门店, 旧门店的节点}`，被服务端归属自洽校验拒绝 —— 而这正是生产上两条脏数据
 * （王芳、王小凤）的成因。挂市场下的部门（养生部/财智部那类矩阵归属）没有门店祖先，不受影响。
 */
export function applyStoreSelection(
  form: OwnershipFields,
  nextStoreId: string,
  orgNodes: OrgNode[],
  stores: { storeId: string; orgNodeId: string | null }[],
): Partial<OwnershipFields> {
  const patch: Partial<OwnershipFields> = { storeId: nextStoreId }

  const currentStoreAncestor = findAncestorStoreNodeId(form.orgNodeId || null, orgNodes)
  if (!currentStoreAncestor) return patch     // 组织挂在市场下，与门店维度无关

  const nextNode = stores.find((s) => s.storeId === nextStoreId)?.orgNodeId ?? ''
  if (nextNode !== currentStoreAncestor) patch.orgNodeId = nextNode
  return patch
}

/** 查找组织节点所属的市场节点 ID（自身及祖先里最近的「市场」型节点，向上遍历 parentId 链） */
export function findAncestorMarketId(nodeId: string | null, orgNodes: OrgNode[]): string | null {
  if (!nodeId || orgNodes.length === 0) return null
  const map = new Map(orgNodes.map((n) => [n.id, n]))
  const visited = new Set<string>()
  let current = map.get(nodeId)
  while (current && !visited.has(current.id)) {
    if (current.type === "市场") return current.id
    visited.add(current.id)
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return null
}
