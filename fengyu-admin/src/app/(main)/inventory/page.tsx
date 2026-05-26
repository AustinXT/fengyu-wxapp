import Link from 'next/link'
import { Boxes, PackagePlus, ShoppingBag, Repeat, AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

const MODULES = [
  {
    href: '/inventory/procurement',
    title: '采购入库',
    desc: '院报货 / 院入库 / 退货出库',
    icon: PackagePlus,
    color: 'text-emerald-700 bg-emerald-50',
  },
  {
    href: '/inventory/sale',
    title: '销售出库',
    desc: '销售出库 / 顾客退货',
    icon: ShoppingBag,
    color: 'text-blue-700 bg-blue-50',
  },
  {
    href: '/inventory/transfer',
    title: '门店调拨',
    desc: '调拨出库 / 调拨入库',
    icon: Repeat,
    color: 'text-purple-700 bg-purple-50',
  },
  {
    href: '/inventory/scrap',
    title: '报损出库',
    desc: '产品损耗 / 异常处理',
    icon: AlertTriangle,
    color: 'text-amber-700 bg-amber-50',
  },
] as const

export default function InventoryHubPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Boxes className="size-6 text-[var(--primary)]" />
        <h1 className="text-xl font-medium">门店库存管理</h1>
      </div>
      <p className="text-sm text-[#666666]">
        4 类库存单据：按业务方向归类。所有数据存于 PostgreSQL，WorkFine 桌面端已弃用。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
