import {
  Boxes,
  CalendarCheck,
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardList,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Gauge,
  Gift,
  Grid3x3,
  HandCoins,
  History,
  Landmark,
  LayoutDashboard,
  LineChart,
  ListChecks,
  MessageSquare,
  Network,
  Package,
  PackageCheck,
  PieChart,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Stethoscope,
  Activity,
  ArrowLeftRight,
  Store,
  Ticket,
  TrendingUp,
  Undo2,
  Unlink,
  UserRound,
  Users,
  Wallet,
  Coins,
  Building2,
  Factory,
  type LucideIcon,
} from 'lucide-react'
import type { AuthSession } from './types'
import { INVENTORY_ENTRY_ENABLED } from './inventory-feature-flags'
import { isAdminScope } from './session-role-guards'
import { scopeSessionToAllActions } from './action-scope'
import {
  DATA_CENTER_DASHBOARD_ACTION,
  DATA_CENTER_REPORT_LIST,
  type DataCenterMenuSection,
  type DataCenterReportKey,
} from './data-center/reports'

export interface MenuItem {
  label: string
  icon: LucideIcon
  href: string
  /** 持有其中任一权限即可显示。 */
  requiredActions: string[]
  /** 除 requiredActions 外，还必须同时具备的权限。 */
  requiredAllActions?: string[]
  /**
   * requiredAllActions 必须由**同一条角色授权**同时提供（与页面 / 取数 action 的 `withAllPermissions` 同口径）。
   * 不设时按全部角色的权限并集判定：两个角色各给一半时菜单会显示、点进去却是 403。
   */
  allActionsFromSameRole?: boolean
  /** 指向同一功能的历史深链，沿用该菜单项的高亮和父级展开状态。 */
  matchPaths?: string[]
  /** 仅向持有指定组织范围的账号显示；总部账号可按配置进入下级业务。 */
  allowedScopeTypes?: Array<'总部' | '市场' | '门店'>
  /** 临时关闭导航入口；页面、权限和深链保持可用。 */
  hidden?: boolean
  /**
   * 父级内的分段小标题（目前仅「数据中心」使用）。可见子项跨两个及以上分段时侧边栏才渲染小标题，
   * 同一分段的子项须在 children 里相邻。
   */
  section?: DataCenterMenuSection
}

export interface MenuParent {
  label: string
  icon: LucideIcon
  children: MenuItem[]
  /** 临时关闭整个业务域导航。 */
  hidden?: boolean
}

export type MenuNode = MenuItem | MenuParent

const DATA_CENTER_REPORT_ICONS: Record<DataCenterReportKey, LucideIcon> = {
  dailyOverview: ClipboardList,
  customerFrequency: CalendarDays,
  remainingCards: ListChecks,
  operatingMaster: FileSpreadsheet,
  commissionDaily: HandCoins,
  commissionDetail: HandCoins,
}

/**
 * 经营明细报表入口（#367），来自 `lib/data-center/reports.ts` 登记表：
 * 可见 = 有 dashboard 且同时具备该页全部权限（顾客明细 / 员工提成类要求专用权限点）；
 * `menu.enabled=false` 的页面骨架已就绪但内容未交付，入口隐藏、深链可用。
 */
function dataCenterReportMenuItems(): MenuItem[] {
  return DATA_CENTER_REPORT_LIST.flatMap((report) => report.menu
    ? [{
        label: report.title,
        icon: DATA_CENTER_REPORT_ICONS[report.key],
        href: report.path,
        requiredActions: [DATA_CENTER_DASHBOARD_ACTION],
        requiredAllActions: [...report.requiredActions],
        allActionsFromSameRole: true,
        section: report.menu.section,
        hidden: !report.menu.enabled,
      }]
    : [])
}

/**
 * 侧边栏按业务域组织；URL 仍保持为原有扁平地址。
 *
 * 父级不设独立权限：仅在其任一子页面可访问时才显示，避免权限矩阵变更后出现空分组。
 */
