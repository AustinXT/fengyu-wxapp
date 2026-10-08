const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../../../../..')
const files = ['fengyu-staff/cloudfunctions/staffApi/utils/conversion-value.js', 'fengyu-client/cloudfunctions/clientApi/utils/conversion-value.js', 'fengyu-client/cloudfunctions/payNotify/conversion-value.js', 'fengyu-admin/src/lib/conversion-value.ts']
const extract = (file, name) => fs.readFileSync(path.join(root,file),'utf8').match(new RegExp('const '+name+' = `([\\s\\S]*?)`'))[1]
describe('#548 四端转换资产与现金增量SQL独立副本', () => {
  test.each(['CONVERSION_VALUE_RECALC_SQL','CONVERSION_RECEIPT_SQL'])('%s 四端逐字相同',name => {
    const queries=files.map(f=>extract(f,name)); for(const q of queries) expect(q).toBe(queries[0])
    expect(queries[0]).toMatchSnapshot()
  })
  test('现金仅分给未退项，前后分币差共用同一资产CTE',()=>{
    const receipt=extract(files[0],'CONVERSION_RECEIPT_SQL'), value=extract(files[0],'CONVERSION_VALUE_RECALC_SQL')
    expect(receipt).toContain('t.gross_value - $2::numeric - t.reserved')
    expect(receipt).toContain('AND NOT r.exited AND r.paid_value IS NULL')
    const prefix=q=>q.slice(0,q.indexOf('), ranked AS ('))
    expect(prefix(receipt)).toBe(prefix(value))
  })
  test.each(files)('%s 单端改金额公式不能蒙混通过',file=>{
    const q=extract(file,'CONVERSION_RECEIPT_SQL');expect(q.replace('t.gross_value - $2::numeric','t.gross_value')).not.toBe(q)
  })
})

// 余额表达式也是四端合同，不能只守受领/权益写入。
describe('#548 四端权威欠款守卫', () => {
  test('conversionDebtSql 的完整查询四端相同且拒绝非法引用', () => {
    const js = files.slice(0,3).map(file => require(path.join(root,file)))
    const expected = js[0].conversionDebtSql('so.sale_order_id')
    for (const module of js) {
      expect(module.conversionDebtSql('so.sale_order_id')).toBe(expected)
      expect(() => module.conversionDebtSql('so.sale_order_id;DROP TABLE sale_items')).toThrow('INVALID_PARAMS')
    }
    const ts = fs.readFileSync(path.join(root, files[3]),'utf8')
    const body = ts.split('function conversionDebtSql')[1].match(/return `([\s\S]*?)`/)[1]
    expect(body.replace(/\$\{orderExpression\}/g,'so.sale_order_id')).toBe(expected)
    expect(expected).toMatchSnapshot()
  })
  test.each(files)('%s getConversionDebt 运行时调用同一余额表达式且取数转Number', file => {
    const src = fs.readFileSync(path.join(root,file),'utf8').split('async function getConversionDebt')[1]
    expect(src).toContain("conversionDebtSql('so.sale_order_id')")
    expect(src).toContain('AS remaining FROM sale_orders so WHERE so.sale_order_id =')
    expect(src).toContain('Number(')
  })
})
