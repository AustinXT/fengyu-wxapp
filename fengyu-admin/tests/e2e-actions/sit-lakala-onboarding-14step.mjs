#!/usr/bin/env bun
/**
 * Lakala SIT 14 步真业务联调
 *
 * 实际可达范围（用项目当前已有 SIT 凭证 OP00000003 + 默认商户 822290059430BFA）：
 *   ✅ 可跑：querySubMerchantId / queryWxRealname / queryAlipayRealname / queryWxConfig
 *           （只读 + 入参只需 merNo，不需要 org_code）
 *   ❌ 阻塞：applyContract / uploadAttachment / submitMerchant / queryMerchant /
 *           queryContract / submitAppeal / updateLakalaMerchantInfo
 *           （必填 org_code = 凤御四方机构号；项目无此值，需向拉卡拉客户经理申请）
 *   ⚠️ 需真人/真支付：submitWxRealname/submitAlipayRealname（生成扫码 URL 后法人扫码）；
 *                    完成交易（已被 arch/008 聚合主扫覆盖，非本次范围）
 *
 * 输出：每接口的 retCode、retMsg、关键响应字段、是否成功，最终汇总报告。
 */
import path from 'node:path'
import fs from 'node:fs'

const envPath = path.resolve(import.meta.dirname, '..', '..', '.env.local')
const envText = fs.readFileSync(envPath, 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=("(.*)"|(.*))$/)
  if (!m) continue
  const [, key, , quoted, bare] = m
  const val = quoted !== undefined ? quoted : bare
  if (!(key in process.env)) process.env[key] = val
}
process.env.NODE_ENV = process.env.NODE_ENV || 'development'

const client = await import('../../src/lib/lakala-client.ts')
const SIT_MERCHANT = process.env.LAKALA_DEFAULT_MERCHANT_NO || '822290059430BFA'
const SIT_TERM = process.env.LAKALA_DEFAULT_TERM_NO || 'D9261078'

const results = []
async function step(n, name, fn, blocked = false) {
  if (blocked) {
    console.log(`\n──[Step ${n}] ${name}`)
    console.log(`  ⛔ BLOCKED：${blocked}`)
    results.push({ n, name, status: 'BLOCKED', reason: blocked })
    return null
  }
  console.log(`\n──[Step ${n}] ${name}`)
  try {
    const t0 = Date.now()
    const resp = await fn()
    const elapsed = Date.now() - t0
    const code = resp?.code ?? resp?.retCode
    const msg = resp?.msg ?? resp?.retMsg
    console.log(`  耗时 ${elapsed}ms`)
    console.log(`  code=${code ?? '(空)'}`)
    console.log(`  msg=${msg ?? '(空)'}`)
    const data = resp?.respData ?? resp?.resp_data ?? resp
    const dataKeys = data && typeof data === 'object' ? Object.keys(data).filter(k => !['code','msg','retCode','retMsg'].includes(k)) : []
    if (dataKeys.length) {
      console.log(`  返回字段 (${dataKeys.length}): ${dataKeys.join(', ')}`)
      // 摘录前 3 个字段值
      const sample = dataKeys.slice(0, 5).map(k => `${k}=${JSON.stringify(data[k]).slice(0, 60)}`)
      sample.forEach(s => console.log(`    · ${s}`))
    }
    const ok = code === 'BBS00000' || code === '000000' || code === 'SUCCESS'
    const businessReject = code && !ok
    if (ok) {
      console.log(`  ✅ 成功`)
      results.push({ n, name, status: 'OK', code, msg })
    } else if (businessReject) {
      console.log(`  ⚠️ 业务拒绝（链路通畅）`)
      results.push({ n, name, status: 'BUSINESS_REJECT', code, msg })
    } else {
      console.log(`  ❓ 响应解析异常`)
      results.push({ n, name, status: 'PARSE_FAIL', code, msg })
    }
    return resp
  } catch (e) {
    console.log(`  ❌ 异常: ${e?.message || e}`)
    results.push({ n, name, status: 'ERROR', error: String(e?.message || e) })
    return null
  }
}

console.log('============================================')
console.log('  拉卡拉商户入网 14 步真业务联调（SIT）')
console.log('============================================')
console.log(`  API_BASE = ${process.env.LAKALA_API_BASE}`)
console.log(`  APPID    = ${process.env.LAKALA_APPID}`)
console.log(`  商户     = ${SIT_MERCHANT}`)
console.log(`  终端     = ${SIT_TERM}`)

