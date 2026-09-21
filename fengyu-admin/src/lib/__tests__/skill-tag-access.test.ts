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

// 员工表单页的 UI 依赖项（permission-contract 的 dependencies 表）。本函数刻意不检查它们，
// 但 fixture 仍带上，好让「持 employee:update 的角色」贴近生产实配。
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

  it('超管角色持 employee:update 但缺员工表单页的 UI 依赖项 → 仍可见（与服务端一致）', () => {
    // 服务端 requirePermission 只查动作本身，不查 UI 依赖闭包；若这里改用 hasUiCapability
    // 就会比服务端更严，出现「API 调得通却看不到入口」。页面能不能进是 requireUiPageCapability
    // 的职责，不该混进写权限判定。本例钉住这个边界。
    const s = session([
      role('admin', { actions: [SKILL_TAG_WRITE_ACTION], isSuperAdmin: true }),
    ])
    expect(canManageSkillTags(s)).toBe(true)
  })

  it('角色缺 scope 元数据数组 → scopeSessionToActions 原样返回，按原始 roles 判定', () => {
    // 旧导出快照 / 历史会话没有角色级元数据时，scopeSessionToActions 会整份原样返回
    // （action-scope.ts 的 hasRoleScopeMetadata 早退）。此时 admin+hr 会话里 admin 角色
    // 不会被裁掉 → 可见。服务端走的是同一个函数，两侧结论仍然一致。
    const s: AuthSession = {
      employeeId: 'LEGACY-1',
      name: '历史会话',
      phone: '13800000000',
      roles: [
        { role: 'admin', scopeId: 'hq-1', scopeType: '总部', isSuperAdmin: true },
        { role: 'hr', scopeId: 'mkt-1', scopeType: '市场', isSuperAdmin: false },
      ],
      permissions: { actions: [SKILL_TAG_WRITE_ACTION], scopeStoreIds: [] },
    }
    expect(canManageSkillTags(s)).toBe(true)
  })
})
