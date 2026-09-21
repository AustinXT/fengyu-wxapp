const {
  normalizeListFilters,
  addTimestampDateRange,
  addDateRange,
  isValidDate,
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

  // ---------- #240：ToPrimitive 失败的 JSON 对象不得抛 TypeError ----------
  // `JSON.parse('{"toString": null}')` 是普通 JSON 对象（不需要用户代码）：
  // `String(raw)` 与 `DATE_RE.test(raw)` 都会走 ToPrimitive → TypeError，
  // 被全局 catch 降级成 {code:-1,'服务器内部错误'}，与本 issue 是同类非优雅降级。
  // 本 normalizer 被 order/service/serviceCommission/appointment/allocation 五个模块共用。
  test('#240 ToPrimitive 失败的入参回落为"未提供"，不抛异常', () => {
    const bad = JSON.parse('{"toString": null}')
    for (const key of ['keyword', 'startDate', 'endDate', 'page', 'pageSize']) {
      let r
      expect(() => { r = normalizeListFilters({ [key]: bad }) }, `key=${key}`).not.toThrow()
      expect(Number.isSafeInteger(r.offset)).toBe(true)
    }
    expect(normalizeListFilters({ keyword: bad }).keyword).toBe('')
    expect(normalizeListFilters({ startDate: bad }).startDate).toBe('')
  })

  test('#240 isValidDate 非字符串一律 false（等价加固，不改既有判定）', () => {
    const bad = JSON.parse('{"toString": null}')
    expect(() => isValidDate(bad)).not.toThrow()
    expect(isValidDate(bad)).toBe(false)
    // 这些在加 typeof 守卫前后都是 false —— 证明守卫是等价的
    expect(isValidDate(20260801)).toBe(false)
    expect(isValidDate(null)).toBe(false)
    expect(isValidDate(undefined)).toBe(false)
    expect(isValidDate(new Date())).toBe(false)
    // 合法值不受影响
    expect(isValidDate('2026-08-01')).toBe(true)
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('0000-01-01')).toBe(false)
  })

  test('#240 既有强转行为不变：数字 keyword 仍被 String 化', () => {
    expect(normalizeListFilters({ keyword: 123 }).keyword).toBe('123')
    expect(normalizeListFilters({}).keyword).toBe('')
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
