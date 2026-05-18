"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Pagination } from "@/components/ui/pagination"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  previewLegacyProductMappingCsv,
  uploadLegacyProductMappingCsv,
  updateLegacyProductMapping,
  deleteLegacyProductMapping,
  type CsvRowInput,
  type MappingListRow,
  type ParsedRow,
  type UploadPreviewResult,
} from "@/actions/legacy-product-mapping"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"

interface Props {
  initialRows: MappingListRow[]
  initialTotal: number
}

/**
 * 简易 CSV 解析（避免 papaparse 新依赖）：
 *  - 首行为表头
 *  - 列：legacy_product_name, legacy_product_code, target_category_id, target_sku_id, source, note
 *  - 不支持引号转义内部逗号（CSV 来自张凯人工导出，简单 split 即可）
 *  - 跳过空行
 */
function parseCsv(text: string): CsvRowInput[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return []
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase())
  const colIdx = (name: string) => header.indexOf(name)
  const idxName = colIdx("legacy_product_name")
  const idxCode = colIdx("legacy_product_code")
  const idxCat = colIdx("target_category_id")
  const idxSku = colIdx("target_sku_id")
  const idxSource = colIdx("source")
  const idxNote = colIdx("note")

  if (idxName < 0) {
    throw new Error("CSV 缺失必需列：legacy_product_name")
  }

  const rows: CsvRowInput[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim())
    rows.push({
      rowIndex: i + 1, // 1-based + 表头偏移
      legacyProductName: cols[idxName] ?? "",
      legacyProductCode: idxCode >= 0 ? cols[idxCode] : undefined,
      targetCategoryId: idxCat >= 0 ? cols[idxCat] : undefined,
      targetSkuId: idxSku >= 0 ? cols[idxSku] : undefined,
      source: idxSource >= 0 ? cols[idxSource] : undefined,
      note: idxNote >= 0 ? cols[idxNote] : undefined,
    })
  }
  return rows
}

