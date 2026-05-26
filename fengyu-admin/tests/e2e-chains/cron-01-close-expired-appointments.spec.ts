/**
 * cron-01：STEP 1 closeExpiredAppointments 端到端
 *
 * 关键事实（src/cron/steps/close-expired-appointments.ts）：
 *   - 关闭 status IN ('待确认','已确认') AND checkin_at IS NULL
 *     AND appointment_time < date_trunc('day', NOW())（预约日期早于今天）
 *   - 按"预约日期"判定：当天的预约即便时刻已过也不关闭，要到次日 03:00 才关
 *   - 已签到（checkin_at 非空）不关闭
 *   - 已关闭/已取消/已完成 不动
 *   - closed > 0 时写 1 条聚合 operation_logs（target_id = dateStampOf(ctx)）
 *   - closed = 0 时不写日志
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'
import { getAppointmentStatus, countOperationLogs } from './_helpers/cron-asserts'

interface CloseResult {
  closed: number
  ids: string[]
}

function runClose(referenceDate: string): CloseResult {
  const out = runCronStep('closeExpiredAppointments', { referenceDate })
  const summary = parseStepSummary<CloseResult>(out, 'closeExpiredAppointments')
  if (!summary) throw new Error(`closeExpired summary 解析失败:\n${out}`)
  return summary
}

function ensureTestStoreEmployee(): { storeId: string; employeeId: string; employeeName: string } {
  const storeId = psql(`SELECT store_id FROM stores LIMIT 1`)
  const row = psql(
    `SELECT employee_id || '||' || COALESCE(name, employee_id) FROM staff_wechat_users WHERE COALESCE(is_resigned, FALSE) = FALSE LIMIT 1`,
  )
  if (!storeId || !row) throw new Error('需要 stores + staff_wechat_users 行')
  const [employeeId, employeeName] = row.split('||')
  return { storeId, employeeId, employeeName }
}

const REAL = ensureTestStoreEmployee()

function insertAppointment(opt: {
  suffix: string
  clientUserId: string
  clientName: string
  appointmentTime: string // ISO + timezone
  status: '待确认' | '已确认' | '已关闭' | '已取消' | '已完成'
  checkinAt?: string // ISO + timezone；省略则 NULL（未签到）
}): string {
  const aid = `${PREFIX.APT}${opt.suffix}`
  const checkinSql = opt.checkinAt ? `'${opt.checkinAt}'::timestamptz` : 'NULL'
  psql(`
    INSERT INTO appointments (
      appointment_id, store_id, client_user_id, client_name,
      employee_id, employee_name,
      appointment_time, checkin_at, status, created_at, updated_at
    )
    VALUES (
      '${aid}', '${REAL.storeId}', '${opt.clientUserId}', '${opt.clientName.replace(/'/g, "''")}',
      '${REAL.employeeId}', '${REAL.employeeName.replace(/'/g, "''")}',
      '${opt.appointmentTime}'::timestamptz, ${checkinSql}, '${opt.status}', NOW(), NOW()
    )
    ON CONFLICT (appointment_id) DO UPDATE SET
      appointment_time = EXCLUDED.appointment_time,
      checkin_at = EXCLUDED.checkin_at,
      status = EXCLUDED.status,
      updated_at = NOW()
  `)
  return aid
}

test.describe.serial('cron-01 closeExpiredAppointments', () => {
  test.beforeAll(() => cleanupCronE2E())
  test.afterAll(() => cleanupCronE2E())

  test('1.1 预约日期早于今天（待确认）→ 关闭 + 写聚合 operation_logs', () => {
    const uid = upsertClient('APT_11', { customerType: '会员客' })
    const aid = insertAppointment({
      suffix: 'APT_11',
      clientUserId: uid, clientName: 'CRON_E2E_APT',
      appointmentTime: '2026-11-19 02:00:00+0800', // referenceDate=2026-11-20 → 前一日预约
      status: '待确认',
    })
    const result = runClose('2026-11-20')
    expect(result.closed).toBeGreaterThanOrEqual(1)
    expect(result.ids).toContain(aid)
    expect(getAppointmentStatus(aid)).toBe('已关闭')

    // operation_log 写到 target_id = dateStamp = '2026-11-20'
    expect(countOperationLogs('cron.close_expired_appointments', '2026-11-20')).toBeGreaterThanOrEqual(1)
  })

  test('1.2 当天预约即便时刻已过也不关闭（按日期判定）', () => {
    const uid = upsertClient('APT_12', { customerType: '会员客' })
    const aid = insertAppointment({
      suffix: 'APT_12',
      clientUserId: uid, clientName: 'CRON_E2E_APT',
      // referenceDate=2026-11-20 03:00；预约在同一天 02:00（时刻已过但仍是"今天"）→ 不关闭
      appointmentTime: '2026-11-20 02:00:00+0800',
      status: '待确认',
    })
    runClose('2026-11-20')
    expect(getAppointmentStatus(aid)).toBe('待确认')
  })

  test('1.3 已关闭重跑幂等：不再操作', () => {
    // 接续 1.1 的 aid 已关闭
    const aid = `${PREFIX.APT}APT_11`
    const result = runClose('2026-11-20')
    expect(result.ids).not.toContain(aid)
    expect(getAppointmentStatus(aid)).toBe('已关闭')
  })

  test('1.4 已确认状态也关闭', () => {
    const uid = upsertClient('APT_14', { customerType: '会员客' })
    const aid = insertAppointment({
      suffix: 'APT_14',
      clientUserId: uid, clientName: 'CRON_E2E_APT',
      appointmentTime: '2026-11-18 12:00:00+0800',
      status: '已确认',
    })
    runClose('2026-11-20')
    expect(getAppointmentStatus(aid)).toBe('已关闭')
  })

  test('1.5 未来时间不动', () => {
    const uid = upsertClient('APT_15', { customerType: '会员客' })
    const aid = insertAppointment({
      suffix: 'APT_15',
      clientUserId: uid, clientName: 'CRON_E2E_APT',
      appointmentTime: '2026-11-21 10:00:00+0800', // 未来
      status: '待确认',
    })
    runClose('2026-11-20')
    expect(getAppointmentStatus(aid)).toBe('待确认')
  })

  test('1.6 closed=0 时不写 operation_log', () => {
    // 清掉所有当前命名空间，确保 closed=0
    cleanupCronE2E()
    const before = countOperationLogs('cron.close_expired_appointments', '2026-11-21')
    const result = runClose('2026-11-21') // 用不同日期戳避免与 1.1 串
    expect(result.closed).toBe(0)
    expect(countOperationLogs('cron.close_expired_appointments', '2026-11-21')).toBe(before) // 无新增
  })

  test('1.7 已取消/已完成状态不动（status 不在 IN 子句）', () => {
    const uidA = upsertClient('APT_17A', { customerType: '会员客' })
    const uidB = upsertClient('APT_17B', { customerType: '会员客' })
    const aidA = insertAppointment({
      suffix: 'APT_17A',
      clientUserId: uidA,
      clientName: 'CRON_E2E_APT_A',
      appointmentTime: '2026-11-18 12:00:00+0800',
      status: '已取消',
    })
    const aidB = insertAppointment({
      suffix: 'APT_17B',
      clientUserId: uidB,
      clientName: 'CRON_E2E_APT_B',
      appointmentTime: '2026-11-18 12:00:00+0800',
      status: '已完成',
    })
    runClose('2026-11-20')
    expect(getAppointmentStatus(aidA)).toBe('已取消')
    expect(getAppointmentStatus(aidB)).toBe('已完成')
  })

  test('1.8 已签到（checkin_at 非空）+ 过期 → 不关闭', () => {
    const uid = upsertClient('APT_18', { customerType: '会员客' })
    const aid = insertAppointment({
      suffix: 'APT_18',
      clientUserId: uid, clientName: 'CRON_E2E_APT',
      appointmentTime: '2026-11-18 12:00:00+0800', // 前几日，已过期
      status: '已确认',
      checkinAt: '2026-11-18 12:30:00+0800', // 已签到 → 不应被关闭
    })
    const result = runClose('2026-11-20')
    expect(result.ids).not.toContain(aid)
    expect(getAppointmentStatus(aid)).toBe('已确认')
  })
})
