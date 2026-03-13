import { notFound } from 'next/navigation'
import { getStoreById } from '@/actions/stores'
import StoreEditPage from './_components/store-edit-page'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = await getStoreById(id)
  if (!store) notFound()
  return <StoreEditPage store={store} />
}
