/**
 * 矩阵表「页面列 → 导出列」的单源转换（#368）。
 *
 * 页面（MatrixTable）与异步导出（export-worker）从同一份列定义出发：分组、冻结、单位、合计口径只写一次，
 * 导出件的表头 / 数值 / 合计不会与页面漂移。导出侧沿用数据中心既有约定（lib/data-center/export.ts）：
 * 写原始数值（金额 2 位、计数整数、占比转百分数），占比列表头追加 (%)。
 */
import type { ExportCell, WorkerExportColumn } from '@/export-worker/xlsx-writer'
import { headerWithUnit, metricCell } from './export'
import { toTotal, type MatrixColumnSpec, type MatrixTotals } from './matrix'
import type { MetricUnit } from './types'

export interface MatrixExportColumnSpec<T> extends MatrixColumnSpec<T> {
  header: string
  /** 数值列单位，缺省 amount（与 MatrixTable 一致） */
  unit?: MetricUnit
  /** 非数值列（姓名、电话、✓ 标记）自己给导出值；缺省按 value + unit 写原始数值 */
  exportValue?: (row: T) => ExportCell
  /** 导出列宽（字符数），缺省 16 */
  exportWidth?: number
}

/** 与页面展示精度一致的 Excel 数字格式（值本身仍是原始数值，可直接求和） */
const NUM_FMT: Record<MetricUnit, string> = { amount: '#,##0.00', percent: '0.00', count: '#,##0' }

/**
 * @param serverTotals 服务端按**全量筛选**算好的合计（与分页表同一份）。导出从不拿明细行现算合计：
 *   明细是流式写出的，现算就得把全部行攒进内存；去重计数列也根本算不出来。
 */
export function toWorkerExportColumns<T>(
  columns: readonly MatrixExportColumnSpec<T>[],
  serverTotals?: MatrixTotals,
): WorkerExportColumn<T>[] {
  return columns.map((column) => {
    const unit = column.unit ?? 'amount'
    const numeric = !column.exportValue && !!column.value
    const hasTotal = !!serverTotals && Object.prototype.hasOwnProperty.call(serverTotals, column.key)
    return {
      header: numeric ? headerWithUnit(column.header, unit) : column.header,
      width: column.exportWidth,
      group: column.group ? { key: column.group.key, header: column.group.header } : undefined,
      value: column.exportValue
        ?? (column.value ? (row: T) => metricCell(column.value!(row), unit) : () => ''),
      ...(numeric ? { numFmt: NUM_FMT[unit] } : {}),
      ...(hasTotal ? { total: metricCell(toTotal(serverTotals![column.key]), unit) } : {}),
    }
  })
}

/** 导出冻结列数 = 页面左侧冻结列数（右侧冻结在 Excel 里没有对应物，不冻结） */
export function countLeftFrozen<T>(columns: readonly MatrixColumnSpec<T>[]): number {
  let count = 0
  while (count < columns.length && columns[count].freeze === 'left') count += 1
  return count
}
