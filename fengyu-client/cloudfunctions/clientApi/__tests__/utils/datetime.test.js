/**
 * 东八区日期工具。
 *
 * 这些函数刻意用**纯 UTC 算术 +8h**，不依赖 `process.env.TZ` ——
 * 云函数进程时区靠 index.js 设置，而单测直接 require utils/ 不加载 index.js，
 * 依赖进程时区的实现会在本地/CI 两处给出不同结果。
 */

const {
  shanghaiDateStr, shanghaiYMD, shanghaiYYMMDD, shanghaiClockHM,
} = require('../../utils/datetime')

describe('utils/datetime — 东八区日期', () => {
  test('北京时间凌晨 00:00–08:00 不会回退到前一天', () => {
    // 2026-09-22T16:30:00Z = 北京 2026-09-23 00:30
    const d = new Date('2026-09-22T16:30:00Z')
    expect(shanghaiDateStr(d)).toBe('2026-09-23')
    expect(shanghaiYMD(d)).toBe('20260923')
    expect(shanghaiYYMMDD(d)).toBe('260923')
  })

  test('北京时间白天与 UTC 同日时也正确', () => {
    const d = new Date('2026-09-22T03:00:00Z')   // 北京 11:00
    expect(shanghaiDateStr(d)).toBe('2026-09-22')
  })
})

describe('utils/datetime — shanghaiClockHM (#215)', () => {
  // 顾客端的「请在 HH:mm 前完成支付」用它。前端不能自己拿 getHours() 推——
  // 那取的是**设备时区**，顾客出境后同一行会变成
  //「请在 03:15 前完成支付（剩余 09:30）」这种自相矛盾的句子。
  test('按东八区给出 HH:mm', () => {
    expect(shanghaiClockHM(new Date('2026-09-22T15:40:00Z'))).toBe('23:40')
  })

  test('跨日边界：UTC 次日凌晨前 → 北京已是次日 00:05', () => {
    expect(shanghaiClockHM(new Date('2026-09-22T16:05:00Z'))).toBe('00:05')
  })

  test('整点补零', () => {
    expect(shanghaiClockHM(new Date('2026-09-22T01:03:00Z'))).toBe('09:03')
  })

  test('不受进程时区影响（结果与 TZ 无关）', () => {
    const originalTz = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      expect(shanghaiClockHM(new Date('2026-09-22T15:40:00Z'))).toBe('23:40')
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }
  })
})
