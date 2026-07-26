import { describe, it, expect } from 'vitest'
import { DEFAULT_PERMISSION_MATRIX } from './permissions'
import { MENU_CONFIG } from './menu'
import type { RoleType } from './types'

/**
 * 页面 → 进入页面所需的【全部无条件 SSR 权限闸门】。
 *
 * 守护目标（2026-05-21 手册截图 500 根因 + 深度审计后加深）：
 *   menu 暴露 / 列表页按钮可达的每个页面，其可见角色必须持有页面 SSR 期间
 *   **无条件且未被吞错**触发的全部 withPermission/withAnyPermission 闸门——
 *   否则该角色点进去会 PERMISSION_DENIED（生产脱敏后误显 500、修复后 403）。
 *
 * 与初版（每页只记一个"主 action"）的区别：
 *   1) 穷举每页 SSR 并行调用的全部 Server Action 闸门（含筛选器下拉的 getStores/getOrgNodes 等）；
 *   2) 纳入按钮/行点击可达的子页（/orders/[id]、/allocations/[orderId]、/customers/[id]、create 页…）；
 *   3) 区分 AND / OR 语义（见 Clause）。
 *
 * 【不计入】的两类（不会让页面打不开，故不建模）：
 *   - 条件加载：`hasPermission(session, X) ? loadX() : Promise.resolve([])`
 *     （如 /orders/[id] 的 allocations/logs/payments、/customers/[id] 的 stores/employees）；
 *   - 吞错加载：`getRates().catch(() => [])`（如 /allocations/[orderId|serviceOrderId] 的提成比例）。
 *
 * 闸门来源已逐个 grep 核实（action 文件的 withPermission 第一参）：
 *   getStores→store:list, getOrgNodes→org:list, getEmployees(Paginated)/getSkillTags→employee:list,
 *   getMarkets 三份各异（commission.ts→commission:list / products.ts→product:list / coupons.ts→coupon:list），
 *   getCustomerById/Orders/Appointments→customer:list（刻意非 sale_order/appointment，让 customer_mgr 可看），
 *   getOrderById/listRefunds→withAny(sale_order:list|refund_create|refund_approve)。
 */

/** 单条闸门：string = AND 必持；string[] = OR 组（withAnyPermission，持任一即可）。 */
type Clause = string | string[]

/** menu 列表页 → 全部无条件 SSR 闸门。 */
const LIST_PAGE_GATES: Record<string, Clause[]> = {
  '/dashboard': ['dashboard:view'],
  // —— 业务管理 ——
  '/orders': ['sale_order:list', 'store:list'],
  '/orders/create': ['sale_order:create', 'employee:list', 'store:list'], // 自身即 menu 项（requiredRoles: manager）
  '/services': ['service:list', 'store:list'],
  '/appointments': ['appointment:list', 'store:list'],
  '/allocations': ['sale_order:list', 'service:list', 'store:list'],
  // 退款管理：listRefunds 为 withAnyPermission([refund_create, refund_approve]) 单一 OR 闸门
  '/refunds': [['sale_order:refund_create', 'sale_order:refund_approve']],
  '/pickup-records': ['pickup_record:list', 'store:list'],
  '/store-unbind': ['store_unbind:list'],
  '/inventory': [], // hub 页：仅 Link 跳转，无 SSR 数据查询
  '/legacy-orders': ['legacy_order:list', 'store:list'],
  // —— 数据管理 ——
  '/data-center': ['data_center:dashboard'], // SSR 仅 getDataCenterScopeOptions 闸门；板块数据客户端取数
  '/org': ['org:list'],
  '/stores': ['store:list'],
  '/merchants': ['merchant:list'], // 商户管理（admin + finance）；getMerchantsPaginated
  '/employees': ['employee:list', 'org:list'], // getEmployeesPaginated/getOrgNodes/getSkillTags
  '/products': ['product:list'],
  '/mall': ['product:list'],
  '/commission': ['commission:list', 'employee:list'], // getRates/getMarkets(commission:list)+getSkillTags(employee:list)
  '/customers': ['customer:list', 'store:list', 'org:list'],
  '/cards': ['sale_item:list', 'store:list', 'org:list'],
  '/coupons': ['coupon:list'], // getTemplates/getMarkets 均 coupon:list
  '/member-benefits': ['system:config'],
  '/points': ['point_transaction:list', 'store:list', 'org:list'],
  '/card-transactions': ['card_transaction:list', 'store:list', 'org:list'],
  // —— 系统管理 ——
  '/permissions': ['permission:list', 'employee:list', 'org:list'],
  '/settings/permission-matrix': ['system:config'],
  '/messages': ['message:list'],
  '/logs': ['operation_log:list'],
  '/settings': ['system:config'],
}

/**
 * 按钮/行点击可达的子页（非 menu 项）。
 * - parent：触达入口所在的 menu 列表页 href（用其可见角色推导谁能点到这里）。
 * - entryGate：若入口是受权限保护的按钮（如"新建"），只有持该 action 的角色才点得到子页；
 *   留空表示行点击/Link 直达（凡能看到 parent 列表的角色都可触达）。
 * - clauses：子页自身的全部无条件 SSR 闸门。
 */
