"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import { toast } from "sonner"
import type { Store } from "@/lib/types"
import type { UnbindRequest } from "@/actions/store-unbind"
import { approveUnbind, rejectUnbind } from "@/actions/store-unbind"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { useRouter } from "next/navigation"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const unbindStatusMap: Record<string, { label: string; className: string }> = {
  pending: { label: "待审批", className: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]" },
  approved: { label: "已通过", className: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]" },
  rejected: { label: "已拒绝", className: "border-[#D94040] text-[#D94040] bg-[#FFF0F0]" },
}

export default function StoresPage({
  stores,
  unbindRequests,
}: {
  stores: Store[]
  unbindRequests: UnbindRequest[]
}) {
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  // 搜索框防抖
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
  const tab = (get("tab") || "stores") as "stores" | "unbind"
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const router = useRouter()

  const pendingCount = unbindRequests.filter((r) => r.status === "pending").length

  const markets = useMemo(() => {
    const names = [...new Set(stores.map((s) => s.marketName).filter(Boolean))] as string[]
    return names.sort()
  }, [stores])

  // ── 门店列表 ──
  const filtered = useMemo(() => {
    let result = stores
    if (marketFilter) {
      result = result.filter((s) => s.marketName === marketFilter)
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(
        (s) =>
          s.storeName.toLowerCase().includes(q) ||
          s.phone?.includes(q)
      )
    }
    return result
  }, [search, marketFilter, stores])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  )

  const columns: Column<Store>[] = [
    { key: "storeName", header: "门店名称" },
    { key: "marketName", header: "所属市场" },
    {
      key: "isClosed",
      header: "营业状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isClosed
              ? "border-[#888888] text-[#888888] bg-[#F5F5F5]"
              : "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
          }
        >
          {row.isClosed ? "已关店" : "营业中"}
        </Badge>
      ),
    },
    {
      key: "bedCount",
      header: "床位数",
      cell: (row) => <span>{row.bedCount ?? "—"}</span>,
    },
    {
      key: "phone",
      header: "联系电话",
      cell: (row) => <span>{row.phone ?? "—"}</span>,
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Link href={`/stores/${row.storeId}/edit`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            编辑
          </Button>
        </Link>
      ),
    },
  ]

  // ── 解绑请求操作 ──
  async function handleApprove(requestId: string) {
    setActionLoading(requestId)
    try {
      const result = await approveUnbind(requestId)
      if (result.success) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.message)
      }
    } catch {
      toast.error("操作失败")
    } finally {
      setActionLoading(null)
    }
  }

  async function handleReject(requestId: string) {
    const reason = window.prompt("请输入拒绝原因")
    if (!reason) return

    setActionLoading(requestId)
    try {
      const result = await rejectUnbind(requestId, reason)
      if (result.success) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.message)
      }
    } catch {
      toast.error("操作失败")
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">门店管理</h1>
        <Link href="/stores/create"><Button>新增门店</Button></Link>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        <button
          onClick={() => set("tab", "")}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
            tab === "stores"
              ? "border-[var(--primary)] text-[var(--primary)]"
              : "border-transparent text-[#999999] hover:text-[var(--foreground)]"
          }`}
        >
          门店列表
        </button>
        <button
          onClick={() => set("tab", "unbind")}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
            tab === "unbind"
              ? "border-[var(--primary)] text-[var(--primary)]"
              : "border-transparent text-[#999999] hover:text-[var(--foreground)]"
          }`}
        >
          解绑申请
          {pendingCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1.5 text-[10px] font-medium text-white">
              {pendingCount}
            </span>
          )}
        </button>
      </div>

      {tab === "stores" && (
        <>
          <div className="flex items-center gap-3">
            <Select
              value={marketFilter}
              onChange={(e) => setFilter("market", e.target.value)}
              className="w-40"
            >
              <option value="">全部市场</option>
              {markets.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
            <Input
              placeholder="搜索门店名称 / 电话"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="max-w-xs"
            />
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
        </>
      )}

      {tab === "unbind" && (
        <div className="rounded-lg border border-[var(--border)] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">顾客</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">手机号</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">原绑定门店</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">备注</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">申请时间</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {unbindRequests.length > 0 ? unbindRequests.map((r) => {
                  const statusInfo = unbindStatusMap[r.status] || { label: r.status, className: "" }
                  return (
                    <tr key={r.requestId} className="hover:bg-[#FFF0EE] transition-colors">
                      <td className="px-4 py-3">{r.customerName ?? "—"}</td>
                      <td className="px-4 py-3 text-[#999999]">{r.customerPhone ?? "—"}</td>
                      <td className="px-4 py-3">{r.fromStoreName ?? r.fromStoreId}</td>
                      <td className="px-4 py-3 text-[#999999] max-w-[200px] truncate">
                        {r.note || (r.rejectReason ? `拒绝：${r.rejectReason}` : "—")}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={statusInfo.className}>
                          {statusInfo.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-[#999999]">
                        {new Date(r.createdAt).toLocaleString("zh-CN")}
                      </td>
                      <td className="px-4 py-3">
                        {r.status === "pending" ? (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleApprove(r.requestId)}
                              loading={actionLoading === r.requestId}
                              disabled={actionLoading !== null}
                            >
                              通过
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleReject(r.requestId)}
                              disabled={actionLoading !== null}
                            >
                              拒绝
                            </Button>
                          </div>
                        ) : (
                          <span className="text-[#999999]">—</span>
                        )}
                      </td>
                    </tr>
                  )
                }) : (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-[#999999]">暂无解绑申请</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
