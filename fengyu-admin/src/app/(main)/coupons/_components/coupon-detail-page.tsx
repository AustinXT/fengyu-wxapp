"use client"

import { useState, useMemo, useCallback, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip } from "@/components/ui/tooltip"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Pagination } from "@/components/ui/pagination"
import { formatCurrency, formatDate } from "@/lib/utils"
import { formatPhoneSafe } from "@/lib/format"
import { actionErrorMessage } from "@/lib/action-error"
import { OrgTreeSelect } from "@/components/ui/org-tree-select"
import { updateTemplate, issueCoupon, batchIssueCoupons, getCustomersForBatchIssue, getOrgNodesForBatchIssue } from "@/actions/coupons"
import type { CouponTemplate, CouponType, IssuedCoupon, BatchCouponCustomer, OrgNode } from "@/lib/types"
import { validateCouponValidityFields } from "./coupon-validity-helper"

const COUPON_TYPE_COLORS: Record<CouponType, string> = {
  "现金券": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "品项券": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "折扣券": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
}


const ISSUED_STATUS_COLORS: Record<string, string> = {
  "已使用": "border-[#888888] text-[#888888] bg-[#F5F5F5]",
  "未使用": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "已过期": "border-[#D94040] text-[#D94040] bg-[#FFF0F0]",
}

function toDateInputValue(isoStr: string | null): string {
  if (!isoStr) return ""
  return isoStr.slice(0, 10)
}

interface Market {
  id: string
  name: string
}

interface Category {
  categoryId: string
  categoryName: string
  productKind: string | null
}

interface Props {
  template: CouponTemplate
  markets: Market[]
  issuedCoupons: IssuedCoupon[]
  categories: Category[]
}

