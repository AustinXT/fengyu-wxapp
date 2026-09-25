import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { db } from '@/db'
import { adminExportJobs } from '@db/export-job'
import { deleteByCloudPaths, uploadFile } from '@/lib/cloudbase'
import { parseErrorPrefix } from '@/lib/api-error'
import { runWithExportSession } from '@/lib/export-session-context'
import { parseExportPayload, parseExportSession, parseExportType } from '@/lib/export-job-schema'
import { logOperation } from '@/lib/operation-log'
import { exportJobLabel } from '@/lib/export-job-types'
import { createExportContent } from './registry'
import { exportCloudPath, exportFileName } from './file-name'
import { writeStreamXlsx } from './xlsx-writer'
import { completeExportMeta } from './export-meta'
import { shouldRetryExportFailure } from './retry-policy'
import { writeWorkerHeartbeat } from '@/lib/worker-heartbeat'
import { createSerializedAsyncRunner, runWorkerSlots } from './worker-slots'

const POLL_INTERVAL_MS = 2_000
const MAINTENANCE_INTERVAL_MS = 60_000
const LEASE_MINUTES = 10
const MAX_ATTEMPTS = 3 // 首次执行 + 自动重试 2 次
const RETENTION_MS = 24 * 60 * 60 * 1_000
const MAX_CONCURRENT_JOBS = 2

let stopping = false
let maintenanceAt = 0
const activeJobIds = new Set<number>()

type ExportJob = typeof adminExportJobs.$inferSelect

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const publishWorkerHeartbeat = createSerializedAsyncRunner(async () => {
  const activeCount = activeJobIds.size
  await writeWorkerHeartbeat(
    'export-worker',
    activeCount > 0 ? 'busy' : 'idle',
    activeCount > 0 ? `正在处理 ${activeCount} 个导出任务` : undefined,
  )
})

