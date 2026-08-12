import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {} }))
vi.mock('@db/org', () => ({ orgNodes: {}, stores: {} }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import { ALL_ACTIONS } from './permissions'
import {
  getPermissionActionLabel,
  getPermissionGroupLabel,
  hasPermissionActionLabel,
} from './permission-presentation'

describe('权限矩阵中文展示名称', () => {
  it('为每一个可授予权限提供中文主名称', () => {
    for (const action of ALL_ACTIONS) {
      expect(hasPermissionActionLabel(action), `缺少 ${action} 的中文名称`).toBe(true)
      expect(getPermissionActionLabel(action)).toMatch(/[\u4E00-\u9FFF]/)
      expect(getPermissionGroupLabel(action.split(':')[0])).toMatch(/[\u4E00-\u9FFF]/)
    }
  })

  it('未知权限使用中文兜底名称', () => {
    expect(getPermissionActionLabel('unknown:action')).toBe('未命名权限')
    expect(getPermissionGroupLabel('unknown')).toBe('未分类权限')
  })
})
