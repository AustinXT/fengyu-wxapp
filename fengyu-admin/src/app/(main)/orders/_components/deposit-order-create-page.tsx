"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { searchCustomers } from "@/actions/customers"
import { createDepositOrder } from "@/actions/orders"
import {
  getProductsByKind,
  type OrderPickerNormalGroup,
} from "@/actions/products"
import { formatPhoneSafe } from "@/lib/format"
import { actionErrorMessage } from "@/lib/action-error"
import type { Store, Customer, ProductSku, Product } from "@/lib/types"
import { NormalSkuPicker } from "./order-create/normal-sku-picker"
import type { CartItem } from "./order-create/types"


interface KindData {
  normalGroups: OrderPickerNormalGroup[]
}

export default function DepositOrderCreatePageClient({ stores }: { stores: Store[] }) {
  const router = useRouter()

  
  const [searchKeyword, setSearchKeyword] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Customer[]>([])
  const [searchDone, setSearchDone] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)

  
  const [kindData, setKindData] = useState<KindData | null>(null)
  const [prefetching, setPrefetching] = useState(false)

  
  const [cart, setCart] = useState<CartItem[]>([])
  
  const [receivedMap, setReceivedMap] = useState<Record<string, string>>({})

  
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
    } catch (err) {
      toast.error(actionErrorMessage(err, "搜索失败，请稍后重试"))
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
    setCart([])
    setReceivedMap({})
  }

  
  const storeId = selectedCustomer?.boundStoreId || null
  const storeName = useMemo(
    () => stores.find((s) => s.storeId === storeId)?.storeName || "",
    [stores, storeId],
  )
  const marketName = useMemo(
    () => stores.find((s) => s.storeId === storeId)?.marketName || "",
    [stores, storeId],
  )

  
  const loadProducts = useCallback(async () => {
    if (kindData) return
    setPrefetching(true)
    try {
      const result = await getProductsByKind("__normal__")
      if ("groups" in result) {
        setKindData({ normalGroups: result.groups })
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, "加载商品数据失败"))
    } finally {
      setPrefetching(false)
    }
  }, [kindData])

  
  useEffect(() => {
    if (selectedCustomer) loadProducts()
  }, [selectedCustomer, loadProducts])

  
  const addToCart = (product: Product, sku: ProductSku) => {
    setCart((prev) => {
      const idx = prev.findIndex((it) => it.sku.skuId === sku.skuId)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 }
        return next
      }
      return [...prev, { sku, product, quantity: 1 }]
    })
  }

  const removeFromCart = (skuId: string) => {
    setCart((prev) => prev.filter((it) => it.sku.skuId !== skuId))
    setReceivedMap((prev) => {
      const next = { ...prev }
      delete next[skuId]
      return next
    })
  }

  const updateQty = (skuId: string, qty: number) => {
    if (qty <= 0) {
      removeFromCart(skuId)
      return
    }
    setCart((prev) =>
      prev.map((it) => (it.sku.skuId === skuId ? { ...it, quantity: qty } : it)),
    )
  }

  
  const handleSubmit = async () => {
    if (!selectedCustomer) {
      toast.error("请先选择顾客")
      return
    }
    if (!storeId) {
      toast.error("顾客未绑定门店，无法开寄存单")
      return
    }
    if (cart.length === 0) {
      toast.error("请至少添加 1 个商品")
      return
    }
    setSubmitting(true)
    try {
      const res = await createDepositOrder({
        storeId,
        marketName,
        clientUserId: selectedCustomer.userId,
        remark: remark || null,
        items: cart.map((it) => ({
          skuId: it.sku.skuId,
          quantity: it.quantity,
          received: Math.max(0, Number(receivedMap[it.sku.skuId]) || 0),
        })),
      })
      if (res.success && res.saleOrderId) {
        toast.success(res.message)
        router.push(`/orders/${res.saleOrderId}`)
      } else {
        toast.error(res.message || "寄存单创建失败")
      }
    } catch (err) {
      toast.error(actionErrorMessage(err, "寄存单创建失败"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </Link>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">开寄存单</h1>
        </div>
      </div>

      {}
      <div className="rounded-[var(--radius)] bg-[#F3F4F6] border border-[#D1D5DB] px-4 py-3 text-sm text-[#6B7280]">
        寄存单用于把 WorkFine 上顾客的剩余次数初始化到小程序，不收款、不计入营业额分成 / 客单价统计（服务单提成正常参与分配）；可正常生成服务单核销次数。
        <br />
        <span className="text-xs">商品范围仅限"普通商品"；禁用：优惠券 / 储值卡 / 行级改价 / 体验卡 / 充值卡 / 组合套餐。</span>
      </div>

      {}
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

      {}
      {selectedCustomer && storeId && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">2. 选择商品（普通商品）</h2>

            {prefetching && <p className="text-sm text-[#999999]">加载商品数据…</p>}

            {!prefetching && kindData && (
              <NormalSkuPicker
                groups={kindData.normalGroups}
                kindLabel="普通商品"
                cart={cart}
                onAdd={addToCart}
              />
            )}

            {}
            {cart.length > 0 && (
              <>
                <Separator className="my-3" />
                <h3 className="text-sm font-semibold text-[var(--foreground)]">已选项目</h3>
                <div className="space-y-2">
                  {cart.map((it) => {
                    const sessionCount = it.sku.sessionCount
                    return (
                      <div
                        key={it.sku.skuId}
                        className="flex items-center justify-between gap-3 border border-[var(--border)] rounded-[var(--radius)] p-3"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">{it.sku.specName}</p>
                          <p className="text-xs text-[#999999]">
                            {it.sku.productType}
                            {sessionCount != null && ` · 每件 ${sessionCount} 次`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-[#999999] whitespace-nowrap">实收 ¥</span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0"
                            className="w-24"
                            value={receivedMap[it.sku.skuId] ?? ""}
                            onChange={(e) =>
                              setReceivedMap((prev) => ({ ...prev, [it.sku.skuId]: e.target.value }))
                            }
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => updateQty(it.sku.skuId, it.quantity - 1)}
                          >
                            −
                          </Button>
                          <span className="w-8 text-center">{it.quantity}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => updateQty(it.sku.skuId, it.quantity + 1)}
                          >
                            +
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[#D94040]"
                            onClick={() => removeFromCart(it.sku.skuId)}
                          >
                            移除
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-[#999999] mt-2">
                  共 {cart.length} 个 SKU；总次数 ={" "}
                  {cart.reduce(
                    (acc, it) =>
                      acc + (it.sku.sessionCount != null ? Number(it.sku.sessionCount) * it.quantity : 0),
                    0,
                  )}{" "}
                  次；合计实收 ¥
                  {cart
                    .reduce((acc, it) => acc + (Math.max(0, Number(receivedMap[it.sku.skuId]) || 0)), 0)
                    .toFixed(2)}
                  （仅记账，不计营业额）
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {}
      {selectedCustomer && cart.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">3. 备注与提交</h2>
            <Input
              placeholder="备注（可选）"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Link href="/orders">
                <Button variant="outline">取消</Button>
              </Link>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? "提交中…" : "确认寄存"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
