'use client'

import { useCallback, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/ui/date-picker'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Pagination } from '@/components/ui/pagination'
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Plus, Trash2 } from 'lucide-react'
import MarketStoreFilter from '@/components/market-store-filter'
import type { MarketStoreFilterOptions, StoreFilterOption } from '@/lib/market-store-filter-types'
import type {
  InventoryOrderRow,
  InventoryItemDto,
} from '@/actions/inventory/types'

export type DocCategory = 'procurement' | 'sale' | 'transfer' | 'scrap'

const SUBTYPES_BY_CATEGORY: Record<DocCategory, string[]> = {
  procurement: ['院报货', '院入库', '退货出库'],
  sale: ['销售出库', '顾客退货'],
  transfer: ['调拨出库', '调拨入库'],
  scrap: [],
}

const PAGE_SIZE_OPTIONS = [10, 20, 50]

function formatDate(d: string | null | undefined) {
  if (!d) return '—'
  return d.slice(0, 10)
}

interface Props {
  category: DocCategory
  title: string
  rows: InventoryOrderRow[]
  total: number
  filterOptions: MarketStoreFilterOptions
  canCreate: boolean
  canDelete: boolean
  /** Server Action 包装：createXxxOrder({...}) — 跨 4 模块共享，参数为各自的 *CreateInput，统一收 any */
  onCreate: (input: any) => Promise<{ id: string }>
  /** Server Action：deleteXxxOrder(id) */
  onDelete: (id: string) => Promise<{ success: true }>
}

