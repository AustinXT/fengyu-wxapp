/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/db-time 时区根治 helper 守护（follow-up #2）。
 *
 * 背景：admin 写 timestamp without tz 列，postgres.js 把 `new Date()` 序列化为 UTC ISO，
 * PG 当墙钟字面落库 → 早 8h；clientApi/staffApi reader 假设北京字面 → 读出来 +8h 偏移。
 * 修复：写入侧改用 `nowTs()`（`NOW()`）/ `beijingTs(d)`（北京墙钟字面 `::timestamp`）。
 *
 * 守护目标：
 *   1. nowTs() 渲染为 PG `NOW()`；
 *   2. beijingTs(d) 把任意 JS Date 格式化为 Asia/Shanghai 墙钟字面 'YYYY-MM-DD HH:mm:ss'；
 *   3. **TZ 无关**：在 TZ=UTC / TZ=America/Los_Angeles 子进程里跑 helper，输出都须等于
 *      北京墙钟字面——这正是修复的核心保证（Intl 固定 timeZone，与进程 TZ 解耦）。
 *      本机默认 TZ=Asia/Shanghai 删了修复也「碰巧对」，只有跨 TZ 子进程能暴露回归
 *      （同 fix/003 client/staff pg parser 守护思路）。
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { nowTs, beijingTs } from '../db-time'

/** 从 drizzle sql 片段的 queryChunks 里拼出可读 SQL 串（参数内联），便于断言。 */
function render(frag: any): string {
  return (frag.queryChunks as any[])
    .map((c: any) => (c === Object(c) && 'value' in c ? c.value.join('') : String(c)))
    .join('')
}

describe('nowTs', () => {
  it('渲染为 PG NOW()（不依赖进程 TZ，server timezone=Shanghai 落北京字面）', () => {
    expect(render(nowTs())).toBe('NOW()')
  })
})

describe('beijingTs', () => {
  it('把 UTC instant 格式化为 Asia/Shanghai 墙钟字面并包 ::timestamp', () => {
    // UTC 2026-06-29 00:30:00 → 北京 2026-06-29 08:30:00
    const frag = beijingTs(new Date('2026-06-29T00:30:00.000Z'))
    expect(render(frag)).toBe('2026-06-29 08:30:00::timestamp')
  })

  it('跨日：UTC 20:00 → 北京次日 04:00（验证不裸截 UTC 日期）', () => {
    // UTC 2026-06-29 20:00:00 → 北京 2026-06-30 04:00:00
    const frag = beijingTs(new Date('2026-06-29T20:00:00.000Z'))
    expect(render(frag)).toBe('2026-06-30 04:00:00::timestamp')
  })

  // 核心回归守护：进程 TZ 不影响输出。spawn 不同 TZ 子进程跑同一 helper。
  // 探针文件 tests/db-time-tz-probe.ts 把 beijingTs(固定 instant) 的北京字面打到 stdout。
  const PROBE = path.resolve(__dirname, '../../../tests/db-time-tz-probe.ts')
  const INSTANT = '2026-06-29T00:30:00.000Z' // UTC 00:30 → 北京 08:30
  const EXPECT = '2026-06-29 08:30:00'

  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    it(`TZ=${tz} 子进程下 beijingTs 仍输出北京墙钟字面`, () => {
      const res = spawnSync('bun', [PROBE, INSTANT], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      })
      if (res.status !== 0) {
        throw new Error(`probe failed (TZ=${tz}): ${res.stderr}`)
      }
      expect(res.stdout.trim()).toBe(EXPECT)
    })
  }
})
