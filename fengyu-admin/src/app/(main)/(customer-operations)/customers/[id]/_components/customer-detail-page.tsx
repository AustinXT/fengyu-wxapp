"use client"

import { useState, useMemo, useRef, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import type { Customer, SaleOrder, Appointment, SaleItem, Store, Employee, CustomerCoupon, CouponStatus } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { MemberLevelBadge } from "@/components/ui/member-level-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils"
import { formatPhoneSafe } from "@/lib/format"
import { actionErrorMessage } from "@/lib/action-error"
import { updateCustomer, mergeClientProfile, type PhoneChangeLog, type OrphanProfile, type CustomerServiceRecord } from "@/actions/customers"
import { searchEmployees } from "@/actions/employees"
import PullWorkfineDialog from "@/app/(main)/(operations)/legacy-orders/_components/pull-workfine-dialog"
import { DangerZoneDelete } from "@/components/delete-action"
import { deleteCustomer } from "@/actions/customers"
import { getCustomerVisibleSaleItems, type CustomerVisibleSaleItem } from "./customer-entitlement-items"
import type { CustomerHomeProduct } from "@/lib/home-product"

interface CustomerDetailPageProps {
  customer: Customer
  orders: SaleOrder[]
  homeProducts: CustomerHomeProduct[]
  appointments: Appointment[]
  stores: Store[]
  employees: Employee[]
  phoneChangeLogs: PhoneChangeLog[]
  serviceOrders: CustomerServiceRecord[]
  coupons: CustomerCoupon[]
  orphanProfiles: OrphanProfile[]
  prepaidBalance?: string
  canUpdate?: boolean
  canMerge?: boolean
  canListEmployees?: boolean
  canEditPhone?: boolean
  canPullLegacy?: boolean
  /** 是否展示「危险操作」删除入口（仅系统管理员 customer:delete） */
  canDelete?: boolean
}

function formatDistinctSkuName(row: Pick<SaleItem, "productName" | "skuName">): string {
  const productName = (row.productName ?? "").trim()
  const skuName = (row.skuName ?? "").trim()
  if (!skuName || skuName === productName) return "—"
  return skuName
}

export default function CustomerDetailPage({
  customer,
  orders,
  homeProducts,
  appointments,
  stores,
  employees,
  phoneChangeLogs,
  serviceOrders,
  coupons,
  orphanProfiles,
  prepaidBalance,
  canUpdate = false,
  canMerge = false,
  canListEmployees = false,
  canEditPhone = false,
  canPullLegacy = false,
  canDelete = false,
}: CustomerDetailPageProps) {
  const router = useRouter()
  const [merging, setMerging] = useState<string | null>(null)
  const [pullLegacyOpen, setPullLegacyOpen] = useState(false)
  const [couponStatus, setCouponStatus] = useState<"" | CouponStatus>("")
  const [cardProductKind, setCardProductKind] = useState("")
  const [cardCategoryId, setCardCategoryId] = useState("")
  const [cardNameQuery, setCardNameQuery] = useState("")

  // 手机号编辑（独立于"基本档案 编辑/保存"，因为手机号修改影响登录/会员识别，需要单独的二次确认流程）
  const [phoneEditing, setPhoneEditing] = useState(false)
  const [phoneInput, setPhoneInput] = useState(customer.phone ?? "")
  const [phoneSaving, setPhoneSaving] = useState(false)
  const [phoneConfirmOpen, setPhoneConfirmOpen] = useState(false)

  function handlePhoneEditCancel() {
    setPhoneInput(customer.phone ?? "")
    setPhoneEditing(false)
  }

  function handlePhoneEditSubmit() {
    const next = phoneInput.trim()
    if (!next) {
      toast.error("请输入手机号")
      return
    }
    if (!/^1\d{10}$/.test(next)) {
      toast.error("手机号格式不正确（需为 11 位手机号）")
      return
    }
    if (next === (customer.phone ?? "")) {
      // 与原号一致，无需提示，直接退出编辑态
      setPhoneEditing(false)
      return
    }
    setPhoneConfirmOpen(true)
  }

  async function handlePhoneConfirm() {
    if (!canUpdate) return
    setPhoneSaving(true)
    setPhoneConfirmOpen(false)
    try {
      // TODO(perf): admin 改 phone 后，client 端 AUTH_CACHE 仍按 OPENID 缓存 5min，自然过期。
      // 若日后出现性能/一致性问题，可考虑通过 cloudbase 触发缓存失效；当前不实现跨服务调用。
      const result = await updateCustomer(
        customer.userId,
        { phone: phoneInput.trim() },
        customer.updatedAt,
      )
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("手机号已更新")
      setPhoneEditing(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "保存失败，请稍后重试"))
    } finally {
      setPhoneSaving(false)
    }
  }

  async function handleMerge(orphanUserId: string) {
    if (!canMerge) return
    if (!confirm(`确认合并孤儿档案 ${orphanUserId} 到当前顾客？\n该操作将把孤儿行的业务数据（订单/券/积分/充值卡/预约/消息/服务单）全部归并到当前顾客，且删除孤儿行。操作不可撤销。`)) return
    setMerging(orphanUserId)
    try {
      const res = await mergeClientProfile(customer.userId, orphanUserId)
      if (!res.success) {
        toast.error(res.message)
      } else {
        toast.success(res.message)
        router.refresh()
      }
    } catch (e: any) {
      toast.error(actionErrorMessage(e, '合并失败'))
    } finally {
      setMerging(null)
    }
  }

  // Edit state
  const [isEditing, setIsEditing] = useState(false)
  useUnsavedChanges(isEditing)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: customer.name ?? "",
    gender: customer.gender ?? "",
    isCrossStoreTemp: customer.isCrossStoreTemp,
    boundEmployeeId: customer.boundEmployeeId ?? "",
    promoterEmployeeName: customer.promoterEmployeeName ?? "",
    customerSource: customer.customerSource ?? "",
    birthday: customer.birthday ?? "",
    occupation: customer.occupation ?? "",
    isMarried: customer.isMarried === true ? "true" : customer.isMarried === false ? "false" : "",
    skinType: customer.skinType ?? "",
    improvementFocus: customer.improvementFocus ?? "",
    skinIssue: customer.skinIssue ?? "",
    wellnessPreference: customer.wellnessPreference ?? "",
    notes: customer.notes ?? "",
  })

  function handleFormChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  // 推荐人搜索选择（异步搜索，不受 scope/limit 限制）
  type PromoterOption = { employeeId: string; name: string | null; phone: string | null }
  const [promoterSearch, setPromoterSearch] = useState("")
  const [promoterOpen, setPromoterOpen] = useState(false)
  const [promoterResults, setPromoterResults] = useState<PromoterOption[]>([])
  const [promoterLoading, setPromoterLoading] = useState(false)
  const promoterRef = useRef<HTMLDivElement>(null)
  const promoterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [selectedPromoter, setSelectedPromoter] = useState<PromoterOption | null>(
    customer.promoterEmployeeName
      ? { employeeId: '', name: customer.promoterEmployeeName, phone: null }
      : null
  )
  const doPromoterSearch = useCallback((q: string) => {
    if (!canListEmployees) return
    if (promoterTimer.current) clearTimeout(promoterTimer.current)
    if (!q.trim()) { setPromoterResults([]); return }
    setPromoterLoading(true)
    promoterTimer.current = setTimeout(async () => {
      const results = await searchEmployees(q)
      setPromoterResults(results)
      setPromoterLoading(false)
    }, 300)
  }, [canListEmployees])
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (promoterRef.current && !promoterRef.current.contains(e.target as Node)) setPromoterOpen(false)
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  function handleCancelEdit() {
    setForm({
      name: customer.name ?? "",
      gender: customer.gender ?? "",
      isCrossStoreTemp: customer.isCrossStoreTemp,
      boundEmployeeId: customer.boundEmployeeId ?? "",
      promoterEmployeeName: customer.promoterEmployeeName ?? "",
      customerSource: customer.customerSource ?? "",
      birthday: customer.birthday ?? "",
      occupation: customer.occupation ?? "",
      isMarried: customer.isMarried === true ? "true" : customer.isMarried === false ? "false" : "",
      skinType: customer.skinType ?? "",
      improvementFocus: customer.improvementFocus ?? "",
      skinIssue: customer.skinIssue ?? "",
      wellnessPreference: customer.wellnessPreference ?? "",
      notes: customer.notes ?? "",
    })
    setSelectedPromoter(
      customer.promoterEmployeeName
        ? { employeeId: '', name: customer.promoterEmployeeName, phone: null }
        : null,
    )
    setPromoterSearch("")
    setPromoterOpen(false)
    setIsEditing(false)
  }

  async function handleSave() {
    if (!canUpdate) return
    setSaving(true)
    try {
      const result = await updateCustomer(customer.userId, {
        name: form.name || null,
        gender: form.gender || null,
        isCrossStoreTemp: form.isCrossStoreTemp,
        boundEmployeeId: form.boundEmployeeId || null,
        promoterEmployeeName: form.promoterEmployeeName || null,
        customerSource: form.customerSource || null,
        birthday: form.birthday || null,
        occupation: form.occupation || null,
        isMarried: form.isMarried === "true" ? true : form.isMarried === "false" ? false : null,
        skinType: form.skinType || null,
        improvementFocus: form.improvementFocus || null,
        skinIssue: form.skinIssue || null,
        wellnessPreference: form.wellnessPreference || null,
        notes: form.notes || null,
      }, customer.updatedAt)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("保存成功")
      setIsEditing(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "保存失败，请稍后重试"))
    } finally {
      setSaving(false)
    }
  }

  // Employees filtered by customer's bound store — 严格美容师身份（skills 含 '美容师'），
  // 与 client `staff.list` / staff `staff.list` / admin orders|services create 统一。
  const storeEmployees = useMemo(() => {
    const isBeautician = (e: typeof employees[number]) =>
      !e.isResigned && e.skills?.includes('美容师')
    if (!customer.boundStoreId) return employees.filter(isBeautician)
    return employees.filter((e) => isBeautician(e) && e.storeId === customer.boundStoreId)
  }, [employees, customer.boundStoreId])

  const activeSaleItems = useMemo(() => {
    return getCustomerVisibleSaleItems(orders)
  }, [orders])

  const cardProductKinds = useMemo(
    () => Array.from(new Set(activeSaleItems.map((item) => item.productKind).filter((value): value is string => Boolean(value)))),
    [activeSaleItems],
  )
  const cardCategories = useMemo(
    () => Array.from(
      new Map(
        activeSaleItems
          .filter((item) => item.categoryId && item.categoryName && (!cardProductKind || item.productKind === cardProductKind))
          .map((item) => [item.categoryId!, { id: item.categoryId!, name: item.categoryName! }]),
      ).values(),
    ),
    [activeSaleItems, cardProductKind],
  )
  const filteredActiveSaleItems = useMemo(() => {
    const query = cardNameQuery.trim().toLocaleLowerCase()
    return activeSaleItems.filter((item) => {
      if (cardProductKind && item.productKind !== cardProductKind) return false
      if (cardCategoryId && item.categoryId !== cardCategoryId) return false
      if (!query) return true
      const name = `${item.productName ?? ''} ${item.skuName ?? ''}`.toLocaleLowerCase()
      return name.includes(query)
    })
  }, [activeSaleItems, cardCategoryId, cardNameQuery, cardProductKind])
  const hasCardFilters = Boolean(cardProductKind || cardCategoryId || cardNameQuery.trim())

  // 顾客优惠券状态筛选（组件内 state 过滤，与详情页「全量预加载」模式一致）
  const filteredCoupons = useMemo(
    () => (couponStatus ? coupons.filter((c) => c.status === couponStatus) : coupons),
    [coupons, couponStatus],
  )

  const orderColumns: Column<SaleOrder>[] = [
    {
      key: "saleOrderId",
      header: "订单号",
      cell: (row) => (
        <span className="font-mono text-xs">{row.saleOrderId}</span>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "totalAmount",
      header: "金额",
      cell: (row) => <span>{formatCurrency(row.totalAmount)}</span>,
    },
    {
      key: "saleOrderDatetime",
      header: "下单时间",
      cell: (row) => <span>{formatDateTime(row.saleOrderDatetime) || "—"}</span>,
    },
    { key: "storeName", header: "门店" },
  ]

  function couponStatusClassName(status: CouponStatus): string {
    if (status === "未使用") return "border-[#3D8A5A] text-[#3D8A5A] bg-[#E8F5EE]"
    if (status === "已使用") return "border-[#888888] text-[#888888] bg-[#F4F4F4]"
    return "border-[#D94040] text-[#D94040] bg-[#FFEBEE]"
  }

  const couponColumns: Column<CustomerCoupon>[] = [
    { key: "name", header: "券名称", cell: (row) => <span className="font-medium">{row.name}</span> },
    { key: "couponType", header: "类型", cell: (row) => <Badge variant="outline">{row.couponType}</Badge> },
    {
      key: "discountValue",
      header: "面值",
      cell: (row) => (
        <span className="font-medium text-[#C0322A]">
          {row.couponType === "折扣券"
            ? `${Math.round(Number(row.discountValue) * 10)}折`
            : `¥${Number(row.discountValue).toFixed(0)}`}
        </span>
      ),
    },
    {
      key: "minSpend",
      header: "门槛",
      cell: (row) => (
        <span>{Number(row.minSpend) > 0 ? `满¥${Number(row.minSpend).toFixed(0)}` : "无"}</span>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => (
        <Badge variant="outline" className={couponStatusClassName(row.status)}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: "expireAt",
      header: "到期",
      cell: (row) => <span>{formatDate(row.expireAt) || "—"}</span>,
    },
    {
      key: "usedAt",
      header: "使用时间",
      cell: (row) => <span>{row.usedAt ? formatDateTime(row.usedAt) : "—"}</span>,
    },
  ]

  const itemColumns: Column<CustomerVisibleSaleItem>[] = [
    {
      key: "productName",
      header: "项目名称",
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.productName ?? "—"}</span>
          {row.cardCount > 1 && <span className="text-xs text-[#999999]">共 {row.cardCount} 张</span>}
        </div>
      ),
    },
    {
      key: "skuName",
      header: "规格",
      cell: (row) => <span>{formatDistinctSkuName(row)}</span>,
    },
    {
      // ticket 2026-05-19 D10=A：合并展示「已用 / 已付 / 共」三段次数
      key: "sessionCount",
      header: "已用/已付/共",
      cell: (row) =>
        row.sessionCount !== null ? (
          <span className="font-medium text-[#C0322A]">
            {`${row.sessionCount - (row.remainingSessions ?? 0)}/${row.paidSessions ?? 0}/${row.sessionCount}`}
          </span>
        ) : (
          <span>—</span>
        ),
    },
    {
      key: "expireDate",
      header: "到期日",
      cell: (row) => <span>{row.expireDate ? formatDate(row.expireDate) : "—"}</span>,
    },
  ]

  const homeProductColumns: Column<CustomerHomeProduct>[] = [
    {
      key: "productName",
      header: "产品",
      cell: (row) => <span className="font-medium">{row.productName}</span>,
    },
    { key: "status", header: "状态", cell: (row) => <StatusBadge status={row.status} /> },
    { key: "purchasedQuantity", header: "购买", cell: (row) => <span>{row.purchasedQuantity} {row.unit}</span> },
    { key: "pickedQuantity", header: "已提", cell: (row) => <span>{row.pickedQuantity} {row.unit}</span> },
    { key: "refundedQuantity", header: "已退", cell: (row) => <span>{row.refundedQuantity} {row.unit}</span> },
    { key: "remainingQuantity", header: "待提", cell: (row) => <span className="font-medium text-[#C0322A]">{row.remainingQuantity} {row.unit}</span> },
    { key: "storeName", header: "购买门店", cell: (row) => <span>{row.storeName || "—"}</span> },
    { key: "purchasedAt", header: "购买日期", cell: (row) => <span>{formatDate(row.purchasedAt) || "—"}</span> },
    { key: "saleOrderId", header: "订单号", cell: (row) => <span className="font-mono text-xs">{row.saleOrderId}</span> },
  ]

  const appointmentColumns: Column<Appointment>[] = [
    {
      key: "appointmentTime",
      header: "预约时间",
      cell: (row) => <span>{formatDateTime(row.appointmentTime) || "—"}</span>,
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => <StatusBadge status={row.status} />,
    },
    { key: "employeeName", header: "美容师" },
    { key: "storeName", header: "门店" },
    {
      key: "notes",
      header: "备注",
      cell: (row) => <span>{row.notes ?? "—"}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          顾客详情 - {customer.name}
        </h1>
        <MemberLevelBadge level={customer.memberLevel} />
        <div className="ml-auto flex gap-2">
          {canPullLegacy && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPullLegacyOpen(true)}
            >
              拉取 WorkFine 历史订单
            </Button>
          )}
        </div>
      </div>

      <PullWorkfineDialog
        open={pullLegacyOpen}
        onOpenChange={setPullLegacyOpen}
        defaultPhone={customer.phone ?? undefined}
      />

      {canMerge && orphanProfiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-[#D4820A]">
              检测到 {orphanProfiles.length} 个同手机号的孤儿档案（openid 为空）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-[var(--muted-foreground)]">
              孤儿档案通常来自历史 WorkFine 同步。合并会把孤儿行的订单、券、积分、充值卡、预约、消息、服务单等业务数据全部归并到当前顾客，
              并删除孤儿行。当前顾客已有的非空档案字段不会被覆盖。仅店长及以上可执行。
            </p>
            <div className="space-y-2">
              {orphanProfiles.map((o) => (
                <div key={o.userId} className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2">
                  <div className="text-sm">
                    <span className="font-mono text-xs">{o.userId}</span>
                    <span className="mx-2">|</span>
                    <span>{o.name ?? '(无姓名)'}</span>
                    {o.customerId && <span className="ml-2 text-xs text-[var(--muted-foreground)]">customerId: {o.customerId}</span>}
                    <MemberLevelBadge level={o.memberLevel} className="ml-2" />
                    {o.pointsBalance > 0 && <span className="ml-2 text-xs">积分 {o.pointsBalance}</span>}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={merging === o.userId}
                    disabled={merging !== null}
                    onClick={() => handleMerge(o.userId)}
                  >
                    合并历史档案
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="profile">
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="profile">基本档案</TabsTrigger>
          <TabsTrigger value="orders">消费记录（{orders.length}）</TabsTrigger>
          <TabsTrigger value="sessions">疗程卡（{activeSaleItems.length}）</TabsTrigger>
          <TabsTrigger value="home-products">家居产品（{homeProducts.length}）</TabsTrigger>
          <TabsTrigger value="appointments">预约记录（{appointments.length}）</TabsTrigger>
          <TabsTrigger value="services">服务记录（{serviceOrders.length}）</TabsTrigger>
          <TabsTrigger value="coupons">顾客优惠券（{coupons.length}）</TabsTrigger>
          <TabsTrigger value="phone-history">手机号变更（{phoneChangeLogs.length}）</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">基本档案</CardTitle>
              {isEditing ? (
                <div className="flex gap-2">
                  <Button size="sm" loading={saving} onClick={handleSave}>
                    保存
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={saving}>
                    取消
                  </Button>
                </div>
              ) : canUpdate ? (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  编辑
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">姓名</label>
                  {isEditing ? (
                    <Input
                      value={form.name}
                      onChange={(e) => handleFormChange("name", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.name ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">性别</label>
                  {isEditing ? (
                    <Select
                      value={form.gender}
                      onChange={(e) => handleFormChange("gender", e.target.value)}
                    >
                      <option value="">未填写</option>
                      <option value="女">女</option>
                      <option value="男">男</option>
                    </Select>
                  ) : (
                    <Input value={customer.gender ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">手机号</label>
                  {phoneEditing ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={phoneInput}
                        onChange={(e) => setPhoneInput(e.target.value)}
                        placeholder="11 位手机号"
                        maxLength={11}
                        autoFocus
                      />
                      <Button size="sm" loading={phoneSaving} onClick={handlePhoneEditSubmit}>
                        保存
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePhoneEditCancel}
                        disabled={phoneSaving}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input value={customer.phone ?? ""} disabled />
                      {canEditPhone && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setPhoneInput(customer.phone ?? "")
                            setPhoneEditing(true)
                          }}
                        >
                          编辑
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">微信昵称</label>
                  <Input value={customer.wechatName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">归属门店</label>
                  <Input value={customer.storeName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">临时跨门店（可被其他门店开单）</label>
                  {isEditing ? (
                    <Select
                      value={form.isCrossStoreTemp ? "true" : "false"}
                      onChange={(e) => setForm((prev) => ({ ...prev, isCrossStoreTemp: e.target.value === "true" }))}
                    >
                      <option value="false">否</option>
                      <option value="true">是</option>
                    </Select>
                  ) : (
                    <Input value={customer.isCrossStoreTemp ? "是" : "否"} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">储值卡余额</label>
                  <Input value={formatCurrency(prepaidBalance ?? "0")} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属美容师</label>
                  {isEditing ? (
                    <Select
                      value={form.boundEmployeeId}
                      onChange={(e) => handleFormChange("boundEmployeeId", e.target.value)}
                    >
                      <option value="">请选择美容师</option>
                      {storeEmployees.map((emp) => (
                        <option key={emp.employeeId} value={emp.employeeId}>
                          {emp.name} ({emp.positionName ?? "—"})
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={customer.employeeName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">推荐人</label>
                  {isEditing ? (
                    <div ref={promoterRef} className="relative">
                      <Input
                        placeholder="输入姓名或手机号搜索"
                        value={promoterOpen ? promoterSearch : (selectedPromoter?.name ?? form.promoterEmployeeName)}
                        onFocus={() => { setPromoterOpen(true); setPromoterSearch("") }}
                        onChange={(e) => { setPromoterSearch(e.target.value); setPromoterOpen(true); doPromoterSearch(e.target.value) }}
                      />
                      {form.promoterEmployeeName && !promoterOpen && (
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[#999999] hover:text-[#333333] text-sm"
                          onClick={() => { handleFormChange("promoterEmployeeName", ""); setSelectedPromoter(null); setPromoterSearch("") }}
                        >
                          ✕
                        </button>
                      )}
                      {promoterOpen && (
                        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] shadow-md">
                          {promoterLoading ? (
                            <li className="px-3 py-2 text-sm text-[#999999]">搜索中…</li>
                          ) : !promoterSearch.trim() ? (
                            <li className="px-3 py-2 text-sm text-[#999999]">请输入关键词搜索</li>
                          ) : promoterResults.length === 0 ? (
                            <li className="px-3 py-2 text-sm text-[#999999]">无匹配结果</li>
                          ) : (
                            promoterResults.map((emp) => (
                              <li
                                key={emp.employeeId}
                                className={`cursor-pointer px-3 py-2 text-sm hover:bg-[var(--muted)] ${emp.name === form.promoterEmployeeName ? "bg-[var(--muted)] font-medium" : ""}`}
                                onMouseDown={() => {
                                  handleFormChange("promoterEmployeeName", emp.name ?? "")
                                  setSelectedPromoter(emp)
                                  setPromoterOpen(false)
                                  setPromoterSearch("")
                                }}
                              >
                                {emp.name}{emp.phone ? ` (${formatPhoneSafe(emp.phone)})` : ""}
                              </li>
                            ))
                          )}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <Input value={customer.promoterEmployeeName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">会员等级</label>
                  <Input value={customer.memberLevel ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">成为会员</label>
                  <Input
                    value={customer.becameMemberAt ? formatDateTime(customer.becameMemberAt) : ""}
                    disabled
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">最近升级</label>
                  <Input
                    value={customer.memberLevelUpgradedAt ? formatDateTime(customer.memberLevelUpgradedAt) : ""}
                    disabled
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">保级至</label>
                  <div className="flex items-center gap-2 h-9">
                    {(() => {
                      const lockedUntil = customer.memberLevelLockedUntil
                      if (!lockedUntil) return <span className="text-sm text-[var(--muted-foreground)]">-</span>
                      const isActive = new Date(lockedUntil) > new Date()
                      return (
                        <>
                          <span className="text-sm">{formatDate(lockedUntil)}</span>
                          {isActive ? (
                            <Badge variant="outline" className="border-[#3D8A5A] text-[#3D8A5A] bg-[#E8F5EE]">
                              保级中
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-[#888888] text-[#888888] bg-[#F4F4F4]">
                              保级已到期
                            </Badge>
                          )}
                        </>
                      )
                    })()}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">顾客类型</label>
                  <Input value={customer.customerType ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">消费档位</label>
                  <Input value={customer.spendingTier ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">月度客活</label>
                  <Input value={customer.monthlyActivity ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">到店状态</label>
                  <Input value={customer.customerStatus ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">顾客来源</label>
                  {isEditing ? (
                    <Select
                      value={form.customerSource}
                      onChange={(e) => handleFormChange("customerSource", e.target.value)}
                    >
                      <option value="">请选择来源</option>
                      <optgroup label="线上来源">
                        <option value="美团">美团</option>
                        <option value="抖音">抖音</option>
                        <option value="小程序">小程序</option>
                      </optgroup>
                      <optgroup label="线下来源">
                        <option value="推带新">推带新</option>
                        <option value="地推卡">地推卡</option>
                        <option value="拓客卡">拓客卡</option>
                        <option value="老带新">老带新</option>
                        <option value="转让店">转让店</option>
                        <option value="自进店">自进店</option>
                        <option value="内部员工或家属">内部员工或家属</option>
                      </optgroup>
                    </Select>
                  ) : (
                    <Input value={customer.customerSource ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">生日</label>
                  {isEditing ? (
                    <Input
                      type="date"
                      value={form.birthday}
                      onChange={(e) => handleFormChange("birthday", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.birthday ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">职业</label>
                  {isEditing ? (
                    <Input
                      value={form.occupation}
                      onChange={(e) => handleFormChange("occupation", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.occupation ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">婚姻状况</label>
                  {isEditing ? (
                    <Select
                      value={form.isMarried}
                      onChange={(e) => handleFormChange("isMarried", e.target.value)}
                    >
                      <option value="">未填写</option>
                      <option value="true">已婚</option>
                      <option value="false">未婚</option>
                    </Select>
                  ) : (
                    <Input
                      value={
                        customer.isMarried === true
                          ? "已婚"
                          : customer.isMarried === false
                            ? "未婚"
                            : ""
                      }
                      disabled
                    />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">肤质</label>
                  {isEditing ? (
                    <Input
                      value={form.skinType}
                      onChange={(e) => handleFormChange("skinType", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.skinType ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">改善重点</label>
                  {isEditing ? (
                    <Input
                      value={form.improvementFocus}
                      onChange={(e) => handleFormChange("improvementFocus", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.improvementFocus ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">肌肤问题</label>
                  {isEditing ? (
                    <Input
                      value={form.skinIssue}
                      onChange={(e) => handleFormChange("skinIssue", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.skinIssue ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">养生偏好</label>
                  {isEditing ? (
                    <Input
                      value={form.wellnessPreference}
                      onChange={(e) => handleFormChange("wellnessPreference", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.wellnessPreference ?? ""} disabled />
                  )}
                </div>
                <div className="col-span-2 space-y-2">
                  <label className="text-sm font-medium">备注</label>
                  {isEditing ? (
                    <textarea
                      className="flex min-h-[80px] w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
                      value={form.notes}
                      onChange={(e) => handleFormChange("notes", e.target.value)}
                    />
                  ) : (
                    <div className="min-h-[40px] rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
                      {customer.notes || "—"}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">消费记录</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={orderColumns}
                data={orders}
                emptyText="暂无消费记录"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardHeader className="space-y-3">
              <CardTitle className="text-base">疗程卡</CardTitle>
              <div className="grid gap-2 sm:grid-cols-[10rem_10rem_minmax(14rem,1fr)]">
                <Select
                  value={cardProductKind}
                  onChange={(e) => {
                    setCardProductKind(e.target.value)
                    setCardCategoryId("")
                  }}
                >
                  <option value="">全部一级品项</option>
                  {cardProductKinds.map((productKind) => (
                    <option key={productKind} value={productKind}>{productKind}</option>
                  ))}
                </Select>
                <Select
                  value={cardCategoryId}
                  onChange={(e) => setCardCategoryId(e.target.value)}
                  disabled={!cardProductKind}
                >
                  <option value="">{cardProductKind ? "全部二级品项" : "请先选择一级品项"}</option>
                  {cardCategories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </Select>
                <Input
                  value={cardNameQuery}
                  onChange={(e) => setCardNameQuery(e.target.value)}
                  placeholder="搜索疗程卡名称"
                />
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={itemColumns}
                data={filteredActiveSaleItems}
                emptyText={hasCardFilters ? "未找到匹配的疗程卡" : "暂无疗程卡"}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="home-products">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">家居产品</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={homeProductColumns}
                data={homeProducts}
                emptyText="暂无家居产品"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appointments">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">预约记录</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={appointmentColumns}
                data={appointments}
                emptyText="暂无预约记录"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="services">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">服务记录</CardTitle>
            </CardHeader>
            <CardContent>
              {serviceOrders.length === 0 ? (
                <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">暂无服务记录</div>
              ) : (
                <div className="space-y-3">
                  {serviceOrders.map((s) => (
                    <Link
                      key={s.serviceOrderId}
                      href={`/services/${s.serviceOrderId}`}
                      className="block rounded-lg border border-[var(--border)] p-3 transition-colors hover:bg-[#FFF0EE]"
                    >
                      <div className="flex items-center gap-2">
                        <StatusBadge status={s.status} />
                        <span className="font-mono text-xs text-[var(--primary)]">{s.serviceOrderId}</span>
                        <span className="ml-auto text-xs text-[var(--muted-foreground)]">{formatDate(s.serviceDate) || "—"}</span>
                      </div>
                      {s.items.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {s.items.map((it, idx) => (
                            <div key={idx} className="text-sm">{it.productName ?? '—'}</div>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 text-xs text-[var(--muted-foreground)]">
                        {[s.storeName, s.employeeName && `美容师：${s.employeeName}`].filter(Boolean).join(' · ') || "—"}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="coupons">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">顾客优惠券</CardTitle>
              <Select
                className="w-32"
                value={couponStatus}
                onChange={(e) => setCouponStatus(e.target.value as "" | CouponStatus)}
              >
                <option value="">全部状态</option>
                <option value="未使用">未使用</option>
                <option value="已使用">已使用</option>
                <option value="已过期">已过期</option>
              </Select>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={couponColumns}
                data={filteredCoupons}
                emptyText="暂无优惠券"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="phone-history">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">手机号变更记录</CardTitle>
            </CardHeader>
            <CardContent>
              {phoneChangeLogs.length === 0 ? (
                <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">暂无换绑记录</div>
              ) : (
                <DataTable
                  columns={[
                    { key: 'createdAt', header: '时间', cell: (row) => <span>{formatDateTime(row.createdAt) || "—"}</span> },
                    { key: 'oldPhone', header: '旧号', cell: (row) => <span className="font-mono text-xs">{row.oldPhone ?? '—'}</span> },
                    { key: 'newPhone', header: '新号', cell: (row) => <span className="font-mono text-xs">{row.newPhone ?? '—'}</span> },
                    { key: 'mergedOrders', header: '归并订单数', cell: (row) => <span>{row.mergedOrders}</span> },
                    {
                      key: 'source',
                      header: '来源',
                      cell: (row) => (
                        <Badge variant="outline">
                          {row.source === 'admin' ? '管理后台' : '顾客端'}
                        </Badge>
                      ),
                    },
                    { key: 'operatorLabel', header: '操作方', cell: (row) => <span>{row.operatorLabel}</span> },
                  ] as Column<PhoneChangeLog>[]}
                  data={phoneChangeLogs}
                  emptyText="暂无换绑记录"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={phoneConfirmOpen} onOpenChange={setPhoneConfirmOpen}>
        <AlertDialogTitle>确认修改手机号</AlertDialogTitle>
        <AlertDialogDescription>
          修改手机号将影响登录、下单联系、会员识别。新手机号 {phoneInput.trim()} 已通过格式校验。确认继续？
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setPhoneConfirmOpen(false)} disabled={phoneSaving}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handlePhoneConfirm} disabled={phoneSaving}>
            确认修改
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* 危险操作：物理删除顾客（仅系统管理员，仅无业务关联的测试号可删） */}
      {canDelete && (
        <DangerZoneDelete
          entityLabel="顾客"
          redirectTo="/customers"
          onConfirm={() => deleteCustomer(customer.userId)}
          description={
            <>
              确定要删除顾客 <span className="font-medium">{customer.name || customer.phone || customer.userId}</span> 吗？
              此操作不可恢复。有订单 / 服务 / 预约 / 积分 / 储值卡 / 优惠券等业务关联的顾客不可删除。
            </>
          }
        />
      )}
    </div>
  )
}
