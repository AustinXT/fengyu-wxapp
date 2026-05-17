#!/usr/bin/env bun
/**
 * auth.login 冒烟（注意：login 不读 _testOpenid，因此走 getWXContext mock）
 *
 * 验证：mock OPENID 无对应员工时返回 isNewUser:true（roles=[]）；
 *      因 wx-server-sdk-mock 默认 OPENID 不匹配 fixture，仅验证空路径。
 */
import './setup.mjs'
import { closePool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'

let pass = false; let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-auth-login] start`)
  const r = await invokeStaffApi('auth.login', {})
  if (r.code !== 0) { rec(`  ✗ login code=${r.code}`); return }
  if (r.data.isNewUser !== true) { rec(`  ✗ mock OPENID 无对应员工 isNewUser 应=true，实际=${r.data.isNewUser}`); return }
  if (!Array.isArray(r.data.roles) || r.data.roles.length !== 0) {
    rec(`  ✗ roles 应=[]，实际=${JSON.stringify(r.data.roles)}`); return
  }
  pass = true; exitCode = 0
  rec(`  ✅ PASS — login 新用户分支正确 (isNewUser=true, roles=[])`)
}
try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally { await closePool(); console.log(`end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`); process.exit(exitCode) }
