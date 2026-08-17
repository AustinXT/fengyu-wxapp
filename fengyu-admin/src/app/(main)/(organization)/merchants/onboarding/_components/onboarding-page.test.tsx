import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactNode } from 'react'
import type { OnboardingApplicationInput, OnboardingListItem } from '@/actions/lakala-onboarding'

const mockSearchBanks = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('@/actions/lakala-onboarding', () => ({
  cancelOnboardingApplication: vi.fn(),
  confirmOnboardingExternalCertification: vi.fn(),
  createOnboardingApplication: vi.fn(),
  initiateElectronicContract: vi.fn(),
  queryOnboardingApplication: vi.fn(),
  reconsiderOnboardingApplication: vi.fn(),
  refreshElectronicContractStatus: vi.fn(),
  refreshOnboardingCertificationStatus: vi.fn(),
  refreshOnboardingSubMerchants: vi.fn(),
  saveOnboardingApplication: vi.fn(),
  searchOnboardingBanks: (...args: unknown[]) => mockSearchBanks(...args),
  submitOnboardingApplication: vi.fn(),
}))

import { OnboardingList, OpeningBankField } from './onboarding-page'

const areaTsv = `code\tname\tparent_code
1\t全国\t
1000\t北京市\t991000
1027\t密云县\t1000
1200\t河北省\t1
1210\t石家庄市\t1200
1211\t井陉县\t1210`

function formWithBank(overrides: Record<string, string> = {}): OnboardingApplicationInput {
  return {
    merchantData: {},
    legalPersonData: {},
    contactData: {},
    settlementData: {
      bankDistCode: '1211',
      bankAreaCode: 'AREA-OLD',
      openningBankCode: 'BANK-OLD',
      openningBankName: '旧开户支行',
      clearingBankCode: 'CLEAR-OLD',
      settleProvinceCode: '1200',
      settleProvinceName: '河北省',
      settleCityCode: '1210',
      settleCityName: '石家庄市',
      ...overrides,
    },
    shopData: {},
    terminalData: {},
  }
}

function BankHarness({ initialForm }: { initialForm: OnboardingApplicationInput }) {
  const [form, setForm] = useState(initialForm)
  return (
    <>
      <OpeningBankField form={form} setForm={setForm} applicationId="onb-1" />
      <output data-testid="form-state">{JSON.stringify(form.settlementData)}</output>
    </>
  )
}

function application(overrides: Partial<OnboardingListItem> = {}): OnboardingListItem {
  return {
    id: 'onb-1',
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
    merCupNo: '821234',
    terminalNo: 'TERM-1',
    lakalaMerchantId: 'merchant-1',
    lakalaMerchantEnabled: true,
    channelData: {
      wechat: [{ subMerchantNo: 'WX-1' }],
      alipay: [{ subMerchantNo: 'ALI-1' }],
    },
    subMerchantCheckedAt: null,
    ...overrides,
  }
}

describe('拉卡拉入网表单与列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => areaTsv,
    }))
    mockSearchBanks.mockResolvedValue({
      success: true,
      message: '查询成功',
      banks: [{
        branchBankNo: 'BANK-NEW',
        clearNo: 'CLEAR-NEW',
        branchBankName: '中国银行井陉支行',
        areaCode: 'AREA-NEW',
      }],
    })
  })

  it('更改开户地区时清空所有旧银行与结算地区字段', async () => {
    const user = userEvent.setup()
    render(<BankHarness initialForm={formWithBank()} />)

    const province = await screen.findByRole('combobox', { name: '开户行省份' })
    await waitFor(() => expect(province).toHaveValue('1200'))
    await user.selectOptions(province, '1000')

    const state = JSON.parse(screen.getByTestId('form-state').textContent || '{}')
    expect(state).toMatchObject({
      bankDistCode: '',
      bankAreaCode: '',
      openningBankCode: '',
      openningBankName: '',
      clearingBankCode: '',
      settleProvinceCode: '',
      settleProvinceName: '',
      settleCityCode: '',
      settleCityName: '',
    })
  })

  it('支行必须从查询结果选择，选中后锁定并保存标准编码', async () => {
    const user = userEvent.setup()
    render(<BankHarness initialForm={formWithBank()} />)

    await user.click(await screen.findByRole('button', { name: '重新选择' }))
    const keyword = screen.getByRole('textbox', { name: '开户支行关键字' })
    await user.type(keyword, '中国银行')
    await user.click(screen.getByRole('button', { name: '查询支行' }))
    await user.click(await screen.findByRole('button', { name: '中国银行井陉支行（BANK-NEW）' }))

    expect(mockSearchBanks).toHaveBeenCalledWith('onb-1', '中国银行', '1211')
    const state = JSON.parse(screen.getByTestId('form-state').textContent || '{}')
    expect(state).toMatchObject({
      bankDistCode: '1211',
      bankAreaCode: 'AREA-NEW',
      openningBankCode: 'BANK-NEW',
      openningBankName: '中国银行井陉支行',
      clearingBankCode: 'CLEAR-NEW',
    })
    expect(screen.queryByRole('textbox', { name: '开户支行关键字' })).not.toBeInTheDocument()
  })

  it('内嵌列表展示业务完成态、负责人且不显示返回按钮', () => {
    render(<OnboardingList applications={[application()]} canCreate embedded />)

    expect(screen.getAllByText('办理完成')).toHaveLength(2)
    expect(screen.getByText('张三')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '收款商户' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发起入网申请' })).toBeInTheDocument()
  })
})
