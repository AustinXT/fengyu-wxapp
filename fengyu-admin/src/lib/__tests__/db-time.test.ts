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
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
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

  // fail-fast：Invalid Date 经 fmtDateTime 会变成 ''，拼进 SQL 是 `''::timestamp` → 运行时 22007，
  // 报错离现场很远。提前抛型错，把问题钉在调用点。
  it('Invalid Date 直接抛错，不生成空字面量 SQL', () => {
    expect(() => beijingTs(new Date('not-a-date'))).toThrow(TypeError)
  })

  it('epoch 0 是合法输入（refunds.ts 的兜底阈值用它）', () => {
    expect(render(beijingTs(new Date(0)))).toBe("1970-01-01 08:00:00::timestamp AT TIME ZONE 'Asia/Shanghai'")
  })
})

/**
 * #253 的**根因层**守护：为什么 admin 写 timestamp 列必须经 db-time，不能裸传 Date。
 *
 * 常见误解是「postgres.js 不接受 Date」——不成立，它原生带 `date.serialize`（→ ISO 串，OID 1184）。
 * 真凶是 drizzle 的 `construct()`：它为了自己接管时间类型，把 client 上时间 OID 的 **serializer**
 * 一并覆盖成恒等函数，于是 Date 未经序列化直达 Bind writer → ERR_INVALID_ARG_TYPE。
 * 到店积分（lib/visit-points.ts）2026-08-14 → 2026-09-22 的 100% 失败就是这条链。
 *
 * 这一层是 `visit-points.test.ts` 里 `PgDialect().sqlToQuery()` 断言够不到的下游，两处合起来才闭环。
 * 本用例不连库（postgres.js 建 client 是惰性的，不发 TCP）。
 */
describe('drizzle 覆盖 postgres.js 时间 serializer（#253 根因）', () => {
  it('construct() 把 1184 的 serializer 从 toISOString 换成恒等函数', () => {
    const client = postgres('postgresql://probe:probe@127.0.0.1:1/probe')
    try {
      const instant = new Date('2026-08-13T10:00:00.000Z')

      // 覆盖前：postgres.js 原生会把 Date 序列化成 ISO 串（所以裸用 postgres.js 不受影响）
      expect(client.options.serializers[1184](instant)).toBe('2026-08-13T10:00:00.000Z')

      drizzle(client)

      // 覆盖后：恒等函数，Date 原样流向 Bind —— 这就是必须走 beijingTs()/nowTs() 的原因
      expect(client.options.serializers[1184](instant)).toBe(instant)
    } finally {
      void client.end({ timeout: 0 })
    }
  })
})
