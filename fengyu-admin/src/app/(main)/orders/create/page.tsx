import { getStores } from '@/actions/stores'
import { getEmployees, getEmployeesOnBusinessTrip } from '@/actions/employees'
import { getRechargeConfig } from '@/actions/cards'
import { mergeEmployeesById } from '@/lib/merge-employees'
import OrderCreatePageClient from '../_components/order-create-page'

export const dynamic = 'force-dynamic'

/**
 * 开单页 Server Component
 *
 * 商品/分类数据全部由 client 在 Step 1 选定 productKindChoice 后通过
 * getProductsByKind() 按需懒拉，server 端不再预加载 categories/products/skus。
 *
 * 2026-05-21 充值入口收敛到开单页：「充值卡」Tab 走 RechargePicker 档位选择 →
 * createRechargeOrder。档位配置由 getRechargeConfig 预拉；未配置（loadRechargeConfig
 * 抛错）时兜成 null，前端提示前往 系统配置 → 充值卡配置。
 */
export default async function Page() {
  const [stores, scopedEmployees, tripEmployees, rechargeConfig] = await Promise.all([
    getStores(),
    getEmployees(),
    getEmployeesOnBusinessTrip(),
    getRechargeConfig().catch(() => null),
  ])
  // 跨门店共享（2026-06-24）：scope 内员工 ∪ 全公司出差员工；前端开单选美容师按「门店 ∪ 出差」筛选
  const employees = mergeEmployeesById(scopedEmployees, tripEmployees)
  return <OrderCreatePageClient stores={stores} employees={employees} rechargeConfig={rechargeConfig} />
}
