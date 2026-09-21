import { describe, it, expect } from 'vitest'
import type { AuthSession } from '../types'
import { canManageSkillTags, SKILL_TAG_WRITE_ACTION } from '../skill-tag-access'

/**
 * 「标签管理」入口显隐（#211）。
 *
 * 这里全部走真实的 hasUiCapability / scopeSessionToActions / isAdminScope，不 mock ——
 * 本函数的全部价值就在于复刻服务端 `withPermission + requireAdmin` 的组合效果，
 * mock 掉任何一环都等于不测。
 */

type Role = AuthSession['roles'][number]

/** 带完整角色元数据的 role，scopeSessionToActions 才会走严格收紧路径（否则原样返回）。 */
function role(
  name: string,
  opts: {
    actions: string[]
    isSuperAdmin?: boolean
    scopeId?: string
    scopeType?: Role['scopeType']
  },
): Role {
  return {
    role: name,
    scopeId: opts.scopeId ?? 'hq-1',
    scopeType: opts.scopeType ?? '总部',
    isSuperAdmin: opts.isSuperAdmin ?? false,
    actions: opts.actions,
    scopeStoreIds: [],
    scopeOrgNodeIds: [opts.scopeId ?? 'hq-1'],
  }
}

function session(roles: Role[]): AuthSession {
  return {
    employeeId: 'EMP-1',
    name: '测试',
    phone: '13800000000',
    roles,
    permissions: {
      // 与生产一致：actions 是各角色的并集
      actions: Array.from(new Set(roles.flatMap((r) => r.actions ?? []))),
      scopeStoreIds: [],
    },
  }
}

// employee:update 的 UI 依赖项（permission-contract 的 dependencies 表）
const UPDATE_DEPS = ['employee:list', 'org:list', 'store:list']
const ADMIN_ACTIONS = [SKILL_TAG_WRITE_ACTION, ...UPDATE_DEPS, 'system:config']

describe('canManageSkillTags — 「标签管理」入口显隐', () => {
  it('admin（超管角色持 employee:update）→ 可见', () => {
    const s = session([role('admin', { actions: ADMIN_ACTIONS, isSuperAdmin: true })])
    expect(canManageSkillTags(s)).toBe(true)
  })

  it('manager（店长，持 employee:update 但非超管）→ 不可见', () => {
    const s = session([
      role('manager', { actions: [SKILL_TAG_WRITE_ACTION, ...UPDATE_DEPS], scopeId: 'store-1', scopeType: '门店' }),
    ])
    expect(canManageSkillTags(s)).toBe(false)
  })

  it('hr（持 employee:update 但非超管）→ 不可见', () => {
    const s = session([
      role('hr', { actions: [SKILL_TAG_WRITE_ACTION, ...UPDATE_DEPS], scopeId: 'mkt-1', scopeType: '市场' }),
    ])
    expect(canManageSkillTags(s)).toBe(false)
  })

  it('finance（只持 employee:list）→ 不可见', () => {
    const s = session([role('finance', { actions: ['employee:list'], scopeId: 'mkt-1', scopeType: '市场' })])
    expect(canManageSkillTags(s)).toBe(false)
  })

  it('session 为 null → 不可见（不抛）', () => {
    expect(canManageSkillTags(null)).toBe(false)
  })

  // 下面两条是本函数存在的全部理由：admin+hr 双角色会话，union actions 恒含
  // employee:update，光看 union 会误判为可见；必须按「授予该动作的角色里有没有超管」判。
  it('admin+hr 且 employee:update 只落在 hr 上 → 不可见（与服务端收紧后被拒一致）', () => {
    const s = session([
      role('admin', { actions: ['system:config'], isSuperAdmin: true }),
      role('hr', { actions: [SKILL_TAG_WRITE_ACTION, ...UPDATE_DEPS], scopeId: 'mkt-1', scopeType: '市场' }),
    ])
    // union 里有 employee:update，但收紧后只剩 hr 角色
    expect(s.permissions.actions).toContain(SKILL_TAG_WRITE_ACTION)
    expect(canManageSkillTags(s)).toBe(false)
  })

  it('admin+hr 且 admin 角色自身也持 employee:update → 可见', () => {
    const s = session([
      role('admin', { actions: ADMIN_ACTIONS, isSuperAdmin: true }),
      role('hr', { actions: [SKILL_TAG_WRITE_ACTION, ...UPDATE_DEPS], scopeId: 'mkt-1', scopeType: '市场' }),
    ])
    expect(canManageSkillTags(s)).toBe(true)
  })

  it('超管角色持 employee:update 但缺 UI 依赖项 → 不可见（避免按钮可见却进不去表单）', () => {
    const s = session([
      role('admin', { actions: [SKILL_TAG_WRITE_ACTION], isSuperAdmin: true }),
    ])
    expect(canManageSkillTags(s)).toBe(false)
  })
})
