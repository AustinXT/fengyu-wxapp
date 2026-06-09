/**
 * Cron E2E runner — 通过 execSync 触发 `bun run cron:once --only=<stepName>` 单 STEP 执行。
 *
 * 设计：
 *   - 单 STEP 比全套快 10-50× (5-30s vs 3-5min)，因为只跑指定写入路径
 *   - 通过 env CRON_REFERENCE_DATE 注入伪造日期（cron run.ts 解析）
 *   - 返回 stdout，方便 spec 解析 STEP summary
 *
 * 关键事实：
 *   - PG 连接：5434/fengyu_e2e（与 admin web 同库，真实业务库）
 *   - cron:once 用 process.exit(0)/process.exit(1) 表征 STEP 错误聚合状态
 *   - 单 STEP 失败不影响下一 STEP（STEP 级隔离）
 */

import { execSync } from 'child_process'
import path from 'path'

const ADMIN_DIR = path.resolve(__dirname, '../../..')

export interface RunCronOptions {
  /** 伪造日期 'YYYY-MM-DD'；undefined → 用真实 CURRENT_DATE */
  referenceDate?: string
  /** 超时 ms，默认 90s（单 STEP 通常 < 30s） */
  timeoutMs?: number
}

/**
 * 跑指定 STEP 的 cron:once。
 * @param stepName  STEP 名（closeExpiredAppointments / customerStatus / memberLevels / birthday / thanksgiving / pointsAudit / roleTypeNullsAudit / paymentInvariants / refundCascadeCoverage / storeUnbindOrphans）
 */
export function runCronStep(stepName: string, options: RunCronOptions = {}): string {
  const env = { ...process.env }
  if (options.referenceDate) {
    env.CRON_REFERENCE_DATE = options.referenceDate
  } else {
    delete env.CRON_REFERENCE_DATE
  }
  try {
    return execSync(`bun run cron:once --only=${stepName}`, {
      cwd: ADMIN_DIR,
      encoding: 'utf8',
      env,
      timeout: options.timeoutMs ?? 90_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    // cron 失败时 process.exit(1)，execSync 抛错；保留 stdout 给 spec 解析
    if (err.stdout) return err.stdout
    throw new Error(
      `runCronStep(${stepName}) failed: ${err.message}\nstderr: ${err.stderr ?? ''}`,
    )
  }
}

/**
 * 解析 cron:once 输出，提取指定 STEP 的 JSON summary。
 *
 * 输出形如：
 *   [cron-worker] birthday: {"total":1,"sentCount":1,"skippedNoConfig":0,"errorCount":0} (123ms)
 */
export function parseStepSummary<T = unknown>(output: string, stepName: string): T | null {
  // 输出形如 `[cron-worker] <stepName>: <JSON> (<ms>ms)`
  // 用 `(<digit>ms)` 锚定结尾 — 整个行匹配到 `(\d+ms)` 之前的最长可解析 JSON
  const lineRe = new RegExp(`\\[cron-worker\\]\\s+${stepName}:\\s+(.*)\\s+\\(\\d+ms\\)`, 'm')
  const m = output.match(lineRe)
  if (!m) return null
  try {
    return JSON.parse(m[1]) as T
  } catch {
    return null
  }
}

/**
 * psql 同步执行（与 link-22 模式一致），返回 stdout 字符串。
 * 不允许在 SQL 中使用未转义的双引号（用单引号 + 字面量）。
 */
export function psql(sqlStr: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu_e2e -t -A -c "${sqlStr.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}
