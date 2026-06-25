/**
 * 跨端会员价分流（member-pricing）一致性守护（admin 侧 vitest）
 *
 * resolveUnitPrice / isMember 在四端独立副本（用户已 veto cloudfunctions-shared）：
 *   ├── fengyu-admin/src/lib/member-pricing.ts                       (TS, camelCase 入参)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/member-pricing.js (CJS, snake_case)
 *   └── fengyu-client/cloudfunctions/clientApi/utils/member-pricing.js (CJS, snake_case)
 * （client miniprogram utils/member-pricing.ts 的 priceView 是展示层镜像，由前端 tsc 守护，不在此比对。）
 *
 * 守护两件事：
 *   1) 两份云函数 .js 副本逐字节一致（项目约定「字节一致」）。
 *   2) 三端 resolveUnitPrice 对同一组输入返回相同 {listUnit, realUnit}，isMember 同口径。
 *      任一端漂移（如改了体验卡豁免、会员判定口径、严格 < 比较）→ 测试失败 → 提醒同步其它端。
 *
 * ⚠️ 业务口径锁定（#6=B，2026-06-25）：体验卡不再豁免，与普通单品同口径
 *    （会员=会员价 special，非会员=标价 list）。下方「体验卡 + 非会员 → 标价」用例即守护此决策。
 */

import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveUnitPrice as adminResolve, isMember as adminIsMember } from '@/lib/member-pricing'

const requireFromHere = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// admin/src/lib/__tests__/ → repo root 上 4 级
const REPO_ROOT = path.resolve(__dirname, '../../../..')

const CLIENT_JS = path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/utils/member-pricing.js')
const STAFF_JS = path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/utils/member-pricing.js')

const clientMod = requireFromHere(CLIENT_JS)
const staffMod = requireFromHere(STAFF_JS)

/** 测试矩阵：每行 = 一种 (sku, member) 组合 + 期望成交基线。 */
const CASES: Array<{
  name: string
  price: number
  special: number | null
  isExperience: boolean
  member: boolean
  expectList: number
  expectReal: number
}> = [
  { name: '普通商品 + 会员 → 会员价', price: 200, special: 160, isExperience: false, member: true, expectList: 200, expectReal: 160 },
  { name: '普通商品 + 非会员 → 标价', price: 200, special: 160, isExperience: false, member: false, expectList: 200, expectReal: 200 },
  // #6=B 锁定：体验卡按会员分流，不再对非会员豁免
  { name: '体验卡 + 会员 → 会员价', price: 298, special: 99, isExperience: true, member: true, expectList: 298, expectReal: 99 },
  { name: '体验卡 + 非会员 → 标价（#6=B，不再豁免）', price: 298, special: 99, isExperience: true, member: false, expectList: 298, expectReal: 298 },
  { name: '会员价 == 标价（脏数据 guard，不优惠）', price: 200, special: 200, isExperience: false, member: true, expectList: 200, expectReal: 200 },
  { name: '会员价 > 标价（脏数据 guard，不优惠）', price: 200, special: 260, isExperience: false, member: true, expectList: 200, expectReal: 200 },
  { name: 'special 为 null → 标价', price: 200, special: null, isExperience: false, member: true, expectList: 200, expectReal: 200 },
]

describe('member-pricing 跨端一致性', () => {
  test('两份云函数副本逐字节一致（clientApi == staffApi）', () => {
    const a = fs.readFileSync(CLIENT_JS, 'utf8')
    const b = fs.readFileSync(STAFF_JS, 'utf8')
    expect(a).toBe(b)
  })

  test('isMember 三端同口径（会员客 或 有钻石等级）', () => {
    const matrix: Array<[string | null, string | null, boolean]> = [
      ['会员客', null, true],
      ['流量客', '星钻', true],
      ['流量客', '', false],
      ['流量客', null, false],
      [null, null, false],
    ]
    for (const [ct, lvl, expected] of matrix) {
      expect(adminIsMember(ct, lvl)).toBe(expected)
      expect(clientMod.isMember(ct, lvl)).toBe(expected)
      expect(staffMod.isMember(ct, lvl)).toBe(expected)
    }
  })

  test.each(CASES)('resolveUnitPrice 三端一致：$name', (c) => {
    // snake_case（云函数）与 camelCase（admin TS）两种入参形态
    const snake = { price: c.price, special_price: c.special, is_experience: c.isExperience }
    const camel = { price: c.price, specialPrice: c.special, isExperience: c.isExperience }

    const client = clientMod.resolveUnitPrice(snake, c.member)
    const staff = staffMod.resolveUnitPrice(snake, c.member)
    const admin = adminResolve(camel, c.member)

    // 期望值
    expect(admin).toEqual({ listUnit: c.expectList, realUnit: c.expectReal })
    // 三端一致
    expect(client).toEqual(admin)
    expect(staff).toEqual(admin)
  })
})
