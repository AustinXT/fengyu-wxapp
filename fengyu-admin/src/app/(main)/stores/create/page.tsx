import { getAvailableStoreNodes } from '@/actions/stores'
import { getMerchantOptions } from '@/actions/merchants'
import { getSessionFromCookie } from '@/actions/auth'
import { hasPermission } from '@/lib/permissions'
import StoreCreatePage from './_components/store-create-page'

export const dynamic = 'force-dynamic'

export default async function Page() {
  
  const storeNodes = await getAvailableStoreNodes()
  
  const session = await getSessionFromCookie()
  const canEditPayment = !!(session && hasPermission(session, 'store:lakala_config'))
  const merchantOptions = canEditPayment ? await getMerchantOptions() : []
  return (
    <StoreCreatePage
      storeNodes={storeNodes}
      canEditPayment={canEditPayment}
      merchantOptions={merchantOptions}
    />
  )
}