function asClaimedId(rows: unknown): number | null {
  const row = (rows as Array<{ id?: number | string }>)[0]
  const id = Number(row?.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function recoverExpiredLeases(): Promise<void> {
  await db.execute(sql`
    UPDATE admin_export_jobs
       SET status = CASE
             WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'failed'
             ELSE 'queued'
           END,
           next_attempt_at = NOW(),
           lease_expires_at = NULL,
           error_code = 'WORKER_LEASE_EXPIRED',
           error_message = CASE
             WHEN attempt_count >= ${MAX_ATTEMPTS} THEN '导出任务执行超时，已达到最大重试次数'
             ELSE '导出任务执行超时，正在自动重试'
           END,
           completed_at = CASE
             WHEN attempt_count >= ${MAX_ATTEMPTS} THEN NOW()
             ELSE NULL
           END,
           updated_at = NOW()
     WHERE status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < NOW()
  `)
}

/** SKIP LOCKED 使意外启动的第二个 worker 也不会领取同一任务。 */
async function claimNextJob(): Promise<ExportJob | null> {
  const claimed = await db.execute(sql`
    UPDATE admin_export_jobs
       SET status = 'running',
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, NOW()),
           lease_expires_at = NOW() + ${sql.raw(`interval '${LEASE_MINUTES} minutes'`)},
           error_code = NULL,
           error_message = NULL,
           updated_at = NOW()
     WHERE id = (
       SELECT id
         FROM admin_export_jobs
        WHERE status = 'queued'
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id
  `)
  const id = asClaimedId(claimed)
  if (!id) return null
  const [job] = await db
    .select()
    .from(adminExportJobs)
    .where(eq(adminExportJobs.id, id))
    .limit(1)
  return job ?? null
}

async function renewLease(id: number): Promise<void> {
  await db.execute(sql`
    UPDATE admin_export_jobs
       SET lease_expires_at = NOW() + ${sql.raw(`interval '${LEASE_MINUTES} minutes'`)},
           updated_at = NOW()
     WHERE id = ${id}
       AND status = 'running'
  `)
}

function safeFailure(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const parsed = parseErrorPrefix(message)
  if (parsed) return { code: parsed.prefix, message: parsed.displayMessage.slice(0, 500) }
  return { code: 'EXPORT_FAILED', message: '导出生成失败，系统将自动重试' }
}

async function failJob(job: ExportJob, err: unknown): Promise<void> {
  const failure = safeFailure(err)
  const shouldRetry = shouldRetryExportFailure(failure.code, job.attemptCount, MAX_ATTEMPTS)
  await db
    .update(adminExportJobs)
    .set({
      status: shouldRetry ? 'queued' : 'failed',
      nextAttemptAt: shouldRetry
        ? new Date(Date.now() + job.attemptCount * 30_000)
        : new Date(),
      leaseExpiresAt: null,
      completedAt: shouldRetry ? null : new Date(),
      errorCode: failure.code,
      errorMessage: shouldRetry
        ? `${failure.message}（第 ${job.attemptCount} 次失败，正在重试）`
        : failure.message,
    })
    .where(and(eq(adminExportJobs.id, job.id), eq(adminExportJobs.status, 'running')))

  if (!shouldRetry) {
    const session = parseExportSession(job.scopeSnapshot)
    await logOperation(session, 'export_job.failed', 'admin_export_jobs', String(job.id), {
      exportType: job.exportType,
      attemptCount: job.attemptCount,
      errorCode: failure.code,
    }).catch((logError) => console.error('[export-worker] failure audit log error:', logError))
  }
}

async function expireFinishedFiles(): Promise<void> {
  const expired = await db
    .select({ id: adminExportJobs.id, fileCloudPath: adminExportJobs.fileCloudPath })
    .from(adminExportJobs)
    .where(and(
      inArray(adminExportJobs.status, ['ready', 'expired']),
      isNotNull(adminExportJobs.fileCloudPath),
      lt(adminExportJobs.expiresAt, new Date()),
    ))
    .limit(100)

  for (const job of expired) {
    try {
      if (job.fileCloudPath) await deleteByCloudPaths([job.fileCloudPath])
      await db
        .update(adminExportJobs)
        .set({ status: 'expired', fileCloudPath: null, updatedAt: new Date() })
        .where(and(
          eq(adminExportJobs.id, job.id),
          inArray(adminExportJobs.status, ['ready', 'expired']),
        ))
    } catch (err) {
      console.error(`[export-worker] cleanup failed for job ${job.id}:`, err)
    }
  }
}

async function runMaintenance(): Promise<void> {
  const now = Date.now()
  if (now - maintenanceAt < MAINTENANCE_INTERVAL_MS) return
  maintenanceAt = now
  await recoverExpiredLeases()
  await expireFinishedFiles()
}

async function processJob(job: ExportJob): Promise<void> {
  let tempDir: string | null = null
  let cloudPath: string | null = null
  const jobStartedAt = Date.now()
  activeJobIds.add(job.id)
  await publishWorkerHeartbeat().catch(() => undefined)
  const heartbeat = setInterval(() => {
    void renewLease(job.id).catch((err) => console.error(`[export-worker] lease renew failed for ${job.id}:`, err))
  }, 30_000)
  heartbeat.unref()

  try {
    const exportType = parseExportType(job.exportType)
    if (!exportType) {
      await failJob(job, new Error('INVALID_STATE: 导出任务类型异常'))
      return
    }
    const session = parseExportSession(job.scopeSnapshot)
    const payload = parseExportPayload(exportType, job.requestPayload)
    tempDir = await mkdtemp(path.join(tmpdir(), 'fengyu-export-'))

    const generateStartedAt = Date.now()
    const output = await runWithExportSession(session, async () => {
      const content = await createExportContent(exportType, payload)
      const fileName = exportFileName(exportJobLabel(exportType, payload))
      const filePath = path.join(tempDir!, fileName)
      let lastProgress = 0
      const writeResult = await writeStreamXlsx({
        filePath,
        sheetName: content.sheetName,
        columns: content.columns,
        rows: content.rows,
        frozenColumns: content.frozenColumns,
        totalsLabel: content.totalsLabel,
        isEmphasisRow: content.isEmphasisRow,
        meta: completeExportMeta(content.meta, { generatedAt: new Date(), exporterName: session.name }),
        onProgress: async (rowCount) => {
          if (rowCount - lastProgress < 1_000) return
          lastProgress = rowCount
          await db
            .update(adminExportJobs)
            .set({ progressRows: rowCount })
            .where(and(eq(adminExportJobs.id, job.id), eq(adminExportJobs.status, 'running')))
        },
      })
      return { content, fileName, filePath, writeResult }
    })
    const generateMs = Date.now() - generateStartedAt

    if (output.writeResult.rowCount === 0) {
      await db
        .update(adminExportJobs)
        .set({
          status: 'empty',
          leaseExpiresAt: null,
          completedAt: new Date(),
          rowCount: 0,
          sheetCount: 0,
          progressRows: 0,
          errorCode: null,
          errorMessage: null,
        })
        .where(and(eq(adminExportJobs.id, job.id), eq(adminExportJobs.status, 'running')))
      await logOperation(session, 'export_job.empty', 'admin_export_jobs', String(job.id), {
        exportType,
      }).catch((logError) => console.error('[export-worker] empty audit log error:', logError))
      console.log(`[export-worker] job ${job.id} empty (generate=${generateMs}ms total=${Date.now() - jobStartedAt}ms)`)
      return
    }

    // 路径按任务固定：上传后、状态写回前若进程中断，下一次重试会覆盖同一对象。
    // 对象名与任务名称同步，浏览器跟随临时 URL 下载时才能保留正确文件名。
    // uploadFile 内部已调用 getTempFileURL 验证上传 + 返回临时 URL（含 CDN_BASE 兜底），
    // 无需外部二次调用 getTempFileUrl 验证——其失败会把已成功上传的任务误标为 failed。
    const uploadPath = exportCloudPath(job.id, output.fileName)
    const uploadStartedAt = Date.now()
    await uploadFile(createReadStream(output.filePath), uploadPath)
    const uploadMs = Date.now() - uploadStartedAt
    cloudPath = uploadPath
    const expiresAt = new Date(Date.now() + RETENTION_MS)
    await db
      .update(adminExportJobs)
      .set({
        status: 'ready',
        leaseExpiresAt: null,
        completedAt: new Date(),
        expiresAt,
        progressRows: output.writeResult.rowCount,
        rowCount: output.writeResult.rowCount,
        sheetCount: output.writeResult.sheetCount,
        fileCloudPath: cloudPath,
        fileName: output.fileName,
        errorCode: null,
        errorMessage: null,
      })
      .where(and(eq(adminExportJobs.id, job.id), eq(adminExportJobs.status, 'running')))
    await logOperation(session, 'export_job.ready', 'admin_export_jobs', String(job.id), {
      exportType,
      rowCount: output.writeResult.rowCount,
      sheetCount: output.writeResult.sheetCount,
    }).catch((logError) => console.error('[export-worker] ready audit log error:', logError))
    const queueWaitMs = Math.max(0, jobStartedAt - job.createdAt.getTime())
    console.log(
      `[export-worker] job ${job.id} ready (${output.writeResult.rowCount} rows, queue=${queueWaitMs}ms generate=${generateMs}ms upload=${uploadMs}ms total=${Date.now() - jobStartedAt}ms)`,
    )
  } catch (err) {
    console.error(`[export-worker] job ${job.id} failed:`, err)
    if (cloudPath) {
      await deleteByCloudPaths([cloudPath]).catch((cleanupError) => {
        console.error(`[export-worker] failed upload cleanup for ${job.id}:`, cleanupError)
      })
    }
    await failJob(job, err)
  } finally {
    clearInterval(heartbeat)
    activeJobIds.delete(job.id)
    await publishWorkerHeartbeat().catch(() => undefined)
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      console.error(`[export-worker] temp cleanup failed for ${job.id}:`, err)
    })
  }
}

