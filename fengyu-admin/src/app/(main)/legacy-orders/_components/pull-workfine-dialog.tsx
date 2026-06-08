"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  searchWorkfineCustomer,
  previewWorkfineOrders,
  importWorkfineOrdersByCustomer,
  type WorkfineCustomerCandidate,
  type WorkfineOrderPreview,
  type AvailableStore,
} from "@/actions/legacy-orders"
import { formatDate as fmtDate } from "@/lib/utils"
import { actionErrorMessage } from "@/lib/action-error"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可选：从 /customers/[id] 入口打开时预填的手机号；Dialog 首次打开自动触发搜索 */
  defaultPhone?: string
}

type Step = "search" | "preview"

function formatDate(s: string | null | undefined) {
  if (!s) return "—"
  return fmtDate(s) || s
}

export default function PullWorkfineDialog({ open, onOpenChange, defaultPhone }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [step, setStep] = useState<Step>("search")
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  // WorkFine 不可用 / 搜索 / 预览失败的常驻错误（不随 toast 消失，附「重试」），绑定 search 步骤
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<WorkfineCustomerCandidate[]>([])
  const [picked, setPicked] = useState<WorkfineCustomerCandidate | null>(null)

  const [loadingOrders, setLoadingOrders] = useState(false)
  const [orders, setOrders] = useState<WorkfineOrderPreview[]>([])
  const [availableStores, setAvailableStores] = useState<AvailableStore[]>([])
  // WorkFine 门店名 → 新系统 storeId（默认同名匹配，可人工改选；"" = 未指派）
  const [storeMapping, setStoreMapping] = useState<Record<string, string>>({})
  const [selectedOrderNos, setSelectedOrderNos] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  // 重置 / 预填
  useEffect(() => {
    if (!open) return
    setStep("search")
    setCandidates([])
    setPicked(null)
    setOrders([])
    setAvailableStores([])
    setStoreMapping({})
    setSelectedOrderNos(new Set())
    setErrorMsg(null)
    if (defaultPhone) {
      setQuery(defaultPhone)
      // 自动触发一次搜索
      doSearch(defaultPhone)
    } else {
      setQuery("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultPhone])

  async function doSearch(raw: string) {
    const q = raw.trim()
    if (!q) {
      toast.error("请输入手机号或顾客编号")
      return
    }
    setErrorMsg(null)
    setSearching(true)
    try {
      const isPhone = /^1\d{10}$/.test(q)
      const res = await searchWorkfineCustomer(
        isPhone ? { phone: q } : { customerId: q },
      )
      setCandidates(res)
      if (res.length === 0) {
        toast.error("WorkFine 中未找到匹配顾客")
      } else if (res.length === 1) {
        // 自动选中并进预览
        pickCandidate(res[0])
      }
    } catch (err) {
      const msg = actionErrorMessage(err, "搜索失败")
      setErrorMsg(msg)
      toast.error(msg)
    } finally {
      setSearching(false)
    }
  }

  async function pickCandidate(c: WorkfineCustomerCandidate) {
    setErrorMsg(null)
    setPicked(c)
    setLoadingOrders(true)
    setStep("preview")
    try {
      const res = await previewWorkfineOrders({ workfineCustomerId: c.customerId })
      setOrders(res.orders)
      setAvailableStores(res.availableStores)

      // 门店映射默认值：WorkFine 门店名 → 同名新系统门店的 storeId（无同名留 ""）
      const byName = new Map(res.availableStores.map((s) => [s.storeName, s.storeId] as const))
      const distinctStoreNames = [
        ...new Set(res.orders.map((o) => o.storeName).filter((s): s is string => !!s)),
      ]
      const mapping: Record<string, string> = {}
      for (const name of distinctStoreNames) mapping[name] = byName.get(name) ?? ""
      setStoreMapping(mapping)

      // 默认勾选：未导入 且 门店已映射（同名命中）的行
      const defaultSel = new Set(
        res.orders
          .filter((o) => !o.alreadyImported && !!o.storeName && !!mapping[o.storeName])
          .map((o) => o.legacyOrderNo),
      )
      setSelectedOrderNos(defaultSel)
    } catch (err) {
      const msg = actionErrorMessage(err, "预览失败")
      setErrorMsg(msg)
      toast.error(msg)
      setStep("search")
    } finally {
      setLoadingOrders(false)
    }
  }

  function toggleOrder(legacyOrderNo: string, allowed: boolean) {
    if (!allowed) return
    setSelectedOrderNos((prev) => {
      const next = new Set(prev)
      if (next.has(legacyOrderNo)) next.delete(legacyOrderNo)
      else next.add(legacyOrderNo)
      return next
    })
  }

  function changeStoreMapping(storeName: string, storeId: string) {
    setStoreMapping((prev) => ({ ...prev, [storeName]: storeId }))
    // 若该门店改为未指派（""），取消其名下已勾选的订单
    if (!storeId) {
      setSelectedOrderNos((prev) => {
        const next = new Set(prev)
        for (const o of orders) {
          if (o.storeName === storeName) next.delete(o.legacyOrderNo)
        }
        return next
      })
    }
  }

  // 当前可导入条件：未导入 且 其 WorkFine 门店已映射到新系统门店
  const isAllowed = (o: WorkfineOrderPreview) =>
    !o.alreadyImported && !!o.storeName && !!storeMapping[o.storeName]

  async function doImport() {
    if (!picked) return
    if (selectedOrderNos.size === 0) {
      toast.error("请至少勾选 1 条")
      return
    }
    setImporting(true)
    try {
      const res = await importWorkfineOrdersByCustomer({
        workfineCustomerId: picked.customerId,
        selectedOrderNos: Array.from(selectedOrderNos),
        storeMapping,
      })
      const parts = [`已导入 ${res.insertedCount} 条`]
      if (res.skippedAlreadyExist > 0) parts.push(`已存在跳过 ${res.skippedAlreadyExist}`)
      if (res.skippedNoStore > 0) parts.push(`门店未匹配跳过 ${res.skippedNoStore}`)
      toast.success(parts.join("，"))
      onOpenChange(false)
      // 跳到 /legacy-orders 并按该顾客手机号筛选
      if (res.affectedPhone) {
        startTransition(() => {
          router.push(`/legacy-orders?q=${encodeURIComponent(res.affectedPhone!)}`)
          router.refresh()
        })
      } else {
        router.refresh()
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, "导入失败"))
    } finally {
      setImporting(false)
    }
  }

  const importableCount = orders.filter(isAllowed).length
  // 本次预览涉及的去重 WorkFine 门店名（用于映射表）
  const distinctStoreNames = [
    ...new Set(orders.map((o) => o.storeName).filter((s): s is string => !!s)),
  ]
  const unmappedCount = distinctStoreNames.filter((n) => !storeMapping[n]).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>
          {step === "search" ? "拉取顾客历史订单（WorkFine）" : `预览订单 — ${picked?.name ?? picked?.customerId}`}
        </DialogTitle>
        <DialogDescription>
          {step === "search"
            ? "输入顾客手机号或 WorkFine 顾客编号 → 在结果中选择 → 预览并勾选要导入的订单。仅写入 sale_orders.status='未审核'，不影响统计。"
            : `WorkFine 顾客编号 ${picked?.customerId}；可导入 ${importableCount} 条（共 ${orders.length} 条）。`}
        </DialogDescription>
      </DialogHeader>

      {step === "search" && (
        <div className="space-y-4 mt-4">
          {errorMsg && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/[0.06] px-3 py-2.5 text-sm text-[var(--destructive)]">
              <span aria-hidden className="mt-0.5 shrink-0 font-medium">⚠</span>
              <span className="flex-1 leading-relaxed">{errorMsg}</span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 border-[var(--destructive)]/50 text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                onClick={() => doSearch(query)}
                disabled={searching || !query.trim()}
              >
                重试
              </Button>
              <button
                type="button"
                aria-label="关闭提示"
                className="shrink-0 rounded p-0.5 opacity-60 hover:bg-[var(--destructive)]/10 hover:opacity-100"
                onClick={() => setErrorMsg(null)}
              >
                ✕
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="手机号（11 位）或 WorkFine 顾客编号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  doSearch(query)
                }
              }}
              autoFocus
            />
            <Button onClick={() => doSearch(query)} disabled={searching || !query.trim()}>
              {searching ? "搜索中…" : "搜索"}
            </Button>
          </div>

          {candidates.length > 0 && (
            <div className="border rounded-md max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] sticky top-0">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">姓名</th>
                    <th className="px-3 py-2 font-medium">手机号</th>
                    <th className="px-3 py-2 font-medium">WorkFine 编号</th>
                    <th className="px-3 py-2 font-medium">PG</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.customerId} className="border-t">
                      <td className="px-3 py-2">{c.name ?? "—"}</td>
                      <td className="px-3 py-2">{c.phone ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{c.customerId}</td>
                      <td className="px-3 py-2">
                        {c.existsInPg ? (
                          <Badge variant="default">已在 PG</Badge>
                        ) : (
                          <Badge variant="outline">未匹配</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => pickCandidate(c)}>
                          选择
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4 mt-4">
          {loadingOrders ? (
            <div className="text-center py-8 text-[var(--muted-foreground)]">加载中…</div>
          ) : orders.length === 0 ? (
            <div className="text-center py-8 text-[var(--muted-foreground)]">
              该顾客在 WorkFine 中无历史订单
            </div>
          ) : (
            <>
              {distinctStoreNames.length > 0 && (
                <div className="border rounded-md p-3 space-y-2">
                  <div className="text-sm font-medium">
                    门店映射（WorkFine 门店 → 新系统门店，默认同名）
                  </div>
                  {unmappedCount > 0 && (
                    <div className="text-xs text-[var(--destructive)]">
                      有 {unmappedCount} 个门店未指派，对应订单不可导入；请为其选择新系统门店。
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {distinctStoreNames.map((name) => (
                      <div key={name} className="flex items-center gap-2 text-sm">
                        <span className="min-w-[8rem] truncate">{name}</span>
                        <span className="text-[var(--muted-foreground)]">→</span>
                        <select
                          className="flex-1 h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm"
                          value={storeMapping[name] ?? ""}
                          onChange={(e) => changeStoreMapping(name, e.target.value)}
                        >
                          <option value="">未指派</option>
                          {availableStores.map((s) => (
                            <option key={s.storeId} value={s.storeId}>
                              {s.storeName}
                              {s.isClosed ? "（已闭店）" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="border rounded-md max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--muted)] sticky top-0">
                  <tr className="text-left">
                    <th className="px-3 py-2 w-10"></th>
                    <th className="px-3 py-2 font-medium">单号</th>
                    <th className="px-3 py-2 font-medium">日期</th>
                    <th className="px-3 py-2 font-medium">门店</th>
                    <th className="px-3 py-2 font-medium text-right">金额</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const allowed = isAllowed(o)
                    const checked = selectedOrderNos.has(o.legacyOrderNo)
                    return (
                      <tr
                        key={o.legacyOrderNo}
                        className={`border-t ${allowed ? "" : "opacity-60"}`}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!allowed}
                            onChange={() => toggleOrder(o.legacyOrderNo, allowed)}
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{o.legacyOrderNo}</td>
                        <td className="px-3 py-2">{formatDate(o.saleDate)}</td>
                        <td className="px-3 py-2">{o.storeName ?? "—"}</td>
                        <td className="px-3 py-2 text-right">¥{o.amount.toFixed(2)}</td>
                        <td className="px-3 py-2">
                          {o.alreadyImported ? (
                            <Badge variant="secondary">已在 PG</Badge>
                          ) : !allowed ? (
                            <Badge variant="destructive">待选门店</Badge>
                          ) : (
                            <Badge variant="outline">可导入</Badge>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </>
          )}
        </div>
      )}

      <DialogFooter>
        {step === "preview" && (
          <Button
            variant="outline"
            onClick={() => {
              setStep("search")
              setPicked(null)
              setOrders([])
              setAvailableStores([])
              setStoreMapping({})
              setSelectedOrderNos(new Set())
            }}
            disabled={importing}
          >
            返回
          </Button>
        )}
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
          关闭
        </Button>
        {step === "preview" && orders.length > 0 && (
          <Button onClick={doImport} disabled={importing || selectedOrderNos.size === 0}>
            {importing ? "导入中…" : `导入选中 ${selectedOrderNos.size} 条`}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
