/**
 * db-time TZ 探针：被 src/lib/__tests__/db-time.test.ts 以不同 TZ 子进程 spawn。
 *
 * 打印 beijingTs(命令行传入的 ISO instant) 的北京墙钟字面（queryChunks 里的参数串）。
 * Intl 固定 timeZone=Asia/Shanghai，输出与进程 TZ 解耦——任一 TZ 都应得到同一北京字面。
 *
 * 用法：bun tests/db-time-tz-probe.ts 2026-06-29T00:30:00.000Z
 */
import { beijingTs } from '../src/lib/db-time'

const iso = process.argv[2]
if (!iso) {
  console.error('missing instant arg')
  process.exit(2)
}
const frag = beijingTs(new Date(iso)) as unknown as {
  queryChunks: Array<{ value: string[] } | string>
}
// beijingTs 渲染结构：[{value:['']}, <北京字面串>, {value:['::timestamp']}]，取第 2 个 chunk。
const wall = frag.queryChunks[1]
console.log(typeof wall === 'string' ? wall : '')
