import { describe, expect, it } from 'vitest'
import { queryLocalLakalaBanks, queryLocalLakalaBanksByAreaKeywords } from './lakala-bank-directory'

describe('拉卡拉本地支行字典', () => {
  it('按城市地区码和支行名称查询', async () => {
    const banks = await queryLocalLakalaBanks({ areaCode: '7010', bankName: '中国工商银行股份有限公司贵阳鸿通城支行', limit: 5 })
    expect(banks[0]).toMatchObject({
      areaCode: '7010',
      branchBankNo: '102701005285',
      clearNo: '102100099996',
    })
  })

  it('没有地区码时可按地区名称定位城市支行', async () => {
    const banks = await queryLocalLakalaBanksByAreaKeywords({
      areaKeywords: ['贵阳'],
      bankName: '工商银行 鸿通城',
      limit: 5,
    })
    expect(banks[0]?.areaCode).toBe('7010')
  })
})
