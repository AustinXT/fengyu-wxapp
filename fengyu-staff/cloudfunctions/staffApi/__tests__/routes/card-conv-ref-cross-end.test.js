/**
 * F6 转换差额 card-conv- external_ref 白名单跨端守护（staff 侧）。
 *
 * admin 侧同构副本：
 * fengyu-admin/src/lib/__tests__/card-conv-ref-cross-end.test.ts
 * 改一端必须同步另一端。
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const adminSrc = fs.readFileSync(path.resolve(REPO_ROOT, 'fengyu-admin/src/actions/orders.ts'), 'utf-8')
const staffSrc = fs.readFileSync(
  path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/routes/order.js'),
  'utf-8',
)

const adminPrefixMatch = adminSrc.match(/`'([^']+)' \|\| \$\{saleOrders\.saleOrderId\}`/)
const staffPrefixMatch = staffSrc.match(/`(card-[a-z-]+)\$\{convOrderId\}`/)
if (!adminPrefixMatch) throw new Error('未找到 admin card-conv- 白名单前缀')
if (!staffPrefixMatch) throw new Error('未找到 staff card-conv- 写入前缀')
const adminPrefix = adminPrefixMatch[1]
const staffPrefix = staffPrefixMatch[1]

describe('F6 转换差额 card-conv- external_ref 白名单跨端守护（staff 侧）', () => {
  test('admin 白名单前缀与 staff 写入前缀字面一致（均为 card-conv-）', () => {
    expect(adminPrefix).toBe('card-conv-')
    expect(staffPrefix).toBe(adminPrefix)
  })

  test('admin 白名单形态必须是 or(isNull(externalRef), eq(externalRef, 前缀拼接))', () => {
    expect(adminSrc).toMatch(
      /or\(\s*isNull\(cardTransactions\.externalRef\),\s*eq\(\s*cardTransactions\.externalRef,\s*sql<string>`'card-conv-' \|\|/,
    )
  })

  test('admin 导出行限定 转换单 + 充值 + 正数金额', () => {
    expect(adminSrc).toMatch(/eq\(saleOrders\.saleOrderType, '转换单'\)/)
    expect(adminSrc).toMatch(/eq\(cardTransactions\.type, '充值'\)/)
    expect(adminSrc).toMatch(/gt\(cardTransactions\.amount, '0'\)/)
  })

  test('staff INSERT 必须写 external_ref 列并以 ON CONFLICT 幂等', () => {
    expect(staffSrc).toMatch(
      /INSERT INTO card_transactions \(card_id, type, amount, ref_order_id, external_ref\)/,
    )
    expect(staffSrc).toMatch(
      /ON CONFLICT \(external_ref\) WHERE external_ref IS NOT NULL DO NOTHING/,
    )
  })

  test('staff 写入值必须用同一前缀拼接', () => {
    expect(staffSrc).toMatch(/`card-conv-\$\{convOrderId\}`/)
  })
})
