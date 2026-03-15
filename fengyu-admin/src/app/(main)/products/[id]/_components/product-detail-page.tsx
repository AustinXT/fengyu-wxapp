"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes"
import type { Product, ProductSku, ProductCategory } from "@/lib/types"
import { updateProduct, createSku, updateSku, deleteSku } from "@/actions/products"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ImageUpload } from "@/components/ui/image-upload"
import { DataTable, type Column } from "@/components/ui/data-table"
import { Sheet, SheetHeader, SheetTitle, SheetClose, SheetContent, SheetFooter } from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
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
  const [saving, setSaving] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  useUnsavedChanges(formDirty)
  const [coverImage, setCoverImage] = useState(product.coverImage ?? "")
  const [detailImages, setDetailImages] = useState<string[]>(product.detailImages ?? [])

  // SKU Sheet state
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingSku, setEditingSku] = useState<ProductSku | null>(null)
  const [skuSaving, setSkuSaving] = useState(false)

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingSkuId, setDeletingSkuId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // --- Product Save ---
  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)

    const name = (fd.get("name") as string).trim()
    const categoryId = fd.get("categoryId") as string
    const price = (fd.get("price") as string).trim()

    if (!name) {
      toast.error("请输入商品名称")
      return
    }
    if (!categoryId) {
      toast.error("请选择品项分类")
      return
    }
    if (!price) {
      toast.error("请输入标价")
      return
    }

    const specialPrice = (fd.get("specialPrice") as string).trim() || null
    const salesCategory = (fd.get("salesCategory") as string) || null
    const description = (fd.get("description") as string).trim() || null
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0
    const validStart = (fd.get("validStart") as string) || null
    const validEnd = (fd.get("validEnd") as string) || null

    setSaving(true)
    try {
      const result = await updateProduct(product.productId, {
        categoryId,
        name,
        coverImage: coverImage || null,
        detailImages: detailImages.length > 0 ? detailImages : null,
        description,
        price,
        specialPrice,
        salesCategory,
        sortOrder,
        validStart,
        validEnd,
      }, product.updatedAt)
      if (!result.success) {
        toast.error(result.message)
        if (result.message.includes("已被其他人修改")) router.refresh()
        return
      }
      setFormDirty(false)
      toast.success("保存成功")
      router.refresh()
    } catch {
      toast.error("保存失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  // --- SKU Sheet ---
  const openCreateSku = () => {
    setEditingSku(null)
    setSheetOpen(true)
  }

  const openEditSku = (sku: ProductSku) => {
    setEditingSku(sku)
    setSheetOpen(true)
  }

  const handleSkuSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)

    const specName = (fd.get("specName") as string).trim()
    const productType = fd.get("productType") as string
    const price = (fd.get("price") as string).trim()
    const sessionCount = parseInt(fd.get("sessionCount") as string)

    if (!specName) {
      toast.error("请输入规格名称")
      return
    }
    if (!productType) {
      toast.error("请选择产品类型")
      return
    }
    if (!price) {
      toast.error("请输入标价")
      return
    }
    if (isNaN(sessionCount) || sessionCount < 1) {
      toast.error("次数至少为 1")
      return
    }

    const specialPrice = (fd.get("specialPrice") as string).trim() || null
    const serviceFee = (fd.get("serviceFee") as string).trim() || "0"
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0
    const isBundleSku = fd.get("isBundleSku") === "on"

    setSkuSaving(true)
    try {
      if (editingSku) {
        const skuResult = await updateSku(editingSku.skuId, {
          specName,
          productType,
          price,
          specialPrice,
          sessionCount,
          serviceFee,
          sortOrder,
          isBundleSku,
        }, editingSku.updatedAt)
        if (!skuResult.success) {
          toast.error(skuResult.message)
          if (skuResult.message.includes("已被其他人修改")) router.refresh()
          return
        }
        toast.success("规格更新成功")
      } else {
        const skuId = `sku-${Date.now()}`
        const createResult = await createSku({
          skuId,
          productId: product.productId,
          specName,
          productType,
          price,
          specialPrice,
          sessionCount,
          serviceFee,
          sortOrder,
          isBundleSku,
        })
        if (!createResult.success) {
          toast.error(createResult.message)
          return
        }
        toast.success("规格创建成功")
      }
      setSheetOpen(false)
      router.refresh()
    } catch {
      toast.error(editingSku ? "更新失败，请稍后重试" : "创建失败，请稍后重试")
    } finally {
      setSkuSaving(false)
    }
  }

  // --- SKU Delete ---
  const openDeleteDialog = (skuId: string) => {
    setDeletingSkuId(skuId)
    setDeleteDialogOpen(true)
  }

  const handleDeleteSku = async () => {
    if (!deletingSkuId) return
    setDeleting(true)
    try {
      const delResult = await deleteSku(deletingSkuId)
      if (!delResult.success) {
        toast.error(delResult.message)
        return
      }
      toast.success("规格已删除")
      setDeleteDialogOpen(false)
      setDeletingSkuId(null)
      router.refresh()
    } catch {
      toast.error("删除失败，请稍后重试")
    } finally {
      setDeleting(false)
    }
  }

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
      cell: (row) => (
        <div className="flex gap-2">
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openEditSku(row)}>
            编辑
          </Button>
          <Button variant="link" size="sm" className="h-auto p-0 text-[var(--destructive)]" onClick={() => openDeleteDialog(row.skuId)}>
            删除
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <form onSubmit={handleSave} onInput={() => setFormDirty(true)} className="space-y-4">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
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
                <Input name="name" defaultValue={product.name} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">品项分类</label>
                <Select name="categoryId" defaultValue={product.categoryId}>
                  {categories.map((c) => (
                    <option key={c.categoryId} value={c.categoryId}>
                      {c.categoryName}（{c.productKind}）
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">销售分类</label>
                <Select name="salesCategory" defaultValue={product.salesCategory ?? ""}>
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
                <Input name="price" type="number" defaultValue={product.price} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">特价</label>
                <Input
                  name="specialPrice"
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
                  name="description"
                  className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 min-h-[80px]"
                  defaultValue={product.description ?? ""}
                />
              </div>
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">封面图</label>
                <ImageUpload
                  value={coverImage}
                  onChange={(v) => setCoverImage(v as string)}
                  path="product-covers"
                />
              </div>
              <div className="col-span-2 space-y-2">
                <label className="text-sm font-medium">详情图</label>
                <ImageUpload
                  value={detailImages}
                  onChange={(v) => setDetailImages(v as string[])}
                  path="product-details"
                  multiple
                  max={9}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">排序</label>
                <Input name="sortOrder" type="number" defaultValue={product.sortOrder} />
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
                <Input name="validStart" type="date" defaultValue={product.validStart ?? ""} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">截止日期</label>
                <Input
                  name="validEnd"
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
          <Button type="button" variant="outline" onClick={() => router.back()}>
            取消
          </Button>
          <Button type="submit" loading={saving}>保存</Button>
        </div>
      </form>

      {/* SKU 列表 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">SKU 列表</CardTitle>
          <Button size="sm" onClick={openCreateSku}>新增规格</Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={skuColumns}
            data={skus}
            emptyText="暂无规格"
          />
        </CardContent>
      </Card>

      {/* SKU Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetHeader>
          <SheetTitle>{editingSku ? "编辑规格" : "新增规格"}</SheetTitle>
          <SheetClose onClick={() => setSheetOpen(false)} />
        </SheetHeader>
        <form onSubmit={handleSkuSubmit} className="flex flex-1 flex-col overflow-hidden">
          <SheetContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">规格名称 *</label>
                <Input
                  name="specName"
                  defaultValue={editingSku?.specName ?? ""}
                  placeholder="请输入规格名称"
                  key={editingSku?.skuId ?? "new"}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">产品类型 *</label>
                <Select
                  name="productType"
                  defaultValue={editingSku?.productType ?? ""}
                  key={`type-${editingSku?.skuId ?? "new"}`}
                >
                  <option value="" disabled>请选择</option>
                  <option value="疗程卡">疗程卡</option>
                  <option value="单品">单品</option>
                  <option value="院装产品">院装产品</option>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">标价 *</label>
                <Input
                  name="price"
                  type="number"
                  step="0.01"
                  defaultValue={editingSku?.price ?? ""}
                  placeholder="0.00"
                  key={`price-${editingSku?.skuId ?? "new"}`}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">特价</label>
                <Input
                  name="specialPrice"
                  type="number"
                  step="0.01"
                  defaultValue={editingSku?.specialPrice ?? ""}
                  placeholder="不填则无特价"
                  key={`sp-${editingSku?.skuId ?? "new"}`}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">次数 *</label>
                <Input
                  name="sessionCount"
                  type="number"
                  min={1}
                  defaultValue={editingSku?.sessionCount ?? 1}
                  key={`sc-${editingSku?.skuId ?? "new"}`}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">手工费</label>
                <Input
                  name="serviceFee"
                  type="number"
                  step="0.01"
                  defaultValue={editingSku?.serviceFee ?? "0"}
                  placeholder="0.00"
                  key={`sf-${editingSku?.skuId ?? "new"}`}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">排序</label>
                <Input
                  name="sortOrder"
                  type="number"
                  defaultValue={editingSku?.sortOrder ?? 0}
                  key={`so-${editingSku?.skuId ?? "new"}`}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="isBundleSku"
                  id="isBundleSku"
                  defaultChecked={editingSku?.isBundleSku ?? false}
                  className="h-4 w-4 rounded border-[var(--input)]"
                  key={`bs-${editingSku?.skuId ?? "new"}`}
                />
                <label htmlFor="isBundleSku" className="text-sm font-medium">套餐规格</label>
              </div>
            </div>
          </SheetContent>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => setSheetOpen(false)}>
              取消
            </Button>
            <Button type="submit" loading={skuSaving}>
              {editingSku ? "保存" : "创建"}
            </Button>
          </SheetFooter>
        </form>
      </Sheet>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogTitle>确认删除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要删除该规格吗？此操作不可撤销。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              setDeleteDialogOpen(false)
              setDeletingSkuId(null)
            }}
            disabled={deleting}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteSku} disabled={deleting}>
            {deleting ? "删除中..." : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}
