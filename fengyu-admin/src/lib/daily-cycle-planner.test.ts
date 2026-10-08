import { describe, expect, it } from 'vitest'
import { planDailyMonths, inheritedTemplateIds, monthRange } from './daily-cycle-planner'
import { buildDailyPeriod, defaultDailyCyclePattern, validateDailyCyclePattern } from './daily-period-template'

const global = { id: 'global', regionId: null, version: 1, pattern: defaultDailyCyclePattern }
const natural = { start: { monthOffset: 0 as const, day: 1 }, end: { monthOffset: 0 as const, day: 31 }, weeks: [
  { id: 'w1', name: '第1周', start: { monthOffset: 0 as const, day: 1 }, end: { monthOffset: 0 as const, day: 7 } },
  { id: 'w2', name: '第2周', start: { monthOffset: 0 as const, day: 8 }, end: { monthOffset: 0 as const, day: 14 } },
  { id: 'w3', name: '第3周', start: { monthOffset: 0 as const, day: 15 }, end: { monthOffset: 0 as const, day: 21 } },
  { id: 'w4', name: '第4周', start: { monthOffset: 0 as const, day: 22 }, end: { monthOffset: 0 as const, day: 31 } },
] }
const data = () => ({ regions: [{ id: 'market-one-with-a-long-id', name: '市场一' }, { id: 'market-two', name: '市场二' }], templates: [global], overrides: [], periods: [], disabledTemplateIds: [] })

describe('日期规则及月份准备', () => {
  it('三个归属月跨年，拒绝无效月份和范围', () => {
    expect(monthRange('2027-12', 3)).toEqual(['2027-12', '2028-01', '2028-02'])
    expect(() => monthRange('2027-13')).toThrow('有效月份')
    expect(() => monthRange('2027-12', 37)).toThrow('生成范围')
  })
  it('市场专用优先，其余市场沿用总部，跨月及自然月均可展开', () => {
    const input = { ...data(), templates: [global, { ...global, id: 'specific', regionId: 'market-two', pattern: natural }] }
    const rows = planDailyMonths(input, '2028-02', 3, '2027-12-01')
    expect(rows).toHaveLength(6)
    expect(rows.every(r => r.action === 'create')).toBe(true)
    expect(rows[0].period?.start).toBe('2028-01-26')
    expect(rows[3].period?.end).toBe('2028-02-29')
    expect(rows[3].source).toBe('region-template')
  })
  it('停用市场规则真正继承总部，原月份例外不删除且不误应用于总部模板', () => {
    const input = { ...data(), templates: [global, { ...global, id: 'specific', regionId: 'market-two', pattern: natural }], disabledTemplateIds: ['specific'],
      overrides: [{ templateId: 'specific', regionId: 'market-two', monthKey: '2028-02', pattern: natural }] }
    const rows = planDailyMonths(input, '2028-02', 1, '2027-12-01')
    expect(rows[1].period?.start).toBe('2028-01-26')
    expect(rows[1].source).toBe('global-template')
    expect(input.overrides).toHaveLength(1)
  })
  it('月份例外只覆盖指定市场和月份，下个月仍使用长期规则', () => {
    const special = structuredClone(defaultDailyCyclePattern)
    special.weeks[0].end.day = 5; special.weeks[1].start.day = 6
    const rows = planDailyMonths({ ...data(), overrides: [{ templateId: 'global', regionId: 'market-two', monthKey: '2028-02', pattern: special }] }, '2028-02', 3, '2027-12-01')
    expect(rows[0].period?.weeks[0].end).toBe('2028-02-02')
    expect(rows[3].period?.weeks[0].end).toBe('2028-02-05')
    expect(rows[4].period?.weeks[0].end).toBe('2028-03-02')
  })
  it('保留旧全局安排及原编号，不拆分同月、不覆盖旧目标所在周期', () => {
    const legacy = { ...buildDailyPeriod('2026-10', defaultDailyCyclePattern, 'old'), version: 1, regionId: null, monthKey: null }
    const rows = planDailyMonths({ ...data(), periods: [legacy] }, '2026-10', 1, '2026-10-07')
    expect(rows.every(r => r.action === 'keep' && r.period?.id === 'old')).toBe(true)
  })
  it('重复准备保留原编号，长期规则变化仅标记差异', () => {
    const existing = { ...buildDailyPeriod('2028-02', natural, 'saved'), regionId: 'market-two', monthKey: '2028-02', version: 3 }
    const rows = planDailyMonths({ ...data(), periods: [existing] }, '2028-02', 1, '2027-12-01')
    expect(rows[1]).toMatchObject({ action: 'keep', ruleChanged: true, period: { id: 'saved', version: 3 } })
  })
  it('市场不同规则不能遮蔽旧全局周期，边界有空档必须阻止', () => {
    const legacy = { ...buildDailyPeriod('2026-10', defaultDailyCyclePattern, 'old'), regionId: null, monthKey: null, version: 1 }
    const rows = planDailyMonths({ ...data(), periods: [legacy], templates: [global, { ...global, id: 'specific', regionId: 'market-two', pattern: natural }] }, '2026-11', 1, '2026-10-07')
    expect(rows[0].action).toBe('create')
    expect(rows[1]).toMatchObject({ action: 'blocked', reason: expect.stringContaining('不连续') })
  })
  it('没有规则、已开始月份、非法周日期均阻止新建', () => {
    expect(planDailyMonths({ ...data(), templates: [] }, '2028-02', 1, '2027-12-01')[0].action).toBe('blocked')
    expect(planDailyMonths(data(), '2026-10', 1, '2026-10-07')[0].reason).toContain('尚未开始')
    const invalid = structuredClone(global); invalid.pattern.weeks[1].start.day = 5
    expect(planDailyMonths({ ...data(), templates: [invalid] }, '2028-02', 1, '2027-12-01')[0].reason).toContain('连续')
  })
  it('长期规则验证普通年、闰年及跨年；拒绝经营月之间的空档', () => {
    expect(() => validateDailyCyclePattern(defaultDailyCyclePattern)).not.toThrow()
    expect(() => validateDailyCyclePattern(natural)).not.toThrow()
    const invalid = structuredClone(defaultDailyCyclePattern); invalid.end.day = 24; invalid.weeks[3].end.day = 24
    expect(() => validateDailyCyclePattern(invalid)).toThrow('相邻经营月')
  })
  it('继承元数据只接受列表，配置损坏时拒绝生成', () => {
    expect(inheritedTemplateIds(null)).toEqual([])
    expect(inheritedTemplateIds('["template-one"]')).toEqual(['template-one'])
    expect(() => inheritedTemplateIds('{}')).toThrow('配置损坏')
  })
})

it('批量显式更新旧未来月份时，新月份按更新后的边界校验',()=>{
 const old={...buildDailyPeriod('2028-02',natural,'saved'),regionId:'market-two',monthKey:'2028-02',version:1}
 const input={...data(),periods:[old]}
 expect(planDailyMonths(input,'2028-02',2,'2027-12-01')[3].action).toBe('blocked')
 const rows=planDailyMonths({...input,updateUnused:true},'2028-02',2,'2027-12-01')
 expect(rows[2].ruleChanged).toBe(true)
 expect(rows[3].action).toBe('create')
})
