import { describe, expect, it } from 'vitest'
import { parseAliyunBusinessLicenseResult, parseAliyunIdCardResult } from './client'

describe('阿里云 OCR 返回解析', () => {
  it('解析身份证正面的 data.face.data 嵌套字段', () => {
    const result = parseAliyunIdCardResult({
      Data: JSON.stringify({ face: { data: { name: '张三', idNumber: '360102199001011234' } } }),
    }, 'face')
    expect(result).toMatchObject({ side: 'face', larName: '张三', larIdcard: '360102199001011234' })
  })

  it('解析身份证反面的长期有效期', () => {
    const result = parseAliyunIdCardResult({
      data: JSON.stringify({ back: { data: { validPeriod: '2018.06.01-长期' } } }),
    }, 'back')
    expect(result).toMatchObject({
      side: 'back',
      larIdcardStDt: '2018-06-01',
      larIdcardLongTerm: 'true',
    })
  })

  it('解析营业执照并移除省市区地址前缀', () => {
    const result = parseAliyunBusinessLicenseResult({
      data: JSON.stringify({
        name: '测试有限公司',
        creditCode: '91360100TEST000001',
        address: '江西省南昌市西湖区中山路 1 号',
        legalPerson: '李四',
      }),
    })
    expect(result.merRegName).toBe('测试有限公司')
    expect(result.merRegAddr).toBe('中山路 1 号')
    expect(result.merRegDistCode).toBeTruthy()
  })
})
