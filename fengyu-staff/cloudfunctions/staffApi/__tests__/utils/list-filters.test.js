const {
  normalizeListFilters,
  addTimestampDateRange,
  addDateRange,
} = require('../../utils/list-filters')

describe('list-filters', () => {
  test('规范化分页、关键词和手机号', () => {
    expect(normalizeListFilters({
      page: '2',
      pageSize: '20',
      keyword: '  138-1234  ',
    })).toMatchObject({
      page: 2,
      pageSize: 20,
      offset: 20,
      keyword: '138-1234',
      phoneKeyword: '1381234',
    })
  })

  test('LIKE 通配符按字面量转义', () => {
    expect(normalizeListFilters({ keyword: '张_%' }).keywordPattern).toBe('%张\\_\\%%')
  })

  test.each([
    [{ startDate: '2026-02-30' }, /INVALID_PARAMS.*startDate/],
    [{ endDate: '26-08-01' }, /INVALID_PARAMS.*endDate/],
    [{ startDate: '2026-08-27', endDate: '2026-08-26' }, /INVALID_PARAMS.*不能晚于/],
  ])('拒绝非法日期 %#', (payload, error) => {
    expect(() => normalizeListFilters(payload)).toThrow(error)
  })

  test('时间戳日期范围使用上海自然日半开区间', () => {
    const conditions = []
    const params = ['store-1']
    addTimestampDateRange(conditions, params, 'o.created_at', '2026-08-01', '2026-08-26')
    expect(conditions.join(' ')).toContain("AT TIME ZONE 'Asia/Shanghai'")
    expect(conditions.join(' ')).toContain('<')
    expect(params).toEqual(['store-1', '2026-08-01', '2026-08-26'])
  })

  test('date 列使用首尾包含区间', () => {
    const conditions = []
    const params = []
    addDateRange(conditions, params, 'so.service_date', '2026-08-01', '2026-08-26')
    expect(conditions).toEqual([
      'so.service_date >= $1::date',
      'so.service_date <= $2::date',
    ])
  })
})
