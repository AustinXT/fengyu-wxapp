import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ busy: false, lockError: false, commands: [] as string[] }))
vi.mock('@/db', () => ({ db: { execute: vi.fn(async () => [{ size: '100' }]) } }))
vi.mock('./lib/notify', () => ({ notifyOps: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawnMock = (command: string) => {
  runtime.commands.push(command)
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end: () => void } }
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = { end: () => queueMicrotask(() => child.emit('close', 0)) }
  queueMicrotask(() => {
    if (command === 'flock') {
      if (runtime.lockError) child.emit('error', new Error('flock missing'))
      else if (runtime.busy) child.emit('close', 75)
      else child.stdout.emit('data', Buffer.from('locked\n'))
    } else child.emit('close', 1) // pg_dump 故障不会访问任何业务库。
  })
  return child
  }
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } }
})
import { maintainBackupRuntime, runScheduledBackupIfDue, processManualBackupRequests } from './database-backup'

let root: string
const id = 'a0000000-0000-4000-8000-000000000001'
const now = new Date('2026-10-03T04:00:00Z')
const partial = `fengyu-scheduled-20261003T030000Z-${id}.dump.partial`
const file = (name: string) => path.join(root, 'control', name)

beforeEach(async () => {
  runtime.busy = false; runtime.lockError = false; runtime.commands = []
  root = await mkdtemp(path.join(os.tmpdir(), 'backup-255-'))
  vi.stubEnv('DATABASE_BACKUP_REQUEST_DIR', path.join(root, 'control'))
  vi.stubEnv('DATABASE_BACKUP_DIR', path.join(root, 'data'))
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test')
  await mkdir(file('states'), { recursive: true }); await mkdir(file('requests'))
  await mkdir(path.join(root, 'data'))
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function interrupted() {
  await writeFile(file(`states/${id}.json`), JSON.stringify({ id, kind: 'scheduled', state: 'running', createdAt: now.toISOString(), updatedAt: now.toISOString() }))
  await writeFile(file('backup.lock'), '')
  await writeFile(file('scheduled-day.txt'), '2026-10-03\n')
  await writeFile(path.join(root, 'data', partial), 'partial')
}

describe('备份重启恢复与部署互斥', () => {
  it('立即清理三种残留、标失败可诊断，补跑当天定时备份', async () => {
    await interrupted()
    await maintainBackupRuntime()
    const recovered = JSON.parse(await readFile(file(`states/${id}.json`), 'utf8'))
    expect(recovered.state).toBe('failed'); expect(recovered.message).toContain('中断')
    expect(await stat(file('backup.lock')).catch(() => null)).toBeNull()
    expect(await stat(path.join(root, 'data', partial)).catch(() => null)).toBeNull()
    expect(await stat(file('scheduled-day.txt')).catch(() => null)).toBeNull()
    await runScheduledBackupIfDue(now)
    expect(runtime.commands).toContain('pg_dump')
    expect((await readFile(file('scheduled-day.txt'), 'utf8')).trim()).toBe('2026-10-03')
    const count = runtime.commands.length
    await runScheduledBackupIfDue(now)
    expect(runtime.commands).toHaveLength(count) // 普通失败仍每天一次，避免打满数据库。
  })

  it('锁被部署/活备份占用时不清残留、不落定时标记', async () => {
    await interrupted(); runtime.busy = true
    await maintainBackupRuntime()
    expect(JSON.parse(await readFile(file(`states/${id}.json`), 'utf8')).state).toBe('running')
    expect(await stat(path.join(root, 'data', partial))).toBeTruthy()
    await rm(file('scheduled-day.txt'))
    expect(await runScheduledBackupIfDue(now)).toBeNull()
    expect(await stat(file('scheduled-day.txt')).catch(() => null)).toBeNull()
    expect(runtime.commands).not.toContain('pg_dump')
  })

  it('部署期间手动请求重新排队且保留 active 锁，空闲后可执行', async () => {
    await writeFile(file(`requests/${id}.json`), JSON.stringify({ id, kind: 'manual', requestedBy: 'test' }))
    await writeFile(file('manual-active.lock'), '')
    runtime.busy = true
    await processManualBackupRequests()
    expect(await stat(file(`requests/${id}.json`))).toBeTruthy()
    expect(await stat(file('manual-active.lock'))).toBeTruthy()
    runtime.busy = false
    await processManualBackupRequests()
    expect(runtime.commands).toContain('pg_dump')
    expect(await stat(file('manual-active.lock')).catch(() => null)).toBeNull()
  })

  it('清理孤儿手动请求，不删除成功备份与其它文件', async () => {
    await writeFile(file(`requests/${id}.json.running`), '{}')
    await writeFile(file('manual-active.lock'), '')
    const good = partial.replace(/\.partial$/, '')
    await writeFile(path.join(root, 'data', good), 'valid')
    await writeFile(path.join(root, 'data', 'unrelated.partial'), 'unrelated')
    await maintainBackupRuntime()
    expect(await stat(file(`requests/${id}.json.running`)).catch(() => null)).toBeNull()
    expect(await stat(file('manual-active.lock')).catch(() => null)).toBeNull()
    expect(await readFile(path.join(root, 'data', good), 'utf8')).toBe('valid')
    expect(await readFile(path.join(root, 'data', 'unrelated.partial'), 'utf8')).toBe('unrelated')
  })
  it('坏状态文件不拖垮维护；锁基础设施错误可诊断且定时当天不重试', async () => {
    await writeFile(file(`states/${id}.json`), 'broken-json')
    await maintainBackupRuntime()
    runtime.lockError = true
    const result = await runScheduledBackupIfDue(now)
    expect(result?.state).toBe('failed')
    expect(result?.message).toContain('备份锁不可用')
    expect((await readFile(file('scheduled-day.txt'), 'utf8')).trim()).toBe('2026-10-03')
    const count = runtime.commands.length
    await runScheduledBackupIfDue(now)
    expect(runtime.commands).toHaveLength(count)
  })

})
