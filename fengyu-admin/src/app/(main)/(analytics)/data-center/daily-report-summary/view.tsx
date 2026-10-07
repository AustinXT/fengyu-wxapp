'use client'

import * as React from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { useUrlFilters } from '@/lib/hooks/use-url-filters'
import {
  DAILY_REPORT_METRICS,
  dailyReportSummaryExportRows,
  type DailyReportMetricValues,
  type DailyReportSummaryRow,
} from '@/lib/data-center/daily-report-summary'
import { formatCount } from '@/lib/data-center/format'

const SEARCH_DEBOUNCE_MS = 300

function amount(value: number | undefined): string {
  return value == null ? '—' : `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function metricText(values: DailyReportMetricValues | null | undefined, key: string): string {
  const metric = DAILY_REPORT_METRICS.find((item) => item.key === key)
  const value = values?.[key as keyof DailyReportMetricValues]
  if (value == null) return '—'
  return metric?.unit === 'amount' ? amount(value) : formatCount(value)
}

function MetricStrip({ label, values }: { label: string; values: DailyReportMetricValues | null }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {DAILY_REPORT_METRICS.map((metric) => (
        <div key={metric.key} className="rounded-md bg-[#F8F9FB] px-3 py-2">
          <div className="text-xs text-[var(--muted-foreground)]">{metric.label}</div>
          <div className="mt-1 text-sm font-medium">{metricText(values, metric.key)}</div>
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

function TextSection({ title, value }: { title: string; value: string }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium text-[var(--muted-foreground)]">{title}</h3>
      <p className="whitespace-pre-wrap break-words text-sm">{value || <span className="text-[var(--muted-foreground)]">未填写</span>}</p>
    </section>
  )
}

function safeFileDate(value: string) {
  return value.replaceAll('-', '')
}

export function DailyReportSummaryView({
  date,
  today,
  employeeSearch,
  reports,
}: {
  date: string
  today: string
  employeeSearch: string
  reports: DailyReportSummaryRow[]
}) {
  const filters = useUrlFilters()
  const setFilter = filters.set
  const [search, setSearch] = React.useState(employeeSearch)
  React.useEffect(() => setSearch(employeeSearch), [employeeSearch])
  React.useEffect(() => {
    if (search.trim() === employeeSearch) return
    const timer = window.setTimeout(() => setFilter('employee', search.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, employeeSearch, setFilter])

  const businessCount = reports.reduce((total, report) => total + report.entries.length, 0)

  async function exportWorkbook() {
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      const rows = dailyReportSummaryExportRows(reports)
      const overview = workbook.addWorksheet('日报概览')
      const feedback = workbook.addWorksheet('业务反馈')
      const overviewRows = rows.overview
      const feedbackRows = rows.business
      if (overviewRows.length) {
        overview.columns = Object.keys(overviewRows[0]).map((header) => ({ header, key: header, width: 18 }))
        overview.addRows(overviewRows)
      } else {
        overview.addRow(['日期', '区域', '门店', '员工', '岗位', '提交时间', '指导员', '同事', '当日业绩', '当日消耗', '当日客量', '当日新客', '当日项目数', '今日行动', '今日成长', '明日计划'])
      }
      if (feedbackRows.length) {
        feedback.columns = Object.keys(feedbackRows[0]).map((header) => ({ header, key: header, width: 22 }))
        feedback.addRows(feedbackRows)
      } else {
        feedback.addRow(['日期', '区域', '门店', '员工', '业务类型', '业务日期', '顾客及业务', '业务编号', '反馈', '后续跟进'])
      }
      for (const sheet of [overview, feedback]) {
        sheet.views = [{ state: 'frozen', ySplit: 1 }]
        const header = sheet.getRow(1)
        header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0322A' } }
        header.height = 24
        sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(sheet.columnCount).letter}1` }
        sheet.eachRow((row, rowNumber) => {
          if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true }
        })
      }
      const bytes = await workbook.xlsx.writeBuffer()
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `员工日报内容汇总_${safeFileDate(date)}.xlsx`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch {
      toast.error('导出失败，请稍后重试')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-sm text-[var(--muted-foreground)]">
          日报日期
          <DatePicker aria-label="日报日期" value={date} max={today} onValueChange={(value) => setFilter('date', value)} />
        </label>
        <label className="flex min-w-56 flex-col gap-1 text-sm text-[var(--muted-foreground)]">
          员工搜索
          <Input aria-label="员工搜索" placeholder="输入员工姓名" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={50} />
        </label>
        <div className="ml-auto flex items-center gap-3 text-sm text-[var(--muted-foreground)]">
          <span>{reports.length} 份日报 · {businessCount} 条业务</span>
          <Button type="button" variant="outline" onClick={() => void exportWorkbook()} disabled={!reports.length}>
            <Download className="mr-2 size-4" />导出 Excel
          </Button>
        </div>
      </Card>

      {reports.length === 0 ? (
        <Card className="p-10 text-center text-sm text-[var(--muted-foreground)]">所选日期和范围内没有已提交日报。</Card>
      ) : (
        <div className="flex flex-col gap-3">
          {reports.map((report) => (
            <details key={report.id} className="group rounded-lg border border-[var(--border)] bg-white">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <div>
                  <span className="font-medium text-[var(--foreground)]">{report.employeeName}</span>
                  <span className="ml-2 text-sm text-[var(--muted-foreground)]">{report.positionName || '未记录岗位'} · {report.storeName}{report.marketName ? ` · ${report.marketName}` : ''}</span>
                </div>
                <span className="text-sm text-[var(--muted-foreground)]">{report.entries.length} 条业务 · {report.submittedAt ? new Date(report.submittedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }) : '已提交'} <span className="ml-1 transition-transform group-open:rotate-180">⌄</span></span>
              </summary>
              <div className="border-t border-[var(--border)] p-4">
                <div className="flex flex-col gap-4">
                  <section>
                    <div className="mb-2 text-sm font-semibold">经营指标快照 · 当日</div>
                    <MetricStrip label="当日指标" values={report.metrics?.day ?? null} />
                    {report.metrics?.week && <><div className="mb-2 mt-3 text-sm font-semibold">经营周累计{report.metrics.weekName ? ` · ${report.metrics.weekName}` : ''}</div><MetricStrip label="经营周指标" values={report.metrics.week} /></>}
                    {report.metrics?.month && <><div className="mb-2 mt-3 text-sm font-semibold">经营月累计{report.metrics.periodName ? ` · ${report.metrics.periodName}` : ''}</div><MetricStrip label="经营月指标" values={report.metrics.month} /></>}
                  </section>
                  <div className="grid gap-4 lg:grid-cols-3">
                    <TextSection title="今日行动" value={report.action} />
                    <TextSection title="今日成长" value={report.growth} />
                    <TextSection title="明日计划" value={report.plan} />
                  </div>
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">业务反馈与后续跟进</h3>
                    {report.entries.length === 0 ? <p className="text-sm text-[var(--muted-foreground)]">本日报没有关联销售或服务条目。</p> : (
                      <div className="grid gap-3 lg:grid-cols-2">
                        {report.entries.map((entry) => (
                          <div key={`${entry.businessType}:${entry.businessId}`} className="rounded-md border border-[var(--border)] p-3">
                            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                              <span className="rounded bg-[#FFF0EE] px-2 py-0.5 text-[var(--color-brand)]">{entry.businessType === 'service' ? '服务' : '销售'}</span>
                              <span className="font-medium">{String(entry.snapshot.title ?? '业务记录')}</span>
                              <span className="text-xs text-[var(--muted-foreground)]">{entry.businessId}</span>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <TextSection title="反馈" value={entry.feedback} />
                              <TextSection title="后续跟进" value={entry.followUp} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                  <div className="text-xs text-[var(--muted-foreground)]">指导员：{report.mentorEmployeeId || '未填写'} · 同事：{report.peerEmployeeId || '未填写'}</div>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
