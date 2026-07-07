
export interface ShareGiftConfig {
  
  enabled: boolean
  
  percent: number
  
  minFaceValue: number
  
  maxFaceValue: number
  
  couponTemplateId: string
  
  validityDays: number
  
  inviterMustHavePaidOrder: boolean
  
  messageInviterTitle: string
  
  messageInviterBody: string
  
  messageInviteeTitle: string
  
  messageInviteeBody: string
}

export const DEFAULT_SHARE_GIFT_CONFIG: ShareGiftConfig = {
  enabled: false,
  percent: 0.15,
  minFaceValue: 1,
  maxFaceValue: 500,
  couponTemplateId: '',
  validityDays: 90,
  inviterMustHavePaidOrder: false,
  messageInviterTitle: '🎁 分享礼到账',
  messageInviterBody:
    '您邀请的新客首单已结清（¥{paidAmount}），向您赠送一张 ¥{couponValue} 代金券，{validityDays} 天内有效，请尽快使用。',
  messageInviteeTitle: '🎁 新客首单回馈',
  messageInviteeBody:
    '欢迎首次下单！感谢好友分享，赠送您一张 ¥{couponValue} 代金券，{validityDays} 天内有效。',
}

function clampNumber(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}


export function normalizeShareGiftConfig(input: unknown): ShareGiftConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SHARE_GIFT_CONFIG }
  const r = input as Record<string, unknown>

  const percent = clampNumber(r.percent, 0.01, 0.5, DEFAULT_SHARE_GIFT_CONFIG.percent)
  const minRaw = Number(r.minFaceValue)
  const maxRaw = Number(r.maxFaceValue)
  let minFaceValue = Number.isFinite(minRaw)
    ? Math.max(0, Math.round(minRaw * 100) / 100)
    : DEFAULT_SHARE_GIFT_CONFIG.minFaceValue
  let maxFaceValue = Number.isFinite(maxRaw)
    ? Math.max(0, Math.round(maxRaw * 100) / 100)
    : DEFAULT_SHARE_GIFT_CONFIG.maxFaceValue
  if (minFaceValue > maxFaceValue) {
    const t = minFaceValue
    minFaceValue = maxFaceValue
    maxFaceValue = t
  }
  const daysRaw = Number(r.validityDays)
  const validityDays = Number.isFinite(daysRaw)
    ? Math.max(1, Math.min(3650, Math.floor(daysRaw) || 1))
    : DEFAULT_SHARE_GIFT_CONFIG.validityDays

  return {
    enabled: Boolean(r.enabled),
    percent,
    minFaceValue,
    maxFaceValue,
    couponTemplateId: typeof r.couponTemplateId === 'string' ? r.couponTemplateId.trim() : '',
    validityDays,
    inviterMustHavePaidOrder: Boolean(r.inviterMustHavePaidOrder),
    messageInviterTitle:
      typeof r.messageInviterTitle === 'string' ? r.messageInviterTitle.trim() : '',
    messageInviterBody:
      typeof r.messageInviterBody === 'string' ? r.messageInviterBody.trim() : '',
    messageInviteeTitle:
      typeof r.messageInviteeTitle === 'string' ? r.messageInviteeTitle.trim() : '',
    messageInviteeBody:
      typeof r.messageInviteeBody === 'string' ? r.messageInviteeBody.trim() : '',
  }
}
