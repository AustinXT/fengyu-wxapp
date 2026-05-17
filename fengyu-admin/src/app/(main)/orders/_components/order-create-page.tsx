"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { searchCustomers } from "@/actions/customers"
import {
  createOrder,
  createConversionOrder,
  confirmOfflinePayment,
  generateOrderWxacode,
} from "@/actions/orders"
import { getAvailableCoupons } from "@/actions/coupons"
import { getProductsByKind, type ProductKindForOrder, type OrderPickerResult, type OrderPickerNormalGroup, type OrderPickerCategory } from "@/actions/products"
import { getCustomerHeldCards, type HeldCardCandidate } from "@/actions/cards"
import { formatDate } from "@/lib/utils"
import { formatPhoneSafe } from "@/lib/format"
import type { ProductSku, Store, Employee, Customer, AvailableCoupon } from "@/lib/types"
import {
  BundlePicker,
  NormalSkuPicker,
  TrialCardPicker,
  PrepaidCardPicker,
  ConversionPanel,
  type CartItem,
  type ItemPriceOverride,
  type BundleAddPayload,
} from "./order-create"
import type { Product } from "@/lib/types"

/**
 * Step 1 商品类型 4 选 1（PR-B / PR-C）
 * - "组合套餐" → 后端 `__bundle__`（products.is_bundle=true）
 * - "普通商品" → 后端 `__normal__`（排除卡类 + 非 bundle，分组结构）
 * - "体验卡" / "充值卡" → 精确 product_kind 匹配（平铺结构）
 */
type ProductKindChoice = '组合套餐' | '普通商品' | '体验卡' | '充值卡'

const PRODUCT_KIND_CHOICES: ProductKindChoice[] = ['组合套餐', '普通商品', '体验卡', '充值卡']

/** Step 3 订单类型 3 选 1（PR-C） */
type OrderTypeChoice = '销售单' | '内部单' | '转换单'
const ORDER_TYPE_CHOICES: OrderTypeChoice[] = ['销售单', '内部单', '转换单']

/** 选择 → 后端 getProductsByKind(kind) 单值调用（ticket 2026-04-24 PR-A）*/
function resolveBackendKind(choice: ProductKindChoice): ProductKindForOrder {
  if (choice === '组合套餐') return '__bundle__'
  if (choice === '普通商品') return '__normal__'
  if (choice === '体验卡') return '体验卡'
  return '充值卡'
}

/**
 * 单次选择缓存的数据形态：
 * - bundles：仅"组合套餐"分支有值
 * - normalGroups：仅"普通商品"分支有值（分组结构）
 * - flatCategories：仅"体验卡" / "充值卡"分支有值（平铺结构）
 */