export default function LegacyProductMappingPageClient({
  initialRows,
  initialTotal,
}: Props) {
  const router = useRouter()
  const { get, set, setMany } = useUrlFilters()
  const [, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const page = Number(get("page") || 1)
  const pageSize = Number(get("size") || 20)

  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<UploadPreviewResult | null>(null)
  const [pendingRows, setPendingRows] = useState<CsvRowInput[] | null>(null)
  const [editTarget, setEditTarget] = useState<MappingListRow | null>(null)
  const [editForm, setEditForm] = useState<{
    targetCategoryId: string
    targetSkuId: string
    note: string
    confirmed: boolean
  }>({ targetCategoryId: "", targetSkuId: "", note: "", confirmed: false })
  const [deleteTarget, setDeleteTarget] = useState<MappingListRow | null>(null)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      toast.error("文件过大（>2MB），请分批上传")
      return
    }
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length === 0) {
        toast.error("CSV 无有效数据行")
        return
      }
      setPending(true)
      const result = await previewLegacyProductMappingCsv(rows)
      setPreview(result)
      setPendingRows(rows)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "解析失败")
    } finally {
      setPending(false)
      // 清空文件输入，允许重传同名文件
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleConfirmUpload = async () => {
    if (!pendingRows) return
    setPending(true)
    try {
      const res = await uploadLegacyProductMappingCsv(pendingRows)
      toast.success(
        `上传完成：新增 ${res.inserted} / 覆盖 ${res.updated} / 跳过 ${res.skipped} / 警告 ${res.warnings}`,
      )
      setPreview(null)
      setPendingRows(null)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败")
    } finally {
      setPending(false)
    }
  }

  const openEditDialog = (row: MappingListRow) => {
    setEditTarget(row)
    setEditForm({
      targetCategoryId: row.targetCategoryId ?? "",
      targetSkuId: row.targetSkuId ?? "",
      note: row.note ?? "",
      confirmed: row.confirmed,
    })
  }

  const handleSaveEdit = async () => {
    if (!editTarget) return
    setPending(true)
    try {
      await updateLegacyProductMapping(
        editTarget.id,
        {
          targetCategoryId: editForm.targetCategoryId.trim() || null,
          targetSkuId: editForm.targetSkuId.trim() || null,
          note: editForm.note.trim() || null,
          confirmed: editForm.confirmed,
        },
        editTarget.updatedAt,
      )
      toast.success("已更新")
      setEditTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败")
    } finally {
      setPending(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setPending(true)
    try {
      await deleteLegacyProductMapping(deleteTarget.id, deleteTarget.updatedAt)
      toast.success("已删除")
      setDeleteTarget(null)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--foreground)]">
          历史品项映射
        </h1>
        <span className="text-sm text-[#999999]">
          WorkFine 原品项 → 新品项分类/SKU 映射；CSV 上传后入库 + 业务方逐条确认
        </span>
      </div>

      {/* 上传 + 筛选 */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              className="hidden"
              id="csv-upload-input"
            />
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={pending}
            >
              上传 CSV
            </Button>
            <span className="text-xs text-[#999999]">
              列：legacy_product_name, legacy_product_code, target_category_id,
              target_sku_id, source, note（首行表头；&lt;2MB）
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Input
              placeholder="原品项名 / 编号 模糊搜索"
              defaultValue={get("q")}
              onBlur={(e) => set("q", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  set("q", (e.target as HTMLInputElement).value)
                }
              }}
            />
            <select
              className="h-9 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
              value={get("source")}
              onChange={(e) => setMany({ source: e.target.value, page: "" })}
            >
              <option value="">全部 source</option>
              <option value="ai_inferred">AI 推断</option>
              <option value="business_confirmed">业务方确认</option>
              <option value="manual_override">手动覆盖</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={get("unmapped") === "1"}
                onChange={(e) =>
                  setMany({ unmapped: e.target.checked ? "1" : "", page: "" })
                }
              />
              仅未映射（target 全空）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={get("unconfirmed") === "1"}
                onChange={(e) =>
                  setMany({ unconfirmed: e.target.checked ? "1" : "", page: "" })
                }
              />
              仅未确认
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMany({
                  q: "",
                  source: "",
                  unmapped: "",
                  unconfirmed: "",
                  page: "",
                })
              }}
            >
              重置筛选
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 表格 */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    原品项名
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    编号
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    目标分类
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    目标 SKU
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    来源
                  </th>
                  <th className="px-4 py-3 text-center font-medium text-gray-500">
                    确认
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    备注
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    更新时间
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {initialRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="py-12 text-center text-[#999999]"
                    >
                      暂无映射数据。请通过「上传 CSV」导入。
                    </td>
                  </tr>
                )}
                {initialRows.map((r) => {
                  const unmapped = !r.targetCategoryId && !r.targetSkuId
                  return (
                    <tr
                      key={r.id}
                      className={`hover:bg-[#FFF0EE] transition-colors ${
                        unmapped ? "bg-amber-50" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-medium">
                        {r.legacyProductName}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {r.legacyProductCode || "-"}
                      </td>
                      <td className="px-4 py-3">
                        {r.targetCategoryName ? (
                          <span>
                            {r.targetCategoryName}{" "}
                            <span className="text-xs text-[#999999]">
                              ({r.targetCategoryId})
                            </span>
                          </span>
                        ) : (
                          <span className="text-[#999999]">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {r.targetSkuSpecName ? (
                          <span>
                            {r.targetSkuSpecName}{" "}
                            <span className="text-xs text-[#999999]">
                              ({r.targetSkuId})
                            </span>
                          </span>
                        ) : (
                          <span className="text-[#999999]">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <SourceBadge source={r.source} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        {r.confirmed ? (
                          <span className="text-[#3D8A5A]">✓ 已确认</span>
                        ) : (
                          <span className="text-[#D4820A]">○ 待确认</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#666666] max-w-xs truncate">
                        {r.note || "-"}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#999999]">
                        {new Date(r.updatedAt).toLocaleString("zh-CN", {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openEditDialog(r)}
                            disabled={pending}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-[#D94040]"
                            onClick={() => setDeleteTarget(r)}
                            disabled={pending}
                          >
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-200">
            <Pagination
              total={initialTotal}
              page={page}
              pageSize={pageSize}
              onPageChange={(p) =>
                startTransition(() => set("page", String(p)))
              }
              pageSizeOptions={[10, 20, 50, 100]}
              onPageSizeChange={(s) =>
                startTransition(() =>
                  setMany({ size: String(s), page: "" }),
                )
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* 预览弹窗 */}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null)
            setPendingRows(null)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>CSV 预览（共 {preview?.totalRows ?? 0} 行）</DialogTitle>
        </DialogHeader>
        {preview && (
          <div className="mt-3 space-y-3">
            <div className="flex gap-4 text-sm">
              <span className="text-[#3D8A5A]">
                ok: {preview.okCount}
              </span>
              <span className="text-[#D4820A]">
                warning: {preview.warningCount}（target 全空，将作为「待映射」入库）
              </span>
              <span className="text-[#D94040]">
                error: {preview.errorCount}（将被跳过）
              </span>
            </div>
            <div className="max-h-96 overflow-auto border rounded">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">行</th>
                    <th className="px-2 py-1 text-left">level</th>
                    <th className="px-2 py-1 text-left">name</th>
                    <th className="px-2 py-1 text-left">code</th>
                    <th className="px-2 py-1 text-left">target_category</th>
                    <th className="px-2 py-1 text-left">target_sku</th>
                    <th className="px-2 py-1 text-left">messages</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r: ParsedRow) => (
                    <tr
                      key={r.rowIndex}
                      className={
                        r.level === "error"
                          ? "bg-red-50"
                          : r.level === "warning"
                            ? "bg-amber-50"
                            : ""
                      }
                    >
                      <td className="px-2 py-1">{r.rowIndex}</td>
                      <td className="px-2 py-1">{r.level}</td>
                      <td className="px-2 py-1">{r.legacyProductName}</td>
                      <td className="px-2 py-1 font-mono">
                        {r.legacyProductCode || "-"}
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {r.targetCategoryId || "-"}
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {r.targetSkuId || "-"}
                      </td>
                      <td className="px-2 py-1 text-[#666]">
                        {r.messages.join("；")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.totalRows > preview.rows.length && (
                <div className="p-2 text-center text-xs text-[#999]">
                  （仅显示前 {preview.rows.length} 行，共 {preview.totalRows} 行）
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setPreview(null)
              setPendingRows(null)
            }}
          >
            取消
          </Button>
          <Button onClick={handleConfirmUpload} disabled={pending}>
            确认入库（{(preview?.okCount ?? 0) + (preview?.warningCount ?? 0)} 行）
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 编辑弹窗 */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogHeader>
          <DialogTitle>
            编辑映射：{editTarget?.legacyProductName}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-sm text-[#666] mb-1">
              target_category_id（留空表示不映射到分类）
            </label>
            <Input
              value={editForm.targetCategoryId}
              onChange={(e) =>
                setEditForm({ ...editForm, targetCategoryId: e.target.value })
              }
              placeholder="如：cat_xxx"
            />
          </div>
          <div>
            <label className="block text-sm text-[#666] mb-1">
              target_sku_id（留空表示不映射到 SKU）
            </label>
            <Input
              value={editForm.targetSkuId}
              onChange={(e) =>
                setEditForm({ ...editForm, targetSkuId: e.target.value })
              }
              placeholder="如：sku_yyy"
            />
          </div>
          <div>
            <label className="block text-sm text-[#666] mb-1">备注</label>
            <Input
              value={editForm.note}
              onChange={(e) =>
                setEditForm({ ...editForm, note: e.target.value })
              }
              placeholder="可记录映射依据"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editForm.confirmed}
              onChange={(e) =>
                setEditForm({ ...editForm, confirmed: e.target.checked })
              }
            />
            标记为「已确认」
          </label>
          <p className="text-xs text-[#999]">
            保存后 source 自动变更为 manual_override。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditTarget(null)}>
            取消
          </Button>
          <Button onClick={handleSaveEdit} disabled={pending}>
            保存
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogTitle>
          删除映射「{deleteTarget?.legacyProductName}」？
        </AlertDialogTitle>
        <AlertDialogDescription>
          该映射将物理删除。若后续 CSV 再次包含同名原品项，会作为新行插入。
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            className="bg-[#D94040]"
          >
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>
    </div>
  )
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ai_inferred: {
      label: "AI 推断",
      cls: "bg-blue-50 text-blue-700 border border-blue-200",
    },
    business_confirmed: {
      label: "业务方确认",
      cls: "bg-green-50 text-green-700 border border-green-200",
    },
    manual_override: {
      label: "手动覆盖",
      cls: "bg-amber-50 text-amber-700 border border-amber-200",
    },
  }
  const entry = map[source] ?? { label: source, cls: "bg-gray-50 text-gray-700 border" }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${entry.cls}`}>
      {entry.label}
    </span>
  )
}
