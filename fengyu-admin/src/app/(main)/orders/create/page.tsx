import { getStores } from '@/actions/stores'
import { getEmployees } from '@/actions/employees'
import { getRechargeCardSkus, type RechargeCardSku } from '@/actions/cards'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'

/**
 * 开单页 Server Component
 *
 * PR-C：商品/分类数据全部由 client 在 Step 1 选定 productKindChoice 后通过
 * getProductsByKind() 按需懒拉，server 端不再预加载 categories/products/skus。
 *
 * 2026-05-19 ticket：充值卡真实档位 SKU 在 SSR 期一次性 fetch（小集合，
 * is_recharge_card=true 的 SKU 个位数），失败降级空数组 fallback 到硬编码档位。
 */
export default async function Page() {
  const [stores, employees, rechargeSkusResult] = await Promise.all([
    getStores(),
    getEmployees(),
    getRechargeCardSkus().catch((err) => {
      console.warn('[orders/create] getRechargeCardSkus failed, fallback to []', err)
      return [] as RechargeCardSku[]
    }),
  ])

  return (
    <OrderCreatePageClient
      stores={stores}
      employees={employees}
      rechargeCardSkus={rechargeSkusResult}
    />
  )
}
