"use client"

import { useState, useMemo } from "react"
import type { CommissionRate } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils"

const MARKET_TABS = [
  { orgId: "org-market-nc", label: "南昌市场" },
  { orgId: "org-market-jj", label: "九江市场" },
]

interface CommissionPageProps {
  rates: CommissionRate[]
}

export default function CommissionPage({ rates }: CommissionPageProps) {
  const [orderTypeFilter, setOrderTypeFilter] = useState("")
  const [roleTypeFilter, setRoleTypeFilter] = useState("")
  const [salesCategoryFilter, setSalesCategoryFilter] = useState("")

  const orderTypes = useMemo(
    () => [...new Set(rates.map((r) => r.orderType))],
    [rates]
  )
  const roleTypes = useMemo(
    () => [...new Set(rates.map((r) => r.roleType))],
    [rates]
  )
  const salesCategories = useMemo(
    () => [...new Set(rates.map((r) => r.salesCategory))],
    [rates]
  )

  const filterRates = (orgId: string) => {
    let result = rates.filter((r) => r.orgId === orgId)
    if (orderTypeFilter) result = result.filter((r) => r.orderType === orderTypeFilter)
    if (roleTypeFilter) result = result.filter((r) => r.roleType === roleTypeFilter)
    if (salesCategoryFilter)
      result = result.filter((r) => r.salesCategory === salesCategoryFilter)
    return result
  }

  const columns: Column<CommissionRate>[] = [
    { key: "orderType", header: "订单类型" },
    { key: "roleType", header: "角色类型" },
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
      cell: () => (
        <div className="flex gap-2">
          <Button variant="link" size="sm" className="h-auto p-0">
            编辑
          </Button>
          <Button variant="link" size="sm" className="h-auto p-0 text-[var(--destructive)]">
            删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">提成矩阵</h1>
        <Button>新增规则</Button>
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={orderTypeFilter}
          onChange={(e) => setOrderTypeFilter(e.target.value)}
          className="w-32"
        >
          <option value="">全部订单类型</option>
          {orderTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          value={roleTypeFilter}
          onChange={(e) => setRoleTypeFilter(e.target.value)}
          className="w-32"
        >
          <option value="">全部角色</option>
          {roleTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          value={salesCategoryFilter}
          onChange={(e) => setSalesCategoryFilter(e.target.value)}
          className="w-32"
        >
          <option value="">全部销售分类</option>
          {salesCategories.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>

      <Tabs defaultValue={MARKET_TABS[0].orgId}>
        <TabsList>
          {MARKET_TABS.map((tab) => (
            <TabsTrigger key={tab.orgId} value={tab.orgId}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {MARKET_TABS.map((tab) => (
          <TabsContent key={tab.orgId} value={tab.orgId}>
            <DataTable
              columns={columns}
              data={filterRates(tab.orgId)}
              emptyText="暂无提成规则"
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
