/**
 * 分享礼运营配置
 *
 * 存储为 system_configs.share_gift_config JSON 字符串。
 * 云函数 grantShareGift(payNotify/staffApi/clientApi) 读取相同键。
 */
export interface ShareGiftConfig {
  /** 总开关；false 时 grantShareGift 直接 return */
  enabled: boolean
  /** 新客首单首笔「首次支付」金额 × percent 为券面值；clamp 到 [0.01, 0.5] */
  percent: number
  /** 面值下限（元，含）；计算结果 < min 时取 min */
  minFaceValue: number
  /** 面值上限（元，含）；计算结果 > max 时取 max */
  maxFaceValue: number
  /** 券模板 ID（coupon_templates.template_id）；空字符串表示未选择 */
  couponTemplateId: string
  /** 兜底有效期天数（模板为 days 模式时用模板 valid_days；fixed 模式用 valid_to） */
  validityDays: number
  /** 要求邀请人自身至少有一笔结清订单 */
  inviterMustHavePaidOrder: boolean
  /** 给邀请人的消息标题；空字符串不发该条 */
  messageInviterTitle: string
  /** 给邀请人的消息正文；支持 {paidAmount}/{couponValue}/{validityDays} 占位符 */
  messageInviterBody: string
  /** 给新客的消息标题 */
  messageInviteeTitle: string
  /** 给新客的消息正文 */
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

/**
 * 规范化分享礼配置（与 grantShareGift 云函数 clamp 规则保持一致）。
 * - enabled / inviterMustHavePaidOrder → boolean
 * - percent → clamp 到 [0.01, 0.5]，非数字回退默认
 * - minFaceValue / maxFaceValue → ≥ 0 的 2 位小数；min > max 时交换
 * - couponTemplateId / 文案 → trim
 * - validityDays → [1, 3650] 整数
 */
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
