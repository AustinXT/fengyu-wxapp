/** #300：四端转换单 receipt 增量 SQL 整段一致，并钉住与兑现价值重算的关系。 */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../../../../..')
const files = [
  'fengyu-staff/cloudfunctions/staffApi/utils/payment-allocatable.js',
  'fengyu-client/cloudfunctions/clientApi/utils/payment-allocatable.js',
  'fengyu-client/cloudfunctions/payNotify/payment-allocatable.js',
  'fengyu-admin/src/lib/payment-allocatable.ts',
]
const normalize = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\$\{saleOrderId\}/g, '$1')
  .replace(/\$\{evt\}/g, '$2').replace(/\s+/g, ' ').replace(/\s+\)/g, ')').trim()
function extract(src) {
  const match = src.match(/`\s*(WITH conversion_receipt_order AS[\s\S]*?)`/)
  expect(match, '转换 receipt SQL 必须存在').not.toBeNull()
  return normalize(match[1])
}

describe('#300 转换单 receipt 四端整段守护', () => {
  const queries = files.map((file) => extract(fs.readFileSync(path.join(root,file),'utf8')))
  test.each(files.map((file,i) => [file,i]))('%s 与 staff 的完整增量 SQL 相等', (_file,i) => {
    expect(queries[i]).toBe(queries[0])
  })
  test('完整 SQL 快照：转出固定、转入取前后分币差，不丢掉负的一分尾差', () => {
    expect(queries[0]).toMatchSnapshot()
    expect(queries[0]).toContain('net_received - $2::numeric')
    expect(queries[0]).toContain('WHERE a.amount <> 0')
  })
  test('receipt 当前值规则与 paid-sessions STEP 1.6 的完整计算相等', () => {
    const paid = fs.readFileSync(path.join(root,'fengyu-staff/cloudfunctions/staffApi/utils/paid-sessions.js'),'utf8')
      .match(/const CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL = `([\s\S]*?)`/)[1]
    const expected = normalize(paid).split(' UPDATE sale_items si')[0]
    const currentRule = queries[0].replace(/conversion_receipt_order/g,'conversion_order')
      .replace(/, LEAST\(conversion_order\.in_total, GREATEST\(0, conversion_order\.converted_value \+ GREATEST\(0, conversion_order\.net_received - \$2::numeric\) - conversion_order\.waived_in_received\)\) AS target_before/, '')
      .replace(/ - \( ROUND\(target_before \* cumulative_sale_amount \/ in_total, 2\) - ROUND\(target_before \* \(cumulative_sale_amount - item_sale_amount\) \/ in_total, 2\)\)/, '')
      .replace('AS amount','AS item_received').split(' SELECT a.sale_item_id')[0]
    expect(currentRule).toBe(expected)
  })
  test.each([0,1,2,3])('第 %i 端独自改分摊日期外的任意金额规则必须不相等', (i) => {
    expect(queries[i].replace('net_received - $2::numeric','net_received')).not.toBe(queries[0])
  })
})
