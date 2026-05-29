import { describe, it, expect } from 'vitest'
import {
  nextState,
  canTransition,
  listLegalEvents,
  isTerminalStatus,
  TransitionError,
  type LakalaOnboardingStatus,
  type LakalaOnboardingEvent,
} from '../lakala-onboarding-state'

/**
 * 状态机覆盖（plan §1.5）：
 *   - 每个合法 transition 逐项验证 nextState 返回值
 *   - 每个状态尝试非法事件，断言抛 TransitionError 且 error.current/event 透传
 *   - 回退路径 contract_signing → draft + cancel 通配测试单独验证
 */

const ALL_STATUSES: LakalaOnboardingStatus[] = [
  'draft',
  'contract_signing',
  'contract_signed',
  'attachments_uploading',
  'submitted',
  'callback_pending',
  'approved',
  'rejected',
  'under_review',
  'appealing',
  'realname_pending',
  'completed',
  'cancelled',
]

const ALL_EVENTS: LakalaOnboardingEvent[] = [
  'apply_contract',
  'contract_apply_fail',
  'contract_signed_callback',
  'start_attachments',
  'submit_merchant',
  'await_callback',
  'callback_approved',
  'callback_rejected',
  'callback_manual',
  'submit_appeal',
  'appeal_resubmitted',
  'start_realname',
  'realname_success',
  'cancel',
]

/** 合法转换矩阵 — 与 lakala-onboarding-state.ts TRANSITIONS 对齐 */
const LEGAL: [LakalaOnboardingStatus, LakalaOnboardingEvent, LakalaOnboardingStatus][] = [
  ['draft', 'apply_contract', 'contract_signing'],
  ['draft', 'cancel', 'cancelled'],

  ['contract_signing', 'contract_signed_callback', 'contract_signed'],
  ['contract_signing', 'contract_apply_fail', 'draft'],
  ['contract_signing', 'cancel', 'cancelled'],

  ['contract_signed', 'start_attachments', 'attachments_uploading'],
  ['contract_signed', 'cancel', 'cancelled'],

  ['attachments_uploading', 'submit_merchant', 'submitted'],
  ['attachments_uploading', 'cancel', 'cancelled'],

  ['submitted', 'await_callback', 'callback_pending'],
  ['submitted', 'callback_approved', 'approved'],
  ['submitted', 'callback_rejected', 'rejected'],
  ['submitted', 'callback_manual', 'under_review'],
  ['submitted', 'cancel', 'cancelled'],

  ['callback_pending', 'callback_approved', 'approved'],
  ['callback_pending', 'callback_rejected', 'rejected'],
  ['callback_pending', 'callback_manual', 'under_review'],
  ['callback_pending', 'cancel', 'cancelled'],

  ['approved', 'start_realname', 'realname_pending'],
  ['approved', 'cancel', 'cancelled'],

  ['rejected', 'submit_appeal', 'appealing'],
  ['rejected', 'cancel', 'cancelled'],

  ['under_review', 'submit_appeal', 'appealing'],
  ['under_review', 'callback_approved', 'approved'],
  ['under_review', 'callback_rejected', 'rejected'],
  ['under_review', 'cancel', 'cancelled'],

  ['appealing', 'appeal_resubmitted', 'submitted'],
  ['appealing', 'cancel', 'cancelled'],

  ['realname_pending', 'realname_success', 'completed'],
  ['realname_pending', 'cancel', 'cancelled'],

  ['completed', 'cancel', 'cancelled'],
]

describe('nextState · 合法转换全覆盖', () => {
  for (const [from, event, to] of LEGAL) {
    it(`${from} --${event}--> ${to}`, () => {
      expect(nextState(from, event)).toBe(to)
    })
  }
})

describe('nextState · 非法转换全部抛 TransitionError', () => {
  // 对每个状态尝试所有事件；不在 LEGAL 表里的组合应抛错
  const legalSet = new Set(LEGAL.map(([s, e]) => `${s}|${e}`))
  for (const status of ALL_STATUSES) {
    for (const event of ALL_EVENTS) {
      if (legalSet.has(`${status}|${event}`)) continue
      it(`${status} --${event}--> ❌ throws TransitionError`, () => {
        try {
          nextState(status, event)
          throw new Error('expected to throw, but did not')
        } catch (e) {
          expect(e).toBeInstanceOf(TransitionError)
          expect((e as TransitionError).current).toBe(status)
          expect((e as TransitionError).event).toBe(event)
          expect((e as TransitionError).code).toBe('INVALID_STATE: LAKALA_TRANSITION_BLOCKED')
          expect((e as Error).message).toContain(status)
          expect((e as Error).message).toContain(event)
        }
      })
    }
  }
})

