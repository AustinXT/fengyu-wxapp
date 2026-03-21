"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { formatCurrency, formatDate } from "@/lib/utils"
import { updateTemplate, issueCoupon } from "@/actions/coupons"
import type { CouponTemplate, CouponType, IssuedCoupon } from "@/lib/types"

const COUPON_TYPE_COLORS: Record<CouponType, string> = {
  "现金券": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "项目券": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
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

interface Props {
  template: CouponTemplate
  markets: Market[]
  issuedCoupons: IssuedCoupon[]
}

export default function CouponDetailPage({ template, markets, issuedCoupons }: Props) {
  const router = useRouter()

  // Edit mode state
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
  const marketMap = useMemo(() => new Map(markets.map((m) => [m.id, m.name])), [markets])

  // Issue coupon dialog state
  const [issueOpen, setIssueOpen] = useState(false)
  const [issuePhone, setIssuePhone] = useState("")
  const [issueCustomerName, setIssueCustomerName] = useState("")
  const [issueSearched, setIssueSearched] = useState(false)
  const [issueLoading, setIssueLoading] = useState(false)

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

    setSaving(true)
    try {
      const tplResult = await updateTemplate(template.templateId, {
        name: editName.trim(),
        couponType: editCouponType,
        discountValue: editDiscountValue,
        minSpend: editMinSpend || undefined,
        maxDiscount: editCouponType === "折扣券" && editMaxDiscount ? editMaxDiscount : null,
        totalCount: editTotalCount ? parseInt(editTotalCount, 10) : null,
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
      toast.error(err instanceof Error ? err.message : "保存失败，请重试")
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
    } catch {
      toast.error("搜索失败")
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
    } catch {
      toast.error("发放失败，请重试")
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
      cell: (row) => <span>{formatDate(row.issuedAt)}</span>,
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

      {/* Template Info */}
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
                  <option value="项目券">项目券</option>
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
                <label className="text-sm font-medium">最低消费</label>
                <Input
                  type="number"
                  placeholder="0 表示无门槛"
                  value={editMinSpend}
                  onChange={(e) => setEditMinSpend(e.target.value)}
                />
              </div>
              {editCouponType === "折扣券" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">最高抵扣</label>
                  <Input
                    type="number"
                    placeholder="折扣封顶金额"
                    value={editMaxDiscount}
                    onChange={(e) => setEditMaxDiscount(e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">发行总量</label>
                <Input
                  type="number"
                  placeholder="不填则不限量"
                  value={editTotalCount}
                  onChange={(e) => setEditTotalCount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">有效期模式</label>
                <Select
                  value={editValidityMode}
                  onChange={(e) => setEditValidityMode(e.target.value as "fixed" | "days")}
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
              {template.maxDiscount && (
                <div>
                  <div className="text-sm text-[var(--muted-foreground)]">最高抵扣</div>
                  <div className="mt-1 font-medium">{formatCurrency(template.maxDiscount)}</div>
                </div>
              )}
              <div>
                <div className="text-sm text-[var(--muted-foreground)]">发行总量</div>
                <div className="mt-1 font-medium">
                  {template.totalCount ?? "不限"}
                </div>
              </div>
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

      {/* Issued Coupons */}
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

      {/* Issue Coupon Dialog */}
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
    </div>
  )
}
