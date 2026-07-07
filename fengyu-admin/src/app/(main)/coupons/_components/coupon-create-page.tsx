"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip } from "@/components/ui/tooltip"
import { createTemplate } from "@/actions/coupons"
import type { CouponType } from "@/lib/types"
import { validateCouponValidityFields } from "./coupon-validity-helper"

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
  markets: Market[]
  categories: Category[]
}

export default function CouponCreatePage({ markets, categories }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [name, setName] = useState("")
  const [couponType, setCouponType] = useState<CouponType | "">("")
  const [discountValue, setDiscountValue] = useState("")
  const [minSpend, setMinSpend] = useState("")
  const [maxDiscount, setMaxDiscount] = useState("")
  const [totalCount, setTotalCount] = useState("")
  const [validityMode, setValidityMode] = useState<"fixed" | "days">("days")
  const [validDays, setValidDays] = useState("")
  const [validFrom, setValidFrom] = useState("")
  const [validTo, setValidTo] = useState("")
  const [description, setDescription] = useState("")
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>([])
  const [allMarkets, setAllMarkets] = useState(true)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([])
  const [allCategories, setAllCategories] = useState(true)

  async function handleCreate() {
    if (!name.trim()) {
      toast.error("请输入券名称")
      return
    }
    if (!couponType) {
      toast.error("请选择券类型")
      return
    }
    if (!discountValue) {
      toast.error("请输入面值/折扣")
      return
    }
    const dv = Number(discountValue)
    if (isNaN(dv) || dv <= 0) {
      toast.error("面值/折扣必须大于 0")
      return
    }
    if (couponType === "折扣券" && dv >= 1) {
      toast.error("折扣券的折扣值必须在 0~1 之间（如 0.85 表示 85 折）")
      return
    }

    const validityCheck = validateCouponValidityFields({
      validityMode,
      validDays,
      validFrom,
      validTo,
    })
    if (!validityCheck.ok) {
      toast.error(validityCheck.message)
      return
    }

    setSaving(true)
    try {
      const templateId = `tpl-${Date.now()}`
      const result = await createTemplate({
        templateId,
        name: name.trim(),
        couponType,
        discountValue,
        minSpend: minSpend || undefined,
        maxDiscount: null,
        totalCount: couponType === "折扣券" ? null : (totalCount ? parseInt(totalCount, 10) : null),
        applicableCategoryIds: couponType === "品项券" && !allCategories && selectedCategoryIds.length > 0 ? selectedCategoryIds : null,
        validityMode,
        validFrom: validityMode === "fixed" && validFrom ? validFrom : null,
        validTo: validityMode === "fixed" && validTo ? validTo : null,
        validDays: validityMode === "days" && validDays ? parseInt(validDays, 10) : null,
        applicableMarketIds: allMarkets ? null : (selectedMarketIds.length > 0 ? selectedMarketIds : null),
        description: description.trim() || null,
        isActive: true,
      })
      if (!result.success) {
        toast.error(result.message)
        return
      }
      setFormDirty(false)
      toast.success("优惠券创建成功")
      router.push("/coupons")
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4" onInput={() => setFormDirty(true)}>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新增优惠券</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">券名称</label>
              <Input
                placeholder="请输入券名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">券类型</label>
              <Select
                value={couponType}
                onChange={(e) => setCouponType(e.target.value as CouponType)}
              >
                <option value="" disabled>
                  请选择券类型
                </option>
                <option value="现金券">现金券</option>
                <option value="品项券">品项券</option>
                <option value="折扣券">折扣券</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {couponType === "折扣券" ? "折扣率（0~1）" : "面值（元）"}
              </label>
              <Input
                type="number"
                placeholder={couponType === "折扣券" ? "如 0.85 表示8.5折" : "如 50.00"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
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
                value={minSpend}
                onChange={(e) => setMinSpend(e.target.value)}
              />
            </div>
            {couponType !== "折扣券" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">发行总量</label>
                <Input
                  type="number"
                  placeholder="不填则不限量"
                  value={totalCount}
                  onChange={(e) => setTotalCount(e.target.value)}
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">有效期</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">有效期模式</label>
              <Select
                value={validityMode}
                onChange={(e) => {
                  const next = e.target.value as "fixed" | "days"
                  setValidityMode(next)
                  
                  if (next === "days") {
                    setValidFrom("")
                    setValidTo("")
                  } else {
                    setValidDays("")
                  }
                }}
              >
                <option value="days">领取后N天</option>
                <option value="fixed">固定时段</option>
              </Select>
            </div>
            {validityMode === "days" ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">有效天数</label>
                <Input
                  type="number"
                  placeholder="如 30"
                  value={validDays}
                  onChange={(e) => setValidDays(e.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">开始日期</label>
                  <Input
                    type="date"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">结束日期</label>
                  <Input
                    type="date"
                    value={validTo}
                    onChange={(e) => setValidTo(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {couponType === "品项券" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">适用品项分类</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allCategories}
                  onChange={(e) => {
                    setAllCategories(e.target.checked)
                    if (e.target.checked) setSelectedCategoryIds([])
                  }}
                  className="h-4 w-4 rounded border-[var(--input)]"
                />
                <span className="text-sm font-medium">全部品项</span>
              </label>
              {!allCategories && (
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
                                checked={selectedCategoryIds.includes(c.categoryId)}
                                onChange={(e) => {
                                  setSelectedCategoryIds((prev) =>
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
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">适用市场</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allMarkets}
                onChange={(e) => {
                  setAllMarkets(e.target.checked)
                  if (e.target.checked) setSelectedMarketIds([])
                }}
                className="h-4 w-4 rounded border-[var(--input)]"
              />
              <span className="text-sm font-medium">全部市场</span>
            </label>
            {!allMarkets && (
              <div className="grid grid-cols-3 gap-2 pl-6">
                {markets.map((m) => (
                  <label key={m.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedMarketIds.includes(m.id)}
                      onChange={(e) => {
                        setSelectedMarketIds((prev) =>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">其他信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <label className="text-sm font-medium">描述说明</label>
            <textarea
              className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] min-h-[80px]"
              placeholder="请输入券的使用说明"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button onClick={handleCreate} disabled={saving}>
          {saving ? "创建中..." : "创建优惠券"}
        </Button>
      </div>
    </div>
  )
}
