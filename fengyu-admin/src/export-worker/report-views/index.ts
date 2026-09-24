/**
 * 经营明细报表（report-*）导出视图 → 处理函数。`Record` 让新登记的报表视图漏配处理函数时 tsc 即报错；
 * registry.ts 的 queryDataCenter 先查这里、再走板块前缀分发（见其注释）。
 *
 * 各页面的处理函数放在本目录下各自的文件里，并行开发时只在这张表上各加一行。
 */
import type { DataCenterReportExportView, ExportQueryPayload } from '@/lib/export-job-types'
import type { ExportContent } from '../registry'
import { commissionDailyExport, commissionDetailExport } from './commission'

export const DATA_CENTER_REPORT_EXPORT_HANDLERS: Record<
  DataCenterReportExportView,
  (params: ExportQueryPayload) => Promise<ExportContent>
> = {
  'report-commission-daily': commissionDailyExport,
  'report-commission-detail': commissionDetailExport,
}
