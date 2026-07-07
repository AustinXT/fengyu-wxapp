import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

/**
 * 跨 TZ 子进程 probe 共用 helper（db-time.test.ts / timestamp-reader-tz.test.ts 复用）。
 *
 * 两个测试原先各自重复 `spawnSync + if (res.status !== 0) throw new Error(res.stderr)` 模板，
 * 且 timestamp-reader-tz 的 `node -e` 对照漏了 status 守卫（#5）。抽到这里统一：
 *   - status !== 0 抛错；
 *   - spawn 本身失败（bun/node 不在 PATH → ENOENT）时 `res.error` 有值，附带其 message，
 *     给可读诊断，而不是让空 stdout 走到 `expect(...).toBe(...)` 失败、看不出根因。
 */

/** 在指定 TZ 子进程用 bun 跑 probe 脚本，返回 trim 后的 stdout。status!==0 / spawn 失败抛错。 */
export function runBunProbeInTz(probe: string, arg: string, tz: string): string {
  const res = spawnSync('bun', [probe, arg], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  })
  assertOk(res, `bun ${probe}`, tz)
  return res.stdout.trim()
}

/** 在指定 TZ 子进程跑 `node -e <code>`，返回 trim 后的 stdout。status!==0 / spawn 失败抛错。 */
export function runNodeInTz(code: string, tz: string): string {
  const res = spawnSync('node', ['-e', code], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  })
  assertOk(res, 'node -e', tz)
  return res.stdout.trim()
}

function assertOk(
  res: SpawnSyncReturns<Buffer | string>,
  runner: string,
  tz: string,
): void {
  if (res.status !== 0) {
    const spawnErr = res.error ? ` | spawn error: ${res.error.message}` : ''
    throw new Error(
      `${runner} failed (TZ=${tz}, status=${res.status})${spawnErr}: ${res.stderr}`,
    )
  }
}
