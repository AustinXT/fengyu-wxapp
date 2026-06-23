"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { searchCustomers } from "@/actions/customers"
import { createPrepaidInflow } from "@/actions/orders"
import { formatPhoneSafe } from "@/lib/format"
import type { Store, Customer } from "@/lib/types"

/**
 * 旧系统充值金转入页（admin）
 *
 * 把 WorkFine 顾客的充值金余额等额导入小程序储值卡：1:1、不打折、不限额、不计营业额。
 * 入账门店沿用顾客绑定门店（储值卡跨店通用，store_id 仅作订单归属）；转入即时到账。
 * 转入单本质是「充值单」，将来退款走员工端充值卡退款链路（与本页解耦）。
 */
export default function InflowOrderCreatePageClient({ stores }: { stores: Store[] }) {
  const router = useRouter()

  // ===== 顾客 =====
  const [searchKeyword, setSearchKeyword] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Customer[]>([])
  const [searchDone, setSearchDone] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)

  // ===== 金额 + 备注 + 提交 =====
  const [amount, setAmount] = useState("")
  const [remark, setRemark] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSearch = async () => {
    const kw = searchKeyword.trim()
    if (!kw) {
      toast.error("请输入姓名或手机号")
      return
    }
    setSearching(true)
    setSearchDone(false)
    setSelectedCustomer(null)
    setSearchResults([])
    try {
      const results = await searchCustomers(kw)
      setSearchResults(results)
      setSearchDone(true)
      if (results.length === 0) {
        toast.info("未找到已注册顾客，请引导顾客登录小程序并绑定门店")
      }
    } catch {
      toast.error("搜索失败，请稍后重试")
    } finally {
      setSearching(false)
    }
  }

  const selectCustomer = (c: Customer) => {
    setSelectedCustomer(c)
    setSearchResults([])
  }

  const clearCustomer = () => {
    setSelectedCustomer(null)
  }

  // 入账门店沿用顾客绑定门店（与寄存单同口径）
  const storeId = selectedCustomer?.boundStoreId || null
  const storeName = useMemo(
    () => stores.find((s) => s.storeId === storeId)?.storeName || "",
    [stores, storeId],
  )

  const amountNum = Number(amount)
  const amountValid =
    Number.isFinite(amountNum) && amountNum > 0 && Math.abs(Math.round(amountNum * 100) - amountNum * 100) <= 1e-6

  const handleSubmit = async () => {
    if (!selectedCustomer) {
      toast.error("请先选择顾客")
      return
    }
    if (!storeId) {
      toast.error("顾客未绑定门店，无法转入")
      return
    }
    if (!amountValid) {
      toast.error("请输入有效转入金额（最多 2 位小数）")
      return
    }
    setSubmitting(true)
    try {
      const res = await createPrepaidInflow({
        clientUserId: selectedCustomer.userId,
        storeId,
        amount: amountNum,
        remark: remark.trim() || null,
      })
      if (res.success && res.saleOrderId) {
        toast.success(res.message)
        router.push(`/orders/${res.saleOrderId}`)
      } else {
        toast.error(res.message || "转入失败")
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "转入失败"
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">充值金转入</h1>
        </div>
      </div>

      {/* 提示 banner */}
      <div className="rounded-[var(--radius)] bg-[#F3F4F6] border border-[#D1D5DB] px-4 py-3 text-sm text-[#6B7280]">
        充值金转入用于把旧系统（WorkFine）顾客的充值金余额等额导入小程序储值卡，按 1:1 录入、不打折、不限额、不计入营业额 / 提成。
        <br />
        <span className="text-xs">
          转入即时到账，订单类型为「充值卡」并标记「旧系统充值金转入」；转入后可像普通储值卡余额一样消费、退款（退款在员工端发起）。
        </span>
      </div>

      {/* Section 1: 选择顾客 */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">1. 选择顾客</h2>
          {!selectedCustomer ? (
            <>
              <div className="flex gap-2">
                <Input
                  placeholder="输入顾客姓名或手机号"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSearch()
                  }}
                />
                <Button onClick={handleSearch} disabled={searching}>
                  {searching ? "搜索中…" : "搜索"}
                </Button>
              </div>
              {searchDone && searchResults.length > 0 && (
                <div className="border border-[var(--border)] rounded-[var(--radius)] divide-y divide-[var(--border)]">
                  {searchResults.map((c) => (
                    <button
                      key={c.userId}
                      type="button"
                      onClick={() => selectCustomer(c)}
                      className="w-full text-left p-3 hover:bg-[var(--muted)] transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium">{c.name || "未命名"}</span>
                          <span className="ml-3 text-sm text-[#999999]">{formatPhoneSafe(c.phone)}</span>
                        </div>
                        <div className="text-xs text-[#999999]">
                          {c.storeName || "未绑定门店"}
                          {c.memberLevel && <span className="ml-2">· {c.memberLevel}</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between bg-[var(--muted)] rounded-[var(--radius)] p-3">
              <div>
                <span className="font-medium">{selectedCustomer.name || "未命名"}</span>
                <span className="ml-3 text-sm text-[#999999]">{formatPhoneSafe(selectedCustomer.phone)}</span>
                <span className="ml-3 text-xs text-[#999999]">门店：{storeName || "未绑定"}</span>
                {selectedCustomer.memberLevel && (
                  <span className="ml-3 text-xs text-[#999999]">等级：{selectedCustomer.memberLevel}</span>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={clearCustomer}>
                重新选择
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: 金额 + 备注 + 提交 */}
      {selectedCustomer && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">2. 转入金额</h2>
            {!storeId && (
              <p className="text-sm text-[#D94040]">该顾客未绑定门店，无法转入。请先引导顾客绑定门店。</p>
            )}
            <div className="flex items-center gap-2">
              <span className="text-sm text-[#999999]">¥</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="输入旧系统充值金余额"
                className="w-48"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {amount && !amountValid && (
                <span className="text-xs text-[#D94040]">金额无效（须 &gt; 0，最多 2 位小数）</span>
              )}
            </div>
            <Input
              placeholder="备注（可选，如旧系统账号 / 迁移说明）"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              maxLength={100}
            />
            <p className="text-xs text-[#999999]">
              按旧系统余额 1:1 等额录入（如旧系统余额 3680.5 即转入 ¥3680.5），不打折、不限额。
            </p>
            <div className="flex justify-end gap-2">
              <Link href="/orders">
                <Button variant="outline">取消</Button>
              </Link>
              <Button onClick={handleSubmit} disabled={submitting || !storeId || !amountValid}>
                {submitting ? "转入中…" : `确认转入${amountValid ? ` ¥${amountNum}` : ""}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
