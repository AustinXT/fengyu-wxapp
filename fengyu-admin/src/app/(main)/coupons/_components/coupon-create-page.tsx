"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { createTemplate } from "@/actions/coupons"
import type { CouponType } from "@/lib/types"

export default function CouponCreatePage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
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

    setSaving(true)
    try {
      const templateId = `tpl-${Date.now()}`
      await createTemplate({
        templateId,
        name: name.trim(),
        couponType,
        discountValue,
        minSpend: minSpend || undefined,
        maxDiscount: couponType === "折扣券" && maxDiscount ? maxDiscount : null,
        totalCount: totalCount ? parseInt(totalCount, 10) : null,
        validityMode,
        validFrom: validityMode === "fixed" && validFrom ? validFrom : null,
        validTo: validityMode === "fixed" && validTo ? validTo : null,
        validDays: validityMode === "days" && validDays ? parseInt(validDays, 10) : null,
        description: description.trim() || null,
        isActive: true,
      })
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
    <div className="space-y-4">
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
                <option value="项目券">项目券</option>
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
              <label className="text-sm font-medium">最低消费</label>
              <Input
                type="number"
                placeholder="0 表示无门槛"
                value={minSpend}
                onChange={(e) => setMinSpend(e.target.value)}
              />
            </div>
            {couponType === "折扣券" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">最高抵扣</label>
                <Input
                  type="number"
                  placeholder="折扣封顶金额"
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">发行总量</label>
              <Input
                type="number"
                placeholder="不填则不限量"
                value={totalCount}
                onChange={(e) => setTotalCount(e.target.value)}
              />
            </div>
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
                onChange={(e) => setValidityMode(e.target.value as "fixed" | "days")}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">其他信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <label className="text-sm font-medium">描述说明</label>
            <textarea
              className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 min-h-[80px]"
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
