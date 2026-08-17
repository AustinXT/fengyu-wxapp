import { describe, expect, it } from 'vitest'
import type { OnboardingListItem } from '@/actions/lakala-onboarding'
import { onboardingBusinessStatus, onboardingMetricCounts } from './lakala-onboarding-presentation'

function application(overrides: Partial<OnboardingListItem> = {}): OnboardingListItem {
  return {
    id: 'onb_1',
    applicationNo: 'ONB-1',
    orderNo: 'ONB-1',
    storeId: 'store-1',
    storeName: '南昌店',
    marketName: '南昌市场',
    subjectName: '凤御南昌店',
    status: 'SUCCESS',
    missing: null,
    owner: '张三',
    updatedAt: '2026-08-17T00:00:00.000Z',
    merCupNo: '82123456',
    terminalNo: 'TERM-1',
    lakalaMerchantId: null,
    lakalaMerchantEnabled: null,
    channelData: {
      wechat: [{ subMerchantNo: 'WX-1' }],
      alipay: [{ subMerchantNo: 'ALI-1' }],
    },
    subMerchantCheckedAt: null,
    ...overrides,
  }
}

describe('拉卡拉入网业务状态', () => {
  it('区分渠道报备、终端号、外部认证和启用待办', () => {
    expect(onboardingBusinessStatus(application({ merCupNo: null })).label).toBe('待渠道报备')
    expect(onboardingBusinessStatus(application({ terminalNo: null })).label).toBe('待终端号')
    expect(onboardingBusinessStatus(application({ channelData: { wechat: [], alipay: [] } })).todo).toBe('等待微信子商户号')
    expect(onboardingBusinessStatus(application()).label).toBe('待外部认证')
    expect(onboardingBusinessStatus(application({ lakalaMerchantId: 'merchant-1', lakalaMerchantEnabled: false })).label).toBe('待启用')
  })

  it('只有已绑定且启用的申请才是办理完成', () => {
    const completed = application({ lakalaMerchantId: 'merchant-1', lakalaMerchantEnabled: true })
    expect(onboardingBusinessStatus(completed)).toMatchObject({ label: '办理完成', completed: true })

    expect(onboardingMetricCounts([
      application({ id: 'draft', status: 'DRAFT', merCupNo: null }),
      application({ id: 'ready', status: 'FILES_READY', merCupNo: null }),
      application({ id: 'reviewing' }),
      completed,
    ])).toEqual({ drafts: 1, ready: 1, reviewing: 1, completed: 1 })
  })
})
