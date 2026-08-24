import { describe, expect, it } from 'vitest'
import { heartbeatLevel, type WorkerHeartbeat } from './worker-heartbeat'

function heartbeat(updatedAt: string): WorkerHeartbeat {
  return { worker: 'cron-worker', pid: 1, updatedAt, state: 'idle' }
}

describe('worker heartbeat level', () => {
  const now = Date.parse('2026-08-13T04:00:00.000Z')

  it('在 90 秒内为正常', () => {
    expect(heartbeatLevel(heartbeat('2026-08-13T03:59:00.000Z'), now)).toBe('ok')
  })

  it('90~180 秒为警告，超过 180 秒为异常', () => {
    expect(heartbeatLevel(heartbeat('2026-08-13T03:57:45.000Z'), now)).toBe('warn')
    expect(heartbeatLevel(heartbeat('2026-08-13T03:56:59.000Z'), now)).toBe('error')
    expect(heartbeatLevel(null, now)).toBe('error')
  })
})
