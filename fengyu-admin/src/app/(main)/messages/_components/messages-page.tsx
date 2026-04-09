'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import type { AdminMessage } from '@/actions/messages'
import { deleteMessage } from '@/actions/messages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Pagination } from '@/components/ui/pagination'
import {
  Dialog,
  DialogClose,
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

function formatDateTime(dt: string) {
  return new Date(dt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface Props {
  messages: AdminMessage[]
  messageTypes: string[]
  total: number
}

/**
 * 消息中心管理页 — 服务端分页
 *
 * messages 表无 store 维度，仅 admin 可访问（菜单+权限矩阵双重控制）。
 */
export default function MessagesPage({ messages, messageTypes, total }: Props) {
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
      <h1 className="text-2xl font-bold text-[var(--foreground)]">消息中心</h1>

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
    </div>
  )
}
