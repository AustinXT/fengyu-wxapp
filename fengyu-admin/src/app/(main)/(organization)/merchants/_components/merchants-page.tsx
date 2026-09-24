"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { AdminMerchant, MerchantMarketOption } from "@/actions/merchants"
import type { OnboardingListItem } from "@/actions/lakala-onboarding"
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectOption } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Pagination } from "@/components/ui/pagination"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDateTime } from "@/lib/utils"
import MarketStoreFilter from "@/components/market-store-filter"
import { OnboardingList } from "../onboarding/_components/onboarding-page"
import { PreserveListContextLink } from "@/components/return-context"
import { normalizePage } from "@/lib/paging"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

export default function MerchantsPage({
  merchants,
  total,
  markets,
  canCreate,
  canOnboard = false,
  onboardingApplications = [],
  filterOptions,
}: {
  merchants: AdminMerchant[]
  total: number
  markets: MerchantMarketOption[]
  canCreate: boolean
  canOnboard?: boolean
  onboardingApplications?: OnboardingListItem[]
  filterOptions: MarketStoreFilterOptions
}) {
  const router = useRouter()
  const { get, setMany } = useUrlFilters()
  const [searchInput, setSearchInput] = useState(get("q"))
  const activeTab = get("tab") === "onboarding" ? "onboarding" : "merchants"
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const enabledFilter = get("enabled")
  const marketFilter = get("market")
  const storeFilter = get("store")
  const currentPage = normalizePage(get("page", "1"))
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20

  // 搜索防抖 300ms
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setMany({ q: value, page: "" }), 300)
    },
    [setMany],
  )

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])

  const columns: Column<AdminMerchant>[] = [
    {
      key: "merchantName",
      header: "商户名称",
      cell: (row) => (
        <PreserveListContextLink
          href={`/merchants/${row.id}`}
          className="font-medium text-[var(--primary)] hover:underline"
        >
          {row.merchantName}
        </PreserveListContextLink>
      ),
    },
    {
      key: "merchantNo",
      header: "商户号",
      cell: (row) => <span className="font-mono text-xs">{row.merchantNo ?? "—"}</span>,
    },
    {
      key: "termNo",
      header: "终端号",
      cell: (row) => <span className="font-mono text-xs">{row.termNo ?? "—"}</span>,
    },
    {
      key: "enabled",
      header: "收款状态",
      cell: (row) =>
        row.enabled ? (
          <Badge variant="outline" className="border-[#3D8A5A] text-[#3D8A5A]">
            已启用
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[#888888]">
            未启用
          </Badge>
        ),
    },
    {
      key: "marketName",
      header: "所属市场",
      cell: (row) => row.marketName ?? "—",
    },
    {
      key: "storeNames",
      header: "门店",
      cell: (row) => row.storeNames ?? "—",
    },
    {
      key: "storeCount",
      header: "关联门店",
      cell: (row) => `${row.storeCount} 个`,
    },
    {
      key: "updatedAt",
      header: "更新时间",
      cell: (row) => <span className="text-xs text-[#999999]">{formatDateTime(row.updatedAt)}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">商户管理</h1>
          <p className="mt-1 text-xs text-[#999999]">
            拉卡拉收款商户档案；门店在「门店编辑」页选择关联本表的商户。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {activeTab === "merchants" && canCreate && (
            <Button onClick={() => router.push("/merchants/create")}>新建商户</Button>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setMany({ tab: value === "onboarding" ? value : "", page: "" })}>
        <TabsList>
          <TabsTrigger value="merchants">收款商户</TabsTrigger>
          {canOnboard && <TabsTrigger value="onboarding">入网申请</TabsTrigger>}
        </TabsList>

        <TabsContent value="merchants" className="space-y-4">
          <div className="flex items-center gap-3">
            <Input
              placeholder="商户名称 / 商户号"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-56"
            />
            <MarketStoreFilter
              options={filterOptions}
              marketValue={marketFilter}
              storeValue={storeFilter}
              onMarketChange={(value) => {
                setMany({ market: value, store: '', page: '' })
              }}
              onStoreChange={(value) => setMany({ store: value, page: '' })}
              marketClassName="w-40"
              storeClassName="w-48"
            />
            <Select
              value={enabledFilter}
              onChange={(e) => setMany({ enabled: e.target.value, page: "" })}
              className="w-40"
            >
              <SelectOption value="">全部状态</SelectOption>
              <SelectOption value="enabled">已启用</SelectOption>
              <SelectOption value="disabled">未启用</SelectOption>
            </Select>
          </div>

          <DataTable columns={columns} data={merchants} emptyText="暂无商户" />

          <Pagination
            total={total}
            page={currentPage}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageChange={(p) => setMany({ page: String(p) })}
            onPageSizeChange={(s) => setMany({ size: String(s), page: "1" })}
          />
        </TabsContent>

        {canOnboard && (
          <TabsContent value="onboarding">
            <OnboardingList applications={onboardingApplications} canCreate={canCreate} embedded />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
