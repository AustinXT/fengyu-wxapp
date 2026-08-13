import { describe, expect, it } from 'vitest'
import type { Employee } from './types'
import {
  formatOrderServiceStaffOption,
  getOrderServiceStaffCandidates,
  isOrderServiceStaffCandidate,
} from './order-service-staff'

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

describe('getOrderServiceStaffCandidates', () => {
  const employee = (
    employeeId: string,
    name: string,
    storeId: string,
    isOnBusinessTrip = false,
  ) => ({
    ...base,
    employeeId,
    name,
    storeId,
    isOnBusinessTrip,
  } as Employee)

  it('本门店员工优先于外店出差员工，同组按姓名排序', () => {
    const result = getOrderServiceStaffCandidates([
      employee('trip-a', 'Alpha Trip', 'store-b', true),
      employee('local-z', 'Zulu Local', 'store-a'),
      employee('trip-z', 'Zulu Trip', 'store-c', true),
      employee('local-a', 'Alpha Local', 'store-a'),
    ], 'store-a')

    expect(result.map((item) => item.employeeId)).toEqual([
      'local-a',
      'local-z',
      'trip-a',
      'trip-z',
    ])
  })

  it('继续排除非本店且未出差的员工', () => {
    const result = getOrderServiceStaffCandidates([
      employee('local', '本店', 'store-a'),
      employee('other', '外店', 'store-b'),
    ], 'store-a')

    expect(result.map((item) => item.employeeId)).toEqual(['local'])
  })
})

describe('formatOrderServiceStaffOption', () => {
  it('外店出差员工追加（外援），本店员工不追加', () => {
    const staff = {
      name: '美容师甲',
      positionName: '高级美容师',
      storeId: 'store-b',
      isOnBusinessTrip: true,
    }

    expect(formatOrderServiceStaffOption(staff, 'store-a')).toBe('美容师甲 (高级美容师)（外援）')
    expect(formatOrderServiceStaffOption({ ...staff, storeId: 'store-a' }, 'store-a')).toBe('美容师甲 (高级美容师)')
  })
})
