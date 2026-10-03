import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('@/actions/operating-targets', () => ({
  getOperatingProgress: vi.fn(),
  getOperatingPk: vi.fn(),
  getOwnOperatingTarget: vi.fn(),
  saveOwnOperatingTarget: vi.fn(),
}))
vi.mock('@/actions/export-jobs', () => ({ createExportJob: vi.fn() }))
import {
  getOwnOperatingTarget,
  saveOwnOperatingTarget,
} from '@/actions/operating-targets'
import { OperatingView } from './view'
import { TargetEntry } from '../operating-targets/view'
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const date = (n: number) =>
  new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000)
    .toISOString()
    .slice(0, 10)
const period = {
  id: '202610',
  name: '202610',
  start: today,
  end: date(27),
  version: 1,
  weeks: [0, 1, 2, 3].map((i) => ({
    id: 'w' + (i + 1),
    name: '第' + (i + 1) + '周',
    start: date(i * 7),
    end: date(i * 7 + 6),
  })),
}
const values = Object.fromEntries(
  ['sales', 'consumption', 'visits', 'newCustomers', 'projects'].map((k) => [
    k,
    {
      monthTarget: k === 'projects' ? null : k === 'newCustomers' ? 0 : 10000,
      monthDone: 2000,
      weekTarget: 5000,
      weekDone: 1000,
      days: [{ date: today, done: 1000 }],
      weeks: period.weeks.map((w) => ({ id: w.id, done: 1000 })),
    },
  ]),
)
const progress: any = {
  filters: {},
  canConfigure: false,
  periods: [period],
  period,
  week: period.weeks[0],
  regions: [],
  stores: [],
  classes: [],
  rows: [
    {
      scope: 'personal',
      scopeId: 'u1',
      name: '测试员工',
      scopeName: '测试员工',
      values,
    },
  ],
  ownScopes: [],
}
const goal: any = {
  periods: [period],
  period,
  week: period.weeks[0],
  scope: { scope: 'personal', scopeId: 'u1' },
  scopes: [{ scope: 'personal', scopeId: 'u1', name: '我的目标' }],
  target: {
    sales: 2000000,
    consumption: 1005000,
    month_confirmed: true,
    counts_month_confirmed: false,
    penalty: '认真复盘',
    version: 2,
    weeks: {},
  },
}
describe('经营目标页面', () => {
  it('计数零不标未达成，缺目标显示未设置，月表显示四周', () => {
    render(<OperatingView initial={progress} />)
    fireEvent.change(screen.getByLabelText('指标'), {
      target: { value: 'newCustomers' },
    })
    fireEvent.click(screen.getByText('月成果表'))
    expect(screen.getByText('不计算完成率')).toBeInTheDocument()
    expect(screen.getByText('第4周')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('指标'), {
      target: { value: 'projects' },
    })
    expect(screen.getAllByText('未设置')).toHaveLength(2)
    expect(screen.queryByText('周期与分班配置')).not.toBeInTheDocument()
  })
  it('旧金额只读，三项补充需整数且提交完整五项', async () => {
    vi.mocked(getOwnOperatingTarget).mockResolvedValue(goal)
    window.confirm = vi.fn(() => true)
    render(<TargetEntry initial={goal} />)
    expect(screen.getByLabelText('月业绩目标')).toBeDisabled()
    for (const [label, value] of [
      ['月客量目标', '10'],
      ['月新客目标', '0'],
      ['月项目数目标', '12'],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.change(screen.getByLabelText('月客量目标'), {
      target: { value: '1.5' },
    })
    expect(screen.getByText('补充确认三项月目标')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('月客量目标'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByText('补充确认三项月目标'))
    await waitFor(() =>
      expect(saveOwnOperatingTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          sales: '20000.00',
          consumption: '10050.00',
          visits: '10',
          newCustomers: '0',
          projects: '12',
          version: 2,
        }),
      ),
    )
  })
  it('保存可供视觉检查的三页静态预览', () => {
    mkdirSync('../_tmp/daily-five-web', { recursive: true })
    for (const [name, element] of [
      ['progress', <OperatingView initial={progress} />],
      ['pk', <OperatingView initial={progress} pk />],
      ['targets', <TargetEntry initial={goal} />],
    ] as const) {
      writeFileSync(
        '../_tmp/daily-five-web/' + name + '.html',
        '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./preview.css"><body>' +
          renderToStaticMarkup(element) +
          '</body></html>',
      )
    }
  })
})
