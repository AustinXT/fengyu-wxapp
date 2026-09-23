/**
 * 员工表单里「所属组织 ⇄ 所属门店」两个字段的联动口径（#259 前端侧）。
 *
 * 为什么要单测这个而不是只跑页面：服务端的归属自洽校验一旦收紧，
 * 前端**不联动**就等于把合法操作变成报错 —— 生产两条脏数据（王芳、王小凤）正是
 * 「同市场内改门店、没动所属组织」造出来的，而收紧后同一个操作会被直接拒掉。
 * 联动逻辑是纯函数，值得单独钉住。
 */
import { describe, it, expect } from 'vitest'
import { findAncestorStoreNodeId, applyOrgNodeSelection, applyStoreSelection } from './utils'
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

describe('applyOrgNodeSelection — 改组织后的完整补丁', () => {
  /**
   * codex 谱系第 6 轮：上一版导出的是「算出一个值」的 helper，联动的**接线**只能靠页面源码
   * 结构守护去认，而 `if (next !== undefined) void next` 之类的绕过让守护全绿、页面真回归。
   * 改成返回整份补丁后，这里断言的就是「旧表单 + 用户选择 → 新表单」的最终字段。
   */
  it('总是把 orgNodeId 写进补丁（哪怕门店不动）', () => {
    expect(applyOrgNodeSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, 'd1', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'd1' })
  })

  /**
   * GLM 谱系第 4 轮：原先只按**市场**判断，于是同市场内把组织改到另一门店的子树时
   * 市场没变 → storeId 保持旧门店 → 提交上去正好撞服务端归属自洽校验，用户得二次试错。
   */
  it('改到同市场另一门店的部门 → 门店跟着改成那个门店', () => {
    expect(applyOrgNodeSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, 'org-s2', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'org-s2', storeId: 'S002' })
  })

  it('改到门店节点自身 → 门店跟着改', () => {
    expect(applyOrgNodeSelection({ storeId: 'S002', orgNodeId: 'org-s2' }, 'org-s1', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'org-s1', storeId: 'S001' })
  })

  /** 有门店祖先但那个门店不在可选列表里（被 scope 过滤）→ 清空让用户自己选，不能留旧值 */
  it('改到 scope 外门店的节点 → 清空门店', () => {
    expect(applyOrgNodeSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, 'org-s3', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'org-s3', storeId: '' })
  })

  it('市场下的部门（矩阵归属）+ 门店在同一市场 → 保留门店', () => {
    expect(applyOrgNodeSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, 'm1-dept', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'm1-dept' })
  })

  it('改到另一市场的节点 + 门店在原市场 → 清空门店（原有市场口径）', () => {
    expect(applyOrgNodeSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, 'm2', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'm2', storeId: '' })
  })

  /** 门店本来就空时补丁里不该出现 `storeId` —— 那是一次无意义的状态更新 */
  it('门店本来就空 → 补丁只含 orgNodeId', () => {
    expect(applyOrgNodeSelection({ storeId: '', orgNodeId: '' }, 'org-s3', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'org-s3' })
    expect(applyOrgNodeSelection({ storeId: '', orgNodeId: '' }, 'm2', ORG_NODES, STORES))
      .toEqual({ orgNodeId: 'm2' })
  })
})

describe('applyStoreSelection — 改门店后的完整补丁', () => {
  /**
   * 这个方向以前只活在页面 onChange 里、从未被测过 —— 而它正是生产两条脏数据
   * （王芳、王小凤：同市场内改门店、没动所属组织）的直接成因。
   */
  it('组织归属于旧门店 → 跟着改成新门店的节点', () => {
    expect(applyStoreSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, 'S002', ORG_NODES, STORES))
      .toEqual({ storeId: 'S002', orgNodeId: 'org-s2' })
  })

  it('组织是旧门店下的部门 → 同样跟着改（判的是门店祖先，不是节点自身）', () => {
    expect(applyStoreSelection({ storeId: 'S001', orgNodeId: 'd1' }, 'S002', ORG_NODES, STORES))
      .toEqual({ storeId: 'S002', orgNodeId: 'org-s2' })
  })

  it('组织挂在市场下（矩阵归属）→ 不动组织', () => {
    expect(applyStoreSelection({ storeId: 'S001', orgNodeId: 'm1-dept' }, 'S002', ORG_NODES, STORES))
      .toEqual({ storeId: 'S002' })
  })

  it('组织已经归属于新门店 → 不重复写', () => {
    expect(applyStoreSelection({ storeId: 'S001', orgNodeId: 'org-s2' }, 'S002', ORG_NODES, STORES))
      .toEqual({ storeId: 'S002' })
  })

  it('清空门店 + 组织归属于某门店 → 组织一起清空（否则提交 {null, 某店节点} 仍不自洽）', () => {
    expect(applyStoreSelection({ storeId: 'S001', orgNodeId: 'org-s1' }, '', ORG_NODES, STORES))
      .toEqual({ storeId: '', orgNodeId: '' })
  })

  it('组织为空 → 只改门店', () => {
    expect(applyStoreSelection({ storeId: '', orgNodeId: '' }, 'S001', ORG_NODES, STORES))
      .toEqual({ storeId: 'S001' })
  })
})