const ORG_CODE_BLOCK = '需 LAKALA_ORG_CODE（凤御四方机构号，向拉卡拉客户经理申请）'

await step(1, '电子合同申请 (applyContract)', null, ORG_CODE_BLOCK)
await step(2, '附件上传 (uploadAttachment)', null, ORG_CODE_BLOCK)
await step(3, '新增商户进件 (submitMerchant)', null, ORG_CODE_BLOCK)
await step(4, '进件回调通知 (callback route)', null, '被动接收 — 实测需 SIT 端推送回调，admin 路由验签实现已单测覆盖（31/31 单测全绿）')
await step(5, '进件复议提交 (submitAppeal)', null, ORG_CODE_BLOCK + ' + 需 step 3 失败后才能跑')
await step(6, '进件信息查询 (queryMerchant)', null, ORG_CODE_BLOCK)
await step(7, '返回拉卡拉商户号', null, '来自 step 3/4 响应字段 — 链路目标值')

await step(8, '支付宝微信商户开户状态查询 (queryWxConfig)', async () => {
  return await client.queryWxConfig({ merNo: SIT_MERCHANT })
})

await step(9, '微信实名认证结果查询 (queryWxRealname)', async () => {
  return await client.queryWxRealname({ merNo: SIT_MERCHANT })
})

await step(10, '支付宝实名认证信息查询 (queryAlipayRealname)', async () => {
  return await client.queryAlipayRealname({ merNo: SIT_MERCHANT })
})

await step(11, '微信实名修改提交 (submitWxRealname / modifyWxRealname)', null, '写操作 + 改 SIT 默认商户数据 — 不在只读联调范围')
await step(12, '支付宝实名修改提交 (submitAlipayRealname / modifyAlipayRealname)', null, '写操作 + 改 SIT 默认商户数据 — 不在只读联调范围')
await step(13, '商户法人扫码实名认证授权', null, '需法人本人手机扫拉卡拉返回的 qrcodeData URL — 无法自动化')
await step(14, '发起交易请求', null, '由 arch/008 聚合主扫覆盖，非本次入网模块范围')

// ── 子商户号查询额外测一下（属于步骤 7-8 之间的辅助）
await step('7.5', '子商户号查询 (querySubMerchantId) — 已在前置 smoke 验签通过', async () => {
  return await client.querySubMerchantId({ merNo: SIT_MERCHANT, contractId: 'fy_smoke_nonexistent' })
})

console.log('\n============================================')
console.log('               联调汇总报告')
console.log('============================================')
const byStatus = { OK: 0, BUSINESS_REJECT: 0, BLOCKED: 0, ERROR: 0, PARSE_FAIL: 0 }
for (const r of results) byStatus[r.status]++
console.log(`成功:        ${byStatus.OK} 步`)
console.log(`业务拒绝:    ${byStatus.BUSINESS_REJECT} 步 (链路通畅，参数/状态不满足业务规则)`)
console.log(`阻塞:        ${byStatus.BLOCKED} 步 (需外部数据/凭证)`)
console.log(`异常:        ${byStatus.ERROR} 步`)
console.log(`解析失败:    ${byStatus.PARSE_FAIL} 步`)
console.log('\n详细分项：')
results.forEach(r => {
  const mark = r.status === 'OK' ? '✅' : r.status === 'BUSINESS_REJECT' ? '⚠️' : r.status === 'BLOCKED' ? '⛔' : '❌'
  console.log(`  ${mark} Step ${String(r.n).padEnd(4)} ${r.name}`)
  if (r.code) console.log(`        code=${r.code} msg=${r.msg ?? ''}`)
  if (r.reason) console.log(`        ${r.reason}`)
  if (r.error) console.log(`        ${r.error}`)
})

console.log('\n关键阻塞：')
console.log('  LAKALA_ORG_CODE（凤御四方机构号）— 拉卡拉 7 个核心入网接口的必填字段。')
console.log('  本项目尚无此值，需向拉卡拉客户经理申请（凤御作为四方接入方时拉卡拉分配）。')
console.log('  申请后写入 admin/.env.local 即可解锁 Step 1/2/3/5/6 + writeOp Step 11/12。')
