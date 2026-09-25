/**
 * 经营明细报表（#367 起）的导出取数。每个报表视图在这里登记一个取数函数；
 * registry.ts 的 queryDataCenter **先**按 `isDataCenterReportView` 分派到这里，再走旧板块的前缀分发。
 *
 * 取数一律调用页面同源的 Server Action（withAllPermissions 在导出人的权限快照下再过一次闸门），
 * 列定义用 lib/data-center/matrix-export.ts 从页面列骨架转换，表头 / 合计与页面不漂移。
 */
import { exportRemainingCardsReport } from '@/actions/data-center/remaining-cards'
import { resolveScopeName } from '@/lib/data-center/context'
import { countLeftFrozen, toWorkerExportColumns } from '@/lib/data-center/matrix-export'
import { displaySearchTerm, remainingCardsColumnSpecs } from '@/lib/data-center/remaining-cards'
import type { DataCenterScope } from '@/lib/data-center/types'
import {
  DATA_CENTER_REPORT_EXPORT_VIEWS,
  type DataCenterExportPayload,
} from '@/lib/export-job-types'
import type { ExportContent } from './registry'

type Row = Record<string, unknown>

export type DataCenterReportExportView = (typeof DATA_CENTER_REPORT_EXPORT_VIEWS)[number]

const REPORT_VIEWS: ReadonlySet<string> = new Set(DATA_CENTER_REPORT_EXPORT_VIEWS)

export function isDataCenterReportView(view: string): view is DataCenterReportExportView {
  return REPORT_VIEWS.has(view)
}

async function scopeMetaLabel(scope: DataCenterScope): Promise<string> {
  const name = await resolveScopeName(scope)
  if (scope.type === 'market') return `市场 · ${name}`
  if (scope.type === 'store') return `门店 · ${name}`
  return name
}

async function* fromArray<T>(rows: readonly T[]): AsyncIterable<T> {
  for (const row of rows) yield row
}

async function remainingCardsContent(params: Record<string, string>): Promise<ExportContent> {
  const report = await exportRemainingCardsReport(params)
  const specs = remainingCardsColumnSpecs(report.columns)
  return {
    sheetName: '顾客剩余卡项清单',
    // ExportContent 的行类型是宽松的 Record；列取值函数只会收到本函数产出的行
    columns: toWorkerExportColumns(specs, report.totals) as unknown as ExportContent['columns'],
    rows: fromArray(report.rows as unknown as Row[]),
    frozenColumns: countLeftFrozen(specs),
    totalsLabel: '合计',
    meta: {
      period: null,
      scope: await scopeMetaLabel(report.params.scope),
      extra: [
        { label: '快照日', value: report.asOf },
        { label: '显示范围', value: report.params.show === 'remaining' ? '只看有剩余' : '全部顾客' },
        ...(report.params.q ? [{ label: '顾客搜索', value: displaySearchTerm(report.params.q) }] : []),
      ],
    },
  }
}

const REPORT_CONTENT: Record<DataCenterReportExportView, (params: Record<string, string>) => Promise<ExportContent>> = {
  'report-remaining-cards': remainingCardsContent,
}

export function queryDataCenterReport(
  payload: DataCenterExportPayload & { view: DataCenterReportExportView },
): Promise<ExportContent> {
  return REPORT_CONTENT[payload.view](payload.params)
}
