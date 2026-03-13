"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import type { CouponType } from "@/lib/types"

export default function CouponCreatePage() {
  const router = useRouter()
  const [couponType, setCouponType] = useState<CouponType | "">("")
  const [validityMode, setValidityMode] = useState<"fixed" | "days">("days")

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
              <Input placeholder="请输入券名称" />
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
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">最低消费</label>
              <Input type="number" placeholder="0 表示无门槛" />
            </div>
            {couponType === "折扣券" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">最高抵扣</label>
                <Input type="number" placeholder="折扣封顶金额" />
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">发行总量</label>
              <Input type="number" placeholder="不填则不限量" />
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
                <Input type="number" placeholder="如 30" />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">开始日期</label>
                  <Input type="date" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">结束日期</label>
                  <Input type="date" />
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
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button>创建优惠券</Button>
      </div>
    </div>
  )
}
