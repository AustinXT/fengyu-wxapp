/**
 * 员工提成日报 / 提成明细（#375）的导出内容。取数走与页面同一个 Server Action（worker 以任务快照会话执行），
 * 列定义走 lib/data-center/commission-columns.ts，经 matrix-export.ts 转成导出列 —— 与页面不漂移。
 */
import { exportCommissionDetail, getCommissionDaily } from '@/actions/data-center/commission'
import {
  buildCommissionDailyColumns,
  buildCommissionDetailColumns,
  commissionDailyTotalsMap,
  commissionTotalsLabel,
  type CommissionDetailRow,
} from '@/lib/data-center/commission-columns'
import {
  COMMISSION_SOURCE_LABELS,
  COMMISSION_VIEW_LABELS,
} from '@/lib/data-center/commission-daily'
import { countLeftFrozen, toWorkerExportColumns } from '@/lib/data-center/matrix-export'
import { monthRange } from '@/lib/data-center/report-period'
import { shanghaiToday } from '@/lib/data-center/time-range'
import {
  EXPORT_WORKER_BATCH_SIZE,
  iterateExportPages,
  type ExportBatchOptions,
} from '@/lib/export-pagination'
import type { ExportQueryPayload } from '@/lib/export-job-types'
import type { ExportMetaEntry, WorkerExportColumn } from './xlsx-writer'
import type { ExportContent } from './registry'

type Row = Record<string, unknown>

function asRows<T>(rows: readonly T[]): AsyncIterable<Row> {
  return (async function* () {
    for (const row of rows) yield row as unknown as Row
  })()
}

function periodText(month: string): string {
  const range = monthRange(month)
  return `${range.start} ~ ${range.end}`
}

export async function commissionDailyExport(params: ExportQueryPayload): Promise<ExportContent> {
  const data = await getCommissionDaily(params)
  const columns = buildCommissionDailyColumns({
    month: data.month,
    view: data.options.view,
    grain: data.grain,
    today: shanghaiToday(),
  })
  const extra: ExportMetaEntry[] = [
    { label: '视图', value: COMMISSION_VIEW_LABELS[data.options.view] },
    {
      label: '汇总维度',
      value: data.grain === 'position' ? '按岗位' : data.grain === 'employee' ? '按员工（合并门店）' : '按员工 × 单据门店',
    },
    ...(data.options.search ? [{ label: '员工搜索', value: data.options.search }] : []),
    ...(data.options.hideZero ? [{ label: '隐藏 0 提成行', value: '是（负数行保留）' }] : []),
    { label: '口径', value: '业绩提成按款项归属日期、消耗提成按服务日期；读落库提成额，按单据门店切分' },
  ]
  return {
    sheetName: '员工提成日报',
    columns: toWorkerExportColumns(columns, commissionDailyTotalsMap(columns, data.totals)) as unknown as WorkerExportColumn<Row>[],
    rows: asRows(data.rows),
    frozenColumns: countLeftFrozen(columns),
    totalsLabel: commissionTotalsLabel(data.grain, data.totals),
    meta: { period: periodText(data.month), scope: data.scopeName, extra },
  }
}

export async function commissionDetailExport(params: ExportQueryPayload): Promise<ExportContent> {
  const fetch = (options: ExportBatchOptions<string>) => exportCommissionDetail(params, options)
  // 第一批同时带回全量汇总（合计行）与筛选回显；其余批次只取行
  const first = await fetch({ limit: EXPORT_WORKER_BATCH_SIZE })
  const { filters, summary } = first
  const columns = buildCommissionDetailColumns({ showEmployee: !filters.employeeId })
  const totals = summary
    ? { received: summary.received, allocated: summary.allocated, commission: summary.commission, rate: summary.averageRate }
    : undefined
  const employee = filters.employeeId
    ? (() => {
        const row = first.rows[0]
        return row ? `${row.employeeName}（${row.positionName || '无岗位'}）` : filters.employeeId
      })()
    : '全部员工'
  const extra: ExportMetaEntry[] = [
    { label: '员工', value: employee },
    { label: '门店', value: filters.storeId ? (first.rows[0]?.storeName ?? filters.storeId) : '范围内全部门店' },
    { label: '提成类型', value: filters.source ? COMMISSION_SOURCE_LABELS[filters.source] : '全部' },
    ...(summary ? [{ label: '明细条数', value: String(summary.count) }] : []),
  ]
  return {
    sheetName: '提成明细',
    columns: toWorkerExportColumns(columns, totals) as unknown as WorkerExportColumn<Row>[],
    rows: (async function* () {
      for await (const row of iterateExportPages<CommissionDetailRow, string>(fetch, first)) yield row as unknown as Row
    })(),
    frozenColumns: countLeftFrozen(columns),
    totalsLabel: `合计（${summary?.count ?? 0} 条）`,
    meta: {
      period: filters.date ? `${filters.date} ~ ${filters.date}` : periodText(first.month),
      scope: first.scopeName,
      extra,
    },
  }
}
