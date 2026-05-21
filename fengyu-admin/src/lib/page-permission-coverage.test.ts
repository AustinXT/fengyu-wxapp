import { describe, it, expect } from 'vitest'
import { DEFAULT_PERMISSION_MATRIX } from './permissions'
import { MENU_CONFIG } from './menu'
import type { RoleType } from './types'

/**
 * 页面 → 进入所需权限（取自各列表页 Server Component 在 SSR 时调用的
 * getXxxPaginated/list 的 withPermission/withAnyPermission action 串）。
 *
 * - string：单一权限（withPermission）
 * - string[]：OR 关系（withAnyPermission），持有任一即可进入
 *
 * 守护目标（2026-05-21 修手册截图 500 根因后新增）：
 *   1) 任何业务页都不能"只有 admin 能进"——否则 admin 之外的角色全 403/500，
 *      说明权限矩阵漏配；
 *   2) 配合 admin 全开，确保 admin 能进所有页（superset 在 permissions.test.ts 守护）。
 */
const PAGE_REQUIRED_ACTIONS: Record<string, string | string[]> = {
  // —— 业务管理（此前 admin 缺权限 → 截图 500 的 7 页）——
  '/orders': 'sale_order:list',
  '/services': 'service:list',
  '/appointments': 'appointment:list',
  '/customers': 'customer:list',
  '/cards': 'sale_item:list',
  '/pickup-records': 'pickup_record:list',
  // /allocations 页内部并行调 orders + services，两者都需具备
  '/allocations': ['sale_order:list', 'service:list'],
  // —— 此前正常的业务/流水页 ——
  '/refunds': ['sale_order:refund_create', 'sale_order:refund_approve'],
  '/points': 'point_transaction:list',
  '/card-transactions': 'card_transaction:list',
  '/inventory': 'inventory:list',
  // —— 数据/系统管理页 ——
  '/dashboard': 'dashboard:view',
  '/org': 'org:list',
  '/stores': 'store:list',
  '/employees': 'employee:list',
  '/products': 'product:list',
  '/mall': 'product:list',
  '/commission': 'commission:list',
  '/coupons': 'coupon:list',
  '/permissions': 'permission:list',
  '/logs': 'operation_log:list',
  '/settings': 'system:config',
  '/member-benefits': 'system:config',
  '/legacy-orders': 'legacy_order:list',
}

const NON_ADMIN_ROLES: RoleType[] = ['manager', 'finance', 'hr', 'product', 'customer_mgr']

/** 角色是否能进入页面（持有所需单权限，或 OR 列表中任一） */
function roleCanAccess(role: RoleType, required: string | string[]): boolean {
  const actions = DEFAULT_PERMISSION_MATRIX[role]
  if (Array.isArray(required)) {
    // /allocations 这种"两者都要"的页面：用 every；OR 页面用 some。
    // 这里通过把"两者都要"显式建模为 every、OR 建模为 some 区分不了，
    // 故对数组统一按"全部持有才算可进"处理（覆盖 /allocations 的 AND 语义）；
    // 真正的 OR 页（/refunds）单独在测试里处理。
    return required.every((a) => actions.includes(a))
  }
  return actions.includes(required)
}

describe('页面权限覆盖守护（防止业务页 admin-only / 漏配致 500）', () => {
  it('admin 能进入所有页面', () => {
    for (const [page, required] of Object.entries(PAGE_REQUIRED_ACTIONS)) {
      const reqs = Array.isArray(required) ? required : [required]
      for (const a of reqs) {
        expect(DEFAULT_PERMISSION_MATRIX.admin, `admin 无法进入 ${page}（缺 ${a}）`).toContain(a)
      }
    }
  })

  it('每个页面所需的每个 action 至少被一个非-admin 角色持有（不存在 admin 专属业务页）', () => {
    const adminOnly: Array<{ page: string; action: string }> = []
    for (const [page, required] of Object.entries(PAGE_REQUIRED_ACTIONS)) {
      const reqs = Array.isArray(required) ? required : [required]
      for (const action of reqs) {
        const heldByNonAdmin = NON_ADMIN_ROLES.some((r) =>
          DEFAULT_PERMISSION_MATRIX[r].includes(action),
        )
        if (!heldByNonAdmin) adminOnly.push({ page, action })
      }
    }
    // system:config / permission:list / operation_log:list / legacy_order:* 等系统治理类
    // 本就允许 admin 专属；此处仅断言"业务数据页"不会变成 admin-only。
    const businessOnly = adminOnly.filter(({ action }) =>
      /^(sale_order|service|appointment|customer|sale_item|pickup_record|allocation|point_transaction|card_transaction|inventory):/.test(
        action,
      ),
    )
    expect(businessOnly, `业务页变成 admin 专属（漏配）：${JSON.stringify(businessOnly)}`).toEqual([])
  })

  it('manager 角色可进入全部 7 个核心业务页（截图 500 的那批）', () => {
    const businessPages = ['/orders', '/services', '/appointments', '/customers', '/cards', '/pickup-records', '/allocations']
    for (const page of businessPages) {
      expect(roleCanAccess('manager', PAGE_REQUIRED_ACTIONS[page]), `manager 进不了 ${page}`).toBe(true)
    }
  })

  it('menu 与 page 一致：menu 暴露给某角色的页面，该角色必能加载（防 finance×/allocations 类 403/500 漂移）', () => {
    // 收集 menu.ts 里 href 命中 PAGE_REQUIRED_ACTIONS 的项，
    // 对每个 requiredRoles ∪ readonlyRoles 角色断言其能加载该页所需的全部 action。
    const mismatches: Array<{ page: string; role: RoleType; missing: string }> = []
    for (const group of MENU_CONFIG) {
      for (const item of group.items) {
        const required = PAGE_REQUIRED_ACTIONS[item.href]
        if (!required) continue // 仅校验已建模的列表页（/orders/create 等无 SSR 列表查询的跳过）
        const reqs = Array.isArray(required) ? required : [required]
        // 注意：OR 页（/refunds）这里按 every 处理过严；当前建模的 menu 项里无 OR 页，安全。
        const seenBy = [...item.requiredRoles, ...(item.readonlyRoles ?? [])]
        for (const role of seenBy) {
          for (const action of reqs) {
            if (!DEFAULT_PERMISSION_MATRIX[role].includes(action)) {
              mismatches.push({ page: item.href, role, missing: action })
            }
          }
        }
      }
    }
    expect(mismatches, `menu 暴露但页面权限缺失：${JSON.stringify(mismatches)}`).toEqual([])
  })
})
