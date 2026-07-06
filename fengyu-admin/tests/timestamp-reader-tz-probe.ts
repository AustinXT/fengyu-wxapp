/**
 * timestamp reader TZ 探针：被 src/lib/__tests__/timestamp-reader-tz.test.ts 以不同 TZ 子进程 spawn。
 *
 * 打印 parseTimestamp1114(命令行传入的 1114 字面) 的 toISOString。'+08:00' 显式偏移构造，
 * 输出与进程 TZ 解耦——任一 TZ 都应得到同一 UTC instant。
 *
 * 用法：bun tests/timestamp-reader-tz-probe.ts "2026-07-06 14:00:00"
 */
import { parseTimestamp1114 } from '../src/db'

const literal = process.argv[2]
if (!literal) {
  console.error('missing 1114 literal arg')
  process.exit(2)
}
const d = parseTimestamp1114(literal)
console.log(d ? d.toISOString() : 'null')
