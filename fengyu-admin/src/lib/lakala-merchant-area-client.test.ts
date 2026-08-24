import { describe, expect, it } from 'vitest'
import {
  buildLakalaMerchantAreaDirectory,
  parseLakalaMerchantAreas,
} from './lakala-merchant-area-client'

const tsv = `code\tname\tparent_code
1\t全国\t
1000\t北京市\t991000
1027\t密云县\t1000
1200\t河北省\t1
1210\t石家庄市\t1200
1211\t井陉县\t1210`

describe('拉卡拉地区码客户端目录', () => {
  it('解析 TSV 并生成省市区联动选项', () => {
    const directory = buildLakalaMerchantAreaDirectory(parseLakalaMerchantAreas(tsv))

    expect(directory.provinceOptions).toEqual([
      { value: '1000', label: '北京市' },
      { value: '1200', label: '河北省' },
    ])
    expect(directory.getCityOptions('1200')).toEqual([{ value: '1210', label: '石家庄市' }])
    expect(directory.getCountyOptions('1210')).toEqual([{ value: '1211', label: '井陉县' }])
  })

  it('直辖市使用同一省市码并可回显完整路径', () => {
    const directory = buildLakalaMerchantAreaDirectory(parseLakalaMerchantAreas(tsv))

    expect(directory.getCityOptions('1000')).toEqual([{ value: '1000', label: '北京市' }])
    expect(directory.getPathByCode('1027')).toEqual({
      provinceCode: '1000',
      cityCode: '1000',
      countyCode: '1027',
      label: '北京市密云县',
    })
  })

  it('未知地区码不会伪造联动路径', () => {
    const directory = buildLakalaMerchantAreaDirectory(parseLakalaMerchantAreas(tsv))
    expect(directory.getPathByCode('missing')).toEqual({
      provinceCode: '',
      cityCode: '',
      countyCode: '',
      label: '',
    })
  })
})
