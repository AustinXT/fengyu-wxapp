import { describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@/lib/types'

/**
 * expandMarketVisibility（#399）：visible = 直接授权市场 ∪ 门店级角色的祖先市场；granted 只含前者。
 * 数据中心据 granted 判定无门店市场能否作为默认范围——祖先市场混进 granted 会让
 * 「唯一门店被停用的店长」被默认带到整个市场。
 */
const NODES = [
  { id: 'HQ', parentId: null, type: '总部' },
  { id: 'M-NC', parentId: 'HQ', type: '市场' },
  { id: 'S-NC1', parentId: 'M-NC', type: '门店' },
  { id: 'M-PX', parentId: 'HQ', type: '市场' }, // 品项公司：无门店市场
]

vi.mock('@/db', () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = () => Promise.resolve(NODES)
  return { db: chain }
})

import { expandMarketVisibility, expandVisibleMarketIds } from '@/lib/permissions'

type Role = AuthSession['roles'][number]
function session(roles: Array<Pick<Role, 'role' | 'scopeId' | 'scopeType'>>, scopeOrgNodeIds?: string[]): AuthSession {
  return {
    employeeId: 'E', name: 'n', phone: 'p',
    roles: roles as Role[],
    permissions: { actions: [], scopeStoreIds: [], scopeOrgNodeIds },
  } as AuthSession
}

describe('expandMarketVisibility', () => {
  it('总部角色：null（全开）', async () => {
    expect(await expandMarketVisibility(session([{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }]))).toBeNull()
  })

  it('hr@品项公司：直接授权该市场（granted 与 visible 都含）', async () => {
    const r = await expandMarketVisibility(session([{ role: 'hr', scopeId: 'M-PX', scopeType: '市场' }], ['M-PX']))
    expect(r).toEqual({ visible: ['M-PX'], granted: ['M-PX'] })
  })

  it('门店店长：所属市场只是祖先市场——visible 含、granted 不含', async () => {
    const r = await expandMarketVisibility(session([{ role: 'manager', scopeId: 'S-NC1', scopeType: '门店' }], ['S-NC1']))
    expect(r).toEqual({ visible: ['M-NC'], granted: [] })
  })

  it('门店店长 + hr@品项公司：granted 只含品项公司', async () => {
    const r = await expandMarketVisibility(session(
      [{ role: 'manager', scopeId: 'S-NC1', scopeType: '门店' }, { role: 'hr', scopeId: 'M-PX', scopeType: '市场' }],
      ['S-NC1', 'M-PX'],
    ))
    expect(r?.granted).toEqual(['M-PX'])
    expect(r?.visible.sort()).toEqual(['M-NC', 'M-PX'])
  })

  it('scopeOrgNodeIds 缺失（旧会话）时按角色根节点展开，结果一致', async () => {
    const r = await expandMarketVisibility(session([{ role: 'hr', scopeId: 'M-PX', scopeType: '市场' }]))
    expect(r).toEqual({ visible: ['M-PX'], granted: ['M-PX'] })
  })

  it('expandVisibleMarketIds 行为不变 = visible', async () => {
    expect(await expandVisibleMarketIds(session([{ role: 'manager', scopeId: 'S-NC1', scopeType: '门店' }], ['S-NC1']))).toEqual(['M-NC'])
  })
})
