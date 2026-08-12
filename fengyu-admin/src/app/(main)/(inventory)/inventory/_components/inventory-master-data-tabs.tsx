'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/inventory/skus', label: '库存商品' },
  { href: '/inventory/suppliers', label: '供应商' },
  { href: '/inventory/sku-mappings', label: 'SKU 映射' },
] as const

/**
 * 库存资料配置的三个旧地址共用这一页签导航。
 *
 * 每项仍由独立 RSC 路由取数，以保留既有深链、权限闸门和 URL 筛选参数；
 * 因此这里使用 Link 而非把三张数据表一次性加载到客户端。
 */
export function InventoryMasterDataTabs() {
  const pathname = usePathname()

  return (
    <div role="tablist" aria-label="资料配置" className="mb-4 flex border-b border-[var(--border)]">
      {TABS.map((tab) => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2',
              active
                ? 'border-[var(--primary)] text-[var(--primary)]'
                : 'border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
