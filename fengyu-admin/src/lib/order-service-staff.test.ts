import { describe, expect, it } from 'vitest'
import { isOrderServiceStaffCandidate } from './order-service-staff'

const base = {
  isResigned: false,
  storeId: 'store-a',
  skills: ['美容师'],
  isOnBusinessTrip: false,
}

describe('isOrderServiceStaffCandidate', () => {
  it.each(['美容师', '养生师'])('本门店%s可选', (skill) => {
    expect(isOrderServiceStaffCandidate({ ...base, skills: [skill] }, 'store-a')).toBe(true)
  })

  it('其他门店养生师仅在出差时可选', () => {
    const wellnessStaff = { ...base, storeId: 'store-b', skills: ['养生师'] }

    expect(isOrderServiceStaffCandidate(wellnessStaff, 'store-a')).toBe(false)
    expect(isOrderServiceStaffCandidate({ ...wellnessStaff, isOnBusinessTrip: true }, 'store-a')).toBe(true)
  })

  it('排除无绑定门店、已离职或无服务技能的人员', () => {
    expect(isOrderServiceStaffCandidate({ ...base, storeId: null }, 'store-a')).toBe(false)
    expect(isOrderServiceStaffCandidate({ ...base, isResigned: true }, 'store-a')).toBe(false)
    expect(isOrderServiceStaffCandidate({ ...base, skills: ['推广师'] }, 'store-a')).toBe(false)
  })
})
