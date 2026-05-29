import { notFound } from 'next/navigation'
import { getStoreById } from '@/actions/stores'
import { listLakalaMerchants } from '@/actions/lakala-onboarding'
import { getSessionFromCookie } from '@/actions/auth'
import { hasPermission } from '@/lib/permissions'
import StoreEditPage from './_components/store-edit-page'

export const dynamic = 'force-dynamic'

/** 「关联商户」下拉行：lakala_merchants WHERE onboarding_status IN ('approved','completed','realname_pending') */
export interface LakalaMerchantOption {
  id: string
  merchantName: string
  merchantNo: string | null
  onboardingStatus: string
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = await getStoreById(id)
  if (!store) notFound()

  // 「关联商户」下拉数据 + 权限：仅 admin 可改，hr/其它角色只读
  const session = await getSessionFromCookie()
  const canEditMerchant = !!(session && hasPermission(session, 'lakala:onboarding:update'))

  let merchantOptions: LakalaMerchantOption[] = []
  if (canEditMerchant) {
    try {
      const rows = await listLakalaMerchants()
      merchantOptions = rows
        .filter((r) =>
          r.onboardingStatus === 'approved' ||
          r.onboardingStatus === 'completed' ||
          r.onboardingStatus === 'realname_pending',
        )
        .map((r) => ({
          id: r.id,
          merchantName: r.merchantName,
          merchantNo: r.merchantNo,
          onboardingStatus: r.onboardingStatus,
        }))
    } catch {
      merchantOptions = []
    }
  }

  return (
    <StoreEditPage
      store={store}
      merchantOptions={merchantOptions}
      canEditMerchant={canEditMerchant}
    />
  )
}
