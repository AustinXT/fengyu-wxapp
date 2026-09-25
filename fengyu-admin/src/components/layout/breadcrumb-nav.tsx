"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { getMenuParentForPath, MENU_CONFIG } from '@/lib/menu'
import { resolveReturnTo } from '@/lib/return-context'
import { DATA_CENTER_REPORT_LIST, DATA_CENTER_REPORTS, type DataCenterReportKey } from '@/lib/data-center/reports'

const ROUTE_LABELS: Record<string, string> = {
  "/dashboard": "工作台",
  "/orders": "订单管理",
  "/orders/create": "开单",
  "/allocations": "营业额分配",
  "/refunds": "退款管理",
  "/services": "服务单管理",
  "/appointments": "预约管理",
  "/legacy-orders": "历史订单核对",
  "/pickup-records": "提货记录",
  "/store-unbind": "门店解绑",
  "/inventory": "库存管理",
  "/inventory/stocks": "库存查询",
  "/inventory/movements": "进出明细",
  "/inventory/operations": "库存业务",
  "/inventory/operations/supply-chain": "供应链业务",
  "/inventory/operations/market": "市场业务",
  "/inventory/operations/store": "门店业务",
  "/inventory/docs": "单据中心",
  "/inventory/settlements": "货款结算",
  "/inventory/skus": "资料配置",
  "/inventory/suppliers": "资料配置",
  "/inventory/sku-mappings": "资料配置",
  "/inventory/promotions": "报货福利",
  "/org": "组织架构",
  "/stores": "门店管理",
  "/employees": "员工管理",
  "/products": "商品管理",
  "/products/categories": "分类管理",
  "/commission": "提成矩阵",
  "/customers": "顾客管理",
  "/coupons": "优惠券管理",
  "/cards": "疗程卡管理",
  "/member-benefits": "会员权益",
  "/points": "积分流水",
  "/card-transactions": "充值卡流水",
  "/mall": "商城管理",
  "/merchants": "商户管理",
  // 裸路径只做 redirect，正常不会渲染面包屑；但 /data-center/<非法段> 的 404 页靠这一条
  // 渲染出可点的「数据中心」逃生链接（点它经裸路径跳回销售板块）。勿当死代码删。
  "/data-center": "数据中心",
  "/data-center/sales": "销售",
  "/data-center/customer": "客量",
  "/data-center/efficiency": "人效",
  "/data-center/product": "品项",
  // 经营明细报表（#367）：标题来自登记表，与页面 h1、菜单同源
  ...Object.fromEntries(DATA_CENTER_REPORT_LIST.map((report) => [report.path, report.title])),
  "/permissions": "权限管理",
  "/messages": "消息中心",
  "/logs": "操作日志",
  "/settings": "系统配置",
  "/settings/diagnostics": "系统自检",
  "/settings/lakala-diagnostics": "系统自检",
}

/**
 * 下钻子页 → 父页（直达匹配时在当前页前补一级可点的父页）。
 * 如「数据中心 / 员工提成日报 / 提成明细」：父页链接走 returnTo，回到下钻前的筛选状态。
 */
const ROUTE_PARENTS: Record<string, string> = Object.fromEntries(
  DATA_CENTER_REPORT_LIST.flatMap((report) => report.parent
    ? [[report.path, DATA_CENTER_REPORTS[report.parent as DataCenterReportKey].path]]
    : []),
)

interface BreadcrumbItem {
  label: string
  href?: string
}

function buildBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = []
  const parent = getMenuParentForPath(MENU_CONFIG, pathname)
  if (parent) items.push({ label: parent.label })

  // Direct match first
  if (ROUTE_LABELS[pathname]) {
    const parentPath = ROUTE_PARENTS[pathname]
    if (parentPath) items.push({ label: ROUTE_LABELS[parentPath], href: parentPath })
    items.push({ label: ROUTE_LABELS[pathname], href: pathname })
    return items
  }

  // Build from path segments
  const segments = pathname.split("/").filter(Boolean)
  let currentPath = ""

  for (const segment of segments) {
    currentPath += `/${segment}`
    const label = ROUTE_LABELS[currentPath]

    if (label) {
      items.push({ label, href: currentPath })
    } else if (items.length > 0) {
      // Dynamic segment like [id] — show as "详情"
      items.push({ label: "详情", href: currentPath })
    }
  }

  return items
}

export function BreadcrumbNav() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const breadcrumbs = buildBreadcrumbs(pathname)
  const contextIndex = breadcrumbs.reduce(
    (last, item, index) => item.href && ROUTE_LABELS[item.href] && index < breadcrumbs.length - 1 ? index : last,
    -1,
  )

  if (breadcrumbs.length === 0) return null

  return (
    <nav aria-label="面包屑导航" className="mb-4 flex items-center gap-1 text-sm">
      {breadcrumbs.map((item, i) => {
        const isLast = i === breadcrumbs.length - 1

        return (
            <span key={item.href ?? item.label} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-[#999999]" />}
            {isLast ? (
              <span className="font-medium text-[var(--foreground)]">{item.label}</span>
            ) : item.href ? (
              <Link
                href={i === contextIndex ? resolveReturnTo(searchParams.get('returnTo'), item.href) : item.href}
                className="text-[#999999] transition-colors hover:text-[var(--foreground)]"
              >
                {item.label}
              </Link>
            ) : (
              <span className="text-[#999999]">{item.label}</span>
            )}
          </span>
        )
      })}
    </nav>
  )
}
