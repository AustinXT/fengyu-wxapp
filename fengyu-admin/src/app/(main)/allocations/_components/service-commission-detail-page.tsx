"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { batchSaveServiceCommissions } from "@/actions/service-commissions"
import type { ServiceOrder, ServiceCommission, Employee, CommissionRate } from "@/lib/types"
import type { ServiceItemDetail } from "@/actions/services"

const ROLE_TYPE_OPTIONS = ["美容师", "养生师", "推广师"] as const

interface CommissionRow {
  id: number
  serviceItemId: string
  employeeId: string
  roleType: string
  rate: string
  amount: string
}

/** 从员工的部门/职位推断提成角色类型 */
function inferRoleType(employee: Employee): string {
  const dept = employee.departmentName || ''
  const pos = employee.positionName || ''
  if (dept.includes('推广') || pos.includes('推广')) return '推广师'
  return '美容师'
}

/** 根据市场、角色、销售分类、金额匹配提成比例（服务单） */
function findMatchingRate(
  rates: CommissionRate[],
  marketName: string,
  roleType: string,
  salesCategory: string | null,
  amount: number,
): CommissionRate | null {
  return rates.find((r) =>
    r.orgName === marketName &&
    r.orderType === '服务单' &&
    r.roleType === roleType &&
    r.salesCategory === (salesCategory || '') &&
    Number(r.amountTierMin) <= amount &&
    (r.amountTierMax === null || Number(r.amountTierMax) > amount)
  ) ?? null
}

