/**
 * utils/paging.safePaging 单元测试（#240）
 *
 * 守的是两道防线：
 *   ① Math.trunc —— `Math.max/min` 不取整，2.5 ~ 99.9 区间的小数会原样进 LIMIT，
 *      PG 按 int8 解析直接抛 `invalid input syntax for type bigint`。
 *   ② Number.isSafeInteger —— Infinity / 超 2^53 的值经 trunc 仍非法，必须回落默认值。
 *
 * 判据统一为 `Number.isInteger(...)`：只要有一个出口漏出非整数，
 * 下游拿它当 LIMIT/OFFSET 参数就是 500 级报错。
 */

const { safePaging, MAX_PAGE, MAX_PAGE_SIZE } = require('../../utils/paging')

describe('safePaging', () => {
  test('正常整数入参：原样返回并算出 offset', () => {
    expect(safePaging(3, 20, 20)).toEqual({ safePage: 3, safePageSize: 20, offset: 40 })
    expect(safePaging(1, 50, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
  })

  test('缺省入参（undefined）→ 回落 page=1 与调用点默认 pageSize', () => {
    expect(safePaging(undefined, undefined, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
    expect(safePaging(undefined, undefined, 20)).toEqual({ safePage: 1, safePageSize: 20, offset: 0 })
  })

  test('null 视同未传（Number(null)=0 落在 <1 分支）', () => {
    expect(safePaging(null, null, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
  })

  // ---------- 防线 ① 取整 ----------
  test('防线①：2.5 ~ 99.9 区间的小数 pageSize 被截断为整数（旧写法两个夹子双双失效）', () => {
    const r = safePaging(2.7, 2.5, 50)
    expect(r).toEqual({ safePage: 2, safePageSize: 2, offset: 2 })
    expect(Number.isInteger(r.safePageSize)).toBe(true)
    expect(Number.isInteger(r.offset)).toBe(true)
  })

  test('防线①：小数 page 被截断，offset 仍是整数', () => {
    const r = safePaging(3.999, 20, 20)
    expect(r.safePage).toBe(3)
    expect(r.offset).toBe(40)
    expect(Number.isInteger(r.safePage)).toBe(true)
  })

  test('防线①：字符串小数同样被截断', () => {
    const r = safePaging('2.5', '10.9', 50)
    expect(r).toEqual({ safePage: 2, safePageSize: 10, offset: 10 })
  })

  // ---------- 防线 ② 安全整数 ----------
  test("防线②：'Infinity' 经 trunc 仍是 Infinity，必须回落默认值", () => {
    const r = safePaging('Infinity', 'Infinity', 50)
    expect(r).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
    expect(Number.isInteger(r.offset)).toBe(true)
  })

  test('防线②：数值 Infinity / -Infinity 同样回落', () => {
    expect(safePaging(Infinity, Infinity, 20)).toEqual({ safePage: 1, safePageSize: 20, offset: 0 })
    expect(safePaging(-Infinity, -Infinity, 20)).toEqual({ safePage: 1, safePageSize: 20, offset: 0 })
  })

  test('防线②：1e21 超出安全整数范围 → 回落（注意它不会被 maxPageSize 夹住，夹子在 isSafeInteger 之后）', () => {
    const r = safePaging(1e21, 1e21, 50)
    expect(r).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
  })

  test('防线②：NaN / 非数字字符串 → 回落', () => {
    expect(safePaging(NaN, NaN, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
    expect(safePaging('abc', 'abc', 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
    expect(safePaging({}, [], 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
  })

  // ---------- 边界夹取 ----------
  test('pageSize 超上限被夹到 maxPageSize（默认 100）', () => {
    expect(safePaging(1, 999, 50).safePageSize).toBe(100)
    expect(safePaging(1, 999, 50, 30).safePageSize).toBe(30)
  })

  test('page / pageSize 为 0 或负数 → 回落（0 也走默认，不是夹到 1）', () => {
    expect(safePaging(0, 0, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
    expect(safePaging(-5, -5, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
    // 0.5 落在 <1 分支 —— 旧写法恰好被 Math.max(1, …) 兜住，所以这条不是回归点，是行为对齐
    expect(safePaging(0.5, 0.5, 50)).toEqual({ safePage: 1, safePageSize: 50, offset: 0 })
  })

  test('大页码：offset 是两个安全整数的乘积，仍为整数', () => {
    const r = safePaging(1000, 100, 50)
    expect(r.offset).toBe(99900)
    expect(Number.isInteger(r.offset)).toBe(true)
  })

  // ---------- page 封顶：offset 必须恒为安全整数 ----------
  // 不封顶时 `safePaging(Number.MAX_SAFE_INTEGER, 100, 50)` 的 offset = 900719925474099000，
  // Number.isSafeInteger 为假；maxPageSize 调高还会让 offset 越过 1e21 → String() 输出
  // "2e+21" → pg 按文本传参让 PG int8in 报错，正是本 issue 要修的那个 500。
  test('page 超 MAX_PAGE 被夹住，offset 仍是安全整数', () => {
    const r = safePaging(Number.MAX_SAFE_INTEGER, 100, 50)
    expect(r.safePage).toBe(MAX_PAGE)
    expect(r.offset).toBe((MAX_PAGE - 1) * 100)
    expect(Number.isSafeInteger(r.offset)).toBe(true)
    // 关键：String() 不得退化成指数记法（pg 是按 toString() 传参的）
    expect(String(r.offset)).not.toMatch(/e\+/i)
  })

  test('MAX_PAGE 边界：恰好等于上限不被改动，上限+1 被夹住', () => {
    expect(safePaging(MAX_PAGE, 10, 20).safePage).toBe(MAX_PAGE)
    expect(safePaging(MAX_PAGE + 1, 10, 20).safePage).toBe(MAX_PAGE)
  })

  // ---------- defaultPageSize 自身的契约 ----------
  // 漏传第三参数时若原样吐出 undefined，node-postgres 会把它序列化成 null，
  // 而 `LIMIT NULL` 在 PG 里等于**不限行数** —— 静默全表返回（顾客表含手机号）。
  test('defaultPageSize 非法（漏传 / 0 / 负数 / NaN）时回落 1，绝不吐出 undefined', () => {
    expect(safePaging(1, 'abc').safePageSize).toBe(1)
    expect(safePaging(1, 'abc', 0).safePageSize).toBe(1)
    expect(safePaging(1, 'abc', -5).safePageSize).toBe(1)
    expect(safePaging(1, 'abc', NaN).safePageSize).toBe(1)
    expect(safePaging(1, 'abc', Infinity).safePageSize).toBe(1)
  })

  test('defaultPageSize 是小数时按取整处理（截断意图明确，不粗暴兜 1）', () => {
    expect(safePaging(1, 'abc', 2.5).safePageSize).toBe(2)
    expect(safePaging(1, 'abc', 20.9).safePageSize).toBe(20)
  })

  test('defaultPageSize 超 maxPageSize 也被夹住（回落分支不得突破自己声明的上限）', () => {
    expect(safePaging(1, 'abc', 500).safePageSize).toBe(MAX_PAGE_SIZE)
    expect(safePaging(1, 'abc', 500, 30).safePageSize).toBe(30)
  })

  test('导出的常量口径：MAX_PAGE_SIZE=100 且是 maxPageSize 的默认值', () => {
    expect(MAX_PAGE_SIZE).toBe(100)
    expect(MAX_PAGE).toBe(1_000_000)
    expect(safePaging(1, 9999, 20).safePageSize).toBe(MAX_PAGE_SIZE)
  })

  test('任意入参组合下三个出口恒为**安全**整数且不超上限（表驱动兜底）', () => {
    // 输入表必须含 Number.MAX_SAFE_INTEGER 与空串：前者是 offset 溢出的唯一真实触发点，
    // 后者（Number('') === 0）是表单最常见的空值入参。
    const inputs = [
      2.5, '2.5', 'Infinity', Infinity, -Infinity, NaN, 1e21, -1, 0, -0, 0.5,
      null, undefined, {}, [], [5], '', '050', '12abc', true, false,
      Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2 ** 53, '9007199254740993',
    ]
    for (const p of inputs) {
      for (const s of inputs) {
        const r = safePaging(p, s, 50)
        const label = `page=${String(p)} pageSize=${String(s)}`
        expect(Number.isSafeInteger(r.safePage), label).toBe(true)
        expect(Number.isSafeInteger(r.safePageSize), label).toBe(true)
        expect(Number.isSafeInteger(r.offset), label).toBe(true)
        expect(r.safePage).toBeGreaterThanOrEqual(1)
        expect(r.safePage).toBeLessThanOrEqual(MAX_PAGE)
        expect(r.safePageSize).toBeGreaterThanOrEqual(1)
        expect(r.safePageSize).toBeLessThanOrEqual(MAX_PAGE_SIZE)
        // pg 按 toString() 传参：任何指数记法都会让 PG int8in 报错
        expect(String(r.offset), label).not.toMatch(/e\+/i)
      }
    }
  })
})
