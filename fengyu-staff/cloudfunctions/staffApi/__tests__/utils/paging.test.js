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

const { safePaging } = require('../../utils/paging')

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

  test('任意入参组合下三个出口恒为整数（表驱动兜底）', () => {
    const inputs = [2.5, '2.5', 'Infinity', Infinity, -Infinity, NaN, 1e21, -1, 0, null, undefined, {}, [], '12abc']
    for (const p of inputs) {
      for (const s of inputs) {
        const r = safePaging(p, s, 50)
        expect(Number.isInteger(r.safePage), `page=${String(p)}`).toBe(true)
        expect(Number.isInteger(r.safePageSize), `pageSize=${String(s)}`).toBe(true)
        expect(Number.isInteger(r.offset), `offset for ${String(p)}/${String(s)}`).toBe(true)
        expect(r.safePage).toBeGreaterThanOrEqual(1)
        expect(r.safePageSize).toBeGreaterThanOrEqual(1)
      }
    }
  })
})
