import { describe, expect, it } from 'vitest'
import { basePeriodLabel, basePeriodTitle, MOM_BASE_PERIOD_LABEL } from './base-period'
import { basePeriodTitle as exportBasePeriodTitle, completeExportMeta } from '@/export-worker/export-meta'

describe('#296 基期格式与标签同源', () => {
  it('页面环比/较上期均用环比基期，导出说明同名', () => {
    expect(exportBasePeriodTitle).toBe(basePeriodTitle)
    const range = { start: '2026-08-01', end: '2026-08-22' }
    expect(basePeriodTitle('环比', range)).toBe('环比基期：2026-08-01 ~ 2026-08-22（22 天）')
    expect(basePeriodTitle('较上期', range)).toBe(basePeriodTitle('环比', range))
    expect(basePeriodLabel('较上期')).toBe(MOM_BASE_PERIOD_LABEL)
    const entries = completeExportMeta({ period: '2026-09', scope: '全部', basePeriod: `${range.start} ~ ${range.end}` }, { generatedAt: new Date(0), exporterName: 'a' })!
    expect(entries[2].label).toBe(MOM_BASE_PERIOD_LABEL)
  })
  it('同比保留同比基期；缺区间不输出，单日/跨闰日含首尾；非法跨度不写NaN', () => {
    expect(basePeriodTitle('同比', { start: '2024-02-28', end: '2024-03-01' })).toBe('同比基期：2024-02-28 ~ 2024-03-01（3 天）')
    expect(basePeriodTitle('环比', { start: '2026-09-01', end: '2026-09-01' })).toContain('（1 天）')
    expect(basePeriodTitle('环比', null)).toBeUndefined()
    expect(basePeriodTitle('环比', { start: 'invalid', end: 'invalid' })).toBe('环比基期：invalid ~ invalid')
  })
})
