"use client"

import { useMemo } from "react"
import { MOCK_PRODUCT_CATEGORIES } from "@/lib/mock-data"
import type { ProductKind, ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DataTable, type Column } from "@/components/ui/data-table"

const PRODUCT_KINDS: ProductKind[] = ["福利活动", "护理项目", "家居产品", "充值卡"]

export default function ProductCategoriesPage() {
  const categoriesByKind = useMemo(() => {
    const map: Record<string, ProductCategory[]> = {}
    for (const kind of PRODUCT_KINDS) {
      map[kind] = MOCK_PRODUCT_CATEGORIES
        .filter((c) => c.productKind === kind)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    }
    return map
  }, [])

  const columns: Column<ProductCategory>[] = [
    {
      key: "categoryName",
      header: "分类名称",
      cell: (row) => <span className="font-medium">{row.categoryName}</span>,
    },
    {
      key: "sortOrder",
      header: "排序",
    },
    {
      key: "isValid",
      header: "状态",
      cell: (row) => (
        <Badge
          variant="outline"
          className={
            row.isValid
              ? "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]"
              : "border-[#888888] text-[#888888] bg-[#F5F5F5]"
          }
        >
          {row.isValid ? "启用" : "停用"}
        </Badge>
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
            停用
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">品项分类</h1>
        <Button>新增分类</Button>
      </div>

      <Tabs defaultValue="福利活动">
        <TabsList>
          {PRODUCT_KINDS.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {kind}（{categoriesByKind[kind]?.length ?? 0}）
            </TabsTrigger>
          ))}
        </TabsList>

        {PRODUCT_KINDS.map((kind) => (
          <TabsContent key={kind} value={kind}>
            <DataTable
              columns={columns}
              data={(categoriesByKind[kind] ?? [])}
              emptyText="暂无分类"
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
