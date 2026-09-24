'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { listInventorySkus } from '@/actions/inventory/skus'
import { actionErrorMessage } from '@/lib/action-error'
import type { InventorySkuOptionFilters, InventorySkuRow } from '@/lib/inventory/types'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export const SKU_SEARCH_PAGE_SIZE = 20
export const SKU_SEARCH_DEBOUNCE_MS = 300

export function formatInventorySkuLabel(sku: Pick<InventorySkuRow, 'productName' | 'specName' | 'productCode'>): string {
  return `${sku.productName}${sku.specName ? ` · ${sku.specName}` : ''} · ${sku.productCode}`
}

/**
 * 可检索的库存商品选择（#339）。
 *
 * 取代「页面服务端预加载前 100 条 + 原生 select」：候选按 product_code 升序只拿第一页，
 * 市场新建的 `INV-SKU-…` 自采商品排在 WorkFine 导入编号之后，大概率根本选不到。
 * 现在展开后按关键词（防抖）走服务端分页，业务过滤（`filters`）也在服务端做 ——
 * 在前端对「第一页」再筛一遍，筛掉的只是那 100 条里的，排在后面的合法商品依旧看不见。
 *
 * 已选值的名称**不依赖**当前检索结果（#192 DocPicker 同一个坑：选中项掉出候选集后
 * 控件一片空白）：选中时就地记下名称；外部带进来的值（回显 / 预填）先用调用方给的
 * `selectedLabel`，没有就按 `skuIds` 精确查一次（含已停用商品）。
 */
