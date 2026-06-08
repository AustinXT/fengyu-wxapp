import { describe, it, expect } from 'vitest'
import {
  redact,
  maskPhone,
  maskIdCard,
  maskBankCard,
  REDACT_PII_FIELDS,
  REDACT_RATE_FIELDS,
  REDACT_RATE_MASK,
} from '../lakala-redact'

/**
 * 脱敏覆盖（plan §0★ + §1.3）：
 *   - 每种敏感字段类型至少 1 用例
 *   - PII vs 费率差异：PII 保留前后 4 位；费率直接 '***'
 *   - 嵌套对象/数组继承父 key
 *   - 非字符串值（数字/null）也走脱敏
 */

describe('maskPhone', () => {
  it('11 位手机号 → 138****1234（前 3 + **** + 后 4）', () => {
    expect(maskPhone('13812341234')).toBe('138****1234')
  })
  it('短串 < 8 位 → 全部 *', () => {
    expect(maskPhone('1234567')).toBe('*******')
  })
  it('空 / undefined / 非串 → 空串', () => {
    expect(maskPhone('')).toBe('')
    expect(maskPhone(undefined as unknown as string)).toBe('')
    expect(maskPhone(null as unknown as string)).toBe('')
  })
})

describe('maskIdCard', () => {
  it('18 位身份证 → 110101 + ******** + 1234（前 6 + 后 4）', () => {
    expect(maskIdCard('110101199001011234')).toBe('110101********1234')
  })
  it('短于 10 位 → 全 *', () => {
    expect(maskIdCard('12345')).toBe('*****')
  })
  it('空 → 空', () => {
    expect(maskIdCard('')).toBe('')
  })
})

describe('maskBankCard', () => {
  it('19 位 → 6225 + ************ + 1234（前 4 + 后 4）', () => {
    expect(maskBankCard('6225756800012341234')).toBe('6225***********1234')
  })
  it('16 位 → 6225 + ******** + 1234', () => {
    expect(maskBankCard('6225756812341234')).toBe('6225********1234')
  })
  it('短于 8 位 → 全 *', () => {
    expect(maskBankCard('1234567')).toBe('*******')
  })
})

describe('redact · 顶层 PII 字段', () => {
  it('idCard / 身份证类全部按身份证规则脱敏', () => {
    expect(
      redact({
        idCard: '110101199001011234',
        id_card: '110101199001011234',
        legalCertNo: '110101199001011234',
        legalIdNo: '110101199001011234',
        larIdcard: '110101199001011234',
        acctIdcard: '110101199001011234',
      }),
    ).toEqual({
      idCard: '110101********1234',
      id_card: '110101********1234',
      legalCertNo: '110101********1234',
      legalIdNo: '110101********1234',
      larIdcard: '110101********1234',
      acctIdcard: '110101********1234',
    })
  })

  it('phone / mobile / contactMobile / larMobile 全部按手机号规则脱敏', () => {
    expect(
      redact({
        phone: '13812341234',
        mobile: '13812341234',
        contactMobile: '13812341234',
        larMobile: '13812341234',
        merContactMobile: '13812341234',
        shopContactMobile: '13812341234',
      }),
    ).toEqual({
      phone: '138****1234',
      mobile: '138****1234',
      contactMobile: '138****1234',
      larMobile: '138****1234',
      merContactMobile: '138****1234',
      shopContactMobile: '138****1234',
    })
  })

  it('bankCardNo / acctNo / settleAcctNo 全部按银行卡规则脱敏', () => {
    expect(
      redact({
        bankCard: '6225756812341234',
        bankCardNo: '6225756812341234',
        accountNo: '6225756812341234',
        settleAcctNo: '6225756812341234',
        acctNo: '6225756812341234',
      }),
    ).toEqual({
      bankCard: '6225********1234',
      bankCardNo: '6225********1234',
      accountNo: '6225********1234',
      settleAcctNo: '6225********1234',
      acctNo: '6225********1234',
    })
  })
})

describe('redact · 费率字段（plan §0★ 强制 ***，不留任何提示）', () => {
  it('feeRate / rateCode / rateType / 等单值字段 → ***', () => {
    expect(
      redact({
        feeRate: '0.6',
        rateCode: 'A',
        rateType: 'BANK_DEBIT',
        rate: '0.5',
        serviceFee: '10',
        merFeeRate: '0.38',
        singleFeeRate: '0.45',
        cardFeeRate: '0.6',
        costFeeRate: '0.3',
      }),
    ).toEqual({
      feeRate: '***',
      rateCode: '***',
      rateType: '***',
      rate: '***',
      serviceFee: '***',
      merFeeRate: '***',
      singleFeeRate: '***',
      cardFeeRate: '***',
      costFeeRate: '***',
    })
  })

  it('feeData（拉卡拉 Set 嵌套结构）整段被替换为 ***', () => {
    const result = redact({
      feeData: [
        { feeRateTypeCode: 'BANK_DEBIT_CARD', feeRatePct: '0.6', feeUpperAmtPcnt: '20' },
      ],
    }) as Record<string, unknown>
    expect(result.feeData).toBe('***')
  })

  it('数字型费率值（0.6 / 60）也被替换 — 类型转换攻击防御', () => {
    expect(redact({ feeRate: 0.6 })).toEqual({ feeRate: '***' })
    expect(redact({ rate: 60 })).toEqual({ rate: '***' })
  })

  it('布尔型费率 — 健壮性兜底', () => {
    expect(redact({ feeRate: true })).toEqual({ feeRate: '***' })
  })
})

