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

  
  const session = await getSessionFromCookie()
  const canEditPayment = !!(session && hasPermission(session, 'store:lakala_config'))

  
  const merchantOptions = canEditPayment ? await getMerchantOptions() : []

  return (
    <StoreEditPage
      store={store}
      canEditPayment={canEditPayment}
      merchantOptions={merchantOptions}
    />
  )
}
