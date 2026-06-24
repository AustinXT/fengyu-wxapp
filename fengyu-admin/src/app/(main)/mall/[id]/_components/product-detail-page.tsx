"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useUnsavedChanges } from "@/lib/hooks/use-unsaved-changes";
import type { Product, ProductSku, ProductCategory, MallCategory, MallBundleGroup } from "@/lib/types";
import {
  updateProduct, deleteProduct, addSkuToProduct, removeSkuFromProduct,
  createBundleGroup, updateBundleGroup, deleteBundleGroup,
} from "@/actions/products";
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
  bundleGroups,
  allSkus,
  mallCategories,
  skuCategories,
  markets,
  manageScope,
}: {
  product: Product;
  skus: ProductSku[];
  bundleGroups: MallBundleGroup[];
  allSkus: ProductSku[];
  mallCategories: MallCategory[];
  skuCategories: ProductCategory[];
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
  const [allMarkets, setAllMarkets] = useState(!product.marketScope);
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>(
    product.marketScope ? product.marketScope.split(",") : [],
  );

  // Mall category groups for grouped select
  const mallGroups = useMemo(
    () => mallCategories.filter((c) => c.categoryGroup === null).sort((a, b) => a.sortOrder - b.sortOrder),
    [mallCategories],
  );
  const mallSubCats = useMemo(
    () => mallCategories.filter((c) => c.categoryGroup !== null).sort((a, b) => a.sortOrder - b.sortOrder),
    [mallCategories],
  );

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
  const [pickerTargetGroupId, setPickerTargetGroupId] = useState<number | null>(null);

  // Remove dialog state
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removingSkuId, setRemovingSkuId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Bundle group dialog state
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<MallBundleGroup | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);

  // Delete group dialog
  const [deleteGroupDialogOpen, setDeleteGroupDialogOpen] = useState(false);
  const [deletingGroupId, setDeletingGroupId] = useState<number | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);

  // Delete product dialog
  const [deleteProductDialogOpen, setDeleteProductDialogOpen] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);

  const handleDeleteProduct = async () => {
    setDeletingProduct(true);
    try {
      const result = await deleteProduct(product.productId, product.updatedAt);
      if (!result.success) {
        toast.error(result.message);
        if (result.message.includes("已被其他人修改")) router.refresh();
        return;
      }
      toast.success("商品已删除");
      setDeleteProductDialogOpen(false);
      setFormDirty(false);
      router.push("/mall");
    } catch {
      toast.error("删除失败，请稍后重试");
    } finally {
      setDeletingProduct(false);
    }
  };

  // SKU Picker computed (uses skuCategories = product_categories)
  const linkedSkuIds = useMemo(() => new Set(skus.map((s) => s.skuId)), [skus]);

  const subCategories = useMemo(() => skuCategories.filter((c) => c.productKind !== null), [skuCategories]);
  const productKinds = useMemo(() => skuCategories.filter((c) => c.productKind === null), [skuCategories]);

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

  // --- Product Save ---
  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);

    const name = (fd.get("name") as string).trim();
    // 套餐(isBundle)时价格输入框为禁用展示态无 name，fd.get("price") 为 null，须空值兜底
    const price = ((fd.get("price") as string | null) ?? "").trim();

    if (!name) {
      toast.error("请输入商品名称");
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
          ...(isBundle ? {} : { price, specialPrice }),
          manageScope: manageScope.scopeId,
          marketScope: allMarkets ? null : selectedMarketIds.length > 0 ? selectedMarketIds.join(",") : null,
          sortOrder,
          isVisible,
        },
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
  const openPicker = (groupId?: number | null) => {
    setPickerSearch("");
    setPickerCategoryId("");
    setPickerKindValue("");
    setPickerTargetGroupId(groupId ?? null);
    setPickerOpen(true);
  };

  const handleAddSku = async (skuId: string) => {
    setAddingSku(skuId);
    try {
      const result = await addSkuToProduct(product.productId, skuId, 0, pickerTargetGroupId);
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

  // --- Bundle Group CRUD ---
  const openGroupDialog = (group?: MallBundleGroup) => {
    setEditingGroup(group ?? null);
    setGroupDialogOpen(true);
  };

  const handleGroupSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const groupName = ((fd.get("groupName") as string | null) ?? "").trim();
    const pickCountRaw = ((fd.get("pickCount") as string | null) ?? "").trim();
    const pickCount = pickCountRaw ? parseInt(pickCountRaw) || null : null;
    const unitListPrice = ((fd.get("unitListPrice") as string | null) ?? "").trim();
    const unitMemberPrice = ((fd.get("unitMemberPrice") as string | null) ?? "").trim() || null;

    if (!groupName) {
      toast.error("请输入分组名称");
      return;
    }
    if (!unitListPrice) {
      toast.error("请输入标价单价");
      return;
    }
    if (unitMemberPrice && Number(unitMemberPrice) > Number(unitListPrice)) {
      toast.error("会员价单价不能高于标价单价");
      return;
    }

    setGroupSaving(true);
    try {
      if (editingGroup) {
        const result = await updateBundleGroup(editingGroup.id, { groupName, pickCount, unitListPrice, unitMemberPrice });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success("分组已更新");
      } else {
        const result = await createBundleGroup({ productId: product.productId, groupName, pickCount, unitListPrice, unitMemberPrice });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success("分组已创建");
      }
      setGroupDialogOpen(false);
      setEditingGroup(null);
      router.refresh();
    } catch {
      toast.error("操作失败，请稍后重试");
    } finally {
      setGroupSaving(false);
    }
  };

  const openDeleteGroupDialog = (groupId: number) => {
    setDeletingGroupId(groupId);
    setDeleteGroupDialogOpen(true);
  };

  const handleDeleteGroup = async () => {
    if (!deletingGroupId) return;
    setDeletingGroup(true);
    try {
      const result = await deleteBundleGroup(deletingGroupId);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success("分组已删除");
      setDeleteGroupDialogOpen(false);
      setDeletingGroupId(null);
      router.refresh();
    } catch {
      toast.error("删除失败，请稍后重试");
    } finally {
      setDeletingGroup(false);
    }
  };

  // --- SKU columns ---
  const skuColumns: Column<ProductSku>[] = useMemo(() => {
    const cols: Column<ProductSku>[] = [
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
    ];
    if (isBundle) {
      cols.push(
        {
          key: "bundleListPrice" as keyof ProductSku,
          header: "套餐标价单价",
          cell: (row) => <span>{row.bundleListPrice ? formatCurrency(row.bundleListPrice) : "—"}</span>,
        },
        {
          key: "bundlePrice" as keyof ProductSku,
          header: "套餐会员价单价",
          cell: (row) => (
            <span className={row.bundlePrice ? "text-[#C0322A]" : ""}>
              {row.bundlePrice ? formatCurrency(row.bundlePrice) : "—"}
            </span>
          ),
        },
      );
    }
    cols.push(
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
    );
    return cols;
  }, [isBundle]);

  // Group SKUs by bundleGroupId for bundle view
  const ungroupedSkus = useMemo(() => skus.filter((s) => !s.bundleGroupId), [skus]);
  const skusByGroup = useMemo(() => {
    const map: Record<number, ProductSku[]> = {};
    for (const s of skus) {
      if (s.bundleGroupId) {
        if (!map[s.bundleGroupId]) map[s.bundleGroupId] = [];
        map[s.bundleGroupId].push(s);
      }
    }
    return map;
  }, [skus]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => router.back()}>
          &larr; 返回
        </Button>
        <h1 className="text-2xl font-bold text-[var(--foreground)] flex-1">商品详情 - {product.name}</h1>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setDeleteProductDialogOpen(true)}
        >
          删除商品
        </Button>
      </div>

      {/* 是否套餐切换 */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium">是否套餐</label>
            <Select
              value={isBundle ? "true" : "false"}
              onChange={(e) => {
                setIsBundle(e.target.value === "true");
                setFormDirty(true);
              }}
              className="w-32"
            >
              <option value="false">否</option>
              <option value="true">是</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 套餐分组管理（isBundle 时显示） */}
      {isBundle && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">套餐分组管理</CardTitle>
            <Button size="sm" onClick={() => openGroupDialog()}>
              添加分组
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {bundleGroups.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)] py-4 text-center">
                暂无分组，请添加套餐分组后再添加规格
              </p>
            ) : (
              bundleGroups.map((group) => {
                const groupSkus = skusByGroup[group.id] || [];
                return (
                  <div key={group.id} className="border border-[var(--border)] rounded-[var(--radius)]">
                    <div className="flex items-center justify-between px-4 py-3 bg-[var(--muted)]/30">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{group.groupName}</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-foreground)]">
                          {group.pickCount ? `${groupSkus.length}选${group.pickCount}` : "全选"}
                        </span>
                        <span className="text-xs text-[var(--muted-foreground)]">
                          标价单价 {group.unitListPrice ? formatCurrency(group.unitListPrice) : "—"}
                          {group.unitMemberPrice ? ` · 会员价 ${formatCurrency(group.unitMemberPrice)}` : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="link" size="sm" className="h-auto p-0 text-sm" onClick={() => openGroupDialog(group)}>
                          编辑
                        </Button>
                        <span className="text-[var(--border)]">|</span>
                        <Button variant="link" size="sm" className="h-auto p-0 text-sm text-[var(--destructive)]" onClick={() => openDeleteGroupDialog(group.id)}>
                          删除
                        </Button>
                        <span className="text-[var(--border)]">|</span>
                        <Button variant="link" size="sm" className="h-auto p-0 text-sm" onClick={() => openPicker(group.id)}>
                          添加规格
                        </Button>
                      </div>
                    </div>
                    <div className="p-2">
                      <DataTable columns={skuColumns} data={groupSkus} emptyText="该分组暂无规格" />
                    </div>
                  </div>
                );
              })
            )}

            {/* 未分组规格：正常态应为空（所有子商品必须归入分组）；非空=配置异常告警 */}
            {ungroupedSkus.length > 0 && (
              <div className="border border-[var(--destructive)] rounded-[var(--radius)]">
                <div className="flex items-center justify-between px-4 py-3 bg-[var(--destructive)]/10">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-[var(--destructive)]">⚠ 未分组规格（配置异常）</span>
                    <span className="text-xs text-[var(--destructive)]">这些规格不计入套餐价，请移入分组或移除</span>
                  </div>
                </div>
                <div className="p-2">
                  <DataTable columns={skuColumns} data={ungroupedSkus} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 非套餐：平铺 SKU 列表 */}
      {!isBundle && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">商品规格列表</CardTitle>
            <Button size="sm" onClick={() => openPicker()}>
              添加规格
            </Button>
          </CardHeader>
          <CardContent>
            <DataTable columns={skuColumns} data={skus} emptyText="暂无规格" />
          </CardContent>
        </Card>
      )}

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
            {isBundle ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">标价</label>
                  <Input value={formatCurrency(product.price)} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">会员价</label>
                  <Input value={product.specialPrice ? formatCurrency(product.specialPrice) : "无"} disabled />
                </div>
                <p className="col-span-2 text-xs text-[var(--muted-foreground)]">
                  套餐价由各分组「单价 × 可选数量」自动计算，不可手动修改。
                </p>
              </div>
            ) : (
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
            )}
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
                defaultChecked={product.isVisible}
                onChange={() => setFormDirty(true)}
                className="h-4 w-4 rounded border-[var(--input)]"
              />
              <span className="text-sm">在客户端商城中展示</span>
            </label>
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
          <DialogTitle>添加规格{pickerTargetGroupId ? ` — ${bundleGroups.find((g) => g.id === pickerTargetGroupId)?.groupName}` : ""}</DialogTitle>
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

      {/* Remove SKU Confirmation */}
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

      {/* Bundle Group Create/Edit Dialog */}
      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogHeader className="relative">
          <DialogTitle>{editingGroup ? "编辑分组" : "添加分组"}</DialogTitle>
          <DialogClose onOpenChange={setGroupDialogOpen} />
        </DialogHeader>
        <form onSubmit={handleGroupSave} className="mt-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">分组名称</label>
            <Input
              name="groupName"
              defaultValue={editingGroup?.groupName ?? ""}
              placeholder="如：护理服务、家居产品"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">标价单价</label>
              <Input
                name="unitListPrice"
                type="number"
                step="0.01"
                min={0}
                defaultValue={editingGroup?.unitListPrice ?? ""}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">会员价单价</label>
              <Input
                name="unitMemberPrice"
                type="number"
                step="0.01"
                min={0}
                defaultValue={editingGroup?.unitMemberPrice ?? ""}
                placeholder="不填=按标价成交"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">可选数量</label>
            <Input
              name="pickCount"
              type="number"
              min={1}
              defaultValue={editingGroup?.pickCount ?? ""}
              placeholder="不填则全选"
            />
            <p className="text-xs text-[var(--muted-foreground)]">
              N选M 的 M 值，留空表示该组内全部必选。套餐价 = 标价单价 × 计入数量。
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setGroupDialogOpen(false)}>
              取消
            </Button>
            <Button type="submit" loading={groupSaving}>
              {editingGroup ? "保存" : "创建"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Delete Group Confirmation */}
      <AlertDialog open={deleteGroupDialogOpen} onOpenChange={setDeleteGroupDialogOpen}>
        <AlertDialogTitle>确认删除分组</AlertDialogTitle>
        <AlertDialogDescription>
          确认删除该分组？仅可删除已清空规格的分组；若组内仍有规格，请先移除规格。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              setDeleteGroupDialogOpen(false);
              setDeletingGroupId(null);
            }}
            disabled={deletingGroup}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteGroup} disabled={deletingGroup}>
            {deletingGroup ? "删除中..." : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>

      {/* Delete Product Confirmation */}
      <AlertDialog open={deleteProductDialogOpen} onOpenChange={setDeleteProductDialogOpen}>
        <AlertDialogTitle>确认删除商品</AlertDialogTitle>
        <AlertDialogDescription>
          确认删除「{product.name}」？删除后将从商城列表中移除，已下单的历史数据不受影响。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => setDeleteProductDialogOpen(false)}
            disabled={deletingProduct}
          >
            取消
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteProduct} disabled={deletingProduct}>
            {deletingProduct ? "删除中..." : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  );
}