export function InventorySkuSearchSelect({
  value,
  onChange,
  filters,
  disabled = false,
  disabledHint,
  placeholder = '选择库存商品',
  selectedLabel,
  ariaLabel,
}: {
  value: string
  /** 第二个参数是被选中的完整行；清空时为 null。 */
  onChange: (skuId: string, sku: InventorySkuRow | null) => void
  filters?: InventorySkuOptionFilters
  disabled?: boolean
  /** 禁用原因（如「请先选择市场」），代替占位文案显示。 */
  disabledHint?: string
  placeholder?: string
  /** 调用方已知的已选商品名称（如单据明细的 skuName），优先于精确查询。 */
  selectedLabel?: string | null
  ariaLabel?: string
}) {
  const listboxId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [rows, setRows] = useState<InventorySkuRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [labels, setLabels] = useState<Map<string, string>>(() => new Map())
  // 只有最后一次发出的请求能落地：关键词连打、翻页与换过滤条件交错时，先发后到的旧结果必须丢掉。
  const requestSeqRef = useRef(0)

  // 调用方多半传内联对象字面量，按内容而不是引用判断过滤条件是否真的变了。
  const filterKey = JSON.stringify(filters ?? {})
  const stableFilters = useMemo(() => JSON.parse(filterKey) as InventorySkuOptionFilters, [filterKey])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), SKU_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [keyword])

  // 展开、关键词或过滤条件变化 → 重查第 1 页。收起时不取数。
  useEffect(() => {
    if (!open) return
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    setRows([])
    setTotal(0)
    setPage(1)
    setActiveIndex(-1)
    listInventorySkus({ ...stableFilters, keyword: debouncedKeyword || undefined, onlyActive: true, page: 1, pageSize: SKU_SEARCH_PAGE_SIZE })
      .then((result) => {
        if (seq !== requestSeqRef.current) return
        setRows(result.data)
        setTotal(result.total)
      })
      .catch((err: unknown) => {
        if (seq !== requestSeqRef.current) return
        setError(actionErrorMessage(err, '加载库存商品失败'))
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false)
      })
  }, [open, debouncedKeyword, stableFilters])

  function loadMore() {
    if (loading) return
    const nextPage = page + 1
    const seq = ++requestSeqRef.current
    setLoading(true)
    listInventorySkus({ ...stableFilters, keyword: debouncedKeyword || undefined, onlyActive: true, page: nextPage, pageSize: SKU_SEARCH_PAGE_SIZE })
      .then((result) => {
        if (seq !== requestSeqRef.current) return
        setRows((previous) => {
          const seen = new Set(previous.map((row) => row.skuId))
          return [...previous, ...result.data.filter((row) => !seen.has(row.skuId))]
        })
        setTotal(result.total)
        setPage(nextPage)
      })
      .catch((err: unknown) => {
        if (seq !== requestSeqRef.current) return
        setError(actionErrorMessage(err, '加载库存商品失败'))
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false)
      })
  }

  // 已选值名称兜底：既不在本地记录里、调用方也没给名称时，按 id 精确查（含已停用）。
  const knownLabel = value ? labels.get(value) ?? (selectedLabel || null) : null
  useEffect(() => {
    if (!value || knownLabel) return
    let cancelled = false
    listInventorySkus({ skuIds: [value], onlyActive: false, page: 1, pageSize: SKU_SEARCH_PAGE_SIZE })
      .then((result) => {
        if (cancelled) return
        const sku = result.data.find((row) => row.skuId === value)
        setLabels((previous) => new Map(previous).set(value, sku ? formatInventorySkuLabel(sku) : value))
      })
      .catch(() => {
        if (!cancelled) setLabels((previous) => new Map(previous).set(value, value))
      })
    return () => {
      cancelled = true
    }
  }, [value, knownLabel])

  useEffect(() => {
    if (!open) return
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  function select(sku: InventorySkuRow) {
    setLabels((previous) => new Map(previous).set(sku.skuId, formatInventorySkuLabel(sku)))
    onChange(sku.skuId, sku)
    setOpen(false)
    setKeyword('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(rows.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      // 表单都是 onSubmit 提交，回车必须拦下，否则在搜索框里回车会直接提交整张单
      event.preventDefault()
      const sku = rows[activeIndex]
      if (sku) select(sku)
    }
  }

  const hasMore = rows.length < total
  const displayText = value ? (knownLabel ?? '加载中…') : null

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel ?? placeholder}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        title={displayText ?? undefined}
        className={cn(
          'flex h-10 w-full items-center justify-between rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 text-left text-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50',
          !displayText && 'text-[var(--muted-foreground)]',
        )}
      >
        <span className="truncate">{displayText ?? (disabled && disabledHint ? disabledHint : placeholder)}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="ml-2 shrink-0 text-[var(--muted-foreground)]">
          <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[18rem] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-md">
          <div className="border-b border-[var(--border)] p-2">
            <Input
              autoFocus
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入编号 / 名称 / 规格搜索"
              aria-label="搜索库存商品"
              aria-controls={listboxId}
              className="h-9"
            />
          </div>
          <div id={listboxId} role="listbox" aria-label="库存商品候选" className="max-h-[300px] overflow-y-auto py-1">
            {rows.map((sku, index) => (
              <button
                key={sku.skuId}
                type="button"
                role="option"
                aria-selected={sku.skuId === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(sku)}
                className={cn(
                  'block w-full truncate px-3 py-1.5 text-left text-sm',
                  index === activeIndex && 'bg-[var(--accent)]',
                  sku.skuId === value && 'text-[#C0322A]',
                )}
                title={formatInventorySkuLabel(sku)}
              >
                {formatInventorySkuLabel(sku)}
              </button>
            ))}
            {!loading && !error && rows.length === 0 && (
              <div className="px-3 py-2 text-sm text-[var(--muted-foreground)]">
                {debouncedKeyword ? '没有匹配的库存商品' : '暂无可选库存商品'}
              </div>
            )}
            {error && <div role="alert" className="px-3 py-2 text-sm text-[var(--destructive)]">{error}</div>}
            {loading && <div className="px-3 py-2 text-sm text-[var(--muted-foreground)]">加载中…</div>}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
            <span>{total > 0 ? `已显示 ${rows.length} / ${total}` : ''}</span>
            <span className="flex items-center gap-3">
              {value && (
                <button type="button" className="hover:text-[var(--foreground)]" onClick={() => { onChange('', null); setOpen(false) }}>
                  清除选择
                </button>
              )}
              {hasMore && (
                <button type="button" className="text-[var(--primary)] hover:underline disabled:opacity-50" disabled={loading} onClick={loadMore}>
                  加载更多
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
