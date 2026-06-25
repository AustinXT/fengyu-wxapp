"use client"

import { useState, useCallback, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { Customer, Store, OrgNode } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog"
import { formatPhone } from "@/lib/utils"
import { actionErrorMessage } from "@/lib/action-error"
import { createCustomer } from "@/actions/customers"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

const MEMBER_LEVEL_COLORS: Record<string, string> = {
  "黑钻": "border-[#333333] text-[#333333] bg-[#F0F0F0]",
  "金钻": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "粉钻": "border-[#C06088] text-[#C06088] bg-[#FDF0F5]",
  "星钻": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "初钻": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
}

const MEMBER_LEVELS = ["黑钻", "金钻", "粉钻", "星钻", "初钻"]

const CUSTOMER_SOURCES = ["美团", "抖音", "小程序", "推带新", "地推卡", "拓客卡", "老带新", "转让店", "自进店", "内部员工或家属"]

const CUSTOMER_TYPES = ["流量客", "体验客", "小美客", "会员客"]
const SPENDING_TIERS = ["10W+", "6-10W", "3-6W", "1-3W", "1990-1W", "<1990"]
const MONTHLY_ACTIVITIES = ["二次客活", "一次客活", "0次客活"]
const CUSTOMER_STATUSES = ["保有会员-稳定", "保有会员-有效", "沉睡", "冰冻", "休眠"]

const CUSTOMER_TYPE_COLORS: Record<string, string> = {
  "会员客": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "小美客": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "体验客": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "流量客": "border-[#888888] text-[#888888] bg-[#F5F5F5]",
}

const CUSTOMER_STATUS_COLORS: Record<string, string> = {
  "保有会员-稳定": "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]",
  "保有会员-有效": "border-[#5E8BB3] text-[#5E8BB3] bg-[#F0F5FA]",
  "沉睡": "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
  "冰冻": "border-[#D94040] text-[#D94040] bg-[#FFF0F0]",
  "休眠": "border-[#888888] text-[#888888] bg-[#F5F5F5]",
}

/**
 * 顾客列表页 — 服务端分页
 *
 * 数据已在 Server Component 中通过 getCustomersPaginated() 完成 DB 级过滤+分页。
 */
export default function CustomersPage({
  customers,
  stores,
  orgNodes,
  total,
}: {
  customers: Customer[]
  stores: Store[]
  orgNodes: OrgNode[]
  total: number
}) {
  const router = useRouter()
  const { get, set, setMany } = useUrlFilters()
  const setFilter = useCallback((key: string, value: string) => {
    setMany({ [key]: value, page: '' })
  }, [setMany])

  const marketFilter = get("market")
  const storeFilter = get("store")
  const levelFilter = get("level")
  const sourceFilter = get("source")
  const typeFilter = get("type")
  const tierFilter = get("tier")
  const activityFilter = get("activity")
  const statusFilter = get("status")
  const currentPage = Math.max(1, Number(get("page", "1")) || 1)
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  // 市场列表
  const markets = useMemo(() =>
    orgNodes.filter(n => n.type === '市场' && n.isActive),
    [orgNodes]
  )

  // 根据选中市场过滤门店列表
  const filteredStores = useMemo(() => {
    if (!marketFilter) return stores
    const storeNodeIds = new Set(
      orgNodes.filter(n => n.parentId === marketFilter && n.type === '门店').map(n => n.id)
    )
    return stores.filter(s => s.orgNodeId && storeNodeIds.has(s.orgNodeId))
  }, [stores, orgNodes, marketFilter])

  // 搜索防抖
  const [searchInput, setSearchInput] = useState(get("q"))
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef[0]) clearTimeout(debounceRef[0])
    debounceRef[0] = setTimeout(() => setFilter("q", value), 300)
  }, [setFilter, debounceRef])

  // Create dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newPhone, setNewPhone] = useState("")
  const [newName, setNewName] = useState("")

  async function handleCreate() {
    if (!newPhone.trim()) {
      toast.error("请输入手机号")
      return
    }
    if (!newName.trim()) {
      toast.error("请输入姓名")
      return
    }

    setCreating(true)
    try {
      const result = await createCustomer({
        phone: newPhone.trim(),
        name: newName.trim(),
      })
      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(result.message)
      setDialogOpen(false)
      setNewPhone("")
      setNewName("")
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "创建失败，请稍后重试"))
    } finally {
      setCreating(false)
    }
  }

  const columns: Column<Customer>[] = [
    {
      key: "name",
      header: "姓名",
      cell: (row) => <span className="font-medium">{row.name ?? "—"}</span>,
    },
    {
      key: "phone",
      header: "手机号",
      cell: (row) => <span>{row.phone ? formatPhone(row.phone) : "—"}</span>,
    },
    {
      key: "storeName",
      header: "归属门店",
      cell: (row) => <span>{row.storeName ?? "—"}</span>,
    },
    {
      key: "customerType",
      header: "顾客类型",
      cell: (row) => (
        <Badge
          variant="outline"
          className={CUSTOMER_TYPE_COLORS[row.customerType] ?? ""}
        >
          {row.customerType}
        </Badge>
      ),
    },
    {
      key: "memberLevel",
      header: "会员等级",
      cell: (row) =>
        row.memberLevel ? (
          <Badge
            variant="outline"
            className={MEMBER_LEVEL_COLORS[row.memberLevel] ?? ""}
          >
            {row.memberLevel}
          </Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "spendingTier",
      header: "消费档位",
      cell: (row) => <span>{row.spendingTier}</span>,
    },
    {
      key: "customerStatus",
      header: "到店状态",
      cell: (row) =>
        row.customerStatus ? (
          <Badge
            variant="outline"
            className={CUSTOMER_STATUS_COLORS[row.customerStatus] ?? ""}
          >
            {row.customerStatus}
          </Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "employeeName",
      header: "所属美容师",
      cell: (row) => <span>{row.employeeName ?? "—"}</span>,
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Link href={`/customers/${row.userId}`}>
          <Button variant="link" size="sm" className="h-auto p-0">
            详情
          </Button>
        </Link>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">顾客管理</h1>
        <Button onClick={() => setDialogOpen(true)}>新增顾客</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={marketFilter}
          onChange={(e) => setMany({ market: e.target.value, store: '', page: '' })}
          className="w-32"
        >
          <option value="">全部市场</option>
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select
          value={storeFilter}
          onChange={(e) => setFilter("store", e.target.value)}
          className="w-40"
        >
          <option value="">全部门店</option>
          {filteredStores.map((s) => (
            <option key={s.storeId} value={s.storeId}>
              {s.storeName}
            </option>
          ))}
        </Select>
        <Select
          value={levelFilter}
          onChange={(e) => setFilter("level", e.target.value)}
          className="w-32"
        >
          <option value="">会员等级</option>
          {MEMBER_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
        <Select
          value={sourceFilter}
          onChange={(e) => setFilter("source", e.target.value)}
          className="w-36"
        >
          <option value="">顾客来源</option>
          {CUSTOMER_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          value={typeFilter}
          onChange={(e) => setFilter("type", e.target.value)}
          className="w-32"
        >
          <option value="">顾客类型</option>
          {CUSTOMER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          value={tierFilter}
          onChange={(e) => setFilter("tier", e.target.value)}
          className="w-32"
        >
          <option value="">消费档位</option>
          {SPENDING_TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          value={activityFilter}
          onChange={(e) => setFilter("activity", e.target.value)}
          className="w-32"
        >
          <option value="">月度客活</option>
          {MONTHLY_ACTIVITIES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => setFilter("status", e.target.value)}
          className="w-36"
        >
          <option value="">到店状态</option>
          {CUSTOMER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input
          placeholder="搜索姓名 / 手机号"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <DataTable columns={columns} data={customers} />

      <Pagination
        total={total}
        pageSize={pageSize}
        page={currentPage}
        onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageSizeChange={(size) => setMany({ size: String(size), page: '' })}
      />

      {/* 新增顾客 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogClose onOpenChange={setDialogOpen} />
        <DialogHeader>
          <DialogTitle>新增顾客</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div>
            <label className="text-sm text-[#999999]">
              手机号 <span className="text-[#D94040]">*</span>
            </label>
            <Input
              className="mt-1"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="请输入手机号"
            />
          </div>
          <div>
            <label className="text-sm text-[#999999]">
              姓名 <span className="text-[#D94040]">*</span>
            </label>
            <Input
              className="mt-1"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="请输入姓名"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>
            取消
          </Button>
          <Button
            loading={creating}
            disabled={!newPhone.trim() || !newName.trim()}
            onClick={handleCreate}
          >
            确认创建
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
