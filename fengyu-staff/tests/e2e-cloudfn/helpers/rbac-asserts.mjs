/**
 * RBAC / 越权拒绝 smoke 共用断言 + 调用 helper
 *
 * 设计：每个测试用例都是 (员工 openid + payload) → (期望 code / errorType / message 前缀)。
 * 不再展开 try/catch；调用方只关心结果摘要。
 */
import { invokeStaffApi } from './invoke.mjs'
import { invalidateStaffAuthCache } from './fixtures.mjs'

/**
 * 调用并断言成功（code === 0）
 * 返回云函数 data 供后续断言（不抛）。
 *
 * @param {string} action
 * @param {object} payload - 必含 _testOpenid
 * @param {string} label - 描述当前用例
 * @returns {Promise<{ok: boolean, data: any, message?: string, code?: number}>}
 */
export async function expectOk(action, payload, label) {
  const r = await invokeStaffApi(action, payload)
  if (r.code !== 0) {
    return { ok: false, code: r.code, message: r.message, errorType: r.errorType, data: r.data, label }
  }
  return { ok: true, data: r.data, label }
}

/**
 * 调用并断言失败（期望 errorType 前缀匹配）
 *
 * @param {string} action
 * @param {object} payload
 * @param {string} expectedPrefix - 'PERMISSION_DENIED' / 'INVALID_PARAMS' / ...
 * @param {string} label
 * @returns {Promise<{ok: boolean, errorType?, code?, message?, label}>}
 */
export async function expectFail(action, payload, expectedPrefix, label) {
  const r = await invokeStaffApi(action, payload)
  // errorType 是 buildErrorResponse 提取的一级前缀；message 含完整 'PERMISSION_DENIED: xxx'
  const typeMatch = r.errorType === expectedPrefix
  const msgMatch = typeof r.message === 'string' && r.message.startsWith(expectedPrefix + ':')
  if (r.code === 0) {
    return { ok: false, label, reason: `expected fail ${expectedPrefix}, got code=0`, message: JSON.stringify(r.data) }
  }
  if (!typeMatch && !msgMatch) {
    return { ok: false, label, reason: `expected ${expectedPrefix}, got errorType=${r.errorType} message=${r.message}` }
  }
  return { ok: true, label, errorType: r.errorType, message: r.message }
}

/**
 * 调用 auth.login 拿到 staffLevel / scopeStoreIds 等关键 ctx 字段
 *
 * 注意：login 路由本身不一定显式回 staffLevel；为了拿到 ctx 派生量，
 * 我们调一个走 auth 中间件但不要权限的轻量 action（store.list 即可）。
 * 但 staffApi/auth.login 实际会返回基础信息；这里直接调 auth.login 即可。
 *
 * @param {string} openid - _testOpenid
 * @param {string|null} loginLevel - 'store' | 'management' | null
 * @returns {Promise<{ok: boolean, data?: any, code?, message?}>}
 */
export async function login(openid, loginLevel = null) {
  const payload = { _testOpenid: openid }
  if (loginLevel) payload._loginLevel = loginLevel
  // 缓存可能被前一轮污染，先清
  await invalidateStaffAuthCache(openid)
  return invokeStaffApi('auth.login', payload)
}

/**
 * 收集一批结果，统一返回 errors 数组
 * @param {Array<{ok: boolean, label: string, reason?: string}>} results
 * @returns {string[]} errors
 */
export function collectErrors(results) {
  const errors = []
  for (const r of results) {
    if (!r.ok) {
      const detail = r.reason || r.message || `code=${r.code} type=${r.errorType}`
      errors.push(`[${r.label}] ${detail}`)
    }
  }
  return errors
}

/**
 * smoke runner：跑一组用例，全部 ok 则 PASS，否则汇总错误打印 + FAIL
 *
 * @param {string} smokeName
 * @param {() => Promise<Array<{ok, label, reason?}>>} runFn
 * @param {() => Promise<void>} cleanup
 */
export async function runSmoke(smokeName, runFn, cleanup) {
  let pass = false
  let exitCode = 1
  const start = Date.now()
  console.log(`[${smokeName}] start | ${new Date().toISOString()}`)
  try {
    const results = await runFn()
    const errors = collectErrors(results)
    const okCount = results.filter((r) => r.ok).length
    console.log(`  cases: ${results.length} | ok=${okCount} | fail=${errors.length}`)
    if (errors.length === 0) {
      pass = true
      exitCode = 0
      console.log(`  ✅ PASS — ${results.length} cases`)
    } else {
      console.log(`  ✗ FAIL — ${errors.length} cases:`)
      for (const e of errors) console.log(`    - ${e}`)
    }
  } catch (e) {
    console.error(`[${smokeName}] EXCEPTION:`, e?.message || e)
    if (e?.stack) console.error(e.stack)
  } finally {
    try {
      if (cleanup) await cleanup()
    } catch (e) {
      console.error(`[${smokeName}] cleanup error:`, e?.message || e)
    }
    console.log(`[${smokeName}] end | ${pass ? 'PASS' : 'FAIL'} | ${(Date.now() - start) / 1000}s`)
    process.exit(exitCode)
  }
}
