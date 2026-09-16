#!/usr/bin/env node

/**
 * Explicit, rerunnable test -> prod import for the four confirmed Lakala onboarding records.
 * Defaults to dry-run; production writes require --apply. The dry-run also verifies every
 * imported attachment on the test host. --apply copies those private files to the production
 * bind mount before committing their rewritten container paths to PostgreSQL.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Client } = require('pg')

const ORDER_NOS = [
  'ONB-20260716-5014',
  'ONB-20260724-4669',
  'ONB-20260731-2510',
  'ONB-20260822-3735',
]

const CONTAINER_PRIVATE_UPLOAD_ROOT = '/var/lib/fengyu/private-uploads'
const SOURCE_CONTAINER_PRIVATE_UPLOAD_ROOTS = [
  CONTAINER_PRIVATE_UPLOAD_ROOT,
  '/var/lib/fengyu-admin/private-uploads',
]
const DEFAULT_TEST_SSH_HOST = 'lx-test'   // ~/.ssh/config 别名（原 sqlserver101，2026-09-04 改名）
const DEFAULT_PROD_SSH_HOST = 'lx-prod'   // ~/.ssh/config 别名（原 fengyu-prod，2026-09-04 改名）
const DEFAULT_PRIVATE_UPLOAD_HOST_DIR = '/www/wwwroot/fengyu-admin/docker/data/private-uploads'
const DEFAULT_LEGACY_TEST_PRIVATE_UPLOAD_HOST_DIR = '/www/wwwroot/fengyu-admin/docker/private-uploads'
const MAX_SSH_BUFFER = 8 * 1024 * 1024
const SSH_CONTROL_PATH = `/tmp/fengyu-lakala-ssh-${process.pid}-%C`
const SSH_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPersist=60',
  '-o', `ControlPath=${SSH_CONTROL_PATH}`,
]

function envValue(file, key) {
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((item) => item.startsWith(`${key}=`))
  if (!line) throw new Error(`${file} 缺少 ${key}`)
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

// 复用权威实现：只比 authority 会被 `?host=` / `?%68ost=` 这类 query 覆盖绕过（见 _lib/assert-db-target.js）
const { isAllowedDbTarget } = require('./_lib/assert-db-target')

function assertTarget(url, host) {
  if (!isAllowedDbTarget(url)) {
    throw new Error(`数据库目标校验失败：连接串不在白名单内，或 query 试图覆盖连接目标`)
  }
  const parsed = new URL(url)
  if (parsed.hostname !== host) {
    throw new Error(`数据库目标校验失败：应为 ${host}:5433/fengyu_wxapp，实际 ${parsed.hostname}`)
  }
}

async function queryRows(client, text, values = []) {
  return (await client.query(text, values)).rows
}

function jsonValue(value) {
  return JSON.stringify(value)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function assertSshHost(host, label) {
  if (!/^[A-Za-z0-9_.@-]+$/.test(host)) throw new Error(`${label} 不是安全的 SSH host：${host}`)
}

function normalizeHostUploadRoot(value, label) {
  const normalized = path.posix.resolve(value)
  if (normalized === '/') throw new Error(`${label} 不得为根目录`)
  return normalized
}

function runSsh(host, command, { input, encoding = 'utf8', allowFailure = false } = {}) {
  const result = spawnSync('ssh', [...SSH_OPTIONS, host, command], {
    input,
    encoding,
    maxBuffer: MAX_SSH_BUFFER,
  })
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`
    throw new Error(`SSH ${host} 执行失败：${detail}`)
  }
  return result
}

function closeSshControl(host) {
  spawnSync('ssh', [...SSH_OPTIONS, '-O', 'exit', host], { stdio: 'ignore' })
}

function runSshWithSudoFallback(host, command, options = {}) {
  const direct = runSsh(host, command, { ...options, allowFailure: true })
  if (!direct.error && direct.status === 0) return direct
  return runSsh(host, `sudo -n sh -ceu ${shellQuote(command)}`, options)
}

function buildAttachmentPlan(attachment, testUploadRoot, legacyTestUploadRoot, prodUploadRoot) {
  const sourceLocalPath = path.posix.resolve(attachment.local_path)
  const sourceMappings = SOURCE_CONTAINER_PRIVATE_UPLOAD_ROOTS.map((containerRoot) => ({
    containerRoot,
    hostRoot: containerRoot === CONTAINER_PRIVATE_UPLOAD_ROOT ? testUploadRoot : legacyTestUploadRoot,
  }))
  const sourceMapping = sourceMappings.find(({ containerRoot }) => {
    const expectedApplicationDir = path.posix.join(containerRoot, 'lakala-onboarding', attachment.application_id)
    return sourceLocalPath.startsWith(`${expectedApplicationDir}/`)
  })
  if (!sourceMapping) {
    throw new Error(`附件 ${attachment.id} 的 local_path 不在申请私有目录内：${attachment.local_path}`)
  }
  const relativePath = path.posix.relative(sourceMapping.containerRoot, sourceLocalPath)
  if (!relativePath || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)) {
    throw new Error(`附件 ${attachment.id} 的相对路径无效`)
  }
  return {
    attachment,
    sourceHostPath: path.posix.join(sourceMapping.hostRoot, relativePath),
    targetHostPath: path.posix.join(prodUploadRoot, relativePath),
    targetLocalPath: path.posix.join(CONTAINER_PRIVATE_UPLOAD_ROOT, relativePath),
  }
}

function validateSourceAttachments(plans, testSshHost) {
  if (!plans.length) return
  const command = plans
    .map((plan) => [
      `if test ! -f ${shellQuote(plan.sourceHostPath)}; then printf '%s\n' ${shellQuote(`附件 ${plan.attachment.id} 的源文件不存在：${plan.sourceHostPath}`)} >&2; exit 1; fi`,
      `stat -c %s -- ${shellQuote(plan.sourceHostPath)}`,
    ].join('; '))
    .join('; ')
  const result = runSshWithSudoFallback(testSshHost, `set -eu; ${command}`)
  const actualSizes = String(result.stdout).trim().split(/\r?\n/).map(Number)
  if (actualSizes.length !== plans.length) throw new Error('测试机附件批量校验结果数量不一致')
  for (const [index, plan] of plans.entries()) {
    const actualSize = actualSizes[index]
    const expectedSize = Number(plan.attachment.file_size)
    if (!Number.isSafeInteger(actualSize) || actualSize < 0 || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || actualSize !== expectedSize) {
      throw new Error(`附件 ${plan.attachment.id} 大小不一致：数据库=${plan.attachment.file_size}，文件=${actualSize}`)
    }
  }
}

function readRemoteAttachment(host, remotePath) {
  const command = `test -f ${shellQuote(remotePath)}; cat -- ${shellQuote(remotePath)}`
  return runSshWithSudoFallback(host, command, { encoding: null }).stdout
}

function copyAttachmentsToProd(plans, testSshHost, prodSshHost, copiedTargetPaths) {
  const stageRoot = `/tmp/fengyu-lakala-import-${process.pid}-${Date.now()}`
  try {
    for (const plan of plans) {
      const result = runSshWithSudoFallback(prodSshHost, [
        'set -eu',
        `if test -f ${shellQuote(plan.targetHostPath)}; then stat -c %s -- ${shellQuote(plan.targetHostPath)}; elif test -e ${shellQuote(plan.targetHostPath)}; then exit 2; else echo MISSING; fi`,
      ].join('; '))
      const output = String(result.stdout).trim()
      if (output === 'MISSING') {
        plan.targetAlreadyExists = false
        continue
      }
      const actualSize = Number(output)
      const expectedSize = Number(plan.attachment.file_size)
      if (!Number.isSafeInteger(actualSize) || actualSize !== expectedSize) {
        throw new Error(`生产附件 ${plan.attachment.id} 已存在但大小不一致：数据库=${plan.attachment.file_size}，文件=${output}`)
      }
      plan.targetAlreadyExists = true
    }

    for (const [index, plan] of plans.entries()) {
      if (plan.targetAlreadyExists) continue
      const content = readRemoteAttachment(testSshHost, plan.sourceHostPath)
      if (content.length !== Number(plan.attachment.file_size)) {
        throw new Error(`附件 ${plan.attachment.id} 在复制过程中大小发生变化`)
      }
      const stagePath = path.posix.join(stageRoot, `${index}-${path.posix.basename(plan.targetHostPath)}`)
      runSsh(prodSshHost, `umask 077; mkdir -p ${shellQuote(stageRoot)}; cat > ${shellQuote(stagePath)}`, {
        input: content,
        encoding: null,
      })
      plan.stagePath = stagePath
    }

    for (const plan of plans) {
      if (plan.targetAlreadyExists) continue
      const targetDir = path.posix.dirname(plan.targetHostPath)
      const promote = [
        'set -eu',
        `if test -e ${shellQuote(plan.targetHostPath)}; then test ! -e ${shellQuote(plan.stagePath)}; else mkdir -p ${shellQuote(targetDir)}; mv ${shellQuote(plan.stagePath)} ${shellQuote(plan.targetHostPath)}; fi`,
      ].join('; ')
      runSshWithSudoFallback(prodSshHost, promote)
      copiedTargetPaths.push(plan.targetHostPath)
      runSshWithSudoFallback(prodSshHost, [
        'set -eu',
        `chown 1001:1001 ${shellQuote(plan.targetHostPath)}`,
        `chmod 600 ${shellQuote(plan.targetHostPath)}`,
      ].join('; '))
    }
  } finally {
    runSshWithSudoFallback(prodSshHost, `rm -rf -- ${shellQuote(stageRoot)}`, { allowFailure: true })
  }
}

function cleanupCopiedAttachments(prodSshHost, copiedTargetPaths) {
  if (!copiedTargetPaths.length) return
  const files = copiedTargetPaths.map(shellQuote).join(' ')
  const directories = [...new Set(copiedTargetPaths.map((item) => path.posix.dirname(item)))]
    .map(shellQuote)
    .join(' ')
  runSshWithSudoFallback(prodSshHost, `set -eu; rm -f -- ${files}; rmdir -- ${directories} 2>/dev/null || true`, { allowFailure: true })
}

async function main() {
  const apply = process.argv.includes('--apply')
  const root = path.resolve(__dirname, '..', '..')
  // 来源是 dev 环境的库（原 envs/test.env 随独立 test 环境于 2026-09-01 退役；两者本就同一个库）。
  const testUrl = process.env.TEST_DATABASE_URL || envValue(path.join(root, 'envs/dev.env'), 'PG_CONNECTION_STRING')
  const prodUrl = process.env.PROD_DATABASE_URL || envValue(path.join(root, 'envs/prod.env'), 'ADMIN_DATABASE_URL')
  assertTarget(testUrl, '101.34.242.103')
  assertTarget(prodUrl, '118.178.196.26')
  const testSshHost = process.env.TEST_SSH_HOST || DEFAULT_TEST_SSH_HOST
  const prodSshHost = process.env.PROD_SSH_HOST || DEFAULT_PROD_SSH_HOST
  assertSshHost(testSshHost, 'TEST_SSH_HOST')
  assertSshHost(prodSshHost, 'PROD_SSH_HOST')
  const testUploadRoot = normalizeHostUploadRoot(
    process.env.TEST_PRIVATE_UPLOAD_HOST_DIR || DEFAULT_PRIVATE_UPLOAD_HOST_DIR,
    'TEST_PRIVATE_UPLOAD_HOST_DIR',
  )
  const legacyTestUploadRoot = normalizeHostUploadRoot(
    process.env.TEST_LEGACY_PRIVATE_UPLOAD_HOST_DIR || DEFAULT_LEGACY_TEST_PRIVATE_UPLOAD_HOST_DIR,
    'TEST_LEGACY_PRIVATE_UPLOAD_HOST_DIR',
  )
  const prodUploadRoot = normalizeHostUploadRoot(
    process.env.PROD_PRIVATE_UPLOAD_HOST_DIR || DEFAULT_PRIVATE_UPLOAD_HOST_DIR,
    'PROD_PRIVATE_UPLOAD_HOST_DIR',
  )

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
    const attachmentPlans = attachments.map((attachment) => (
      buildAttachmentPlan(attachment, testUploadRoot, legacyTestUploadRoot, prodUploadRoot)
    ))
    validateSourceAttachments(attachmentPlans, testSshHost)

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
    const sourceApplicationById = new Map(applications.map((row) => [row.id, row]))
    const sourceApplicationByOrderNo = new Map(applications.map((row) => [row.order_no, row]))
    for (const existing of existingApplications) {
      const sourceById = sourceApplicationById.get(existing.id)
      const sourceByOrderNo = sourceApplicationByOrderNo.get(existing.order_no)
      if (!sourceById || !sourceByOrderNo || sourceById !== sourceByOrderNo) {
        throw new Error(`prod 申请与源数据冲突：id=${existing.id}，order_no=${existing.order_no}`)
      }
    }
    const existingApplicationIds = new Set(existingApplications.map((row) => row.id))
    const applicationsToCreate = applications.filter((row) => !existingApplicationIds.has(row.id))

    const existingAttachments = await queryRows(target,
      'SELECT id, application_id FROM lakala_onboarding_attachments WHERE id = ANY($1::text[])',
      [attachments.map((row) => row.id)],
    )
    const sourceAttachmentById = new Map(attachments.map((row) => [row.id, row]))
    for (const existing of existingAttachments) {
      const sourceAttachment = sourceAttachmentById.get(existing.id)
      if (!sourceAttachment || existing.application_id !== sourceAttachment.application_id) {
        throw new Error(`prod 附件与源数据冲突：id=${existing.id}，application_id=${existing.application_id}`)
      }
    }
    const existingAttachmentIds = new Set(existingAttachments.map((row) => row.id))
    const attachmentPlansToCreate = attachmentPlans.filter(({ attachment }) => !existingAttachmentIds.has(attachment.id))

    const existingLogs = await queryRows(target,
      'SELECT id, application_id FROM lakala_onboarding_request_logs WHERE id = ANY($1::text[])',
      [logs.map((row) => row.id)],
    )
    const sourceLogById = new Map(logs.map((row) => [row.id, row]))
    for (const existing of existingLogs) {
      const sourceLog = sourceLogById.get(existing.id)
      if (!sourceLog || existing.application_id !== sourceLog.application_id) {
        throw new Error(`prod 请求日志与源数据冲突：id=${existing.id}，application_id=${existing.application_id}`)
      }
    }
    const existingLogIds = new Set(existingLogs.map((row) => row.id))
    const logsToCreate = logs.filter((row) => !existingLogIds.has(row.id))

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
      applications: {
        source: applications.length,
        toCreate: applicationsToCreate.length,
        existing: existingApplications.length,
      },
      merchantsToCreate: missingMerchants.length,
      attachments: {
        source: attachments.length,
        toCreate: attachmentPlansToCreate.length,
        existing: existingAttachments.length,
        toCreateItems: attachmentPlansToCreate.map(({ attachment }) => ({
          id: attachment.id,
          applicationId: attachment.application_id,
          applicationOrderNo: sourceApplicationById.get(attachment.application_id)?.order_no,
          displayName: attachment.display_name,
          status: attachment.status,
        })),
      },
      attachmentFiles: {
        sourceRoots: [
          `${testSshHost}:${testUploadRoot}`,
          `${testSshHost}:${legacyTestUploadRoot}`,
        ],
        target: `${prodSshHost}:${prodUploadRoot}`,
        validated: attachmentPlans.length,
      },
      requestLogs: {
        source: logs.length,
        toCreate: logsToCreate.length,
        existing: existingLogs.length,
      },
    }, null, 2))
    if (!apply) return

    const copiedTargetPaths = []
    let transactionStarted = false
    try {
      copyAttachmentsToProd(attachmentPlans, testSshHost, prodSshHost, copiedTargetPaths)
      await target.query('BEGIN')
      transactionStarted = true
      for (const merchant of missingMerchants) {
        await target.query(`
          INSERT INTO lakala_merchants (id, merchant_name, merchant_no, term_no, enabled, market_org_node_id, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [merchant.id, merchant.merchant_name, merchant.merchant_no, merchant.term_no, merchant.enabled, merchant.market_org_node_id, merchant.created_at, merchant.updated_at])
      }
      for (const app of applications) {
        const merchantId = targetMerchantIdBySourceId.get(app.lakala_merchant_id)
        await target.query('UPDATE stores SET lakala_merchant_id=$1 WHERE store_id=$2', [merchantId, app.store_id])
      }
      for (const app of applicationsToCreate) {
        const merchantId = targetMerchantIdBySourceId.get(app.lakala_merchant_id)
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
      for (const plan of attachmentPlansToCreate) {
        const { attachment } = plan
        await target.query(`
          INSERT INTO lakala_onboarding_attachments (
            id, application_id, att_type, display_name, local_path, file_name, file_ext, file_size, mime_type, status,
            att_file_id, lakala_file_url, lakala_show_url, lakala_batch_no, lakala_ocr_status, uploaded_to_lakala_at,
            expires_at, last_error_message, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `, [attachment.id, attachment.application_id, attachment.att_type, attachment.display_name, plan.targetLocalPath, attachment.file_name, attachment.file_ext, attachment.file_size, attachment.mime_type, attachment.status, attachment.att_file_id, attachment.lakala_file_url, attachment.lakala_show_url, attachment.lakala_batch_no, attachment.lakala_ocr_status, attachment.uploaded_to_lakala_at, attachment.expires_at, attachment.last_error_message, attachment.created_at, attachment.updated_at])
      }
      for (const plan of attachmentPlans) {
        if (!existingAttachmentIds.has(plan.attachment.id)) continue
        await target.query(
          'UPDATE lakala_onboarding_attachments SET local_path=$1 WHERE id=$2 AND application_id=$3',
          [plan.targetLocalPath, plan.attachment.id, plan.attachment.application_id],
        )
      }
      for (const log of logsToCreate) {
        await target.query(`
          INSERT INTO lakala_onboarding_request_logs (
            id, application_id, api_name, request_id, request_payload_masked, response_payload, success, error_code, error_message, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [log.id, log.application_id, log.api_name, log.request_id, jsonValue(log.request_payload_masked), jsonValue(log.response_payload), log.success, log.error_code, log.error_message, log.created_at])
      }
      await target.query('COMMIT')
      transactionStarted = false
    } catch (error) {
      if (transactionStarted) await target.query('ROLLBACK')
      cleanupCopiedAttachments(prodSshHost, copiedTargetPaths)
      throw error
    }
  } finally {
    await source.end()
    await target.end()
    closeSshControl(testSshHost)
    closeSshControl(prodSshHost)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`迁移失败：${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  buildAttachmentPlan,
  normalizeHostUploadRoot,
  shellQuote,
}
