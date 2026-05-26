#!/usr/bin/env bun
/**
 * auth.bindPhone 冒烟
 *
 * 验证：CloudID 绑定找到已有员工行 → 写入 openid + 返 roles + invalidateAuthCache
 * 安全守护：phoneNumber 明文直传未开 ALLOW_DIRECT_PHONE → 被拒（防绑任意员工手机号提权）
 *
 * 注意：bindPhone 读 cloud.getWXContext().OPENID（无 _testOpenid override）。
 * 通过 globalThis.__e2e_current_openid__ 在调用前覆盖（wx-server-sdk-mock 支持）。
 */
import './setup.mjs'
import { NS, TEST_MANAGER_EMP_ID, TEST_MANAGER_PHONE, pgQuery, closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-auth-bindphone] start`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  // 清空 openid 模拟"档案存在但未绑定"
  await pgQuery(`UPDATE staff_wechat_users SET openid = NULL WHERE employee_id = $1`, [TEST_MANAGER_EMP_ID])

  // 覆盖 mock OPENID
  const bindOpenid = `${NS}_BIND_OPENID`
  globalThis.__e2e_current_openid__ = bindOpenid

  const errors = []

  // directPhone 直传旁路已默认关闭，走 CloudID mock（phoneData 注入 event 顶层模拟平台解密）
  const r = await invokeStaffApi('auth.bindPhone', {}, { phoneData: { data: { purePhoneNumber: TEST_MANAGER_PHONE } } })
  if (r.code !== 0) errors.push(`bindPhone code=${r.code} msg=${r.message}`)
  else {
    if (r.data.staffWfId !== TEST_MANAGER_EMP_ID) errors.push(`staffWfId 应=${TEST_MANAGER_EMP_ID}`)
    if (!Array.isArray(r.data.roles) || !r.data.roles.includes('manager')) {
      errors.push(`roles 应含 manager，实际=${JSON.stringify(r.data.roles)}`)
    }
    rec(`  ✓ bindPhone OK: emp=${r.data.staffWfId} roles=${JSON.stringify(r.data.roles)}`)
  }

  // PG: openid 已写入
  const row = (await pgQuery(`SELECT openid FROM staff_wechat_users WHERE employee_id = $1`, [TEST_MANAGER_EMP_ID]))[0]
  if (row.openid !== bindOpenid) errors.push(`openid 未写入，实际='${row.openid}'`)

  // 安全守护：phoneNumber 明文直传未开 ALLOW_DIRECT_PHONE 必须被拒（防绑任意员工手机号 → 提权店长）
  const rDirect = await invokeStaffApi('auth.bindPhone', { phoneNumber: TEST_MANAGER_PHONE })
  if (rDirect.code === 0) {
    errors.push('directPhone 直传未开 ALLOW_DIRECT_PHONE 却成功（应被拒）')
  } else if (!(rDirect.message || '').includes('直传未启用')) {
    errors.push(`directPhone 拒绝消息不符，实际='${rDirect.message}'`)
  } else {
    rec(`  ✓ directPhone 直传被拒（安全守护）`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL`); for (const e of errors) rec(`    - ${e}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — bindPhone 关联已有员工 + roles 派生正确`)
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message); console.error(e.stack) }
finally {
  globalThis.__e2e_current_openid__ = null
  try { await cleanupTestData(NS) } catch {}
  await closePool()
  console.log(`[smoke-auth-bindphone] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
