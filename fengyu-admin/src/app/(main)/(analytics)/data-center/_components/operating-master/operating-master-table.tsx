"use client"

import { ExportButton } from "@/components/ui/export-button"
import {
  OPERATING_MASTER_COLUMNS,
  OPERATING_MASTER_HEADER_HEIGHTS,
  isOperatingMasterSubtotal,
  operatingMasterTotalsLabel,
  type OperatingMasterRow,
} from "@/lib/data-center/operating-master"
import type { MatrixTotals } from "@/lib/data-center/matrix"
import { MatrixTable, type MatrixColumn } from "../matrix-table"

/** 列定义来自 lib（与导出同源），这里只补页面渲染：维度列显示文本、占位列合计行显示「—」 */
const COLUMNS: MatrixColumn<OperatingMasterRow>[] = OPERATING_MASTER_COLUMNS.map((column) => {
  if (column.key === "marketName") return { ...column, cell: (row: OperatingMasterRow) => row.marketName }
  if (column.key === "storeName") return { ...column, cell: (row: OperatingMasterRow) => row.storeName }
  if (column.pending) return { ...column, formatTotal: () => "—" }
  return column
})

/** 占位列不在服务端合计里：补成显式的 null，合计行才会走 formatTotal 渲染「—」而不是留白 */
const PENDING_TOTALS: MatrixTotals = Object.fromEntries(
  OPERATING_MASTER_COLUMNS.filter((column) => column.pending).map((column) => [column.key, null]),
)

/**
 * 经营数据主表（#372）表格：两行分组表头（模板 E2/J2/N2/S2 全文）、冻结市场 / 门店、
 * 跨市场时每个市场一行小计、表尾合计（跨市场为「总计」）。不分页、不排序（行序 = 市场 → 门店）。
 */
export function OperatingMasterTable({
  rows,
  totals,
  multiMarket,
  exportParams,
}: {
  rows: OperatingMasterRow[]
  totals: MatrixTotals
  multiMarket: boolean
  exportParams: Record<string, string>
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <ExportButton
          exportRequest={{
            exportType: "data-center",
            payload: { view: "report-operating-master", params: exportParams },
          }}
        />
      </div>
      <MatrixTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.rowKey}
        isSubtotal={isOperatingMasterSubtotal}
        totals={{ label: operatingMasterTotalsLabel(multiMarket), values: { ...PENDING_TOTALS, ...totals } }}
        headerHeights={OPERATING_MASTER_HEADER_HEIGHTS}
      />
    </div>
  )
}
