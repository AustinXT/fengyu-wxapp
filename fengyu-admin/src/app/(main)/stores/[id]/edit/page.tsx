import { notFound } from 'next/navigation'
import { getStoreById, getStoreLakalaMerchantName } from '@/actions/stores'
import { getSessionFromCookie } from '@/actions/auth'
import { hasPermission } from '@/lib/permissions'
import StoreEditPage from './_components/store-edit-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = await getStoreById(id)
  if (!store) notFound()

  // 拉卡拉收款配置：仅 admin（store:lakala_config）可编辑，其它角色（含 hr）只读
  const session = await getSessionFromCookie()
  const canEditPayment = !!(session && hasPermission(session, 'store:lakala_config'))

  // 回显已填商户名（落在 lakala_merchants.merchant_name，便于区分各店商户）
  const lakalaMerchantName = store.lakalaMerchantId ? await getStoreLakalaMerchantName(id) : null

  return (
    <StoreEditPage
      store={store}
      canEditPayment={canEditPayment}
      lakalaMerchantName={lakalaMerchantName}
    />
  )
}
