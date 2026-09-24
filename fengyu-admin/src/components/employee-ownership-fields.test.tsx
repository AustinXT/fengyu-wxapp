/**
 * `EmployeeOwnershipFields` 的**运行时交互**测试（#259 双向联动）。
 *
 * 为什么不能只靠纯函数测试 + 源码正则守护：`applyOrgNodeSelection` /
 * `applyStoreSelection` 的口径已由 `lib/org-ancestry-form.test.ts` 钉住，但「补丁有没有真的
 * 合并进受控值」此前只能靠正则认，而 codex 谱系连着两轮给出了绕过 ——
 * `void applyX(...)`、只接一个方向、以及
 * `{ ...prev, ...applyStoreSelection(...), orgNodeId: prev.orgNodeId }`（补丁被随后属性覆盖）。
 * 这里改成真渲染 + 真触发 + 断言**另一个字段的受控值**，上面三种绕过都会当场变红。
 *
 * 宿主（两个页面）只负责把 patch 合进自己的 form —— 那一步由
 * `lib/org-ancestry-form-wiring.test.ts` 的结构守护兜着，其已知上限也写在那里。
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { EmployeeOwnershipFields } from './employee-ownership-fields'
import type { OrgNode, Store } from '@/lib/types'

/**
 * 总部 hq
 * └── 市场 m1
 *     ├── 门店 org-s1 ── 部门 d1
 *     ├── 门店 org-s2
 *     └── 部门 m1-dept   （挂市场下 → 无门店祖先，矩阵式归属）
 */
const ORG_NODES = [
  { id: 'hq', name: '总部', type: '总部', parentId: null, sortOrder: 0, isActive: true },
  { id: 'm1', name: '市场一', type: '市场', parentId: 'hq', sortOrder: 0, isActive: true },
  { id: 'org-s1', name: 'A店', type: '门店', parentId: 'm1', sortOrder: 0, isActive: true },
  { id: 'd1', name: 'A店养生部', type: '部门', parentId: 'org-s1', sortOrder: 0, isActive: true },
  { id: 'org-s2', name: 'B店', type: '门店', parentId: 'm1', sortOrder: 0, isActive: true },
  { id: 'm1-dept', name: '财智部', type: '部门', parentId: 'm1', sortOrder: 0, isActive: true },
] as unknown as OrgNode[]

const STORES = [
  { storeId: 'S001', storeName: 'A店', orgNodeId: 'org-s1' },
  { storeId: 'S002', storeName: 'B店', orgNodeId: 'org-s2' },
] as unknown as Store[]

/** 按宿主页面的真实用法接线：把 patch 合进自己的 state */
function Host({ initial }: { initial: { storeId: string; orgNodeId: string } }) {
  const [form, setForm] = useState(initial)
  return (
    <>
      <EmployeeOwnershipFields
        value={form}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        orgNodes={ORG_NODES}
        stores={STORES}
        storeOptions={STORES}
      />
      <output data-testid="form">{JSON.stringify(form)}</output>
    </>
  )
}

function currentForm(): { storeId: string; orgNodeId: string } {
  return JSON.parse(screen.getByTestId('form').textContent ?? '{}')
}

function selectStore(storeId: string) {
  fireEvent.change(screen.getByLabelText('所属门店'), { target: { value: storeId } })
}

describe('EmployeeOwnershipFields — 改门店 → 组织跟着改', () => {
  /**
   * 这个方向是生产两条脏数据的直接成因：同市场内改门店、没动「所属组织」，
   * 于是 store 指向新店而 org_node 还指着旧店 —— 收紧校验后同一操作会被服务端直接拒。
   */
  it('组织归属于旧门店 → 选新门店后组织变成新门店的节点', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'org-s1' }} />)

    selectStore('S002')

    expect(currentForm()).toEqual({ storeId: 'S002', orgNodeId: 'org-s2' })
  })

  it('组织是旧门店下的部门 → 同样跟着改（判的是门店祖先，不是节点自身）', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'd1' }} />)

    selectStore('S002')

    expect(currentForm()).toEqual({ storeId: 'S002', orgNodeId: 'org-s2' })
  })

  it('组织挂在市场下（矩阵归属）→ 只改门店，组织不动', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'm1-dept' }} />)

    selectStore('S002')

    expect(currentForm()).toEqual({ storeId: 'S002', orgNodeId: 'm1-dept' })
  })

  it('清空门店 + 组织归属于某门店 → 组织一起清空（否则提交 {null, 某店节点} 仍不自洽）', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'org-s1' }} />)

    selectStore('')

    expect(currentForm()).toEqual({ storeId: '', orgNodeId: '' })
  })

  /** 门店下拉的受控值本身也要跟着变 —— 否则用户看到的还是旧门店 */
  it('门店下拉的显示值跟随变化', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'org-s1' }} />)

    selectStore('S002')

    expect((screen.getByLabelText('所属门店') as HTMLSelectElement).value).toBe('S002')
  })
})

/** 展开组织树到叶子，再点某个节点名 */
function selectOrgNode(name: string) {
  // 触发器：未选中时显示 placeholder
  fireEvent.click(screen.getByText(/请选择所属组织|总部\/|市场一/))
  // 逐层展开：每轮把当前所有折叠三角点开，下一层随之出现。
  // 用 testid 而不是 '▸' 字面 —— 换图标时不会碎（GLM 谱系第 9 轮 P3）。
  for (let depth = 0; depth < 3; depth++) {
    const toggles = screen.queryAllByTestId(/^org-tree-toggle-/)
    if (toggles.length === 0) break
    for (const t of toggles) if (t.textContent === '▸') fireEvent.click(t)
  }
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('EmployeeOwnershipFields — 改组织 → 门店跟着改', () => {
  /**
   * GLM 谱系第 4 轮：原先只按**市场**判断，于是同市场内把组织改到另一门店的子树时
   * 市场没变 → storeId 保持旧门店 → 提交上去正好撞服务端归属自洽校验，用户得二次试错。
   */
  it('改到同市场另一门店的节点 → 门店跟着改成那个门店', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'org-s1' }} />)

    selectOrgNode('B店')

    expect(currentForm()).toEqual({ storeId: 'S002', orgNodeId: 'org-s2' })
  })

  it('改到门店下的部门 → 门店取该部门的门店祖先', () => {
    render(<Host initial={{ storeId: 'S002', orgNodeId: 'org-s2' }} />)

    selectOrgNode('A店养生部')

    expect(currentForm()).toEqual({ storeId: 'S001', orgNodeId: 'd1' })
  })

  it('改到市场下的部门（矩阵归属）→ 同市场则保留门店', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'org-s1' }} />)

    selectOrgNode('财智部')

    expect(currentForm()).toEqual({ storeId: 'S001', orgNodeId: 'm1-dept' })
  })

  /** 门店下拉的受控值也要跟着变 —— 否则用户看到的还是旧门店 */
  it('门店下拉的显示值跟随组织变化', () => {
    render(<Host initial={{ storeId: 'S001', orgNodeId: 'org-s1' }} />)

    selectOrgNode('B店')

    expect((screen.getByLabelText('所属门店') as HTMLSelectElement).value).toBe('S002')
  })
})
