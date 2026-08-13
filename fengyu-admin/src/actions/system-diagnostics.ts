'use server'

import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { callClientFunction, callStaffFunction, probeCloudbaseStorage } from '@/lib/cloudbase'
import { logOperation } from '@/lib/operation-log'
import { requireAdmin } from '@/lib/permissions'
import { heartbeatLevel, readWorkerHeartbeat, type WorkerName } from '@/lib/worker-heartbeat'
import { withPermission } from '@/lib/with-permission'
import { probeWorkfineConnection } from '@/lib/workfine-mssql'

export type DiagnosticStatus = 'ok' | 'warn' | 'error' | 'disabled'

export interface DiagnosticItem {
  key: string
  label: string
  group: 'core' | 'cloud' | 'external'
  status: DiagnosticStatus
  value: string
  detail?: string
  latencyMs?: number
}

export interface SystemDiagnostics {
  generatedAt: string
  summary: Exclude<DiagnosticStatus, 'disabled'>
  items: DiagnosticItem[]
}

export interface BackupStatusView {
  id: string
  kind: 'scheduled' | 'manual'
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  createdAt: string
  updatedAt: string
  completedAt?: string
  sizeBytes?: number
  errorCode?: 'INSUFFICIENT_SPACE' | 'BACKUP_FAILED'
  message?: string
}

export interface BackupCapacityView {
  checkedAt: string
  totalBytes: number
  freeBytes: number
  databaseBytes: number
  estimatedRequiredBytes: number
  warning: boolean
  sufficient: boolean
}

export interface BackupOverview {
  capacity: BackupCapacityView | null
  statuses: BackupStatusView[]
  active: boolean
  schedule: string
  scheduledRetentionDays: number
  manualRetentionDays: number
}

const TIMEOUT_MS = 8_000

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

async function timedProbe(
  item: Omit<DiagnosticItem, 'status' | 'value' | 'latencyMs'>,
  probe: () => Promise<void>,
  successValue = '连接正常',
): Promise<DiagnosticItem> {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
      }),
    ])
    return { ...item, status: 'ok', value: successValue, latencyMs: elapsed(startedAt) }
  } catch {
    return { ...item, status: 'error', value: '检查失败', detail: item.detail || '请查看对应服务日志。', latencyMs: elapsed(startedAt) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function disabledItem(key: string, label: string, group: DiagnosticItem['group'], detail: string): DiagnosticItem {
  return { key, label, group, status: 'disabled', value: '未启用', detail }
}

function signedPayload(service: string): Record<string, string> {
  const secret = process.env.CLIENT_SECRET?.trim()
  if (!secret) throw new Error('INVALID_STATE: CLIENT_SECRET is not configured')
  const timestamp = String(Date.now())
  const nonce = randomUUID()
  const signature = createHmac('sha256', secret)
    .update(`${service}\n${timestamp}\n${nonce}`)
    .digest('hex')
  return { service, timestamp, nonce, signature }
}

async function verifyCloudFunctionResult(result: unknown): Promise<void> {
  const response = result as { code?: number; data?: { ok?: boolean } }
  if (response?.code !== 0 || response.data?.ok !== true) throw new Error('INVALID_STATE: cloud function unhealthy')
}

async function fetchGateway(url: string, headers?: HeadersInit): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', headers, signal: controller.signal, cache: 'no-store' })
    if (response.status >= 500) throw new Error('INVALID_STATE: gateway unavailable')
  } finally {
    clearTimeout(timeout)
  }
}

async function workerItem(worker: WorkerName, label: string): Promise<DiagnosticItem> {
  const heartbeat = await readWorkerHeartbeat(worker)
  const status = heartbeatLevel(heartbeat)
  if (!heartbeat) return { key: worker, label, group: 'core', status, value: '未检测到心跳', detail: '请确认容器已启动且共享状态目录已挂载。' }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(heartbeat.updatedAt)) / 1_000))
  return {
    key: worker,
    label,
    group: 'core',
    status,
    value: heartbeat.state === 'busy' ? '正在执行任务' : '运行中',
    detail: `最近心跳 ${ageSeconds} 秒前${heartbeat.detail ? `；${heartbeat.detail}` : ''}`,
  }
}

