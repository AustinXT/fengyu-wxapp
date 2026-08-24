import type { OnboardingListItem, OnboardingStatus } from '@/actions/lakala-onboarding'

export const onboardingStatusText: Record<OnboardingStatus, string> = {
  DRAFT: '草稿',
  FILES_UPLOADING: '资料保存中',
  FILES_READY: '资料已就绪',
  SUBMITTING: '提交中',
  SUBMITTED: '已提交',
  REGISTERING: '审核中',
  SUCCESS: '审核通过',
  FAILED: '审核失败',
  CANCELLED: '已取消',
}

export interface OnboardingBusinessStatus {
  label: string
  todo: string | null
  completed: boolean
}

export function channelMerchantNumbers(
  channelData: Record<string, unknown>,
  channel: 'wechat' | 'alipay',
): string {
  const values = channelData[channel]
  if (!Array.isArray(values)) return ''
  return values
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const number = (value as Record<string, unknown>).subMerchantNo
      return typeof number === 'string' && number.trim() ? [number.trim()] : []
    })
    .join('、')
}

export function onboardingBusinessStatus(application: OnboardingListItem): OnboardingBusinessStatus {
  if (application.status !== 'SUCCESS') {
    const todo = application.status === 'FAILED'
      ? '修正资料后重新提交'
      : ['SUBMITTING', 'SUBMITTED', 'REGISTERING'].includes(application.status)
        ? '等待拉卡拉审核'
        : application.missing || '补齐资料并提交拉卡拉'
    return { label: onboardingStatusText[application.status], todo, completed: false }
  }

  if (!application.merCupNo) return { label: '待渠道报备', todo: '等待银联商户号', completed: false }
  if (!application.terminalNo) return { label: '待终端号', todo: '请查询审核状态获取终端号', completed: false }
  if (!channelMerchantNumbers(application.channelData, 'wechat')) {
    return { label: '待渠道报备', todo: '等待微信子商户号', completed: false }
  }
  if (!channelMerchantNumbers(application.channelData, 'alipay')) {
    return { label: '待渠道报备', todo: '等待支付宝子商户号', completed: false }
  }
  if (application.lakalaMerchantId) {
    return application.lakalaMerchantEnabled
      ? { label: '办理完成', todo: '收款商户已启用并绑定门店', completed: true }
      : { label: '待启用', todo: '已关联收款商户，请到收款商户页人工启用', completed: false }
  }
  return { label: '待外部认证', todo: '请法人完成微信认证后刷新认证状态', completed: false }
}

export function onboardingMetricCounts(applications: OnboardingListItem[]) {
  return {
    drafts: applications.filter((item) => ['DRAFT', 'FILES_UPLOADING', 'FAILED'].includes(item.status)).length,
    ready: applications.filter((item) => item.status === 'FILES_READY').length,
    reviewing: applications.filter((item) => (
      ['SUBMITTING', 'SUBMITTED', 'REGISTERING'].includes(item.status)
      || (item.status === 'SUCCESS' && !onboardingBusinessStatus(item).completed)
    )).length,
    completed: applications.filter((item) => onboardingBusinessStatus(item).completed).length,
  }
}
