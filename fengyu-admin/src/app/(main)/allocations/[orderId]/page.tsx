"use client"

import { use, useState } from "react"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { MOCK_ORDERS, MOCK_SALE_ALLOCATIONS, MOCK_EMPLOYEES, MOCK_ORG_NODES } from "@/lib/mock-data"

interface AllocationRow {
  id: number
  saleItemId: string
  employeeId: string
  departmentId: string
  amount: string
  ratio: string
}

export default function AllocationEditPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params)
  const order = MOCK_ORDERS.find((o) => o.saleOrderId === orderId)

  const departments = MOCK_ORG_NODES.filter((n) => n.type === "department")
  const activeEmployees = MOCK_EMPLOYEES.filter((e) => !e.isResigned)

  const items = order?.items || []
  const existingAllocations = MOCK_SALE_ALLOCATIONS.filter(
    (a) => items.some((i) => i.saleItemId === a.saleItemId) && !a.isVoid
  )

  const [rows, setRows] = useState<AllocationRow[]>(() => {
    if (existingAllocations.length > 0) {
      return existingAllocations.map((a, idx) => ({
        id: idx,
        saleItemId: a.saleItemId,
        employeeId: a.employeeId,
        departmentId: activeEmployees.find((e) => e.employeeId === a.employeeId)?.orgNodeId || "",
        amount: a.totalAmount,
        ratio: (Number(a.allocationRatio) * 100).toFixed(0),
      }))
    }
    return []
  })

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        id: Date.now(),
        saleItemId: items[0]?.saleItemId || "",
        employeeId: "",
        departmentId: "",
        amount: "",
        ratio: "",
      },
    ])
  }

  const updateRow = (id: number, field: keyof AllocationRow, value: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const updated = { ...r, [field]: value }
        // Auto-calc ratio when amount changes
        if (field === "amount" && order) {
          const totalAmount = Number(order.totalAmount)
          const amount = Number(value)
          if (totalAmount > 0 && !isNaN(amount)) {
            updated.ratio = ((amount / totalAmount) * 100).toFixed(1)
          }
        }
        return updated
      })
    )
  }

  const removeRow = (id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  if (!order) {
    return (
      <div className="py-20 text-center text-[#999999]">
        <p className="text-lg">订单不存在</p>
        <Link href="/allocations" className="text-[var(--primary)] hover:underline mt-2 inline-block">返回分配列表</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/allocations" className="text-[#999999] hover:text-[var(--foreground)]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </Link>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">营业额分配</h1>
      </div>

      {/* 订单摘要 */}
      <Card>
        <CardHeader>
          <CardTitle>订单信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-[#999999]">订单号</span>
              <p className="font-medium mt-1">{order.saleOrderId}</p>
            </div>
            <div>
              <span className="text-[#999999]">顾客</span>
              <p className="font-medium mt-1">{order.customerName || "-"}</p>
            </div>
            <div>
              <span className="text-[#999999]">状态</span>
              <p className="mt-1"><StatusBadge status={order.status} /></p>
            </div>
            <div>
              <span className="text-[#999999]">订单金额</span>
              <p className="font-bold text-lg mt-1 text-[var(--primary)]">¥{Number(order.totalAmount).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 商品明细 */}
      <Card>
        <CardHeader>
          <CardTitle>商品明细</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">商品</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">实收</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">数量</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {items.map((item) => (
                  <tr key={item.saleItemId}>
                    <td className="px-4 py-3 font-medium">{item.skuName || item.productName}</td>
                    <td className="px-4 py-3 text-right">¥{Number(item.received).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 分配表单 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>分配明细</CardTitle>
          <Button size="sm" variant="outline" onClick={addRow}>+ 添加分配人</Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {rows.length > 0 ? (
            rows.map((row) => (
              <div key={row.id} className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end bg-[#FAFAFA] rounded-lg p-4">
                <div>
                  <label className="text-xs text-[#999999]">关联明细</label>
                  <Select
                    className="mt-1"
                    value={row.saleItemId}
                    onChange={(e) => updateRow(row.id, "saleItemId", e.target.value)}
                  >
                    <option value="">选择明细</option>
                    {items.map((item) => (
                      <option key={item.saleItemId} value={item.saleItemId}>
                        {item.skuName || item.productName} (¥{item.received})
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-[#999999]">部门</label>
                  <Select
                    className="mt-1"
                    value={row.departmentId}
                    onChange={(e) => updateRow(row.id, "departmentId", e.target.value)}
                  >
                    <option value="">选择部门</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
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
                    {activeEmployees
                      .filter((e) => !row.departmentId || e.orgNodeId === row.departmentId)
                      .map((e) => (
                        <option key={e.employeeId} value={e.employeeId}>{e.name} ({e.positionName})</option>
                      ))}
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-[#999999]">金额</label>
                  <Input
                    className="mt-1"
                    type="number"
                    placeholder="0.00"
                    value={row.amount}
                    onChange={(e) => updateRow(row.id, "amount", e.target.value)}
                  />
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="text-xs text-[#999999]">比例</label>
                    <Input className="mt-1" value={row.ratio ? `${row.ratio}%` : ""} readOnly />
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeRow(row.id)} className="text-[#D94040]">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-center text-[#999999] py-8">暂无分配记录，点击"添加分配人"开始分配</p>
          )}

          <Separator />

          <div className="flex justify-end gap-3">
            <Link href="/allocations">
              <Button variant="outline">取消</Button>
            </Link>
            <Button onClick={() => alert("保存分配成功（Mock）")}>保存分配</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
