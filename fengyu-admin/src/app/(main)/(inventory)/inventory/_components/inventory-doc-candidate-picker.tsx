'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { listInventoryDocCandidateIds, listInventoryDocCandidates } from '@/actions/inventory/docs'
import { actionErrorMessage } from '@/lib/action-error'
import { inventoryDocStatusLabel } from '@/lib/inventory/doc-status-label'
import {
  INVENTORY_DOC_CANDIDATES,
  INVENTORY_DOC_CANDIDATE_PROGRESS_LABEL,
  type InventoryDocCandidatePurpose,
  type InventoryDocCandidateRow,
} from '@/lib/inventory/doc-candidates'
import type { InventoryDocRow } from '@/lib/inventory/types'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'

export const DOC_CANDIDATE_PAGE_SIZE = 20
export const DOC_CANDIDATE_DEBOUNCE_MS = 300

/**
 * 候选重取信号（#338）。候选原先随 RSC 的 `router.refresh()` 一起刷新；改成客户端查询后
 * refresh 管不到它，建单 / 行内动作成功后由工作区 bump 版本号，所有挂着的候选列表重取。
 * 默认值是 no-op，脱离工作区单独渲染时不报错。
 */
export const DocCandidateReloadContext = createContext<{ version: number; bump: () => void }>({
  version: 0,
  bump: () => {},
})

