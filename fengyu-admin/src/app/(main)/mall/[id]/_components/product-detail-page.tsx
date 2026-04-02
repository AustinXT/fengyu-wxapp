"use client";

import { useState, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes";
import type { Product, ProductSku, ProductCategory } from "@/lib/types";
import { updateProduct, addSkuToProduct, removeSkuFromProduct, updateSkuBundlePrice } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryCascader } from "@/components/ui/category-cascader";
import { Separator } from "@/components/ui/separator";
import { ImageUpload } from "@/components/ui/image-upload";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Dialog, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { formatCurrency } from "@/lib/utils";

interface Market {
  id: string;
  name: string;
}

export default function MallProductDetailPageClient({
  product,
  skus,
  allSkus,
  categories,
  markets,
  manageScope,
}: {
  product: Product;
  skus: ProductSku[];
  allSkus: ProductSku[];
  categories: ProductCategory[];
  markets: Market[];
  manageScope: { scopeId: string | null; scopeName: string };
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  useUnsavedChanges(formDirty);
  const [categoryId, setCategoryId] = useState(product.categoryId);
  const [coverImage, setCoverImage] = useState(product.coverImage ?? "");
  const [detailImages, setDetailImages] = useState<string[]>(product.detailImages ?? []);

  const [isBundle, setIsBundle] = useState(product.isBundle);
  const [isShengmei, setIsShengmei] = useState<boolean>((product as any).isShengmei ?? false);
  const [allMarkets, setAllMarkets] = useState(!product.marketScope);
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>(
    product.marketScope ? product.marketScope.split(",") : [],
  );

  const selectedCategory = categories.find((c) => c.categoryId === categoryId);
  const selectedProductKind = selectedCategory?.productKind;

  const manageScopeDisplay = useMemo(() => {
    if (!product.manageScope) return "总部";
    const m = markets.find((mk) => mk.id === product.manageScope);
    return m?.name ?? product.manageScope;
  }, [product.manageScope, markets]);

  // SKU Picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerCategoryId, setPickerCategoryId] = useState("");
  const [pickerKindValue, setPickerKindValue] = useState("");
  const [addingSku, setAddingSku] = useState<string | null>(null);

  // Remove dialog state
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removingSkuId, setRemovingSkuId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // SKU Picker computed
  const linkedSkuIds = useMemo(() => new Set(skus.map((s) => s.skuId)), [skus]);

  const subCategories = useMemo(() => categories.filter((c) => c.productKind !== null), [categories]);
  const productKinds = useMemo(() => categories.filter((c) => c.productKind === null), [categories]);

  const availableSkus = useMemo(() => {
    let list = allSkus.filter((s) => !linkedSkuIds.has(s.skuId));

    if (pickerCategoryId) {
      list = list.filter((s) => s.categoryId === pickerCategoryId);
    } else if (pickerKindValue) {
      list = list.filter((s) => s.productKind === pickerKindValue);
    }

    if (pickerSearch.trim()) {
      const kw = pickerSearch.trim().toLowerCase();
      list = list.filter(
        (s) => s.specName.toLowerCase().includes(kw) || (s.categoryName ?? "").toLowerCase().includes(kw),
      );
    }

    return list;
  }, [allSkus, linkedSkuIds, pickerSearch, pickerCategoryId, pickerKindValue]);

  const handleCategoryChange = (id: string) => {
    setCategoryId(id);
    const cat = categories.find((c) => c.categoryId === id);
    if (cat) {
      setIsBundle(cat.productKind === "福利活动");
      if (cat.productKind !== "护理项目") {
        setIsShengmei(false);
      }
    }
    setFormDirty(true);
  };

  // --- Product Save ---
  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    const name = (fd.get("name") as string).trim();
    const price = (fd.get("price") as string).trim();

    if (!name) {
      toast.error("请输入商品名称");
      return;
    }
    if (!categoryId) {
      toast.error("请选择品项分类");
      return;
    }
    if (!price) {
      toast.error("请输入标价");
      return;
    }

    const specialPrice = (fd.get("specialPrice") as string).trim() || null;
    const salesCategory = (fd.get("salesCategory") as string) || null;
    const description = (fd.get("description") as string).trim() || null;
    const sortOrder = parseInt(fd.get("sortOrder") as string) || 0;
    const validStart = (fd.get("validStart") as string) || null;
    const validEnd = (fd.get("validEnd") as string) || null;

    setSaving(true);
    try {
      const result = await updateProduct(
        product.productId,
        {
          categoryId,
          name,
          coverImage: coverImage || null,
          detailImages: detailImages.length > 0 ? detailImages : null,
          description,
          isBundle,
          price,
          specialPrice,
          manageScope: manageScope.scopeId,
          marketScope: allMarkets ? null : selectedMarketIds.length > 0 ? selectedMarketIds.join(",") : null,
          sortOrder,
          validStart,
          validEnd,
        } as any,
        product.updatedAt,
      );
      if (!result.success) {
        toast.error(result.message);
        if (result.message.includes("已被其他人修改")) router.refresh();
        return;
      }
      setFormDirty(false);
      toast.success("保存成功");
      router.refresh();
    } catch {
      toast.error("保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  // --- SKU Picker ---
  const openPicker = () => {
    setPickerSearch("");
    setPickerCategoryId("");
    setPickerKindValue("");
    setPickerOpen(true);
  };

  const handleAddSku = async (skuId: string) => {
    setAddingSku(skuId);
    try {
      const result = await addSkuToProduct(product.productId, skuId);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success("规格已添加");
      router.refresh();
    } catch {
      toast.error("添加失败，请稍后重试");
    } finally {
      setAddingSku(null);
    }
  };

  // --- bundlePrice inline edit ---
  const handleBundlePriceSave = async (skuId: string, value: string) => {
    const bundlePrice = value.trim() === "" ? null : value.trim();
    try {
      const result = await updateSkuBundlePrice(product.productId, skuId, bundlePrice);
      if (!result.success) {
        toast.error(result.message);
        router.refresh();
        return;
      }
      toast.success("套餐价已更新");
    } catch {
      toast.error("更新失败，请稍后重试");
    }
  };

  // --- SKU Remove ---
  const openRemoveDialog = (skuId: string) => {
    setRemovingSkuId(skuId);
    setRemoveDialogOpen(true);
  };

  const handleRemoveSku = async () => {
    if (!removingSkuId) return;
    setRemoving(true);
    try {
      const result = await removeSkuFromProduct(product.productId, removingSkuId);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success("规格已移除");
      setRemoveDialogOpen(false);
      setRemovingSkuId(null);
      router.refresh();
    } catch {
      toast.error("移除失败，请稍后重试");
    } finally {
      setRemoving(false);
    }
  };

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
      key: "bundlePrice" as keyof ProductSku,
      header: "套餐内价格",
      cell: (row) => (
        <BundlePriceCell skuId={row.skuId} defaultValue={row.bundlePrice ?? ""} onSave={handleBundlePriceSave} />
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
      key: "validEnd" as keyof ProductSku,
      header: "有效期",
      cell: (row) => (
        <span className="text-sm text-[var(--muted-foreground)]">
          {row.validStart || row.validEnd ? `${row.validStart ?? "—"} ~ ${row.validEnd ?? "—"}` : "同商品"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-[var(--destructive)]"
          onClick={() => openRemoveDialog(row.skuId)}
        >
          移除
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">商品详情 - {product.name}</h1>
      </div>

      {/* 商品规格列表 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">商品规格列表</CardTitle>
          <Button size="sm" onClick={openPicker}>
            添加规格
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable columns={skuColumns} data={skus} emptyText="暂无规格" />
        </CardContent>
      </Card>

      <form onSubmit={handleSave} onInput={() => setFormDirty(true)} className="space-y-4">
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
                <CategoryCascader
                  name="categoryId"
                  categories={categories}
                  value={categoryId}
                  onChange={handleCategoryChange}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">销售分类</label>
                <Select name="salesCategory" defaultValue={(product as any).salesCategory ?? ""}>
                  <option value="">请选择</option>
                  <option value="自采自销">自采自销</option>
                  <option value="他销自耗">他销自耗</option>
                  <option value="他销他耗">他销他耗</option>
                  <option value="生态合作">生态合作</option>
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
              {selectedProductKind === "护理项目" && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">是否生美</label>
                  <Select
                    value={isShengmei ? "true" : "false"}
                    onChange={(e) => {
                      setIsShengmei(e.target.value === "true");
                      setFormDirty(true);
                    }}
                  >
                    <option value="false">否（科美）</option>
                    <option value="true">是（生美）</option>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">管理范围</label>
                <Input value={manageScopeDisplay} disabled />
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
                <label className="text-sm font-medium">会员价</label>
                <Input
                  name="specialPrice"
                  type="number"
                  defaultValue={product.specialPrice ?? ""}
                  placeholder="不填则无会员价"
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
                  className="flex w-full rounded-[var(--radius)] border border-[var(--input)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)] min-h-[80px]"
                  defaultValue={product.description ?? ""}
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
                <Input name="sortOrder" type="number" defaultValue={product.sortOrder} />
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
                <Input name="validEnd" type="date" defaultValue={product.validEnd ?? ""} placeholder="不填则长期有效" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Separator />

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            取消
          </Button>
          <Button type="submit" loading={saving}>
            保存
          </Button>
        </div>
      </form>

      {/* SKU Picker Dialog */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen} className="max-w-2xl">
        <DialogHeader className="relative">
          <DialogTitle>添加规格</DialogTitle>
          <DialogClose onOpenChange={setPickerOpen} />
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <CategoryCascader
              categories={subCategories}
              productKinds={productKinds}
              value={pickerCategoryId}
              kindValue={pickerKindValue}
              allowEmpty
              placeholder="品项筛选"
              className="w-56"
              onChange={(catId, kind) => {
                setPickerCategoryId(catId);
                setPickerKindValue(kind);
              }}
            />
            <Input
              placeholder="搜索规格名称..."
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              className="flex-1"
            />
          </div>
          <div className="max-h-[400px] overflow-y-auto space-y-2">
            {availableSkus.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)] py-8 text-center">
                {pickerSearch || pickerCategoryId || pickerKindValue ? "无匹配结果" : "暂无可添加的规格"}
              </p>
            ) : (
              availableSkus.map((sku) => (
                <div
                  key={sku.skuId}
                  className="flex items-center justify-between p-3 rounded-[var(--radius)] border border-[var(--border)] hover:bg-[var(--accent)] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{sku.specName}</p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {sku.productKind} · {sku.categoryName} · {sku.productType}
                    </p>
                    <p className="text-xs">
                      {formatCurrency(sku.price)}
                      {sku.specialPrice && (
                        <span className="text-[#C0322A] ml-1">会员 {formatCurrency(sku.specialPrice)}</span>
                      )}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-2 shrink-0"
                    loading={addingSku === sku.skuId}
                    disabled={!!addingSku}
                    onClick={() => handleAddSku(sku.skuId)}
                  >
                    添加
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </Dialog>

      {/* Remove Confirmation */}
      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogTitle>确认移除</AlertDialogTitle>
        <AlertDialogDescription>
          确定要移除该规格吗？移除后不会删除规格本身，仅解除与本商品的关联。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              setRemoveDialogOpen(false);
              setRemovingSkuId(null);
            }}
            disabled={removing}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleRemoveSku} disabled={removing}>
            {removing ? "移除中..." : "移除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  );
}

function BundlePriceCell({
  skuId,
  defaultValue,
  onSave,
}: {
  skuId: string;
  defaultValue: string;
  onSave: (skuId: string, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultValue);
  const [saving, setSaving] = useState(false);
  const committed = useRef(defaultValue);

  const submit = async () => {
    if (value === committed.current) return;
    setSaving(true);
    await onSave(skuId, value);
    committed.current = value;
    setSaving(false);
  };

  return (
    <Input
      type="number"
      step="0.01"
      className="h-8 w-24"
      placeholder="—"
      value={value}
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
