/**
 * 拉卡拉商户入网 · 14 步主状态机（plan §1.5）
 *
 * 标准路径：
 *   draft → contract_signing → contract_signed → attachments_uploading →
 *   submitted → callback_pending → (approved | rejected | under_review)
 *   → (under_review → appealing → 回 submitted)
 *   → (approved → realname_pending → completed)
 *
 * 回退路径：
 *   contract_signing → draft  (合同申请失败，允许回退重做)
 *
 * 任意态都可 cancelled（cancelOnboarding action）。
 * 任意失败态可保留状态机当前位置，仅在 lakala_merchants.last_error_code/msg 记录失败原因，
 *   而不是把状态翻成"failed"——拉卡拉端往往允许在原状态重试 / 复议。
 *
 * **集中实现**：actions 不裸写 status='...'，统一走 nextState() / assertTransition()。
 * 所有合法转换 + 非法拒绝都有单元测试覆盖（lakala-onboarding-state.test.ts）。
 */

export type LakalaOnboardingStatus =
  | 'draft'
  | 'contract_signing'
  | 'contract_signed'
  | 'attachments_uploading'
  | 'submitted'
  | 'callback_pending'
  | 'approved'
  | 'rejected'
  | 'under_review'
  | 'appealing'
  | 'realname_pending'
  | 'completed'
  | 'cancelled'

/**
 * 状态转换事件（按 plan §1.5 + endpoints §1-§16）。
 *
 * apply_contract            applyContract action 调用成功
 * contract_apply_fail       applyContract action 调用失败，回 draft 重做
 * contract_signed_callback  电子合同 H5 完成 / queryContract 返回 COMPLETED
 * start_attachments         进入附件上传阶段
 * submit_merchant           submitMerchant action 调用成功
 * await_callback            提交后等回调
 * callback_approved         进件回调 / queryMerchant 返回 WAIT_FOR_CONTACT
 * callback_rejected         进件回调返回 INNER_CHECK_REJECTED（自动校验失败）
 * callback_manual           进件回调返回 MANUAL_AUDIT（转人工审核中）
 * submit_appeal             submitAppeal action 调用成功（rejected/under_review → appealing）
 * appeal_resubmitted        appeal 转回拉卡拉 → submitted（回到等待回调）
 * start_realname            进入实名报备阶段（approved → realname_pending）
 * realname_success          微信 + 支付宝实名 success + 子商户号回填完成
 * cancel                    cancelOnboarding action（任意态可触发）
 */
export type LakalaOnboardingEvent =
  | 'apply_contract'
  | 'contract_apply_fail'
  | 'contract_signed_callback'
  | 'start_attachments'
  | 'submit_merchant'
  | 'await_callback'
  | 'callback_approved'
  | 'callback_rejected'
  | 'callback_manual'
  | 'submit_appeal'
  | 'appeal_resubmitted'
  | 'start_realname'
  | 'realname_success'
  | 'cancel'

/** 转换表 — 唯一权威来源。 */
const TRANSITIONS: Readonly<
  Record<LakalaOnboardingStatus, Readonly<Partial<Record<LakalaOnboardingEvent, LakalaOnboardingStatus>>>>
> = {
  draft: {
    apply_contract: 'contract_signing',
    cancel: 'cancelled',
  },
  contract_signing: {
    contract_signed_callback: 'contract_signed',
    contract_apply_fail: 'draft',
    cancel: 'cancelled',
  },
  contract_signed: {
    start_attachments: 'attachments_uploading',
    cancel: 'cancelled',
  },
  attachments_uploading: {
    submit_merchant: 'submitted',
    cancel: 'cancelled',
  },
  submitted: {
    await_callback: 'callback_pending',
    callback_approved: 'approved',
    callback_rejected: 'rejected',
    callback_manual: 'under_review',
    cancel: 'cancelled',
  },
  callback_pending: {
    callback_approved: 'approved',
    callback_rejected: 'rejected',
    callback_manual: 'under_review',
    cancel: 'cancelled',
  },
  approved: {
    start_realname: 'realname_pending',
    cancel: 'cancelled',
  },
  rejected: {
    submit_appeal: 'appealing',
    cancel: 'cancelled',
  },
  under_review: {
    submit_appeal: 'appealing',
    callback_approved: 'approved',
    callback_rejected: 'rejected',
    cancel: 'cancelled',
  },
  appealing: {
    appeal_resubmitted: 'submitted',
    cancel: 'cancelled',
  },
  realname_pending: {
    realname_success: 'completed',
    cancel: 'cancelled',
  },
  completed: {
    // 终态（admin 可 cancel 已上线商户 → cancelOnboarding 会强制解绑所有 stores）
    cancel: 'cancelled',
  },
  cancelled: {
    // 终态，不可流转
  },
}

export class TransitionError extends Error {
  readonly code = 'INVALID_STATE: LAKALA_TRANSITION_BLOCKED'
  constructor(public readonly current: LakalaOnboardingStatus, public readonly event: LakalaOnboardingEvent) {
    super(`Illegal transition: status=${current} event=${event}`)
    this.name = 'TransitionError'
  }
}

/**
 * 计算下一个状态。
 * 合法转换返回新状态字符串；非法转换抛 TransitionError（含 current/event 上下文）。
 *
 * 调用方应在 server action 内捕获 TransitionError → 翻成 INVALID_STATE 错误 + 落 logOperation 告警。
 */
export function nextState(
  current: LakalaOnboardingStatus,
  event: LakalaOnboardingEvent,
): LakalaOnboardingStatus {
  const row = TRANSITIONS[current]
  const target = row?.[event]
  if (!target) throw new TransitionError(current, event)
  return target
}

/**
 * 检查转换是否合法（不抛异常的便携版本，常用于 UI 渲染"可执行操作"按钮）。
 */
export function canTransition(
  current: LakalaOnboardingStatus,
  event: LakalaOnboardingEvent,
): boolean {
  return TRANSITIONS[current]?.[event] !== undefined
}

/**
 * 列出某状态下所有合法事件 — 用于 UI/admin 自检 + 测试枚举。
 */
export function listLegalEvents(current: LakalaOnboardingStatus): LakalaOnboardingEvent[] {
  return Object.keys(TRANSITIONS[current] || {}) as LakalaOnboardingEvent[]
}

/** 终态：不可再流转出去（除了 cancelled，对外暴露的接口语义上不可逆）。 */
export function isTerminalStatus(status: LakalaOnboardingStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}
