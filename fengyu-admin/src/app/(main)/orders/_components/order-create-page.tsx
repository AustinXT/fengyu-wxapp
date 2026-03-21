"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { searchCustomerByPhone } from "@/actions/customers"
import { createOrder, confirmOfflinePayment, generateOrderWxacode } from "@/actions/orders"
import { getAvailableCoupons } from "@/actions/coupons"
import { formatDate } from "@/lib/utils"
import type { ProductCategory, Product, ProductSku, Store, Employee, Customer, AvailableCoupon, ProductKind } from "@/lib/types"

const PRODUCT_KINDS: ProductKind[] = ["福利活动", "护理项目", "家居产品", "充值卡"]

const KIND_COLORS: Record<ProductKind, string> = {
  "福利活动": "bg-[#FFF8E6] text-[#D4820A]",
  "护理项目": "bg-[#F0F5FA] text-[#5E8BB3]",
  "家居产品": "bg-[#F0F9F2] text-[#3D8A5A]",
  "充值卡": "bg-[#F5F5F5] text-[#888888]",
}

interface CartItem {
  sku: ProductSku
  product: Product
  quantity: number
}

interface ItemPriceOverride {
  saleAmount: string | null
  received: string | null
  receivedTouched: boolean
}

function getItemAmounts(item: CartItem, override?: ItemPriceOverride) {
  const defaultUnitPrice = item.sku.specialPrice
    ? Number(item.sku.specialPrice)
    : Number(item.sku.price)
  const defaultSaleAmount = defaultUnitPrice * item.quantity

  const saleAmount = override?.saleAmount != null && override.saleAmount !== ''
    ? Number(override.saleAmount)
    : defaultSaleAmount

  const received = override?.received != null && override.received !== ''
    ? Number(override.received)
    : saleAmount

  return { defaultUnitPrice, defaultSaleAmount, saleAmount, received }
}

const steps = ["选择顾客", "选择商品", "确认订单", "完成"]

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, idx) => (
        <div key={label} className="flex items-center gap-2">
          <div className={`flex items-center justify-center h-8 w-8 rounded-full text-sm font-medium ${
            idx < current ? "bg-[#3D8A5A] text-white" :
            idx === current ? "bg-[var(--primary)] text-white" :
            "bg-gray-200 text-[#999999]"
          }`}>
            {idx < current ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
            ) : (
              idx + 1
            )}
          </div>
          <span className={`text-sm hidden sm:inline ${idx === current ? "text-[var(--foreground)] font-medium" : "text-[#999999]"}`}>
            {label}
          </span>
          {idx < steps.length - 1 && <div className="w-8 h-px bg-gray-300" />}
        </div>
      ))}
    </div>
  )
}

