import { Suspense } from 'react'
import { getMessagesPaginated, getMessageTypes } from '@/actions/messages'
import { getMarketStoreFilterOptions } from '@/actions/stores'
import { getSession } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import MessagesPageClient from './_components/messages-page'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams

  const recipientType =
    params.rtype === '客户' || params.rtype === '员工' ? params.rtype : undefined
  const isRead =
    params.read === 'read' || params.read === 'unread' ? params.read : undefined

  // (main) layout 已保证 session 存在，这里仅做类型收窄
  const session = await getSession()
  const canSend = !!session && hasPermission(session, 'message:send')

  const [{ data: messages, total }, messageTypes, filterOptions] = await Promise.all([
    getMessagesPaginated({
      recipientType,
      messageType: params.type,
      isRead,
      search: params.q,
      marketId: params.market,
      storeId: params.store,
      dateFrom: params.from,
      dateTo: params.to,
      page: params.page ? Number(params.page) : undefined,
      pageSize: params.size ? Number(params.size) : undefined,
    }),
    getMessageTypes(),
    getMarketStoreFilterOptions(),
  ])

  return (
    <Suspense>
      <MessagesPageClient
        messages={messages}
        messageTypes={messageTypes}
        total={total}
        canSend={canSend}
        filterOptions={filterOptions}
      />
    </Suspense>
  )
}
