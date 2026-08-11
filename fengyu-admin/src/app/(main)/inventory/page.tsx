import Link from 'next/link'
import { BadgePercent, Boxes, ClipboardList, Link2, Package, PackageCheck, Truck, Workflow } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

const MODULES = [
  {
    href: '/inventory/skus',
    title: '库存商品资料',
    desc: '独立库存 SKU / 多价体系 / 自采资料',
    icon: Package,
    color: 'text-red-700 bg-red-50',
  },
  {
    href: '/inventory/sku-mappings',
    title: '销售 SKU 映射',
    desc: '提货商品与实际库存 SKU 的对应关系',
    icon: Link2,
    color: 'text-orange-700 bg-orange-50',
  },
  {
    href: '/inventory/stocks',
    title: '实时库存',
    desc: '总部 / 市场 / 门店库存余额与批次',
    icon: PackageCheck,
    color: 'text-emerald-700 bg-emerald-50',
  },
  {
    href: '/inventory/docs',
    title: '库存单据',
    desc: '报货 / 采购 / 发货 / 入库 / 配货 / 调货',
    icon: ClipboardList,
    color: 'text-blue-700 bg-blue-50',
  },
  {
    href: '/inventory/operations',
    title: '业务流程',
    desc: '报货、采购、发货、收货、配货、自采与转换',
    icon: Workflow,
    color: 'text-violet-700 bg-violet-50',
  },
  {
    href: '/inventory/suppliers',
    title: '供应商',
    desc: '供应链与市场自采供应商档案',
    icon: Truck,
    color: 'text-amber-700 bg-amber-50',
  },
  {
    href: '/inventory/promotions',
    title: '报货福利方案',
    desc: '时间、产品与数量阶梯优惠',
    icon: BadgePercent,
    color: 'text-teal-700 bg-teal-50',
  },
]

export default function InventoryHubPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Boxes className="size-6 text-[var(--primary)]" />
        <h1 className="text-xl font-medium">进销存管理</h1>
      </div>
      <p className="text-sm text-[#666666]">
        二期库存以总部、市场、门店三层库存表为中心，库存流转单据作为余额变化的审计依据。
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {MODULES.map((m) => {
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
