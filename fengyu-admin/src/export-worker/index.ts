import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '@/db'
import { adminExportJobs } from '@db/export-job'
import { deleteByCloudPaths, uploadFile } from '@/lib/cloudbase'
import { parseErrorPrefix } from '@/lib/api-error'
import { runWithExportSession } from '@/lib/export-session-context'
import { parseExportPayload, parseExportSession, parseExportType } from '@/lib/export-job-schema'
import { logOperation } from '@/lib/operation-log'
import { shanghaiYmd } from '@/lib/datetime'
import { createExportContent } from './registry'
import { writeStreamXlsx } from './xlsx-writer'

const POLL_INTERVAL_MS = 2_000
const MAINTENANCE_INTERVAL_MS = 60_000
const LEASE_MINUTES = 10
const MAX_ATTEMPTS = 3 // 首次执行 + 自动重试 2 次
const RETENTION_MS = 24 * 60 * 60 * 1_000

let stopping = false
let maintenanceAt = 0

type ExportJob = typeof adminExportJobs.$inferSelect

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asClaimedId(rows: unknown): number | null {
  const row = (rows as Array<{ id?: number | string }>)[0]
  const id = Number(row?.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function recoverExpiredLeases(): Promise<void> {
  await db.execute(sql`
    UPDATE admin_export_jobs
       SET status = 'queued',
           next_attempt_at = NOW(),
           lease_expires_at = NULL,
           error_code = 'WORKER_LEASE_EXPIRED',
           error_message = '导出任务执行超时，正在自动重试',
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

function outputFileName(base: string): string {
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || '导出数据'
  const timestamp = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }).replace(/:/g, '')
  return `${cleaned}_${shanghaiYmd()}${timestamp}.xlsx`
}

function safeFailure(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const parsed = parseErrorPrefix(message)
  if (parsed) return { code: parsed.prefix, message: parsed.displayMessage.slice(0, 500) }
  return { code: 'EXPORT_FAILED', message: '导出生成失败，系统将自动重试' }
}

async function failJob(job: ExportJob, err: unknown): Promise<void> {
  const failure = safeFailure(err)
  const shouldRetry = job.attemptCount < MAX_ATTEMPTS
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
      eq(adminExportJobs.status, 'ready'),
      lt(adminExportJobs.expiresAt, new Date()),
    ))
    .limit(100)

  for (const job of expired) {
    try {
      if (job.fileCloudPath) await deleteByCloudPaths([job.fileCloudPath])
      await db
        .update(adminExportJobs)
        .set({ status: 'expired', fileCloudPath: null, updatedAt: new Date() })
        .where(and(eq(adminExportJobs.id, job.id), eq(adminExportJobs.status, 'ready')))
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
  const exportType = parseExportType(job.exportType)
  if (!exportType) {
    await failJob(job, new Error('INVALID_STATE: 导出任务类型异常'))
    return
  }

  let tempDir: string | null = null
  let cloudPath: string | null = null
  let uploaded = false
  const heartbeat = setInterval(() => {
    void renewLease(job.id).catch((err) => console.error(`[export-worker] lease renew failed for ${job.id}:`, err))
  }, 30_000)
  heartbeat.unref()

  try {
    const session = parseExportSession(job.scopeSnapshot)
    const payload = parseExportPayload(exportType, job.requestPayload)
    tempDir = await mkdtemp(path.join(tmpdir(), 'fengyu-export-'))

    const output = await runWithExportSession(session, async () => {
      const content = await createExportContent(exportType, payload)
      const fileName = outputFileName(content.fileNameBase)
      const filePath = path.join(tempDir!, fileName)
      let lastProgress = 0
      const writeResult = await writeStreamXlsx({
        filePath,
        sheetName: content.sheetName,
        columns: content.columns,
        rows: content.rows,
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
      return
    }

    cloudPath = `admin/exports/${job.id}/${output.fileName}`
    await uploadFile(createReadStream(output.filePath), cloudPath)
    uploaded = true
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
    console.log(`[export-worker] job ${job.id} ready (${output.writeResult.rowCount} rows)`)
  } catch (err) {
    console.error(`[export-worker] job ${job.id} failed:`, err)
    if (uploaded && cloudPath) {
      await deleteByCloudPaths([cloudPath]).catch((cleanupError) => {
        console.error(`[export-worker] failed upload cleanup for ${job.id}:`, cleanupError)
      })
    }
    await failJob(job, err)
  } finally {
    clearInterval(heartbeat)
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      console.error(`[export-worker] temp cleanup failed for ${job.id}:`, err)
    })
  }
}

async function run(): Promise<void> {
  console.log('[export-worker] started (global concurrency: 1)')
  while (!stopping) {
    try {
      await runMaintenance()
      const job = await claimNextJob()
      if (job) {
        await processJob(job)
      } else {
        await sleep(POLL_INTERVAL_MS)
      }
    } catch (err) {
      console.error('[export-worker] loop error:', err)
      await sleep(POLL_INTERVAL_MS)
    }
  }
  console.log('[export-worker] stopped')
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })

if (process.argv.includes('--once')) {
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
