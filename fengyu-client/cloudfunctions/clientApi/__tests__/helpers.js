/**
 * 测试辅助工具
 */

/**
 * 创建标准 ctx 对象（客户端用户）
 * @param {Object} overrides - 覆盖默认值
 */
function createCtx(overrides = {}) {
  return {
    event: {
      action: overrides.action || 'test.action',
      payload: overrides.payload || {},
      ...(overrides.event || {}),
    },
    context: {},
    auth: {
      isOpenid: true,
      openid: 'test-openid-001',
      userId: 'user-001',
      phone: '13800001111',
      boundStoreId: 'store-001',
      boundStoreName: '凤御测试店',
      boundMarketName: '华东市场',
      ...(overrides.auth || {}),
    },
    result: null,
  }
}

/**
 * 创建已绑定手机号的用户 ctx
 */
function createBoundCtx(payload = {}, authOverrides = {}) {
  return createCtx({
    payload,
    auth: {
      phone: '13800001111',
      boundStoreId: 'store-001',
      boundStoreName: '凤御测试店',
      boundMarketName: '华东市场',
      ...authOverrides,
    },
  })
}

/**
 * 创建新用户 ctx（未绑定手机号/门店）
 */
function createNewUserCtx(payload = {}) {
  return createCtx({
    payload,
    auth: {
      userId: null,
      phone: null,
      boundStoreId: null,
      boundStoreName: null,
      boundMarketName: null,
    },
  })
}

/**
 * 模拟 pg.transaction 的 client
 * 支持链式 mockResolvedValueOnce
 */
function createMockTransactionClient(queryResults = []) {
  const mockQuery = vi.fn()
  for (const result of queryResults) {
    mockQuery.mockResolvedValueOnce(result)
  }
  // 默认返回空行
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  return { query: mockQuery }
}


/**
 * 把一段 SQL 的 WHERE 子句（或判据常量的反引号内容）规范化成**条件列表**（issue #215）。
 *
 * ⚠️ 守卫同源不能只断言「子串都在」——那样 `AND → OR`、或任一侧多加一条守卫，
 * 子串照样全在，漂移锁就成了摆设。这里连接符、条件集合、条件数量都锁住，
 * 出现 OR 直接抛错。`expect` 由调用方做，helper 只负责规范化。
 *
 * ⚠️ 已知限制：按 ` AND ` 切分，所以守卫里若出现**含 AND 的字符串字面量**会被误拆。
 * 现有守卫的字面量（'待支付' / '转换单'）都不含，且误拆方向是转红而非静默通过（fail-loud）。
 */
function sqlConjuncts(sqlText) {
  const body = sqlText
    .replace(/[\s\S]*?WHERE /, '')       // 只留 WHERE 之后
    .replace(/[\s\S]*?=\s*\n?\s*`/, '')  // 常量声明则只留反引号内的
    .replace(/--[^\n]*/g, '')            // SQL 行注释（card.js 的守卫里就有）
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/\bOR\b/.test(body)) {
    throw new Error(`守卫必须是纯合取，但出现了 OR：${body}`)
  }
  return body
    .split(/\s+AND\s+/)
    .map((c) => c.trim().replace(/^o\./, '').replace(/\s+/g, ' '))
    .filter((c) => c && c !== 'sale_order_id = $1')
    .sort()
}

/** 从源码里按锚点切出一段，锚点缺失直接抛错（`slice(x, -1)` 会静默切出大半个文件） */
function sliceBetweenAnchors(source, startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor)
  if (start < 0) throw new Error(`未找到锚点: ${startAnchor}`)
  const end = source.indexOf(endAnchor, start)
  if (end <= start) throw new Error(`未找到结束锚点: ${endAnchor}`)
  return source.slice(start, end)
}

module.exports = {
  sqlConjuncts,
  sliceBetweenAnchors,
  createCtx,
  createBoundCtx,
  createNewUserCtx,
  createMockTransactionClient,
}
