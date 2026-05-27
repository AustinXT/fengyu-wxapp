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

/** Asia/Shanghai 固定时区格式化（避免依赖运行环境时区） */
const partsOf = (() => {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  return (d: Date) => {
    const p: Record<string, string> = {}
    for (const { type, value } of fmt.formatToParts(d)) p[type] = value
    return p
  }
})()

/**
 * 格式化为本地时区 `YYYY-MM-DD HH:mm:ss`。
 * 入参通常是 action `toISOString()` 出来的 UTC 串，必须经此转换，
 * 否则裸写 ISO 会差 8 小时（见 orders.ts 把 timestamp toISOString）。
 */
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : ''
  const p = partsOf(d)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/**
 * 格式化为 `YYYY-MM-DD`。
 * 若入参已是纯日期串（Drizzle date 列即 string），直接截断返回，不做时区转换（避免偏移）。
 */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return ''
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : ''
  const p = partsOf(d)
  return `${p.year}-${p.month}-${p.day}`
}

/** 身份证脱敏：仅保留后 4 位（前缀 ****） */
export function maskIdCard(v: string | null | undefined): string {
  if (!v) return ''
  const s = v.trim()
  if (s.length <= 4) return s
  return `****${s.slice(-4)}`
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