const SUBPAGES: Array<{ href: string; parent: string; entryGate?: string; clauses: Clause[] }> = [
  // 订单
  { href: '/orders/create-deposit', parent: '/orders', entryGate: 'sale_order:create', clauses: ['store:list'] },
  { href: '/orders/[id]', parent: '/orders', clauses: [['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve']] },
  // 服务单
  { href: '/services/create', parent: '/services', entryGate: 'service:create', clauses: ['employee:list', 'store:list'] },
  { href: '/services/[id]', parent: '/services', clauses: ['service:list'] },
  // 退款详情（行点击直达；getRefundById 同 listRefunds 的 OR 闸门）
  { href: '/refunds/[id]', parent: '/refunds', clauses: [['sale_order:refund_create', 'sale_order:refund_approve']] },
  // 营业额分配（getRates 已 .catch 吞错，不计入）
  { href: '/allocations/[orderId]', parent: '/allocations', clauses: [['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'], 'allocation:list', 'employee:list', 'store:list'] },
  { href: '/allocations/service/[serviceOrderId]', parent: '/allocations', clauses: ['service:list', 'allocation:list', 'employee:list', 'store:list'] },
  // 顾客（订单/预约历史刻意 gated by customer:list）
  { href: '/customers/[id]', parent: '/customers', clauses: ['customer:list'] },
  // 提货
  { href: '/pickup-records/create', parent: '/pickup-records', entryGate: 'pickup_record:create', clauses: ['store:list'] },
  // 商品 / 商城
  { href: '/products/[id]', parent: '/products', clauses: ['product:list'] },
  { href: '/products/create', parent: '/products', entryGate: 'product:create', clauses: ['product:list'] },
  { href: '/products/categories', parent: '/products', clauses: ['product:list'] },
  { href: '/mall/[id]', parent: '/mall', clauses: ['product:list'] },
  { href: '/mall/create', parent: '/mall', entryGate: 'product:create', clauses: ['product:list'] },
  { href: '/mall/categories', parent: '/mall', clauses: ['product:list'] },
  // 优惠券
  { href: '/coupons/[id]', parent: '/coupons', clauses: ['coupon:list'] },
  { href: '/coupons/create', parent: '/coupons', entryGate: 'coupon:create', clauses: ['coupon:list'] },
  // 员工 / 门店
  { href: '/employees/[id]', parent: '/employees', clauses: ['employee:list', 'org:list', 'store:list'] },
  { href: '/employees/create', parent: '/employees', entryGate: 'employee:create', clauses: ['employee:list', 'org:list', 'store:list'] },
  { href: '/stores/[id]/edit', parent: '/stores', clauses: ['store:list'] },
  { href: '/stores/create', parent: '/stores', entryGate: 'store:create', clauses: ['org:list'] },
  // 商户管理：menu /merchants 门槛改 merchant:list 后，manager 等只读角色也可见列表/详情；
  // 新建/编辑入口按 merchant:create / merchant:update 隐藏（只读角色触达不了）；
  // create 页 SSR 取市场下拉(merchant:list) + merchant:create 闸门。
  { href: '/merchants/[id]', parent: '/merchants', clauses: ['merchant:list'] },
  { href: '/merchants/[id]/edit', parent: '/merchants', entryGate: 'merchant:update', clauses: ['merchant:list'] },
  { href: '/merchants/create', parent: '/merchants', entryGate: 'merchant:create', clauses: ['merchant:create', 'merchant:list'] },
  // 库存四单据（从 /inventory hub 的 Link 直达）+ 单据详情
  { href: '/inventory/stocks', parent: '/inventory', clauses: ['inventory:stock_list'] },
  { href: '/inventory/procurement', parent: '/inventory', clauses: ['inventory:list', 'store:list'] },
  { href: '/inventory/sale', parent: '/inventory', clauses: ['inventory:list', 'store:list'] },
  { href: '/inventory/transfer', parent: '/inventory', clauses: ['inventory:list', 'store:list'] },
  { href: '/inventory/scrap', parent: '/inventory', clauses: ['inventory:list', 'store:list'] },
  { href: '/inventory/procurement/[id]', parent: '/inventory', clauses: ['inventory:list'] },
  { href: '/inventory/sale/[id]', parent: '/inventory', clauses: ['inventory:list'] },
  { href: '/inventory/transfer/[id]', parent: '/inventory', clauses: ['inventory:list'] },
  { href: '/inventory/scrap/[id]', parent: '/inventory', clauses: ['inventory:list'] },
]

const ALL_ROLES: RoleType[] = ['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr']
const NON_ADMIN_ROLES: RoleType[] = ['manager', 'finance', 'hr', 'product', 'customer_mgr']

const holds = (role: RoleType, action: string) => DEFAULT_PERMISSION_MATRIX[role].includes(action)

