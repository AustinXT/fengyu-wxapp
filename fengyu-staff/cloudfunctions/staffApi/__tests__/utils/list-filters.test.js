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

  // ---------- #240：分页归一委托 utils/paging 单源 ----------
  // 改造前这里自带 `Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage) || 1) : 1`，
  // page 侧漏：isFinite(1e20) 为真 → offset = 2e21 → String(2e21) === "2e+21"
  // → pg 按文本传参让 PG int8in 抛 `invalid input syntax for type bigint`（500 级）。
  // 本 normalizer 供 order / service / serviceCommission / appointment / allocation 五个模块使用。
  test('#240 超安全整数 page 不得让 offset 退化成指数记法', () => {
    for (const page of [1e20, 1e21, Number.MAX_SAFE_INTEGER, '1e20']) {
      const r = normalizeListFilters({ page, pageSize: 20 })
      expect(Number.isSafeInteger(r.offset), `page=${String(page)}`).toBe(true)
      expect(String(r.offset), `page=${String(page)}`).not.toMatch(/e\+/i)
    }
  })

  test('#240 小数 / Infinity / NaN 分页入参回落合法整数', () => {
    expect(normalizeListFilters({ page: 2.7, pageSize: 2.5 })).toMatchObject({ page: 2, pageSize: 2, offset: 2 })
    expect(normalizeListFilters({ page: 'Infinity', pageSize: 'Infinity' })).toMatchObject({ page: 1, pageSize: 20, offset: 0 })
    expect(normalizeListFilters({ page: NaN, pageSize: NaN })).toMatchObject({ page: 1, pageSize: 20, offset: 0 })
  })

  test('#240 既有行为不变：合法整数入参、上限夹取、默认值', () => {
    expect(normalizeListFilters({ page: 3, pageSize: 50 })).toMatchObject({ page: 3, pageSize: 50, offset: 100 })
    expect(normalizeListFilters({ pageSize: 999 }).pageSize).toBe(100)
    expect(normalizeListFilters({}, 50)).toMatchObject({ page: 1, pageSize: 50, offset: 0 })
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
