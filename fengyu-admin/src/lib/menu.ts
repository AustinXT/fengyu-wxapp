import {
  LayoutDashboard,
  ShoppingCart,
  FileText,
  PieChart,
  Stethoscope,
  CalendarCheck,
  Network,
  Store,
  Users,
  Package,
  ShoppingBag,
  Grid3x3,
  UserRound,
  Ticket,
  BarChart3,
  Shield,

  ScrollText,
  Settings,
  Unlink,
  type LucideIcon,
} from 'lucide-react'
import type { AuthSession, RoleType } from './types'

export interface MenuItem {
  label: string
  icon: LucideIcon
  href: string
  requiredRoles: RoleType[]
  readonlyRoles?: RoleType[]
}

export interface MenuGroup {
  label: string | null
  items: MenuItem[]
}

export const MENU_CONFIG: MenuGroup[] = [
  {
    label: null,
    items: [
      { label: '工作台', icon: LayoutDashboard, href: '/dashboard', requiredRoles: ['admin', 'manager', 'finance', 'hr', 'product', 'customer_mgr'] },
    ],
  },
  {
    label: '业务管理',
    items: [
      { label: '开单', icon: ShoppingCart, href: '/orders/create', requiredRoles: ['manager'] },
      { label: '订单管理', icon: FileText, href: '/orders', requiredRoles: ['manager'], readonlyRoles: ['finance'] },
      { label: '营业额分配', icon: PieChart, href: '/allocations', requiredRoles: ['manager'], readonlyRoles: ['finance'] },
      { label: '服务单管理', icon: Stethoscope, href: '/services', requiredRoles: ['manager'] },
      { label: '预约管理', icon: CalendarCheck, href: '/appointments', requiredRoles: ['manager'] },
      { label: '门店解绑', icon: Unlink, href: '/store-unbind', requiredRoles: ['manager'] },
    ],
  },
  {
    label: '数据管理',
    items: [
      { label: '组织架构', icon: Network, href: '/org', requiredRoles: ['admin', 'hr'] },
      { label: '门店管理', icon: Store, href: '/stores', requiredRoles: ['admin', 'hr'] },
      { label: '员工管理', icon: Users, href: '/employees', requiredRoles: ['admin', 'hr'] },
      { label: '商品管理', icon: Package, href: '/products', requiredRoles: ['admin', 'product'] },
      { label: '商城管理', icon: ShoppingBag, href: '/mall', requiredRoles: ['admin', 'product'] },
      { label: '提成矩阵', icon: Grid3x3, href: '/commission', requiredRoles: ['admin'] },
      { label: '顾客管理', icon: UserRound, href: '/customers', requiredRoles: ['manager', 'customer_mgr'], readonlyRoles: ['finance'] },
      { label: '优惠券管理', icon: Ticket, href: '/coupons', requiredRoles: ['admin', 'product'] },
    ],
  },
  {
    label: '数据中心',
    items: [
      { label: '经营数据', icon: BarChart3, href: '/data-center', requiredRoles: ['manager'], readonlyRoles: ['finance'] },
    ],
  },
  {
    label: '系统管理',
    items: [
      { label: '权限管理', icon: Shield, href: '/permissions', requiredRoles: ['admin', 'hr'] },

      { label: '操作日志', icon: ScrollText, href: '/logs', requiredRoles: ['admin'] },
      { label: '系统配置', icon: Settings, href: '/settings', requiredRoles: ['admin'] },
    ],
  },
]

export function getVisibleMenuGroups(session: AuthSession): MenuGroup[] {
  const userRoles = session.roles.map(r => r.role)
  return MENU_CONFIG.map(group => ({
    ...group,
    items: group.items.filter(item => {
      const allAllowedRoles = [...item.requiredRoles, ...(item.readonlyRoles || [])]
      return allAllowedRoles.some(role => userRoles.includes(role))
    }),
  })).filter(group => group.items.length > 0)
}