describe('canTransition · 不抛异常版本', () => {
  it('合法转换返回 true', () => {
    expect(canTransition('draft', 'apply_contract')).toBe(true)
    expect(canTransition('approved', 'start_realname')).toBe(true)
    expect(canTransition('realname_pending', 'realname_success')).toBe(true)
  })
  it('非法转换返回 false（不抛）', () => {
    expect(canTransition('draft', 'realname_success')).toBe(false)
    expect(canTransition('cancelled', 'cancel')).toBe(false)
    expect(canTransition('completed', 'apply_contract')).toBe(false)
  })
})

describe('listLegalEvents · 列出某状态的合法事件', () => {
  it('draft 仅 [apply_contract, cancel]', () => {
    expect(new Set(listLegalEvents('draft'))).toEqual(new Set(['apply_contract', 'cancel']))
  })
  it('contract_signing 含回退事件 contract_apply_fail', () => {
    const events = new Set(listLegalEvents('contract_signing'))
    expect(events.has('contract_signed_callback')).toBe(true)
    expect(events.has('contract_apply_fail')).toBe(true)
    expect(events.has('cancel')).toBe(true)
  })
  it('cancelled 终态 → 无合法事件', () => {
    expect(listLegalEvents('cancelled')).toEqual([])
  })
  it('completed 仅可 cancel（admin 强解上线商户）', () => {
    expect(listLegalEvents('completed')).toEqual(['cancel'])
  })
})

describe('isTerminalStatus', () => {
  it('completed / cancelled = 终态', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('cancelled')).toBe(true)
  })
  it('其他全部非终态', () => {
    expect(isTerminalStatus('draft')).toBe(false)
    expect(isTerminalStatus('contract_signing')).toBe(false)
    expect(isTerminalStatus('approved')).toBe(false)
    expect(isTerminalStatus('rejected')).toBe(false)
    expect(isTerminalStatus('under_review')).toBe(false)
    expect(isTerminalStatus('appealing')).toBe(false)
    expect(isTerminalStatus('realname_pending')).toBe(false)
  })
})

describe('关键路径完整 walk', () => {
  it('标准路径 draft → completed（无驳回，无人工审核）', () => {
    let s: LakalaOnboardingStatus = 'draft'
    s = nextState(s, 'apply_contract')
    expect(s).toBe('contract_signing')
    s = nextState(s, 'contract_signed_callback')
    expect(s).toBe('contract_signed')
    s = nextState(s, 'start_attachments')
    expect(s).toBe('attachments_uploading')
    s = nextState(s, 'submit_merchant')
    expect(s).toBe('submitted')
    s = nextState(s, 'await_callback')
    expect(s).toBe('callback_pending')
    s = nextState(s, 'callback_approved')
    expect(s).toBe('approved')
    s = nextState(s, 'start_realname')
    expect(s).toBe('realname_pending')
    s = nextState(s, 'realname_success')
    expect(s).toBe('completed')
  })

  it('回退路径 contract_signing 失败 → draft 重做 → 重新申请', () => {
    let s: LakalaOnboardingStatus = 'draft'
    s = nextState(s, 'apply_contract')
    expect(s).toBe('contract_signing')
    s = nextState(s, 'contract_apply_fail')
    expect(s).toBe('draft')
    s = nextState(s, 'apply_contract')
    expect(s).toBe('contract_signing')
  })

  it('复议路径 submitted → rejected → appealing → submitted → approved', () => {
    let s: LakalaOnboardingStatus = 'submitted'
    s = nextState(s, 'callback_rejected')
    expect(s).toBe('rejected')
    s = nextState(s, 'submit_appeal')
    expect(s).toBe('appealing')
    s = nextState(s, 'appeal_resubmitted')
    expect(s).toBe('submitted')
    s = nextState(s, 'callback_approved')
    expect(s).toBe('approved')
  })

  it('人工审核路径 submitted → under_review → 直通过', () => {
    let s: LakalaOnboardingStatus = 'submitted'
    s = nextState(s, 'callback_manual')
    expect(s).toBe('under_review')
    s = nextState(s, 'callback_approved')
    expect(s).toBe('approved')
  })

  it('任意非终态都可 cancel', () => {
    const cancellable: LakalaOnboardingStatus[] = [
      'draft',
      'contract_signing',
      'contract_signed',
      'attachments_uploading',
      'submitted',
      'callback_pending',
      'approved',
      'rejected',
      'under_review',
      'appealing',
      'realname_pending',
      'completed', // admin 可强解上线商户
    ]
    for (const s of cancellable) {
      expect(nextState(s, 'cancel')).toBe('cancelled')
    }
  })

  it('cancelled 终态 → 任何事件都拒绝', () => {
    for (const e of ALL_EVENTS) {
      expect(() => nextState('cancelled', e)).toThrow(TransitionError)
    }
  })
})
