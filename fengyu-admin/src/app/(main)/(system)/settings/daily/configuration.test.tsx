import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DailyConfiguration from './configuration'

vi.mock('@/actions/daily-config', () => ({
  getDailyConfiguration: vi.fn(), previewDailyPeriod: vi.fn(), saveDailyPeriod: vi.fn(), saveDailyPk: vi.fn(),
  createDailyPeriodsForMonth: vi.fn(), saveDailyPeriodTemplate: vi.fn(),
}))

const initial = { periods: [], templates: [], overrides: [], periodStores: [], regions: [], classes: [], assignments: [], stores: [], members: [], logs: [] }

beforeEach(() => {
  // HTTP IP 地址上的 Crypto 只有 getRandomValues，没有 randomUUID。
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('HTTP 环境下空配置可以打开周期模板编辑', () => {
  render(<DailyConfiguration initial={initial} />)
  expect(screen.getByText('周期模板')).toBeVisible()
  expect(screen.getByLabelText('周期模板名称')).toHaveValue('默认经营周期')
})

it('HTTP 环境下已有经营月可以添加多个 PK 班级', () => {
  const period = { id: 'p1', name: '十月', start: '2026-10-01', end: '2026-10-28', regionId: null, monthKey: null, templateId: null, templateSource: 'legacy', version: 1,
    weeks: [1, 2, 3, 4].map(n => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) }
  render(<DailyConfiguration initial={{ ...initial, periods: [period], stores: [{ id: 's1', name: '测试门店', orgNodeId: null, area: '' }] }} />)
  fireEvent.click(screen.getByRole('tab', { name: 'PK 班级' }))
  fireEvent.click(screen.getByRole('button', { name: '添加班级' }))
  fireEvent.click(screen.getByRole('button', { name: '添加班级' }))
  expect(screen.getByLabelText('班级 1')).toBeVisible()
  expect(screen.getByLabelText('班级 2')).toBeVisible()
  expect(screen.getByLabelText('测试门店班级').querySelectorAll('option')).toHaveLength(3)
})

it('门店指导员候选覆盖所有在职员工，输入框可直接键入搜索姓名', () => {
  const period = { id: 'p1', name: '十月', start: '2026-10-01', end: '2026-10-28', regionId: null, monthKey: null, templateId: null, templateSource: 'legacy', version: 1,
    weeks: [1, 2, 3, 4].map(n => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) }
  render(<DailyConfiguration initial={{ ...initial, periods: [period],
    classes: [{ id: 'c1', name: '一班', periodId: 'p1' }],
    assignments: [{ periodId: 'p1', storeId: 's1', classId: 'c1', legion: '', groupName: '', mentorName: '' }],
    stores: [{ id: 's1', name: '测试门店', orgNodeId: null, area: '测试区域' }],
    members: [
      { id: 'e1', name: '张三', storeId: 's1', position: '美容师' },
      { id: 'e2', name: '李四', storeId: 's2', position: '区域总监' },
    ],
  }} />)
  fireEvent.click(screen.getByRole('tab', { name: 'PK 班级' }))
  const input = screen.getByLabelText('测试门店mentorName')
  expect(input).toHaveAttribute('list', 'daily-mentors-s1')
  expect(document.querySelector('#daily-mentors-s1 option[value="李四"]')).toHaveAttribute('label', '区域总监 · 未分配门店')
  fireEvent.change(input, { target: { value: '李四' } })
  expect(input).toHaveValue('李四')
})