interface PrefetchedKindData {
  choice: ProductKindChoice
  bundles: Extract<OrderPickerResult, { kind: '__bundle__' }>['bundles']
  normalGroups: OrderPickerNormalGroup[]
  flatCategories: OrderPickerCategory[]
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
  stores,
  employees,
}: {
  stores: Store[]
  employees: Employee[]
}) {
  const [step, setStep] = useState(0)
  const [searchKeyword, setSearchKeyword] = useState("")
  const [searchResults, setSearchResults] = useState<Customer[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [cart, setCart] = useState<CartItem[]>([])
  // PR-C: Step 3 订单类型 3 选 1（销售单 / 内部单 / 转换单），默认销售单
  const [orderType, setOrderType] = useState<OrderTypeChoice>('销售单')
  // PR-B: Step 1 商品类型 4 选 1（默认 普通商品），驱动 Step 2 数据源
  const [productKindChoice, setProductKindChoice] = useState<ProductKindChoice>('普通商品')
  // PR-B: 内存缓存 — choice → 已预拉数据，避免 Step 2 切换 kind 时重复请求
  const [kindDataCache, setKindDataCache] = useState<Record<ProductKindChoice, PrefetchedKindData | undefined>>({
    组合套餐: undefined,
    普通商品: undefined,
    体验卡: undefined,
    充值卡: undefined,
  })
  const [prefetching, setPrefetching] = useState(false)
  // PR-C: 转换单候选卡（按顾客 + 门店动态加载）
  const [heldCards, setHeldCards] = useState<HeldCardCandidate[]>([])
  const [heldCardsLoading, setHeldCardsLoading] = useState(false)
  const [selectedHeldCardIds, setSelectedHeldCardIds] = useState<string[]>([])
  const [paymentMethod, setPaymentMethod] = useState("微信")
  const [selectedStoreId, setSelectedStoreId] = useState<string>(stores[0]?.storeId || "")
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>("")
  const [searching, setSearching] = useState(false)
  const [remark, setRemark] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [createdOrderId, setCreatedOrderId] = useState<string>("")
  // PR-C: 转换单成功结果（用于 Step 4 文案）
  const [conversionResult, setConversionResult] = useState<{
    totalIn: number
    totalOut: number
    priceDiff: number
    prepaidCardCredit: number
  } | null>(null)
  const [searchDone, setSearchDone] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)
  const [availableCoupons, setAvailableCoupons] = useState<AvailableCoupon[]>([])
  const [selectedCouponId, setSelectedCouponId] = useState<string>("")
  const [loadingCoupons, setLoadingCoupons] = useState(false)
  const [priceOverrides, setPriceOverrides] = useState<Record<string, ItemPriceOverride>>({})
  /**
   * ticket 2026-04-24 PR-3 §3.4 — 本次收款
   * 空字符串 = 未输入（默认按 payable_amount 全额收款）；
   * 非空 = 显式收款金额（0 表示纯挂账，0<v<payable 表示部分支付）。
   * 线上支付模式下禁用（admin 暂不支持线上支付）。
   */
  const [receivedAmountInput, setReceivedAmountInput] = useState<string>("")

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

  /**
   * 按 ProductKindChoice 预拉 Step 2 所需 SKU/SPU 数据。
   * - 已缓存则直接返回；并发期间忽略重复触发。
   * - 失败仅静默 toast 提示，不阻断 Step 1 → Step 2 流程（Step 2 自己会兜底）。
   */
  const prefetchKindData = useCallback(async (choice: ProductKindChoice) => {
    if (kindDataCache[choice]) return
    // 充值卡不依赖 SKU 列表（档位由前端 lib 提供，虚拟 SKU 已在 DB seed），无需拉数据
    if (choice === '充值卡') {
      setKindDataCache((prev) => ({
        ...prev,
        充值卡: { choice: '充值卡', bundles: [], normalGroups: [], flatCategories: [] },
      }))
      return
    }
    setPrefetching(true)
    try {
      const result = await getProductsByKind(resolveBackendKind(choice))
      const data: PrefetchedKindData = {
        choice,
        bundles: [],
        normalGroups: [],
        flatCategories: [],
      }
      // 按 discriminant key 而非字面量值分派（避免 flat 分支 kind:string 吞并 literal narrowing）
      if ('bundles' in result) {
        data.bundles = result.bundles
      } else if ('groups' in result) {
        data.normalGroups = result.groups
      } else {
        data.flatCategories = result.categories
      }
      setKindDataCache((prev) => ({ ...prev, [choice]: data }))
    } catch {
      toast.error("加载商品数据失败，进入下一步后可重试")
    } finally {
      setPrefetching(false)
    }
  }, [kindDataCache])

  const selectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer)
    // 自动默认顾客绑定的门店和美容师
    if (customer.boundStoreId && stores.some(s => s.storeId === customer.boundStoreId)) {
      setSelectedStoreId(customer.boundStoreId)
    }
    if (customer.boundEmployeeId && employees.some(e => e.employeeId === customer.boundEmployeeId && !e.isResigned && e.skills?.includes('美容师'))) {
      setSelectedEmployeeId(customer.boundEmployeeId)
    }
    void prefetchKindData(productKindChoice)
  }

  /**
   * 切换商品类型
   * - 若已选顾客 → 立即触发预拉
   * - 切换前若 cart 非空 → 弹确认（ticket §5 风险表）
   * - 实际清空 cart 在"进入 Step 2"时统一处理
   */
  const handleKindChoiceChange = (choice: ProductKindChoice) => {
    if (choice === productKindChoice) return
    if (cart.length > 0) {
      const ok = window.confirm("切换商品类型将清空当前购物车，是否继续？")
      if (!ok) return
      setCart([])
      setPriceOverrides({})
    }
    setProductKindChoice(choice)
    // 充值卡仅支持销售单（与 client 对齐）；进入充值卡分支时强制回落
    if (choice === '充值卡' && orderType !== '销售单') {
      setOrderType('销售单')
    }
    if (selectedCustomer) {
      void prefetchKindData(choice)
    }
  }

  // PR-C: 当切到转换单 + 已知顾客 + 门店时，加载折抵候选卡
  useEffect(() => {
    if (step !== 2) return
    if (orderType !== '转换单') return
    if (!selectedCustomer?.userId || !selectedStoreId) {
      setHeldCards([])
      return
    }
    let cancelled = false
    setHeldCardsLoading(true)
    getCustomerHeldCards(selectedCustomer.userId, selectedStoreId)
      .then((rows) => {
        if (cancelled) return
        setHeldCards(rows)
      })
      .catch(() => {
        if (cancelled) return
        toast.error("加载折抵卡失败，请重试")
        setHeldCards([])
      })
      .finally(() => {
        if (!cancelled) setHeldCardsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [step, orderType, selectedCustomer?.userId, selectedStoreId])

  // 切到非转换单时清空已选折抵卡
  useEffect(() => {
    if (orderType !== '转换单') {
      setSelectedHeldCardIds([])
    }
  }, [orderType])

  const addToCart = (product: Product, sku: ProductSku) => {
    // 充值卡订单：每单仅 1 笔，点击档位/自定义金额时替换购物车（不累加数量）
    // 2026-04-26 ticket：判定路径由 sku_id 字面量切换为 sku.isRechargeCard capability 列
    if (sku.isRechargeCard === true) {
      setCart([{ sku, product, quantity: 1 }])
      setPriceOverrides({})
      return
    }
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

  /**
   * Step 1 → Step 3（确认页）跳转：切换到 Step 3 并按顾客/金额异步加载可用优惠券。
   * 非套餐分支（普通/体验/充值）由底部「下一步」按钮调用；
   * 组合套餐分支由 BundlePicker.onBundleAdded 触发（跳过购物车 UI）。
   */
  const goToConfirm = async (subtotal: number) => {
    setStep(2)
    setSelectedCouponId("")
    if (selectedCustomer?.userId) {
      setLoadingCoupons(true)
      try {
        const coupons = await getAvailableCoupons(
          selectedCustomer.userId,
          subtotal,
          selectedStoreId || undefined,
        )
        setAvailableCoupons(coupons)
      } catch {
        setAvailableCoupons([])
      } finally {
        setLoadingCoupons(false)
      }
    } else {
      setAvailableCoupons([])
    }
  }

  /**
   * 组合套餐一次性加购：清空旧 cart（保证一单仅 1 个套餐） →
   * 按 bundlePrice 填入套餐子 SKU → 跳 Step 3 确认页。
   * 预算子总额用 sku.specialPrice（= bundlePrice）逐项累加，用于优惠券匹配。
   */
  const handleBundleAdded = (payload: BundleAddPayload) => {
    const newCart: CartItem[] = payload.skus.map((sku) => ({
      sku,
      product: payload.product,
      quantity: 1,
    }))
    setCart(newCart)
    setPriceOverrides({})
    const subtotal = newCart.reduce((sum, item) => {
      const unit = item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)
      return sum + unit * item.quantity
    }, 0)
    void goToConfirm(subtotal)
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

  // 应付合计 & 实付合计（含手动覆盖）— 内部单走半价显示分支
  const isInternal = orderType === '内部单'
  const isConversion = orderType === '转换单'
  const isBundleOrder = productKindChoice === '组合套餐'
  // 充值卡订单：payAmount 已由 matchTier 计算，禁止手工改价（与 client 对齐）
  // 2026-04-26 ticket：判定路径由 sku_id 字面量切换为 sku.isRechargeCard capability 列
  const isRechargeOrder = cart.some((item) => item.sku.isRechargeCard === true)
  const internalRatio = isInternal ? 0.5 : 1
  // 组合套餐 / 内部单 / 充值卡均禁用手工改价，cart 金额按 specialPrice(bundlePrice) 或原价计算
  const suppressOverride = isInternal || isBundleOrder || isRechargeOrder

  const { totalSaleAmount, totalReceived } = useMemo(() => {
    let sa = 0, rc = 0
    for (const item of cart) {
      // 组合套餐 / 内部单：禁止 priceOverrides 生效；组合套餐仍可叠加内部单半价
      const override = suppressOverride ? undefined : priceOverrides[item.sku.skuId]
      const amounts = getItemAmounts(item, override)
      sa += amounts.saleAmount * internalRatio
      rc += amounts.received * internalRatio
    }
    return { totalSaleAmount: sa, totalReceived: rc }
  }, [cart, priceOverrides, suppressOverride, internalRatio])

  // 转换单候选按钮可用性（ticket §5 表格最后两行）
  const conversionAllowed = !!selectedCustomer?.userId

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/orders" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新建订单</h1>
      </div>

      <StepIndicator current={step} />

      {/* Step 1: 选择顾客 + 商品类型（PR-B） */}
      {step === 0 && (
        <Card>
          <CardContent className="p-6 space-y-6">
            {/* 商品类型 4 选 1 — Step 2 数据源由此驱动 */}
            <div>
              <h2 className="text-base font-semibold mb-3">商品类型</h2>
              <div className="flex flex-wrap gap-2">
                {PRODUCT_KIND_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => handleKindChoiceChange(choice)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      productKindChoice === choice
                        ? "border-[var(--primary)] bg-[#FFF0EE] text-[var(--primary)]"
                        : "border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-gray-50"
                    }`}
                    aria-pressed={productKindChoice === choice}
                  >
                    {choice}
                  </button>
                ))}
              </div>
              {prefetching && (
                <p className="text-xs text-[#999999] mt-2">正在加载 {productKindChoice} 数据…</p>
              )}
            </div>

            <Separator />

            {/* 搜索顾客 */}
            <div className="space-y-4">
              <h2 className="text-base font-semibold">搜索顾客</h2>
              <div className="flex gap-2">
                <Input
                  placeholder="输入姓名或手机号搜索"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
                  className="w-72"
                />
                <Button onClick={handleSearch} loading={searching}>搜索</Button>
              </div>

              {/* 搜索结果列表 */}
              {searchDone && searchResults.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-[#999999]">找到 {searchResults.length} 位顾客，请选择：</p>
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {searchResults.map((c) => (
                      <button
                        key={c.userId}
                        onClick={() => selectCustomer(c)}
                        className={`w-full text-left px-4 py-3 rounded-lg border text-sm transition-colors ${
                          selectedCustomer?.userId === c.userId
                            ? "border-[var(--primary)] bg-[#FFF0EE]"
                            : "border-[var(--border)] bg-[#FAFAFA] hover:bg-gray-100"
                        }`}
                      >
                        <div className="flex items-center gap-4">
                          <span className="font-medium min-w-[4em]">{c.name || "-"}</span>
                          <span className="text-[#999999]">{formatPhoneSafe(c.phone)}</span>
                          {c.memberLevel && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[#FFF8E6] text-[#D4820A]">{c.memberLevel}</span>
                          )}
                          {c.storeName && (
                            <span className="text-xs text-[#999999]">{c.storeName}</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 已选顾客信息卡 */}
              {selectedCustomer && (
                <Card className="bg-[#FAFAFA]">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-[#3D8A5A]">已选择顾客</span>
                      <button
                        className="text-xs text-[#999999] hover:text-[#D94040]"
                        onClick={() => setSelectedCustomer(null)}
                      >
                        取消选择
                      </button>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                      <div>
                        <span className="text-[#999999]">姓名</span>
                        <p className="font-medium">{selectedCustomer.name || "-"}</p>
                      </div>
                      <div>
                        <span className="text-[#999999]">手机</span>
                        <p className="font-medium">{formatPhoneSafe(selectedCustomer.phone)}</p>
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

              {/* 未找到已注册顾客 — 指引顾客登录小程序 */}
              {searchDone && searchResults.length === 0 && (
                <Card className="bg-gray-50 border-gray-300">
                  <CardContent className="p-4 text-sm space-y-1 text-gray-700">
                    <p className="font-medium">未找到已注册顾客</p>
                    <p>本系统仅支持为"已在凤御小程序登录并绑定门店"的顾客开单。</p>
                    <p>请让顾客在客户端小程序完成登录与门店绑定后，再用姓名/手机号搜索。</p>
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="flex justify-end">
              <Button
                onClick={() => {
                  // PR-B B4：跨 kind 加购残留清理 — 进入 Step 2 前清空 cart + priceOverrides
                  setCart([])
                  setPriceOverrides({})
                  if (!kindDataCache[productKindChoice]) {
                    void prefetchKindData(productKindChoice)
                  }
                  setStep(1)
                }}
                disabled={!selectedCustomer}
              >
                下一步
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 2: 选择商品（PR-C：4 类 picker 渲染分支） */}
      {step === 1 && (
        <div className="space-y-4">
          {(() => {
            const data = kindDataCache[productKindChoice]
            if (!data && prefetching) {
              return <Card><CardContent className="p-6 text-sm text-[#999999]">正在加载 {productKindChoice} 数据…</CardContent></Card>
            }
            if (!data) {
              return (
                <Card>
                  <CardContent className="p-6 text-sm text-[#999999] flex items-center gap-3">
                    <span>{productKindChoice} 数据未加载</span>
                    <Button size="sm" variant="outline" onClick={() => void prefetchKindData(productKindChoice)}>
                      重试
                    </Button>
                  </CardContent>
                </Card>
              )
            }
            switch (productKindChoice) {
              case '组合套餐':
                return (
                  <BundlePicker
                    bundles={data.bundles}
                    cart={cart}
                    onAdd={addToCart}
                    onBundleAdded={handleBundleAdded}
                  />
                )
              case '普通商品':
                return (
                  <NormalSkuPicker
                    groups={data.normalGroups}
                    kindLabel="普通商品"
                    cart={cart}
                    onAdd={addToCart}
                  />
                )
              case '体验卡':
                return (
                  <TrialCardPicker
                    categories={data.flatCategories}
                    kindLabel="体验卡"
                    cart={cart}
                    onAdd={addToCart}
                  />
                )
              case '充值卡':
                return <PrepaidCardPicker onAdd={addToCart} />
            }
          })()}

          {/* 购物车（组合套餐分支跳过购物车 UI，直接由 BundlePicker.onBundleAdded 进 Step 3） */}
          {productKindChoice !== '组合套餐' && (
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold mb-3">
                购物车 <span className="text-[#999999]">({cart.length} 件)</span>
              </h3>
              {cart.length > 0 ? (
                <div className="space-y-2">
                  {cart.map((item) => {
                    const unitPrice = item.sku.specialPrice ? Number(item.sku.specialPrice) : Number(item.sku.price)
                    // 2026-04-26 ticket：判定路径由 sku_id 字面量切换为 sku.isRechargeCard capability 列
                    const isRechargeItem = item.sku.isRechargeCard === true
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
                              disabled={isRechargeItem}
                              className="w-7 h-7 flex items-center justify-center text-[#666666] hover:bg-gray-100 rounded-l transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                            >
                              −
                            </button>
                            <span className="w-8 text-center text-sm font-medium">{item.quantity}</span>
                            <button
                              onClick={() => updateCartQuantity(item.sku.skuId, 1)}
                              disabled={isRechargeItem}
                              className="w-7 h-7 flex items-center justify-center text-[#666666] hover:bg-gray-100 rounded-r transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
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
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(0)}>上一步</Button>
            {/* 组合套餐分支：跳过购物车，选套餐后由 BundlePicker.onBundleAdded 自动进 Step 3；这里不渲染「下一步」 */}
            {productKindChoice !== '组合套餐' && (
              <Button
                onClick={() => void goToConfirm(catalogTotal)}
                disabled={cart.length === 0}
              >
                下一步
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Step 3: 确认订单（PR-C：订单类型 3 选 1 + 内部单/转换单分支） */}
      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <h2 className="text-base font-semibold">确认订单</h2>

            {/* 订单类型 3 选 1 */}
            <div>
              <label className="text-sm text-[#999999] block mb-2">订单类型</label>
              <div className="flex flex-wrap gap-2">
                {ORDER_TYPE_CHOICES.map((choice) => {
                  // 充值卡订单仅支持销售单（与 client 模型对齐）
                  const rechargeLocked = productKindChoice === '充值卡' && choice !== '销售单'
                  const disabled = rechargeLocked || (choice === '转换单' && !conversionAllowed)
                  const disabledReason = rechargeLocked
                    ? "充值卡订单仅支持销售单"
                    : (choice === '转换单' && !conversionAllowed ? "请先用搜索确认顾客身份" : undefined)
                  return (
                    <button
                      key={choice}
                      type="button"
                      disabled={disabled}
                      onClick={() => setOrderType(choice)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        orderType === choice
                          ? "border-[var(--primary)] bg-[#FFF0EE] text-[var(--primary)]"
                          : disabled
                            ? "border-[var(--border)] bg-gray-50 text-[#cccccc] cursor-not-allowed"
                            : "border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-gray-50"
                      }`}
                      aria-pressed={orderType === choice}
                      title={disabledReason}
                    >
                      {choice}
                    </button>
                  )
                })}
              </div>
              {orderType === '转换单' && !conversionAllowed && (
                <p className="text-xs text-[#D94040] mt-1">请先用搜索确认顾客身份</p>
              )}
              {productKindChoice === '充值卡' && (
                <p className="text-xs text-[#999999] mt-1">充值卡订单仅支持销售单</p>
              )}
              {isInternal && (
                <p className="text-xs text-[#D4820A] mt-1">内部单 5 折，禁用手工改价 + 优惠券</p>
              )}
              {isBundleOrder && !isConversion && (
                <p className="text-xs text-[#D4820A] mt-1">组合套餐按打包价销售，禁用手工改价</p>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#999999]">顾客</label>
                <p className="font-medium">{selectedCustomer?.name ?? "-"}</p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">支付方式</label>
                <Select className="mt-1" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="微信">微信支付</option>
                  <option value="支付宝">支付宝</option>
                  <option value="线下">线下支付</option>
                </Select>
              </div>
              {/* ticket 2026-04-24 PR-3 §3.4 — 本次收款（仅线下可用） */}
              {!isConversion && (() => {
                const selectedCoupon = availableCoupons.find((c) => c.couponId === selectedCouponId)
                const couponDiscount = !isInternal && selectedCoupon ? Number(selectedCoupon.discountAmount) : 0
                const payableAmount = Math.max(0, Math.round((totalReceived - couponDiscount) * 100) / 100)
                const isOnlinePay = paymentMethod === '微信' || paymentMethod === '支付宝'
                return (
                  <div>
                    <label className="text-sm text-[#999999]">
                      本次收款
                      {isOnlinePay && <span className="ml-1 text-[11px]">（线上支付不支持）</span>}
                    </label>
                    <Input
                      type="number"
                      min="0"
                      max={payableAmount}
                      step="0.01"
                      placeholder={`留空=全额 ¥${payableAmount.toFixed(2)}`}
                      className="mt-1"
                      disabled={isOnlinePay}
                      value={isOnlinePay ? "" : receivedAmountInput}
                      onChange={(e) => setReceivedAmountInput(e.target.value)}
                    />
                    <p className="text-[11px] text-[#999999] mt-1">
                      留空或默认 = 全额收款；小于全额将落为"部分支付"订单
                    </p>
                  </div>
                )
              })()}
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
                  {employees.filter((e) => !e.isResigned && (!selectedStoreId || e.storeId === selectedStoreId) && e.skills?.includes('美容师')).map((e) => (
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

              {/* 优惠券（仅已注册顾客可选 + 非内部单 + 非充值卡） */}
              {selectedCustomer?.userId && !isInternal && !isConversion && !isRechargeOrder && (
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

            {/* 商品清单 — 转换单走 ConversionPanel；销售/内部单走原表单 */}
            {isConversion ? (
              <ConversionPanel
                loading={heldCardsLoading}
                heldCards={heldCards}
                selectedIds={selectedHeldCardIds}
                onChange={setSelectedHeldCardIds}
                totalIn={cart.reduce((s, item) => {
                  const amt = getItemAmounts(item)
                  return s + amt.saleAmount
                }, 0)}
              />
            ) : (
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
                    // 内部单 / 组合套餐：不读 priceOverrides，禁用手工改价
                    const override = suppressOverride ? undefined : priceOverrides[item.sku.skuId]
                    const baseAmounts = getItemAmounts(item, override)
                    const displaySaleAmount = baseAmounts.saleAmount * internalRatio
                    const displayReceived = baseAmounts.received * internalRatio
                    const hasOverride = !suppressOverride && (override?.saleAmount != null || override?.received != null)

                    return (
                      <div key={item.sku.skuId} className="grid grid-cols-12 gap-2 items-center bg-[#FAFAFA] rounded px-3 py-2 text-sm">
                        <span className="col-span-3 truncate" title={`${item.product.name} - ${item.sku.specName}`}>
                          {item.product.name} - {item.sku.specName}
                        </span>
                        <span className="col-span-1 text-center">{item.quantity}</span>
                        <span className="col-span-2 text-right text-[#999999]">
                          {isInternal ? (
                            <>
                              <span className="line-through mr-1">¥{baseAmounts.defaultSaleAmount.toFixed(2)}</span>
                              <span className="text-[var(--primary)]">¥{(baseAmounts.defaultSaleAmount * 0.5).toFixed(2)}</span>
                            </>
                          ) : (
                            <>¥{baseAmounts.defaultSaleAmount.toFixed(2)}</>
                          )}
                        </span>
                        <div className="col-span-2">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            disabled={suppressOverride}
                            className="h-8 text-sm text-right"
                            value={suppressOverride ? displaySaleAmount.toFixed(2) : (override?.saleAmount ?? baseAmounts.defaultSaleAmount.toFixed(2))}
                            onChange={(e) => {
                              if (suppressOverride) return
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
                            disabled={suppressOverride}
                            className="h-8 text-sm text-right"
                            value={suppressOverride ? displayReceived.toFixed(2) : (override?.received ?? baseAmounts.saleAmount.toFixed(2))}
                            onChange={(e) => {
                              if (suppressOverride) return
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
                  const couponDiscount = !isInternal && selectedCoupon ? Number(selectedCoupon.discountAmount) : 0
                  const finalAmount = Math.max(0, totalReceived - couponDiscount)
                  return (
                    <div className="text-right pt-4 space-y-1">
                      {isInternal && (
                        <div className="flex justify-end">
                          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-[#888888]">内部单 5 折</span>
                        </div>
                      )}
                      <div className="text-sm text-[#999999]">
                        应付合计: ¥{totalSaleAmount.toFixed(2)}
                      </div>
                      {totalReceived !== totalSaleAmount && (
                        <div className="text-sm text-[#999999]">
                          实付合计: ¥{totalReceived.toFixed(2)}
                        </div>
                      )}
                      {selectedCoupon && !isInternal && (
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
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>上一步</Button>
              <Button loading={submitting} onClick={async () => {
                if (!selectedStoreId) { toast.error("请选择门店"); return }

                // 转换单分支
                if (isConversion) {
                  if (!selectedCustomer?.userId) {
                    toast.error("转换单必须实名顾客")
                    return
                  }
                  if (selectedHeldCardIds.length === 0) {
                    toast.error("请至少勾选一张折抵卡")
                    return
                  }
                  setSubmitting(true)
                  try {
                    const store = stores.find((s) => s.storeId === selectedStoreId)
                    const res = await createConversionOrder({
                      storeId: selectedStoreId,
                      marketName: store?.marketName || "未知市场",
                      clientUserId: selectedCustomer.userId,
                      paymentMethod: paymentMethod as '微信' | '支付宝' | '线下',
                      preferredEmployeeId: selectedEmployeeId || undefined,
                      remark: remark.trim() || null,
                      convertOutSaleItemIds: selectedHeldCardIds,
                      convertInItems: cart.map((item) => ({
                        skuId: item.sku.skuId,
                        productName: item.product.name,
                        skuSpecName: item.sku.specName,
                        productType: item.sku.productType as '疗程卡' | '单品' | '家居产品',
                        sessionCount: item.sku.sessionCount,
                        unitPrice: item.sku.price,
                        quantity: item.quantity,
                      })),
                    })
                    if (res.success && res.saleOrderId) {
                      toast.success(res.message)
                      setCreatedOrderId(res.saleOrderId)
                      setConversionResult({
                        totalIn: res.totalIn ?? 0,
                        totalOut: res.totalOut ?? 0,
                        priceDiff: res.priceDiff ?? 0,
                        prepaidCardCredit: res.prepaidCardCredit ?? 0,
                      })
                      setStep(3)
                    } else {
                      toast.error(res.message)
                    }
                  } catch {
                    toast.error("创建转换单失败，请稍后重试")
                  } finally {
                    setSubmitting(false)
                  }
                  return
                }

                // 销售单 / 内部单 — 走原 createOrder
                // 校验手动金额（内部单 / 组合套餐跳过 priceOverrides，因为禁用了改价）
                if (!suppressOverride) {
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
                }
                // ticket 2026-04-24 PR-3 §3.4 — 本次收款解析与前端校验
                // 空字符串 → undefined（后端按 payable_amount 全额处理）；
                // 非空 → number，后端做 0 ≤ v ≤ payable 的最终校验。
                let receivedAmountArg: number | undefined
                if (paymentMethod === '微信' || paymentMethod === '支付宝') {
                  // 线上支付：admin 不支持与 receivedAmount 共存，强制 undefined（后端也会拒绝 >0）
                  receivedAmountArg = undefined
                } else if (receivedAmountInput.trim() !== '') {
                  const parsed = Number(receivedAmountInput)
                  if (!Number.isFinite(parsed) || parsed < 0) {
                    toast.error('本次收款金额无效'); return
                  }
                  receivedAmountArg = Math.round(parsed * 100) / 100
                }

                setSubmitting(true)
                try {
                  const store = stores.find((s) => s.storeId === selectedStoreId)
                  const res = await createOrder({
                    storeId: selectedStoreId,
                    marketName: store?.marketName || "未知市场",
                    clientUserId: selectedCustomer!.userId,
                    clientPhone: selectedCustomer!.phone ?? '',
                    customerName: selectedCustomer!.name?.trim() || selectedCustomer!.phone || '',
                    paymentMethod: paymentMethod as '微信' | '支付宝' | '线下',
                    saleOrderType: orderType,
                    preferredEmployeeId: selectedEmployeeId || undefined,
                    remark: remark.trim() || null,
                    couponId: !isInternal ? (selectedCouponId || null) : null,
                    receivedAmount: receivedAmountArg,
                    items: cart.map((item) => {
                      // 内部单后端会再 ×0.5；前端传原价 saleAmount，不要预先半价
                      // 组合套餐：priceOverrides 被 UI 锁死不会有值，这里 suppressOverride 兜底
                      const override = suppressOverride ? undefined : priceOverrides[item.sku.skuId]
                      const amounts = getItemAmounts(item, override)
                      return {
                        skuId: item.sku.skuId,
                        productName: item.product.name,
                        skuSpecName: item.sku.specName,
                        productType: item.sku.productType as '疗程卡' | '单品' | '家居产品',
                        sessionCount: item.sku.sessionCount,
                        unitPrice: item.sku.price,
                        unitRealPrice: (amounts.saleAmount / item.quantity).toFixed(2),
                        quantity: item.quantity,
                        saleAmount: amounts.saleAmount.toFixed(2),
                        received: amounts.received.toFixed(2),
                        salesCategory: null,
                        // 2026-04-26 ticket：充值卡 capability hint（服务端会以 product_skus 权威值覆盖）
                        isRechargeCard: item.sku.isRechargeCard === true,
                      }
                    }),
                  })
                  if (res.success) {
                    toast.success(res.message)
                    setCreatedOrderId(res.saleOrderId || "")
                    setConversionResult(null)
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

      {/* Step 4: 完成（PR-C C4：按订单类型/差额展示不同文案） */}
      {step === 3 && (
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            <div className="flex justify-center">
              <div className="h-16 w-16 rounded-full flex items-center justify-center bg-[#F0F9F2]">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3D8A5A" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
            </div>
            <h2 className="text-xl font-bold text-[var(--foreground)]">
              {paymentConfirmed ? '收款已确认' : conversionResult ? '转换单已创建' : '订单创建成功'}
            </h2>
            {createdOrderId && (
              <p className="text-sm font-mono text-[var(--primary)]">{createdOrderId}</p>
            )}

            {/* 转换单成功文案分支 */}
            {conversionResult ? (
              <div className="text-sm space-y-1">
                <p className="text-[#666666]">
                  转入 ¥{conversionResult.totalIn.toFixed(2)} ｜ 折抵 ¥{conversionResult.totalOut.toFixed(2)}
                </p>
                {conversionResult.priceDiff > 0 && (
                  <p className="text-[#D94040] font-semibold">
                    请确认补差额收款 ¥{conversionResult.priceDiff.toFixed(2)}
                  </p>
                )}
                {conversionResult.priceDiff === 0 && (
                  <p className="text-[#3D8A5A] font-semibold">折抵完成，无需收款</p>
                )}
                {conversionResult.priceDiff < 0 && (
                  <p className="text-[#5E8BB3] font-semibold">
                    差额 ¥{conversionResult.prepaidCardCredit.toFixed(2)} 已充入储值卡
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-[#999999]">
                {paymentConfirmed
                  ? '订单已确认收款，状态已更新为已支付'
                  : paymentMethod === '线下'
                    ? '线下支付订单，可直接确认收款'
                    : '请将二维码展示给顾客，扫码进入小程序完成支付'}
              </p>
            )}

            {/* 微信/支付宝支付：可打印 QR 码（销售/内部单 + 转换单正差额场景） */}
            {paymentMethod !== '线下' && createdOrderId && !paymentConfirmed
              && (!conversionResult || conversionResult.priceDiff > 0) && (
              <OrderQRCode orderId={createdOrderId} />
            )}

            {/* 线下支付：确认收款按钮（销售/内部单 + 转换单正差额场景） */}
            {paymentMethod === '线下' && createdOrderId && !paymentConfirmed
              && (!conversionResult || conversionResult.priceDiff > 0) && (
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
              <Button onClick={() => {
                setStep(0); setCart([]); setSelectedCustomer(null); setSearchKeyword(""); setSearchResults([]); setCreatedOrderId(""); setSearchDone(false); setPaymentConfirmed(false); setSelectedCouponId(""); setAvailableCoupons([]); setPriceOverrides({}); setOrderType("销售单"); setReceivedAmountInput("")
                setProductKindChoice('普通商品')
                setKindDataCache({ 组合套餐: undefined, 普通商品: undefined, 体验卡: undefined, 充值卡: undefined })
                setHeldCards([])
                setSelectedHeldCardIds([])
                setConversionResult(null)
              }}>
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
