/**
 * 组织树范围基础工具。
 *
 * 所有授权范围均按“节点自身 + 任意层级后代”解释。这里保持纯函数，调用方可在
 * 会话构造、权限校验和 UI 路径展开时复用，且异常的循环数据不会造成死循环。
 */

import { db } from '@/db'
import { orgNodes, stores } from '@db/org'

export interface OrgScopeNode {
  id: string
  parentId: string | null
  type?: string
}

/** 返回 roots 自身及其全部后代节点，按树中首次发现顺序去重。 */
export function collectDescendantNodeIds(
  nodes: OrgScopeNode[],
  roots: Iterable<string>,
): string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.parentId) continue
    const children = childrenByParent.get(node.parentId) ?? []
    children.push(node.id)
    childrenByParent.set(node.parentId, children)
  }

  const result: string[] = []
  const visited = new Set<string>()
  const queue = Array.from(new Set(Array.from(roots).filter(Boolean)))

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    result.push(nodeId)

    for (const childId of childrenByParent.get(nodeId) ?? []) {
      if (!visited.has(childId)) queue.push(childId)
    }
  }

  return result
}

/** 向上查找指定类型的祖先；包含当前节点，且对循环链路安全。 */
export function findAncestorNodeIdByType(
  nodes: OrgScopeNode[],
  nodeId: string | null | undefined,
  type: string,
): string | null {
  if (!nodeId) return null
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const visited = new Set<string>()
  let current = nodeById.get(nodeId)

  while (current && !visited.has(current.id)) {
    if (current.type === type) return current.id
    visited.add(current.id)
    current = current.parentId ? nodeById.get(current.parentId) : undefined
  }

  return null
}

/**
 * 解析组织节点子树对应的门店 ID。
 *
 * 总部和不存在的节点维持调用方既有“不过滤”语义；其它节点返回自身及所有后代关联门店。
 */
export async function resolveOrgNodeToStoreIds(rootNodeId: string): Promise<string[] | null> {
  const [nodes, storeRows] = await Promise.all([
    db.select({ id: orgNodes.id, parentId: orgNodes.parentId, type: orgNodes.type }).from(orgNodes),
    db.select({ storeId: stores.storeId, orgNodeId: stores.orgNodeId }).from(stores),
  ])
  const root = nodes.find((node) => node.id === rootNodeId)
  if (!root || root.type === '总部') return null

  const nodeIds = new Set(collectDescendantNodeIds(nodes, [rootNodeId]))
  return Array.from(new Set(
    storeRows
      .filter((store) => store.orgNodeId && nodeIds.has(store.orgNodeId))
      .map((store) => store.storeId),
  ))
}