/** 角色是否满足全部闸门（AND 单项必持、OR 组持任一）。 */
function satisfies(role: RoleType, clauses: Clause[]): boolean {
  return clauses.every((c) => (Array.isArray(c) ? c.some((a) => holds(role, a)) : holds(role, c)))
}

/** 列出未满足的闸门（用于报错信息）。 */
function missingClauses(role: RoleType, clauses: Clause[]): Clause[] {
  return clauses.filter((c) => (Array.isArray(c) ? !c.some((a) => holds(role, a)) : !holds(role, c)))
}

/** menu 中某 href 的可见角色（持有该项 requiredActions 任一的角色；门槛 action 反推）。 */
function seenBy(href: string): RoleType[] {
  for (const group of MENU_CONFIG) {
    for (const item of group.items) {
      if (item.href === href) {
        return ALL_ROLES.filter((role) => item.requiredActions.some((a) => holds(role, a)))
      }
    }
  }
  return []
}

describe('页面权限覆盖守护（全 SSR 闸门 + 子页 + 防 403/500 漂移）', () => {
  it('admin 能进入所有页面（含子页）', () => {
    const all = [...Object.values(LIST_PAGE_GATES), ...SUBPAGES.map((s) => s.clauses)]
    const failed: Clause[] = []
    for (const clauses of all) failed.push(...missingClauses('admin', clauses))
    expect(failed, `admin 无法进入某页（缺：${JSON.stringify(failed)}）`).toEqual([])
  })

  it('menu 列表页：每个可见角色都满足该页全部无条件 SSR 闸门', () => {
    const mismatches: Array<{ page: string; role: RoleType; missing: Clause[] }> = []
    for (const [href, clauses] of Object.entries(LIST_PAGE_GATES)) {
      for (const role of seenBy(href)) {
        const miss = missingClauses(role, clauses)
        if (miss.length) mismatches.push({ page: href, role, missing: miss })
      }
    }
    expect(mismatches, `menu 暴露但页面权限缺失：${JSON.stringify(mismatches)}`).toEqual([])
  })

  it('子页：每个可触达角色都满足该子页全部无条件 SSR 闸门', () => {
    const mismatches: Array<{ page: string; role: RoleType; missing: Clause[] }> = []
    for (const sub of SUBPAGES) {
      // 可触达角色 = 能看到 parent 列表的角色；若入口是受权限保护的按钮，再交集持该 action 的角色。
      const reachable = seenBy(sub.parent).filter((r) => !sub.entryGate || holds(r, sub.entryGate))
      for (const role of reachable) {
        const miss = missingClauses(role, sub.clauses)
        if (miss.length) mismatches.push({ page: sub.href, role, missing: miss })
      }
    }
    expect(mismatches, `子页可触达但权限缺失：${JSON.stringify(mismatches)}`).toEqual([])
  })

  it('每个业务数据页的每个闸门至少被一个非-admin 角色持有（不存在 admin 专属业务页）', () => {
    const businessRe =
      /^(sale_order|service|appointment|customer|sale_item|pickup_record|allocation|point_transaction|card_transaction|inventory):/
    const adminOnly: Array<{ page: string; action: string }> = []
    for (const [href, clauses] of Object.entries(LIST_PAGE_GATES)) {
      for (const clause of clauses) {
        const opts = Array.isArray(clause) ? clause : [clause]
        const businessOpts = opts.filter((a) => businessRe.test(a))
        if (businessOpts.length === 0) continue // 非业务域闸门（system:config/permission 等）允许 admin 专属
        // OR 组只要任一业务项被非-admin 持有即不算 admin-only
        const heldByNonAdmin = businessOpts.some((a) => NON_ADMIN_ROLES.some((r) => holds(r, a)))
        if (!heldByNonAdmin) adminOnly.push({ page: href, action: businessOpts.join('|') })
      }
    }
    expect(adminOnly, `业务页变成 admin 专属（漏配）：${JSON.stringify(adminOnly)}`).toEqual([])
  })

  it('manager 可进入全部 7 个核心业务页（截图 500 的那批）', () => {
    const businessPages = ['/orders', '/services', '/appointments', '/customers', '/cards', '/pickup-records', '/allocations']
    for (const page of businessPages) {
      // /cards 的 sale_item:list 等：用 satisfies 校验全闸门
      expect(satisfies('manager', LIST_PAGE_GATES[page]), `manager 进不了 ${page}`).toBe(true)
    }
  })

  it('所有 menu href 都已建模 SSR 闸门（防止新增页漏进守护）', () => {
    const modeled = new Set(Object.keys(LIST_PAGE_GATES))
    const unmodeled: string[] = []
    for (const group of MENU_CONFIG) {
      for (const item of group.items) {
        if (!modeled.has(item.href)) unmodeled.push(item.href)
      }
    }
    expect(unmodeled, `menu 新增页未登记 SSR 闸门（请补 LIST_PAGE_GATES）：${JSON.stringify(unmodeled)}`).toEqual([])
  })
})
