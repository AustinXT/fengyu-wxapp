"use client"

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import { use } from "react"
import { MOCK_COUPON_TEMPLATES } from "@/lib/mock-data"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { DataTable, type Column } from "@/components/ui/data-table"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { CouponType } from "@/lib/types"

const COUPON_TYPE_COLORS: Record<CouponType, string> = {
  "现金券": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "项目券": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "折扣券": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
}

interface IssuedCoupon {
  couponId: string
  customerName: string
  phone: string
  status: string
  issuedAt: string
  usedAt: string | null
}

const MOCK_ISSUED_COUPONS: IssuedCoupon[] = [
  {
    couponId: "c-001",
    customerName: "林美",
    phone: "139****9001",
    status: "已使用",
    issuedAt: "2026-02-01T10:00:00Z",
    usedAt: "2026-02-15T14:30:00Z",
  },
  {
    couponId: "c-002",
    customerName: "杨雪",
    phone: "139****9002",
    status: "未使用",
    issuedAt: "2026-03-01T09:00:00Z",
    usedAt: null,
  },
  {
    couponId: "c-003",
    customerName: "何丽",
    phone: "139****9003",
    status: "已过期",
    issuedAt: "2026-01-15T11:00:00Z",
    usedAt: null,
  },
]

const ISSUED_STATUS_COLORS: Record<string, string> = {
  "已使用": "border-[#888888] text-[#888888] bg-[#F5F5F5]",
  "未使用": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "已过期": "border-[#D94040] text-[#D94040] bg-[#FFF0F0]",
}

export default function CouponDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const template = useMemo(
    () => MOCK_COUPON_TEMPLATES.find((t) => t.templateId === id) ?? null,
    [id]
  )

  if (!template) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <p className="text-[var(--muted-foreground)]">优惠券不存在</p>
      </div>
    )
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
            <Button variant="outline" size="sm">
              编辑
            </Button>
            <Button size="sm">发放优惠券</Button>
          </div>
        </CardHeader>
        <CardContent>
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
            {template.description && (
              <div className="col-span-2">
                <div className="text-sm text-[var(--muted-foreground)]">描述</div>
                <div className="mt-1 text-sm">{template.description}</div>
              </div>
            )}
          </div>
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
            data={MOCK_ISSUED_COUPONS}
            emptyText="暂无已发放记录"
          />
        </CardContent>
      </Card>
    </div>
  )
}
