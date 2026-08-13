import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { notifyOps } from './lib/notify'

export type BackupKind = 'scheduled' | 'manual'
export type BackupState = 'queued' | 'running' | 'succeeded' | 'failed'

export interface BackupRequest {
  id: string
  kind: 'manual'
  requestedAt: string
  requestedBy: string
}

export interface BackupStatus {
  id: string
  kind: BackupKind
  state: BackupState
  createdAt: string
  updatedAt: string
  completedAt?: string
  sizeBytes?: number
  errorCode?: 'INSUFFICIENT_SPACE' | 'BACKUP_FAILED'
  message?: string
}

export interface BackupCapacity {
  checkedAt: string
  totalBytes: number
  freeBytes: number
  databaseBytes: number
  estimatedRequiredBytes: number
  warning: boolean
  sufficient: boolean
}

const MIB = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1_000
const BACKUP_FILE_PATTERN = /^fengyu-(scheduled|manual)-\d{8}T\d{6}Z-[0-9a-f-]+\.dump$/

export function backupControlDir(): string {
  return process.env.DATABASE_BACKUP_REQUEST_DIR?.trim() || '/var/lib/fengyu/backup-control'
}

export function backupDataDir(): string {
  return process.env.DATABASE_BACKUP_DIR?.trim() || '/var/lib/fengyu/database-backups'
}

function requestsDir(): string { return path.join(backupControlDir(), 'requests') }
function statesDir(): string { return path.join(backupControlDir(), 'states') }
function capacityPath(): string { return path.join(backupControlDir(), 'capacity.json') }
function scheduledMarkerPath(): string { return path.join(backupControlDir(), 'scheduled-day.txt') }

async function ensureDirectories(): Promise<void> {
  for (const dir of [backupControlDir(), requestsDir(), statesDir(), backupDataDir()]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temp, filePath)
}

async function databaseSizeBytes(): Promise<number> {
  const rows = await db.execute(sql`SELECT pg_database_size(current_database())::text AS size`)
  const value = Number((rows as unknown as Array<{ size: string }>)[0]?.size)
  if (!Number.isFinite(value) || value < 0) throw new Error('unable to determine database size')
  return value
}

async function lastSuccessfulDumpBytes(): Promise<number> {
  const names = await readdir(backupDataDir()).catch(() => [])
  let latest: { mtime: number; size: number } | null = null
  for (const name of names) {
    if (!BACKUP_FILE_PATTERN.test(name)) continue
    const info = await stat(path.join(backupDataDir(), name)).catch(() => null)
    if (info?.isFile() && (!latest || info.mtimeMs > latest.mtime)) {
      latest = { mtime: info.mtimeMs, size: info.size }
    }
  }
  return latest?.size ?? 0
}

export function estimateBackupBytes(databaseBytes: number, lastDumpBytes: number): number {
  return Math.ceil(Math.max(256 * MIB, databaseBytes * 1.2, lastDumpBytes * 1.5))
}

export async function publishBackupCapacity(): Promise<BackupCapacity> {
  await ensureDirectories()
  const [fsInfo, databaseBytes, lastDumpBytes] = await Promise.all([
    statfs(backupDataDir()),
    databaseSizeBytes(),
    lastSuccessfulDumpBytes(),
  ])
  const totalBytes = Number(fsInfo.blocks) * Number(fsInfo.bsize)
  const freeBytes = Number(fsInfo.bavail) * Number(fsInfo.bsize)
  const estimatedRequiredBytes = estimateBackupBytes(databaseBytes, lastDumpBytes)
  const projectedFree = Math.max(0, freeBytes - estimatedRequiredBytes)
  const capacity: BackupCapacity = {
    checkedAt: new Date().toISOString(),
    totalBytes,
    freeBytes,
    databaseBytes,
    estimatedRequiredBytes,
    sufficient: freeBytes >= estimatedRequiredBytes,
    warning: totalBytes > 0 && projectedFree / totalBytes < 0.1,
  }
  await atomicJson(capacityPath(), capacity)
  return capacity
}

