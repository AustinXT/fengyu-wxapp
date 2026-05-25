import { describe, it, expect } from 'vitest'
import { mergeEmployeesById } from './merge-employees'
import type { Employee } from '@/lib/types'

/** 构造合法的最小 Employee 夹具（必填字段给值，其余走默认 null）。 */
function makeEmployee(overrides: Partial<Employee> & Pick<Employee, 'employeeId'>): Employee {
  return {
    openid: null,
    phone: null,
    name: null,
    gender: null,
    idCard: null,
    storeId: null,
    orgNodeId: null,
    positionName: null,
    avatarUrl: null,
    birthday: null,
    skills: null,
    isResigned: false,
    hiredAt: null,
    resignedAt: null,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('mergeEmployeesById', () => {
  it('多个列表按 employeeId 去重，重复 id 保留首次出现的记录', () => {
    const first = makeEmployee({ employeeId: 'E1', name: '甲', storeId: 'S-FIRST' })
    const dup = makeEmployee({ employeeId: 'E1', name: '甲改', storeId: 'S-SECOND' })
    const other = makeEmployee({ employeeId: 'E2', name: '乙' })

    const result = mergeEmployeesById([first], [dup, other])

    expect(result).toHaveLength(2)
    const e1 = result.find((e) => e.employeeId === 'E1')!
    // 保留的是第一个列表里的那条（字段值能区分）
    expect(e1.name).toBe('甲')
    expect(e1.storeId).toBe('S-FIRST')
    expect(e1).toBe(first)
  })

  it('结果按 name 升序排列', () => {
    const result = mergeEmployeesById([
      makeEmployee({ employeeId: 'E3', name: 'Charlie' }),
      makeEmployee({ employeeId: 'E1', name: 'Alice' }),
      makeEmployee({ employeeId: 'E2', name: 'Bob' }),
    ])

    expect(result.map((e) => e.name)).toEqual(['Alice', 'Bob', 'Charlie'])
  })

  it('空列表输入返回空数组', () => {
    expect(mergeEmployeesById([])).toEqual([])
  })

  it('全空输入（无参数）返回空数组', () => {
    expect(mergeEmployeesById()).toEqual([])
  })

  it('多个空列表返回空数组', () => {
    expect(mergeEmployeesById([], [], [])).toEqual([])
  })

  it('单个列表也能正常工作（去重 + 排序）', () => {
    const result = mergeEmployeesById([
      makeEmployee({ employeeId: 'E2', name: 'Bravo' }),
      makeEmployee({ employeeId: 'E1', name: 'Alpha' }),
      makeEmployee({ employeeId: 'E2', name: 'Bravo-重复' }),
    ])

    expect(result).toHaveLength(2)
    // localeCompare 升序：Alpha < Bravo
    expect(result.map((e) => e.name)).toEqual(['Alpha', 'Bravo'])
    // E2 去重保留首次出现的 'Bravo'（非 'Bravo-重复'）
    expect(result.find((e) => e.employeeId === 'E2')!.name).toBe('Bravo')
  })

  it('name 为 null/undefined 时 localeCompare 不报错', () => {
    const nullName = makeEmployee({ employeeId: 'E1', name: null })
    const undefName = makeEmployee({ employeeId: 'E2', name: undefined as unknown as string | null })
    const named = makeEmployee({ employeeId: 'E3', name: 'Zoe' })

    let result: Employee[] = []
    expect(() => {
      result = mergeEmployeesById([named], [nullName, undefName])
    }).not.toThrow()

    expect(result).toHaveLength(3)
    // null/undefined 折叠为 '' 排在最前
    expect(result[result.length - 1].name).toBe('Zoe')
  })
})
