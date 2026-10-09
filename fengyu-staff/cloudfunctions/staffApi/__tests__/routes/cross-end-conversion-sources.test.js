const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('@babel/parser')
const root = path.resolve(__dirname, '../../../../..')
const files = ['fengyu-staff/cloudfunctions/staffApi/utils/conversion-sources.js','fengyu-client/cloudfunctions/clientApi/utils/conversion-sources.js','fengyu-client/cloudfunctions/payNotify/conversion-sources.js','fengyu-admin/src/lib/conversion-sources.ts']
function canonical(node) {
  if (Array.isArray(node)) return node.map(canonical)
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).filter(([key]) => !['start','end','loc','extra','comments','leadingComments','trailingComments','innerComments','typeAnnotation','returnType','typeParameters'].includes(key)).map(([key,value])=>[key,canonical(value)]))
}
function core(file) {
  const ast = parse(fs.readFileSync(path.join(root,file),'utf8'), {sourceType:'module',plugins:['typescript']})
  return ast.program.body.map(n => n.type === 'ExportNamedDeclaration' ? n.declaration : n)
    .filter(n => n.type === 'FunctionDeclaration' && n.id.name !== 'conversionSourceQuery'
      || n.type === 'VariableDeclaration' && ['CONVERSION_POINT_OFFSETS_SQL','CONVERSION_SOURCE_AUDIT_SQL','CONVERSION_UNKNOWN_POINT_SOURCE_SQL'].includes(n.declarations[0].id.name)).map(canonical)
}
describe('#548 四端来源和积分偏移独立副本合同',()=>{
  test.each(files)('%s 完整来源算法同义', file => expect(core(file)).toEqual(core(files[0])))
  test('来源使用整数分，乘积超过JS精确范围仍不失分',()=>{
    const {takeSources, snapshot, parseSnapshot}=require('../../utils/conversion-sources')
    const source=[{sourceOrderId:'S1',pointOrderId:'S1',valueCents:9999999999},{sourceOrderId:'S2',pointOrderId:'S2',valueCents:9999999998}]
    const taken=takeSources(source,9999999998)
    expect(taken.reduce((sum,s)=>sum+s.valueCents,0)).toBe(9999999998)
    expect(parseSnapshot(snapshot(taken)).sources).toEqual(taken)
    expect(()=>parseSnapshot({version:1,valueCents:100,sources:source})).toThrow('快照损坏')
  })
})

// paidRows方向也属于退款副本合同，防止异常/历史行让两端取数分叉。
test('#548 两端退款会计来源只取本单合法方向',()=>{
  const paths=['fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js','fengyu-admin/src/lib/refund-cascade.ts']
  const predicates=paths.map(file=>fs.readFileSync(path.join(root,file),'utf8').match(/WHERE si\.sale_order_id = [^\n]*?AND si\.item_direction = CASE WHEN[^\n]*?END ORDER BY si\.sale_item_id/)[0].replace(/\$\{\w+\}|\$\d+/g,'?').replace(/\s+/g,' ').trim())
  expect(predicates[0]).toBe(predicates[1])
  expect(predicates[0]).toContain("(SELECT sale_order_type FROM sale_orders WHERE sale_order_id = ?) = '转换单'")
})

test('#548 公共退款note保留金额和原因，去除内部来源，数据库原文不变',()=>{
  const {stripConversionSourcesFromNote}=require('../../utils/conversion-sources')
  const original=JSON.stringify({refundReason:'退一件',items:[{refSaleItemId:'A',paidAmount:1000,refundAmount:200,conversionSources:[{pointOrderId:'secret-root',valueCents:20000}]}]})
  const cleaned=JSON.parse(stripConversionSourcesFromNote(original))
  expect(cleaned).toEqual({refundReason:'退一件',items:[{refSaleItemId:'A',paidAmount:1000,refundAmount:200}]})
  expect(original).toContain('secret-root')
  expect(stripConversionSourcesFromNote('普通收款备注')).toBe('普通收款备注')
})

test('#548 四端原链读者必须实际调用凭据守卫，不能只有导入',()=>{
 const readers=['fengyu-admin/src/lib/points-settle.ts','fengyu-staff/cloudfunctions/staffApi/utils/points.js','fengyu-client/cloudfunctions/clientApi/utils/points.js','fengyu-client/cloudfunctions/payNotify/points.js'];
 for(const file of readers) {
  const src=fs.readFileSync(path.join(root,file),'utf8');
  expect(src).toMatch(/await assertConversionRefundSourcesKnown\(/);
  const guard=src.indexOf('await assertConversionRefundSourcesKnown(');
  expect(guard).toBeLessThan(src.indexOf('const sumRes ='));
 }
});