export default function OrderCreatePageClient({
  categories,
  products,
  skus,
  stores,
  employees,
}: {
  categories: ProductCategory[]
  products: Product[]
  skus: ProductSku[]
  stores: Store[]
  employees: Employee[]
}) {
  const [step, setStep] = useState(0)
  const [phone, setPhone] = useState("")
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(categories[0]?.categoryId || "")
  const [expandedKind, setExpandedKind] = useState<ProductKind | "">(
    () => categories.find(c => c.categoryId === (categories[0]?.categoryId))?.productKind || ""
  )

  const categoriesByKind = useMemo(() => {
    const groups: Partial<Record<ProductKind, ProductCategory[]>> = {}
    for (const kind of PRODUCT_KINDS) {
      const filtered = categories.filter(c => c.productKind === kind)
      if (filtered.length > 0) groups[kind] = filtered
    }
    return groups
  }, [categories])
  const [cart, setCart] = useState<CartItem[]>([])
  const [orderType, setOrderType] = useState<'普通' | '体验' | '内部' | '福利活动'>("普通")
  const [paymentMethod, setPaymentMethod] = useState("wechat")
  const [selectedStoreId, setSelectedStoreId] = useState<string>(stores[0]?.storeId || "")
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("")
  const [searching, setSearching] = useState(false)
  const [remark, setRemark] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [createdOrderId, setCreatedOrderId] = useState<string>("")
  const [searchDone, setSearchDone] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)
  const [availableCoupons, setAvailableCoupons] = useState<AvailableCoupon[]>([])
  const [selectedCouponId, setSelectedCouponId] = useState<string>("")
  const [loadingCoupons, setLoadingCoupons] = useState(false)
  const [priceOverrides, setPriceOverrides] = useState<Record<string, ItemPriceOverride>>({})

  const searchCustomer = async () => {
    if (!phone.trim() || !/^1\d{10}$/.test(phone.trim())) {
      toast.error("请输入正确的手机号")
      return
    }
    setSearching(true)
    setSearchDone(false)
    try {
      const result = await searchCustomerByPhone(phone.trim())
      setSelectedCustomer(result)
      setSearchDone(true)
      if (result) {
        // 自动默认顾客绑定的门店和美容师
        if (result.boundStoreId && stores.some(s => s.storeId === result.boundStoreId)) {
          setSelectedStoreId(result.boundStoreId)
        }
        if (result.boundEmployeeId && employees.some(e => e.employeeId === result.boundEmployeeId && !e.isResigned)) {
          setSelectedEmployeeId(result.boundEmployeeId)
        }
      } else {
        toast.info("未找到该手机号对应的顾客，可直接使用手机号开单")
      }
    } catch {
      toast.error("搜索失败，请稍后重试")
    } finally {
      setSearching(false)
    }
  }

  const categoryProducts = products.filter((p) => p.categoryId === selectedCategoryId)

  const addToCart = (product: Product, sku: ProductSku) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.sku.skuId === sku.skuId)
      if (existing) {
        return prev.map((i) =>
          i.sku.skuId === sku.skuId ? { ...i, quantity: i.quantity + 1 } : i
        )
      }
      return [...prev, { sku, product, quantity: 1 }]
    })
  }

  const removeFromCart = (skuId: string) => {
    setCart((prev) => prev.filter((i) => i.sku.skuId !== skuId))
  }

  const updateCartQuantity = (skuId: string, delta: number) => {
    setCart((prev) =>
      prev.reduce<CartItem[]>((acc, item) => {
        if (item.sku.skuId !== skuId) {
          acc.push(item)
        } else {
          const newQty = item.quantity + delta
          if (newQty > 0) acc.push({ ...item, quantity: newQty })
          // newQty <= 0 时自动移除
        }
        return acc
      }, [])
    )
  }

  // 门店切换时，清除不属于该门店的美容师选择
  useEffect(() => {
    if (selectedEmployeeId && selectedStoreId) {
      const emp = employees.find(e => e.employeeId === selectedEmployeeId)
      if (emp && emp.storeId !== selectedStoreId) {
        setSelectedEmployeeId("")
      }
    }
  }, [selectedStoreId, selectedEmployeeId, employees])

  // 原价合计（用于购物车显示，不含手动覆盖）
  const catalogTotal = cart.reduce((sum, item) => {
    const price = item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)
    return sum + price * item.quantity
  }, 0)

  // 应付合计 & 实付合计（含手动覆盖）
  const { totalSaleAmount, totalReceived } = useMemo(() => {
    let sa = 0, rc = 0
    for (const item of cart) {
      const amounts = getItemAmounts(item, priceOverrides[item.sku.skuId])
      sa += amounts.saleAmount
      rc += amounts.received
    }
    return { totalSaleAmount: sa, totalReceived: rc }
  }, [cart, priceOverrides])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新建订单</h1>
      </div>

      <StepIndicator current={step} />

      {/* Step 1: 选择顾客 */}
      {step === 0 && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h2 className="text-base font-semibold">搜索顾客</h2>
            <div className="flex gap-2">
              <Input
                placeholder="输入手机号搜索"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-64"
              />
              <Button onClick={searchCustomer} loading={searching}>搜索</Button>
            </div>
            {selectedCustomer && (
              <Card className="bg-[#FAFAFA]">
                <CardContent className="p-4">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                    <div>
                      <span className="text-[#999999]">姓名</span>
                      <p className="font-medium">{selectedCustomer.name || "-"}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">手机</span>
                      <p className="font-medium">{selectedCustomer.phone}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">会员等级</span>
                      <p className="font-medium">{selectedCustomer.memberLevel || "-"}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">绑定门店</span>
                      <p className="font-medium">{selectedCustomer.storeName || "-"}</p>
                    </div>
                    <div>
                      <span className="text-[#999999]">绑定美容师</span>
                      <p className="font-medium">{selectedCustomer.employeeName || "-"}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
            {searchDone && !selectedCustomer && (
              <Card className="bg-[#FFF8E6] border-[#D4820A]">
                <CardContent className="p-4 text-sm">
                  <p className="text-[#D4820A] font-medium">未找到已注册顾客</p>
                  <p className="text-[#999999] mt-1">将使用手机号 {phone} 开单，顾客后续注册绑定手机号后历史订单会自动关联</p>
                </CardContent>
              </Card>
            )}
            <div className="flex justify-end">
              <Button onClick={() => setStep(1)} disabled={!searchDone && !selectedCustomer}>下一步</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: 选择商品 */}
      {step === 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Category nav — 二级分类 */}
          <Card className="lg:col-span-1">
            <CardContent className="p-3">
              <h3 className="text-sm font-semibold text-[#999999] mb-2">商品分类</h3>
              <div className="space-y-0.5">
                {PRODUCT_KINDS.map((kind) => {
                  const kindCategories = categoriesByKind[kind]
                  if (!kindCategories) return null
                  const isExpanded = expandedKind === kind
                  return (
                    <div key={kind}>
                      <button
                        onClick={() => setExpandedKind(isExpanded ? "" : kind)}
                        className="w-full text-left px-3 py-2 rounded text-sm flex items-center justify-between hover:bg-gray-50 transition-colors"
                      >
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${KIND_COLORS[kind]}`}>
                          {kind}
                        </span>
                        <svg
                          width="12" height="12" viewBox="0 0 12 12"
                          className={`text-[#999999] transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        >
                          <path d="M4.5 3L7.5 6L4.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      {isExpanded && (
                        <div className="ml-3 space-y-0.5 mt-0.5">
                          {kindCategories.map((cat) => (
                            <button
                              key={cat.categoryId}
                              onClick={() => setSelectedCategoryId(cat.categoryId)}
                              className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                                selectedCategoryId === cat.categoryId
                                  ? "bg-[var(--primary)] text-white"
                                  : "hover:bg-[#FFF0EE] text-[var(--foreground)]"
                              }`}
                            >
                              {cat.categoryName}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Products */}
          <div className="lg:col-span-3 space-y-4">
            <Card>
              <CardContent className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {categoryProducts.map((product) => {
                    const productSkus = skus.filter((s) => s.productId === product.productId)
                    return (
                      <Card key={product.productId} className="bg-[#FAFAFA]">
                        <CardContent className="p-4 space-y-2">
                          <div className="flex justify-between items-start">
                            <h4 className="font-medium text-sm">{product.name}</h4>
                            <span className="text-xs text-[#999999]">¥{product.price}</span>
                          </div>
                          <p className="text-xs text-[#999999] line-clamp-2">{product.description}</p>
                          <Separator />
                          <div className="space-y-1">
                            {productSkus.map((sku) => (
                              <div key={sku.skuId} className="flex items-center justify-between">
                                <span className="text-xs">
                                  {sku.specName}
                                  <span className="text-[#999999] ml-1">
                                    ¥{sku.specialPrice || sku.price}
                                  </span>
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => addToCart(product, sku)}
                                  className="h-6 text-xs px-2"
                                >
                                  加入
                                </Button>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
                  {categoryProducts.length === 0 && (
                    <p className="text-sm text-[#999999] py-8 text-center col-span-2">该分类暂无商品</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Cart */}
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">
                  购物车 <span className="text-[#999999]">({cart.length} 件)</span>
                </h3>
                {cart.length > 0 ? (
                  <div className="space-y-2">
                    {cart.map((item) => {
                      const unitPrice = item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)
                      return (
                        <div key={item.sku.skuId} className="flex items-center justify-between bg-[#FAFAFA] rounded px-3 py-2 text-sm">
                          <div className="flex-1 min-w-0">
                            <span className="font-medium">{item.product.name}</span>
                            <span className="text-[#999999] ml-2">{item.sku.specName}</span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <div className="flex items-center border border-[var(--border)] rounded">
                              <button
                                onClick={() => updateCartQuantity(item.sku.skuId, -1)}
                                className="w-7 h-7 flex items-center justify-center text-[#666666] hover:bg-gray-100 rounded-l transition-colors"
                              >
                                −
                              </button>
                              <span className="w-8 text-center text-sm font-medium">{item.quantity}</span>
                              <button
                                onClick={() => updateCartQuantity(item.sku.skuId, 1)}
                                className="w-7 h-7 flex items-center justify-center text-[#666666] hover:bg-gray-100 rounded-r transition-colors"
                              >
                                +
                              </button>
                            </div>
                            <span className="font-medium w-20 text-right">
                              ¥{(unitPrice * item.quantity).toLocaleString()}
                            </span>
                            <button onClick={() => removeFromCart(item.sku.skuId)} className="text-[#D94040] text-xs hover:underline">
                              删除
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    <div className="text-right font-bold text-lg pt-2">
                      合计: ¥{catalogTotal.toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[#999999] text-center py-4">请从上方添加商品</p>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(0)}>上一步</Button>
              <Button
                onClick={async () => {
                  setStep(2)
                  setSelectedCouponId("")
                  // 如果是已注册顾客，拉取可用优惠券
                  if (selectedCustomer?.userId) {
                    setLoadingCoupons(true)
                    try {
                      const coupons = await getAvailableCoupons(selectedCustomer.userId, catalogTotal, selectedStoreId || undefined)
                      setAvailableCoupons(coupons)
                    } catch {
                      setAvailableCoupons([])
                    } finally {
                      setLoadingCoupons(false)
                    }
                  } else {
                    setAvailableCoupons([])
                  }
                }}
                disabled={cart.length === 0}
              >
                下一步
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: 确认订单 */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <h2 className="text-base font-semibold">确认订单</h2>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#999999]">顾客</label>
                <p className="font-medium">{selectedCustomer?.name || phone}</p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">订单类型</label>
                <Select className="mt-1" value={orderType} onChange={(e) => setOrderType(e.target.value as '普通' | '体验' | '内部' | '福利活动')}>
                  <option value="普通">普通</option>
                  <option value="体验">体验</option>
                  <option value="内部">内部</option>
                  <option value="福利活动">福利活动</option>
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">支付方式</label>
                <Select className="mt-1" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="wechat">微信支付</option>
                  <option value="alipay">支付宝</option>
                  <option value="offline">线下支付</option>
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">门店</label>
                <Select className="mt-1" value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)}>
                  {stores.map((s) => (
                    <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">指定美容师（可选）</label>
                <Select className="mt-1" value={selectedEmployeeId} onChange={(e) => setSelectedEmployeeId(e.target.value)}>
                  <option value="">不指定</option>
                  {employees.filter((e) => !e.isResigned && (!selectedStoreId || e.storeId === selectedStoreId)).map((e) => (
                    <option key={e.employeeId} value={e.employeeId}>{e.name} ({e.positionName})</option>
                  ))}
                </Select>
              </div>
              <div className="col-span-2 md:col-span-3">
                <label className="text-sm text-[#999999]">备注（可选）</label>
                <Input
                  className="mt-1"
                  placeholder="订单备注"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                />
              </div>

              {/* 优惠券（仅已注册顾客可选） */}
              {selectedCustomer?.userId && (
                <div className="col-span-2 md:col-span-3">
                  <label className="text-sm text-[#999999]">优惠券（可选）</label>
                  {loadingCoupons ? (
                    <p className="text-sm text-[#999999] mt-1">正在加载可用优惠券…</p>
                  ) : availableCoupons.length > 0 ? (
                    <Select
                      className="mt-1"
                      value={selectedCouponId}
                      onChange={(e) => setSelectedCouponId(e.target.value)}
                    >
                      <option value="">不使用优惠券</option>
                      {availableCoupons.map((c) => (
                        <option key={c.couponId} value={c.couponId}>
                          {c.name} — 优惠¥{c.discountAmount}（到期 {formatDate(c.expireAt)}）
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p className="text-sm text-[#999999] mt-1">暂无可用优惠券</p>
                  )}
                </div>
              )}
            </div>

            <Separator />

            <div>
              <h3 className="text-sm font-semibold mb-3">商品清单</h3>
              {/* 表头 */}
              <div className="grid grid-cols-12 gap-2 text-xs text-[#999999] px-3 mb-1">
                <span className="col-span-3">商品规格</span>
                <span className="col-span-1 text-center">数量</span>
                <span className="col-span-2 text-right">原价小计</span>
                <span className="col-span-2 text-right">应付金额</span>
                <span className="col-span-2 text-right">实付金额</span>
                <span className="col-span-2 text-center">操作</span>
              </div>
              <div className="space-y-2">
                {cart.map((item) => {
                  const override = priceOverrides[item.sku.skuId]
                  const amounts = getItemAmounts(item, override)
                  const hasOverride = override?.saleAmount != null || override?.received != null

                  return (
                    <div key={item.sku.skuId} className="grid grid-cols-12 gap-2 items-center bg-[#FAFAFA] rounded px-3 py-2 text-sm">
                      <span className="col-span-3 truncate" title={`${item.product.name} - ${item.sku.specName}`}>
                        {item.product.name} - {item.sku.specName}
                      </span>
                      <span className="col-span-1 text-center">{item.quantity}</span>
                      <span className="col-span-2 text-right text-[#999999]">
                        ¥{amounts.defaultSaleAmount.toFixed(2)}
                      </span>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          className="h-8 text-sm text-right"
                          value={override?.saleAmount ?? amounts.defaultSaleAmount.toFixed(2)}
                          onChange={(e) => {
                            const val = e.target.value
                            setPriceOverrides(prev => ({
                              ...prev,
                              [item.sku.skuId]: {
                                saleAmount: val,
                                received: prev[item.sku.skuId]?.receivedTouched ? (prev[item.sku.skuId]?.received ?? null) : null,
                                receivedTouched: prev[item.sku.skuId]?.receivedTouched ?? false,
                              }
                            }))
                          }}
                        />
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          className="h-8 text-sm text-right"
                          value={override?.received ?? amounts.saleAmount.toFixed(2)}
                          onChange={(e) => {
                            setPriceOverrides(prev => ({
                              ...prev,
                              [item.sku.skuId]: {
                                saleAmount: prev[item.sku.skuId]?.saleAmount ?? null,
                                received: e.target.value,
                                receivedTouched: true,
                              }
                            }))
                          }}
                        />
                      </div>
                      <div className="col-span-2 flex justify-center">
                        {hasOverride && (
                          <button
                            className="text-xs text-[#5E8BB3] hover:underline"
                            onClick={() => {
                              setPriceOverrides(prev => {
                                const next = { ...prev }
                                delete next[item.sku.skuId]
                                return next
                              })
                            }}
                          >
                            重置
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* 金额汇总 */}
              {(() => {
                const selectedCoupon = availableCoupons.find((c) => c.couponId === selectedCouponId)
                const couponDiscount = selectedCoupon ? Number(selectedCoupon.discountAmount) : 0
                const finalAmount = Math.max(0, totalReceived - couponDiscount)
                return (
                  <div className="text-right pt-4 space-y-1">
                    <div className="text-sm text-[#999999]">
                      应付合计: ¥{totalSaleAmount.toFixed(2)}
                    </div>
                    {totalReceived !== totalSaleAmount && (
                      <div className="text-sm text-[#999999]">
                        实付合计: ¥{totalReceived.toFixed(2)}
                      </div>
                    )}
                    {selectedCoupon && (
                      <div className="text-sm text-[#3D8A5A]">
                        优惠券减免: -¥{couponDiscount.toFixed(2)}
                      </div>
                    )}
                    <div className="font-bold text-xl text-[var(--primary)]">
                      订单总额: ¥{finalAmount.toFixed(2)}
                    </div>
                  </div>
                )
              })()}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>上一步</Button>
              <Button loading={submitting} onClick={async () => {
                if (!selectedStoreId) { toast.error("请选择门店"); return }
                // 校验手动金额
                for (const item of cart) {
                  const amounts = getItemAmounts(item, priceOverrides[item.sku.skuId])
                  if (isNaN(amounts.saleAmount) || amounts.saleAmount < 0) {
                    toast.error(`${item.product.name} 的应付金额无效`); return
                  }
                  if (isNaN(amounts.received) || amounts.received < 0) {
                    toast.error(`${item.product.name} 的实付金额无效`); return
                  }
                  if (amounts.received > amounts.saleAmount + 0.005) {
                    toast.error(`${item.product.name} 的实付金额不能超过应付金额`); return
                  }
                }
                setSubmitting(true)
                try {
                  const store = stores.find((s) => s.storeId === selectedStoreId)
                  const res = await createOrder({
                    storeId: selectedStoreId,
                    marketName: store?.marketName || "未知市场",
                    clientUserId: selectedCustomer?.userId || null,
                    clientPhone: selectedCustomer?.phone || phone,
                    customerName: selectedCustomer?.name || phone,
                    paymentMethod: paymentMethod as 'wechat' | 'alipay' | 'offline',
                    saleOrderType: orderType,
                    preferredEmployeeId: selectedEmployeeId || undefined,
                    remark: remark.trim() || null,
                    couponId: selectedCouponId || null,
                    items: cart.map((item) => {
                      const amounts = getItemAmounts(item, priceOverrides[item.sku.skuId])
                      return {
                        skuId: item.sku.skuId,
                        productName: item.product.name,
                        skuSpecName: item.sku.specName,
                        productType: item.sku.productType as '疗程卡' | '单品' | '院装产品',
                        sessionCount: item.sku.sessionCount,
                        unitPrice: item.sku.price,
                        unitRealPrice: (amounts.saleAmount / item.quantity).toFixed(2),
                        quantity: item.quantity,
                        saleAmount: amounts.saleAmount.toFixed(2),
                        received: amounts.received.toFixed(2),
                        salesCategory: item.product.salesCategory || null,
                      }
                    }),
                  })
                  if (res.success) {
                    toast.success(res.message)
                    setCreatedOrderId(res.saleOrderId || "")
                    setStep(3)
                  } else {
                    toast.error(res.message)
                  }
                } catch {
                  toast.error("创建订单失败，请稍后重试")
                } finally {
                  setSubmitting(false)
                }
              }}>提交订单</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4: 完成 */}
      {step === 3 && (
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="h-16 w-16 rounded-full flex items-center justify-center bg-[#F0F9F2]">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3D8A5A" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
            </div>
            <h2 className="text-xl font-bold text-[var(--foreground)]">
              {paymentConfirmed ? '收款已确认' : '订单创建成功'}
            </h2>
            {createdOrderId && (
              <p className="text-sm font-mono text-[var(--primary)]">{createdOrderId}</p>
            )}
            <p className="text-sm text-[#999999]">
              {paymentConfirmed
                ? '订单已确认收款，状态已更新为已支付'
                : paymentMethod === 'offline'
                  ? '线下支付订单，可直接确认收款'
                  : '请将二维码展示给顾客，扫码进入小程序完成支付'}
            </p>

            {/* 微信/支付宝支付：可打印 QR 码（spec §5.12） */}
            {paymentMethod !== 'offline' && createdOrderId && !paymentConfirmed && (
              <OrderQRCode orderId={createdOrderId} />
            )}

            {/* 线下支付：确认收款按钮 */}
            {paymentMethod === 'offline' && createdOrderId && !paymentConfirmed && (
              <div className="pt-2">
                <Button
                  loading={confirming}
                  className="bg-[#3D8A5A] hover:bg-[#2E6B45] text-white"
                  onClick={async () => {
                    setConfirming(true)
                    try {
                      const res = await confirmOfflinePayment(createdOrderId)
                      if (res.success) {
                        toast.success('收款确认成功')
                        setPaymentConfirmed(true)
                      } else {
                        toast.error(res.message)
                      }
                    } catch {
                      toast.error('确认收款失败，请稍后重试')
                    } finally {
                      setConfirming(false)
                    }
                  }}
                >
                  确认收款
                </Button>
              </div>
            )}

            <div className="flex justify-center gap-3 pt-4">
              {createdOrderId ? (
                <Link href={`/orders/${createdOrderId}`}>
                  <Button variant="outline">查看订单</Button>
                </Link>
              ) : (
                <Link href="/orders">
                  <Button variant="outline">返回订单列表</Button>
                </Link>
              )}
              <Button onClick={() => { setStep(0); setCart([]); setSelectedCustomer(null); setPhone(""); setCreatedOrderId(""); setSearchDone(false); setPaymentConfirmed(false); setSelectedCouponId(""); setAvailableCoupons([]); setPriceOverrides({}) }}>
                继续开单
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/**
 * 订单小程序码组件 — 调用微信 API 生成客户端小程序码，顾客扫码进入支付页。
 * 支持打印：点击"打印二维码"按钮触发浏览器打印（仅打印二维码区域）。
 */
function OrderQRCode({ orderId }: { orderId: string }) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const printRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setError("")
    generateOrderWxacode(orderId)
      .then((res) => {
        if (res.success && res.dataUrl) {
          setQrDataUrl(res.dataUrl)
        } else {
          setError(res.message || "生成小程序码失败")
        }
      })
      .catch(() => setError("生成小程序码失败"))
      .finally(() => setLoading(false))
  }, [orderId])

  const handlePrint = () => {
    if (!qrDataUrl) return
    const w = window.open('', '_blank', 'width=400,height=500')
    if (!w) return
    w.document.write(`<html><head><title>订单二维码</title>
      <style>body{text-align:center;font-family:system-ui;padding:40px}
      img{width:200px;height:200px}p{margin:8px 0;color:#333}
      .id{font-family:monospace;font-size:14px;color:#C0322A}</style>
      </head><body>
      <h3>凤御美业</h3>
      <img src="${qrDataUrl}" />
      <p class="id">${orderId}</p>
      <p style="font-size:12px;color:#999">请使用微信扫描二维码完成支付</p>
      </body></html>`)
    w.document.close()
    w.onload = () => { w.print(); w.close() }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="w-[200px] h-[200px] bg-[var(--muted)] rounded-lg animate-pulse" />
        <p className="text-xs text-[#999999]">正在生成小程序码…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <p className="text-xs text-[#D94040]">{error}</p>
      </div>
    )
  }

  if (!qrDataUrl) return null

  return (
    <div ref={printRef} className="flex flex-col items-center gap-3 py-4">
      <div className="bg-white p-3 rounded-lg border border-[var(--border)] inline-block">
        <img src={qrDataUrl} alt="订单小程序码" width={200} height={200} />
      </div>
      <p className="text-xs text-[#999999]">顾客使用微信扫描小程序码 → 进入小程序 → 完成支付</p>
      <Button variant="outline" size="sm" onClick={handlePrint}>
        <svg className="mr-1.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" />
        </svg>
        打印二维码
      </Button>
    </div>
  )
}
