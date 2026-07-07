/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/db-time 写入侧 helper 守护。
 *
 * migration 0076 起 timestamp 列统一 timestamptz（1184，存绝对时刻）。本文件守护写入 helper：
 *   1. nowTs() 渲染为 PG `NOW()`（timestamptz，TZ 无关）；
 *   2. beijingTs(d) 把 JS Date 格式化为 Asia/Shanghai 墙钟字面 + `::timestamp AT TIME ZONE 'Asia/Shanghai'`
 *      （显式当北京转 timestamptz，与 server/session TZ 解耦）；
 *   3. **TZ 无关**：TZ=UTC / America/Los_Angeles 子进程下 beijingTs 输出都须等于北京墙钟字面
 *      （Intl 固定 timeZone，与进程 TZ 解耦）。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { nowTs, beijingTs } from '../db-time'
import { runBunProbeInTz } from './tz-probe-helper'

/** 从 drizzle sql 片段的 queryChunks 里拼出可读 SQL 串（参数内联），便于断言。 */
function render(frag: any): string {
  return (frag.queryChunks as any[])
    .map((c: any) => (c === Object(c) && 'value' in c ? c.value.join('') : String(c)))
    .join('')
}

describe('nowTs', () => {
  it('渲染为 PG NOW()（timestamptz，TZ 无关）', () => {
    expect(render(nowTs())).toBe('NOW()')
  })
})

describe('beijingTs', () => {
  it('把 UTC instant 格式化为 Asia/Shanghai 墙钟字面 + AT TIME ZONE 转 timestamptz', () => {
    // UTC 2026-06-29 00:30:00 → 北京 2026-06-29 08:30:00
    const frag = beijingTs(new Date('2026-06-29T00:30:00.000Z'))
    expect(render(frag)).toBe("2026-06-29 08:30:00::timestamp AT TIME ZONE 'Asia/Shanghai'")
  })

  it('跨日：UTC 20:00 → 北京次日 04:00（验证不裸截 UTC 日期）', () => {
    // UTC 2026-06-29 20:00:00 → 北京 2026-06-30 04:00:00
    const frag = beijingTs(new Date('2026-06-29T20:00:00.000Z'))
    expect(render(frag)).toBe("2026-06-30 04:00:00::timestamp AT TIME ZONE 'Asia/Shanghai'")
  })

  // 核心回归守护：进程 TZ 不影响输出。spawn 不同 TZ 子进程跑同一 helper。
  // 探针文件 tests/db-time-tz-probe.ts 把 beijingTs(固定 instant) 的北京字面打到 stdout。
  // spawn + status 守卫抽到 ./tz-probe-helper（与其它 TZ 守护测试共用）。
  const PROBE = path.resolve(__dirname, '../../../tests/db-time-tz-probe.ts')
  const INSTANT = '2026-06-29T00:30:00.000Z' // UTC 00:30 → 北京 08:30
  const EXPECT = '2026-06-29 08:30:00'

  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    it(`TZ=${tz} 子进程下 beijingTs 仍输出北京墙钟字面`, () => {
      expect(runBunProbeInTz(PROBE, INSTANT, tz)).toBe(EXPECT)
    })
  }
})