export const MENU_CONFIG: MenuNode[] = [
  { label: '工作台', icon: LayoutDashboard, href: '/dashboard', requiredActions: ['dashboard:view'] },
  {
    label: '经营业务',
    icon: ChartNoAxesCombined,
    children: [
      { label: '开单', icon: ShoppingCart, href: '/orders/create', requiredActions: ['sale_order:create'] },
      { label: '订单管理', icon: FileText, href: '/orders', requiredActions: ['sale_order:list'] },
      { label: '历史订单核对', icon: History, href: '/legacy-orders', requiredActions: ['legacy_order:list'] },
      { label: '营业额分配', icon: PieChart, href: '/allocations', requiredActions: ['allocation:list'] },
      { label: '退款管理', icon: Undo2, href: '/refunds', requiredActions: ['sale_order:refund_create', 'sale_order:refund_approve'] },
      { label: '服务单管理', icon: Stethoscope, href: '/services', requiredActions: ['service:list'] },
      { label: '预约管理', icon: CalendarCheck, href: '/appointments', requiredActions: ['appointment:list'] },
      { label: '提货记录', icon: PackageCheck, href: '/pickup-records', requiredActions: ['pickup_record:list'], hidden: !INVENTORY_ENTRY_ENABLED },
      { label: '门店解绑', icon: Unlink, href: '/store-unbind', requiredActions: ['store_unbind:list'] },
    ],
  },
  {
    label: '客户运营',
    icon: UserRound,
    children: [
      { label: '顾客管理', icon: UserRound, href: '/customers', requiredActions: ['customer:list'] },
      { label: '疗程卡管理', icon: CreditCard, href: '/cards', requiredActions: ['sale_item:list'] },
      { label: '优惠券管理', icon: Ticket, href: '/coupons', requiredActions: ['coupon:list'] },
      { label: '会员权益', icon: Gift, href: '/member-benefits', requiredActions: ['system:config'] },
      { label: '积分流水', icon: Coins, href: '/points', requiredActions: ['point_transaction:list'] },
      { label: '充值卡流水', icon: Wallet, href: '/card-transactions', requiredActions: ['card_transaction:list'] },
    ],
  },
  {
    label: '商品商城',
    icon: ShoppingBag,
    children: [
      { label: '商品管理', icon: Package, href: '/products', requiredActions: ['product:create'] },
      { label: '商城管理', icon: ShoppingBag, href: '/mall', requiredActions: ['product:create'] },
    ],
  },
  {
    label: '库存管理',
    icon: Boxes,
    hidden: !INVENTORY_ENTRY_ENABLED,
    children: [
      { label: '库存查询', icon: PackageCheck, href: '/inventory/stocks', requiredActions: ['inventory:stock_list'] },
      { label: '进出明细', icon: ArrowLeftRight, href: '/inventory/movements', requiredActions: ['inventory:stock_list'] },
      {
        label: '供应链业务',
        icon: Factory,
        href: '/inventory/operations/supply-chain',
        requiredActions: ['inventory:supply_chain_operate', 'inventory:supply_chain_approve'],
        allowedScopeTypes: ['总部'],
      },
      {
        label: '市场业务',
        icon: Building2,
        href: '/inventory/operations/market',
        requiredActions: ['inventory:market_operate', 'inventory:market_approve'],
        allowedScopeTypes: ['市场'],
      },
      {
        label: '门店业务',
        icon: Store,
        href: '/inventory/operations/store',
        requiredActions: ['inventory:store_operate'],
        allowedScopeTypes: ['门店'],
      },
      {
        label: '单据中心',
        icon: FileText,
        href: '/inventory/docs',
        requiredActions: ['inventory:list', 'inventory:stock_list'],
        requiredAllActions: ['inventory:list', 'inventory:stock_list'],
      },
      {
        label: '货款结算',
        icon: Landmark,
        href: '/inventory/settlements',
        // 只读报表全部是金额字段：门店价格档（无任一价格查看权限）不暴露入口。
        requiredActions: ['inventory:supply_chain_price_view', 'inventory:market_price_view'],
        requiredAllActions: ['inventory:list'],
      },
      {
        label: '资料配置',
        icon: Package,
        href: '/inventory/skus',
        requiredActions: ['inventory:stock_list'],
        matchPaths: ['/inventory/suppliers', '/inventory/sku-mappings', '/inventory/promotions'],
      },
    ],
  },
  {
    label: '组织管理',
    icon: Network,
    children: [
      { label: '组织架构', icon: Network, href: '/org', requiredActions: ['org:create'] },
      { label: '门店管理', icon: Store, href: '/stores', requiredActions: ['store:create'] },
      { label: '商户管理', icon: Landmark, href: '/merchants', requiredActions: ['merchant:list'] },
      { label: '员工管理', icon: Users, href: '/employees', requiredActions: ['employee:create'] },
      { label: '提成矩阵', icon: Grid3x3, href: '/commission', requiredActions: ['commission:list'] },
    ],
  },
  {
    // 4 个板块各占一条独立路径：itemMatchesPath 只比 pathname，挂 `?tab=` 会让子项同时高亮。
    // 经营明细报表（#367）同样一页一条路径，按「看板 / 经营明细 / 员工收入」分段；下钻子页不进菜单，
    // 靠 itemMatchesPath 的前缀匹配高亮父页（提成明细 → 员工提成日报）。
    label: '数据中心',
    icon: LineChart,
    children: [
      { label: '销售', icon: TrendingUp, href: '/data-center/sales', requiredActions: ['data_center:dashboard'], section: '看板' },
      { label: '客量', icon: Users, href: '/data-center/customer', requiredActions: ['data_center:dashboard'], section: '看板' },
      { label: '人效', icon: Gauge, href: '/data-center/efficiency', requiredActions: ['data_center:dashboard'], section: '看板' },
      { label: '品项', icon: PieChart, href: '/data-center/product', requiredActions: ['data_center:dashboard'], section: '看板' },
      ...dataCenterReportMenuItems(),
    ],
  },
  {
    label: '系统管理',
    icon: Settings,
    children: [
      { label: '权限管理', icon: Shield, href: '/permissions', requiredActions: ['permission:list'] },
      { label: '权限矩阵', icon: SlidersHorizontal, href: '/settings/permission-matrix', requiredActions: ['system:config'] },
      { label: '消息中心', icon: MessageSquare, href: '/messages', requiredActions: ['message:list'] },
      { label: '操作日志', icon: ScrollText, href: '/logs', requiredActions: ['operation_log:list'] },
      { label: '系统配置', icon: Settings, href: '/settings', requiredActions: ['system:config'] },
      {
        label: '系统自检',
        icon: Activity,
        href: '/settings/diagnostics',
        matchPaths: ['/settings/lakala-diagnostics'],
        requiredActions: ['system:diagnostics'],
      },
    ],
  },
]