export function formatCandidateDoc(doc: Pick<InventoryDocRow, 'id' | 'docDate' | 'status' | 'partiallyReceived'>): string {
  return `${doc.id} · ${doc.docDate.slice(0, 10)} · ${inventoryDocStatusLabel(doc)}`
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function progressText(row: InventoryDocCandidateRow, purpose: InventoryDocCandidatePurpose) {
  const kind = INVENTORY_DOC_CANDIDATES[purpose].progress
  const label = INVENTORY_DOC_CANDIDATE_PROGRESS_LABEL[kind]
  if (row.progress.done === null) return `${label} ${formatQuantity(row.progress.total)}`
  return `${label} ${formatQuantity(row.progress.done)} / ${formatQuantity(row.progress.total)}`
}

type Selection =
  | {
    mode: 'single'
    value: string
    /** 已选单据的完整行（表单 `useLoadedDocument()` 的 doc），只用于「已选」文案 */
    current?: Pick<InventoryDocRow, 'id' | 'docDate' | 'status' | 'partiallyReceived'> | null
    onChange: (id: string) => void
  }
  | {
    mode: 'multi'
    values: string[]
    onChange: (ids: string[]) => void
    /** 一键带出：用当前检索条件（日期区间等）取全部仍有剩余量的单，替换已选 */
    bulkLabel?: string
    /** 一键带出暂不可用的原因（如「请先选择供应链库存主体」），按钮禁用并显示为提示 */
    bulkDisabledReason?: string
  }

/**
 * 办理台的来源单 / 待处理单选择（#338）。
 *
 * 取代「页面预加载最近 100 张 + 原生 select」：按用途走服务端检索 + 分页，
 * 默认只列仍有剩余量的单（建单类来源可切换显示全部），候选以表格展示收发主体与进度。
 * 已选单据单独显示在表格上方，**不依赖**它是否在当前页 —— 待办「去收货」预选的老单、
 * 办完一次后掉出候选的单，都照样有已选文案（#192 DocPicker 的同一个坑）。
 */
export function InventoryDocCandidatePicker({
  label,
  purpose,
  selection,
  required = false,
  disabled = false,
  targetOrgNodeId,
}: {
  label: string
  purpose: InventoryDocCandidatePurpose
  selection: Selection
  required?: boolean
  disabled?: boolean
  /** 收窄到某个接收端（采购订单表单选了供应链主体后） */
  targetOrgNodeId?: string
}) {
  const definition = INVENTORY_DOC_CANDIDATES[purpose]
  const showDocType = definition.rules.length > 1
  const labelId = useId()
  const radioName = useId()
  const { version } = useContext(DocCandidateReloadContext)
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [includeExhausted, setIncludeExhausted] = useState(false)
  const [rows, setRows] = useState<InventoryDocCandidateRow[]>([])
  const [total, setTotal] = useState(0)
  const [pageSize, setPageSize] = useState(DOC_CANDIDATE_PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [bulkLoading, setBulkLoading] = useState(false)
  // 只有最后一次发出的请求能落地：检索、翻页、重取交错时过时结果必须丢掉
  const requestSeqRef = useRef(0)
  // 一键带出：卸载 / 重复点击时作废在途请求（条件与已选的变化由下面的整包快照比对负责）
  const bulkSeqRef = useRef(0)
  /*
   * 一键带出**实际发送的全部参数** + 已选集合，渲染期同步。在途请求落地前与发起时的快照整包比对，
   * 不依赖任何被动 effect（effect 不保证先于异步回调执行），也不借用列表的防抖 filterKey ——
   * 带出用的是非防抖关键字，防抖追平那一下不该把正确的结果作废。
   */
  const bulkKey = JSON.stringify([
    purpose,
    keyword.trim(),
    startDate,
    endDate,
    targetOrgNodeId ?? '',
    selection.mode === 'multi' ? selection.values : [],
  ])
  const latestBulkKeyRef = useRef(bulkKey)
  latestBulkKeyRef.current = bulkKey
  useEffect(() => () => { bulkSeqRef.current++ }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), DOC_CANDIDATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  /*
   * 任一检索条件变化回到第 1 页（否则可能停在一个已不存在的页码上）。页码与条件绑在同一份
   * state 里、渲染期直接判定，而不是另起一个 effect 去 setPage(1) —— 那样每次换条件都会先按
   * 旧页码发一次注定作废的请求。
   */
  const filterKey = JSON.stringify([purpose, debouncedKeyword, startDate, endDate, includeExhausted, targetOrgNodeId ?? ''])
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 })
  const page = pageState.key === filterKey ? pageState.page : 1
  const setPage = useCallback((next: number) => setPageState({ key: filterKey, page: next }), [filterKey])

  useEffect(() => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    listInventoryDocCandidates({
      purpose,
      keyword: debouncedKeyword || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      targetOrgNodeId: targetOrgNodeId || undefined,
      includeExhausted: definition.remainingToggle ? includeExhausted : undefined,
      page,
      pageSize: DOC_CANDIDATE_PAGE_SIZE,
    })
      .then((result) => {
        if (seq !== requestSeqRef.current) return
        /*
         * 重取后总数缩小（刚办完一张单）当前页可能越界：空页 + 分页器因 total ≤ pageSize 不渲染，
         * 用户就困在「没有单据」里。夹回最后一页重取。
         */
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize))
        if (result.data.length === 0 && page > lastPage) {
          setPage(lastPage)
          return
        }
        setRows(result.data)
        setTotal(result.total)
        setPageSize(result.pageSize)
      })
      .catch((err: unknown) => {
        if (seq !== requestSeqRef.current) return
        setError(actionErrorMessage(err, '加载候选单据失败'))
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false)
      })
    // filterKey 已覆盖全部检索条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page, version, retryNonce])

  const isSelected = (id: string) => (
    selection.mode === 'single' ? selection.value === id : selection.values.includes(id)
  )

  const toggle = (id: string, checked: boolean) => {
    if (selection.mode === 'single') {
      selection.onChange(checked ? id : '')
      return
    }
    selection.onChange(checked
      ? (selection.values.includes(id) ? selection.values : [...selection.values, id])
      : selection.values.filter((value) => value !== id))
  }

  const bringOut = async () => {
    if (selection.mode !== 'multi' || bulkLoading || selection.bulkDisabledReason) return
    const seq = ++bulkSeqRef.current
    // 请求快照（见 bulkKey）：用输入框的**当前**关键字，不用防抖值
    const snapshot = bulkKey
    const hadSelection = selection.values.length > 0
    setBulkLoading(true)
    try {
      const result = await listInventoryDocCandidateIds({
        purpose,
        keyword: keyword.trim() || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        targetOrgNodeId: targetOrgNodeId || undefined,
      })
      // 在途时改了日期 / 关键字 / 主体，或已选被清除 / 改勾选：旧结果不能再覆盖当前选择
      if (seq !== bulkSeqRef.current || latestBulkKeyRef.current !== snapshot) return
      // 「替换已选」对空结果同样成立：带出 0 张就清空，别让上一个区间的单留着被提交
      selection.onChange(result.ids)
      if (result.ids.length === 0) {
        toast.info(hadSelection ? '当前条件下没有仍有剩余量的单据，已清空已选' : '当前条件下没有仍有剩余量的单据')
        return
      }
      toast.success(`已带出 ${result.ids.length} 张单据`)
    } catch (err) {
      if (seq === bulkSeqRef.current) toast.error(actionErrorMessage(err, '带出单据失败'))
    } finally {
      setBulkLoading(false)
    }
  }

  const selectedSummary = selection.mode === 'single'
    ? (selection.value
      ? (selection.current && selection.current.id === selection.value
        ? formatCandidateDoc(selection.current)
        : selection.value)
      : null)
    : (selection.values.length > 0 ? `${selection.values.length} 张：${selection.values.join('、')}` : null)

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={labelId} className="block text-sm font-medium">
          {label}
          {required && (
            <>
              <span className="ml-0.5 text-[var(--primary)]" aria-hidden="true">*</span>
              <span className="sr-only">（必填）</span>
            </>
          )}
        </span>
        {selectedSummary && (
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate text-[#555555]" title={selectedSummary}>已选 {selectedSummary}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => (selection.mode === 'single' ? selection.onChange('') : selection.onChange([]))}
            >
              清除
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
        <Input
          aria-label={`${label} 检索`}
          placeholder="搜索单号 / 收发主体"
          // 与服务端截断长度一致，别让用户以为后面的字也参与了检索
          maxLength={64}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          disabled={disabled}
        />
        <DatePicker aria-label={`${label} 开始日期`} placeholder="开始日期" value={startDate} onValueChange={setStartDate} max={endDate || undefined} disabled={disabled} />
        <DatePicker aria-label={`${label} 结束日期`} placeholder="结束日期" value={endDate} onValueChange={setEndDate} min={startDate || undefined} disabled={disabled} />
        <div className="flex flex-wrap items-center gap-3">
          {definition.remainingToggle && (
            <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
              <input
                type="checkbox"
                checked={includeExhausted}
                onChange={(event) => setIncludeExhausted(event.target.checked)}
                disabled={disabled}
              />
              显示已无剩余的单
            </label>
          )}
          {selection.mode === 'multi' && selection.bulkLabel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={bulkLoading}
              disabled={disabled || Boolean(selection.bulkDisabledReason)}
              title={selection.bulkDisabledReason}
              onClick={() => void bringOut()}
            >
              {selection.bulkLabel}
            </Button>
          )}
          {selection.mode === 'multi' && selection.bulkLabel && selection.bulkDisabledReason && (
            <span className="text-xs text-[#888888]">{selection.bulkDisabledReason}</span>
          )}
        </div>
      </div>
      <div className="max-h-80 overflow-auto rounded-[var(--radius)] border border-[var(--border)]">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="sticky top-0 bg-[var(--muted)] text-left text-xs text-[var(--muted-foreground)]">
            <tr>
              <th className="w-12 px-3 py-2 font-medium"><span className="sr-only">选择</span></th>
              <th className="px-3 py-2 font-medium">单号</th>
              {showDocType && <th className="px-3 py-2 font-medium">类型</th>}
              <th className="px-3 py-2 font-medium">日期</th>
              <th className="px-3 py-2 font-medium">发出方</th>
              <th className="px-3 py-2 font-medium">接收方</th>
              <th className="px-3 py-2 font-medium">进度</th>
              <th className="px-3 py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              // 只对建单类来源标「已无剩余」：状态类候选（收货 / 关闭）的进度只是参考，不代表不可选
              const exhausted = definition.remainingToggle
                && row.progress.done !== null
                && row.progress.done >= row.progress.total - 0.000001
              return (
                <tr key={row.id} className={`border-t border-[var(--border)] ${isSelected(row.id) ? 'bg-[#FFF8F7]' : ''}`}>
                  <td className="px-3 py-2">
                    <input
                      type={selection.mode === 'single' ? 'radio' : 'checkbox'}
                      name={selection.mode === 'single' ? radioName : undefined}
                      aria-label={`选择 ${row.id}`}
                      checked={isSelected(row.id)}
                      disabled={disabled}
                      onChange={(event) => toggle(row.id, event.target.checked)}
                    />
                  </td>
                  <td className="px-3 py-2 font-medium">{row.id}</td>
                  {showDocType && <td className="px-3 py-2 text-xs text-[#666666]">{row.docType}</td>}
                  <td className="px-3 py-2">{row.docDate.slice(0, 10)}</td>
                  <td className="px-3 py-2">{row.sourceOrgNodeName ?? '—'}</td>
                  <td className="px-3 py-2">{row.targetOrgNodeName ?? '—'}</td>
                  <td className={`px-3 py-2 ${exhausted ? 'text-[#888888]' : ''}`}>
                    {progressText(row, purpose)}
                    {exhausted && <span className="ml-1 text-xs">（已无剩余）</span>}
                  </td>
                  <td className="px-3 py-2">{inventoryDocStatusLabel(row)}</td>
                </tr>
              )
            })}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={showDocType ? 8 : 7} className="px-3 py-6 text-center text-sm text-[#888888]">
                  {definition.remainingToggle && !includeExhausted ? '没有仍有剩余量的单据' : '没有符合条件的单据'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && <div className="border-t border-[var(--border)] px-3 py-2 text-sm text-[#666666]">正在加载候选单据</div>}
        {error && (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2 text-sm text-[#D94040]">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setRetryNonce((nonce) => nonce + 1)}>重试</Button>
          </div>
        )}
      </div>
      {total > pageSize && <Pagination total={total} page={page} pageSize={pageSize} onPageChange={setPage} />}
    </div>
  )
}
