/**
 * XLSX 导出工具（纯前端，在 client component 内调用）
 *
 * 用 exceljs 在浏览器端生成 .xlsx 并触发下载，二进制不经 Server Action 传输。
 * exceljs 体积较大，故 `exportToXlsx` 内部动态 import，避免增大首屏 bundle。
 */

export interface ExportColumn<T> {
  header: string
  /** 列宽（字符数），默认 16 */
  width?: number
  accessor: (row: T) => string | number | null | undefined
}

export interface ExportOptions<T> {
  /** 文件名前缀（不含扩展名与时间戳） */
  filename: string
  sheetName: string
  columns: ExportColumn<T>[]
  rows: T[]
}

// 时间格式化收口到 lib/datetime.ts（Asia/Shanghai 固定时区单一来源）；import 供本文件内部用（文件名时间戳），同时 re-export 保持既有 `@/lib/export-xlsx` import 兼容。
import { fmtDate, fmtDateTime } from './datetime'
export { fmtDate, fmtDateTime }

/** 身份证脱敏：仅保留后 4 位（前缀 ****） */
export function maskIdCard(v: string | null | undefined): string {
  if (!v) return ''
  const s = v.trim()
  if (s.length <= 4) return s
  return `****${s.slice(-4)}`
}

/**
 * 小数比率转百分比字符串：`0.30 → "30%"`、`0.155 → "15.5%"`。
 * 入参通常是 DB numeric 列（postgres.js 返回 string），null/空/非数字 → ""。
 */
export function fmtPercent(v: string | number | null | undefined): string {
  if (v == null || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isNaN(n)) return ''
  // toFixed(2) 后再 Number 去尾零：30 → "30"，15.5 → "15.5"
  return `${Number((n * 100).toFixed(2))}%`
}

export async function exportToXlsx<T>(opts: ExportOptions<T>): Promise<void> {
  const { filename, sheetName, columns, rows } = opts
  const ExcelJS = (await import('exceljs')).default

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)

  // 用列索引作为内部 key（header 可能重名，避免冲突）
  ws.columns = columns.map((c, i) => ({
    header: c.header,
    key: `c${i}`,
    width: c.width ?? 16,
  }))

  for (const row of rows) {
    const record: Record<string, string | number> = {}
    columns.forEach((c, i) => {
      const val = c.accessor(row)
      record[`c${i}`] = val == null ? '' : val
    })
    ws.addRow(record)
  }

  // 首行加粗 + 冻结
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  const ts = fmtDateTime(new Date()).replace(/[-: ]/g, '').slice(0, 12) // YYYYMMDDHHmm
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}_${ts}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
