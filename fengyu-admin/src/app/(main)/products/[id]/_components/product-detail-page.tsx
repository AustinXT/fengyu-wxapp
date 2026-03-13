"use client"

import { useRouter } from "next/navigation"
import type { Product, ProductSku, ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { DataTable, type Column } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils"

export default function ProductDetailPageClient({
  product,
  skus,
  categories,
}: {
  product: Product
  skus: ProductSku[]
  categories: ProductCategory[]
}) {
  const router = useRouter()

  const skuColumns: Column<ProductSku>[] = [
    {
      key: "specName",
      header: "规格名",
      cell: (row) => <span className="font-medium">{row.specName}</span>,
    },
    { key: "productType", header: "产品类型" },
    {
      key: "price",
      header: "标价",
      cell: (row) => <span>{formatCurrency(row.price)}</span>,
    },
    {
      key: "specialPrice",
      header: "会员价",
      cell: (row) => (
        <span className={row.specialPrice ? "text-[#C0322A]" : ""}>
          {row.specialPrice ? formatCurrency(row.specialPrice) : "—"}
        </span>
      ),
    },
    {
      key: "sessionCount",
      header: "次数",
      cell: (row) => <span>{row.sessionCount ?? "—"}</span>,
    },
    {
      key: "serviceFee",
      header: "手工费",
      cell: (row) => <span>{formatCurrency(row.serviceFee)}</span>,
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
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          商品详情 - {product.name}
        </h1>
      </div>

      {/* 基本信息 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">商品名称</label>
              <Input defaultValue={product.name} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">品项分类</label>
              <Select defaultValue={product.categoryId}>
                {categories.map((c) => (
                  <option key={c.categoryId} value={c.categoryId}>
                    {c.categoryName}（{c.productKind}）
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">销售分类</label>
              <Select defaultValue={product.salesCategory ?? ""}>
                <option value="">请选择</option>
                <option value="自采自销">自采自销</option>
                <option value="他销自耗">他销自耗</option>
                <option value="他销他耗">他销他耗</option>
                <option value="生态合作">生态合作</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">是否套餐</label>
              <Input value={product.isBundle ? "是" : "否"} disabled />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 价格 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">价格</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">标价</label>
              <Input type="number" defaultValue={product.price} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">特价</label>
              <Input
                type="number"
                defaultValue={product.specialPrice ?? ""}
                placeholder="不填则无特价"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 展示 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">展示</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">商品描述</label>
              <textarea
                className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 min-h-[80px]"
                defaultValue={product.description ?? ""}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <Input defaultValue={product.coverImage ?? ""} placeholder="图片 URL" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">详情图</label>
              <Input
                defaultValue={product.detailImages?.join(", ") ?? ""}
                placeholder="多张图片 URL，逗号分隔"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">排序</label>
              <Input type="number" defaultValue={product.sortOrder} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 有效期 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">有效期</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">生效日期</label>
              <Input type="date" defaultValue={product.validStart ?? ""} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">截止日期</label>
              <Input
                type="date"
                defaultValue={product.validEnd ?? ""}
                placeholder="不填则长期有效"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button>保存</Button>
      </div>

      {/* SKU 列表 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">SKU 列表</CardTitle>
          <Button size="sm">新增规格</Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={skuColumns}
            data={skus}
            emptyText="暂无规格"
          />
        </CardContent>
      </Card>
    </div>
  )
}