async function analystItem(): Promise<DiagnosticItem> {
  const origin = (process.env.ANALYST_INTERNAL_ORIGIN || process.env.ANALYST_PUBLIC_ORIGIN || process.env.NEXT_PUBLIC_ANALYST_ORIGIN || '').trim()
  if (!origin) return disabledItem('analyst', '数据分析系统', 'core', '未配置 Analyst 地址。')
  const secret = (process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET || '').trim()
  if (!secret) return { key: 'analyst', label: '数据分析系统', group: 'core', status: 'error', value: '签名密钥未配置' }
  const service = 'analyst'
  const timestamp = String(Date.now())
  const nonce = randomUUID()
  const signature = createHmac('sha256', secret).update(`${service}\n${timestamp}\n${nonce}`).digest('hex')
  return timedProbe(
    { key: 'analyst', label: '数据分析系统', group: 'core' },
    async () => {
      const url = new URL('/api/health', origin)
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { 'x-health-timestamp': timestamp, 'x-health-nonce': nonce, 'x-health-signature': signature },
      })
      const body = await response.json() as { ok?: boolean }
      if (!response.ok || body.ok !== true) throw new Error('INVALID_STATE: analyst unhealthy')
    },
  )
}

function configuredGatewayItem(options: {
  key: string
  label: string
  configured: boolean
  url: string
  disabledDetail: string
}): Promise<DiagnosticItem> | DiagnosticItem {
  if (!options.configured) return disabledItem(options.key, options.label, 'external', options.disabledDetail)
  return timedProbe(
    { key: options.key, label: options.label, group: 'external', detail: '仅校验配置与网关可达性，不调用计费接口。' },
    () => fetchGateway(options.url),
    '配置完整，网关可达',
  )
}

export const getSystemDiagnostics = withPermission(
  'system:diagnostics',
  async (): Promise<SystemDiagnostics> => {
    const workfineConfigured = Boolean(process.env.MSSQL_CONNECTION_STRING || process.env.MSSQL_SERVER)
    const ocrMode = (process.env.ALIYUN_OCR_MODE || 'real').toLowerCase()
    const ocrConfigured = ocrMode === 'mock' || Boolean(
      (process.env.ALIYUN_OCR_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID)
      && (process.env.ALIYUN_OCR_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET),
    )
    const aiBase = process.env.OPENAI_BASE_URL || process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1'
    const aiConfigured = Boolean(process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY)

    const results = await Promise.all([
      timedProbe(
        { key: 'admin', label: '管理后台', group: 'core' },
        async () => undefined,
        '运行中',
      ),
      timedProbe(
        { key: 'postgresql', label: 'PostgreSQL 业务主库', group: 'core' },
        async () => { await db.execute(sql`SELECT 1`) },
      ),
      workerItem('cron-worker', '定时任务 / 备份 Worker'),
      workerItem('export-worker', '异步导出 Worker'),
      analystItem(),
      workfineConfigured
        ? timedProbe({ key: 'workfine', label: 'WorkFine 只读数据源', group: 'external' }, probeWorkfineConnection)
        : Promise.resolve(disabledItem('workfine', 'WorkFine 只读数据源', 'external', '未配置 WorkFine 连接。')),
      timedProbe(
        { key: 'clientApi', label: 'clientApi 云函数', group: 'cloud' },
        async () => verifyCloudFunctionResult(await callClientFunction('clientApi', { action: 'system.health', payload: signedPayload('clientApi') })),
      ),
      timedProbe(
        { key: 'payNotify', label: 'payNotify 云函数', group: 'cloud' },
        async () => verifyCloudFunctionResult(await callClientFunction('payNotify', { action: 'system.health', payload: signedPayload('payNotify') })),
      ),
      timedProbe(
        { key: 'staffApi', label: 'staffApi 云函数', group: 'cloud' },
        async () => verifyCloudFunctionResult(await callStaffFunction('staffApi', { action: 'system.health', payload: signedPayload('staffApi') })),
      ),
      timedProbe({ key: 'cloudbaseStorage', label: 'CloudBase 对象存储', group: 'cloud' }, probeCloudbaseStorage),
      Promise.resolve(configuredGatewayItem({
        key: 'wechat', label: '微信开放平台',
        configured: Boolean(process.env.WX_CLIENT_APPID && process.env.WX_CLIENT_SECRET),
        url: 'https://api.weixin.qq.com', disabledDetail: '小程序 AppID / Secret 未配置。',
      })),
      Promise.resolve(configuredGatewayItem({
        key: 'tmap', label: '腾讯位置服务', configured: Boolean(process.env.TMAP_KEY && process.env.TMAP_SECRET),
        url: 'https://apis.map.qq.com', disabledDetail: '地图密钥未配置。',
      })),
      Promise.resolve(configuredGatewayItem({
        key: 'ocr', label: '阿里云 OCR', configured: ocrConfigured,
        url: `https://${process.env.ALIYUN_OCR_ENDPOINT || 'ocr-api.cn-hangzhou.aliyuncs.com'}`,
        disabledDetail: 'OCR 功能未配置。',
      })),
      Promise.resolve(configuredGatewayItem({
        key: 'ai', label: 'AI 模型网关', configured: aiConfigured,
        url: aiBase, disabledDetail: 'AI 功能未配置。',
      })),
    ])
    const items = results.flat() as DiagnosticItem[]
    const summary = items.some((item) => item.status === 'error')
      ? 'error'
      : items.some((item) => item.status === 'warn') ? 'warn' : 'ok'
    return { generatedAt: new Date().toISOString(), summary, items }
  },
)