async function run(): Promise<void> {
  console.log(`[export-worker] started (global concurrency: ${MAX_CONCURRENT_JOBS})`)
  await publishWorkerHeartbeat()
  const workerHeartbeat = setInterval(() => {
    void publishWorkerHeartbeat().catch(() => undefined)
  }, 30_000)
  workerHeartbeat.unref()
  await runWorkerSlots({
    concurrency: MAX_CONCURRENT_JOBS,
    shouldStop: () => stopping,
    runMaintenance,
    claimNextJob,
    processJob: async (job, slot) => {
      console.log(`[export-worker] slot ${slot} claimed job ${job.id}`)
      await processJob(job)
    },
    waitWhenIdle: () => sleep(POLL_INTERVAL_MS),
    onLoopError: (err, slot) => console.error(`[export-worker] slot ${slot} loop error:`, err),
  })
  clearInterval(workerHeartbeat)
  await publishWorkerHeartbeat().catch(() => undefined)
  console.log('[export-worker] stopped')
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

if (process.argv.includes('--check')) {
  console.log('[export-worker] bundle verified')
} else if (process.argv.includes('--once')) {
  runMaintenance()
    .then(claimNextJob)
    .then(async (job) => {
      if (job) await processJob(job)
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[export-worker] one-shot failed:', err)
      process.exit(1)
    })
} else {
  run().catch((err) => {
    console.error('[export-worker] fatal error:', err)
    process.exit(1)
  })
}
