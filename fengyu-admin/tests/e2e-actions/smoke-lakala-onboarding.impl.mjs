/**
 * Phase 2D · admin 拉卡拉商户入网端到端冒烟（真 PG + mock 拉卡拉客户端）
 *
 * 由 smoke-lakala-onboarding.mjs spawn 起 bun 子进程（cwd=fengyu-admin/）。
 * 前置 preload：
 *   _admin-preload.mjs       — mock @/lib/auth / permissions / operation-log / next/cache
 *   _lakala-preload.mjs      — mock @/lib/lakala-client（16 方法）+ lakala-rate + cloudbase
 *
 * 完整路径（plan §3 + §11 验证）：
 *   1. createDraft → assert lakala_merchants 行 + outOrgCode lm-* 前缀
 *   2. saveDraft → assert merchantName 更新 + formData jsonb 写入
 *   3. applyContract → assert client.applyContract 被调 + status='contract_signing'
 *   4. refreshContractStatus → assert status='contract_signed'（mock 直接返回 COMPLETED）
 *   5. uploadAttachment ×3 → assert 3 行 attachments，attchId 已回填
 *   6. submitMerchant → assert client.submitMerchant 被调（含 feeData）+ 返回 contractId
 *      额外断言：返回值 jsonb 不含 feeRate / rateCode
 *   7. POST /api/lakala/callback/incoming 模拟（直接更新 PG）→ assert merchant_no / term_no 写入
 *   8. submitWxRealname → mock realname success → assert wx_sub_mchid 回填
 *   9. linkStoreToMerchant → assert stores 2 列快照同步（merchantNo/subAppid）+ term_no/enabled 不动
 *   10. unlinkStoreFromMerchant → assert stores 快照清空 + lakala_enabled=false
 *
 * 清理：所有命名空间前缀 'TE2A_LK_' 数据 + 命名空间 stores 复位 + 已绑 lakala_merchant_id 全清。
 */
import path from 'node:path'

const __filename = new URL(import.meta.url).pathname
const TESTS_DIR = path.dirname(__filename)
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')

// PG 连接（与其它 smoke 一致）
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu'
process.env.DATABASE_URL = process.env.PG_CONNECTION_STRING
process.env.LAKALA_ORG_CODE = process.env.LAKALA_ORG_CODE || '1'
process.env.LAKALA_INCOMING_NOTIFY_URL = process.env.LAKALA_INCOMING_NOTIFY_URL ||
  'https://test.example.com/api/lakala/callback/incoming'

const setupUrl = 'file://' + path.join(TESTS_DIR, 'setup.mjs')
const fixturesUrl = 'file://' + path.join(TESTS_DIR, 'helpers', 'fixtures.mjs')

const setup = await import(setupUrl)
const fixtures = await import(fixturesUrl)
const { pgQuery, closePool, NS, TEST_STORE_ID } = setup
const { ensureTestStore } = fixtures

// 本 smoke 独占命名空间（与其它 smoke 隔离）
const LK_NS = `${NS}_LK`

let exitCode = 1

async function cleanupLakala() {
  // 解绑测试门店（防 stores.lakala_merchant_id FK 阻塞 lakala_merchants 删除）
  await pgQuery(
    `UPDATE stores SET lakala_merchant_id = NULL,
        lakala_merchant_no = NULL, lakala_sub_appid = NULL, lakala_enabled = false
       WHERE store_id LIKE $1 OR lakala_merchant_id IN (
         SELECT id FROM lakala_merchants WHERE id LIKE $2
       )`,
    [`${NS}%`, `${LK_NS}%`],
  )
  await pgQuery(`DELETE FROM lakala_merchant_logs WHERE lakala_merchant_id LIKE $1`, [`${LK_NS}%`])
  await pgQuery(`DELETE FROM lakala_merchant_attachments WHERE lakala_merchant_id LIKE $1`, [`${LK_NS}%`])
  await pgQuery(`DELETE FROM lakala_merchants WHERE id LIKE $1`, [`${LK_NS}%`])
}

