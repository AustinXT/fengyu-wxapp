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
      
      { label: "退款管理", icon: Undo2, href: "/refunds", requiredActions: ["sale_order:refund_create", "sale_order:refund_approve"] },
      { label: "服务单管理", icon: Stethoscope, href: "/services", requiredActions: ["service:list"] },
      { label: "预约管理", icon: CalendarCheck, href: "/appointments", requiredActions: ["appointment:list"] },
      { label: "提货记录", icon: PackageCheck, href: "/pickup-records", requiredActions: ["pickup_record:list"] },
      { label: "门店解绑", icon: Unlink, href: "/store-unbind", requiredActions: ["store_unbind:list"] },
      { label: "门店库存", icon: Boxes, href: "/inventory", requiredActions: ["inventory:list"] },
    ],
  },
  {
    label: "数据管理",
    items: [
      { label: "数据中心", icon: LineChart, href: "/data-center", requiredActions: ["data_center:dashboard"] },
      
      { label: "组织架构", icon: Network, href: "/org", requiredActions: ["org:create"] },
      { label: "门店管理", icon: Store, href: "/stores", requiredActions: ["store:create"] },
      
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


export function getVisibleMenuGroups(session: AuthSession): MenuGroup[] {
  const actions = session.permissions.actions;
  return MENU_CONFIG.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      item.requiredActions.some((a) => actions.includes(a))
    ),
  })).filter((group) => group.items.length > 0);
}
