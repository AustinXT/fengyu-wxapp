import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PRICE_THRESHOLD_ORDER_TYPE,
  PRICE_THRESHOLD_SALES_CATEGORIES,
  isPriceThresholdEligible,
  parsePriceThreshold,
} from '../commission-threshold'

describe('#379 commission-threshold', () => {
  // admin 前置校验的可配集合必须与 DB CHECK 一字不差：CHECK 更宽 → 页面拦了库能写；更窄 → 页面放行、落库 500
  it('可配集合与 db/schema/commission.ts 的 chk_commission_matrix_price_threshold 一致', () => {
    const schema = readFileSync(resolve(__dirname, '../../../../db/schema/commission.ts'), 'utf8')
    const m = schema.match(/'chk_commission_matrix_price_threshold',\s*sql`([^`]+)`/)
    expect(m).not.toBeNull()
    const check = m![1]
    expect(check).toContain(`\${table.orderType} = '${PRICE_THRESHOLD_ORDER_TYPE}'`)
    const inList = check.match(/\$\{table\.salesCategory\} IN \(([^)]+)\)/)
    expect(inList).not.toBeNull()
    const cats = inList![1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''))
    expect(cats).toEqual([...PRICE_THRESHOLD_SALES_CATEGORIES])
  })

  it('isPriceThresholdEligible', () => {
    expect(isPriceThresholdEligible('服务单', '自销自耗')).toBe(true)
    expect(isPriceThresholdEligible('服务单', '他销自耗')).toBe(true)
    expect(isPriceThresholdEligible('服务单', '他销他耗')).toBe(false)
    expect(isPriceThresholdEligible('服务单', '生态合作')).toBe(false)
    expect(isPriceThresholdEligible('销售单', '自销自耗')).toBe(false)
  })

  it.each([
    ['', { ok: true, value: null }],
    [null, { ok: true, value: null }],
    [' 100 ', { ok: true, value: '100' }],
    ['0', { ok: true, value: '0' }],
    ['49.9', { ok: true, value: '49.9' }],
    ['-1', { ok: false }],
    ['1e3', { ok: false }],
    ['1.005', { ok: false }],
    ['100000000', { ok: false }],
  ] as const)('parsePriceThreshold(%j)', (raw, expected) => {
    expect(parsePriceThreshold(raw)).toMatchObject(expected)
  })
})