describe('redact · 嵌套 + 数组结构', () => {
  it('嵌套对象内的 phone 被脱敏', () => {
    expect(
      redact({ snapshot: { phone: '13812341234', otherField: '保留原值' } }),
    ).toEqual({
      snapshot: { phone: '138****1234', otherField: '保留原值' },
    })
  })

  it('数组里的对象 PII 字段被脱敏', () => {
    expect(
      redact({
        contacts: [
          { phone: '13812341234', name: '张三' },
          { phone: '13912000000', name: '李四' },
        ],
      }),
    ).toEqual({
      contacts: [
        { phone: '138****1234', name: '张三' },
        { phone: '139****0000', name: '李四' },
      ],
    })
  })

  it('changes.phone.{from,to} diff 子对象继承 phone 上下文（plan §0★ 复议 diff 屏蔽）', () => {
    expect(
      redact({
        changes: { phone: { from: '13800000000', to: '13912341234' } },
      }),
    ).toEqual({
      changes: { phone: { from: '138****0000', to: '139****1234' } },
    })
  })

  it('changes.feeRate.{from,to} diff → 整 diff 子对象被 ***', () => {
    const result = redact({
      changes: { feeRate: { from: '0.6', to: '0.5' } },
    }) as Record<string, unknown>
    expect((result.changes as Record<string, unknown>).feeRate).toBe('***')
  })

  it('混合 PII + 费率 + 普通字段（典型拉卡拉进件 reqBody）', () => {
    const out = redact({
      orderNo: 'ORD-20260529-001',
      merRegName: '凤御美容院',
      larName: '张三',
      larIdcard: '110101199001011234',
      merContactMobile: '13812341234',
      acctNo: '6225756812341234',
      feeData: [{ feeRatePct: '0.6' }],
      mccCode: '7298',
    }) as Record<string, unknown>
    expect(out.orderNo).toBe('ORD-20260529-001')
    expect(out.merRegName).toBe('凤御美容院')
    expect(out.larName).toBe('张三')
    expect(out.larIdcard).toBe('110101********1234')
    expect(out.merContactMobile).toBe('138****1234')
    expect(out.acctNo).toBe('6225********1234')
    expect(out.feeData).toBe('***')
    expect(out.mccCode).toBe('7298')
  })
})

describe('redact · 边界 input', () => {
  it('null / undefined 直接返回', () => {
    expect(redact(null)).toBe(null)
    expect(redact(undefined)).toBe(undefined)
  })
  it('原始 string / number 直接返回（顶层无 key 上下文）', () => {
    expect(redact('hello')).toBe('hello')
    expect(redact(42)).toBe(42)
  })
  it('空对象 / 空数组保留结构', () => {
    expect(redact({})).toEqual({})
    expect(redact([])).toEqual([])
  })
  it('深层嵌套 PII（4 层）也被脱敏', () => {
    expect(
      redact({
        a: { b: { c: { d: { phone: '13812341234' } } } },
      }),
    ).toEqual({
      a: { b: { c: { d: { phone: '138****1234' } } } },
    })
  })
})

describe('REDACT_*_FIELDS 常量导出（守护 plan §0★ 必含项）', () => {
  it('PII 必含 11 项白名单关键字段', () => {
    for (const k of [
      'idCard',
      'bankCard',
      'phone',
      'legalCertNo',
      'legalIdNo',
      'contactMobile',
      'larMobile',
      'mobile',
      'bankCardNo',
      'settleAcctNo',
      'accountNo',
    ]) {
      expect(REDACT_PII_FIELDS.has(k)).toBe(true)
    }
  })

  it('费率必含 10 项白名单关键字段', () => {
    for (const k of [
      'feeRate',
      'rateCode',
      'rateType',
      'feeData',
      'rate',
      'serviceFee',
      'merFeeRate',
      'singleFeeRate',
      'cardFeeRate',
      'costFeeRate',
    ]) {
      expect(REDACT_RATE_FIELDS.has(k)).toBe(true)
    }
  })

  it('REDACT_RATE_MASK 是 ***', () => {
    expect(REDACT_RATE_MASK).toBe('***')
  })
})