export default function ServiceCommissionDetailPageClient({
  serviceOrder,
  serviceItems,
  commissions,
  employees,
  commissionRates = [],
}: {
  serviceOrder: ServiceOrder
  serviceItems: ServiceItemDetail[]
  commissions: ServiceCommission[]
  employees: Employee[]
  commissionRates?: CommissionRate[]
}) {
  const activeEmployees = employees.filter((e) => !e.isResigned && e.storeId === serviceOrder.storeId)

  const [rows, setRows] = useState<CommissionRow[]>(() => {
    if (commissions.length > 0) {
      return commissions.map((c, idx) => {
        const emp = employees.find((e) => e.employeeId === c.employeeId)
        return {
          id: idx,
          serviceItemId: c.serviceItemId,
          employeeId: c.employeeId,
          roleType: emp ? inferRoleType(emp) : '',
          rate: (Number(c.commissionRate) * 100).toFixed(1),
          amount: c.commissionAmount,
        }
      })
    }
    return []
  })

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        id: Date.now(),
        serviceItemId: serviceItems[0]?.serviceItemId || "",
        employeeId: "",
        roleType: "",
        rate: "",
        amount: "",
      },
    ])
  }

  /** 根据当前行数据自动从提成矩阵查找比例并计算金额 */
  const autoFillFromMatrix = (row: CommissionRow): CommissionRow => {
    const item = serviceItems.find((i) => i.serviceItemId === row.serviceItemId)
    if (!item || !row.roleType || commissionRates.length === 0) return row
    const unitPrice = Number(item.unitRealPrice)
    const match = findMatchingRate(
      commissionRates,
      serviceOrder.marketName,
      row.roleType,
      item.salesCategory ?? null,
      unitPrice,
    )
    if (!match) return row
    const ratioPercent = (Number(match.commissionRate) * 100).toFixed(1)
    return { ...row, rate: ratioPercent, amount: (unitPrice * Number(match.commissionRate)).toFixed(2) }
  }

  const updateRow = (id: number, field: keyof CommissionRow, value: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const updated = { ...r, [field]: value }
        if (field === "employeeId" && value) {
          const emp = activeEmployees.find((e) => e.employeeId === value)
          if (emp) updated.roleType = inferRoleType(emp)
        }
        if (field === "roleType" || field === "serviceItemId" || field === "employeeId") {
          return autoFillFromMatrix(updated)
        }
        if (field === "rate") {
          const item = serviceItems.find((i) => i.serviceItemId === updated.serviceItemId)
          const unitPrice = item ? Number(item.unitRealPrice) : 0
          const ratio = Number(value)
          if (unitPrice > 0 && !isNaN(ratio)) {
            updated.amount = ((ratio / 100) * unitPrice).toFixed(2)
          }
        }
        if (field === "amount") {
          const item = serviceItems.find((i) => i.serviceItemId === updated.serviceItemId)
          const unitPrice = item ? Number(item.unitRealPrice) : 0
          const amt = Number(value)
          if (unitPrice > 0 && !isNaN(amt)) {
            updated.rate = ((amt / unitPrice) * 100).toFixed(1)
          }
        }
        return updated
      })
    )
  }

  const removeRow = (id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/allocations?tab=service" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">服务提成分配</h1>
      </div>

      {/* 服务单摘要 */}
      <Card>
        <CardHeader>
          <CardTitle>服务单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#999999]">服务单号</span>
              <p className="font-medium mt-1">{serviceOrder.serviceOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{serviceOrder.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={serviceOrder.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">美容师</span>
              <p className="font-medium mt-1">{serviceOrder.employeeName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">门店</span>
              <p className="font-medium mt-1">{serviceOrder.storeName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">服务日期</span>
              <p className="font-medium mt-1">{serviceOrder.serviceDate}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 服务明细 */}
      <Card>
        <CardHeader>
          <CardTitle>服务明细</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">商品名称</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">规格</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">销售分类</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">单价</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">核销次数</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">操作员</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {serviceItems.map((item) => (
                  <tr key={item.serviceItemId}>
                    <td className="px-4 py-3 font-medium">{item.productName || '-'}</td>
                    <td className="px-4 py-3 text-[#666666]">{item.skuName || '-'}</td>
                    <td className="px-4 py-3 text-[#666666]">{item.salesCategory || '-'}</td>
                    <td className="px-4 py-3 text-right">¥{Number(item.unitRealPrice).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{item.sessionUsed}</td>
                    <td className="px-4 py-3">{item.employeeName || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 提成分配表单 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>提成分配</CardTitle>
          <Button size="sm" variant="outline" onClick={addRow}>+ 添加分配人</Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {rows.length > 0 ? (
            rows.map((row) => (
              <div key={row.id} className="bg-[#FAFAFA] rounded-lg p-4">
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                  <div>
                    <label className="text-xs text-[#999999]">关联明细</label>
                    <Select
                      className="mt-1"
                      value={row.serviceItemId}
                      onChange={(e) => updateRow(row.id, "serviceItemId", e.target.value)}
                    >
                      <option value="">选择明细</option>
                      {serviceItems.map((item) => (
                        <option key={item.serviceItemId} value={item.serviceItemId}>
                          {item.productName}{item.skuName ? ` - ${item.skuName}` : ''}{item.salesCategory ? ` [${item.salesCategory}]` : ''} (¥{item.unitRealPrice})
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-[#999999]">员工</label>
                    <Select
                      className="mt-1"
                      value={row.employeeId}
                      onChange={(e) => updateRow(row.id, "employeeId", e.target.value)}
                    >
                      <option value="">选择员工</option>
                      {activeEmployees.map((e) => (
                        <option key={e.employeeId} value={e.employeeId}>{e.name} ({e.positionName})</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-[#999999]">员工角色</label>
                    <Select
                      className="mt-1"
                      value={row.roleType}
                      onChange={(e) => updateRow(row.id, "roleType", e.target.value)}
                    >
                      <option value="">选择角色</option>
                      {ROLE_TYPE_OPTIONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-[#999999]">提成比例(%)</label>
                    <Input
                      className="mt-1"
                      type="number"
                      placeholder="0.0"
                      value={row.rate}
                      onChange={(e) => updateRow(row.id, "rate", e.target.value)}
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-[#999999]">金额</label>
                      <Input
                        className="mt-1"
                        type="number"
                        placeholder="0.00"
                        value={row.amount}
                        onChange={(e) => updateRow(row.id, "amount", e.target.value)}
                      />
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeRow(row.id)} className="text-[#D94040]">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </Button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="text-center text-[#999999] py-8">暂无提成记录，点击"添加分配人"开始分配</p>
          )}

          <Separator />

          <SaveButton serviceOrderId={serviceOrder.serviceOrderId} rows={rows} />
        </CardContent>
      </Card>
    </div>
  )
}

function SaveButton({ serviceOrderId, rows }: { serviceOrderId: string; rows: CommissionRow[] }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const handleSave = () => {
    const validRows = rows.filter((r) => r.serviceItemId && r.employeeId && r.amount)
    if (validRows.length === 0 && rows.length > 0) {
      toast.error('请填写完整的提成信息')
      return
    }

    // 校验：同一 serviceItemId + employeeId 不能重复
    const seen = new Set<string>()
    for (const r of validRows) {
      const key = `${r.serviceItemId}|${r.employeeId}`
      if (seen.has(key)) {
        toast.error('同一明细行不能分配给同一员工多次，请合并或删除重复行')
        return
      }
      seen.add(key)
    }

    // 校验：金额不能为负数
    for (const r of validRows) {
      if (Number(r.amount) <= 0) {
        toast.error('提成金额必须大于 0')
        return
      }
    }

    startTransition(async () => {
      const res = await batchSaveServiceCommissions(serviceOrderId, validRows.map((r) => ({
        serviceItemId: r.serviceItemId,
        employeeId: r.employeeId,
        commissionRate: (Number(r.rate) / 100).toFixed(4),
        commissionAmount: Number(r.amount).toFixed(2),
      })))
      if (res.success) {
        toast.success(res.message)
        router.push('/allocations?tab=service')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex justify-end gap-3">
      <Link href="/allocations?tab=service">
        <Button variant="outline">取消</Button>
      </Link>
      <Button onClick={handleSave} loading={pending}>保存提成</Button>
    </div>
  )
}