export function isMenuParent(node: MenuNode): node is MenuParent {
  return 'children' in node
}

export function hasMenuItemAccess(
  item: MenuItem,
  actions: readonly string[],
  scopeTypes?: readonly ('总部' | '市场' | '门店')[],
): boolean {
  return item.hidden !== true
    && item.requiredActions.some((action) => actions.includes(action))
    && (item.requiredAllActions?.every((action) => actions.includes(action)) ?? true)
    && (!item.allowedScopeTypes || !scopeTypes || item.allowedScopeTypes.some((scope) => scopeTypes.includes(scope)))
}

export function flattenMenuItems(nodes: readonly MenuNode[] = MENU_CONFIG): MenuItem[] {
  return nodes.flatMap((node) => isMenuParent(node) ? node.children : [node])
}

export function itemMatchesPath(item: MenuItem, pathname: string): boolean {
  return [item.href, ...(item.matchPaths ?? [])].some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export function getMenuItemForPath(nodes: readonly MenuNode[], pathname: string): MenuItem | null {
  const matching = flattenMenuItems(nodes)
    .filter((item) => itemMatchesPath(item, pathname))
    .sort((a, b) => {
      const aLength = Math.max(a.href.length, ...(a.matchPaths ?? []).map((path) => path.length))
      const bLength = Math.max(b.href.length, ...(b.matchPaths ?? []).map((path) => path.length))
      return bLength - aLength
    })
  return matching[0] ?? null
}

export function getMenuParentForPath(nodes: readonly MenuNode[], pathname: string): MenuParent | null {
  return nodes.find((node): node is MenuParent => isMenuParent(node) && node.children.some((item) => itemMatchesPath(item, pathname))) ?? null
}

export function getVisibleMenuItems(session: AuthSession): MenuNode[] {
  const actions = session.permissions.actions
  const scopeTypes = isAdminScope(session)
    ? (['总部', '市场', '门店'] as const)
    : session.roles.map((role) => role.scopeType)
  // 同角色判定复用 withAllPermissions 的收窄函数，菜单与页面闸门不会各算各的
  const visibleItem = (item: MenuItem) => hasMenuItemAccess(item, actions, scopeTypes)
    && (!item.allActionsFromSameRole || !item.requiredAllActions
      || scopeSessionToAllActions(session, item.requiredAllActions).roles.length > 0)
  return MENU_CONFIG.reduce<MenuNode[]>((visible, node) => {
    if (!isMenuParent(node)) {
      if (visibleItem(node)) visible.push(node)
      return visible
    }
    if (node.hidden) return visible
    const children = node.children.filter(visibleItem)
    if (children.length > 0) visible.push({ ...node, children })
    return visible
  }, [])
}

/** @deprecated 使用 getVisibleMenuItems；保留别名，便于渐进迁移调用方。 */
export const getVisibleMenuGroups = getVisibleMenuItems
