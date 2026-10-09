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
      || n.type === 'VariableDeclaration' && n.declarations[0].id.name === 'CONVERSION_POINT_OFFSETS_SQL').map(canonical)
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
