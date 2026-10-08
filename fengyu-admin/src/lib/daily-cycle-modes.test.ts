import { describe, it, expect } from 'vitest'
import { cycleModesInput, readCycleModes, patternSignature } from './daily-cycle-modes'
import { defaultDailyCyclePattern as pattern } from './daily-period-template'

const base = { id: 'default', name: '总部标准', isDefault: true, regionIds: [], pattern }
const shared = { id: 'shared', name: '市场共用', isDefault: false, regionIds: ['a', 'b'], pattern }
describe('周期模式分组', () => {
  it('数据库JSON键顺序不影响规则匹配，保留共同模式', () => {
    const reordered = JSON.parse(JSON.stringify(pattern, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value))
    expect(patternSignature(reordered)).toBe(patternSignature(pattern))
    const modes = readCycleModes([{ id: 'ta', name: shared.name, regionId: 'a', pattern: reordered }, { id: 'tb', name: shared.name, regionId: 'b', pattern: reordered }], [], ['a', 'b'], JSON.stringify([base, shared]))
    expect(modes.find(m => m.id === 'shared')?.regionIds).toEqual(['a', 'b'])
  })
  it('已恢复总部的市场不再显示为特殊模式成员', () => {
    expect(readCycleModes([{ id: 'ta', name: shared.name, regionId: 'a', pattern }], ['ta'], ['a', 'b'], JSON.stringify([base, shared]))[1].regionIds).toEqual([])
  })
  it('旧入口修改规则后按真实规则重新展示', () => {
    const changed = structuredClone(pattern); changed.weeks[0].end.day = 5; changed.weeks[1].start.day = 6
    const modes = readCycleModes([{ id: 'ta', name: shared.name, regionId: 'a', pattern: changed }], [], ['a'], JSON.stringify([base, shared]))
    expect(modes.find(m => m.regionIds.includes('a'))?.pattern).toEqual(changed)
    expect(cycleModesInput.safeParse(modes).success).toBe(true)
  })
  it('同一市场不可同时分配给两套模式', () => {
    expect(cycleModesInput.safeParse([base, shared, { ...shared, id: 'other', name: '其他' }]).success).toBe(false)
  })
})

import { resolveCycleMode, upgradeCycleModes } from './daily-cycle-modes'
it('生效前沿用旧版本，生效后按市场模式及按月配置取数', () => {
  const one = { ...pattern, weeks: [{ id: 'only', name: '整月', start: pattern.start, end: pattern.end }] }
  const future = { ...shared, effectiveFrom: '2040-01-01', monthly: { '2040-02': one } }
  const revisions = [{ validFrom: '0001-01-01', modes: [base] }, { validFrom: '2026-10-07', modes: [base, future] }]
  expect(resolveCycleMode(revisions, 'a', '2040-01')?.mode.id).toBe('default') // 首日在2039-12-26，未到生效日
  expect(resolveCycleMode(revisions, 'a', '2040-02')?.pattern.weeks).toHaveLength(1)
  expect(resolveCycleMode(revisions, 'b', '2040-03')?.mode.id).toBe('shared')
  expect(resolveCycleMode(revisions, 'other', '2040-03')?.mode.id).toBe('default')
})
it('升级保留旧市场的月份例外，差异例外不扩散到其他市场', () => {
  const single = { ...pattern, weeks: [{ id: 'only', name: '整月', start: pattern.start, end: pattern.end }] }
  const modes = upgradeCycleModes([{ id: 'global', name: '总部', regionId: null, pattern }], [], ['a', 'b'], [{ templateId: 'global', regionId: 'a', monthKey: '2040-01', pattern: single }])
  expect(modes.find(m => m.regionIds.includes('a'))?.monthly?.['2040-01'].weeks).toHaveLength(1)
  expect(modes.find(m => m.isDefault)?.monthly).toEqual({})
  expect(cycleModesInput.safeParse(modes).success).toBe(true)
})
