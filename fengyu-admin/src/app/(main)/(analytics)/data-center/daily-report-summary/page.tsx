import { getDataCenterScopeOptions } from '@/actions/data-center/shared'
import { getDailyReportSummary } from '@/actions/data-center/daily-report-summary'
import { firstQueryValue } from '@/lib/data-center/params'
import { isValidCalendarDate } from '@/lib/calendar-date'
import { shanghaiToday } from '@/lib/data-center/time-range'
import { DATA_CENTER_REPORTS } from '@/lib/data-center/reports'
import { prepareReport } from '../_components/report/prepare-report'
import { ReportLayout } from '../_components/report/report-layout'
import { DailyReportSummaryView } from './view'

export const dynamic = 'force-dynamic'

const REPORT = DATA_CENTER_REPORTS.dailyReportSummary

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = await searchParams
  const { scopeOptions, context } = await prepareReport({
    report: REPORT,
    query,
    loadScopeOptions: getDataCenterScopeOptions,
    axes: [],
  })
  const requestedDate = firstQueryValue(query.date)
  const date = requestedDate && isValidCalendarDate(requestedDate) && requestedDate <= context.today
    ? requestedDate
    : context.today
  const employeeSearch = firstQueryValue(query.employee) ?? ''
  const reports = context.scope
    ? await getDailyReportSummary({ date, scope: context.scope, employeeSearch })
    : []

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      infoItems={context.scope ? [{ label: '已提交日报', value: `${reports.length} 份` }] : []}
    >
      {context.scope && <DailyReportSummaryView date={date} today={context.today} employeeSearch={employeeSearch} reports={reports} />}
    </ReportLayout>
  )
}
