/**
 * 导出任务失败后是否自动重试。
 *
 * 入参 / 状态类错误（INVALID_PARAMS / INVALID_STATE）是确定性的：同一个任务再跑一遍必然同样失败，
 * 自动重试只会在 30s、60s 后把昂贵的取数查询白跑两遍、占住 worker 槽位（#368 评审）。
 * 这类错误首次即判 failed；其余（数据库瞬断、上传失败、未分类错误）仍按次数重试。
 */
const DETERMINISTIC_FAILURE_CODES: ReadonlySet<string> = new Set(['INVALID_PARAMS', 'INVALID_STATE'])

export function shouldRetryExportFailure(code: string, attemptCount: number, maxAttempts: number): boolean {
  if (DETERMINISTIC_FAILURE_CODES.has(code)) return false
  return attemptCount < maxAttempts
}
