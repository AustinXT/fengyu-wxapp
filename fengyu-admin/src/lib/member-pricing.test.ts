import { describe, it, expect } from 'vitest'
import { isMember, resolveUnitPrice } from './member-pricing'

describe('isMember', () => {
  it('会员客 → true', () => {
    expect(isMember('会员客', null)).toBe(true)
  })
  it('有钻石等级（member_level 非空）→ true', () => {
    expect(isMember('流量客', '星钻')).toBe(true)
    expect(isMember(null, '初钻')).toBe(true)
  })
  it('流量客 + 无等级 → false', () => {
    expect(isMember('流量客', null)).toBe(false)
    expect(isMember('流量客', '')).toBe(false)
  })
  it('全空 / undefined → false', () => {
    expect(isMember(null, null)).toBe(false)
    expect(isMember(undefined, undefined)).toBe(false)
    expect(isMember()).toBe(false)
  })
})

describe('resolveUnitPrice', () => {
  it('非会员普通商品（会员价 < 标价）→ 标价', () => {
    expect(resolveUnitPrice({ price: '200', specialPrice: '150', isExperience: false }, false)).toEqual({
      listUnit: 200,
      realUnit: 200,
    })
  })
  it('会员普通商品（会员价 < 标价）→ 会员价', () => {
    expect(resolveUnitPrice({ price: '200', specialPrice: '150' }, true)).toEqual({
      listUnit: 200,
      realUnit: 150,
    })
  })
  it('体验卡（is_experience）非会员 → 标价（#6=B，不再豁免）', () => {
    expect(resolveUnitPrice({ price: '500', specialPrice: '100', isExperience: true }, false)).toEqual({
      listUnit: 500,
      realUnit: 500,
    })
  })
  it('体验卡（is_experience）会员 → 会员价（与普通商品同口径）', () => {
    expect(resolveUnitPrice({ price: '500', specialPrice: '100', isExperience: true }, true)).toEqual({
      listUnit: 500,
      realUnit: 100,
    })
  })
  it('会员价 ≥ 标价（脏数据）→ 取标价（即使会员）', () => {
    expect(resolveUnitPrice({ price: '100', specialPrice: '100' }, true).realUnit).toBe(100)
    expect(resolveUnitPrice({ price: '100', specialPrice: '120' }, true).realUnit).toBe(100)
  })
  it('无会员价（null / 空串）→ 取标价', () => {
    expect(resolveUnitPrice({ price: '200', specialPrice: null }, true).realUnit).toBe(200)
    expect(resolveUnitPrice({ price: '200', specialPrice: '' }, true).realUnit).toBe(200)
    expect(resolveUnitPrice({ price: '200' }, true).realUnit).toBe(200)
  })
  it('数字入参与非法标价兜底为 0', () => {
    expect(resolveUnitPrice({ price: 200, specialPrice: 150 }, true).realUnit).toBe(150)
    expect(resolveUnitPrice({ price: 'abc', specialPrice: '50' }, true)).toEqual({ listUnit: 0, realUnit: 0 })
  })
})
