

export interface ExportColumn<T> {
  header: string
  
  width?: number
  accessor: (row: T) => string | number | null | undefined
}

export interface ExportOptions<T> {
  
  filename: string
  sheetName: string
  columns: ExportColumn<T>[]
  rows: T[]
}


import { fmtDate, fmtDateTime } from './datetime'
export { fmtDate, fmtDateTime }


export function maskIdCard(v: string | null | undefined): string {
  if (!v) return ''
  const s = v.trim()
  if (s.length <= 4) return s
  return `****${s.slice(-4)}`
}


export function fmtPercent(v: string | number | null | undefined): string {
  if (v == null || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (Number.isNaN(n)) return ''
  
  return `${Number((n * 100).toFixed(2))}%`
}

export async function exportToXlsx<T>(opts: ExportOptions<T>): Promise<void> {
  const { filename, sheetName, columns, rows } = opts
  const ExcelJS = (await import('exceljs')).default

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)

  
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

  
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  const ts = fmtDateTime(new Date()).replace(/[-: ]/g, '').slice(0, 12) 
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}_${ts}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
