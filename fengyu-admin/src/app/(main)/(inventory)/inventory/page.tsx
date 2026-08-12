import Link from 'next/link'
import {
  AlertTriangle,
  Boxes,
  FileText,
  Package,
  PackageCheck,
  PackagePlus,
  Repeat,
  ShoppingBag,
  Tags,
  Truck,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getSession } from '@/lib/auth'
import { hasAllUiCapabilities } from '@/lib/permission-contract'

export const dynamic = 'force-dynamic'

const MODULES = [
  {
    href: '/inventory/stocks',
    actions: ['inventory:stock_list'],
    title: '门店库存表',
    desc: '实时余额 / 批号 / 库存流水基准',
    icon: PackageCheck,
    color: 'text-red-700 bg-red-50',
  },
  {
    href: '/inventory/procurement',
    actions: ['inventory:list'],
    title: '采购入库',
    desc: '院报货 / 院入库 / 退货出库',
    icon: PackagePlus,
    color: 'text-emerald-700 bg-emerald-50',
  },
  {
    href: '/inventory/sale',
    actions: ['inventory:list'],
    title: '销售出库',
    desc: '销售出库 / 顾客退货',
    icon: ShoppingBag,
    color: 'text-blue-700 bg-blue-50',
  },
  {
    href: '/inventory/transfer',
    actions: ['inventory:list'],
    title: '门店调拨',
    desc: '调拨出库 / 调拨入库',
    icon: Repeat,
    color: 'text-purple-700 bg-purple-50',
  },
  {
    href: '/inventory/scrap',
    actions: ['inventory:list'],
    title: '报损出库',
    desc: '产品损耗 / 异常处理',
    icon: AlertTriangle,
    color: 'text-amber-700 bg-amber-50',
  },
  {
    href: '/inventory/skus',
    actions: ['inventory:stock_list'],
    title: '库存产品资料',
    desc: 'SKU、来源和归属市场资料',
    icon: Package,
    color: 'text-indigo-700 bg-indigo-50',
  },
  {
    href: '/inventory/suppliers',
    actions: ['inventory:stock_list'],
    title: '库存供应商',
    desc: '供应商档案与启停管理',
    icon: Tags,
    color: 'text-cyan-700 bg-cyan-50',
  },
  {
    href: '/inventory/sku-mappings',
    actions: ['inventory:stock_list'],
    title: 'SKU 映射',
    desc: '库存 SKU 与业务商品映射',
    icon: Repeat,
    color: 'text-violet-700 bg-violet-50',
  },
  {
    href: '/inventory/promotions',
    actions: ['inventory:stock_list'],
    title: '库存促销方案',
    desc: '市场促销与福利价格方案',
    icon: Tags,
    color: 'text-pink-700 bg-pink-50',
  },
  {
    href: '/inventory/docs',
    actions: ['inventory:list', 'inventory:stock_list'],
    title: '库存单据中心',
    desc: '通用库存单据、审批与收货',
    icon: FileText,
    color: 'text-slate-700 bg-slate-100',
  },
  {
    href: '/inventory/operations',
    actions: ['inventory:list', 'inventory:stock_list'],
    title: '库存业务流程',
    desc: '报货、采购、发货、收货及特殊业务',
    icon: Truck,
    color: 'text-orange-700 bg-orange-50',
  },
] as const

export default async function InventoryHubPage() {
  const actions = (await getSession())?.permissions.actions ?? []
  const modules = MODULES.filter((module) => hasAllUiCapabilities(actions, module.actions))
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Boxes className="size-6 text-[var(--primary)]" />
        <h1 className="text-xl font-medium">门店库存管理</h1>
      </div>
      <p className="text-sm text-[#666666]">
        新库存业务以门店库存表为中心，报货、入库、退货、调拨、提货、报损都围绕库存余额和流水展开。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {modules.map((m) => {
          const Icon = m.icon
          return (
            <Link key={m.href} href={m.href}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-5 flex items-start gap-4">
                  <div className={`flex size-12 items-center justify-center rounded-lg ${m.color}`}>
                    <Icon className="size-6" />
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">{m.title}</div>
                    <div className="text-xs text-[#999999] mt-1">{m.desc}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
