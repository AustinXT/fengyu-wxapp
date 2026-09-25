/**
 * 经营明细报表的导出内容构造：顾客剩余卡项清单（#371）、顾客频率表（#370）。
 * 由 registry.ts 的 `queryReport` 按视图名精确分派（报表视图先于旧板块前缀分发）。
 *
 * 取数一律调用页面同源的 Server Action（withAllPermissions 在导出人的权限快照下再过一次闸门），
 * 列定义用 lib/data-center/matrix-export.ts 从页面列骨架转换，表头 / 合计与页面不漂移。
 */
import { exportRemainingCardsReport } from '@/actions/data-center/remaining-cards'
import { resolveScopeName } from '@/lib/data-center/context'
import { countLeftFrozen, toWorkerExportColumns } from '@/lib/data-center/matrix-export'
import { displaySearchTerm, remainingCardsColumnSpecs } from '@/lib/data-center/remaining-cards'
import { exportCustomerFrequencyReport } from '@/actions/data-center/customer-frequency'
import { frequencyExportColumnSpecs } from '@/lib/data-center/customer-frequency'
import { isValidMonth } from '@/lib/data-center/report-period'
import { shanghaiToday } from '@/lib/data-center/time-range'
import type { DataCenterScope } from '@/lib/data-center/types'
import type { ExportContent } from './registry'

type Row = Record<string, unknown>

async function scopeMetaLabel(scope: DataCenterScope): Promise<string> {
  const name = await resolveScopeName(scope)
  if (scope.type === 'market') return `市场 · ${name}`
  if (scope.type === 'store') return `门店 · ${name}`
  return name
}

async function* fromArray<T>(rows: readonly T[]): AsyncIterable<T> {
  for (const row of rows) yield row
}

export async function remainingCardsContent(params: Record<string, string>): Promise<ExportContent> {
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

/** 顾客频率表（#370）导出：registry.ts `queryReport` 按视图名 `report-customer-frequency` 分派到这里 */
export async function customerFrequencyContent(params: Record<string, string>): Promise<ExportContent> {
  // 与主表同一纪律：页面导出时已钉住生效月份；拿不到月份宁可失败，也不按执行当天的「上月」出数
  if (!isValidMonth(params.month)) throw new Error('INVALID_PARAMS: 导出缺少统计月份')
  // 未来月份在 parseReportMonth 里会回落成「上月」：伪造的导出参数不能借此导出一个与 payload 不符的月份
  if (params.month > shanghaiToday().slice(0, 7)) throw new Error('INVALID_PARAMS: 不能导出未来月份')
  const report = await exportCustomerFrequencyReport(params)
  const specs = frequencyExportColumnSpecs(report.params.month)
  return {
    sheetName: '顾客频率表',
    // ExportContent 的行类型是宽松的 Record；列取值函数只会收到本函数产出的行
    columns: toWorkerExportColumns(specs, report.totals) as unknown as ExportContent['columns'],
    rows: fromArray(report.rows as unknown as Row[]),
    frozenColumns: countLeftFrozen(specs),
    totalsLabel: '合计',
    meta: {
      period: `${report.params.range.start} ~ ${report.params.range.end}（${report.params.monthLabel}）`,
      scope: await scopeMetaLabel(report.params.scope),
      extra: [
        { label: '显示范围', value: report.params.show === 'visited' ? '只看有到店' : '全部顾客' },
        ...(report.params.searchLabel ? [{ label: '顾客搜索', value: report.params.searchLabel }] : []),
        { label: '日期格', value: '每日拆「到店 / 金额」两列：到店写 ✓；金额为当日消费净额（按款项归属日期，退款为负）' },
      ],
    },
  }
}
