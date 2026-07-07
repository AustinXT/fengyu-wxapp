/**
 * admin reader 时区根治守护：postgres.js 1114 parser（`parseTimestamp1114`）必须 TZ 无关。
 *
 * 背景：admin 读 `timestamp without time zone` 列，postgres.js 内置 parse `x => new Date(x)` 按
 * **进程本地 TZ** 解释无时区字面；容器 TZ 漂移（ops/001）即把北京墙钟当 UTC → epoch 晚 8h → 前端 +8 →
 * T+8（寄存单录入时刻显示成 T+8 即此）。修复：src/db/index.ts 注册 types.beijingTimestamp（1114 显式
 * 按 +08:00 解析），与进程 TZ 解耦。
 *
 * 守护目标：
 *   1. parseTimestamp1114 把北京墙钟字面解析为正确 UTC instant（北京 14:00 → 06:00Z）；
 *   2. null 透传；
 *   3. **TZ 无关**：TZ=UTC / America/Los_Angeles / Asia/Shanghai 子进程下输出都须相等——
 *      这是修复的核心保证。本机默认 TZ=Shanghai，删了修复「碰巧也对」，只有跨 TZ 子进程能暴露回归
 *      （同 fix/003 client/staff pg parser 守护、db-time.test.ts 思路）。
 *   4. 对照：内置 `new Date(字面)` 在 TZ=UTC 下确实偏移（证明修复必要性）。
 *
 * spawn + status 守卫抽到 ./tz-probe-helper（与 db-time.test.ts 共用，含 ENOENT 诊断）。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { parseTimestamp1114 } from '../../db'
import { runBunProbeInTz, runNodeInTz } from './tz-probe-helper'

const PROBE = path.resolve(__dirname, '../../../tests/timestamp-reader-tz-probe.ts')
const LITERAL = '2026-07-06 14:00:00' // 北京墙钟 14:00（库存字面）
const EXPECT_ISO = '2026-07-06T06:00:00.000Z' // 北京 14:00 = UTC 06:00

describe('parseTimestamp1114', () => {
  it('北京墙钟字面 → 正确 UTC instant（北京 14:00 → 06:00Z）', () => {
    expect(parseTimestamp1114(LITERAL)?.toISOString()).toBe(EXPECT_ISO)
  })

  it('跨日边界：北京 08:00 = UTC 00:00', () => {
    expect(parseTimestamp1114('2026-06-16 08:00:00')?.toISOString()).toBe(
      '2026-06-16T00:00:00.000Z',
    )
  })

  it('null 透传', () => {
    expect(parseTimestamp1114(null)).toBeNull()
  })

  // 核心回归守护：进程 TZ 不影响输出（这是与内置 parse 的本质区别）。
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    it(`TZ=${tz} 子进程下仍输出同一 UTC instant`, () => {
      expect(runBunProbeInTz(PROBE, LITERAL, tz)).toBe(EXPECT_ISO)
    })
  }

  it('对照：内置 new Date(字面) 在 TZ=UTC 下当 UTC 14:00（晚 8h，证明修复必要性）', () => {
    // 内置 parse 等价于 new Date('2026-07-06 14:00:00')；V8 对带空格字面按本地 TZ 解析，
    // TZ=UTC 下 = UTC 14:00 → 前端 fmtDateTime +8 → 显示 22:00 = T+8（用户报告的现象）。
    const out = runNodeInTz(
      `process.stdout.write(new Date(${JSON.stringify(LITERAL)}).toISOString())`,
      'UTC',
    )
    expect(out).toBe('2026-07-06T14:00:00.000Z')
  })
})
