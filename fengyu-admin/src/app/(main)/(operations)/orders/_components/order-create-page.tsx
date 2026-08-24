"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { MemberLevelBadge } from "@/components/ui/member-level-badge"
import { searchCustomers } from "@/actions/customers"
import {
  createOrder,
  createConversionOrder,
  confirmOfflinePayment,
  generateOrderWxacode,
} from "@/actions/orders"
import { getAvailableCoupons } from "@/actions/coupons"
import { getProductsByKind, type ProductKindForOrder, type OrderPickerResult, type OrderPickerNormalGroup, type OrderPickerCategory } from "@/actions/products"
import { getCustomerHeldCards, getCustomerCardBalance, getCustomerPointsBalance, createRechargeOrder, type HeldCardCandidate } from "@/actions/cards"
import { formatDate } from "@/lib/utils"
import { formatPhoneSafe } from "@/lib/format"
import { actionErrorMessage } from "@/lib/action-error"
import { isMember, resolveUnitPrice } from "@/lib/member-pricing"
import { calculateTreatmentTierLineAmounts } from "@/lib/treatment-tier-pricing"
import { formatOrderServiceStaffOption, getOrderServiceStaffCandidates, isOrderServiceStaffCandidate } from "@/lib/order-service-staff"
import type { RechargeConfig } from "@/lib/recharge-tier"
import type { ProductSku, Store, Employee, Customer, AvailableCoupon } from "@/lib/types"
import {
  BundlePicker,
  NormalSkuPicker,
  TrialCardPicker,
  ConversionPanel,
  RechargePicker,
  resolveRecharge,
  formatAmount as formatRechargeAmount,
  formatDiscountLabel,
  type CartItem,
  type ItemPriceOverride,
  type BundleAddPayload,
} from "./order-create"
import { allocateDiscountPerLine, calculateSaleCashAmount, requiresOfflineCardOnlyConfirmation } from "./order-create/payment-calculation"
import type { Product } from "@/lib/types"

/**
 * Step 1 商品类型 3 选 1（PR-B / PR-C）
 * - "组合套餐" → 后端 `__bundle__`（products.is_bundle=true）
 * - "普通商品" → 后端 `__normal__`（排除体验卡 + 非 bundle，分组结构）
 * - "体验卡" → 精确 SKU.is_experience=true 匹配（平铺结构）
 * - "充值卡" → 无 SKU 数据，走 RechargePicker 档位选择 → createRechargeOrder（2026-05-21
 *   充值入口收敛到开单页，与 staff order-create 的「充值卡」Tab 对齐）
 */
type ProductKindChoice = '组合套餐' | '普通商品' | '体验卡' | '充值卡'

const PRODUCT_KIND_CHOICES: ProductKindChoice[] = ['组合套餐', '普通商品', '体验卡', '充值卡']

/** Step 3 订单类型 3 选 1（PR-C） */
type OrderTypeChoice = '销售单' | '内部单' | '转换单'
const ORDER_TYPE_CHOICES: OrderTypeChoice[] = ['销售单', '内部单', '转换单']

/** 选择 → 后端 getProductsByKind(kind) 单值调用 */
function resolveBackendKind(choice: ProductKindChoice): ProductKindForOrder {
  if (choice === '组合套餐') return '__bundle__'
  if (choice === '普通商品') return '__normal__'
  return '体验卡'
}

/** 组合套餐与普通商品都受顾客绑定门店影响，不能跨顾客共用缓存项。 */
function kindDataCacheKey(choice: ProductKindChoice, clientUserId?: string): string {
  return choice === '组合套餐' || choice === '普通商品'
    ? `${choice}:${clientUserId ?? ''}`
    : choice
}

/**
 * 单次选择缓存的数据形态：
 * - bundles：仅"组合套餐"分支有值
 * - normalGroups：仅"普通商品"分支有值（分组结构）
 * - flatCategories：仅"体验卡"分支有值（平铺结构）
 */
interface PrefetchedKindData {
  choice: ProductKindChoice
  bundles: Extract<OrderPickerResult, { kind: '__bundle__' }>['bundles']
  normalGroups: OrderPickerNormalGroup[]
  flatCategories: OrderPickerCategory[]
}

function getItemAmounts(
  item: CartItem,
  override?: ItemPriceOverride,
  opts?: { buyerIsMember?: boolean; isInternal?: boolean; tierLineAmount?: number | null },
) {
  // 默认成交单价分流（与后端 createOrder 同口径，后端为权威）：
  // - 内部单：一律按标价 price（后端再 ×50%，不取会员/体验价）
  // - 套餐子项（bundlePrice/bundleGroupId）：套餐价独立机制，沿用 specialPrice，不分流
  // - 普通商品/体验卡：会员价分流 —— 会员→会员价、非会员→标价（#6=B：体验卡不再豁免，同口径）
  const listUnit = Number(item.sku.price)
  const isBundleItem = !!item.bundleProductId || item.sku.bundlePrice != null || item.sku.bundleGroupId != null
  const defaultUnitPrice = opts?.isInternal
    ? listUnit
    : isBundleItem
      ? (item.sku.specialPrice ? Number(item.sku.specialPrice) : listUnit)
      : resolveUnitPrice(
          { price: item.sku.price, specialPrice: item.sku.specialPrice, isExperience: item.sku.isExperience },
          opts?.buyerIsMember ?? false,
        ).realUnit
  const defaultSaleAmount = opts?.tierLineAmount != null
    ? opts.tierLineAmount
    : defaultUnitPrice * item.quantity

  // 应付金额：店长特别优惠可手填覆盖，统一钳制到 [0, 标价小计]（向下调，不许涨价）。
  // 未设 override.saleAmount 的普通项 → defaultSaleAmount（钳制为恒等，零行为变化）。
  const rawSale = override?.saleAmount != null && override.saleAmount !== ''
    ? Number(override.saleAmount)
    : defaultSaleAmount
  const saleAmount = Number.isNaN(rawSale)
    ? defaultSaleAmount
    : Math.max(0, Math.min(rawSale, defaultSaleAmount))

  const received = override?.received != null && override.received !== ''
    ? Number(override.received)
    : saleAmount

  return { defaultUnitPrice, defaultSaleAmount, saleAmount, received }
}

/** 充值卡金额统一按非负值、两位小数和业务上限钳制。 */
function clampPrepaidAmount(value: string | number, maxAmount: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  const normalizedMax = Number.isFinite(maxAmount) ? Math.max(0, maxAmount) : 0
  return Math.round(Math.max(0, Math.min(parsed, normalizedMax)) * 100) / 100
}

function purchaseLimitMessage(sku: Pick<ProductSku, 'specName' | 'purchaseLimit'>): string {
  return `${sku.specName} 每单最多可购买 ${sku.purchaseLimit} 件`
}

function findCartPurchaseLimitViolation(
  items: Array<{ sku: Pick<ProductSku, 'skuId' | 'specName' | 'purchaseLimit'>; quantity: number }>,
): { sku: Pick<ProductSku, 'specName' | 'purchaseLimit'>; quantity: number } | null {
  const totals = new Map<string, { sku: Pick<ProductSku, 'specName' | 'purchaseLimit'>; quantity: number }>()
  for (const item of items) {
    const current = totals.get(item.sku.skuId)
    totals.set(item.sku.skuId, {
      sku: item.sku,
      quantity: (current?.quantity ?? 0) + item.quantity,
    })
  }
  for (const row of totals.values()) {
    if (row.sku.purchaseLimit != null && row.quantity > row.sku.purchaseLimit) return row
  }
  return null
}

function pointsToDiscountCents(points: number, rate: number): number {
  return Math.floor(points * rate * 100 + 1e-6)
}

