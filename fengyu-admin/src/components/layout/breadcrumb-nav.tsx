"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { getMenuParentForPath, MENU_CONFIG } from '@/lib/menu'

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
  "/inventory": "进销存",
  "/inventory/stocks": "库存查询",
  "/inventory/operations": "库存业务",
  "/inventory/docs": "单据中心",
  "/inventory/procurement": "采购入库",
  "/inventory/sale": "销售出库",
  "/inventory/transfer": "门店调拨",
  "/inventory/scrap": "报损出库",
  "/inventory/skus": "资料配置",
  "/inventory/suppliers": "资料配置",
  "/inventory/sku-mappings": "资料配置",
  "/inventory/promotions": "促销方案",
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
  "/data-center": "数据中心",
  "/permissions": "权限管理",
  "/messages": "消息中心",
  "/logs": "操作日志",
  "/settings": "系统配置",
}

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
  const breadcrumbs = buildBreadcrumbs(pathname)

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
                href={item.href}
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