/** 失败时打印实际数据辅助定位。 */
async function dumpMerchant(id) {
  const rows = await pgQuery(`SELECT * FROM lakala_merchants WHERE id = $1`, [id])
  console.log('  [dump] merchant:', JSON.stringify(rows[0], null, 2))
}

async function main() {
  console.log(`[smoke-lakala-onboarding] start | ${new Date().toISOString()}`)
  await cleanupLakala()
  await ensureTestStore()
  console.log(`  ✓ fixtures ready | store=${TEST_STORE_ID}`)

  // 动态 import admin actions（preload 已 mock 拉卡拉 client + rate + cloudbase）
  const actionsMod = await import(path.join(ADMIN_DIR, 'src', 'actions', 'lakala-onboarding.ts'))

  // ---- STEP 1. createDraft ----------------------------------------------
  const created = await actionsMod.createDraft({
    merchantName: `${LK_NS}_TEST_MERCHANT`,
    formData: { stage: 'init' },
  })
  if (!created.success || !created.id) throw new Error('STEP1 createDraft 失败')
  // 关键：用真实生成 id 替换 LK_NS 前缀（避免 cleanup 漏）
  // ksuid 不带 LK_NS 前缀；我们用 INSERT 后改 id 的方式让 cleanup 能匹配
  const realId = created.id
  const newId = `${LK_NS}_${realId}` // cleanup 用 LK_NS% 命中
  await pgQuery(`UPDATE lakala_merchants SET id = $1 WHERE id = $2`, [newId, realId])
  console.log(`  ✓ STEP1 createDraft id=${newId}`)

  const rows1 = await pgQuery(`SELECT * FROM lakala_merchants WHERE id = $1`, [newId])
  if (rows1.length !== 1) throw new Error('STEP1 行不存在')
  if (!rows1[0].out_org_code.startsWith('lm-')) throw new Error(`STEP1 outOrgCode 前缀错: ${rows1[0].out_org_code}`)
  if (rows1[0].onboarding_status !== 'draft') throw new Error(`STEP1 状态错: ${rows1[0].onboarding_status}`)

  // ---- STEP 2. saveDraft ------------------------------------------------
  const sd = await actionsMod.saveDraft(newId, {
    merchantName: `${LK_NS}_TEST_MERCHANT_UPDATED`,
    formData: { stage: 'editing', basic: { name: 'X' } },
  })
  if (!sd.success) throw new Error(`STEP2 saveDraft 失败: ${sd.message}`)
  const rows2 = await pgQuery(`SELECT merchant_name, form_data FROM lakala_merchants WHERE id = $1`, [newId])
  if (!rows2[0].merchant_name.endsWith('UPDATED')) throw new Error('STEP2 merchantName 未更新')
  console.log(`  ✓ STEP2 saveDraft`)

  // ---- STEP 3. applyContract → status='contract_signing' ------------------
  const ac = await actionsMod.applyContract(newId, {
    orderNo: `O-${Date.now()}`,
    orgId: 1,
    ecTypeCode: 'EC015',
    certType: 'RESIDENT_ID',
    certName: '张三',
    certNo: '110101199001011234',
    mobile: '13812341234',
    openningBankCode: '0001',
    openningBankName: 'ICBC',
    acctTypeCode: '57',
    acctNo: '6225123412341234',
    acctName: '张三',
    ecContentParameters: '{}',
  })
  if (!ac.success) throw new Error(`STEP3 applyContract 失败: ${ac.message}`)
  const rows3 = await pgQuery(`SELECT onboarding_status FROM lakala_merchants WHERE id = $1`, [newId])
  if (rows3[0].onboarding_status !== 'contract_signing') {
    await dumpMerchant(newId)
    throw new Error(`STEP3 状态期望 contract_signing 实际 ${rows3[0].onboarding_status}`)
  }
  if (!globalThis.__lakalaMocks.calls.find((c) => c.method === 'applyContract')) {
    throw new Error('STEP3 client.applyContract 未被调')
  }
  console.log(`  ✓ STEP3 applyContract → contract_signing`)

  // ---- STEP 4. refreshContractStatus → 'contract_signed' ----------------
  const rcs = await actionsMod.refreshContractStatus(newId)
  if (!rcs.success) throw new Error(`STEP4 refreshContractStatus 失败: ${rcs.message}`)
  const rows4 = await pgQuery(`SELECT onboarding_status, contract_no FROM lakala_merchants WHERE id = $1`, [newId])
  if (rows4[0].onboarding_status !== 'contract_signed') {
    await dumpMerchant(newId)
    throw new Error(`STEP4 状态期望 contract_signed 实际 ${rows4[0].onboarding_status}`)
  }
  if (rows4[0].contract_no !== 'MOCK_EC_NO') throw new Error(`STEP4 contract_no 错: ${rows4[0].contract_no}`)
  console.log(`  ✓ STEP4 refreshContractStatus → contract_signed + contractNo=MOCK_EC_NO`)

  // ---- STEP 5. uploadAttachment ×3 → status='attachments_uploading' -------
  for (const t of ['biz_license', 'id_card_front', 'id_card_back']) {
    const ua = await actionsMod.uploadAttachment(newId, {
      attachmentType: t,
      sourceUrl: 'https://mock.cdn/source.jpg',
      attExtName: 'jpg',
      attContext: 'AAAA', // base64 占位，不影响 mock
      metadata: { type: t },
    })
    if (!ua.success) throw new Error(`STEP5 上传 ${t} 失败`)
    if (!ua.attchId || !ua.attchId.startsWith('MOCK_ATT_')) throw new Error(`STEP5 attchId 未回填: ${ua.attchId}`)
  }
  const rows5 = await pgQuery(
    `SELECT COUNT(*)::int as cnt FROM lakala_merchant_attachments WHERE lakala_merchant_id = $1 AND attch_id IS NOT NULL`,
    [newId],
  )
  if (rows5[0].cnt !== 3) throw new Error(`STEP5 期望 3 个有 attchId 的附件，实际 ${rows5[0].cnt}`)
  const rows5b = await pgQuery(`SELECT onboarding_status FROM lakala_merchants WHERE id = $1`, [newId])
  if (rows5b[0].onboarding_status !== 'attachments_uploading') {
    throw new Error(`STEP5 状态期望 attachments_uploading 实际 ${rows5b[0].onboarding_status}`)
  }
  console.log(`  ✓ STEP5 uploadAttachment ×3 → attachments_uploading`)

  // ---- STEP 6. submitMerchant → status='submitted'（+ feeData 不泄漏） ----
  const beforeSubmitCalls = globalThis.__lakalaMocks.calls.length
  const sm = await actionsMod.submitMerchant(newId, {
    posType: 'WECHAT_PAY',
    merRegName: '凤御测试店',
    merRegDistCode: '360100',
    merRegAddr: '南昌市',
    mccCode: '7298',
    merBusiContent: '640',
    larName: '张三',
    larIdType: 'RESIDENT_ID',
    larIdcard: '110101199001011234',
    larIdcardStDt: '20200101',
    larIdcardExpDt: '20300101',
    merContactMobile: '13812341234',
    merContactName: '张三',
    openningBankCode: '0001',
    openningBankName: 'ICBC',
    clearingBankCode: '0001',
    acctNo: '6225123412341234',
    acctName: '张三',
    acctTypeCode: '57',
    settlePeriod: 'T1',
  })
  if (!sm.success) {
    await dumpMerchant(newId)
    throw new Error(`STEP6 submitMerchant 失败: ${sm.message}`)
  }
  if (sm.contractId !== 'MOCK_CONTRACT_ID') {
    throw new Error(`STEP6 contractId 错: ${sm.contractId}`)
  }
  // 返回值守护：序列化后不含 feeRate / rateCode 字面量
  const smJson = JSON.stringify(sm)
  if (/feeRate|rateCode|0\.6/.test(smJson)) {
    throw new Error(`STEP6 ★ 返回值漏出费率信息: ${smJson}`)
  }
  // 关键：client.submitMerchant 被调时 feeData 已注入（mock 端记录的 args 含 feeData）
  const submitCall = globalThis.__lakalaMocks.calls
    .slice(beforeSubmitCalls)
    .find((c) => c.method === 'submitMerchant')
  if (!submitCall || !submitCall.args.feeData) {
    throw new Error('STEP6 ★ feeData 未注入到 client 调用')
  }
  const rows6 = await pgQuery(`SELECT onboarding_status, last_req_ids FROM lakala_merchants WHERE id = $1`, [newId])
  if (rows6[0].onboarding_status !== 'submitted') {
    throw new Error(`STEP6 状态期望 submitted 实际 ${rows6[0].onboarding_status}`)
  }
  if (rows6[0].last_req_ids.addMerContractId !== 'MOCK_CONTRACT_ID') {
    throw new Error(`STEP6 last_req_ids.addMerContractId 未写: ${JSON.stringify(rows6[0].last_req_ids)}`)
  }
  console.log(`  ✓ STEP6 submitMerchant → submitted | feeData 注入但不出现在返回值 | contractId=MOCK_CONTRACT_ID`)

  // ---- STEP 7. 模拟回调（直接 UPDATE PG 推进到 approved + 回填 merchantNo/termNo） ----
  // 完整 HTTP 回调路由由 Phase 1C agent 已实现，本 smoke 直接调 SQL 模拟回调结果
  await pgQuery(
    `UPDATE lakala_merchants
       SET onboarding_status = 'approved',
           merchant_no = 'MOCK_MER_001',
           term_no = 'MOCK_TERM_001',
           last_callback_at = NOW()
       WHERE id = $1`,
    [newId],
  )
  const rows7 = await pgQuery(`SELECT merchant_no, term_no, onboarding_status FROM lakala_merchants WHERE id = $1`, [newId])
  if (rows7[0].onboarding_status !== 'approved') throw new Error('STEP7 模拟回调后状态错')
  if (rows7[0].merchant_no !== 'MOCK_MER_001') throw new Error('STEP7 merchant_no 未写')
  if (rows7[0].term_no !== 'MOCK_TERM_001') throw new Error('STEP7 term_no 未写')
  console.log(`  ✓ STEP7 模拟回调 → approved + merchantNo=MOCK_MER_001 + termNo=MOCK_TERM_001`)

  // ---- STEP 8. submitWxRealname → wx_sub_mchid 回填 ----------------------
  const wx = await actionsMod.submitWxRealname(newId, {
    receOrgNo: 'REC-001',
    subMchId: 'WX_SUB_999',
    channelId: 'wxchannel-app',
  })
  if (!wx.success) throw new Error(`STEP8 submitWxRealname 失败: ${wx.message}`)
  const rows8 = await pgQuery(
    `SELECT wx_sub_mchid, wx_sub_appid, wx_realname_status, onboarding_status
       FROM lakala_merchants WHERE id = $1`,
    [newId],
  )
  if (rows8[0].wx_sub_mchid !== 'WX_SUB_999') throw new Error(`STEP8 wx_sub_mchid 未回填: ${rows8[0].wx_sub_mchid}`)
  if (rows8[0].wx_sub_appid !== 'wxchannel-app') throw new Error(`STEP8 wx_sub_appid 未回填`)
  if (rows8[0].wx_realname_status !== 'submitted') throw new Error(`STEP8 wx_realname_status 期望 submitted`)
  if (rows8[0].onboarding_status !== 'realname_pending') {
    throw new Error(`STEP8 状态期望 realname_pending 实际 ${rows8[0].onboarding_status}`)
  }
  console.log(`  ✓ STEP8 submitWxRealname → realname_pending + wx_sub_mchid=WX_SUB_999`)

  // ---- STEP 9. linkStoreToMerchant → 复位商户到 completed 后绑定 -----------
  // 先把状态推到 completed 以满足 link 条件
  await pgQuery(`UPDATE lakala_merchants SET onboarding_status='completed' WHERE id=$1`, [newId])
  const beforeStore = await pgQuery(
    `SELECT lakala_merchant_id, lakala_merchant_no, lakala_sub_appid, lakala_term_no, lakala_enabled
       FROM stores WHERE store_id = $1`,
    [TEST_STORE_ID],
  )
  // 设个明确的 term_no 验证 link 不动它
  await pgQuery(`UPDATE stores SET lakala_term_no = 'STORE_TERM_KEEP' WHERE store_id = $1`, [TEST_STORE_ID])

  const link = await actionsMod.linkStoreToMerchant({ storeId: TEST_STORE_ID, lakalaMerchantId: newId })
  if (!link.success) throw new Error(`STEP9 link 失败: ${link.message}`)
  const afterLink = await pgQuery(
    `SELECT lakala_merchant_id, lakala_merchant_no, lakala_sub_appid, lakala_term_no, lakala_enabled
       FROM stores WHERE store_id = $1`,
    [TEST_STORE_ID],
  )
  if (afterLink[0].lakala_merchant_id !== newId) throw new Error('STEP9 lakala_merchant_id 未刷')
  if (afterLink[0].lakala_merchant_no !== 'MOCK_MER_001') {
    throw new Error(`STEP9 快照 merchantNo 错: ${afterLink[0].lakala_merchant_no}`)
  }
  if (afterLink[0].lakala_sub_appid !== 'wxchannel-app') {
    throw new Error(`STEP9 快照 subAppid 错: ${afterLink[0].lakala_sub_appid}`)
  }
  // 关键守护：term_no / enabled 不动
  if (afterLink[0].lakala_term_no !== 'STORE_TERM_KEEP') {
    throw new Error(`STEP9 ★ term_no 被改动: ${afterLink[0].lakala_term_no}`)
  }
  if (afterLink[0].lakala_enabled !== beforeStore[0].lakala_enabled) {
    throw new Error(`STEP9 ★ lakala_enabled 被改动`)
  }
  console.log(`  ✓ STEP9 linkStoreToMerchant → 快照刷 merchantNo/subAppid，term_no/enabled 保留`)

  // ---- STEP 10. unlinkStoreFromMerchant → 清快照 + enabled=false ----------
  await pgQuery(`UPDATE stores SET lakala_enabled = true WHERE store_id = $1`, [TEST_STORE_ID])
  const ul = await actionsMod.unlinkStoreFromMerchant({ storeId: TEST_STORE_ID })
  if (!ul.success) throw new Error(`STEP10 unlink 失败: ${ul.message}`)
  const afterUnlink = await pgQuery(
    `SELECT lakala_merchant_id, lakala_merchant_no, lakala_sub_appid, lakala_term_no, lakala_enabled
       FROM stores WHERE store_id = $1`,
    [TEST_STORE_ID],
  )
  if (afterUnlink[0].lakala_merchant_id !== null) throw new Error('STEP10 lakala_merchant_id 未清')
  if (afterUnlink[0].lakala_merchant_no !== null) throw new Error('STEP10 lakala_merchant_no 未清')
  if (afterUnlink[0].lakala_sub_appid !== null) throw new Error('STEP10 lakala_sub_appid 未清')
  if (afterUnlink[0].lakala_enabled !== false) throw new Error('STEP10 ★ enabled 未被强置 false')
  // term_no 在 unlink 时不动（仅清空快照 + enabled=false；plan §3 注释）
  if (afterUnlink[0].lakala_term_no !== 'STORE_TERM_KEEP') {
    throw new Error(`STEP10 term_no 被改动: ${afterUnlink[0].lakala_term_no}`)
  }
  console.log(`  ✓ STEP10 unlinkStoreFromMerchant → 快照清空 + enabled=false`)

  exitCode = 0
  console.log(`\n[smoke-lakala-onboarding] ✅ ALL 10 STEPS PASSED`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-lakala-onboarding] EXCEPTION:', e.message)
  if (e.stack) console.error(e.stack)
} finally {
  try { await cleanupLakala() } catch (e) { console.warn('cleanup err:', e.message) }
  // 复位测试门店的 term_no，避免影响其它 smoke
  try {
    await pgQuery(`UPDATE stores SET lakala_term_no = NULL WHERE store_id = $1`, [TEST_STORE_ID])
  } catch {}
  await closePool()
  console.log(`[smoke-lakala-onboarding] end | exit=${exitCode}`)
  process.exit(exitCode)
}
