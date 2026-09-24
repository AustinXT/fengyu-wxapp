"use client"

import { useState, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { CommissionRate } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"

import { DataTable, type Column } from "@/components/ui/data-table"
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { formatCurrency } from "@/lib/utils"
import { actionErrorMessage } from "@/lib/action-error"
import { createRate, updateRate, deleteRate, type MarketOption } from "@/actions/commission"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { SkillTag } from "@/lib/types"
import { SALES_CATEGORIES } from "@/lib/sales-categories"

const ORDER_TYPE_OPTIONS = ["销售单", "服务单"]

interface RateFormData {
  orgId: string
  orderType: string
  roleType: string
  salesCategory: string
  amountTierMin: string
  amountTierMax: string
  commissionRate: string
}

const emptyForm = (defaultOrgId: string, skillTags: SkillTag[]): RateFormData => ({
  orgId: defaultOrgId,
  orderType: ORDER_TYPE_OPTIONS[0],
  roleType: skillTags[0]?.name ?? "",
  salesCategory: "",
  amountTierMin: "0",
  amountTierMax: "",
  commissionRate: "",
})

interface CommissionPageProps {
  rates: CommissionRate[]
  markets: MarketOption[]
  skillTags: SkillTag[]
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}

export default function CommissionPage({ rates, markets, skillTags, canCreate, canUpdate, canDelete }: CommissionPageProps) {
  const router = useRouter()
  const { get, set } = useUrlFilters()
  const activeTab = get("market") || ""
  const setActiveTab = useCallback((v: string) => set("market", v), [set])
  const orderTypeFilter = get("orderType")
  const roleTypeFilter = get("roleType")
  const salesCategoryFilter = get("salesCategory")

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRate, setEditingRate] = useState<CommissionRate | null>(null)
  const [form, setForm] = useState<RateFormData>(emptyForm(markets[0]?.orgId ?? "", skillTags))
  const [saving, setSaving] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<CommissionRate | null>(null)
  const [deleting, setDeleting] = useState(false)

  const orderTypes = useMemo(
    () => [...new Set(rates.map((r) => r.orderType))],
    [rates]
  )
const salesCategories = useMemo(
    () => [...new Set(rates.map((r) => r.salesCategory))],
    [rates]
  )

  const filteredRates = useMemo(() => {
    let result = activeTab ? rates.filter((r) => r.orgId === activeTab) : rates
    if (orderTypeFilter) result = result.filter((r) => r.orderType === orderTypeFilter)
    if (roleTypeFilter) result = result.filter((r) => r.roleType === roleTypeFilter)
    if (salesCategoryFilter)
      result = result.filter((r) => r.salesCategory === salesCategoryFilter)
    return result
  }, [rates, activeTab, orderTypeFilter, roleTypeFilter, salesCategoryFilter])

  const openAddDialog = () => {
    if (!canCreate) return
    setEditingRate(null)
    setForm(emptyForm(activeTab || (markets[0]?.orgId ?? ""), skillTags))
    setDialogOpen(true)
  }

  const openEditDialog = (row: CommissionRate) => {
    if (!canUpdate) return
    setEditingRate(row)
    setForm({
      orgId: row.orgId,
      orderType: row.orderType,
      roleType: row.roleType,
      salesCategory: row.salesCategory,
      amountTierMin: row.amountTierMin,
      amountTierMax: row.amountTierMax ?? "",
      commissionRate: row.commissionRate,
    })
    setDialogOpen(true)
  }

  const handleSubmit = async () => {
    if ((editingRate && !canUpdate) || (!editingRate && !canCreate)) return
    if (!form.salesCategory.trim()) {
      toast.error("请输入销售分类")
      return
    }
    const rate = parseFloat(form.commissionRate)
    if (isNaN(rate) || rate < 0 || rate > 1) {
      toast.error("提成比例须为 0~1 之间的数值")
      return
    }
    const min = parseFloat(form.amountTierMin)
    if (isNaN(min) || min < 0) {
      toast.error("金额下限须为非负数")
      return
    }
    const maxStr = form.amountTierMax.trim()
    if (maxStr !== "") {
      const max = parseFloat(maxStr)
      if (isNaN(max) || max < 0) {
        toast.error("金额上限须为非负数")
        return
      }
      if (max <= min) {
        toast.error("金额上限须大于下限")
        return
      }
    }

    setSaving(true)
    try {
      if (editingRate) {
        const rateResult = await updateRate(editingRate.id, {
          orgId: form.orgId,
          orderType: form.orderType,
          roleType: form.roleType,
          salesCategory: form.salesCategory.trim(),
          amountTierMin: form.amountTierMin,
          amountTierMax: maxStr || null,
          commissionRate: form.commissionRate,
        }, editingRate.updatedAt)
        if (!rateResult.success) {
          toast.error(rateResult.message)
          if (rateResult.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("规则已更新")
      } else {
        const createResult = await createRate({
          orgId: form.orgId,
          orderType: form.orderType,
          roleType: form.roleType,
          salesCategory: form.salesCategory.trim(),
          amountTierMin: form.amountTierMin,
          amountTierMax: maxStr || null,
          commissionRate: form.commissionRate,
        })
        if (!createResult.success) {
          toast.error(createResult.message)
          return
        }
        toast.success("规则已创建")
      }
      setDialogOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, editingRate ? "更新失败" : "创建失败"))
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!canDelete || !deleteTarget) return
    setDeleting(true)
    try {
      const delResult = await deleteRate(deleteTarget.id)
      if (!delResult.success) {
        toast.error(delResult.message)
        return
      }
      toast.success("规则已删除")
      setDeleteTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(actionErrorMessage(err, "删除失败"))
      console.error(err)
    } finally {
      setDeleting(false)
    }
  }

  const marketMap = useMemo(() => new Map(markets.map(m => [m.orgId, m.name])), [markets])

  const columns: Column<CommissionRate>[] = [
    ...(!activeTab ? [{
      key: "orgName" as const,
      header: "市场",
      cell: (row: CommissionRate) => <span>{row.orgName ?? marketMap.get(row.orgId) ?? row.orgId}</span>,
    }] : []),
    { key: "orderType", header: "订单类型" },
    { key: "roleType", header: "技能标签" },
    { key: "salesCategory", header: "销售分类" },
    {
      key: "amountTier",
      header: "金额区间",
      cell: (row) => (
        <span>
          {formatCurrency(row.amountTierMin)} ~{" "}
          {row.amountTierMax ? formatCurrency(row.amountTierMax) : "无上限"}
        </span>
      ),
    },
    {
      key: "commissionRate",
      header: "提成比例",
      cell: (row) => (
        <span className="font-medium text-[#C0322A]">
          {(parseFloat(row.commissionRate) * 100).toFixed(1)}%
        </span>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex gap-2">
          {canUpdate && <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEditDialog(row)}>
            编辑
          </Button>}
          {canDelete && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[var(--destructive)]"
              onClick={() => setDeleteTarget(row)}
            >
              删除
            </Button>
          )}
        </div>
      ),
    },
  ]

  // Collect unique values for select options (merge defaults + existing data)
  const allOrderTypes = useMemo(
    () => [...new Set([...ORDER_TYPE_OPTIONS, ...orderTypes])],
    [orderTypes]
  )
  const allRoleTypes = useMemo(() => skillTags.map((t) => t.name), [skillTags])
  const allSalesCategories = useMemo(
    () => [...new Set([...SALES_CATEGORIES, ...salesCategories])],
    [salesCategories]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">提成矩阵</h1>
        {canCreate && <Button onClick={openAddDialog}>新增规则</Button>}
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={activeTab}
          onChange={(e) => setActiveTab(e.target.value)}
          className="w-36"
        >
          <option value="">全部市场</option>
          {markets.map((m) => (
            <option key={m.orgId} value={m.orgId}>
              {m.name}
            </option>
          ))}
        </Select>
        <Select
          value={orderTypeFilter}
          onChange={(e) => set("orderType", e.target.value)}
          className="w-32"
        >
          <option value="">全部订单类型</option>
          {allOrderTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          value={roleTypeFilter}
          onChange={(e) => set("roleType", e.target.value)}
          className="w-32"
        >
          <option value="">全部技能标签</option>
          {allRoleTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          value={salesCategoryFilter}
          onChange={(e) => set("salesCategory", e.target.value)}
          className="w-32"
        >
          <option value="">全部销售分类</option>
          {allSalesCategories.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>

      {markets.length === 0 ? (
        <p className="text-sm text-[#999999] py-8 text-center">暂无市场节点，请先在组织架构中创建市场</p>
      ) : (
        <DataTable
          columns={columns}
          data={filteredRates}
          emptyText="暂无提成规则"
        />
      )}

      {/* Add/Edit Dialog */}
      {(canCreate || canUpdate) && <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogHeader>
          <DialogTitle>{editingRate ? "编辑规则" : "新增规则"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">所属市场 *</label>
            <Select
              value={form.orgId}
              onChange={(e) => setForm({ ...form, orgId: e.target.value })}
            >
              {markets.map((tab) => (
                <option key={tab.orgId} value={tab.orgId}>
                  {tab.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">订单类型 *</label>
            <Select
              value={form.orderType}
              onChange={(e) => setForm({ ...form, orderType: e.target.value })}
            >
              {allOrderTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">技能标签 *</label>
            <Select
              value={form.roleType}
              onChange={(e) => setForm({ ...form, roleType: e.target.value })}
            >
              {allRoleTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">销售分类 *</label>
            <Select
              value={form.salesCategory}
              onChange={(e) => setForm({ ...form, salesCategory: e.target.value })}
            >
              <option value="">请选择销售分类</option>
              {SALES_CATEGORIES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">金额下限 *</label>
              <Input
                type="number"
                min={0}
                value={form.amountTierMin}
                onChange={(e) => setForm({ ...form, amountTierMin: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">金额上限</label>
              <Input
                type="number"
                min={0}
                value={form.amountTierMax}
                onChange={(e) => setForm({ ...form, amountTierMax: e.target.value })}
                placeholder="留空表示无上限"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">提成比例 * (0~1)</label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={form.commissionRate}
              onChange={(e) => setForm({ ...form, commissionRate: e.target.value })}
              placeholder="例如 0.15 表示 15%"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </Dialog>}

      {/* Delete Confirmation */}
      {canDelete && <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogTitle>确认删除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要删除该提成规则吗？此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDeleteTarget(null)} disabled={deleting}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={deleting}>
            {deleting ? "删除中..." : "确认删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>}
    </div>
  )
}
