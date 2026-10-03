const test = require('node:test')
const assert = require('node:assert/strict')
const { checkExperiencePaginationCompat, LEGACY_EXPERIENCE_LIMIT } = require('../check-experience-pagination-compat.cjs')
for (const count of [0, 7, 20]) test(`兼容期${count}条放行`, async () => {
  assert.equal(await checkExperiencePaginationCompat({ query: async sql => {
    assert.match(sql, /is_experience = true AND is_enabled = true AND deleted_at IS NULL/)
    return { rows: [{ count }] }
  } }), count)
})
test('21条拒绝，不能让旧前端静默漏卡', async () => {
  await assert.rejects(checkExperiencePaginationCompat({ query: async () => ({rows:[{count:21}]}) }), /旧前端只能显示20条/)
})
test('数据库不可用或计数无效也不能放行', async () => {
  await assert.rejects(checkExperiencePaginationCompat({ query: async () => {throw Error('offline')} }))
  await assert.rejects(checkExperiencePaginationCompat({ query: async () => ({rows:[]}) }), /无效/)
})

test('兼容门禁阈值必须等于真实路由默认页大小', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const filename = path.resolve(__dirname, '../../fengyu-client/cloudfunctions/clientApi/routes/product.js')
  const routeModule = { exports: {} }
  // 加载真实路由源码；只隔离本测试不调用的数据库与图片依赖，不连接任何业务库。
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: routeModule,
    require: name => {
      assert.ok(name === '../db/pg' || name === '../utils/image', `unexpected dependency: ${name}`)
      return {}
    },
  }, { filename })
  assert.equal(LEGACY_EXPERIENCE_LIMIT, routeModule.exports.__pageSizeCaliber.PRODUCT_PAGE_SIZE_DEFAULT)
})
