"use client"

import { useState, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import type { CouponTemplate, CouponType } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { AlertDialog, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { formatCurrency, formatDate } from "@/lib/utils"
import { toast } from "sonner"
import { toggleTemplateActive } from "@/actions/coupons"
import { Select } from "@/components/ui/select"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { ExportButton } from "@/components/ui/export-button"
import { exportToXlsx, fmtDateTime } from "@/lib/export-xlsx"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const COUPON_TYPE_COLORS: Record<CouponType, string> = {
  "现金券": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "品项券": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "折扣券": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
}

function formatDiscount(tpl: CouponTemplate): string {
  if (tpl.couponType === "折扣券") {
    return `${(parseFloat(tpl.discountValue) * 10).toFixed(1)}折`
  }
  return formatCurrency(tpl.discountValue)
}

function formatValidity(tpl: CouponTemplate): string {
  if (tpl.validityMode === "days" && tpl.validDays) {
    return `领取后${tpl.validDays}天`
  }
  if (tpl.validFrom && tpl.validTo) {
    return `${formatDate(tpl.validFrom)} ~ ${formatDate(tpl.validTo)}`
  }
  return "—"
}

interface Market {
  id: string
  name: string
}

interface CouponsPageProps {
  templates: CouponTemplate[]
  markets: Market[]
}

export default function CouponsPage({ templates, markets }: CouponsPageProps) {
  const router = useRouter()
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])
  const [toggleTarget, setToggleTarget] = useState<CouponTemplate | null>(null)

  async function doToggle() {
    if (!toggleTarget) return
    const action = toggleTarget.isActive ? '停用' : '启用'
    try {
      const res = await toggleTemplateActive(toggleTarget.templateId, !toggleTarget.isActive, toggleTarget.updatedAt)
      if (res.success) {
        toast.success(res.message)
        router.refresh()
      } else {
        toast.error(res.message)
        if (res.message.includes('已被其他人修改')) router.refresh()
      }
    } catch {
      toast.error(`${action}失败`)
    } finally {
      setToggleTarget(null)
    }
  }

  
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  const search = get("q")
  const marketFilter = get("market")
  const page = Number(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  const marketMap = useMemo(() => new Map(markets.map((m) => [m.id, m.name])), [markets])

  const filtered = useMemo(() => {
    let list = templates
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((t) => t.name.toLowerCase().includes(q))
    }
    if (marketFilter) {
      list = list.filter((t) =>
        t.applicableMarketIds?.includes(marketFilter)
      )
    }
    return list
  }, [templates, search, marketFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  )

  
  const handleExport = useCallback(async () => {
    if (filtered.length === 0) {
      toast.info("当前筛选无数据可导出")
      return
    }
    await exportToXlsx({
      filename: "优惠券",
      sheetName: "优惠券",
      columns: [
        { header: "券名称", width: 24, accessor: (r) => r.name },
        { header: "券类型", width: 10, accessor: (r) => r.couponType },
        { header: "面值/折扣", accessor: (r) => formatDiscount(r) },
        { header: "使用条件", width: 16, accessor: (r) => (r.minSpend && parseFloat(r.minSpend) > 0 ? `满${formatCurrency(r.minSpend)}可用` : "无门槛") },
        { header: "适用市场", width: 20, accessor: (r) => (!r.applicableMarketIds || r.applicableMarketIds.length === 0 ? "全部市场" : r.applicableMarketIds.map((id) => marketMap.get(id) ?? id).join("、")) },
        { header: "有效期", width: 24, accessor: (r) => formatValidity(r) },
        { header: "已发", accessor: (r) => r.issuedCount },
        { header: "总量", accessor: (r) => (r.couponType === "折扣券" ? "" : r.totalCount ?? "不限") },
        { header: "状态", width: 10, accessor: (r) => (r.isActive ? "启用" : "停用") },
        { header: "创建时间", width: 20, accessor: (r) => fmtDateTime(r.createdAt) },
        { header: "描述", width: 30, accessor: (r) => r.description },
      ],
      rows: filtered,
    })
  }, [filtered, marketMap])

  const columns: Column<CouponTemplate>[] = [
    {
      key: "name",
      header: "券名称",
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "couponType",
      header: "券类型",
      cell: (row) => (
        <Badge variant="outline" className={COUPON_TYPE_COLORS[row.couponType]}>
          {row.couponType}
        </Badge>
      ),
    },
    {
      key: "discountValue",
      header: "面值/折扣",
      cell: (row) => <span className="font-medium">{formatDiscount(row)}</span>,
    },
    {
      key: "minSpend",
      header: "使用条件",
      cell: (row) =>
        row.minSpend && parseFloat(row.minSpend) > 0
          ? `满${formatCurrency(row.minSpend)}可用`
          : "无门槛",
    },
    {
      key: "applicableMarketIds",
      header: "适用市场",
      cell: (row) => {
        if (!row.applicableMarketIds || row.applicableMarketIds.length === 0) {
          return <span className="text-[var(--muted-foreground)]">全部市场</span>
        }
        const names = row.applicableMarketIds.map((id) => marketMap.get(id) ?? id)
        return <span title={names.join('、')}>{names.join('、')}</span>
      },
    },
    {
      key: "validity",
      header: "有效期",
      cell: (row) => <span>{formatValidity(row)}</span>,
    },
    {
      key: "totalCount",
      header: "已发/总量",
      cell: (row) => (
        <span>
          {row.couponType === "折扣券"
            ? row.issuedCount
            : `${row.issuedCount} / ${row.totalCount ?? "不限"}`}
        </span>
      ),
    },
    {
      key: "isActive",
      header: "状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isActive
              ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
              : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
          }
        >
          {row.isActive ? "启用" : "停用"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          <Link href={`/coupons/${row.templateId}`}>
            <Button variant="link" size="sm" className="h-auto p-0">
              详情
            </Button>
          </Link>
          <Button
            variant="link"
            size="sm"
            className={`h-auto p-0 ${row.isActive ? 'text-[var(--destructive)]' : 'text-[#3D8A5A]'}`}
            onClick={() => setToggleTarget(row)}
          >
            {row.isActive ? '停用' : '启用'}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">优惠券管理</h1>
        <Link href="/coupons/create">
          <Button>新增优惠券</Button>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="搜索券名称"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={marketFilter}
          onChange={(e) => setFilter("market", e.target.value)}
          className="w-40"
        >
          <option value="">全部市场</option>
          {markets.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </Select>
        <ExportButton onExport={handleExport} />
      </div>

      <DataTable columns={columns} data={paged} />

      <Pagination
        total={filtered.length}
        pageSize={pageSize}
        page={page}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      <AlertDialog open={!!toggleTarget} onOpenChange={(open) => !open && setToggleTarget(null)}>
        <AlertDialogTitle>确认{toggleTarget?.isActive ? '停用' : '启用'}优惠券？</AlertDialogTitle>
        <AlertDialogDescription>
          将{toggleTarget?.isActive ? '停用' : '启用'}「{toggleTarget?.name}」，操作后立即生效。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setToggleTarget(null)}>取消</AlertDialogCancel>
          <AlertDialogAction onClick={doToggle}>确认{toggleTarget?.isActive ? '停用' : '启用'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
