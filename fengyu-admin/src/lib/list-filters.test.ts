import { describe, it, expect } from 'vitest'
import { parseEmployeeFilters } from './list-filters'

/**
 * parseEmployeeFilters 回归测试 — URL searchParams → EmployeeFilters 单值真源。
 * 覆盖 admin 员工管理列表的 skills 多选（逗号分隔）与 page/size 数字转换。
 */
describe('parseEmployeeFilters', () => {
  it('空 params → 全部 undefined', () => {
    expect(parseEmployeeFilters({})).toEqual({
      marketId: undefined,
      storeId: undefined,
      status: undefined,
      search: undefined,
      skills: undefined,
      page: undefined,
      pageSize: undefined,
    })
  })

  it('skill=美容师 → skills: ["美容师"]', () => {
    expect(parseEmployeeFilters({ skill: '美容师' }).skills).toEqual(['美容师'])
  })

  it('skill=美容师,养生师 → skills: ["美容师","养生师"]', () => {
    expect(parseEmployeeFilters({ skill: '美容师,养生师' }).skills).toEqual([
      '美容师',
      '养生师',
    ])
  })

  it('skill=,,美容师,, → 过滤空段（仅余 "美容师"）', () => {
    expect(parseEmployeeFilters({ skill: ',,美容师,,' }).skills).toEqual([
      '美容师',
    ])
  })

  it('skill=" "（仅空白） → skills: undefined（不返回空数组）', () => {
    // 防御:全空字符串 split 后过滤为空,应归一为 undefined,避免下游产生空数组条件
    expect(parseEmployeeFilters({ skill: '  , , ' }).skills).toBeUndefined()
  })

  it('status=active → "active"', () => {
    expect(parseEmployeeFilters({ status: 'active' }).status).toBe('active')
  })

  it('status=resigned → "resigned"', () => {
    expect(parseEmployeeFilters({ status: 'resigned' }).status).toBe('resigned')
  })

  it('page/size 转 number', () => {
    expect(
      parseEmployeeFilters({ page: '3', size: '50' }),
    ).toMatchObject({ page: 3, pageSize: 50 })
  })

  it('page 空串 → undefined（不返回 NaN）', () => {
    expect(parseEmployeeFilters({ page: '' }).page).toBeUndefined()
  })

  it('market/store/search 透传', () => {
    expect(
      parseEmployeeFilters({
        market: 'market-1',
        store: 'store-1',
        q: '张三',
      }),
    ).toMatchObject({
      marketId: 'market-1',
      storeId: 'store-1',
      search: '张三',
    })
  })
})