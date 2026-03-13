"use client"

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import type { Customer, SaleOrder, Appointment, SaleItem } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils"

interface CustomerDetailPageProps {
  customer: Customer
  orders: SaleOrder[]
  appointments: Appointment[]
}

export default function CustomerDetailPage({ customer, orders, appointments }: CustomerDetailPageProps) {
  const router = useRouter()

  const activeSaleItems = useMemo(() => {
    const allItems: SaleItem[] = []
    for (const order of orders) {
      if (order.items) {
        allItems.push(...order.items)
      }
    }
    return allItems.filter(
      (item) =>
        item.itemDirection === "purchase" &&
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
              <Button variant="outline" size="sm">
                编辑
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-8 gap-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">姓名</label>
                  <Input defaultValue={customer.name ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">手机号</label>
                  <Input defaultValue={customer.phone ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">微信昵称</label>
                  <Input defaultValue={customer.wechatName ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">归属门店</label>
                  <Input value={customer.storeName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">所属美容师</label>
                  <Input value={customer.employeeName ?? ""} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">会员等级</label>
                  <Input defaultValue={customer.memberLevel ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">顾客分类</label>
                  <Input defaultValue={customer.category ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">顾客来源</label>
                  <Input defaultValue={customer.customerSource ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">生日</label>
                  <Input type="date" defaultValue={customer.birthday ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">职业</label>
                  <Input defaultValue={customer.occupation ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">肤质</label>
                  <Input defaultValue={customer.skinType ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">改善重点</label>
                  <Input defaultValue={customer.improvementFocus ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">肌肤问题</label>
                  <Input defaultValue={customer.skinIssue ?? ""} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">养生偏好</label>
                  <Input defaultValue={customer.wellnessPreference ?? ""} />
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
