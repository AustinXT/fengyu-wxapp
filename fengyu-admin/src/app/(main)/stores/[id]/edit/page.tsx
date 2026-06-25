import { notFound } from 'next/navigation'
import { getStoreById } from '@/actions/stores'
import { getMerchantOptions } from '@/actions/merchants'
import { getSessionFromCookie } from '@/actions/auth'
import { hasPermission } from '@/lib/permissions'
import StoreEditPage from './_components/store-edit-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = await getStoreById(id)
  if (!store) notFound()

  // 门店↔收款商户绑定：仅 admin（store:lakala_config）可编辑，其它角色（含 hr）不显示收款卡
  const session = await getSessionFromCookie()
  const canEditPayment = !!(session && hasPermission(session, 'store:lakala_config'))

  // 收款商户下拉数据（仅 admin 可读，故非授权返回空：编辑页不渲染收款卡）
  const merchantOptions = canEditPayment ? await getMerchantOptions() : []

  return (
    <StoreEditPage
      store={store}
      canEditPayment={canEditPayment}
      merchantOptions={merchantOptions}
    />
  )
}
