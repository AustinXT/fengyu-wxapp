import { describe, expect, it } from 'vitest'
import { collectDescendantNodeIds, findAncestorNodeIdByType } from './org-scope'

describe('组织树范围工具', () => {
  const nodes = [
    { id: 'hq', parentId: null, type: '总部' },
    { id: 'market', parentId: 'hq', type: '市场' },
    { id: 'middle', parentId: 'market', type: '部门' },
    { id: 'store', parentId: 'middle', type: '门店' },
    { id: 'dept', parentId: 'store', type: '部门' },
    { id: 'other', parentId: 'hq', type: '市场' },
  ]

  it('展开根节点自身及任意层级后代，多个 roots 去重', () => {
    expect(collectDescendantNodeIds(nodes, ['market', 'store', 'market'])).toEqual([
      'market', 'store', 'middle', 'dept',
    ])
  })

  it('循环组织数据不会死循环或重复返回', () => {
    const cyclic = [
      { id: 'a', parentId: 'c', type: '市场' },
      { id: 'b', parentId: 'a', type: '门店' },
      { id: 'c', parentId: 'b', type: '部门' },
    ]
    expect(collectDescendantNodeIds(cyclic, ['a'])).toEqual(['a', 'b', 'c'])
    expect(findAncestorNodeIdByType(cyclic, 'c', '市场')).toBe('a')
  })

  it('向上找市场不受旧五层限制', () => {
    const deepNodes = [
      { id: 'market', parentId: null, type: '市场' },
      { id: 'n1', parentId: 'market', type: '部门' },
      { id: 'n2', parentId: 'n1', type: '部门' },
      { id: 'n3', parentId: 'n2', type: '部门' },
      { id: 'n4', parentId: 'n3', type: '部门' },
      { id: 'n5', parentId: 'n4', type: '部门' },
      { id: 'store', parentId: 'n5', type: '门店' },
    ]
    expect(findAncestorNodeIdByType(deepNodes, 'store', '市场')).toBe('market')
  })
})
