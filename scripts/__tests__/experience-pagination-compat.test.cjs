const test = require('node:test')
const assert = require('node:assert/strict')
const { checkExperiencePaginationCompat } = require('../check-experience-pagination-compat.cjs')
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
