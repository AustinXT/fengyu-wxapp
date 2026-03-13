"use client"

import { useRouter } from "next/navigation"
import type { ProductCategory } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export default function ProductCreatePageClient({
  categories,
}: {
  categories: ProductCategory[]
}) {
  const router = useRouter()

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新增商品</h1>
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
              <Input placeholder="请输入商品名称" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">品项分类</label>
              <Select defaultValue="">
                <option value="" disabled>
                  请选择分类
                </option>
                {categories.map((c) => (
                  <option key={c.categoryId} value={c.categoryId}>
                    {c.categoryName}（{c.productKind}）
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">销售分类</label>
              <Select defaultValue="">
                <option value="" disabled>
                  请选择
                </option>
                <option value="自采自销">自采自销</option>
                <option value="他销自耗">他销自耗</option>
                <option value="他销他耗">他销他耗</option>
                <option value="生态合作">生态合作</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">是否套餐</label>
              <Select defaultValue="false">
                <option value="false">否</option>
                <option value="true">是</option>
              </Select>
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
              <Input type="number" placeholder="0.00" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">特价</label>
              <Input type="number" placeholder="不填则无特价" />
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
                placeholder="请输入商品描述"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <Input placeholder="图片 URL" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">详情图</label>
              <Input placeholder="多张图片 URL，逗号分隔" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">排序</label>
              <Input type="number" defaultValue={0} />
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
              <Input type="date" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">截止日期</label>
              <Input type="date" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button>创建商品</Button>
      </div>
    </div>
  )
}
