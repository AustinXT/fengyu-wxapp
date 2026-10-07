'use server'

import { and, asc, eq, ilike, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@/db'
import { dailyReportEntries, dailyReports } from '@db/daily-report'
import { orgNodes, stores } from '@db/org'
import { staffWechatUsers } from '@db/user'
import { withPermission } from '@/lib/with-permission'
import { scopeCondition } from '@/lib/permissions'
import { validateScope } from '@/lib/data-center/context'
import { isValidCalendarDate } from '@/lib/calendar-date'
import { shanghaiToday } from '@/lib/data-center/time-range'
import { employeeMetricSnapshot, type DailyReportSummaryRow } from '@/lib/data-center/daily-report-summary'
import type { DataCenterScope } from '@/lib/data-center/types'

export interface DailyReportSummaryFilters {
  date: string
  scope: DataCenterScope
  employeeSearch?: string
}

const marketNode = alias(orgNodes, 'daily_report_market')
const storeNode = alias(orgNodes, 'daily_report_store_node')

export const getDailyReportSummary = withPermission(
  'data_center:dashboard',
  async (session, filters: DailyReportSummaryFilters): Promise<DailyReportSummaryRow[]> => {
    if (!filters || !isValidCalendarDate(filters.date) || filters.date > shanghaiToday()) {
      throw new Error('INVALID_PARAMS: 请选择有效的日报日期')
    }
    const employeeSearch = filters.employeeSearch?.trim().slice(0, 50) ?? ''
    await validateScope(session, filters.scope)
    const conditions = [
      eq(dailyReports.status, 'submitted'),
      eq(dailyReports.reportDate, filters.date),
      scopeCondition(session, dailyReports.storeId),
      filters.scope.type === 'all'
        ? undefined
        : filters.scope.type === 'authorized'
          ? session.permissions.scopeStoreIds.length
            ? inArray(dailyReports.storeId, session.permissions.scopeStoreIds)
            : eq(dailyReports.storeId, '__no_authorized_store__')
          : filters.scope.type === 'market'
            ? eq(marketNode.id, filters.scope.id)
            : filters.scope.type === 'store'
              ? eq(dailyReports.storeId, filters.scope.id)
              : inArray(dailyReports.storeId, filters.scope.ids),
      employeeSearch ? ilike(dailyReports.employeeName, `%${employeeSearch}%`) : undefined,
    ]
    const rows = await db
      .select({
        id: dailyReports.id,
        reportDate: dailyReports.reportDate,
        employeeId: dailyReports.employeeId,
        employeeName: dailyReports.employeeName,
        positionName: staffWechatUsers.positionName,
        storeId: dailyReports.storeId,
        storeName: dailyReports.storeName,
        marketId: marketNode.id,
        marketName: marketNode.name,
        submittedAt: dailyReports.submittedAt,
        action: dailyReports.action,
        growth: dailyReports.growth,
        plan: dailyReports.plan,
        mentorEmployeeId: dailyReports.mentorEmployeeId,
        peerEmployeeId: dailyReports.peerEmployeeId,
        metricSnapshot: dailyReports.metricSnapshot,
      })
      .from(dailyReports)
      .innerJoin(stores, eq(stores.storeId, dailyReports.storeId))
      .innerJoin(storeNode, eq(storeNode.id, stores.orgNodeId))
      .leftJoin(marketNode, eq(marketNode.id, storeNode.parentId))
      .leftJoin(staffWechatUsers, eq(staffWechatUsers.employeeId, dailyReports.employeeId))
      .where(and(...conditions))
      .orderBy(asc(marketNode.name), asc(dailyReports.storeName), asc(dailyReports.employeeName))

    if (rows.length === 0) return []
    const entries = await db
      .select({
        reportId: dailyReportEntries.reportId,
        businessType: dailyReportEntries.businessType,
        businessId: dailyReportEntries.businessId,
        snapshot: dailyReportEntries.snapshot,
        feedback: dailyReportEntries.feedback,
        followUp: dailyReportEntries.followUp,
      })
      .from(dailyReportEntries)
      .where(inArray(dailyReportEntries.reportId, rows.map((row) => row.id)))
      .orderBy(asc(dailyReportEntries.businessType), asc(dailyReportEntries.businessId))

    const byReport = new Map<string, DailyReportSummaryRow['entries']>()
    for (const entry of entries) {
      const list = byReport.get(entry.reportId) ?? []
      list.push({
        businessType: entry.businessType === 'service' ? 'service' : 'sale',
        businessId: entry.businessId,
        snapshot: entry.snapshot as Record<string, unknown>,
        feedback: entry.feedback,
        followUp: entry.followUp,
      })
      byReport.set(entry.reportId, list)
    }

    return rows.map((row) => ({
      ...row,
      reportDate: String(row.reportDate),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      action: row.action ?? '',
      growth: row.growth ?? '',
      plan: row.plan ?? '',
      marketId: row.marketId ?? null,
      marketName: row.marketName ?? null,
      positionName: row.positionName ?? '',
      metrics: employeeMetricSnapshot(row.metricSnapshot),
      entries: byReport.get(row.id) ?? [],
    }))
  },
)
