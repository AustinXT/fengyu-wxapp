'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type { AdminMessage } from '@/actions/messages'
import {
  batchSendMessages,
  deleteMessage,
  getCustomersForBatchMessage,
  getOrgNodesForBatchMessage,
} from '@/actions/messages'
import type { BatchMessageCustomer, OrgNode } from '@/lib/types'
import { formatPhoneSafe } from '@/lib/format'
import { formatDateTime as fmtDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Pagination } from '@/components/ui/pagination'
import { OrgTreeSelect } from '@/components/ui/org-tree-select'
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const RECIPIENT_TYPE_OPTIONS: Array<'客户' | '员工'> = ['客户', '员工']

const MEMBER_LEVEL_OPTIONS = ['黑钻', '金钻', '粉钻', '星钻', '初钻'] as const

/** 批量发送对话框：单次最多发送的人数上限（需与 Server Action 保持一致） */
const BATCH_SEND_MAX = 1000

function formatDateTime(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDateTime(dt)
}

interface Props {
  messages: AdminMessage[]
  messageTypes: string[]
  total: number
  canSend: boolean
}

/**
 * 消息中心管理页 — 服务端分页
 *
 * messages 表无 store 维度，仅 admin 可访问（菜单+权限矩阵双重控制）。
 */
export default function MessagesPage({ messages, messageTypes, total, canSend }: Props) {
  const router = useRouter()
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback(
    (key: string, value: string) => {
      setMany({ [key]: value, page: '' })
    },
    [setMany],
  )

  const rtypeFilter = get('rtype')
  const typeFilter = get('type')
  const readFilter = get('read')
  const dateFrom = get('from')
  const dateTo = get('to')
  const currentPage = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size')))
    ? Number(get('size'))
    : 20

  // 搜索防抖
  const [searchInput, setSearchInput] = useState(get('q'))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (debounceRef[0]) clearTimeout(debounceRef[0])
      debounceRef[0] = setTimeout(() => setFilter('q', value), 300)
    },
    [setFilter, debounceRef],
  )

  // Detail dialog
  const [detail, setDetail] = useState<AdminMessage | null>(null)

  // Delete dialog
  const [pendingDelete, setPendingDelete] = useState<AdminMessage | null>(null)
  const [deleting, setDeleting] = useState(false)
  const handleDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = await deleteMessage(pendingDelete.id)
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      setPendingDelete(null)
      router.refresh()
    } catch {
      toast.error('删除失败，请稍后重试')
    } finally {
      setDeleting(false)
    }
  }

  // ----- 批量发送消息 Dialog state -----
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchTitle, setBatchTitle] = useState('')
  const [batchBody, setBatchBody] = useState('')
  const [batchType, setBatchType] = useState('')
  const [batchMode, setBatchMode] = useState<'filter' | 'select'>('select')
  const [batchOrgFilter, setBatchOrgFilter] = useState('')
  const [batchLevelFilter, setBatchLevelFilter] = useState('')
  const [batchSearch, setBatchSearch] = useState('')
  const [batchPage, setBatchPage] = useState(1)
  const [batchOrgNodes, setBatchOrgNodes] = useState<OrgNode[]>([])
  const [batchOrgLoaded, setBatchOrgLoaded] = useState(false)
  const [batchCustomers, setBatchCustomers] = useState<BatchMessageCustomer[]>([])
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
  const [batchSending, setBatchSending] = useState(false)

  // 加载组织节点（首次打开时）
  useEffect(() => {
    if (batchOpen && !batchOrgLoaded) {
      getOrgNodesForBatchMessage()
        .then((nodes) => {
          setBatchOrgNodes(nodes)
          setBatchOrgLoaded(true)
        })
        .catch(() => toast.error('加载组织列表失败'))
    }
  }, [batchOpen, batchOrgLoaded])

  const loadBatchCustomers = useCallback(
    async (p = 1) => {
      try {
        const result = await getCustomersForBatchMessage({
          orgNodeId: batchOrgFilter || undefined,
          memberLevel: batchLevelFilter || undefined,
          search: batchSearch || undefined,
          page: p,
          pageSize: 10,
        })
        setBatchCustomers(result.data)
        setBatchTotal(result.total)
      } catch {
        toast.error('加载顾客列表失败')
      }
    },
    [batchOrgFilter, batchLevelFilter, batchSearch],
  )

  // 打开对话框或筛选条件变更时重新加载顾客
  useEffect(() => {
    if (batchOpen) {
      setBatchPage(1)
      loadBatchCustomers(1)
    }
  }, [batchOpen, batchOrgFilter, batchLevelFilter, batchSearch, loadBatchCustomers])

  const toggleBatchSelect = (userId: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const toggleSelectAllPage = () => {
    const pageIds = batchCustomers.map((c) => c.userId)
    const allSelected = pageIds.length > 0 && pageIds.every((id) => batchSelected.has(id))
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }

  const handleBatchPageChange = (p: number) => {
    setBatchPage(p)
    loadBatchCustomers(p)
  }

  const resetBatchState = () => {
    setBatchOpen(false)
    setBatchTitle('')
    setBatchBody('')
    setBatchType('')
    setBatchMode('select')
    setBatchOrgFilter('')
    setBatchLevelFilter('')
    setBatchSearch('')
    setBatchPage(1)
    setBatchCustomers([])
    setBatchTotal(0)
    setBatchSelected(new Set())
    setBatchSending(false)
  }

  const handleBatchSend = async () => {
    if (!batchTitle.trim()) {
      toast.error('请输入消息标题')
      return
    }
    if (batchMode === 'select' && batchSelected.size === 0) {
      toast.error('请勾选接收人或切换到"按筛选发送"模式')
      return
    }
    if (batchMode === 'filter' && batchTotal === 0) {
      toast.error('当前筛选结果为空')
      return
    }
    if (batchMode === 'filter' && batchTotal > BATCH_SEND_MAX) {
      toast.error(`筛选结果 ${batchTotal} 人，超过单次上限 ${BATCH_SEND_MAX}，请缩小范围`)
      return
    }

    setBatchSending(true)
    try {
      const result = await batchSendMessages({
        title: batchTitle.trim(),
        body: batchBody.trim() || undefined,
        messageType: batchType.trim() || undefined,
        userIds: batchMode === 'select' ? [...batchSelected] : undefined,
        filters:
          batchMode === 'filter'
            ? {
                orgNodeId: batchOrgFilter || undefined,
                memberLevel: batchLevelFilter || undefined,
                search: batchSearch || undefined,
              }
            : undefined,
      })
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      resetBatchState()
      router.refresh()
    } catch {
      toast.error('发送失败，请稍后重试')
    } finally {
      setBatchSending(false)
    }
  }

  const columns: Column<AdminMessage>[] = [
    {
      key: 'createdAt',
      header: '时间',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span className="text-[#999999] text-xs">{formatDateTime(row.createdAt)}</span>
      ),
    },
    {
      key: 'recipientType',
      header: '接收人',
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <Badge
              variant="outline"
              className={
                row.recipientType === '客户'
                  ? 'border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]'
                  : 'border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]'
              }
            >
              {row.recipientType}
            </Badge>
            <span className="font-medium">{row.recipientName ?? '—'}</span>
          </div>
          <span className="font-mono text-xs text-[#999999]">{row.recipientId}</span>
        </div>
      ),
    },
    {
      key: 'title',
      header: '标题',
      cell: (row) => (
        <span className="font-medium line-clamp-1">{row.title}</span>
      ),
    },
    {
      key: 'messageType',
      header: '分类',
      cell: (row) =>
        row.messageType ? (
          <span className="text-xs text-[#666666]">{row.messageType}</span>
        ) : (
          '—'
        ),
    },
    {
      key: 'isRead',
      header: '状态',
      cell: (row) =>
        row.isRead ? (
          <Badge
            variant="outline"
            className="border-[#888888] text-[#888888] bg-[#F5F5F5]"
          >
            已读
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]"
          >
            未读
          </Badge>
        ),
    },
    {
      key: 'refEntityType',
      header: '关联',
      cell: (row) =>
        row.refEntityType ? (
          <div className="flex flex-col">
            <span className="text-xs text-[#666666]">{row.refEntityType}</span>
            {row.refEntityId && (
              <span className="font-mono text-xs text-[#999999]">
                {row.refEntityId}
              </span>
            )}
          </div>
        ) : (
          '—'
        ),
    },
    {
      key: 'actions',
      header: '操作',
      cell: (row) => (
        <div className="flex gap-2">
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setDetail(row)}
          >
            查看
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-[#D94040]"
            onClick={() => setPendingDelete(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">消息中心</h1>
        {canSend && (
          <Button onClick={() => setBatchOpen(true)}>批量发送消息</Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3">
            <Select
              className="w-32"
              value={rtypeFilter}
              onChange={(e) => setFilter('rtype', e.target.value)}
            >
              <option value="">全部接收人</option>
              {RECIPIENT_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Select
              className="w-36"
              value={typeFilter}
              onChange={(e) => setFilter('type', e.target.value)}
            >
              <option value="">全部分类</option>
              {messageTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Select
              className="w-28"
              value={readFilter}
              onChange={(e) => setFilter('read', e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="unread">未读</option>
              <option value="read">已读</option>
            </Select>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                className="w-40"
                value={dateFrom}
                onChange={(e) => setFilter('from', e.target.value)}
              />
              <span className="text-[#999999]">-</span>
              <Input
                type="date"
                className="w-40"
                value={dateTo}
                onChange={(e) => setFilter('to', e.target.value)}
              />
            </div>
            <Input
              className="max-w-xs"
              placeholder="搜索标题 / 接收人ID"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <DataTable columns={columns} data={messages} />

      <Pagination
        total={total}
        pageSize={pageSize}
        page={currentPage}
        onPageChange={(p) => set('page', p === 1 ? '' : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      {/* Detail Dialog */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogClose onOpenChange={(open) => !open && setDetail(null)} />
        <DialogHeader>
          <DialogTitle>消息详情</DialogTitle>
        </DialogHeader>
        {detail && (
          <div className="space-y-3 mt-4 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">时间</span>
              <span>{formatDateTime(detail.createdAt)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">接收人</span>
              <span>
                {detail.recipientType} · {detail.recipientName ?? '—'}
                <span className="ml-2 font-mono text-xs text-[#999999]">
                  {detail.recipientId}
                </span>
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">分类</span>
              <span>{detail.messageType ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#999999]">状态</span>
              <span>{detail.isRead ? '已读' : '未读'}</span>
            </div>
            {detail.refEntityType && (
              <div className="flex justify-between gap-4">
                <span className="text-[#999999]">关联实体</span>
                <span>
                  {detail.refEntityType}
                  {detail.refEntityId && (
                    <span className="ml-1 font-mono text-xs">
                      {detail.refEntityId}
                    </span>
                  )}
                </span>
              </div>
            )}
            <div>
              <div className="text-[#999999] mb-1">标题</div>
              <div className="font-medium">{detail.title}</div>
            </div>
            {detail.body && (
              <div>
                <div className="text-[#999999] mb-1">正文</div>
                <div className="whitespace-pre-wrap bg-[var(--muted)] rounded-md p-3">
                  {detail.body}
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogTitle>确认删除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要删除该消息吗？此操作不可撤销。
          {pendingDelete && (
            <div className="mt-2 text-sm text-[#666666]">
              标题：{pendingDelete.title}
            </div>
          )}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => setPendingDelete(null)}
            disabled={deleting}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={deleting}>
            {deleting ? '删除中...' : '删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 批量发送消息 Dialog */}
      <Dialog
        open={batchOpen}
        onOpenChange={(open) => {
          if (!open) resetBatchState()
          else setBatchOpen(true)
        }}
        className="max-w-3xl"
      >
        <DialogClose
          onOpenChange={(open) => {
            if (!open) resetBatchState()
          }}
        />
        <DialogHeader>
          <DialogTitle>批量发送消息</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {/* 消息内容 */}
          <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
            <div>
              <label className="mb-1 block text-sm font-medium">
                标题 <span className="text-[#D94040]">*</span>
              </label>
              <Input
                maxLength={200}
                placeholder="请输入消息标题（≤200 字）"
                value={batchTitle}
                onChange={(e) => setBatchTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">正文</label>
              <textarea
                className="flex min-h-[96px] w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
                placeholder="请输入正文内容（可选）"
                value={batchBody}
                onChange={(e) => setBatchBody(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">分类</label>
              <Input
                maxLength={50}
                placeholder="例如 system / promotion（可选，≤50 字）"
                value={batchType}
                onChange={(e) => setBatchType(e.target.value)}
                className="max-w-xs"
              />
            </div>
          </div>

          {/* 接收人筛选 */}
          <div className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">接收人</span>
              <div className="flex gap-2">
                <Button
                  variant={batchMode === 'select' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setBatchMode('select')}
                >
                  手动勾选
                </Button>
                <Button
                  variant={batchMode === 'filter' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setBatchMode('filter')}
                >
                  按筛选发送
                </Button>
              </div>
            </div>

            {/* 筛选栏 */}
            <div className="flex flex-wrap gap-2">
              <OrgTreeSelect
                orgNodes={batchOrgNodes}
                value={batchOrgFilter}
                onChange={(id) => setBatchOrgFilter(id)}
                placeholder="全部市场/门店"
                excludeTypes={['部门']}
                className="w-56"
              />
              <Select
                className="w-32"
                value={batchLevelFilter}
                onChange={(e) => setBatchLevelFilter(e.target.value)}
              >
                <option value="">全部等级</option>
                {MEMBER_LEVEL_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
              <Input
                placeholder="搜索姓名/手机号"
                value={batchSearch}
                onChange={(e) => setBatchSearch(e.target.value)}
                className="flex-1 min-w-[180px]"
              />
            </div>

            {/* 顾客表格 / 筛选模式提示 */}
            {batchMode === 'select' ? (
              <>
                <div className="rounded-[var(--radius)] border border-[var(--border)]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] bg-[var(--muted)]/50">
                        <th className="w-10 px-3 py-2 text-left">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-[var(--input)]"
                            checked={
                              batchCustomers.length > 0 &&
                              batchCustomers.every((c) => batchSelected.has(c.userId))
                            }
                            onChange={toggleSelectAllPage}
                          />
                        </th>
                        <th className="px-3 py-2 text-left font-medium">姓名</th>
                        <th className="px-3 py-2 text-left font-medium">手机号</th>
                        <th className="px-3 py-2 text-left font-medium">门店</th>
                        <th className="px-3 py-2 text-left font-medium">等级</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchCustomers.length === 0 ? (
                        <tr>
                          <td
                            colSpan={5}
                            className="px-3 py-8 text-center text-[var(--muted-foreground)]"
                          >
                            暂无数据
                          </td>
                        </tr>
                      ) : (
                        batchCustomers.map((c) => (
                          <tr
                            key={c.userId}
                            className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/30"
                          >
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-[var(--input)]"
                                checked={batchSelected.has(c.userId)}
                                onChange={() => toggleBatchSelect(c.userId)}
                              />
                            </td>
                            <td className="px-3 py-2 font-medium">{c.name || '—'}</td>
                            <td className="px-3 py-2 font-mono">{formatPhoneSafe(c.phone)}</td>
                            <td className="px-3 py-2">{c.storeName || '—'}</td>
                            <td className="px-3 py-2">{c.memberLevel || '—'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  total={batchTotal}
                  page={batchPage}
                  pageSize={10}
                  onPageChange={handleBatchPageChange}
                />

                <div className="text-sm text-[var(--muted-foreground)]">
                  已选 {batchSelected.size} 位顾客（当前筛选命中 {batchTotal} 人）
                </div>
              </>
            ) : (
              <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--muted)]/30 p-4 text-sm">
                将向<strong className="mx-1 text-[var(--foreground)]">当前筛选条件</strong>
                命中的
                <strong className="mx-1 text-[#C0322A]">{batchTotal}</strong>
                位顾客批量发送消息。
                {batchTotal > BATCH_SEND_MAX && (
                  <div className="mt-2 text-[#D94040]">
                    超过单次上限 {BATCH_SEND_MAX} 人，请缩小筛选范围。
                  </div>
                )}
                {batchTotal === 0 && (
                  <div className="mt-2 text-[#D4820A]">当前筛选结果为空，无法发送。</div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={resetBatchState} disabled={batchSending}>
            取消
          </Button>
          <Button
            onClick={handleBatchSend}
            disabled={
              batchSending ||
              !batchTitle.trim() ||
              (batchMode === 'select' && batchSelected.size === 0) ||
              (batchMode === 'filter' && (batchTotal === 0 || batchTotal > BATCH_SEND_MAX))
            }
          >
            {batchSending
              ? '发送中...'
              : batchMode === 'select'
                ? `确认发送（${batchSelected.size} 人）`
                : `确认发送（${batchTotal} 人）`}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
