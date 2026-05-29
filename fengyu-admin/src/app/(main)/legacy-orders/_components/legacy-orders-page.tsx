"use client"

import { Fragment, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Pagination } from "@/components/ui/pagination"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  approveLegacyOrder,
  batchApproveLegacyOrders,
  rejectLegacyOrder,
  updateLegacyOrderAmount,
  updateLegacyOrderPhone,
  type LegacyOrderRow,
} from "@/actions/legacy-orders"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { formatPhoneSafe } from "@/lib/format"
import PullWorkfineDialog from "./pull-workfine-dialog"
import { formatDateTime as fmtDateTime } from "@/lib/utils"

function formatDateTime(dt: string | null | undefined) {
  if (!dt) return "—"
  return fmtDateTime(dt)
}

interface Props {
  orders: LegacyOrderRow[]
  total: number
  stores: Array<{ storeId: string; storeName: string }>
  canPull?: boolean
}

export default function LegacyOrdersPageClient({ orders, total, stores, canPull = false }: Props) {
  const router = useRouter()
  const { get, set, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()

  const page = Number(get("page") || 1)
  const pageSize = Number(get("size") || 20)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [approveTarget, setApproveTarget] = useState<LegacyOrderRow | null>(null)
  const [rejectTarget, setRejectTarget] = useState<LegacyOrderRow | null>(null)
  const [phoneTarget, setPhoneTarget] = useState<LegacyOrderRow | null>(null)
  const [newPhone, setNewPhone] = useState("")
  const [amountTarget, setAmountTarget] = useState<LegacyOrderRow | null>(null)
  const [newAmount, setNewAmount] = useState("")
  const [batchOpen, setBatchOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [pullOpen, setPullOpen] = useState(false)

  const allOnPageSelected = useMemo(
    () => orders.length > 0 && orders.every((o) => selected.has(o.saleOrderId)),
    [orders, selected],
  )

  const refreshAndClear = () => {
    setSelected(new Set())
    router.refresh()
  }

  const handleApprove = async () => {
    if (!approveTarget) return
    setPending(true)
    try {
      const res = await approveLegacyOrder(approveTarget.saleOrderId, approveTarget.updatedAt)
      if (res.clientUserId) {
        toast.success(`已通过；顾客标签已重算 (user_id: ${res.clientUserId.slice(0, 8)}...)`)
      } else {
        toast.success("已通过（未匹配顾客，跳过标签重算）")
      }
      refreshAndClear()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "通过失败")
    } finally {
      setPending(false)
      setApproveTarget(null)
    }
  }

  const handleReject = async () => {
    if (!rejectTarget) return
    setPending(true)
    try {
      await rejectLegacyOrder(rejectTarget.saleOrderId, rejectTarget.updatedAt)
      toast.success("已作废")
      refreshAndClear()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "作废失败")
    } finally {
      setPending(false)
      setRejectTarget(null)
    }
  }

  const handleUpdatePhone = async () => {
    if (!phoneTarget || !newPhone.trim()) return
    setPending(true)
    try {
      const res = await updateLegacyOrderPhone(
        phoneTarget.saleOrderId,
        newPhone.trim(),
        phoneTarget.updatedAt,
      )
      if (res.matchedUserId) {
        toast.success(`已更新；自动匹配到顾客 ${res.matchedUserId.slice(0, 8)}...`)
      } else {
        toast.success("已更新手机号（暂无小程序顾客匹配）")
      }
      refreshAndClear()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败")
    } finally {
      setPending(false)
      setPhoneTarget(null)
      setNewPhone("")
    }
  }

  const handleUpdateAmount = async () => {
    if (!amountTarget) return
    const parsed = Number(newAmount)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error("请输入大于 0 的金额")
      return
    }
    setPending(true)
    try {
      const res = await updateLegacyOrderAmount(
        amountTarget.saleOrderId,
        parsed,
        amountTarget.updatedAt,
      )
      toast.success(`金额已更新：¥${res.from} → ¥${res.to}（核对通过后才重算标签）`)
      refreshAndClear()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败")
    } finally {
      setPending(false)
      setAmountTarget(null)
      setNewAmount("")
    }
  }

  const handleBatchApprove = async () => {
    if (selected.size === 0) return
    setPending(true)
    try {
      const items = orders
        .filter((o) => selected.has(o.saleOrderId))
        .map((o) => ({ saleOrderId: o.saleOrderId, expectedUpdatedAt: o.updatedAt }))
      const res = await batchApproveLegacyOrders(items)
      toast.success(`批量通过成功 ${res.approvedCount} 条；影响 ${res.affectedUserIds.length} 位顾客`)
      refreshAndClear()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批量通过失败")
    } finally {
      setPending(false)
      setBatchOpen(false)
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allOnPageSelected) {
        const next = new Set(prev)
        orders.forEach((o) => next.delete(o.saleOrderId))
        return next
      }
      const next = new Set(prev)
      orders.forEach((o) => next.add(o.saleOrderId))
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">历史订单核对</h1>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-sm text-[#999999]">
            顾客到店登录后，按手机号筛选并核对 4 字段（金额/日期/门店/手机号）
          </span>
          {canPull && (
            <Button size="sm" onClick={() => setPullOpen(true)}>
              拉取顾客历史
            </Button>
          )}
        </div>
      </div>

      <PullWorkfineDialog open={pullOpen} onOpenChange={setPullOpen} />

      {/* 筛选 */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Input
              placeholder="手机号 / 顾客姓名"
              defaultValue={get("q")}
              onBlur={(e) => set("q", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  set("q", (e.target as HTMLInputElement).value)
                }
              }}
            />
            <select
              className="h-9 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
              value={get("store")}
              onChange={(e) => setMany({ store: e.target.value, page: "" })}
            >
              <option value="">全部门店</option>
              {stores.map((s) => (
                <option key={s.storeId} value={s.storeId}>
                  {s.storeName}
                </option>
              ))}
            </select>
            <Input
              type="date"
              defaultValue={get("from")}
              onChange={(e) => setMany({ from: e.target.value, page: "" })}
            />
            <Input
              type="date"
              defaultValue={get("to")}
              onChange={(e) => setMany({ to: e.target.value, page: "" })}
            />
            <select
              className="h-9 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
              value={get("matched")}
              onChange={(e) => setMany({ matched: e.target.value, page: "" })}
            >
              <option value="">匹配状态 (全部)</option>
              <option value="matched">已匹配小程序顾客</option>
              <option value="unmatched">未匹配</option>
            </select>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMany({ q: "", store: "", from: "", to: "", matched: "", page: "" })
              }}
            >
              重置筛选
            </Button>
            {selected.size > 0 && (
              <Button size="sm" onClick={() => setBatchOpen(true)}>
                批量通过 ({selected.size})
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 表格 */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-3 text-left font-medium text-gray-500 w-10">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">手机号</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客姓名</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">门店</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">金额</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">销售日期</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-500">小程序匹配</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-[#999999]">
                      未找到匹配的未审核订单
                    </td>
                  </tr>
                )}
                {orders.map((o) => (
                  <Fragment key={o.saleOrderId}>
                    <tr
                      className="hover:bg-[#FFF0EE] transition-colors cursor-pointer"
                      onClick={() => setExpandedId(expandedId === o.saleOrderId ? null : o.saleOrderId)}
                    >
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(o.saleOrderId)}
                          onChange={() => toggleSelect(o.saleOrderId)}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono">{formatPhoneSafe(o.clientPhone) || "—"}</td>
                      <td className="px-4 py-3">{o.customerName || o.clientName || "—"}</td>
                      <td className="px-4 py-3">{o.storeName || "—"}</td>
                      <td className="px-4 py-3 text-right font-medium">
                        ¥ {Number(o.totalAmount).toFixed(2)}
                        {(() => {
                          const snap = o.legacyRawSnapshot as { original_amount?: number | string } | null
                          const orig = snap?.original_amount
                          if (orig === undefined || orig === null) return null
                          return (
                            <div className="text-[10px] text-[#999999] line-through font-normal">
                              原 ¥ {Number(orig).toFixed(2)}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="px-4 py-3 text-[#999999]">{formatDateTime(o.saleOrderDatetime)}</td>
                      <td className="px-4 py-3 text-center">
                        {o.hasMiniprogramAccount ? (
                          <span className="text-[#3D8A5A]">✓ 已匹配</span>
                        ) : (
                          <span className="text-[#D94040]">✗ 未匹配</span>
                        )}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setApproveTarget(o)}
                            disabled={pending}
                          >
                            通过
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[#D94040]"
                            onClick={() => setRejectTarget(o)}
                            disabled={pending}
                          >
                            作废
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAmountTarget(o)
                              setNewAmount(String(Number(o.totalAmount).toFixed(2)))
                            }}
                            disabled={pending}
                          >
                            改金额
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setPhoneTarget(o)
                              setNewPhone(o.clientPhone ?? "")
                            }}
                            disabled={pending}
                          >
                            改手机号
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === o.saleOrderId && (
                      <tr className="bg-gray-50">
                        <td colSpan={8} className="px-4 py-3 text-xs text-[#666666]">
                          <div className="font-medium mb-1">原始 WorkFine 抓取快照：</div>
                          <pre className="whitespace-pre-wrap break-all bg-white p-3 rounded border border-gray-200">
                            {JSON.stringify(o.legacyRawSnapshot, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-200">
            <Pagination
              total={total}
              page={page}
              pageSize={pageSize}
              onPageChange={(p) => startTransition(() => set("page", String(p)))}
              pageSizeOptions={[10, 20, 50, 100]}
              onPageSizeChange={(s) =>
                startTransition(() => setMany({ size: String(s), page: "" }))
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* 通过确认 */}
      <AlertDialog open={!!approveTarget} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <AlertDialogTitle>确认通过核对？</AlertDialogTitle>
        <AlertDialogDescription>
          确认 WorkFine 历史订单数据无误（金额、日期、门店、手机号匹配该顾客）。通过后订单 status 将变为
          已支付，顾客的 customer_type / spending_tier / member_level 会立即重算。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setApproveTarget(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={handleApprove}>确认通过</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 作废确认 */}
      <AlertDialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <AlertDialogTitle>确认作废这条历史订单？</AlertDialogTitle>
        <AlertDialogDescription>
          作废后订单 status 将变为已作废，不再参与任何统计。仅在确认 WorkFine 数据本身错误时使用
          （如重复录入、金额错误无法核对）。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setRejectTarget(null)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={handleReject} className="bg-[#D94040]">
            确认作废
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 改手机号 */}
      <Dialog open={!!phoneTarget} onOpenChange={(open) => !open && setPhoneTarget(null)}>
        <DialogHeader>
          <DialogTitle>修改手机号（WorkFine 错填修正）</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <label className="text-sm text-[#666666]">
            原手机号：{phoneTarget?.clientPhone || "—"}
          </label>
          <Input
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            placeholder="新的 11 位手机号"
          />
          <p className="text-xs text-[#999999]">
            更新后系统将自动按新手机号匹配小程序顾客并回填 client_user_id。
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setPhoneTarget(null)
              setNewPhone("")
            }}
          >
            取消
          </Button>
          <Button onClick={handleUpdatePhone} disabled={pending}>
            确认更新
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 改金额 */}
      <Dialog open={!!amountTarget} onOpenChange={(open) => !open && setAmountTarget(null)}>
        <DialogHeader>
          <DialogTitle>修改订单金额（WorkFine 错填修正）</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <label className="text-sm text-[#666666]">
            当前金额：¥ {amountTarget ? Number(amountTarget.totalAmount).toFixed(2) : "—"}
          </label>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={newAmount}
            onChange={(e) => setNewAmount(e.target.value)}
            placeholder="新金额"
          />
          <p className="text-xs text-[#999999]">
            修改后将保留 WorkFine 原始金额到 legacy_raw_snapshot.original_amount（仅首次修改写入）。
            <br />
            <strong>不</strong>会立即重算顾客标签 / 等级 — 核对通过后才统一重算。
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setAmountTarget(null)
              setNewAmount("")
            }}
          >
            取消
          </Button>
          <Button onClick={handleUpdateAmount} disabled={pending}>
            确认更新
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 批量通过 */}
      <AlertDialog open={batchOpen} onOpenChange={setBatchOpen}>
        <AlertDialogTitle>批量通过 {selected.size} 条历史订单？</AlertDialogTitle>
        <AlertDialogDescription>
          全部成功才提交（事务内逐条 CAS），任一冲突则整批回滚。涉及顾客的标签会逐一重算。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setBatchOpen(false)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={handleBatchApprove}>确认批量通过</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
