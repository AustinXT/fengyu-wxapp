import {
  LayoutDashboard,
  ShoppingCart,
  FileText,
  PieChart,
  Stethoscope,
  CalendarCheck,
  Network,
  Store,
  Landmark,
  Users,
  Package,
  PackageCheck,
  ShoppingBag,
  Grid3x3,
  UserRound,
  CreditCard,
  Ticket,
  Shield,
  Coins,
  Wallet,
  Gift,
  MessageSquare,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Unlink,
  History,
  Boxes,
  LineChart,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { AuthSession } from "./types";

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  href: string;
  /**
   * 显示该菜单项所需的权限点（OR：持任一即显示）。
   *
   * 权限点驱动（2026-06-24，取代原 requiredRoles/readonlyRoles 角色驱动）：
   * 菜单可见性 = 用户实际权限矩阵的直接体现，永久跟随 DB 矩阵（system_configs），不再硬编码角色。
   * 门槛 action 选「能代表该页管理能力」的权限：
   *   - 管理类页避开 org:list / store:list / employee:list 这类「引用读」（被多角色作筛选器持有），
   *     改用 :create（如组织架构用 org:create、门店管理用 store:create）；
   *   - 已逐项保证「持该 action 的角色必满足该页全部无条件 SSR 闸门」，故不会出现「可见却 403」，
   *     由 page-permission-coverage.test.ts 守护。
   * 只读由页面内 hasPermission(写 action) 自然决定，菜单层不再区分 readonly。
   */
  requiredActions: string[];
}

export interface MenuGroup {
  label: string | null;
  items: MenuItem[];
}

export const MENU_CONFIG: MenuGroup[] = [
  {
    label: null,
    items: [
      { label: "工作台", icon: LayoutDashboard, href: "/dashboard", requiredActions: ["dashboard:view"] },
    ],
  },
  {
    label: "业务管理",
    items: [
      { label: "开单", icon: ShoppingCart, href: "/orders/create", requiredActions: ["sale_order:create"] },
      { label: "订单管理", icon: FileText, href: "/orders", requiredActions: ["sale_order:list"] },
      { label: "历史订单核对", icon: History, href: "/legacy-orders", requiredActions: ["legacy_order:list"] },
      { label: "营业额分配", icon: PieChart, href: "/allocations", requiredActions: ["allocation:list"] },
      // 退款管理：listRefunds 为 withAnyPermission([refund_create, refund_approve])，门槛同口径取 OR
      { label: "退款管理", icon: Undo2, href: "/refunds", requiredActions: ["sale_order:refund_create", "sale_order:refund_approve"] },
      { label: "服务单管理", icon: Stethoscope, href: "/services", requiredActions: ["service:list"] },
      { label: "预约管理", icon: CalendarCheck, href: "/appointments", requiredActions: ["appointment:list"] },
      { label: "提货记录", icon: PackageCheck, href: "/pickup-records", requiredActions: ["pickup_record:list"] },
      { label: "门店解绑", icon: Unlink, href: "/store-unbind", requiredActions: ["store_unbind:list"] },
      { label: "进销存", icon: Boxes, href: "/inventory", requiredActions: ["inventory:list"] },
    ],
  },
  {
    label: "数据管理",
    items: [
      { label: "数据中心", icon: LineChart, href: "/data-center", requiredActions: ["data_center:dashboard"] },
      // 管理类：避开引用读 org:list / store:list / employee:list，用 :create 代表管理能力
      { label: "组织架构", icon: Network, href: "/org", requiredActions: ["org:create"] },
      { label: "门店管理", icon: Store, href: "/stores", requiredActions: ["store:create"] },
      // 商户管理：门槛 merchant:list，故 manager 等只读角色也可见列表（写权由页面内按钮控制）
      { label: "商户管理", icon: Landmark, href: "/merchants", requiredActions: ["merchant:list"] },
      { label: "员工管理", icon: Users, href: "/employees", requiredActions: ["employee:create"] },
      { label: "商品管理", icon: Package, href: "/products", requiredActions: ["product:create"] },
      { label: "商城管理", icon: ShoppingBag, href: "/mall", requiredActions: ["product:create"] },
      { label: "提成矩阵", icon: Grid3x3, href: "/commission", requiredActions: ["commission:list"] },
      { label: "顾客管理", icon: UserRound, href: "/customers", requiredActions: ["customer:list"] },
      { label: "疗程卡管理", icon: CreditCard, href: "/cards", requiredActions: ["sale_item:list"] },
      { label: "优惠券管理", icon: Ticket, href: "/coupons", requiredActions: ["coupon:create"] },
      { label: "会员权益", icon: Gift, href: "/member-benefits", requiredActions: ["system:config"] },
      { label: "积分流水", icon: Coins, href: "/points", requiredActions: ["point_transaction:list"] },
      { label: "充值卡流水", icon: Wallet, href: "/card-transactions", requiredActions: ["card_transaction:list"] },
    ],
  },
  {
    label: "系统管理",
    items: [
      { label: "权限管理", icon: Shield, href: "/permissions", requiredActions: ["permission:list"] },
      { label: "权限矩阵", icon: SlidersHorizontal, href: "/settings/permission-matrix", requiredActions: ["system:config"] },
      { label: "消息中心", icon: MessageSquare, href: "/messages", requiredActions: ["message:list"] },
      { label: "操作日志", icon: ScrollText, href: "/logs", requiredActions: ["operation_log:list"] },
      { label: "系统配置", icon: Settings, href: "/settings", requiredActions: ["system:config"] },
    ],
  },
];

/**
 * 按当前会话的权限点过滤出可见菜单。
 *
 * 菜单项 requiredActions 与 session.permissions.actions 取交集（OR：持任一即显示）；
 * 空分组自动剔除。actions 已在 getSessionFromCookie 内由 computeActions 摊平（吃 DB 矩阵）。
 */
export function getVisibleMenuGroups(session: AuthSession): MenuGroup[] {
  const actions = session.permissions.actions;
  return MENU_CONFIG.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      item.requiredActions.some((a) => actions.includes(a))
    ),
  })).filter((group) => group.items.length > 0);
}
