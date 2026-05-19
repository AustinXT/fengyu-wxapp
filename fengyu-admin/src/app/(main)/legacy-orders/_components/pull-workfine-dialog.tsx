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
} from "@/actions/legacy-orders"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可选：从 /customers/[id] 入口打开时预填的手机号；Dialog 首次打开自动触发搜索 */
  defaultPhone?: string
}

type Step = "search" | "preview"

function formatDate(s: string) {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
}

export default function PullWorkfineDialog({ open, onOpenChange, defaultPhone }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [step, setStep] = useState<Step>("search")
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [candidates, setCandidates] = useState<WorkfineCustomerCandidate[]>([])
  const [picked, setPicked] = useState<WorkfineCustomerCandidate | null>(null)

  const [loadingOrders, setLoadingOrders] = useState(false)
  const [orders, setOrders] = useState<WorkfineOrderPreview[]>([])
  const [selectedOrderNos, setSelectedOrderNos] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  // 重置 / 预填
  useEffect(() => {
    if (!open) return
    setStep("search")
    setCandidates([])
    setPicked(null)
    setOrders([])
    setSelectedOrderNos(new Set())
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
      toast.error(err instanceof Error ? err.message : "搜索失败")
    } finally {
      setSearching(false)
    }
  }

  async function pickCandidate(c: WorkfineCustomerCandidate) {
    setPicked(c)
    setLoadingOrders(true)
    setStep("preview")
    try {
      const res = await previewWorkfineOrders({ workfineCustomerId: c.customerId })
      setOrders(res.orders)
      // 默认勾选 alreadyImported=false 且 storeMatched=true 的行
      const defaultSel = new Set(
        res.orders
          .filter((o) => !o.alreadyImported && o.storeMatched)
          .map((o) => o.legacyOrderNo),
      )
      setSelectedOrderNos(defaultSel)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "预览失败")
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
      toast.error(err instanceof Error ? err.message : "导入失败")
    } finally {
      setImporting(false)
    }
  }

  const importableCount = orders.filter((o) => !o.alreadyImported && o.storeMatched).length

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
                    const allowed = !o.alreadyImported && o.storeMatched
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
                          ) : !o.storeMatched ? (
                            <Badge variant="destructive">门店未匹配</Badge>
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
