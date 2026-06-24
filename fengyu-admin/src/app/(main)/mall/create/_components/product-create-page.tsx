"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { MallCategory } from "@/lib/types";
import { createProduct } from "@/actions/products";
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ImageUpload } from "@/components/ui/image-upload";

interface Market {
  id: string;
  name: string;
}

export default function MallProductCreatePageClient({
  mallCategories,
  markets,
  manageScope,
}: {
  mallCategories: MallCategory[];
  markets: Market[];
  manageScope: { scopeId: string | null; scopeName: string };
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [detailImages, setDetailImages] = useState<string[]>([]);
  const [formDirty, setFormDirty] = useState(false);
  useUnsavedChanges(formDirty);

  const [isBundle, setIsBundle] = useState(false);
  const [allMarkets, setAllMarkets] = useState(true);
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>([]);

  // Mall category groups for grouped select
  const mallGroups = useMemo(
    () => mallCategories.filter((c) => c.categoryGroup === null).sort((a, b) => a.sortOrder - b.sortOrder),
    [mallCategories],
  );
  const mallSubCats = useMemo(
    () => mallCategories.filter((c) => c.categoryGroup !== null).sort((a, b) => a.sortOrder - b.sortOrder),
    [mallCategories],
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    const name = (fd.get("name") as string).trim();
    // 套餐(isBundle)时价格 Card 不渲染，fd.get("price") 为 null，须空值兜底
    const price = ((fd.get("price") as string | null) ?? "").trim();

    if (!name) {
      toast.error("请输入商城展示名称");
      return;
    }
    if (!categoryId) {
      toast.error("请选择商城分类");
      return;
    }
    if (!isBundle && !price) {
      toast.error("请输入标价");
      return;
    }

    const specialPrice = ((fd.get("specialPrice") as string | null) ?? "").trim() || null;
    const description = ((fd.get("description") as string | null) ?? "").trim() || null;
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0;
    const isVisible = fd.get("isVisible") === "on";

    const productId = `prod-${Date.now()}`;

    setSaving(true);
    try {
      const result = await createProduct({
        productId,
        categoryId,
        name,
        coverImage: coverImage || null,
        detailImages: detailImages.length > 0 ? detailImages : null,
        description,
        isBundle,
        price: isBundle ? '0' : price,
        specialPrice: isBundle ? null : specialPrice,
        manageScope: manageScope.scopeId,
        marketScope: allMarkets ? null : selectedMarketIds.length > 0 ? selectedMarketIds.join(",") : null,
        sortOrder,
        isVisible,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      setFormDirty(false);
      toast.success("商品创建成功，请在详情页管理套餐分组");
      router.push(`/mall/${productId}`);
    } catch {
      toast.error("创建失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} onInput={() => setFormDirty(true)} className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">新增商城商品</h1>
      </div>

      {/* 基本信息 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">商城展示名称</label>
              <Input name="name" placeholder="请输入商城展示名称" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">商城分类</label>
              <Select
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setFormDirty(true);
                }}
              >
                <option value="">请选择商城分类</option>
                {mallGroups.map((group) => (
                  <optgroup key={group.categoryId} label={group.categoryName}>
                    {mallSubCats
                      .filter((c) => c.categoryGroup === group.categoryName)
                      .map((c) => (
                        <option key={c.categoryId} value={c.categoryId}>
                          {c.categoryName}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">是否套餐</label>
              <Select
                value={isBundle ? "true" : "false"}
                onChange={(e) => {
                  setIsBundle(e.target.value === "true");
                  setFormDirty(true);
                }}
              >
                <option value="false">否</option>
                <option value="true">是</option>
              </Select>
            </div>
            {isBundle && (
              <div className="col-span-2">
                <p className="text-sm text-[var(--muted-foreground)] bg-[var(--accent)] px-3 py-2 rounded-[var(--radius)]">
                  创建商品后，可在详情页管理套餐分组和规格
                </p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">管理范围</label>
              <Input value={manageScope.scopeName} disabled />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 价格（套餐价由详情页分组单价自动计算，此处仅非套餐填写） */}
      {!isBundle && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">价格</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">标价</label>
                <Input name="price" type="number" placeholder="0.00" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">会员价</label>
                <Input name="specialPrice" type="number" placeholder="不填则无会员价" />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] min-h-[80px]"
                placeholder="请输入商品描述"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <label className="text-sm font-medium">封面图</label>
              <ImageUpload value={coverImage} onChange={(v) => setCoverImage(v as string)} path="product-covers" />
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
              <Input name="sortOrder" type="number" defaultValue={0} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 可见范围 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">可见范围</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allMarkets}
                onChange={(e) => {
                  setAllMarkets(e.target.checked);
                  if (e.target.checked) setSelectedMarketIds([]);
                  setFormDirty(true);
                }}
                className="h-4 w-4 rounded border-[var(--input)]"
              />
              <span className="text-sm font-medium">全部市场</span>
            </label>
            {!allMarkets && (
              <div className="grid grid-cols-3 gap-2 pl-6">
                {markets.map((m) => (
                  <label key={m.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedMarketIds.includes(m.id)}
                      onChange={(e) => {
                        setSelectedMarketIds((prev) =>
                          e.target.checked ? [...prev, m.id] : prev.filter((id) => id !== m.id),
                        );
                        setFormDirty(true);
                      }}
                      className="h-4 w-4 rounded border-[var(--input)]"
                    />
                    <span className="text-sm">{m.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 客户端展示 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">客户端展示</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="isVisible"
              defaultChecked
              className="h-4 w-4 rounded border-[var(--input)]"
            />
            <span className="text-sm">在客户端商城中展示</span>
          </label>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
        <Button type="submit" loading={saving}>
          创建商品
        </Button>
      </div>
    </form>
  );
}