export default function CouponDetailPage({ template, markets, issuedCoupons, categories }: Props) {
  const router = useRouter()

  
  const [editing, setEditing] = useState(false)
  useUnsavedChanges(editing)
  const [saving, setSaving] = useState(false)
  const [editName, setEditName] = useState(template.name)
  const [editCouponType, setEditCouponType] = useState<CouponType>(template.couponType)
  const [editDiscountValue, setEditDiscountValue] = useState(template.discountValue)
  const [editMinSpend, setEditMinSpend] = useState(template.minSpend ?? "")
  const [editMaxDiscount, setEditMaxDiscount] = useState(template.maxDiscount ?? "")
  const [editTotalCount, setEditTotalCount] = useState(template.totalCount?.toString() ?? "")
  const [editValidityMode, setEditValidityMode] = useState<"fixed" | "days">(
    (template.validityMode as "fixed" | "days") ?? "days"
  )
  const [editValidDays, setEditValidDays] = useState(template.validDays?.toString() ?? "")
  const [editValidFrom, setEditValidFrom] = useState(toDateInputValue(template.validFrom))
  const [editValidTo, setEditValidTo] = useState(toDateInputValue(template.validTo))
  const [editDescription, setEditDescription] = useState(template.description ?? "")
  const [editIsActive, setEditIsActive] = useState(template.isActive ?? true)
  const [editAllMarkets, setEditAllMarkets] = useState(!template.applicableMarketIds || template.applicableMarketIds.length === 0)
  const [editSelectedMarketIds, setEditSelectedMarketIds] = useState<string[]>(template.applicableMarketIds ?? [])
  const [editAllCategories, setEditAllCategories] = useState(!template.applicableCategoryIds || template.applicableCategoryIds.length === 0)
  const [editSelectedCategoryIds, setEditSelectedCategoryIds] = useState<string[]>(template.applicableCategoryIds ?? [])
  const marketMap = useMemo(() => new Map(markets.map((m) => [m.id, m.name])), [markets])
  const categoryMap = useMemo(() => new Map(categories.map((c) => [c.categoryId, c.categoryName])), [categories])

  
  const [issueOpen, setIssueOpen] = useState(false)
  const [issuePhone, setIssuePhone] = useState("")
  const [issueCustomerName, setIssueCustomerName] = useState("")
  const [issueSearched, setIssueSearched] = useState(false)
  const [issueLoading, setIssueLoading] = useState(false)

  
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchMode, setBatchMode] = useState<"manual" | "select">("manual")
  const [batchPhoneText, setBatchPhoneText] = useState("")
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchErrors, setBatchErrors] = useState<Array<{ phone: string; reason: string }>>([])
  
  const [batchCustomers, setBatchCustomers] = useState<BatchCouponCustomer[]>([])
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
  const [batchOrgFilter, setBatchOrgFilter] = useState("")
  const [batchLevelFilter, setBatchLevelFilter] = useState("")
  const [batchSearch, setBatchSearch] = useState("")
  const [batchPage, setBatchPage] = useState(1)
  const [batchOrgNodes, setBatchOrgNodes] = useState<OrgNode[]>([])
  const [batchOrgLoaded, setBatchOrgLoaded] = useState(false)

  
  const parsedPhones = useMemo(() => {
    if (!batchPhoneText.trim()) return []
    return [...new Set(
      batchPhoneText
        .split(/[\n,，\s]+/)
        .map((p) => p.trim())
        .filter(Boolean)
    )]
  }, [batchPhoneText])

  
  const batchPhoneList = batchMode === "manual" ? parsedPhones : [...batchSelected]

  
  useEffect(() => {
    if (batchOpen && !batchOrgLoaded) {
      getOrgNodesForBatchIssue().then((nodes) => {
        setBatchOrgNodes(nodes)
        setBatchOrgLoaded(true)
      })
    }
  }, [batchOpen, batchOrgLoaded])

  
  const loadBatchCustomers = useCallback(async (p = 1) => {
    try {
      const result = await getCustomersForBatchIssue({
        orgNodeId: batchOrgFilter || undefined,
        memberLevel: batchLevelFilter || undefined,
        search: batchSearch || undefined,
        page: p,
        pageSize: 10,
      })
      setBatchCustomers(result.data)
      setBatchTotal(result.total)
    } catch (err) {
      toast.error(actionErrorMessage(err, "加载顾客列表失败"))
    }
  }, [batchOrgFilter, batchLevelFilter, batchSearch])

  
  useEffect(() => {
    if (batchOpen && batchMode === "select") {
      setBatchPage(1)
      loadBatchCustomers(1)
    }
  }, [batchOpen, batchMode, batchOrgFilter, batchLevelFilter, batchSearch, loadBatchCustomers])

  function handleBatchPageChange(p: number) {
    setBatchPage(p)
    loadBatchCustomers(p)
  }

  function toggleBatchSelect(phone: string) {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (next.has(phone)) next.delete(phone)
      else next.add(phone)
      return next
    })
  }

  function toggleSelectAllPage() {
    const pagePhones = batchCustomers.filter((c) => c.phone).map((c) => c.phone!)
    const allSelected = pagePhones.every((p) => batchSelected.has(p))
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        pagePhones.forEach((p) => next.delete(p))
      } else {
        pagePhones.forEach((p) => next.add(p))
      }
      return next
    })
  }

  async function handleBatchIssue() {
    if (batchPhoneList.length === 0) {
      toast.error(batchMode === "manual" ? "请输入手机号" : "请选择顾客")
      return
    }
    setBatchLoading(true)
    setBatchErrors([])
    try {
      const result = await batchIssueCoupons(template.templateId, batchPhoneList)
      if (!result.success) {
        if (result.errors && result.errors.length > 0) {
          setBatchErrors(result.errors)
        }
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      handleCloseBatch()
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "批量发放失败，请重试"))
    } finally {
      setBatchLoading(false)
    }
  }

  function handleCloseBatch() {
    setBatchOpen(false)
    setBatchMode("manual")
    setBatchPhoneText("")
    setBatchErrors([])
    setBatchCustomers([])
    setBatchTotal(0)
    setBatchSelected(new Set())
    setBatchOrgFilter("")
    setBatchLevelFilter("")
    setBatchSearch("")
    setBatchPage(1)
    setBatchLoading(false)
  }

  function handleStartEdit() {
    setEditName(template.name)
    setEditCouponType(template.couponType)
    setEditDiscountValue(template.discountValue)
    setEditMinSpend(template.minSpend ?? "")
    setEditMaxDiscount(template.maxDiscount ?? "")
    setEditTotalCount(template.totalCount?.toString() ?? "")
    setEditValidityMode((template.validityMode as "fixed" | "days") ?? "days")
    setEditValidDays(template.validDays?.toString() ?? "")
    setEditValidFrom(toDateInputValue(template.validFrom))
    setEditValidTo(toDateInputValue(template.validTo))
    setEditDescription(template.description ?? "")
    setEditIsActive(template.isActive ?? true)
    setEditAllMarkets(!template.applicableMarketIds || template.applicableMarketIds.length === 0)
    setEditSelectedMarketIds(template.applicableMarketIds ?? [])
    setEditAllCategories(!template.applicableCategoryIds || template.applicableCategoryIds.length === 0)
    setEditSelectedCategoryIds(template.applicableCategoryIds ?? [])
    setEditing(true)
  }

  function handleCancelEdit() {
    setEditing(false)
  }

  async function handleSaveEdit() {
    if (!editName.trim()) {
      toast.error("请输入券名称")
      return
    }
    if (!editDiscountValue) {
      toast.error("请输入面值/折扣")
      return
    }
    const dv = Number(editDiscountValue)
    if (isNaN(dv) || dv <= 0) {
      toast.error("面值/折扣必须大于 0")
      return
    }
    if (editCouponType === "折扣券" && dv >= 1) {
      toast.error("折扣券的折扣值必须在 0~1 之间（如 0.85 表示 85 折）")
      return
    }

    const validityCheck = validateCouponValidityFields({
      validityMode: editValidityMode,
      validDays: editValidDays,
      validFrom: editValidFrom,
      validTo: editValidTo,
    })
    if (!validityCheck.ok) {
      toast.error(validityCheck.message)
      return
    }

    setSaving(true)
    try {
      const tplResult = await updateTemplate(template.templateId, {
        name: editName.trim(),
        couponType: editCouponType,
        discountValue: editDiscountValue,
        minSpend: editMinSpend || undefined,
        maxDiscount: null,
        totalCount: editCouponType === "折扣券" ? null : (editTotalCount ? parseInt(editTotalCount, 10) : null),
        applicableCategoryIds: editCouponType === "品项券" && !editAllCategories && editSelectedCategoryIds.length > 0 ? editSelectedCategoryIds : null,
        validityMode: editValidityMode,
        validFrom: editValidityMode === "fixed" && editValidFrom ? editValidFrom : null,
        validTo: editValidityMode === "fixed" && editValidTo ? editValidTo : null,
        validDays: editValidityMode === "days" && editValidDays ? parseInt(editValidDays, 10) : null,
        applicableMarketIds: editAllMarkets ? null : (editSelectedMarketIds.length > 0 ? editSelectedMarketIds : null),
        description: editDescription.trim() || null,
        isActive: editIsActive,
      }, template.updatedAt)
      if (!tplResult.success) {
        toast.error(tplResult.message)
        if (tplResult.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("保存成功")
      setEditing(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "保存失败，请重试"))
    } finally {
      setSaving(false)
    }
  }

  async function handleSearchCustomer() {
    if (!issuePhone.trim()) {
      toast.error("请输入手机号")
      return
    }
    try {
      const { searchCustomerByPhone } = await import("@/actions/customers")
      const customer = await searchCustomerByPhone(issuePhone.trim())
      if (customer) {
        setIssueCustomerName(customer.name || "未知姓名")
      } else {
        setIssueCustomerName("")
        toast.info("未找到该手机号对应的顾客")
      }
      setIssueSearched(true)
    } catch (err) {
      toast.error(actionErrorMessage(err, "搜索失败"))
    }
  }

  async function handleIssueCoupon() {
    if (!issueSearched || !issueCustomerName) {
      toast.error("请先搜索顾客")
      return
    }
    setIssueLoading(true)
    try {
      const result = await issueCoupon(template.templateId, issuePhone.trim())
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      setIssueOpen(false)
      setIssuePhone("")
      setIssueCustomerName("")
      setIssueSearched(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "发放失败，请重试"))
    } finally {
      setIssueLoading(false)
    }
  }

  const issuedColumns: Column<IssuedCoupon>[] = [
    {
      key: "couponId",
      header: "券号",
      cell: (row) => <span className="font-mono text-xs">{row.couponId}</span>,
    },
    {
      key: "customerName",
      header: "持有顾客",
      cell: (row) => <span className="font-medium">{row.customerName}</span>,
    },
    { key: "phone", header: "手机号" },
    {
      key: "status",
      header: "状态",
      cell: (row) => (
        <Badge variant="outline" className={ISSUED_STATUS_COLORS[row.status] ?? ""}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: "issuedAt",
      header: "发放时间",
      cell: (row) => <span>{formatDate(row.issuedAt) || "—"}</span>,
    },
    {
      key: "usedAt",
      header: "使用时间",
      cell: (row) => <span>{row.usedAt ? formatDate(row.usedAt) : "—"}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          优惠券详情 - {template.name}
        </h1>
        <Badge variant="outline" className={COUPON_TYPE_COLORS[template.couponType]}>
          {template.couponType}
        </Badge>
      </div>

      {}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">券模板信息</CardTitle>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={saving}>
                  取消
                </Button>
                <Button size="sm" onClick={handleSaveEdit} disabled={saving}>
                  {saving ? "保存中..." : "保存"}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={handleStartEdit}>
                  编辑
                </Button>
                <Button variant="outline" size="sm" onClick={() => setBatchOpen(true)}>批量发放</Button>
                <Button size="sm" onClick={() => setIssueOpen(true)}>发放优惠券</Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">券名称</label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">券类型</label>
                <Select
                  value={editCouponType}
                  onChange={(e) => setEditCouponType(e.target.value as CouponType)}
                >
                  <option value="现金券">现金券</option>
                  <option value="品项券">品项券</option>
                  <option value="折扣券">折扣券</option>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {editCouponType === "折扣券" ? "折扣率（0~1）" : "面值（元）"}
                </label>
                <Input
                  type="number"
                  value={editDiscountValue}
                  onChange={(e) => setEditDiscountValue(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium">最低消费</label>
                  <Tooltip
                    side="top"
                    wide
                    content='门槛基数 = "符合适用分类的商品行小计"，而非全单总额。例：品类=护理项目 + 最低消费 500，顾客必须购买护理类商品金额 ≥ 500 才能使用本券，美甲等其他分类不计入门槛。若不限品类则退化为全单小计。'
                  >
                    <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--border)] text-[10px] text-[var(--muted-foreground)]">
                      ?
                    </span>
                  </Tooltip>
                </div>
                <Input
                  type="number"
                  placeholder="0 表示无门槛"
                  value={editMinSpend}
                  onChange={(e) => setEditMinSpend(e.target.value)}
                />
              </div>
              {editCouponType !== "折扣券" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">发行总量</label>
                  <Input
                    type="number"
                    placeholder="不填则不限量"
                    value={editTotalCount}
                    onChange={(e) => setEditTotalCount(e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">有效期模式</label>
                <Select
                  value={editValidityMode}
                  onChange={(e) => {
                    const next = e.target.value as "fixed" | "days"
                    setEditValidityMode(next)
                    
                    if (next === "days") {
                      setEditValidFrom("")
                      setEditValidTo("")
                    } else {
                      setEditValidDays("")
                    }
                  }}
                >
                  <option value="days">领取后N天</option>
                  <option value="fixed">固定时段</option>
                </Select>
              </div>
              {editValidityMode === "days" ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">有效天数</label>
                  <Input
                    type="number"
                    placeholder="如 30"
                    value={editValidDays}
                    onChange={(e) => setEditValidDays(e.target.value)}
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">开始日期</label>
                    <Input
                      type="date"
                      value={editValidFrom}
                      onChange={(e) => setEditValidFrom(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">结束日期</label>
                    <Input
                      type="date"
                      value={editValidTo}
                      onChange={(e) => setEditValidTo(e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">状态</label>
                <Select
                  value={editIsActive ? "true" : "false"}
                  onChange={(e) => setEditIsActive(e.target.value === "true")}
                >
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </Select>
              </div>
              {editCouponType === "品项券" && (
                <div className="col-span-2 space-y-3">
                  <label className="text-sm font-medium">适用品项分类</label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={editAllCategories}
                        onChange={(e) => {
                          setEditAllCategories(e.target.checked)
                          if (e.target.checked) setEditSelectedCategoryIds([])
                        }}
                        className="h-4 w-4 rounded border-[var(--input)]"
                      />
                      <span className="text-sm">全部品项</span>
                    </label>
                    {!editAllCategories && (
                      <div className="space-y-3 pl-6">
                        {(() => {
                          const grouped = new Map<string, Category[]>()
                          for (const c of categories) {
                            const kind = c.productKind ?? "未分类"
                            if (!grouped.has(kind)) grouped.set(kind, [])
                            grouped.get(kind)!.push(c)
                          }
                          return [...grouped.entries()].map(([kind, cats]) => (
                            <div key={kind}>
                              <div className="text-xs font-medium text-[var(--muted-foreground)] mb-1">{kind}</div>
                              <div className="grid grid-cols-3 gap-2">
                                {cats.map((c) => (
                                  <label key={c.categoryId} className="flex items-center gap-2">
                                    <input
                                      type="checkbox"
                                      checked={editSelectedCategoryIds.includes(c.categoryId)}
                                      onChange={(e) => {
                                        setEditSelectedCategoryIds((prev) =>
                                          e.target.checked
                                            ? [...prev, c.categoryId]
                                            : prev.filter((id) => id !== c.categoryId)
                                        )
                                      }}
                                      className="h-4 w-4 rounded border-[var(--input)]"
                                    />
                                    <span className="text-sm">{c.categoryName}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          ))
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="col-span-2 space-y-3">
                <label className="text-sm font-medium">适用市场</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={editAllMarkets}
                      onChange={(e) => {
                        setEditAllMarkets(e.target.checked)
                        if (e.target.checked) setEditSelectedMarketIds([])
                      }}
                      className="h-4 w-4 rounded border-[var(--input)]"
                    />
                    <span className="text-sm">全部市场</span>
                  </label>
                  {!editAllMarkets && (
                    <div className="grid grid-cols-3 gap-2 pl-6">
                      {markets.map((m) => (
                        <label key={m.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={editSelectedMarketIds.includes(m.id)}
                            onChange={(e) => {
                              setEditSelectedMarketIds((prev) =>
                                e.target.checked
                                  ? [...prev, m.id]
                                  : prev.filter((id) => id !== m.id)
                              )
                            }}
                            className="h-4 w-4 rounded border-[var(--input)]"
                          />
                          <span className="text-sm">{m.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">描述说明</label>
                <textarea
                  className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] min-h-[80px]"
                  placeholder="请输入券的使用说明"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">券名称</div>
                <div className="mt-1 font-medium">{template.name}</div>
              </div>
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">券类型</div>
                <div className="mt-1 font-medium">{template.couponType}</div>
              </div>
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">面值/折扣</div>
                <div className="mt-1 font-medium">
                  {template.couponType === "折扣券"
                    ? `${(parseFloat(template.discountValue) * 10).toFixed(1)}折`
                    : formatCurrency(template.discountValue)}
                </div>
              </div>
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">使用条件</div>
                <div className="mt-1 font-medium">
                  {template.minSpend && parseFloat(template.minSpend) > 0
                    ? `满${formatCurrency(template.minSpend)}可用`
                    : "无门槛"}
                </div>
              </div>
              {template.couponType !== "折扣券" && (
                <div>
                  <div className="text-sm text-[var(--muted-foreground)]">发行总量</div>
                  <div className="mt-1 font-medium">
                    {template.totalCount ?? "不限"}
                  </div>
                </div>
              )}
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">有效期</div>
                <div className="mt-1 font-medium">
                  {template.validityMode === "days"
                    ? `领取后${template.validDays}天`
                    : template.validFrom && template.validTo
                    ? `${formatDate(template.validFrom)} ~ ${formatDate(template.validTo)}`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">状态</div>
                <div className="mt-1">
                  <Badge
                    variant="outline"
                    className={
                      template.isActive
                        ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
                        : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
                    }
                  >
                    {template.isActive ? "启用" : "停用"}
                  </Badge>
                </div>
              </div>
              {template.couponType === "品项券" && (
                <div className="col-span-2">
                  <div className="text-sm text-[var(--muted-foreground)]">适用品项分类</div>
                  <div className="mt-1 font-medium">
                    {!template.applicableCategoryIds || template.applicableCategoryIds.length === 0
                      ? "全部品项"
                      : template.applicableCategoryIds.map((id) => categoryMap.get(id) ?? id).join('、')}
                  </div>
                </div>
              )}
              <div className="col-span-2">
                <div className="text-sm text-[var(--muted-foreground)]">适用市场</div>
                <div className="mt-1 font-medium">
                  {!template.applicableMarketIds || template.applicableMarketIds.length === 0
                    ? "全部市场"
                    : template.applicableMarketIds.map((id) => marketMap.get(id) ?? id).join('、')}
                </div>
              </div>
              {template.description && (
                <div className="col-span-2">
                  <div className="text-sm text-[var(--muted-foreground)]">描述</div>
                  <div className="mt-1 text-sm">{template.description}</div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">已发放优惠券</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={issuedColumns}
            data={issuedCoupons}
            emptyText="暂无已发放记录"
          />
        </CardContent>
      </Card>

      {}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogHeader>
          <DialogTitle>发放优惠券 - {template.name}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">顾客手机号</label>
            <div className="flex gap-2">
              <Input
                placeholder="请输入手机号"
                value={issuePhone}
                onChange={(e) => {
                  setIssuePhone(e.target.value)
                  setIssueSearched(false)
                  setIssueCustomerName("")
                }}
              />
              <Button variant="outline" onClick={handleSearchCustomer}>
                搜索
              </Button>
            </div>
          </div>
          {issueSearched && issueCustomerName && (
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
              <div className="text-sm text-[var(--muted-foreground)]">匹配顾客</div>
              <div className="mt-1 font-medium">{issueCustomerName}</div>
              <div className="text-sm text-[var(--muted-foreground)]">{issuePhone}</div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIssueOpen(false)}>
            取消
          </Button>
          <Button onClick={handleIssueCoupon} disabled={!issueSearched || !issueCustomerName || issueLoading}>
            {issueLoading ? "发放中..." : "确认发放"}
          </Button>
        </DialogFooter>
      </Dialog>

      {}
      <Dialog open={batchOpen} onOpenChange={(open) => { if (!open) handleCloseBatch(); else setBatchOpen(true) }} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>批量发放优惠券 - {template.name}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          {}
          <div className="flex gap-2">
            <Button
              variant={batchMode === "manual" ? "default" : "outline"}
              size="sm"
              onClick={() => setBatchMode("manual")}
            >
              手动输入
            </Button>
            <Button
              variant={batchMode === "select" ? "default" : "outline"}
              size="sm"
              onClick={() => setBatchMode("select")}
            >
              筛选选择
            </Button>
          </div>

          {batchMode === "manual" ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">手机号列表</label>
              <textarea
                className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] min-h-[120px] font-mono"
                placeholder={"请输入手机号，每行一个或用逗号分隔\n13800138000\n13900139000"}
                value={batchPhoneText}
                onChange={(e) => {
                  setBatchPhoneText(e.target.value)
                  setBatchErrors([])
                }}
              />
              {parsedPhones.length > 0 && (
                <div className="text-sm text-[var(--muted-foreground)]">
                  已识别 {parsedPhones.length} 个手机号
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {}
              <div className="flex gap-2">
                <OrgTreeSelect
                  orgNodes={batchOrgNodes}
                  value={batchOrgFilter}
                  onChange={(id) => setBatchOrgFilter(id)}
                  placeholder="全部门店"
                  excludeTypes={["部门"]}
                  className="w-48"
                />
                <Select
                  value={batchLevelFilter}
                  onChange={(e) => setBatchLevelFilter(e.target.value)}
                  className="w-32"
                >
                  <option value="">全部等级</option>
                  <option value="黑钻">黑钻</option>
                  <option value="金钻">金钻</option>
                  <option value="粉钻">粉钻</option>
                  <option value="星钻">星钻</option>
                  <option value="初钻">初钻</option>
                </Select>
                <Input
                  placeholder="搜索姓名/手机号"
                  value={batchSearch}
                  onChange={(e) => setBatchSearch(e.target.value)}
                  className="flex-1"
                />
              </div>

              {}
              <div className="rounded-[var(--radius)] border border-[var(--border)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--muted)]/50">
                      <th className="w-10 px-3 py-2 text-left">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-[var(--input)]"
                          checked={batchCustomers.length > 0 && batchCustomers.filter((c) => c.phone).every((c) => batchSelected.has(c.phone!))}
                          onChange={toggleSelectAllPage}
                        />
                      </th>
                      <th className="px-3 py-2 text-left font-medium">姓名</th>
                      <th className="px-3 py-2 text-left font-medium">手机号</th>
                      <th className="px-3 py-2 text-left font-medium">门店</th>
                      <th className="px-3 py-2 text-left font-medium">等级</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchCustomers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-[var(--muted-foreground)]">
                          暂无数据
                        </td>
                      </tr>
                    ) : (
                      batchCustomers.map((c) => (
                        <tr key={c.userId} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/30">
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-[var(--input)]"
                              checked={!!c.phone && batchSelected.has(c.phone)}
                              onChange={() => c.phone && toggleBatchSelect(c.phone)}
                              disabled={!c.phone}
                            />
                          </td>
                          <td className="px-3 py-2 font-medium">{c.name || "—"}</td>
                          <td className="px-3 py-2 font-mono">{formatPhoneSafe(c.phone)}</td>
                          <td className="px-3 py-2">{c.storeName || "—"}</td>
                          <td className="px-3 py-2">{c.memberLevel || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <Pagination
                total={batchTotal}
                page={batchPage}
                pageSize={10}
                onPageChange={handleBatchPageChange}
              />

              {batchSelected.size > 0 && (
                <div className="text-sm text-[var(--muted-foreground)]">
                  已选 {batchSelected.size} 位顾客
                </div>
              )}
            </div>
          )}

          {}
          {batchErrors.length > 0 && (
            <div className="rounded-[var(--radius)] border border-[#D94040]/30 bg-[#FFF0F0] p-3 space-y-1">
              <div className="text-sm font-medium text-[#D94040]">以下手机号未匹配到顾客：</div>
              {batchErrors.map((e) => (
                <div key={e.phone} className="text-sm text-[#D94040] font-mono">
                  {formatPhoneSafe(e.phone)}
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCloseBatch}>
            取消
          </Button>
          <Button onClick={handleBatchIssue} disabled={batchPhoneList.length === 0 || batchLoading}>
            {batchLoading ? "发放中..." : `确认发放（${batchPhoneList.length}张）`}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
