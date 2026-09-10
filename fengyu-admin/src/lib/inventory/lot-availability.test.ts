import { describe, it, expect } from 'vitest'
import { computeAvailableByLot } from './lot-availability'

describe('computeAvailableByLot — 批次可用量 = 在手 - 已预留', () => {
  // ⚠ 这些 id 必须写成字符串：原生 SQL（tx.execute）返回的 bigint 列由 postgres.js 原样给 string。
  // 改成 number 会让本用例失去意义 —— 历史上正是 Map key 一边 number 一边 string，
  // 导致 reservedByLot.get() 恒 miss、已预留量被静默忽略。
  it('lot.id 与 lot_id 都是 string 时仍能扣减预留量', () => {
    const result = computeAvailableByLot(
      [{ id: '101', quantity_on_hand: '10' }, { id: '102', quantity_on_hand: 5 }],
      [{ lot_id: '101', quantity: '4' }],
    )

    expect(result.get(101)).toBe(6)
    expect(result.get(102)).toBe(5)
  })

  it('number 与 string 混用（drizzle 与原生 SQL 混合来源）也能对上', () => {
    const result = computeAvailableByLot(
      [{ id: 101, quantity_on_hand: 10 }],
      [{ lot_id: '101', quantity: 3 }],
    )

    expect(result.get(101)).toBe(7)
  })

  it('预留量超过在手时归零，不产生负可用量', () => {
    const result = computeAvailableByLot(
      [{ id: '101', quantity_on_hand: '2' }],
      [{ lot_id: '101', quantity: '5' }],
    )

    expect(result.get(101)).toBe(0)
  })

  it('无预留记录时可用量等于在手量', () => {
    const result = computeAvailableByLot([{ id: '101', quantity_on_hand: '8' }], [])

    expect(result.get(101)).toBe(8)
  })

  it('预留命中不属于本次批次集合的 lot_id 时忽略，不影响其它批次', () => {
    const result = computeAvailableByLot(
      [{ id: '101', quantity_on_hand: '8' }],
      [{ lot_id: '999', quantity: '8' }],
    )

    expect(result.get(101)).toBe(8)
    expect(result.size).toBe(1)
  })
})
