"use client"

import { useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import type { Customer, SaleOrder, Appointment, SaleItem, Store, Employee } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils"
import { updateCustomer } from "@/actions/customers"

interface CustomerDetailPageProps {
  customer: Customer
  orders: SaleOrder[]
  appointments: Appointment[]
  stores: Store[]
  employees: Employee[]
}

export default function CustomerDetailPage({ customer, orders, appointments, stores, employees }: CustomerDetailPageProps) {
  const router = useRouter()

  // Edit state
  const [isEditing, setIsEditing] = useState(false)
  useUnsavedChanges(isEditing)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: customer.name ?? "",
    boundEmployeeId: customer.boundEmployeeId ?? "",
    customerSource: customer.customerSource ?? "",
    birthday: customer.birthday ?? "",
    occupation: customer.occupation ?? "",
    isMarried: customer.isMarried === true ? "true" : customer.isMarried === false ? "false" : "",
    skinType: customer.skinType ?? "",
    improvementFocus: customer.improvementFocus ?? "",
    skinIssue: customer.skinIssue ?? "",
    wellnessPreference: customer.wellnessPreference ?? "",
  })

  function handleFormChange(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function handleCancelEdit() {
    setForm({
      name: customer.name ?? "",
      boundEmployeeId: customer.boundEmployeeId ?? "",
      customerSource: customer.customerSource ?? "",
      birthday: customer.birthday ?? "",
      occupation: customer.occupation ?? "",
      isMarried: customer.isMarried === true ? "true" : customer.isMarried === false ? "false" : "",
      skinType: customer.skinType ?? "",
      improvementFocus: customer.improvementFocus ?? "",
      skinIssue: customer.skinIssue ?? "",
      wellnessPreference: customer.wellnessPreference ?? "",
    })
    setIsEditing(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const result = await updateCustomer(customer.userId, {
        name: form.name || null,
        boundEmployeeId: form.boundEmployeeId || null,
        customerSource: form.customerSource || null,
        birthday: form.birthday || null,
        occupation: form.occupation || null,
        isMarried: form.isMarried === "true" ? true : form.isMarried === "false" ? false : null,
        skinType: form.skinType || null,
        improvementFocus: form.improvementFocus || null,
        skinIssue: form.skinIssue || null,
        wellnessPreference: form.wellnessPreference || null,
      }, customer.updatedAt)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes("已被其他人修改")) router.refresh()
        return
      }
      toast.success("保存成功")
      setIsEditing(false)
      router.refresh()
    } catch {
      toast.error("保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  // Employees filtered by customer's bound store
  const storeEmployees = useMemo(() => {
    if (!customer.boundStoreId) return employees.filter((e) => !e.isResigned)
    return employees.filter((e) => !e.isResigned && e.storeId === customer.boundStoreId)
  }, [employees, customer.boundStoreId])

  const activeSaleItems = useMemo(() => {
    const allItems: SaleItem[] = []
    for (const order of orders) {
      if (order.items) {
        allItems.push(...order.items)
      }
    }
    return allItems.filter(
      (item) =>
        item.itemDirection === "购买" &&
        item.sessionCount !== null &&
        (item.remainingSessions ?? 0) > 0
    )
  }, [orders])

  const orderColumns: Column<SaleOrder>[] = [
    {
      key: "saleOrderId",
      header: "订单号",
      cell: (row) => (
        <span className="font-mono text-xs">{row.saleOrderId}</span>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "totalAmount",
      header: "金额",
      cell: (row) => <span>{formatCurrency(row.totalAmount)}</span>,
    },
    {
      key: "saleOrderDatetime",
      header: "下单时间",
      cell: (row) => <span>{formatDateTime(row.saleOrderDatetime)}</span>,
    },
    { key: "storeName", header: "门店" },
  ]

  const itemColumns: Column<SaleItem>[] = [
    {
      key: "productName",
      header: "项目名称",
      cell: (row) => <span className="font-medium">{row.productName ?? "—"}</span>,
    },
    {
      key: "skuName",
      header: "规格",
      cell: (row) => <span>{row.skuName ?? "—"}</span>,
    },
    {
      key: "sessionCount",
      header: "总次数",
      cell: (row) => <span>{row.sessionCount ?? "—"}</span>,
    },
    {
      key: "remainingSessions",
      header: "剩余次数",
      cell: (row) => (
        <span className="font-medium text-[#C0322A]">
          {row.remainingSessions ?? "—"}
        </span>
      ),
    },
    {
      key: "expireDate",
      header: "到期日",
      cell: (row) => <span>{row.expireDate ? formatDate(row.expireDate) : "—"}</span>,
    },
  ]

  const appointmentColumns: Column<Appointment>[] = [
    {
      key: "appointmentTime",
      header: "预约时间",
      cell: (row) => <span>{formatDateTime(row.appointmentTime)}</span>,
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => <StatusBadge status={row.status} />,
    },
    { key: "employeeName", header: "美容师" },
    { key: "storeName", header: "门店" },
    {
      key: "notes",
      header: "备注",
      cell: (row) => <span>{row.notes ?? "—"}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          顾客详情 - {customer.name}
        </h1>
        {customer.memberLevel && (
          <Badge variant="outline" className="border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]">
            {customer.memberLevel}
          </Badge>
        )}
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">基本档案</TabsTrigger>
          <TabsTrigger value="orders">消费记录（{orders.length}）</TabsTrigger>
          <TabsTrigger value="sessions">疗程卡余次（{activeSaleItems.length}）</TabsTrigger>
          <TabsTrigger value="appointments">预约记录（{appointments.length}）</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">基本档案</CardTitle>
              {isEditing ? (
                <div className="flex gap-2">
                  <Button size="sm" loading={saving} onClick={handleSave}>
                    保存
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={saving}>
                    取消
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  编辑
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">姓名</label>
                  {isEditing ? (
                    <Input
                      value={form.name}
                      onChange={(e) => handleFormChange("name", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.name ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">手机号</label>
                  <Input value={customer.phone ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">微信昵称</label>
                  <Input value={customer.wechatName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">归属门店</label>
                  <Input value={customer.storeName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属美容师</label>
                  {isEditing ? (
                    <Select
                      value={form.boundEmployeeId}
                      onChange={(e) => handleFormChange("boundEmployeeId", e.target.value)}
                    >
                      <option value="">请选择美容师</option>
                      {storeEmployees.map((emp) => (
                        <option key={emp.employeeId} value={emp.employeeId}>
                          {emp.name} ({emp.positionName ?? "—"})
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={customer.employeeName ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">会员等级</label>
                  <Input value={customer.memberLevel ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">顾客类型</label>
                  <Input value={customer.customerType ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">消费档位</label>
                  <Input value={customer.spendingTier ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">月度客活</label>
                  <Input value={customer.monthlyActivity ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">到店状态</label>
                  <Input value={customer.customerStatus ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">顾客来源</label>
                  {isEditing ? (
                    <Select
                      value={form.customerSource}
                      onChange={(e) => handleFormChange("customerSource", e.target.value)}
                    >
                      <option value="">请选择来源</option>
                      <optgroup label="线上来源">
                        <option value="美团">美团</option>
                        <option value="抖音">抖音</option>
                        <option value="小程序">小程序</option>
                      </optgroup>
                      <optgroup label="线下来源">
                        <option value="推带新">推带新</option>
                        <option value="地推卡">地推卡</option>
                        <option value="拓客卡">拓客卡</option>
                        <option value="老带新">老带新</option>
                        <option value="转让店">转让店</option>
                        <option value="自进店">自进店</option>
                        <option value="内部员工或家属">内部员工或家属</option>
                      </optgroup>
                    </Select>
                  ) : (
                    <Input value={customer.customerSource ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">生日</label>
                  {isEditing ? (
                    <Input
                      type="date"
                      value={form.birthday}
                      onChange={(e) => handleFormChange("birthday", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.birthday ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">职业</label>
                  {isEditing ? (
                    <Input
                      value={form.occupation}
                      onChange={(e) => handleFormChange("occupation", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.occupation ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">婚姻状况</label>
                  {isEditing ? (
                    <Select
                      value={form.isMarried}
                      onChange={(e) => handleFormChange("isMarried", e.target.value)}
                    >
                      <option value="">未填写</option>
                      <option value="true">已婚</option>
                      <option value="false">未婚</option>
                    </Select>
                  ) : (
                    <Input
                      value={
                        customer.isMarried === true
                          ? "已婚"
                          : customer.isMarried === false
                            ? "未婚"
                            : ""
                      }
                      disabled
                    />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">肤质</label>
                  {isEditing ? (
                    <Input
                      value={form.skinType}
                      onChange={(e) => handleFormChange("skinType", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.skinType ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">改善重点</label>
                  {isEditing ? (
                    <Input
                      value={form.improvementFocus}
                      onChange={(e) => handleFormChange("improvementFocus", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.improvementFocus ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">肌肤问题</label>
                  {isEditing ? (
                    <Input
                      value={form.skinIssue}
                      onChange={(e) => handleFormChange("skinIssue", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.skinIssue ?? ""} disabled />
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">养生偏好</label>
                  {isEditing ? (
                    <Input
                      value={form.wellnessPreference}
                      onChange={(e) => handleFormChange("wellnessPreference", e.target.value)}
                    />
                  ) : (
                    <Input value={customer.wellnessPreference ?? ""} disabled />
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">消费记录</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={orderColumns}
                data={orders}
                emptyText="暂无消费记录"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">疗程卡余次</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={itemColumns}
                data={activeSaleItems}
                emptyText="暂无疗程卡"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appointments">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">预约记录</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={appointmentColumns}
                data={appointments}
                emptyText="暂无预约记录"
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
