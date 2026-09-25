import { describe, expect, it } from 'vitest'
import { KNOWN_PERMISSION_ACTIONS, getUiDependencyClosure } from '@/lib/permission-contract'
import { DATA_CENTER_TABS } from './params'
import { DATA_CENTER_VIEW_REQUIRED_ACTIONS } from '@/lib/export-job-types'
import { DATA_CENTER_REPORT_LIST, DATA_CENTER_REPORTS } from './reports'

describe('经营明细报表登记表（#367）', () => {
  it('路由唯一、挂在 /data-center 下，且不与 [board] 白名单撞名（旧 4 板块路由不变）', () => {
    const paths = DATA_CENTER_REPORT_LIST.map((report) => report.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) {
      expect(path).toMatch(/^\/data-center\/[a-z-]+(\/[a-z-]+)?$/)
      expect((DATA_CENTER_TABS as readonly string[]).includes(path.split('/')[2]), path).toBe(false)
    }
  })

  it('权限组合都以 data_center:dashboard 打底，专用权限点已登记目录且 UI 依赖 dashboard', () => {
    for (const report of DATA_CENTER_REPORT_LIST) {
      expect(report.requiredActions[0], report.path).toBe('data_center:dashboard')
      for (const action of report.requiredActions) {
        expect(KNOWN_PERMISSION_ACTIONS, action).toContain(action)
        if (action !== 'data_center:dashboard') {
          expect(getUiDependencyClosure(action), action).toContain('data_center:dashboard')
        }
      }
    }
  })

  it('下钻子页的父页存在、与父页权限一致，且不进菜单', () => {
    for (const report of DATA_CENTER_REPORT_LIST.filter((item) => item.parent)) {
      const parent = DATA_CENTER_REPORTS[report.parent as keyof typeof DATA_CENTER_REPORTS]
      expect(parent, `${report.path} 的父页 ${report.parent} 不存在`).toBeDefined()
      expect(report.path.startsWith(`${parent.path}/`), '下钻路由须在父页路径之下（菜单靠前缀匹配高亮父页）').toBe(true)
      expect(report.requiredActions).toEqual(parent.requiredActions)
      expect(report.menu).toBeUndefined()
    }
  })

  it('筛选形态与 #367 约定一致', () => {
    expect(DATA_CENTER_REPORTS.dailyOverview.periodKind).toBe('range')
    expect(DATA_CENTER_REPORTS.remainingCards.periodKind).toBe('none')
    for (const key of ['customerFrequency', 'operatingMaster', 'commissionDaily', 'commissionDetail'] as const) {
      expect(DATA_CENTER_REPORTS[key].periodKind, key).toBe('month')
    }
  })

  it('报表导出视图的权限组合与所属报表页一致（页面 / action / 导出三处同一组常量）', () => {
    expect(DATA_CENTER_VIEW_REQUIRED_ACTIONS['report-remaining-cards']).toEqual(DATA_CENTER_REPORTS.remainingCards.requiredActions)
  })
})
