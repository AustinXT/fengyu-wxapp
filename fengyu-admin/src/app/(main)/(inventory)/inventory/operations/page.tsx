import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { requireAllUiPageCapabilities } from '@/lib/page-capability'
import { getDefaultInventoryBusinessLevel, inventoryBusinessPath } from '@/lib/inventory/business-level'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const session = await getSession()
  requireAllUiPageCapabilities(session, ['inventory:list', 'inventory:stock_list'])
  redirect(inventoryBusinessPath(getDefaultInventoryBusinessLevel(session)))
}
