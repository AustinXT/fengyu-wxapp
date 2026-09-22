/**
 * 员工表单里「所属组织 ⇄ 所属门店」两个字段的联动口径（#259 前端侧）。
 *
 * 为什么要单测这个而不是只跑页面：服务端的归属自洽校验一旦收紧，
 * 前端**不联动**就等于把合法操作变成报错 —— 生产两条脏数据（王芳、王小凤）正是
 * 「同市场内改门店、没动所属组织」造出来的，而收紧后同一个操作会被直接拒掉。
 * 联动逻辑是纯函数，值得单独钉住。
 */
import { describe, it, expect } from 'vitest'
import { findAncestorStoreNodeId, resolveStoreIdForOrgNode } from './utils'
import type { OrgNode } from './types'

/**
 * 总部 hq
 * └── 市场 m1
 *     ├── 门店 org-s1 ── 部门 d1
 *     ├── 门店 org-s2
 *     └── 部门 m1-dept        （挂市场下 → 无门店祖先，矩阵式归属）
 * 另一个市场 m2 ── 门店 org-s3（scope 外，不在 stores 列表里）
 */
const ORG_NODES = [
  { id: 'hq', name: '总部', type: '总部', parentId: null },
  { id: 'm1', name: '市场一', type: '市场', parentId: 'hq' },
  { id: 'org-s1', name: 'A店', type: '门店', parentId: 'm1' },
  { id: 'd1', name: 'A店养生部', type: '部门', parentId: 'org-s1' },
  { id: 'org-s2', name: 'B店', type: '门店', parentId: 'm1' },
  { id: 'm1-dept', name: '财智部', type: '部门', parentId: 'm1' },
  { id: 'm2', name: '市场二', type: '市场', parentId: 'hq' },
  { id: 'org-s3', name: 'C店', type: '门店', parentId: 'm2' },
] as unknown as OrgNode[]

/** org-s3 刻意缺席 —— 模拟被 scope 过滤掉的门店 */
const STORES = [
  { storeId: 'S001', orgNodeId: 'org-s1' },
  { storeId: 'S002', orgNodeId: 'org-s2' },
]

describe('findAncestorStoreNodeId — 与服务端 CTE 同口径', () => {
  it('门店节点自身 → 返回自身', () => {
    expect(findAncestorStoreNodeId('org-s1', ORG_NODES)).toBe('org-s1')
  })

  it('门店下的部门 → 上溯到该门店', () => {
    expect(findAncestorStoreNodeId('d1', ORG_NODES)).toBe('org-s1')
  })

  it('市场下的部门 → null（矩阵式归属，与门店维度无关）', () => {
    expect(findAncestorStoreNodeId('m1-dept', ORG_NODES)).toBeNull()
  })

  it('市场 / 总部节点 → null', () => {
    expect(findAncestorStoreNodeId('m1', ORG_NODES)).toBeNull()
    expect(findAncestorStoreNodeId('hq', ORG_NODES)).toBeNull()
  })

  it('节点不在树里 → null，不抛', () => {
    expect(findAncestorStoreNodeId('nope', ORG_NODES)).toBeNull()
  })

  /** 组织表没有 DB 级防环约束，前端遍历同样要防（visited 集合） */
  it('自成环 → 不死循环', () => {
    const looped = [
      { id: 'x', name: 'X', type: '部门', parentId: 'y' },
      { id: 'y', name: 'Y', type: '部门', parentId: 'x' },
    ] as unknown as OrgNode[]
    expect(findAncestorStoreNodeId('x', looped)).toBeNull()
  })
})

describe('resolveStoreIdForOrgNode — 组织→门店的反向联动', () => {
  /**
   * GLM 谱系第 4 轮：原先只按**市场**判断，于是同市场内把组织改到另一门店的子树时
   * 市场没变 → storeId 保持旧门店 → 提交上去正好撞服务端归属自洽校验，用户得二次试错。
   */
  it('改到同市场另一门店的部门 → 门店跟着改成那个门店', () => {
    expect(resolveStoreIdForOrgNode('org-s2', 'S001', ORG_NODES, STORES)).toBe('S002')
  })

  it('改到本门店的下属部门 → 门店不动（已经一致）', () => {
    expect(resolveStoreIdForOrgNode('d1', 'S001', ORG_NODES, STORES)).toBeUndefined()
  })

  it('改到门店节点自身 → 门店跟着改', () => {
    expect(resolveStoreIdForOrgNode('org-s1', 'S002', ORG_NODES, STORES)).toBe('S001')
  })

  /** 有门店祖先但那个门店不在可选列表里（被 scope 过滤）→ 清空让用户自己选，不能留旧值 */
  it('改到 scope 外门店的节点 → 清空门店', () => {
    expect(resolveStoreIdForOrgNode('org-s3', 'S001', ORG_NODES, STORES)).toBe('')
  })

  it('市场下的部门（矩阵归属）+ 门店在同一市场 → 保留门店', () => {
    expect(resolveStoreIdForOrgNode('m1-dept', 'S001', ORG_NODES, STORES)).toBeUndefined()
  })

  it('改到另一市场的节点 + 门店在原市场 → 清空门店（原有市场口径）', () => {
    expect(resolveStoreIdForOrgNode('m2', 'S001', ORG_NODES, STORES)).toBe('')
  })

  /** 门店本来就空时不要返回 `''` —— 那会触发一次无意义的 setState */
  it('门店本来就空 → 一律不动', () => {
    expect(resolveStoreIdForOrgNode('org-s3', '', ORG_NODES, STORES)).toBeUndefined()
    expect(resolveStoreIdForOrgNode('m2', '', ORG_NODES, STORES)).toBeUndefined()
  })
})
