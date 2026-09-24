import ExcelJS from 'exceljs'
import { buildMatrixHeaderLayout } from '@/lib/data-center/matrix'

export type ExportCell = string | number | boolean | Date | null | undefined

export interface WorkerExportColumn<T> {
  header: string
  width?: number
  value: (row: T) => ExportCell
  /**
   * 两行分组表头（#368）：相邻且 key 相同的列在第一行合并为一个分组格，
   * 没有分组的列两行纵向合并。任何一列带 group 时表头即为两行。
   */
  group?: { key: string; header: string }
  /** Excel 数字格式，如金额 '0.00'（值仍写原始数值，便于求和） */
  numFmt?: string
}

/** 导出元信息的一行（写入独立 sheet「导出说明」） */
export interface ExportMetaEntry {
  label: string
  value: string
}

/** 元信息 sheet 名。写在独立 sheet 而不是数据表上方，数据表的冻结行数只等于表头行数 */
export const EXPORT_META_SHEET_NAME = '导出说明'

export interface StreamXlsxOptions<T> {
  filePath: string
  sheetName: string
  columns: WorkerExportColumn<T>[]
  rows: AsyncIterable<T>
  /** 左侧冻结列数（矩阵表的姓名 / 门店等维度列） */
  frozenColumns?: number
  /** 合计行：与数据行同形，经同一套 column.value 取值，写在最后一个数据 sheet 末尾并加粗 */
  totalsRow?: T
  /** 市场小计等需要加粗的行 */
  isEmphasisRow?: (row: T) => boolean
  /** 导出元信息（时间区间、scope、导出时间、导出人……），非空时追加一个独立 sheet */
  meta?: ExportMetaEntry[]
  /** Internal override used by tests; production keeps the Excel-safe default. */
  rowsPerSheet?: number
  onProgress?: (rowCount: number) => Promise<void> | void
}

export interface StreamXlsxResult {
  /** 数据行数（不含表头、合计行） */
  rowCount: number
  /** 数据 sheet 数（不含「导出说明」） */
  sheetCount: number
}

/** Excel 单工作表上限为 1,048,576 行；预留表头且按产品规则在 100 万数据行分表。 */
export const XLSX_ROWS_PER_SHEET = 1_000_000

function safeSheetName(input: string, sequence: number): string {
  const suffix = sequence === 1 ? '' : `-${sequence}`
  const base = input.replace(/[\\/?*\[\]:]/g, ' ').trim() || '导出数据'
  return `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`
}

/**
 * ExcelJS streaming writer 不保留已提交的行，文件体积和行数不再放大 worker 的堆内存。
 */
export async function writeStreamXlsx<T>(options: StreamXlsxOptions<T>): Promise<StreamXlsxResult> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: options.filePath,
    useStyles: true,
    useSharedStrings: false,
  })

  let rowCount = 0
  let sheetCount = 0
  let rowsInSheet = 0
  const rowsPerSheet = Math.min(
    XLSX_ROWS_PER_SHEET,
    Math.max(1, Math.floor(options.rowsPerSheet ?? XLSX_ROWS_PER_SHEET)),
  )
  const layout = buildMatrixHeaderLayout(
    options.columns.map((column, index) => ({ key: String(index), group: column.group })),
  )
  const frozenColumns = Math.max(0, Math.floor(options.frozenColumns ?? 0))
  const groupStarts = new Set([...layout.groupStartKeys].map(Number))

  const createSheet = (): ExcelJS.Worksheet => {
    sheetCount += 1
    rowsInSheet = 0
    const worksheet = workbook.addWorksheet(safeSheetName(options.sheetName, sheetCount), {
      views: [{ state: 'frozen', ySplit: layout.depth, ...(frozenColumns > 0 ? { xSplit: frozenColumns } : {}) }],
    })
    worksheet.columns = options.columns.map((column) => ({
      width: column.width ?? 16,
      ...(column.numFmt ? { style: { numFmt: column.numFmt } } : {}),
    }))

    const headerRows = layout.rows.map(() => worksheet.addRow([]))
    layout.rows.forEach((cells, rowIndex) => {
      for (const cell of cells) {
        const columnIndex = cell.firstLeafIndex + 1
        const target = headerRows[rowIndex].getCell(columnIndex)
        target.value = cell.groupKey
          ? options.columns[cell.firstLeafIndex].group!.header
          : options.columns[cell.firstLeafIndex].header
        if (layout.depth === 2) {
          target.alignment = { vertical: 'middle', horizontal: cell.groupKey ? 'center' : undefined }
        }
        if (cell.groupKey || groupStarts.has(cell.firstLeafIndex)) {
          target.border = { left: { style: 'thin' } }
        }
      }
    })
    // 合并必须在表头行 commit 之前：流式 writer 对已提交的行无法再标记合并从属格
    for (const cell of layout.rows[0]) {
      if (cell.colSpan > 1 || cell.rowSpan > 1) {
        const column = cell.firstLeafIndex + 1
        worksheet.mergeCells(1, column, cell.rowSpan, column + cell.colSpan - 1)
      }
    }
    for (const header of headerRows) {
      header.font = { bold: true }
      header.commit()
    }
    return worksheet
  }

  let worksheet = createSheet()
  for await (const sourceRow of options.rows) {
    if (rowsInSheet >= rowsPerSheet) {
      worksheet.commit()
      worksheet = createSheet()
    }
    const values = options.columns.map((column) => column.value(sourceRow) ?? '')
    const row = worksheet.addRow(values)
    if (options.isEmphasisRow?.(sourceRow)) row.font = { bold: true }
    row.commit()
    rowsInSheet += 1
    rowCount += 1
    if (rowCount % 1_000 === 0) await options.onProgress?.(rowCount)
  }

  if (options.totalsRow !== undefined && rowCount > 0) {
    const totals = worksheet.addRow(options.columns.map((column) => column.value(options.totalsRow as T) ?? ''))
    totals.font = { bold: true }
    totals.eachCell((cell) => { cell.border = { top: { style: 'thin' } } })
    totals.commit()
  }
  worksheet.commit()

  if (options.meta && options.meta.length > 0) {
    const metaSheet = workbook.addWorksheet(EXPORT_META_SHEET_NAME)
    metaSheet.columns = [{ width: 18 }, { width: 48 }]
    for (const entry of options.meta) {
      const row = metaSheet.addRow([entry.label, entry.value])
      row.getCell(1).font = { bold: true }
      row.commit()
    }
    metaSheet.commit()
  }
  await workbook.commit()
  return { rowCount, sheetCount }
}