async function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: env || process.env })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code}: ${stderr.replace(/\s+/g, ' ').trim()}`))
    })
  })
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

async function writeStatus(status: BackupStatus): Promise<void> {
  await atomicJson(path.join(statesDir(), `${status.id}.json`), status)
}

async function recordBackupOutcome(status: BackupStatus, requestedBy?: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO operation_logs (
      operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
    )
    VALUES (
      ${requestedBy || null},
      ${requestedBy ? sql`(SELECT name FROM staff_wechat_users WHERE employee_id = ${requestedBy})` : null},
      ${status.state === 'succeeded' ? 'database_backup.succeeded' : 'database_backup.failed'},
      'database_backup',
      ${status.id},
      jsonb_build_object(
        'kind', ${status.kind},
        'state', ${status.state},
        'sizeBytes', ${status.sizeBytes || null},
        'errorCode', ${status.errorCode || null}
      ),
      'cronTask',
      NOW()
    )
  `)
}

async function cleanupBackups(now = Date.now()): Promise<void> {
  const names = await readdir(backupDataDir()).catch(() => [])
  for (const name of names) {
    if (name.endsWith('.partial')) {
      const info = await stat(path.join(backupDataDir(), name)).catch(() => null)
      if (info && now - info.mtimeMs > DAY_MS) await rm(path.join(backupDataDir(), name), { force: true })
      continue
    }
    const match = BACKUP_FILE_PATTERN.exec(name)
    if (!match) continue
    const retentionDays = match[1] === 'manual'
      ? Number(process.env.MANUAL_BACKUP_RETENTION_DAYS || 30)
      : Number(process.env.SCHEDULED_BACKUP_RETENTION_DAYS || 7)
    const info = await stat(path.join(backupDataDir(), name)).catch(() => null)
    if (info && now - info.mtimeMs > retentionDays * DAY_MS) {
      await rm(path.join(backupDataDir(), name), { force: true })
    }
  }

  const stateFiles = await readdir(statesDir()).catch(() => [])
  for (const name of stateFiles) {
    if (!/^[0-9a-f-]+\.json$/.test(name)) continue
    const info = await stat(path.join(statesDir(), name)).catch(() => null)
    if (info && now - info.mtimeMs > 30 * DAY_MS) await rm(path.join(statesDir(), name), { force: true })
  }
}

async function acquireBackupLock(): Promise<() => Promise<void>> {
  const lockPath = path.join(backupControlDir(), 'backup.lock')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    const info = await stat(lockPath).catch(() => null)
    if (!info || Date.now() - info.mtimeMs < 6 * 60 * 60 * 1_000) throw error
    console.warn('[database-backup] removing stale backup lock')
    await rm(lockPath, { force: true })
    handle = await open(lockPath, 'wx', 0o600)
  }
  return async () => {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true })
  }
}