export default function InventoryListView({
  category,
  title,
  rows,
  total,
  filterOptions,
  canCreate,
  canDelete,
  onCreate,
  onDelete,
}: Props) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()

  const storeFilter = get('store')
  const marketFilter = get('market')
  const subtypeFilter = get('subtype')
  const statusFilter = get('status')
  const dateFrom = get('from')
  const dateTo = get('to')
  const currentPage = Math.max(1, Number(get('page', '1')) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get('size')))
    ? Number(get('size'))
    : 20

  const [searchInput, setSearchInput] = useState(get('q'))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (debounceRef[0]) clearTimeout(debounceRef[0])
      debounceRef[0] = setTimeout(() => setMany({ q: value, page: '' }), 300)
    },
    [debounceRef, setMany],
  )

  const setFilter = useCallback(
    (key: string, value: string) => setMany({ [key]: value, page: '' }),
    [setMany],
  )

  const [createOpen, setCreateOpen] = useState(false)

  async function handleDelete(id: string) {
    if (!confirm(`确认删除单据 ${id}？此操作不可恢复。`)) return
    try {
      await onDelete(id)
      startTransition(() => router.refresh())
    } catch (e) {
      alert(`删除失败：${(e as Error).message}`)
    }
  }

  const columns: Column<InventoryOrderRow>[] = [
    {
      key: 'id',
      header: '单据号',
      cell: (r) => <span className="font-mono text-xs">{r.id}</span>,
    },
    ...(category !== 'scrap'
      ? [
          {
            key: 'docSubtype',
            header: '类型',
            cell: (r: InventoryOrderRow) => (
              <span className="rounded bg-[#FFF0EE] px-2 py-0.5 text-xs text-[var(--primary)]">
                {r.docSubtype ?? '—'}
              </span>
            ),
          } as Column<InventoryOrderRow>,
        ]
      : []),
    {
      key: 'storeName',
      header: '门店',
      cell: (r) => <span>{r.storeName ?? '—'}</span>,
    },
    ...(category === 'transfer'
      ? [
          {
            key: 'counterpartStoreName',
            header: '对方门店',
            cell: (r: InventoryOrderRow) => (
              <span>{r.counterpartStoreName ?? '—'}</span>
            ),
          } as Column<InventoryOrderRow>,
        ]
      : []),
    ...(category === 'sale'
      ? [
          {
            key: 'customerName',
            header: '顾客',
            cell: (r: InventoryOrderRow) => <span>{r.customerName ?? '—'}</span>,
          } as Column<InventoryOrderRow>,
        ]
      : []),
    { key: 'docDate', header: '单据日期', cell: (r) => formatDate(r.docDate) },
    {
      key: 'totalQuantity',
      header: '总数量',
      cell: (r) => (
        <span className="font-medium">
          {r.totalQuantity == null ? '—' : Number(r.totalQuantity)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      cell: (r) => (
        <span
          className={
            r.status === '已完成'
              ? 'text-[#3D8A5A]'
              : r.status === '已取消'
                ? 'text-[#888888]'
                : 'text-[#D4820A]'
          }
        >
          {r.status}
        </span>
      ),
    },
    {
      key: 'createdByName',
      header: '录入人',
      cell: (r) => <span>{r.createdByName ?? r.createdBy}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      cell: (r) => (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/inventory/${category}/${r.id}`)}
          >
            详情
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(r.id)}
              className="text-[#D94040]"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{title}</h2>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4 mr-1" /> 新建
          </Button>
        )}
      </div>

      <div className="bg-white border border-[var(--border)] rounded-md p-3 flex flex-wrap gap-3 items-end">
        <MarketStoreFilter
          options={filterOptions}
          marketValue={marketFilter}
          storeValue={storeFilter}
          onMarketChange={(value) => setMany({ market: value, store: '', page: '' })}
          onStoreChange={(value) => setFilter('store', value)}
          withLabels
        />

        {SUBTYPES_BY_CATEGORY[category].length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[#666666]">子类型</span>
            <Select
              value={subtypeFilter || ''}
              onChange={(e) => setFilter('subtype', e.target.value)}
              className="w-32"
            >
              <option value="">全部</option>
              {SUBTYPES_BY_CATEGORY[category].map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-xs text-[#666666]">状态</span>
          <Select
            value={statusFilter || ''}
            onChange={(e) => setFilter('status', e.target.value)}
            className="w-28"
          >
            <option value="">全部</option>
            <option value="草稿">草稿</option>
            <option value="已完成">已完成</option>
            <option value="已取消">已取消</option>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-[#666666]">起始日期</span>
          <DatePicker
            value={dateFrom}
            onValueChange={(value) => setFilter('from', value)}
            className="w-36"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-[#666666]">结束日期</span>
          <DatePicker
            value={dateTo}
            onValueChange={(value) => setFilter('to', value)}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="text-xs text-[#666666]">搜索</span>
          <Input
            placeholder="单据号 / 备注..."
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        emptyText="暂无单据"
        onRowClick={(r) => router.push(`/inventory/${category}/${r.id}`)}
      />

      <Pagination
        total={total}
        page={currentPage}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={(p) => setMany({ page: String(p) })}
        onPageSizeChange={(s) => setMany({ size: String(s), page: '' })}
      />

      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        category={category}
        stores={filterOptions.stores}
        onCreate={onCreate}
        onSuccess={() => {
          setCreateOpen(false)
          startTransition(() => router.refresh())
        }}
      />
    </div>
  )
}

// ── Create Dialog（schema-driven） ─────────────────────────────────────────

interface CreateDialogProps {
  open: boolean
  onClose: () => void
  category: DocCategory
  stores: StoreFilterOption[]
  onCreate: (input: unknown) => Promise<{ id: string }>
  onSuccess: () => void
}

function CreateDialog({ open, onClose, category, stores, onCreate, onSuccess }: CreateDialogProps) {
  const subtypes = SUBTYPES_BY_CATEGORY[category]
  const [storeId, setStoreId] = useState('')
  const [counterpartStoreId, setCounterpartStoreId] = useState('')
  const [docSubtype, setDocSubtype] = useState(subtypes[0] ?? '')
  const [docDate, setDocDate] = useState(() => {
    // 上海时区当日 YYYY-MM-DD，避免 UTC 截断跨午夜
    const d = new Date()
    const tz = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
    return tz // en-CA 格式即 YYYY-MM-DD
  })
  const [customerName, setCustomerName] = useState('')
  const [remark, setRemark] = useState('')
  const [items, setItems] = useState<InventoryItemDto[]>([
    { productCode: '', productName: '', quantity: 1, scrapReason: category === 'scrap' ? '店用' : undefined },
  ])
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function patchItem(idx: number, patch: Partial<InventoryItemDto>) {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }
  function addItem() {
    setItems((arr) => [
      ...arr,
      { productCode: '', productName: '', quantity: 1, scrapReason: category === 'scrap' ? '店用' : undefined },
    ])
  }
  function removeItem(idx: number) {
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr))
  }

  async function submit() {
    setErr(null)
    if (!storeId) return setErr('请选择门店')
    if (category === 'transfer' && !counterpartStoreId) return setErr('请选择对方门店')
    if (category === 'transfer' && storeId === counterpartStoreId)
      return setErr('发起与接收门店必须不同')
    if (items.some((it) => !it.productCode || !it.productName || !it.quantity))
      return setErr('明细必须填写产品和数量')
    if (category === 'scrap' && items.some((it) => !it.scrapReason))
      return setErr('报损单必须填写每条明细的原因')

    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        storeId,
        docDate,
        remark: remark || null,
        items,
      }
      if (category !== 'scrap') payload.docSubtype = docSubtype
      if (category === 'transfer') payload.counterpartStoreId = counterpartStoreId
      if (category === 'sale') payload.customerName = customerName || null
      await onCreate(payload)
      onSuccess()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      className="max-w-5xl w-[95vw]"
    >
      <div className="flex flex-col max-h-[85vh] -m-6">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-[var(--border)]">
          <DialogTitle>新建{categoryTitle(category)}单据</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* 主表字段 */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="门店">
              <Select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                <option value="">请选择</option>
                {stores.map((s) => (
                  <option key={s.storeId} value={s.storeId}>
                    {s.storeName}
                  </option>
                ))}
              </Select>
            </Field>
            {category === 'transfer' && (
              <Field label="对方门店">
                <Select
                  value={counterpartStoreId}
                  onChange={(e) => setCounterpartStoreId(e.target.value)}
                >
                  <option value="">请选择</option>
                  {stores
                    .filter((s) => s.storeId !== storeId)
                    .map((s) => (
                      <option key={s.storeId} value={s.storeId}>
                        {s.storeName}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            {subtypes.length > 0 && (
              <Field label="子类型">
                <Select value={docSubtype} onChange={(e) => setDocSubtype(e.target.value)}>
                  {subtypes.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="单据日期">
              <DatePicker
                value={docDate}
                onValueChange={(value) => setDocDate(value)}
              />
            </Field>
            {category === 'sale' && (
              <Field label="顾客姓名（可选）">
                <Input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="销售出库 / 顾客退货必填"
                />
              </Field>
            )}
          </div>

          <Field label="备注">
            <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Field>

          {/* 明细行：表头 + 表格式录入 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">明细行（{items.length}）</span>
              <Button size="sm" variant="ghost" onClick={addItem}>
                <Plus className="size-3.5 mr-1" /> 加一行
              </Button>
            </div>

            <div className="border border-[var(--border)] rounded-md overflow-hidden">
              {/* 表头 */}
              <div className="grid gap-2 px-3 py-2 bg-[#F8F8F8] text-xs text-[#666666] font-medium"
                   style={{ gridTemplateColumns: '140px 1fr 140px 100px 120px 140px 40px' }}>
                <div>产品编号</div>
                <div>产品名 <span className="text-[#D94040]">*</span></div>
                <div>规格</div>
                <div>数量 <span className="text-[#D94040]">*</span></div>
                <div>批号</div>
                <div>{category === 'scrap' ? '报损原因 *' : '单价'}</div>
                <div></div>
              </div>

              {/* 数据行 */}
              {items.map((it, idx) => (
                <div
                  key={idx}
                  className="grid gap-2 px-3 py-2 border-t border-[var(--border)] items-center"
                  style={{ gridTemplateColumns: '140px 1fr 140px 100px 120px 140px 40px' }}
                >
                  <Input
                    placeholder="编号"
                    value={it.productCode}
                    onChange={(e) => patchItem(idx, { productCode: e.target.value })}
                  />
                  <Input
                    placeholder="产品名"
                    value={it.productName}
                    onChange={(e) => patchItem(idx, { productName: e.target.value })}
                  />
                  <Input
                    placeholder="规格"
                    value={it.specName ?? ''}
                    onChange={(e) => patchItem(idx, { specName: e.target.value })}
                  />
                  <Input
                    type="number"
                    placeholder="数量"
                    value={String(it.quantity)}
                    onChange={(e) => patchItem(idx, { quantity: Number(e.target.value) })}
                  />
                  <Input
                    placeholder="批号"
                    value={it.batchNo ?? ''}
                    onChange={(e) => patchItem(idx, { batchNo: e.target.value })}
                  />
                  {category === 'scrap' ? (
                    <Select
                      value={it.scrapReason ?? '店用'}
                      onChange={(e) => patchItem(idx, { scrapReason: e.target.value })}
                    >
                      <option value="店用">店用</option>
                      <option value="客用">客用</option>
                      <option value="顾客赠送">顾客赠送</option>
                      <option value="过期">过期</option>
                      <option value="破损">破损</option>
                    </Select>
                  ) : (
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="单价"
                      value={it.unitPrice == null ? '' : String(it.unitPrice)}
                      onChange={(e) =>
                        patchItem(idx, {
                          unitPrice: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeItem(idx)}
                    disabled={items.length <= 1}
                    className="text-[#D94040]"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {err && <div className="text-sm text-[#D94040]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--border)] bg-white">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? '提交中...' : '提交'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[#666666]">{label}</span>
      {children}
    </label>
  )
}

function categoryTitle(c: DocCategory): string {
  return c === 'procurement'
    ? '采购入库'
    : c === 'sale'
      ? '销售出库'
      : c === 'transfer'
        ? '门店调拨'
        : '报损出库'
}
