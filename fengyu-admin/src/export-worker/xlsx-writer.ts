import ExcelJS from 'exceljs'

export type ExportCell = string | number | boolean | Date | null | undefined

export interface WorkerExportColumn<T> {
  header: string
  width?: number
  value: (row: T) => ExportCell
}

export interface StreamXlsxOptions<T> {
  filePath: string
  sheetName: string
  columns: WorkerExportColumn<T>[]
  rows: AsyncIterable<T>
  /** Internal override used by tests; production keeps the Excel-safe default. */
  rowsPerSheet?: number
  onProgress?: (rowCount: number) => Promise<void> | void
}

export interface StreamXlsxResult {
  rowCount: number
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
  const createSheet = (): ExcelJS.Worksheet => {
    sheetCount += 1
    rowsInSheet = 0
    const worksheet = workbook.addWorksheet(safeSheetName(options.sheetName, sheetCount), {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    worksheet.columns = options.columns.map((column) => ({ width: column.width ?? 16 }))
    const header = worksheet.addRow(options.columns.map((column) => column.header))
    header.font = { bold: true }
    header.commit()
    return worksheet
  }

  let worksheet = createSheet()
  for await (const sourceRow of options.rows) {
    if (rowsInSheet >= rowsPerSheet) {
      worksheet.commit()
      worksheet = createSheet()
    }
    const values = options.columns.map((column) => column.value(sourceRow) ?? '')
    worksheet.addRow(values).commit()
    rowsInSheet += 1
    rowCount += 1
    if (rowCount % 1_000 === 0) await options.onProgress?.(rowCount)
  }

  worksheet.commit()
  await workbook.commit()
  return { rowCount, sheetCount }
}
