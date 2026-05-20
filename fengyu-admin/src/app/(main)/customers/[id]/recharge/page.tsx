import { notFound, redirect } from 'next/navigation'
import { getCustomerById } from '@/actions/customers'
import { getRechargeConfig } from '@/actions/cards'
import { getStores } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import RechargeForm from './recharge-form'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const session = await getSession()
  if (!session) redirect('/login')
  if (!hasPermission(session, 'sale_order:create')) {
    redirect(`/customers/${id}?error=no_recharge_permission`)
  }

  const [customer, config, stores] = await Promise.all([
    getCustomerById(id),
    getRechargeConfig(),
    getStores(),
  ])

  if (!customer) notFound()

  return (
    <RechargeForm
      customer={customer}
      config={config}
      stores={stores}
    />
  )
}