function computePointsPreview(input: {
  enabled: boolean
  pointsInput: string
  pointsBalance: number
  rawTotal: number
  currentAmount: number
  pointsToYuanRate: number
  pointsDeductionMaxRate: number
}) {
  const balance = Math.max(0, Math.floor(input.pointsBalance))
  const currentCents = Math.max(0, Math.round(input.currentAmount * 100))
  const rate = Number(input.pointsToYuanRate) || 0.01
  const maxRate = Number(input.pointsDeductionMaxRate) || 0
  const capCents = Math.min(
    currentCents,
    Math.floor(Math.max(0, input.rawTotal) * maxRate * 100 + 1e-6),
  )
  const maxPoints = rate > 0 ? Math.max(0, Math.min(balance, Math.floor(capCents / (rate * 100)))) : 0
  if (!input.enabled || balance <= 0 || capCents <= 0 || maxPoints <= 0) {
    return { pointsUsed: 0, pointsDiscount: 0, maxPoints, maxDiscount: capCents / 100 }
  }

  const requested = input.pointsInput.trim() === ''
    ? maxPoints
    : Math.max(0, Math.min(maxPoints, Math.floor(Number(input.pointsInput) || 0)))
  const discountCents = Math.min(capCents, pointsToDiscountCents(requested, rate))
  return {
    pointsUsed: discountCents > 0 ? requested : 0,
    pointsDiscount: discountCents / 100,
    maxPoints,
    maxDiscount: capCents / 100,
  }
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
  rechargeConfig,
}: {
  stores: Store[]
  employees: Employee[]
  rechargeConfig: RechargeConfig | null
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
  // PR-B: 内存缓存。组合套餐的 key 含顾客 ID，避免 A 顾客的数据展示给 B 顾客。
  const [kindDataCache, setKindDataCache] = useState<Partial<Record<string, PrefetchedKindData>>>({})
  const [prefetching, setPrefetching] = useState(false)
  // PR-C: 转换单候选卡（按顾客 + 门店动态加载）
  const [heldCards, setHeldCards] = useState<HeldCardCandidate[]>([])
  const [heldCardsLoading, setHeldCardsLoading] = useState(false)
  const [selectedHeldCardIds, setSelectedHeldCardIds] = useState<string[]>([])
  const [isExperienceConversion, setIsExperienceConversion] = useState(false)
  const [conversionReceivedInput, setConversionReceivedInput] = useState("")
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
    prepaidCardAmount: number
    isExperienceConversion: boolean
    receivedAmount: number
    remainingAmount: number
  } | null>(null)
  const [searchDone, setSearchDone] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)
  // 线下「确认收款」本次确认金额（受控，仅普通销售/内部单可下调做部分确认；充值/转换单走全额）
  const [confirmAmountInput, setConfirmAmountInput] = useState<string>("")
  // 确认收款结果状态（驱动 Step 4 文案：部分支付 vs 已支付）
  const [confirmResultStatus, setConfirmResultStatus] = useState<'部分支付' | '已支付' | null>(null)
  const [availableCoupons, setAvailableCoupons] = useState<AvailableCoupon[]>([])
  const [selectedCouponId, setSelectedCouponId] = useState<string>("")
  const [loadingCoupons, setLoadingCoupons] = useState(false)
  const [priceOverrides, setPriceOverrides] = useState<Record<string, ItemPriceOverride>>({})
  /**
   * 充值卡抵扣（DB 字段 sale_orders.prepaid_card_amount 命名保持不变；UI 文案统一为「充值卡」）
   * - 顾客余额由 getCustomerCardBalance 查询（跨店）
   * - 上限 = min(余额, 本次实收合计)
   * - 充值订单本身不进 admin 开单页（走员工端 card.recharge），故无需"不可用充值卡买充值卡"守卫
   */
  const [customerCardBalance, setCustomerCardBalance] = useState<number>(0)
  const [useCard, setUseCard] = useState<boolean>(false)
  const [cardAmountInput, setCardAmountInput] = useState<string>("0.00")
  const [customerPointsBalance, setCustomerPointsBalance] = useState<number>(0)
  const [usePoints, setUsePoints] = useState<boolean>(false)
  const [pointsInput, setPointsInput] = useState<string>("")
  const [pointsToYuanRate, setPointsToYuanRate] = useState<number>(0.01)
  const [pointsDeductionMaxRate, setPointsDeductionMaxRate] = useState<number>(0.03)
  // 活动单标记（纯标识，不影响金额/提成口径）
  const [isActivity, setIsActivity] = useState<boolean>(false)
  // 创建订单返回的 status，用于 Step 4 文案分支（部分支付 / 待支付 / 已支付）
  const [createdStatus, setCreatedStatus] = useState<'待支付' | '部分支付' | '已支付' | null>(null)
  // 本次应付合计快照（= totalSaleAmount），用于 Step 4 计算剩余
  const [createdPayable, setCreatedPayable] = useState<number>(0)
  // 充值卡子流程（productKindChoice='充值卡'）：档位选择 + 创建结果
  const [rechargeSelectedFace, setRechargeSelectedFace] = useState<number>(0)
  const [rechargeCustomInput, setRechargeCustomInput] = useState<string>("")
  const [rechargeResult, setRechargeResult] = useState<{ saleOrderId: string; payAmount: number; faceValue: number } | null>(null)

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

  /**
   * 按 ProductKindChoice 预拉 Step 2 所需 SKU/SPU 数据。
   * - 已缓存则直接返回；并发期间忽略重复触发。
   * - 失败仅静默 toast 提示，不阻断 Step 1 → Step 2 流程（Step 2 自己会兜底）。
   */
  const prefetchKindData = useCallback(async (choice: ProductKindChoice, clientUserId = selectedCustomer?.userId) => {
    // 充值卡无 SKU 数据，不走 getProductsByKind（Step 2 渲染 RechargePicker）
    if (choice === '充值卡') return
    const cacheKey = kindDataCacheKey(choice, clientUserId)
    if (kindDataCache[cacheKey]) return
    setPrefetching(true)
    try {
      const result = await getProductsByKind(
        resolveBackendKind(choice),
        choice === '组合套餐' || choice === '普通商品' ? clientUserId : undefined,
      )
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
      setKindDataCache((prev) => ({ ...prev, [cacheKey]: data }))
    } catch (err) {
      toast.error(actionErrorMessage(err, "加载商品数据失败，进入下一步后可重试"))
    } finally {
      setPrefetching(false)
    }
  }, [kindDataCache, selectedCustomer?.userId])

  const selectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer)
    // 顾客切换后充值卡开关保持关闭，金额从 0.00 重新填写。
    setUseCard(false)
    setCardAmountInput('0.00')
    // 自动默认顾客绑定的门店和美容师
    const targetStoreId = customer.boundStoreId && stores.some(s => s.storeId === customer.boundStoreId)
      ? customer.boundStoreId
      : selectedStoreId
    if (targetStoreId !== selectedStoreId) setSelectedStoreId(targetStoreId)
    if (customer.boundEmployeeId && employees.some(
      e => e.employeeId === customer.boundEmployeeId && isOrderServiceStaffCandidate(
        e,
        targetStoreId,
        stores.find((store) => store.storeId === targetStoreId)?.marketName,
      ),
    )) {
      setSelectedEmployeeId(customer.boundEmployeeId)
    } else {
      setSelectedEmployeeId("")
    }
    void prefetchKindData(productKindChoice, customer.userId)
    // 异步加载充值卡余额和积分余额（开单页随时可用；含充值卡 SKU 时由 UI 锁灰，但状态仍保留以便切换时立即可用）
    if (customer.userId) {
      Promise.all([
        getCustomerCardBalance(customer.userId),
        getCustomerPointsBalance(customer.userId),
      ])
        .then(([bal, points]) => {
          setCustomerCardBalance(bal)
          setCustomerPointsBalance(points.pointsBalance)
          setPointsToYuanRate(points.pointsToYuanRate)
          setPointsDeductionMaxRate(points.pointsDeductionMaxRate)
          setUseCard(false)
          setUsePoints(false)
          setCardAmountInput('0.00')
        })
        .catch(() => {
          setCustomerCardBalance(0)
          setCustomerPointsBalance(0)
          setUseCard(false)
          setUsePoints(false)
          setCardAmountInput('0.00')
        })
    } else {
      setCustomerCardBalance(0)
      setCustomerPointsBalance(0)
      setUseCard(false)
      setUsePoints(false)
      setCardAmountInput('0.00')
    }
    setCardAmountInput('0.00')
    setPointsInput("")
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
    if (selectedCustomer) {
      void prefetchKindData(choice, selectedCustomer.userId)
    }
  }

  const handleOrderTypeChange = (choice: OrderTypeChoice) => {
    if (choice === orderType) return
    setOrderType(choice)
    // 不同订单类型的抵扣上限口径不同，切换后要求重新确认金额。
    setUseCard(false)
    setCardAmountInput('0.00')
    setIsExperienceConversion(false)
    setConversionReceivedInput("")
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
      .catch((err) => {
        if (cancelled) return
        toast.error(actionErrorMessage(err, "加载折抵卡失败，请重试"))
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
      setIsExperienceConversion(false)
      setConversionReceivedInput("")
    }
  }, [orderType])

  const addToCart = (product: Product, sku: ProductSku) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.sku.skuId === sku.skuId)
      const nextQty = (existing?.quantity ?? 0) + 1
      if (sku.purchaseLimit != null && nextQty > sku.purchaseLimit) {
        toast.error(purchaseLimitMessage(sku))
        return prev
      }
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
          if (item.sku.purchaseLimit != null && newQty > item.sku.purchaseLimit) {
            toast.error(purchaseLimitMessage(item.sku))
            acc.push(item)
            return acc
          }
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
        // 传订单明细，使 getAvailableCoupons 按合格品类行小计（eligibleTotal）判满减门槛（M10：与 client/staff + order.create 一致）
        const couponItems = cart.map((item, i) => ({ skuId: item.sku.skuId, amount: cartPriceLines[i] }))
        const coupons = await getAvailableCoupons(
          selectedCustomer.userId,
          subtotal,
          selectedStoreId || undefined,
          couponItems,
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
    const violation = findCartPurchaseLimitViolation(payload.items)
    if (violation) {
      toast.error(purchaseLimitMessage(violation.sku))
      return
    }
    const newCart: CartItem[] = payload.items.map(({ sku, quantity }) => ({
      sku,
      product: payload.product,
      quantity,
      bundleProductId: payload.bundleProductId,
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
      if (!emp || !isOrderServiceStaffCandidate(
        emp,
        selectedStoreId,
        stores.find((store) => store.storeId === selectedStoreId)?.marketName,
      )) {
        setSelectedEmployeeId("")
      }
    }
  }, [selectedStoreId, selectedEmployeeId, employees])

  // 会员判定（与后端 createOrder 同口径）：会员客 或 有钻石等级即会员；
  // 未选顾客默认非会员（普通商品只显示标价）。
  const buyerIsMember = isMember(selectedCustomer?.customerType, selectedCustomer?.memberLevel)

  // 订单类型派生（内部单走标价 ×50%）。catalogTotal 需与 cartPriceLines / Step2 单行同口径，故提前求值。
  const isInternal = orderType === '内部单'
  const isConversion = orderType === '转换单'
  const internalRatio = isInternal ? 0.5 : 1

  const activeKindData = kindDataCache[kindDataCacheKey(productKindChoice, selectedCustomer?.userId)]
  const tierCandidates = useMemo(
    () => activeKindData?.normalGroups.flatMap((group) => group.categories.flatMap((category) => category.skus)) ?? [],
    [activeKindData],
  )
  const tierLineAmounts = useMemo(
    () => calculateTreatmentTierLineAmounts(
      cart.map((item) => ({
        categoryId: item.sku.categoryId,
        specName: item.sku.specName,
        productType: item.sku.productType,
        sessionCount: item.sku.sessionCount,
        quantity: item.quantity,
        isExperience: item.sku.isExperience,
        isManagerSpecial: item.sku.isManagerSpecial,
        isBundle: !!item.bundleProductId || item.sku.bundlePrice != null || item.sku.bundleGroupId != null,
      })),
      tierCandidates,
      buyerIsMember,
      orderType,
    ),
    [buyerIsMember, cart, orderType, tierCandidates],
  )

  // 应付合计（购物车显示，不含手动覆盖）：按会员价分流取各行成交单价（套餐沿用套餐价，不分流）；
  // 内部单按标价 ×50%（与 cartPriceLines 同口径，否则 Step2「合计」对内部单显示 ~翻倍）
  const catalogTotal = cart.reduce((sum, item, index) => {
    const a = getItemAmounts(item, undefined, {
      buyerIsMember,
      isInternal,
      tierLineAmount: tierLineAmounts[index],
    })
    return sum + a.defaultSaleAmount * internalRatio
  }, 0)

  // 充值卡子流程（无购物车/优惠券/转换单，独立 Step 1/2/3 分支）
  const isRecharge = productKindChoice === '充值卡'
  const rechargeResolved = resolveRecharge(rechargeConfig, rechargeSelectedFace, rechargeCustomInput)
  const rechargeValid = rechargeResolved.faceValue > 0 && rechargeResolved.payAmount > 0 && !rechargeResolved.error

  // 内部单禁用手工改价（5 折规则后端再计算）；组合套餐允许向下调实付金额
  const suppressOverride = isInternal

  // 当前选中的订单级优惠券。实际抵扣额在转入项目和折抵卡金额都确定后计算。
  const selectedCouponForCalc = availableCoupons.find((c) => c.couponId === selectedCouponId)

  // 店长特别优惠：销售单/转换单 + SKU 标记 + 非套餐行（套餐 sku 带 bundlePrice/bundleGroupId）时
  // 允许店长在 Step3 手动修改应付金额（最低 0，不超过标价）。
  const canEditSaleAmount = (item: CartItem) =>
    !isInternal &&
    !(isConversion && isExperienceConversion) &&
    item.sku.isManagerSpecial === true &&
    item.sku.bundlePrice == null && item.sku.bundleGroupId == null

  // 各行「价格」（含内部单半价处理；店长特价行用手填应付作为 pre-coupon 基线）
  const cartPriceLines = useMemo(() => {
    return cart.map((item, index) => {
      // 店长特价行：pre-coupon 基线 = 手填应付（getItemAmounts 内已钳制 [0, 适用价小计]）
      if (canEditSaleAmount(item)) {
        return Math.round(getItemAmounts(item, priceOverrides[item.sku.skuId], {
          buyerIsMember,
          tierLineAmount: tierLineAmounts[index],
        }).saleAmount * 100) / 100
      }
      // 内部单：基线 = 标价 price × 数量（后端 ×50%，不分流）；销售单 = 会员价分流应付小计
      const a = getItemAmounts(item, undefined, {
        buyerIsMember,
        isInternal,
        tierLineAmount: tierLineAmounts[index],
      })
      return Math.round(a.defaultSaleAmount * internalRatio * 100) / 100
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, internalRatio, priceOverrides, isInternal, isConversion, buyerIsMember, tierLineAmounts])

  // 转换单：折抵合计 totalOut（已选卡）。优惠券仅可抵扣券前的正补差额，
  // 因此这里必须基于 cartPriceLines（含阶梯价和店长特价）而不是券后总额计算上限。
  const conversionTotalOut = useMemo(() => {
    if (!isConversion) return 0
    const set = new Set(selectedHeldCardIds)
    let sum = 0
    for (const c of heldCards) {
      if (set.has(c.saleItemId)) sum += Number(c.deductibleAmount)
    }
    return Math.round(sum * 100) / 100
  }, [isConversion, heldCards, selectedHeldCardIds])
  const couponBaseTotal = useMemo(
    () => Math.round(cartPriceLines.reduce((sum, amount) => sum + amount, 0) * 100) / 100,
    [cartPriceLines],
  )
  const conversionCouponCap = isConversion
    ? Math.max(0, Math.round((couponBaseTotal - conversionTotalOut) * 100) / 100)
    : 0
  const rawCouponDiscount = !isInternal && !isExperienceConversion && selectedCouponForCalc
    ? Math.max(0, Number(selectedCouponForCalc.discountAmount) || 0)
    : 0
  // 转换单券额以正补差额封顶，杜绝把多余券额转为充值卡余额。
  const couponDiscountTotal = isConversion
    ? Math.min(rawCouponDiscount, conversionCouponCap)
    : rawCouponDiscount

  // 各行摊到的券折扣（按 priceLines 比例，末行吸收尾差）
  const couponShares = useMemo(
    () => allocateDiscountPerLine(cartPriceLines, couponDiscountTotal),
    [cartPriceLines, couponDiscountTotal],
  )

  /**
   * perItemAmounts[i] = 本行最终展示金额
   * - saleAmount = 价格 - 摊到的券（应付金额；不可编辑）
   * - received   = priceOverrides.received（用户向下调）或默认 = saleAmount
   */
  const perItemAmounts = useMemo(() => {
    return cart.map((item, i) => {
      const priceLine = cartPriceLines[i]
      const couponShare = couponShares[i] || 0
      const saleAmount = Math.max(0, Math.round((priceLine - couponShare) * 100) / 100)
      const override = suppressOverride ? undefined : priceOverrides[item.sku.skuId]
      const receivedOverride = override?.received != null && override.received !== ''
        ? Number(override.received)
        : null
      const received = receivedOverride != null
        ? Math.min(Math.max(0, receivedOverride), saleAmount)
        : saleAmount
      // 适用成交单价（会员价分流；内部单不分流=标价；套餐沿用套餐价）+ 标价（划线基线）
      const defaultUnitPrice = getItemAmounts(item, undefined, {
        buyerIsMember,
        isInternal,
        tierLineAmount: tierLineAmounts[i],
      }).defaultUnitPrice
      const listUnitPrice = Number(item.sku.price)
      const isBundleItem = item.sku.bundlePrice != null || item.sku.bundleGroupId != null
      return {
        priceLine,
        couponShare,
        saleAmount,
        received,
        defaultUnitPrice,
        listUnitPrice,
        isBundleItem,
      }
    })
  }, [cart, cartPriceLines, couponShares, priceOverrides, suppressOverride, buyerIsMember, isInternal, tierLineAmounts])

  const { totalSaleAmount, totalReceived } = useMemo(() => {
    let sa = 0, rc = 0
    for (const a of perItemAmounts) {
      sa += a.saleAmount
      rc += a.received
    }
    return {
      totalSaleAmount: Math.round(sa * 100) / 100,
      totalReceived: Math.round(rc * 100) / 100,
    }
  }, [perItemAmounts])

  const rawSaleTotalBeforeDeductions = useMemo(
    () => Math.round(cartPriceLines.reduce((sum, amount) => sum + amount, 0) * 100) / 100,
    [cartPriceLines],
  )
  const pointsEnabledForOrder = !isInternal && !isConversion && !!selectedCustomer?.userId
  const pointsPreview = useMemo(
    () => computePointsPreview({
      enabled: pointsEnabledForOrder && usePoints,
      pointsInput,
      pointsBalance: customerPointsBalance,
      rawTotal: rawSaleTotalBeforeDeductions,
      currentAmount: totalSaleAmount,
      pointsToYuanRate,
      pointsDeductionMaxRate,
    }),
    [
      pointsEnabledForOrder,
      usePoints,
      pointsInput,
      customerPointsBalance,
      rawSaleTotalBeforeDeductions,
      totalSaleAmount,
      pointsToYuanRate,
      pointsDeductionMaxRate,
    ],
  )
  const pointShares = useMemo(
    () => allocateDiscountPerLine(perItemAmounts.map((a) => a.saleAmount), pointsPreview.pointsDiscount),
    [perItemAmounts, pointsPreview.pointsDiscount],
  )
  const perItemAmountsAfterPoints = useMemo(() => perItemAmounts.map((amounts, index) => {
    const pointsShare = pointShares[index] || 0
    const finalSaleAmount = Math.max(0, Math.round((amounts.saleAmount - pointsShare) * 100) / 100)
    const finalReceived = Math.min(amounts.received, finalSaleAmount)
    return { ...amounts, pointsShare, finalSaleAmount, finalReceived }
  }), [perItemAmounts, pointShares])
  const { totalSaleAmountAfterPoints, totalReceivedAfterPoints } = useMemo(() => {
    let sale = 0
    let received = 0
    for (const amounts of perItemAmountsAfterPoints) {
      sale += amounts.finalSaleAmount
      received += amounts.finalReceived
    }
    return {
      totalSaleAmountAfterPoints: Math.round(sale * 100) / 100,
      totalReceivedAfterPoints: Math.round(received * 100) / 100,
    }
  }, [perItemAmountsAfterPoints])

  const conversionPriceDiff = Math.round((totalSaleAmount - conversionTotalOut) * 100) / 100
  // 转换单充值卡抵扣：仅补差额 > 0 时可抵扣，上限 = min(余额, 补差额)
  const conversionCardMax = Math.min(Math.max(0, customerCardBalance), Math.max(0, conversionPriceDiff))
  const conversionCardAmount = isConversion && conversionPriceDiff > 0 && useCard
    ? clampPrepaidAmount(cardAmountInput, conversionCardMax)
    : 0
  const conversionRemainingPayable = isExperienceConversion
    ? 0
    : Math.max(0, Math.round((conversionPriceDiff - conversionCardAmount) * 100) / 100)
  const conversionReceivedAmount = conversionRemainingPayable <= 0
    ? 0
    : conversionReceivedInput.trim() === ''
      ? conversionRemainingPayable
      : Math.max(0, Math.min(Number(conversionReceivedInput) || 0, conversionRemainingPayable))

  // 折抵卡变化后若已没有正补差额，不能保留之前选中的优惠券。
  useEffect(() => {
    if (isConversion && (isExperienceConversion || conversionCouponCap <= 0) && selectedCouponId) {
      setSelectedCouponId("")
    }
  }, [conversionCouponCap, isConversion, isExperienceConversion, selectedCouponId])

  // 销售单/内部单充值卡抵扣：上限 = min(余额, 积分抵扣后的本次实收)；salePayable = 抵扣后应付现金
  const saleCardMax = Math.min(Math.max(0, customerCardBalance), Math.max(0, totalReceivedAfterPoints))
  const saleCardAmount = !isConversion && useCard
    ? clampPrepaidAmount(cardAmountInput, saleCardMax)
    : 0
  const salePayable = Math.max(0, Math.round((totalSaleAmountAfterPoints - saleCardAmount) * 100) / 100)
  const saleCashAmount = calculateSaleCashAmount(totalReceivedAfterPoints, saleCardAmount, salePayable)

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
                          <span className="font-medium min-w-[4em]">{c.name || "—"}</span>
                          <span className="text-[#999999]">{formatPhoneSafe(c.phone)}</span>
                          <MemberLevelBadge level={c.memberLevel} />
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
                        <p className="font-medium">{selectedCustomer.name || "—"}</p>
                      </div>
                      <div>
                        <span className="text-[#999999]">手机</span>
                        <p className="font-medium">{formatPhoneSafe(selectedCustomer.phone)}</p>
                      </div>
                      <div>
                        <span className="text-[#999999]">会员等级</span>
                        <div className="mt-1">
                          <MemberLevelBadge level={selectedCustomer.memberLevel} fallback="—" />
                        </div>
                      </div>
                      <div>
                        <span className="text-[#999999]">绑定门店</span>
                        <p className="font-medium">{selectedCustomer.storeName || "—"}</p>
                      </div>
                      <div>
                        <span className="text-[#999999]">绑定美容师</span>
                        <p className="font-medium">{selectedCustomer.employeeName || "—"}</p>
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
                  const cacheKey = kindDataCacheKey(productKindChoice, selectedCustomer?.userId)
                  if (!kindDataCache[cacheKey]) {
                    void prefetchKindData(productKindChoice, selectedCustomer?.userId)
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

      {/* Step 2（充值卡分支）：档位选择 */}
      {step === 1 && isRecharge && (
        <div className="space-y-4">
          <RechargePicker
            config={rechargeConfig}
            selectedFace={rechargeSelectedFace}
            customInput={rechargeCustomInput}
            onSelectFace={(face) => { setRechargeSelectedFace(face); setRechargeCustomInput("") }}
            onCustomChange={(v) => { setRechargeCustomInput(v); setRechargeSelectedFace(0) }}
          />
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(0)}>上一步</Button>
            <Button onClick={() => setStep(2)} disabled={!rechargeValid}>下一步</Button>
          </div>
        </div>
      )}

      {/* Step 2: 选择商品（PR-C：4 类 picker 渲染分支） */}
      {step === 1 && !isRecharge && (
        <div className="space-y-4">
          {(() => {
            const data = kindDataCache[kindDataCacheKey(productKindChoice, selectedCustomer?.userId)]
            if (!data && prefetching) {
              return <Card><CardContent className="p-6 text-sm text-[#999999]">正在加载 {productKindChoice} 数据…</CardContent></Card>
            }
            if (!data) {
              return (
                <Card>
                  <CardContent className="p-6 text-sm text-[#999999] flex items-center gap-3">
                    <span>{productKindChoice} 数据未加载</span>
                    <Button size="sm" variant="outline" onClick={() => void prefetchKindData(productKindChoice, selectedCustomer?.userId)}>
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
                    buyerIsMember={buyerIsMember}
                  />
                )
              case '体验卡':
                return (
                  <TrialCardPicker
                    categories={data.flatCategories}
                    kindLabel="体验卡"
                    cart={cart}
                    onAdd={addToCart}
                    buyerIsMember={buyerIsMember}
                  />
                )
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
                  {cart.map((item, index) => {
                    // 会员价分流：成交单价 = 会员价分流后的适用单价（套餐沿用套餐价，不分流）；
                    // 内部单按标价计价（行金额再 ×50%，与 catalogTotal 同口径，避免「合计半价/单行全价」不一致）
                    const amt = getItemAmounts(item, undefined, {
                      buyerIsMember,
                      isInternal,
                      tierLineAmount: tierLineAmounts[index],
                    })
                    const unitPrice = amt.defaultUnitPrice
                    const listUnit = Number(item.sku.price)
                    const isBundleItem = item.sku.bundlePrice != null || item.sku.bundleGroupId != null
                    // 行金额：内部单按标价 ×50%；划线仅会员价低于标价时（内部单 unitPrice=标价 → 不划线）
                    const rowAmount = Math.round(amt.defaultSaleAmount * internalRatio * 100) / 100
                    const showStrike = !isBundleItem && unitPrice < listUnit
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
                          <span className="font-medium text-right">
                            ¥{rowAmount.toLocaleString()}
                            {showStrike && (
                              <span className="line-through text-[#999999] text-xs ml-1">¥{(listUnit * item.quantity).toLocaleString()}</span>
                            )}
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
                onClick={() => void goToConfirm(couponBaseTotal)}
                disabled={cart.length === 0}
              >
                下一步
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Step 3（充值卡分支）：确认充值订单 */}
      {step === 2 && isRecharge && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <h2 className="text-base font-semibold">确认充值订单</h2>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#999999]">顾客</label>
                <p className="font-medium">{selectedCustomer?.name ?? "—"}</p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">充值面额</label>
                <p className="font-medium">¥{formatRechargeAmount(rechargeResolved.faceValue)}</p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">实付金额</label>
                <p className="font-medium text-[var(--primary)]">
                  ¥{formatRechargeAmount(rechargeResolved.payAmount)}
                  {rechargeResolved.faceValue - rechargeResolved.payAmount > 0 && (
                    <span className="ml-1 text-xs">{formatDiscountLabel(rechargeResolved.discount)}</span>
                  )}
                </p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">支付方式</label>
                <Select className="mt-1" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="微信">微信支付</option>
                  <option value="支付宝">支付宝</option>
                  <option value="线下">线下支付</option>
                </Select>
              </div>
              <div>
                <label className="text-sm text-[#999999]">入账门店</label>
                <Select className="mt-1" value={selectedStoreId} onChange={(e) => setSelectedStoreId(e.target.value)}>
                  {stores.map((s) => (
                    <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
                  ))}
                </Select>
              </div>
              <div className="col-span-2 md:col-span-3">
                <label className="text-sm text-[#999999]">备注（可选）</label>
                <Input
                  className="mt-1"
                  placeholder="例如：现金充值 / 微信转账"
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  maxLength={200}
                />
              </div>
            </div>

            <Separator />

            <div className="text-right space-y-1">
              <div className="text-sm text-[#999999]">充值面额: ¥{formatRechargeAmount(rechargeResolved.faceValue)}</div>
              {rechargeResolved.faceValue - rechargeResolved.payAmount > 0 && (
                <div className="text-sm text-[#3D8A5A]">
                  赠送: ¥{formatRechargeAmount(rechargeResolved.faceValue - rechargeResolved.payAmount)}
                </div>
              )}
              <div className="font-bold text-xl text-[var(--primary)]">
                实付金额: ¥{formatRechargeAmount(rechargeResolved.payAmount)}
              </div>
            </div>

            <p className="text-xs text-[#999999]">
              {paymentMethod === '线下'
                ? `· 线下支付：创建后在完成页「确认收款」即入账，储值卡余额 +¥${formatRechargeAmount(rechargeResolved.faceValue)}（按面额入账）`
                : `· 在线支付：创建后展示二维码给顾客扫码支付，支付成功后储值卡自动 +¥${formatRechargeAmount(rechargeResolved.faceValue)}（按面额入账）`}
            </p>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>上一步</Button>
              <Button loading={submitting} onClick={async () => {
                if (!selectedStoreId) { toast.error("请选择门店"); return }
                if (!selectedCustomer?.userId) { toast.error("请先选择顾客"); return }
                const resolved = resolveRecharge(rechargeConfig, rechargeSelectedFace, rechargeCustomInput)
                if (resolved.faceValue <= 0 || resolved.payAmount <= 0 || resolved.error) {
                  toast.error(resolved.error || "请选择充值金额"); return
                }
                setSubmitting(true)
                try {
                  const res = await createRechargeOrder({
                    clientUserId: selectedCustomer.userId,
                    storeId: selectedStoreId,
                    faceValue: resolved.faceValue,
                    paymentMethod: paymentMethod as '微信' | '支付宝' | '线下',
                    remark: remark.trim() || null,
                  })
                  if (res.success && res.saleOrderId) {
                    toast.success(res.message)
                    setCreatedOrderId(res.saleOrderId)
                    setRechargeResult({
                      saleOrderId: res.saleOrderId,
                      payAmount: res.payAmount ?? resolved.payAmount,
                      faceValue: resolved.faceValue,
                    })
                    setStep(3)
                  } else {
                    toast.error(res.message)
                  }
                } catch (err) {
                  toast.error(actionErrorMessage(err, "创建充值订单失败，请稍后重试"))
                } finally {
                  setSubmitting(false)
                }
              }}>提交充值订单</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: 确认订单（PR-C：订单类型 3 选 1 + 内部单/转换单分支） */}
      {step === 2 && !isRecharge && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <h2 className="text-base font-semibold">确认订单</h2>

            {/* 订单类型 3 选 1 */}
            <div>
              <label className="text-sm text-[#999999] block mb-2">订单类型</label>
              <div className="flex flex-wrap gap-2">
                {ORDER_TYPE_CHOICES.map((choice) => {
                  const disabled = choice === '转换单' && !conversionAllowed
                  const disabledReason = disabled ? "请先用搜索确认顾客身份" : undefined
                  return (
                    <button
                      key={choice}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleOrderTypeChange(choice)}
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
              {isInternal && (
                <p className="text-xs text-[#D4820A] mt-1">内部单 5 折，禁用手工改价 + 优惠券</p>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-[#999999]">顾客</label>
                <p className="font-medium">{selectedCustomer?.name ?? "—"}</p>
              </div>
              <div>
                <label className="text-sm text-[#999999]">支付方式</label>
                <Select className="mt-1" value={paymentMethod} onChange={(e) => {
                  // 线下与线上一致：逐行实付可编辑，切换支付方式保留已填实付
                  setPaymentMethod(e.target.value)
                }}>
                  <option value="微信">微信支付</option>
                  <option value="支付宝">支付宝</option>
                  <option value="线下">线下支付</option>
                </Select>
                {paymentMethod === '线下' && (
                  <p className="text-xs text-[#999999] mt-1">逐行填实付（同线上），提交后按实付扣除充值卡抵扣后的现金「确认收款」入账</p>
                )}
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
                  {getOrderServiceStaffCandidates(
                    employees,
                    selectedStoreId,
                    stores.find((store) => store.storeId === selectedStoreId)?.marketName,
                  ).map((e) => (
                    <option key={e.employeeId} value={e.employeeId}>{formatOrderServiceStaffOption(e, selectedStoreId)}</option>
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

              {/* 活动单标记（纯标识；转换单走独立提交，不带此标记） */}
              {!isConversion && (
                <div className="col-span-2 md:col-span-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isActivity}
                      onChange={(e) => setIsActivity(e.target.checked)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm text-[#666666]">活动（标记为活动订单）</span>
                  </label>
                </div>
              )}

              {/* 优惠券：转换单仅在券前存在正补差额时可用。 */}
              {selectedCustomer?.userId && !isInternal && (
                <div className="col-span-2 md:col-span-3">
                  <label className="text-sm text-[#999999]">优惠券（可选）</label>
                  {isConversion && conversionCouponCap <= 0 ? (
                    <p className="text-sm text-[#999999] mt-1">当前无正补差额，不能使用优惠券</p>
                  ) : loadingCoupons ? (
                    <p className="text-sm text-[#999999] mt-1">正在加载可用优惠券…</p>
                  ) : availableCoupons.length > 0 ? (
                    <Select
                      className="mt-1"
                      value={selectedCouponId}
                      onChange={(e) => setSelectedCouponId(e.target.value)}
                    >
                      <option value="">不使用优惠券</option>
                      {availableCoupons.map((c) => {
                        const displayedDiscount = isConversion
                          ? Math.min(Math.max(0, Number(c.discountAmount) || 0), conversionCouponCap)
                          : Math.max(0, Number(c.discountAmount) || 0)
                        return (
                          <option key={c.couponId} value={c.couponId}>
                            {c.name} — 优惠¥{displayedDiscount.toFixed(2)}（到期 {formatDate(c.expireAt) || "—"}）
                          </option>
                        )
                      })}
                    </Select>
                  ) : (
                    <p className="text-sm text-[#999999] mt-1">暂无可用优惠券</p>
                  )}
                </div>
              )}

              {/* 积分与优惠券同级：先确定订单级抵扣，再展示分摊后的商品明细。 */}
              {pointsEnabledForOrder && (
                <div className="col-span-2 md:col-span-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-[#999999]">积分抵扣（可用 {customerPointsBalance.toLocaleString()} 分）</label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={usePoints}
                        disabled={customerPointsBalance <= 0 || pointsPreview.maxPoints <= 0}
                        onChange={(e) => setUsePoints(e.target.checked)}
                        className="h-4 w-4"
                      />
                      <span className={`text-xs ${customerPointsBalance <= 0 ? 'text-[#cccccc]' : 'text-[#666666]'}`}>
                        启用
                      </span>
                    </label>
                  </div>
                  {usePoints && customerPointsBalance > 0 && pointsPreview.maxPoints > 0 ? (
                    <div className="mt-1 flex items-center gap-2">
                      <Input
                        type="number"
                        min="0"
                        max={pointsPreview.maxPoints}
                        step="1"
                        className="h-9 text-sm w-28"
                        placeholder={`留空=${pointsPreview.maxPoints}`}
                        value={pointsInput}
                        onChange={(e) => setPointsInput(e.target.value)}
                      />
                      <span className="text-xs text-[#3D8A5A]">
                        -¥{pointsPreview.pointsDiscount.toFixed(2)}（{pointsPreview.pointsUsed.toLocaleString()}积分）
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-[#999999] mt-1">
                      {customerPointsBalance <= 0 ? '暂无可抵扣积分' : `最多抵 ¥${pointsPreview.maxDiscount.toFixed(2)}`}
                    </p>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* 商品清单 — 转换单展示转入明细 + ConversionPanel；销售/内部单走原表单 */}
            {isConversion ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-3">转入商品</h3>
                  <div className="grid grid-cols-10 gap-2 text-xs text-[#999999] px-3 mb-1">
                    <span className="col-span-3">商品规格</span>
                    <span className="col-span-1 text-center">数量</span>
                    <span className="col-span-2 text-right">价格</span>
                    <span className="col-span-2 text-right">应付金额</span>
                    <span className="col-span-2 text-center">操作</span>
                  </div>
                  <div className="space-y-2">
                    {cart.map((item, idx) => {
                      const a = perItemAmounts[idx]
                      if (!a) return null
                      const override = priceOverrides[item.sku.skuId]
                      const canEditSale = canEditSaleAmount(item)
                      const hasSaleOverride = canEditSale && override?.saleAmount != null && override.saleAmount !== ''
                      const defaultSale = a.defaultUnitPrice * item.quantity

                      return (
                        <div key={item.sku.skuId} className="grid grid-cols-10 gap-2 items-center bg-[#FAFAFA] rounded px-3 py-2 text-sm">
                          <span className="col-span-3 truncate" title={`${item.product.name} - ${item.sku.specName}`}>
                            {item.product.name} - {item.sku.specName}
                          </span>
                          <span className="col-span-1 text-center">{item.quantity}</span>
                          <span className="col-span-2 text-right text-[#999999]">
                            {!a.isBundleItem && a.defaultUnitPrice < a.listUnitPrice ? (
                              <>
                                <span className="text-[var(--primary)]">¥{a.priceLine.toFixed(2)}</span>
                                <span className="line-through text-[#999999] text-xs ml-1">¥{(a.listUnitPrice * item.quantity).toFixed(2)}</span>
                              </>
                            ) : (
                              <>¥{a.priceLine.toFixed(2)}</>
                            )}
                          </span>
                          {canEditSale ? (
                            <div className="col-span-2">
                              <Input
                                type="number"
                                min="0"
                                max={defaultSale}
                                step="0.01"
                                title="店长特别优惠：可向下调应付金额（最低 0）"
                                className="h-8 text-sm text-right border-[var(--primary)]"
                                value={hasSaleOverride ? (override!.saleAmount as string) : defaultSale.toFixed(2)}
                                onChange={(e) => {
                                  setPriceOverrides(prev => ({
                                    ...prev,
                                    [item.sku.skuId]: {
                                      saleAmount: e.target.value,
                                      received: prev[item.sku.skuId]?.received ?? null,
                                      receivedTouched: prev[item.sku.skuId]?.receivedTouched ?? false,
                                    }
                                  }))
                                }}
                              />
                            </div>
                          ) : (
                            <span className="col-span-2 text-right">¥{a.saleAmount.toFixed(2)}</span>
                          )}
                          <div className="col-span-2 flex justify-center">
                            {hasSaleOverride && (
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
                </div>
                <ConversionPanel
                  loading={heldCardsLoading}
                  heldCards={heldCards}
                  selectedIds={selectedHeldCardIds}
                  onChange={setSelectedHeldCardIds}
                  totalIn={totalSaleAmount}
                  cardBalance={customerCardBalance}
                  useCard={useCard}
                  cardAmountInput={cardAmountInput}
                  cardAmount={conversionCardAmount}
                  onToggleCard={(checked) => {
                    setUseCard(checked)
                    setCardAmountInput('0.00')
                  }}
                  onCardAmountChange={setCardAmountInput}
                  onCardAmountBlur={() => {
                    setCardAmountInput((value) => clampPrepaidAmount(value, conversionCardMax).toFixed(2))
                  }}
                  isExperienceConversion={isExperienceConversion}
                  onExperienceConversionChange={(checked) => {
                    setIsExperienceConversion(checked)
                    setConversionReceivedInput("")
                    if (checked) {
                      setUseCard(false)
                      setCardAmountInput("0.00")
                      setSelectedCouponId("")
                      setPriceOverrides({})
                    }
                  }}
                  receivedAmountInput={conversionReceivedInput === "" ? conversionRemainingPayable.toFixed(2) : conversionReceivedInput}
                  receivedAmount={conversionReceivedAmount}
                  remainingPayable={conversionRemainingPayable}
                  onReceivedAmountChange={setConversionReceivedInput}
                  onReceivedAmountBlur={() => setConversionReceivedInput(conversionReceivedAmount.toFixed(2))}
                />
              </div>
            ) : (
              <div>
                <h3 className="text-sm font-semibold mb-3">商品清单</h3>
                {/* 表头 */}
                <div className="grid grid-cols-12 gap-2 text-xs text-[#999999] px-3 mb-1">
                  <span className="col-span-3">商品规格</span>
                  <span className="col-span-1 text-center">数量</span>
                  <span className="col-span-2 text-right">价格</span>
                  <span className="col-span-2 text-right">应付金额</span>
                  <span className="col-span-2 text-right">实付金额</span>
                  <span className="col-span-2 text-center">操作</span>
                </div>
                <div className="space-y-2">
                  {cart.map((item, idx) => {
                    const a = perItemAmountsAfterPoints[idx]
                    if (!a) return null
                    // 内部单锁定逐行实付（禁用改价）；线下与线上一致，逐行实付可编辑（实收合计在「确认收款」一键入账）
                    const lockReceived = suppressOverride
                    const override = lockReceived ? undefined : priceOverrides[item.sku.skuId]
                    const hasReceivedOverride = !lockReceived && override?.received != null && override.received !== ''
                    // 店长特别优惠：该普通商品行允许手动改应付金额（销售单 + 非套餐）
                    const canEditSale = canEditSaleAmount(item)
                    const hasSaleOverride = canEditSale && override?.saleAmount != null && override.saleAmount !== ''
                    // 标价小计（pre-coupon 应付上界）
                    const defaultSale = a.defaultUnitPrice * item.quantity
                    const hasAnyOverride = hasReceivedOverride || hasSaleOverride

                    return (
                      <div key={item.sku.skuId} className="grid grid-cols-12 gap-2 items-center bg-[#FAFAFA] rounded px-3 py-2 text-sm">
                        <span className="col-span-3 truncate" title={`${item.product.name} - ${item.sku.specName}`}>
                          {item.product.name} - {item.sku.specName}
                        </span>
                        <span className="col-span-1 text-center">{item.quantity}</span>
                        <span className="col-span-2 text-right text-[#999999]">
                          {isInternal ? (
                            <>
                              <span className="line-through mr-1">¥{(a.listUnitPrice * item.quantity).toFixed(2)}</span>
                              <span className="text-[var(--primary)]">¥{a.priceLine.toFixed(2)}</span>
                            </>
                          ) : (!a.isBundleItem && a.defaultUnitPrice < a.listUnitPrice) ? (
                            // 会员价 < 标价：会员价为主 + 划线标价（套餐不分流，不划线）
                            <>
                              <span className="text-[var(--primary)]">¥{a.priceLine.toFixed(2)}</span>
                              <span className="line-through text-[#999999] text-xs ml-1">¥{(a.listUnitPrice * item.quantity).toFixed(2)}</span>
                            </>
                          ) : (
                            <>¥{a.priceLine.toFixed(2)}</>
                          )}
                        </span>
                        {/* 应付金额：店长特别优惠可编辑（向下调，0 ≤ 应付 ≤ 标价），否则只读（仅由订单级优惠券冲抵） */}
                        {canEditSale ? (
                          <div className="col-span-2">
                            <Input
                              type="number"
                              min="0"
                              max={defaultSale}
                              step="0.01"
                              title="店长特别优惠：可向下调应付金额（最低 0）"
                              className="h-8 text-sm text-right border-[var(--primary)]"
                              value={hasSaleOverride ? (override!.saleAmount as string) : defaultSale.toFixed(2)}
                              onChange={(e) => {
                                setPriceOverrides(prev => ({
                                  ...prev,
                                  [item.sku.skuId]: {
                                    saleAmount: e.target.value,
                                    received: prev[item.sku.skuId]?.received ?? null,
                                    receivedTouched: prev[item.sku.skuId]?.receivedTouched ?? false,
                                  }
                                }))
                              }}
                            />
                            {(a.couponShare > 0 || a.pointsShare > 0) && (
                              <div className="mt-1 text-right text-[10px] text-[#3D8A5A]">
                                抵扣后 ¥{a.finalSaleAmount.toFixed(2)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="col-span-2 text-right">
                            ¥{a.finalSaleAmount.toFixed(2)}
                            {a.couponShare > 0 && (
                              <span className="ml-1 block text-[10px] text-[#3D8A5A]">券 -¥{a.couponShare.toFixed(2)}</span>
                            )}
                            {a.pointsShare > 0 && (
                              <span className="ml-1 block text-[10px] text-[#3D8A5A]">积分 -¥{a.pointsShare.toFixed(2)}</span>
                            )}
                          </span>
                        )}
                        {/* 实付金额：可编辑（默认=应付，向下调） */}
                        <div className="col-span-2">
                          <Input
                            type="number"
                            min="0"
                            max={a.finalSaleAmount}
                            step="0.01"
                            disabled={lockReceived}
                            className="h-8 text-sm text-right"
                            value={hasReceivedOverride ? (override!.received as string) : a.finalReceived.toFixed(2)}
                            onChange={(e) => {
                              if (lockReceived) return
                              setPriceOverrides(prev => ({
                                ...prev,
                                [item.sku.skuId]: {
                                  saleAmount: prev[item.sku.skuId]?.saleAmount ?? null,
                                  received: e.target.value,
                                  receivedTouched: true,
                                }
                              }))
                            }}
                            onBlur={(e) => {
                              const clamped = Math.max(0, Math.min(Number(e.target.value) || 0, a.finalSaleAmount))
                              setPriceOverrides(prev => ({
                                ...prev,
                                [item.sku.skuId]: {
                                  saleAmount: prev[item.sku.skuId]?.saleAmount ?? null,
                                  received: clamped.toFixed(2),
                                  receivedTouched: true,
                                }
                              }))
                            }}
                          />
                        </div>
                        <div className="col-span-2 flex justify-center">
                          {hasAnyOverride && (
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
                {/* 充值卡抵扣 UI（admin 新增；商品清单下方） */}
                {!isConversion && selectedCustomer?.userId && (() => {
                  return (
                    <div className="mt-4 border border-[var(--border)] rounded p-3 bg-white">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-medium text-[var(--foreground)]">充值卡抵扣</div>
                          <div className="text-xs text-[#999999] mt-0.5">
                            余额 ¥{customerCardBalance.toFixed(2)}
                          </div>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useCard}
                            disabled={customerCardBalance <= 0 || saleCardMax <= 0}
                            onChange={(e) => {
                              setUseCard(e.target.checked)
                              setCardAmountInput('0.00')
                            }}
                            className="h-4 w-4"
                          />
                          <span className={`text-xs ${customerCardBalance <= 0 || saleCardMax <= 0 ? 'text-[#cccccc]' : 'text-[#666666]'}`}>
                            启用
                          </span>
                        </label>
                      </div>
                      {useCard && customerCardBalance > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-xs text-[#999999]">抵扣金额</span>
                          <Input
                            type="number"
                            min="0"
                            max={saleCardMax}
                            step="0.01"
                            className="h-8 text-sm w-32"
                            placeholder="0.00"
                            value={cardAmountInput}
                            onChange={(e) => setCardAmountInput(e.target.value)}
                            onBlur={(e) => setCardAmountInput(clampPrepaidAmount(e.target.value, saleCardMax).toFixed(2))}
                          />
                          <span className="text-xs text-[#999999]">最多可抵扣 ¥{saleCardMax.toFixed(2)}</span>
                          <span className="text-xs text-[#3D8A5A]">实际抵扣 ¥{saleCardAmount.toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  )
                })()}
                {/* 金额汇总（应付合计 = Σ saleAmount = Σ priceLine - 券折扣 - 积分抵扣；订单总额 = 应付 - 充值卡抵扣） */}
                {(() => {
                  const finalAmount = salePayable
                  return (
                    <div className="text-right pt-4 space-y-1">
                      {isInternal && (
                        <div className="flex justify-end">
                          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-[#888888]">内部单 5 折</span>
                        </div>
                      )}
                      <div className="text-sm text-[#999999]">
                        应付合计: ¥{totalSaleAmountAfterPoints.toFixed(2)}
                      </div>
                      {pointsPreview.pointsDiscount > 0 && (
                        <div className="text-sm text-[#3D8A5A]">
                          积分抵扣: -¥{pointsPreview.pointsDiscount.toFixed(2)}
                        </div>
                      )}
                      {totalReceivedAfterPoints !== totalSaleAmountAfterPoints && (
                        <div className="text-sm text-[#999999]">
                          实付合计: ¥{totalReceivedAfterPoints.toFixed(2)}
                        </div>
                      )}
                      {saleCardAmount > 0 && (
                        <div className="text-sm text-[#3D8A5A]">
                          充值卡抵扣: -¥{saleCardAmount.toFixed(2)}
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
                      convertInItems: cart.map((item, index) => {
                        const override = isExperienceConversion ? undefined : priceOverrides[item.sku.skuId]
                        const amounts = getItemAmounts(item, override, {
                          buyerIsMember,
                          tierLineAmount: tierLineAmounts[index],
                        })
                        return {
                          skuId: item.sku.skuId,
                          productName: item.product.name,
                          productType: item.sku.productType as '疗程卡' | '家居产品',
                          sessionCount: item.sku.sessionCount,
                          unitPrice: item.sku.price,
                          unitRealPrice: (amounts.saleAmount / item.quantity).toFixed(2),
                          saleAmount: amounts.saleAmount.toFixed(2),
                          quantity: item.quantity,
                        }
                      }),
                      prepaidCardAmount: isExperienceConversion ? 0 : conversionCardAmount,
                      couponId: isExperienceConversion ? undefined : (selectedCouponId || undefined),
                      receivedAmount: isExperienceConversion ? 0 : conversionReceivedAmount,
                      isExperienceConversion,
                    })
                    if (res.success && res.saleOrderId) {
                      toast.success(res.message)
                      setCreatedOrderId(res.saleOrderId)
                      setConversionResult({
                        totalIn: res.totalIn ?? 0,
                        totalOut: res.totalOut ?? 0,
                        priceDiff: res.priceDiff ?? 0,
                        prepaidCardCredit: res.prepaidCardCredit ?? 0,
                        prepaidCardAmount: res.prepaidCardAmount ?? 0,
                        isExperienceConversion: res.isExperienceConversion ?? false,
                        receivedAmount: res.receivedAmount ?? 0,
                        remainingAmount: res.remainingAmount ?? 0,
                      })
                      setCreatedStatus((res.remainingAmount ?? 0) > 0 ? '待支付' : '已支付')
                      setCreatedPayable(res.remainingAmount ?? 0)
                      setConfirmAmountInput((res.receivedAmount ?? 0).toFixed(2))
                      setStep(3)
                    } else {
                      toast.error(res.message)
                    }
                  } catch (err) {
                    toast.error(actionErrorMessage(err, "创建转换单失败，请稍后重试"))
                  } finally {
                    setSubmitting(false)
                  }
                  return
                }

                // 销售单 / 内部单 — 走原 createOrder
                // 校验手动金额（内部单跳过 priceOverrides，因为禁用了改价）
                if (!suppressOverride) {
                  for (const [index, item] of cart.entries()) {
                    const amounts = getItemAmounts(item, priceOverrides[item.sku.skuId], {
                      buyerIsMember,
                      isInternal,
                      tierLineAmount: tierLineAmounts[index],
                    })
                    if (isNaN(amounts.saleAmount) || amounts.saleAmount < 0) {
                      toast.error(`${item.product.name} 的应付金额无效`); return
                    }
                    const receivedOverride = priceOverrides[item.sku.skuId]?.received
                    const received = receivedOverride != null && receivedOverride !== ''
                      ? Number(receivedOverride)
                      : perItemAmountsAfterPoints[index]?.finalReceived ?? 0
                    if (isNaN(received) || received < 0) {
                      toast.error(`${item.product.name} 的实付金额无效`); return
                    }
                  }
                }
                if (
                  paymentMethod !== '线下' &&
                  requiresOfflineCardOnlyConfirmation(saleCardAmount, saleCashAmount, salePayable)
                ) {
                  toast.error('本次实付已全部使用充值卡抵扣，订单仍有欠款，请选择线下支付后确认收款')
                  return
                }
                // 本次收款金额：
                // - 线上（微信/支付宝）：= 本次逐行实付 - 充值卡抵扣；< 全额时后端落 first_payment_amount，QR 收限额
                // - 线下：传 0 —— 开单不收款，实收金额在 Step 4「确认收款」环节登记（后端对线下亦强制忽略此值）
                const receivedAmountArg = paymentMethod === '线下' ? 0 : saleCashAmount

                setSubmitting(true)
                try {
                  // 2026-07-08 修复 T1：顾客档案未填写姓名时禁止开单。
                  // 后端 createOrder 现在会以 clientWechatUsers.name 为权威覆写，但此处
                  // 阻断可避免「sale_orders.customer_name 一直是 null 等待后端回填」的中间态。
                  // admin 端无法让顾客填姓名，提示先到顾客档案补全。
                  if (!selectedCustomer!.name || !selectedCustomer!.name.trim()) {
                    toast.error('该顾客未设置姓名，请先到顾客档案补全姓名后再开单');
                    setSubmitting(false);
                    return;
                  }
                  const store = stores.find((s) => s.storeId === selectedStoreId)
                  // BundlePicker 的兼容 onAdd 路径未携带 bundleProductId；此时回退到套餐占位 product。
                  const bundleCartItem = cart.find((item) => item.bundleProductId || item.product.isBundle)
                  const bundleProductId = bundleCartItem?.bundleProductId
                    ?? (bundleCartItem?.product.isBundle ? bundleCartItem.product.productId : undefined)
                  const res = await createOrder({
                    storeId: selectedStoreId,
                    marketName: store?.marketName || "未知市场",
                    clientUserId: selectedCustomer!.userId,
                    clientPhone: selectedCustomer!.phone ?? '',
                    customerName: selectedCustomer!.name!.trim(),
                    paymentMethod: paymentMethod as '微信' | '支付宝' | '线下',
                    saleOrderType: orderType,
                    preferredEmployeeId: selectedEmployeeId || undefined,
                    remark: remark.trim() || null,
                    isActivity,
                    couponId: !isInternal ? (selectedCouponId || null) : null,
                    receivedAmount: receivedAmountArg,
                    usePoints: pointsPreview.pointsUsed > 0,
                    pointsUsed: pointsPreview.pointsUsed > 0 ? pointsPreview.pointsUsed : undefined,
                    prepaidCardAmount: saleCardAmount,
                    bundleProductId,
                    items: cart.map((item, index) => {
                      // 后端为定价权威：普通商品按会员价分流重定价（忽略此处单价），店长特价钳制，
                      // 套餐(isBundle)维持现状；内部单后端按标价 ×0.5（前端传原价 saleAmount，不预先半价）。
                      const isBundleItem = !!item.bundleProductId || item.sku.bundlePrice != null || item.sku.bundleGroupId != null
                      const override = suppressOverride ? undefined : priceOverrides[item.sku.skuId]
                      const amounts = getItemAmounts(item, override, {
                        buyerIsMember,
                        isInternal,
                        tierLineAmount: tierLineAmounts[index],
                      })
                      return {
                        skuId: item.sku.skuId,
                        productName: item.product.name,
                        productType: item.sku.productType as '疗程卡' | '家居产品',
                        sessionCount: item.sku.sessionCount,
                        unitPrice: item.sku.price,
                        unitRealPrice: (amounts.saleAmount / item.quantity).toFixed(2),
                        quantity: item.quantity,
                        saleAmount: amounts.saleAmount.toFixed(2),
                        // 仅实付传最终行上限；应付仍传抵扣前基数，由服务端统一摊券、摊积分。
                        received: (perItemAmountsAfterPoints[index]?.finalReceived ?? 0).toFixed(2),
                        salesCategory: null,
                        isBundle: isBundleItem,
                      }
                    }),
                  })
                  if (res.success) {
                    toast.success(res.message)
                    setCreatedOrderId(res.saleOrderId || "")
                    setCreatedStatus(res.status ?? null)
                    setCreatedPayable(salePayable)
                    // 线下：确认收款金额 = 本次逐行实付扣除充值卡抵扣后的现金。
                    setConfirmAmountInput(paymentMethod === '线下' ? saleCashAmount.toFixed(2) : "")
                    setConfirmResultStatus(null)
                    setConversionResult(null)
                    setStep(3)
                  } else {
                    toast.error(res.message)
                  }
                } catch (err) {
                  toast.error(actionErrorMessage(err, "创建订单失败，请稍后重试"))
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
              {paymentConfirmed
                ? (confirmResultStatus === '部分支付' ? '已确认部分收款' : '收款已确认')
                : rechargeResult
                ? '充值订单已创建'
                : conversionResult
                  ? '转换单已创建'
                  : '订单创建成功'}
            </h2>
            {createdOrderId && (
              <p className="text-sm font-mono text-[var(--primary)]">{createdOrderId}</p>
            )}

            {/* 充值单成功文案分支 */}
            {rechargeResult ? (
              <div className="text-sm space-y-1">
                <p className="text-[#666666]">
                  面额 ¥{formatRechargeAmount(rechargeResult.faceValue)} ｜ 实付 ¥{formatRechargeAmount(rechargeResult.payAmount)}
                </p>
                {paymentConfirmed ? (
                  <p className="text-[#3D8A5A]">储值卡已入账 +¥{formatRechargeAmount(rechargeResult.faceValue)}</p>
                ) : paymentMethod === '线下' ? (
                  <p className="text-[#D4820A]">
                    线下充值：请点击下方「确认收款」完成入账，储值卡余额将 +¥{formatRechargeAmount(rechargeResult.faceValue)}
                  </p>
                ) : (
                  <p className="text-[#D4820A]">
                    请将二维码展示给顾客扫码支付，支付成功后储值卡自动 +¥{formatRechargeAmount(rechargeResult.faceValue)}
                  </p>
                )}
              </div>
            ) : conversionResult ? (
              <div className="text-sm space-y-1">
                <p className="text-[#666666]">
                  转入 ¥{conversionResult.totalIn.toFixed(2)} ｜ 折抵 ¥{conversionResult.totalOut.toFixed(2)}
                </p>
                {conversionResult.isExperienceConversion && (
                  <p className="text-[var(--primary)] font-semibold">体验转换：已按旧卡价值锁价，应付与实付均为 ¥0.00</p>
                )}
                {conversionResult.prepaidCardAmount > 0 && (
                  <p className="text-[#3D8A5A]">
                    储值卡抵扣 ¥{conversionResult.prepaidCardAmount.toFixed(2)}
                  </p>
                )}
                {(() => {
                  const remaining = Math.max(0, Math.round((conversionResult.priceDiff - conversionResult.prepaidCardAmount) * 100) / 100)
                  if (conversionResult.priceDiff > 0 && remaining > 0) {
                    return (
                      <p className="text-[#D94040] font-semibold">
                        本次收款 ¥{conversionResult.receivedAmount.toFixed(2)}，剩余挂账 ¥{Math.max(0, remaining - conversionResult.receivedAmount).toFixed(2)}
                      </p>
                    )
                  }
                  if (conversionResult.priceDiff > 0 && remaining <= 0) {
                    return (
                      <p className="text-[#3D8A5A] font-semibold">储值卡全额抵扣，差额已结清</p>
                    )
                  }
                  if (conversionResult.priceDiff === 0) {
                    return <p className="text-[#3D8A5A] font-semibold">折抵完成，无需收款</p>
                  }
                  return (
                    <p className="text-[#5E8BB3] font-semibold">
                      差额 ¥{conversionResult.prepaidCardCredit.toFixed(2)} 已充入储值卡
                    </p>
                  )
                })()}
              </div>
            ) : (
              <p className="text-sm text-[#999999]">
                {paymentConfirmed
                  ? (confirmResultStatus === '部分支付'
                      ? `已确认收款 ¥${Number(confirmAmountInput || 0).toFixed(2)}，剩余 ¥${Math.max(0, createdPayable - Number(confirmAmountInput || 0)).toFixed(2)} 待收，请到订单详情「录入回款」补齐`
                      : '订单已确认收款，状态已更新为已支付')
                  : createdStatus === '已支付'
                    ? (saleCardAmount > 0
                        ? `订单已由储值卡全额抵扣 ¥${saleCardAmount.toFixed(2)}，已结清`
                        : pointsPreview.pointsDiscount > 0
                          ? `订单已由积分抵扣 ¥${pointsPreview.pointsDiscount.toFixed(2)}，已结清`
                          : '订单已结清')
                    : paymentMethod === '线下'
                      ? '线下收款（等同线上扫码）：按商品实付扣除充值卡抵扣后的现金，点「确认收款」入账'
                      : '请将二维码展示给顾客，扫码进入小程序完成支付'}
              </p>
            )}

            {/* 微信/支付宝支付：可打印 QR 码（销售/内部单 + 转换单仍需补现金 + 充值单在线支付场景；
                部分支付 / 全额储值卡抵扣已结清 不显示二维码）*/}
            {paymentMethod !== '线下' && createdOrderId && !paymentConfirmed
              && createdStatus !== '部分支付' && createdStatus !== '已支付'
              && (!conversionResult || conversionResult.receivedAmount > 0)
              && (!conversionResult || (conversionResult.priceDiff - conversionResult.prepaidCardAmount) > 0.005) && (
              <OrderQRCode orderId={createdOrderId} />
            )}

            {/* 线下支付：确认收款（待支付状态显示）。
                普通销售/内部单可下调本次确认金额做部分确认；充值单 / 转换单走全额确认（all-or-nothing）。
                转换单全额储值卡抵扣已结清（无剩余应付）则不显示确认收款。*/}
            {paymentMethod === '线下' && createdOrderId && !paymentConfirmed
              && createdStatus !== '已支付'
              && (!conversionResult || conversionResult.receivedAmount > 0)
              && (!conversionResult || (conversionResult.priceDiff - conversionResult.prepaidCardAmount) > 0.005) && (
              <div className="pt-2 space-y-2 max-w-xs mx-auto">
                {!rechargeResult && !conversionResult && (
                  <>
                    <div className="rounded bg-[#F5F5F5] px-4 py-3 text-left">
                      <p className="text-sm text-[#999999]">将确认收款（商品实付扣除充值卡抵扣后的现金）</p>
                      <p className="text-2xl font-semibold text-[var(--primary)]">¥{Number(confirmAmountInput || 0).toFixed(2)}</p>
                      {Number(confirmAmountInput || 0) + 0.005 < createdPayable && (
                        <p className="text-xs text-[#D4820A] mt-1">
                          较应付现金 ¥{createdPayable.toFixed(2)} 少 ¥{(createdPayable - Number(confirmAmountInput || 0)).toFixed(2)}，将落「部分支付」
                        </p>
                      )}
                    </div>
                    <p className="text-xs text-[#999999] text-left">
                      实付在商品清单逐行录入；少收的剩余可在订单详情「录入回款」补齐
                    </p>
                  </>
                )}
                <Button
                  loading={confirming}
                  className="bg-[#3D8A5A] hover:bg-[#2E6B45] text-white w-full"
                  onClick={async () => {
                    // 普通销售/内部单及转换单均按页面上的本次实付确认；充值单仍全额确认。
                    const isPlainSale = !rechargeResult && !conversionResult
                    const shouldUseConfirmAmount = (isPlainSale || !!conversionResult) && confirmAmountInput.trim() !== ''
                    const amt = shouldUseConfirmAmount
                      ? Math.round(Number(confirmAmountInput) * 100) / 100
                      : undefined
                    if (amt !== undefined && (!Number.isFinite(amt) || amt < 0)) {
                      toast.error('确认金额无效')
                      return
                    }
                    setConfirming(true)
                    try {
                      const res = await confirmOfflinePayment(createdOrderId, amt)
                      if (res.success) {
                        toast.success(res.message)
                        setPaymentConfirmed(true)
                        setConfirmResultStatus(res.status === '部分支付' ? '部分支付' : '已支付')
                      } else {
                        toast.error(res.message)
                      }
                    } catch (err) {
                      toast.error(actionErrorMessage(err, '确认收款失败，请稍后重试'))
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
                setStep(0); setCart([]); setSelectedCustomer(null); setSearchKeyword(""); setSearchResults([]); setCreatedOrderId(""); setSearchDone(false); setPaymentConfirmed(false); setSelectedCouponId(""); setAvailableCoupons([]); setPriceOverrides({}); setOrderType("销售单")
                setCreatedStatus(null); setCreatedPayable(0)
                setConfirmAmountInput(""); setConfirmResultStatus(null)
                setCustomerCardBalance(0); setUseCard(false); setCardAmountInput('0.00')
                setProductKindChoice('普通商品')
                setKindDataCache({ 组合套餐: undefined, 普通商品: undefined, 体验卡: undefined })
                setHeldCards([])
                setSelectedHeldCardIds([])
                setIsExperienceConversion(false); setConversionReceivedInput("")
                setConversionResult(null)
                setRechargeSelectedFace(0); setRechargeCustomInput(""); setRechargeResult(null)
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
      .catch((err) => setError(actionErrorMessage(err, "生成小程序码失败")))
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
