import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getDefaultInventoryBusinessLevel, inventoryBusinessPath } from '@/lib/inventory/business-level'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  redirect(inventoryBusinessPath(getDefaultInventoryBusinessLevel(session)))
}
