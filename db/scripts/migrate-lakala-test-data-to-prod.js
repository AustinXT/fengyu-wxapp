#!/usr/bin/env node

/**
 * One-time, explicit test -> prod import for the four confirmed Lakala onboarding records.
 * Defaults to dry-run; production writes require --apply.
 */
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')

const ORDER_NOS = [
  'ONB-20260716-5014',
  'ONB-20260724-4669',
  'ONB-20260731-2510',
  'ONB-20260822-3735',
]

function envValue(file, key) {
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((item) => item.startsWith(`${key}=`))
  if (!line) throw new Error(`${file} 缺少 ${key}`)
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

function assertTarget(url, host) {
  const parsed = new URL(url)
  if (parsed.hostname !== host || parsed.port !== '5433' || parsed.pathname !== '/fengyu_wxapp') {
    throw new Error(`数据库目标校验失败：应为 ${host}:5433/fengyu_wxapp`)
  }
}

async function queryRows(client, text, values = []) {
  return (await client.query(text, values)).rows
}

function jsonValue(value) {
  return JSON.stringify(value)
}

async function main() {
  const apply = process.argv.includes('--apply')
  const root = path.resolve(__dirname, '..', '..')
  const testUrl = process.env.TEST_DATABASE_URL || envValue(path.join(root, 'envs/test.env'), 'PG_CONNECTION_STRING')
  const prodUrl = process.env.PROD_DATABASE_URL || envValue(path.join(root, 'envs/prod.env'), 'ADMIN_DATABASE_URL')
  assertTarget(testUrl, '101.34.242.103')
  assertTarget(prodUrl, '118.178.196.26')

  const source = new Client({ connectionString: testUrl })
  const target = new Client({ connectionString: prodUrl })
  await source.connect()
  await target.connect()

  try {
    const applications = await queryRows(source, `
      SELECT id, order_no, store_id, status, merchant_data, legal_person_data,
        contact_data, settlement_data, shop_data, terminal_data, fee_data,
        lakala_request_data, e_contract_order_no, e_contract_apply_id,
        e_contract_result_url, e_contract_no, e_contract_status, e_contract_signed_at,
        contract_id, mer_inner_no, mer_cup_no, channel_data, sub_merchant_checked_at,
        lakala_merchant_id, last_error_code, last_error_message, submitted_at,
        created_by, created_by_name, created_at, updated_at
      FROM lakala_onboarding_applications
      WHERE order_no = ANY($1::text[])
      ORDER BY created_at
    `, [ORDER_NOS])
    if (applications.length !== ORDER_NOS.length) throw new Error(`test 中仅找到 ${applications.length}/${ORDER_NOS.length} 条确认申请`)

    const appIds = applications.map((row) => row.id)
    const merchantIds = [...new Set(applications.map((row) => row.lakala_merchant_id))]
    if (merchantIds.some((id) => !id)) throw new Error('存在未关联拉卡拉商户的申请，停止导入')

    const merchants = await queryRows(source, `
      SELECT id, merchant_name, merchant_no, term_no, enabled, market_org_node_id, created_at, updated_at
      FROM lakala_merchants WHERE id = ANY($1::text[])
    `, [merchantIds])
    if (merchants.length !== merchantIds.length || merchants.some((row) => !row.merchant_no)) {
      throw new Error('源商户资料不完整，停止导入')
    }

    const attachments = await queryRows(source, `
      SELECT id, application_id, att_type, display_name, local_path, file_name, file_ext,
        file_size, mime_type, status, att_file_id, lakala_file_url, lakala_show_url,
        lakala_batch_no, lakala_ocr_status, uploaded_to_lakala_at, expires_at,
        last_error_message, created_at, updated_at
      FROM lakala_onboarding_attachments
      WHERE application_id = ANY($1::text[])
      ORDER BY created_at
    `, [appIds])
    const portableAttachments = attachments.filter((row) => row.status === 'UPLOADED' && row.lakala_file_url)
    const skippedAttachments = attachments.filter((row) => !portableAttachments.includes(row))

    const logs = await queryRows(source, `
      SELECT id, application_id, api_name, request_id, request_payload_masked,
        response_payload, success, error_code, error_message, created_at
      FROM lakala_onboarding_request_logs
      WHERE application_id = ANY($1::text[])
      ORDER BY created_at
    `, [appIds])

    const [{ has_order_no }] = await queryRows(target, `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'lakala_onboarding_applications' AND column_name = 'order_no'
      ) AS has_order_no
    `)
    if (!has_order_no) throw new Error('prod 尚未完成 0033 结构修复，停止数据导入')

    const existingApplications = await queryRows(target,
      'SELECT id, order_no FROM lakala_onboarding_applications WHERE id = ANY($1::text[]) OR order_no = ANY($2::text[])',
      [appIds, ORDER_NOS],
    )
    if (existingApplications.length) throw new Error('prod 已存在本次导入的申请，停止以避免重复导入')

    const storeIds = [...new Set(applications.map((row) => row.store_id))]
    const targetStores = await queryRows(target,
      'SELECT store_id, lakala_merchant_id FROM stores WHERE store_id = ANY($1::text[])',
      [storeIds],
    )
    if (targetStores.length !== storeIds.length) throw new Error('prod 缺少对应门店，停止导入')

    const merchantNos = merchants.map((row) => row.merchant_no)
    const targetMerchants = await queryRows(target,
      'SELECT id, merchant_no FROM lakala_merchants WHERE merchant_no = ANY($1::text[])',
      [merchantNos],
    )
    const targetByMerchantNo = new Map(targetMerchants.map((row) => [row.merchant_no, row]))
    const targetMerchantIdBySourceId = new Map()
    const missingMerchants = []
    for (const sourceMerchant of merchants) {
      const existing = targetByMerchantNo.get(sourceMerchant.merchant_no)
      if (existing) targetMerchantIdBySourceId.set(sourceMerchant.id, existing.id)
      else {
        targetMerchantIdBySourceId.set(sourceMerchant.id, sourceMerchant.id)
        missingMerchants.push(sourceMerchant)
      }
    }

    const targetStoreById = new Map(targetStores.map((row) => [row.store_id, row]))
    for (const app of applications) {
      const expectedMerchantId = targetMerchantIdBySourceId.get(app.lakala_merchant_id)
      const targetStore = targetStoreById.get(app.store_id)
      if (targetStore.lakala_merchant_id && targetStore.lakala_merchant_id !== expectedMerchantId) {
        throw new Error(`prod 门店 ${app.store_id} 已关联另一商户，停止导入`)
      }
    }

    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      applications: applications.length,
      merchantsToCreate: missingMerchants.length,
      attachments: portableAttachments.length,
      skippedAttachments: skippedAttachments.map((row) => ({ id: row.id, fileName: row.file_name, reason: '源文件未上传拉卡拉且已在 101 缺失' })),
      requestLogs: logs.length,
    }, null, 2))
    if (!apply) return

    await target.query('BEGIN')
    try {
      for (const merchant of missingMerchants) {
        await target.query(`
          INSERT INTO lakala_merchants (id, merchant_name, merchant_no, term_no, enabled, market_org_node_id, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [merchant.id, merchant.merchant_name, merchant.merchant_no, merchant.term_no, merchant.enabled, merchant.market_org_node_id, merchant.created_at, merchant.updated_at])
      }
      for (const app of applications) {
        const merchantId = targetMerchantIdBySourceId.get(app.lakala_merchant_id)
        await target.query('UPDATE stores SET lakala_merchant_id=$1 WHERE store_id=$2', [merchantId, app.store_id])
        await target.query(`
          INSERT INTO lakala_onboarding_applications (
            id, order_no, store_id, status, merchant_data, legal_person_data, contact_data, settlement_data, shop_data, terminal_data,
            fee_data, lakala_request_data, e_contract_order_no, e_contract_apply_id, e_contract_result_url, e_contract_no,
            e_contract_status, e_contract_signed_at, contract_id, mer_inner_no, mer_cup_no, channel_data, sub_merchant_checked_at,
            lakala_merchant_id, last_error_code, last_error_message, submitted_at, created_by, created_by_name, created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
          )
        `, [app.id, app.order_no, app.store_id, app.status, jsonValue(app.merchant_data), jsonValue(app.legal_person_data), jsonValue(app.contact_data), jsonValue(app.settlement_data), jsonValue(app.shop_data), jsonValue(app.terminal_data), jsonValue(app.fee_data), jsonValue(app.lakala_request_data), app.e_contract_order_no, app.e_contract_apply_id, app.e_contract_result_url, app.e_contract_no, app.e_contract_status, app.e_contract_signed_at, app.contract_id, app.mer_inner_no, app.mer_cup_no, jsonValue(app.channel_data), app.sub_merchant_checked_at, merchantId, app.last_error_code, app.last_error_message, app.submitted_at, app.created_by, app.created_by_name, app.created_at, app.updated_at])
      }
      for (const attachment of portableAttachments) {
        await target.query(`
          INSERT INTO lakala_onboarding_attachments (
            id, application_id, att_type, display_name, local_path, file_name, file_ext, file_size, mime_type, status,
            att_file_id, lakala_file_url, lakala_show_url, lakala_batch_no, lakala_ocr_status, uploaded_to_lakala_at,
            expires_at, last_error_message, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `, [attachment.id, attachment.application_id, attachment.att_type, attachment.display_name, attachment.local_path, attachment.file_name, attachment.file_ext, attachment.file_size, attachment.mime_type, attachment.status, attachment.att_file_id, attachment.lakala_file_url, attachment.lakala_show_url, attachment.lakala_batch_no, attachment.lakala_ocr_status, attachment.uploaded_to_lakala_at, attachment.expires_at, attachment.last_error_message, attachment.created_at, attachment.updated_at])
      }
      for (const log of logs) {
        await target.query(`
          INSERT INTO lakala_onboarding_request_logs (
            id, application_id, api_name, request_id, request_payload_masked, response_payload, success, error_code, error_message, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [log.id, log.application_id, log.api_name, log.request_id, jsonValue(log.request_payload_masked), jsonValue(log.response_payload), log.success, log.error_code, log.error_message, log.created_at])
      }
      await target.query('COMMIT')
    } catch (error) {
      await target.query('ROLLBACK')
      throw error
    }
  } finally {
    await source.end()
    await target.end()
  }
}

main().catch((error) => {
  console.error(`迁移失败：${error.message}`)
  process.exit(1)
})
