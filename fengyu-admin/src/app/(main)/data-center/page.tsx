import { getStoreOptions } from '@/actions/data-center'
import DataCenterPageClient from './_components/data-center-page'

export const dynamic = 'force-dynamic'

export default async function DataCenterPage() {
  const stores = await getStoreOptions()
  return <DataCenterPageClient stores={stores} />
}