function backupControlDir(): string {
  return process.env.DATABASE_BACKUP_REQUEST_DIR?.trim() || '/var/lib/fengyu/backup-control'
}

function isBackupStatus(value: unknown): value is BackupStatusView {
  const status = value as Partial<BackupStatusView> | null
  return Boolean(
    status
    && typeof status.id === 'string'
    && (status.kind === 'manual' || status.kind === 'scheduled')
    && ['queued', 'running', 'succeeded', 'failed'].includes(String(status.state))
    && typeof status.createdAt === 'string'
    && typeof status.updatedAt === 'string',
  )
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function readBackupOverview(): Promise<BackupOverview> {
  const controlDir = backupControlDir()
  const stateDir = path.join(controlDir, 'states')
  const files = await readdir(stateDir).catch(() => [])
  const statuses = (await Promise.all(
    files.filter((name) => /^[0-9a-f-]+\.json$/.test(name)).map((name) => readJson(path.join(stateDir, name))),
  ))
    .filter(isBackupStatus)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 20)
  const capacityValue = await readJson(path.join(controlDir, 'capacity.json'))
  const capacity = capacityValue && typeof capacityValue === 'object'
    ? capacityValue as BackupCapacityView
    : null
  const active = statuses.some((status) => status.state === 'queued' || status.state === 'running')
  return {
    capacity,
    statuses,
    active,
    schedule: '每天 03:00（Asia/Shanghai）',
    scheduledRetentionDays: Number(process.env.SCHEDULED_BACKUP_RETENTION_DAYS || 7),
    manualRetentionDays: Number(process.env.MANUAL_BACKUP_RETENTION_DAYS || 30),
  }
}

export const getDatabaseBackupOverview = withPermission(
  'system:diagnostics',
  async (): Promise<BackupOverview> => readBackupOverview(),
)

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await rename(temp, filePath)
}

async function clearStaleManualSentinel(sentinel: string): Promise<void> {
  const info = await stat(sentinel).catch(() => null)
  if (!info || Date.now() - info.mtimeMs < 6 * 60 * 60 * 1_000) return
  await rm(sentinel, { force: true })
}

export const queueManualDatabaseBackup = withPermission(
  'system:diagnostics',
  async (session): Promise<{ success: true; id: string; message: string }> => {
    requireAdmin(session)
    const overview = await readBackupOverview()
    if (!overview.capacity) throw new Error('INVALID_STATE: 备份 Worker 尚未上报磁盘空间，请稍后重试')
    if (!overview.capacity.sufficient) throw new Error('INVALID_STATE: 磁盘剩余空间不足，无法创建备份')

    const controlDir = backupControlDir()
    const requestDir = path.join(controlDir, 'requests')
    const stateDir = path.join(controlDir, 'states')
    await mkdir(requestDir, { recursive: true, mode: 0o700 })
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const sentinel = path.join(controlDir, 'manual-active.lock')
    await clearStaleManualSentinel(sentinel)
    let lock: Awaited<ReturnType<typeof open>>
    try {
      lock = await open(sentinel, 'wx', 0o600)
    } catch {
      throw new Error('CONFLICT: 已有备份任务在队列中或执行中')
    }

    const id = randomUUID()
    const now = new Date().toISOString()
    try {
      await lock.writeFile(`${id}\n`)
      await lock.close()
      await atomicJson(path.join(stateDir, `${id}.json`), {
        id, kind: 'manual', state: 'queued', createdAt: now, updatedAt: now,
        message: '已进入备份队列',
      } satisfies BackupStatusView)
      await atomicJson(path.join(requestDir, `${id}.json`), {
        id, kind: 'manual', requestedAt: now, requestedBy: session.employeeId,
      })
    } catch (error) {
      await lock.close().catch(() => undefined)
      await rm(sentinel, { force: true })
      throw error
    }
    await logOperation(session, 'database_backup.queue', 'database_backup', id, { kind: 'manual' })
    revalidatePath('/settings/diagnostics')
    return { success: true, id, message: '手动备份已进入队列' }
  },
)
