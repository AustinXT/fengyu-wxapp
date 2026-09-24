import { describe, expect, it } from 'vitest'
import { formatServiceStaffOption } from './service-staff-candidate'

describe('formatServiceStaffOption', () => {
  it('本店人员不加后缀，角色·部门与员工端 label 同构', () => {
    expect(formatServiceStaffOption({
      employeeId: 'FY-1',
      name: '本店美容师',
      skills: ['美容师'],
      departmentName: '美容部',
      assignmentScope: 'local',
    })).toBe('本店美容师（美容师·美容部）')
  })

  it('市场内出差支援人员带「（外援）」后缀', () => {
    expect(formatServiceStaffOption({
      employeeId: 'FY-2',
      name: '市场养生师',
      skills: ['养生师'],
      departmentName: '养生部',
      assignmentScope: 'same_market_trip',
    })).toBe('市场养生师（养生师·养生部）（外援）')
  })

  it('多技能按白名单顺序拼接，非白名单技能不展示', () => {
    expect(formatServiceStaffOption({
      employeeId: 'FY-3',
      name: '多面手',
      skills: ['美容师', '推广部', '店经理'],
      departmentName: '美容部',
      assignmentScope: 'local',
    })).toBe('多面手（店经理/美容师·美容部）')
  })

  it('角色与部门都缺失时退化成「未分组」，姓名缺失兜底工号', () => {
    expect(formatServiceStaffOption({
      employeeId: 'FY-4',
      name: null,
      skills: null,
      departmentName: undefined,
      assignmentScope: 'same_market_trip',
    })).toBe('FY-4（未分组）（外援）')
  })
})