export async function performDatabaseBackup(
  kind: BackupKind,
  id: string = randomUUID(),
  requestedBy?: string,
): Promise<BackupStatus> {
  await ensureDirectories()
  const createdAt = new Date().toISOString()
  let release: (() => Promise<void>) | null = null
  let partialPath: string | null = null
  const running: BackupStatus = { id, kind, state: 'running', createdAt, updatedAt: createdAt }
  await writeStatus(running)
  try {
    release = await acquireBackupLock()
    const capacity = await publishBackupCapacity()
    if (!capacity.sufficient) {
      const status: BackupStatus = {
        ...running,
        state: 'failed',
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        errorCode: 'INSUFFICIENT_SPACE',
        message: '磁盘剩余空间不足，未执行备份',
      }
      await writeStatus(status)
      await recordBackupOutcome(status, requestedBy).catch((error) => console.error('[database-backup] audit log failed:', error))
      await notifyOps(`⚠️ 数据库备份已阻断：磁盘剩余空间不足（${kind}）`)
      return status
    }

    const databaseUrl = process.env.DATABASE_URL || process.env.E2E_DATABASE_URL
    if (!databaseUrl) throw new Error('DATABASE_URL is not configured')
    const parsedDatabaseUrl = new URL(databaseUrl)
    const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''))
    if (!databaseName) throw new Error('DATABASE_URL database name is missing')
    // 不把含密码 URL 放入进程参数；连接信息只通过子进程环境传递。
    const pgEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PGHOST: parsedDatabaseUrl.hostname,
      PGPORT: parsedDatabaseUrl.port || '5432',
      PGDATABASE: databaseName,
      PGUSER: decodeURIComponent(parsedDatabaseUrl.username),
      PGPASSWORD: decodeURIComponent(parsedDatabaseUrl.password),
      ...(parsedDatabaseUrl.searchParams.get('sslmode')
        ? { PGSSLMODE: parsedDatabaseUrl.searchParams.get('sslmode')! }
        : {}),
    }
    const fileName = `fengyu-${kind}-${timestampForFile()}-${id}.dump`
    const finalPath = path.join(backupDataDir(), fileName)
    partialPath = `${finalPath}.partial`
    await runCommand('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', partialPath], pgEnv)
    await chmod(partialPath, 0o600)
    await runCommand('pg_restore', ['--list', partialPath])
    await rename(partialPath, finalPath)
    partialPath = null
    const info = await stat(finalPath)
    const completedAt = new Date().toISOString()
    const status: BackupStatus = {
      ...running,
      state: 'succeeded',
      updatedAt: completedAt,
      completedAt,
      sizeBytes: info.size,
      message: '备份已完成并通过完整性校验',
    }
    await writeStatus(status)
    await recordBackupOutcome(status, requestedBy).catch((error) => console.error('[database-backup] audit log failed:', error))
    await cleanupBackups()
    await publishBackupCapacity()
    return status
  } catch (error) {
    const completedAt = new Date().toISOString()
    const status: BackupStatus = {
      ...running,
      state: 'failed',
      updatedAt: completedAt,
      completedAt,
      errorCode: 'BACKUP_FAILED',
      message: '备份执行失败，请查看 cron worker 日志',
    }
    await writeStatus(status)
    await recordBackupOutcome(status, requestedBy).catch((auditError) => console.error('[database-backup] audit log failed:', auditError))
    await notifyOps(`⚠️ 数据库备份执行失败（${kind}），请查看 cron worker 日志。`)
    console.error('[database-backup] failed:', error instanceof Error ? error.message : error)
    return status
  } finally {
    if (partialPath) await rm(partialPath, { force: true }).catch(() => undefined)
    if (release) await release()
  }
}

export async function processManualBackupRequests(): Promise<void> {
  await ensureDirectories()
  const names = (await readdir(requestsDir())).filter((name) => /^[0-9a-f-]+\.json$/.test(name)).sort()
  const name = names[0]
  if (!name) return
  const requestPath = path.join(requestsDir(), name)
  const claimedPath = `${requestPath}.running`
  try {
    await rename(requestPath, claimedPath)
  } catch {
    return
  }
  try {
    const request = JSON.parse(await readFile(claimedPath, 'utf8')) as BackupRequest
    if (request.kind !== 'manual' || request.id !== name.replace(/\.json$/, '')) throw new Error('invalid backup request')
    await performDatabaseBackup('manual', request.id, request.requestedBy)
  } finally {
    await rm(claimedPath, { force: true })
    await rm(path.join(backupControlDir(), 'manual-active.lock'), { force: true })
  }
}

function beijingDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now)
}

export async function runScheduledBackupIfDue(now = new Date()): Promise<BackupStatus | null> {
  await ensureDirectories()
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now))
  if (hour < 3) return null
  const day = beijingDay(now)
  const previous = await readFile(scheduledMarkerPath(), 'utf8').catch(() => '')
  if (previous.trim() === day) return null
  const status = await performDatabaseBackup('scheduled')
  // 每天至多尝试一次，失败原因保留在状态中，避免故障时每 5 秒重试打满数据库/磁盘。
  await writeFile(scheduledMarkerPath(), `${day}\n`, { mode: 0o600 })
  return status
}

export async function maintainBackupRuntime(): Promise<void> {
  await publishBackupCapacity()
  await cleanupBackups()
}
