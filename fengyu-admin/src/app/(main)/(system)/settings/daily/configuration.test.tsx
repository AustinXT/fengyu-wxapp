import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DailyConfiguration from './configuration'

vi.mock('@/actions/daily-config', () => ({
  getDailyConfiguration: vi.fn(), previewDailyPeriod: vi.fn(), saveDailyPeriod: vi.fn(), saveDailyPk: vi.fn(),
}))

const initial = { periods: [], classes: [], assignments: [], stores: [], members: [], logs: [] }

beforeEach(() => {
  // HTTP IP 地址上的 Crypto 只有 getRandomValues，没有 randomUUID。
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('HTTP 环境下空配置可以打开、填写并新建经营月', () => {
  render(<DailyConfiguration initial={initial} />)
  expect(screen.getByText('新建经营周期')).toBeVisible()
  fireEvent.change(screen.getByLabelText('月份名称'), { target: { value: '十月' } })
  expect(screen.getByLabelText('月份名称')).toHaveValue('十月')
  fireEvent.click(screen.getByRole('button', { name: '新增经营月' }))
  expect(screen.getByLabelText('月份名称')).toHaveValue('')
})

it('HTTP 环境下已有经营月可以添加多个 PK 班级', () => {
  const period = { id: 'p1', name: '十月', start: '2026-10-01', end: '2026-10-28', version: 1,
    weeks: [1, 2, 3, 4].map(n => ({ id: 'w' + n, name: '第' + n + '周', start: '', end: '' })) }
  render(<DailyConfiguration initial={{ ...initial, periods: [period], stores: [{ id: 's1', name: '测试门店', orgNodeId: null, area: '' }] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'PK 班级' }))
  fireEvent.click(screen.getByRole('button', { name: '添加班级' }))
  fireEvent.click(screen.getByRole('button', { name: '添加班级' }))
  expect(screen.getByLabelText('班级 1')).toBeVisible()
  expect(screen.getByLabelText('班级 2')).toBeVisible()
  expect(screen.getByLabelText('测试门店班级').querySelectorAll('option')).toHaveLength(3)
})
