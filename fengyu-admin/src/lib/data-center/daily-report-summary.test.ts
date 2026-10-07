import { describe, expect, it } from 'vitest'
import {
  dailyReportSummaryExportRows,
  employeeMetricSnapshot,
  type DailyReportSummaryRow,
} from './daily-report-summary'

const report: DailyReportSummaryRow = {
  id: 'r1', reportDate: '2026-10-06', employeeId: 'e1', employeeName: '张三',
  positionName: '美容师', storeId: 's1', storeName: '示例门店', marketId: 'm1', marketName: '示例区域',
  submittedAt: '2026-10-06T10:00:00.000Z', action: '跟进顾客', growth: '学习手法', plan: '复盘服务',
  mentorEmployeeId: 'e2', peerEmployeeId: 'e3',
  metrics: { date: '2026-10-06', day: { sales: 12500, consumption: 8000, visits: 4, newCustomers: 1, projects: 3 }, week: null, month: null, periodName: null, weekName: null, savedAt: null },
  entries: [{ businessType: 'service', businessId: 'svc-1', snapshot: { title: '护理服务', businessDate: '2026-10-06' }, feedback: '顾客反馈很好', followUp: '下周回访' }],
}

describe('员工日报汇总数据', () => {
  it('只读取快照中的个人指标，不泄露门店或区域汇总', () => {
    expect(employeeMetricSnapshot({
      date: '2026-10-06', scopes: {
        personal: { day: { sales: 12500, visits: 4 }, week: null, month: null },
        store: { day: { sales: 999999, visits: 999 } },
        market: { day: { sales: 888888, visits: 888 } },
      },
    })).toMatchObject({ day: { sales: 12500, visits: 4 }, week: null, month: null })
    expect(employeeMetricSnapshot({ scopes: { store: { day: { sales: 999 } } } })).toBeNull()
  })

  it('导出概览和业务反馈两类完整内容，金额由分转元并防止公式注入', () => {
    const rows = dailyReportSummaryExportRows([{ ...report, action: '=HYPERLINK("x")' }])
    expect(rows.overview[0]).toMatchObject({
      员工: '张三', 当日业绩: 125, 当日消耗: 80, 当日客量: 4,
      今日行动: "'=HYPERLINK(\"x\")", 今日成长: '学习手法', 明日计划: '复盘服务',
    })
    expect(rows.business[0]).toMatchObject({
      业务类型: '服务', 业务日期: '2026-10-06', 顾客及业务: '护理服务',
      反馈: '顾客反馈很好', 后续跟进: '下周回访',
    })
  })
})
