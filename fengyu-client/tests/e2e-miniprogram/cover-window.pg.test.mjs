import test from 'node:test'
import assert from 'node:assert/strict'
import { startCoverWindowPgFixture } from './cover-window-pg-fixture.mjs'

const url = process.env.COVER_WINDOW_PG_TEST_URL

test('私有完整schema：真实体验卡路由遍历200条，无重复遗漏且每页有界', { skip: !url }, async () => {
  const fixture = await startCoverWindowPgFixture(url)
  try {
    const ids = []
    let cursor = null
    for (let page = 0; page < 10; page++) {
      const response = await fixture.invoke({ limit: 20, cursor })
      assert.equal(response.result.code, 0)
      const { skuList, hasMore, nextCursor } = response.result.data
      assert.equal(skuList.length, 20)
      ids.push(...skuList.map(row => row.sku_id))
      assert.equal(hasMore, page < 9)
      if (page < 9) assert.ok(nextCursor)
      else assert.equal(nextCursor, null)
      cursor = nextCursor
    }
    assert.equal(new Set(ids).size, 200)
    assert.deepEqual(ids, Array.from({ length: 200 }, (_, i) => 'COVER273-S' + String(i).padStart(4, '0')))
    const capped = await fixture.invoke({ limit: 999 })
    assert.equal(capped.result.data.skuList.length, 50)
  } finally {
    await fixture.close()
  }
})
