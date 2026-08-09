#!/usr/bin/env node
'use strict'

/**
 * 导出 WorkFine 在办进销存单据和顾客未领取权益，供上线后人工重建。
 * 不向 WorkFine 或 PostgreSQL 写入任何数据。
 *
 * 需要为 UDT_S_494/350/525/580/582/872 提供状态字段映射，避免把历史已完成单据误导出。
 */

const fs = require('node:fs')
const path = require('node:path')
const mssql = require('mssql')
const {
  assertMetadataField,
  createMssqlConfig,
  getMetadataTable,
  inspectMssqlObject,
  loadTemplateMetadata,
  parseJsonObject,
  readMssqlObject,
  templateMetadataReport,
  text,
} = require('./workfine-inventory-common')

const PENDING_SOURCES = [
  {
    code: 'S336',
    table: 'UDT_S_336',
    label: '分院报货单（S336，已核验）',
    defaultRule: { completionField: 'UDF_S_3684', pendingValues: ['否'], completedValues: ['是'] },
  },
  {
    code: 'S548',
    table: 'UDT_S_548',
    label: '分院间调货出库（S548，已核验）',
    defaultRule: { completionField: 'UDF_S_4636', pendingValues: [''], completedValues: ['已完成'] },
  },
  {
    code: 'S612',
    table: 'UDT_S_612',
    label: '分院间调货入库（S612，已核验）',
    defaultRule: { completionField: 'UDF_S_5593', pendingValues: [''], completedValues: ['是'] },
  },
  { code: 'S494', table: 'UDT_S_494', label: '在办来源 S494（须以模板元数据复核）' },
  { code: 'S350', table: 'UDT_S_350', label: '在办来源 S350（须以模板元数据复核）' },
  { code: 'S525', table: 'UDT_S_525', label: '在办来源 S525（须以模板元数据复核）' },
  { code: 'S580', table: 'UDT_S_580', label: '市场调货来源 S580（须以模板元数据复核）' },
  { code: 'S582', table: 'UDT_S_582', label: '市场调货来源 S582（须以模板元数据复核）' },
  { code: 'S872', table: 'UDT_S_872', label: '在办来源 S872（须以模板元数据复核）' },
]

const COMMON_FIELDS = {
  rid: ['RID', 'rid', 'source_rid', 'legacy_rid'],
  obyid: ['OBYID', 'obyid', 'source_obyid', 'legacy_obyid'],
  docNo: ['doc_no', 'document_no', 'legacy_doc_no', 'UDF_S_1881', 'UDF_V_1881'],
  docDate: ['doc_date', 'document_date', 'date', 'UDF_S_1884', 'UDF_V_1884'],
  marketName: ['market_name', 'market', 'UDF_S_1882', 'UDF_V_1882'],
  storeName: ['store_name', 'branch_name', 'UDF_S_4473', 'UDF_S_1883', 'UDF_V_4473', 'UDF_V_1883'],
  customerId: ['customer_id', 'UDF_S_5438', 'UDF_V_5438'],
  customerName: ['customer_name', 'UDF_S_5439', 'UDF_V_5439'],
}

function usage() {
  return `
WorkFine 在办进销存 / 未领取权益人工重建清单

  node db/scripts/export-workfine-inventory-rebuild.js --dry-run
  node db/scripts/export-workfine-inventory-rebuild.js --verify
  node db/scripts/export-workfine-inventory-rebuild.js --output /absolute/path/rebuild.json

参数：
  --dry-run              查询并统计，不写文件
  --verify               查询并校验 RID、状态规则和市场调货对方入库异常
  --output PATH          导出 JSON 或 CSV（扩展名决定格式）
  --overwrite            允许覆盖已有输出文件
  --inspect              列出所有来源表/未领取权益视图字段
  --help                 显示本说明

安全前置：
  WORKFINE_INVENTORY_PENDING_RULES 是 JSON，必须为每个来源定义 completionField、
  pendingValues、completedValues，
  例如：
  {"S494":{"completionField":"UDF_S_xxx","pendingValues":["待处理"],"completedValues":["已完成"]}}

  WORKFINE_UNCLAIMED_BENEFITS_VIEW 指向只返回“尚未领取”的 WorkFine 视图。
  WORKFINE_INVENTORY_PENDING_FIELD_MAP 可覆盖 docNo/docDate/marketName/storeName 等字段。
  WORKFINE_INVENTORY_PENDING_EXPECTED_COUNTS 可在切换前锁定核验数量，键为
  S336/S494/...、UNCLAIMED、MARKET_TRANSFER_ANOMALIES。

  每个 UDT_S 来源都会按 tb_sys_template_table.id 与
  tb_sys_template_field.owner_id 核验物理表和状态字段；模板显示名不参与匹配。
`
}

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, inspect: false, output: null, overwrite: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--verify') args.verify = true
    else if (arg === '--inspect') args.inspect = true
    else if (arg === '--output') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--output 需要输出路径')
      args.output = value
      index += 1
    } else if (arg === '--overwrite') args.overwrite = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  const modes = [args.dryRun, args.verify, args.inspect, Boolean(args.output)].filter(Boolean).length
  if (modes > 1) throw new Error('--dry-run、--verify、--inspect、--output 只能选择一种主模式')
  return args
}

function log(message) {
  console.log(`[WORKFINE-INVENTORY-REBUILD] ${message}`)
}

function getColumn(row, candidates) {
  const lower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]))
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, candidate)) return row[candidate]
    if (lower.has(candidate.toLowerCase())) return lower.get(candidate.toLowerCase())
  }
  return null
}

function configuredField(map, sourceCode, name) {
  const sourceMap = map[sourceCode] || map[sourceCode.toLowerCase()] || map['*'] || {}
  const configured = sourceMap[name]
  const candidates = Array.isArray(configured) ? configured : configured ? [configured] : []
  return [...candidates, ...(COMMON_FIELDS[name] || [])]
}

function normalizedDate(value) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : String(value)
}

function serializableRaw(row) {
  const output = {}
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) output[key] = value.toISOString()
    else if (Buffer.isBuffer(value)) output[key] = `[binary ${value.length} bytes]`
    else output[key] = value
  }
  return output
}

function resolveRule(source, rules) {
  const configured = rules[source.code] || rules[source.code.toLowerCase()] || null
  const rule = { ...(source.defaultRule || {}), ...(configured || {}) }
  if (!text(rule.completionField)) {
    throw new Error(`${source.code} 未配置 completionField；为避免导出历史已完成单据，拒绝继续`)
  }
  const pendingValues = Array.isArray(rule.pendingValues)
    ? rule.pendingValues.map((value) => String(value).trim())
    : []
  const completedValues = Array.isArray(rule.completedValues)
    ? rule.completedValues.map((value) => String(value).trim())
    : []
  if (pendingValues.length === 0 || completedValues.length === 0) {
    throw new Error(`${source.code} 必须同时配置 pendingValues 与 completedValues；不能把未知状态默认当作在办`)
  }
  const duplicated = pendingValues.filter((value) => completedValues.includes(value))
  if (duplicated.length > 0) {
    throw new Error(`${source.code} 的 pendingValues 与 completedValues 重叠：${[...new Set(duplicated)].join(', ')}`)
  }
  return {
    completionField: rule.completionField,
    completedValues,
    pendingValues,
  }
}

function isPendingRow(row, rule, source) {
  const raw = getColumn(row, [rule.completionField])
  const value = text(raw) || ''
  if (rule.pendingValues.includes(value)) return true
  if (rule.completedValues.includes(value)) return false
  const rid = text(getColumn(row, COMMON_FIELDS.rid)) || '(缺少 RID)'
  throw new Error(`${source.code} RID=${rid} 的 ${rule.completionField}=${JSON.stringify(value)} 不在 pendingValues/completedValues 中`)
}

function normalizePendingRow(row, source, fieldMap, rule) {
  const rid = text(getColumn(row, configuredField(fieldMap, source.code, 'rid')))
  if (!rid) throw new Error(`${source.code} 存在缺少 RID 的在办记录`)
  return {
    category: '在办库存业务',
    sourceCode: source.code,
    sourceTable: source.table,
    sourceLabel: source.label,
    legacyRid: rid,
    legacyObyid: text(getColumn(row, configuredField(fieldMap, source.code, 'obyid'))) || '',
    legacyDocNo: text(getColumn(row, configuredField(fieldMap, source.code, 'docNo'))),
    docDate: normalizedDate(getColumn(row, configuredField(fieldMap, source.code, 'docDate'))),
    marketName: text(getColumn(row, configuredField(fieldMap, source.code, 'marketName'))),
    storeName: text(getColumn(row, configuredField(fieldMap, source.code, 'storeName'))),
    customerId: text(getColumn(row, configuredField(fieldMap, source.code, 'customerId'))),
    customerName: text(getColumn(row, configuredField(fieldMap, source.code, 'customerName'))),
    completionField: rule.completionField,
    completionValue: text(getColumn(row, [rule.completionField])),
    rebuildAction: '人工按 WorkFine 原记录重建；不得自动迁移',
    raw: serializableRaw(row),
  }
}

function assertPendingSourceMetadata(metadata, sources, rules) {
  for (const source of sources) {
    getMetadataTable(metadata, source.table)
    const rule = resolveRule(source, rules)
    assertMetadataField(metadata, source.table, rule.completionField, `${source.code} 完成状态字段`)
  }
}

async function readPendingSources(pool, rules, fieldMap) {
  const records = []
  for (const source of PENDING_SOURCES) {
    const rule = resolveRule(source, rules)
    const rows = await readMssqlObject(pool, mssql, source.table, 'TABLE')
    const pending = rows.filter((row) => isPendingRow(row, rule, source))
    log(`${source.code}：总计 ${rows.length} 行，在办 ${pending.length} 行`)
    for (const row of pending) records.push(normalizePendingRow(row, source, fieldMap, rule))
  }
  return records
}

function normalizeUnclaimedRow(row, fieldMap, sourceView) {
  const rid = text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'rid')))
  return {
    category: '顾客未领取权益',
    sourceCode: 'UNCLAIMED',
    sourceTable: sourceView,
    sourceLabel: '顾客未领取权益',
    legacyRid: rid || '',
    legacyObyid: text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'obyid'))) || '',
    legacyDocNo: text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'docNo'))),
    docDate: normalizedDate(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'docDate'))),
    marketName: text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'marketName'))),
    storeName: text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'storeName'))),
    customerId: text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'customerId'))),
    customerName: text(getColumn(row, configuredField(fieldMap, 'UNCLAIMED', 'customerName'))),
    completionField: null,
    completionValue: null,
    rebuildAction: '人工核对顾客权益后重建；不得自动迁移',
    raw: serializableRaw(row),
  }
}

function parseExpectedCounts(env = process.env) {
  const counts = parseJsonObject(
    env.WORKFINE_INVENTORY_PENDING_EXPECTED_COUNTS,
    'WORKFINE_INVENTORY_PENDING_EXPECTED_COUNTS',
  )
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`WORKFINE_INVENTORY_PENDING_EXPECTED_COUNTS.${key} 必须是非负整数`)
    }
  }
  return counts
}

function expectedCountFailures(pending, unclaimed, anomalies, expectedCounts) {
  if (Object.keys(expectedCounts).length === 0) return []
  const actual = {}
  for (const source of PENDING_SOURCES) {
    actual[source.code] = pending.filter((record) => record.sourceCode === source.code).length
  }
  actual.UNCLAIMED = unclaimed.length
  actual.MARKET_TRANSFER_ANOMALIES = anomalies.length
  const failures = []
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      failures.push(`未知期望数量键 ${key}`)
      continue
    }
    if (actual[key] !== expected) failures.push(`${key} 数量不一致：期望 ${expected}，实际 ${actual[key]}`)
  }
  return failures
}

function expectedCountCoverageFailures(expectedCounts) {
  const required = [
    ...PENDING_SOURCES.map((source) => source.code),
    'UNCLAIMED',
    'MARKET_TRANSFER_ANOMALIES',
  ]
  return required
    .filter((key) => !Object.prototype.hasOwnProperty.call(expectedCounts, key))
    .map((key) => `缺少切换基线数量 ${key}`)
}

async function readUnclaimedBenefits(pool, fieldMap, env = process.env) {
  const view = text(env.WORKFINE_UNCLAIMED_BENEFITS_VIEW)
  if (!view) throw new Error('缺少 WORKFINE_UNCLAIMED_BENEFITS_VIEW；不能漏导顾客未领取权益')
  const rows = await readMssqlObject(pool, mssql, view, 'VIEW')
  log(`顾客未领取权益视图 ${view}：${rows.length} 行`)
  return rows.map((row) => normalizeUnclaimedRow(row, fieldMap, view))
}

function marketTransferAnomalies(records) {
  const outgoing = new Map()
  const incoming = new Set()
  for (const record of records) {
    if (!record.legacyDocNo) continue
    if (record.sourceCode === 'S580') outgoing.set(record.legacyDocNo, record)
    if (record.sourceCode === 'S582') incoming.add(record.legacyDocNo)
  }
  return [...outgoing.entries()]
    .filter(([docNo]) => !incoming.has(docNo))
    .map(([docNo, record]) => ({
      ...record,
      category: '市场调货异常',
      rebuildAction: '对方入库记录已删除或缺失，人工核对后重建市场调货双方单据',
      anomaly: 'market_transfer_counterpart_inbound_deleted',
      legacyDocNo: docNo,
    }))
}

function normalizeMarketTransferRecord(row, source, fieldMap) {
  const rid = text(getColumn(row, configuredField(fieldMap, source.code, 'rid')))
  const docNo = text(getColumn(row, configuredField(fieldMap, source.code, 'docNo')))
  if (!rid) throw new Error(`${source.code} 存在缺少 RID 的市场调货记录，不能核对对方入库`)
  if (!docNo) throw new Error(`${source.code} RID=${rid} 缺少单据号，不能核对对方入库`)
  return {
    category: '市场调货异常',
    sourceCode: source.code,
    sourceTable: source.table,
    sourceLabel: source.label,
    legacyRid: rid,
    legacyObyid: text(getColumn(row, configuredField(fieldMap, source.code, 'obyid'))) || '',
    legacyDocNo: docNo,
    docDate: normalizedDate(getColumn(row, configuredField(fieldMap, source.code, 'docDate'))),
    marketName: text(getColumn(row, configuredField(fieldMap, source.code, 'marketName'))),
    storeName: text(getColumn(row, configuredField(fieldMap, source.code, 'storeName'))),
    customerId: null,
    customerName: null,
    completionField: null,
    completionValue: null,
    rebuildAction: '对方入库记录已删除或缺失，人工核对后重建市场调货双方单据',
    anomaly: 'market_transfer_counterpart_inbound_deleted',
    raw: serializableRaw(row),
  }
}

async function readMarketTransferAnomalies(pool, fieldMap) {
  const outgoingSource = PENDING_SOURCES.find((source) => source.code === 'S580')
  const incomingSource = PENDING_SOURCES.find((source) => source.code === 'S582')
  const [outgoingRows, incomingRows] = await Promise.all([
    readMssqlObject(pool, mssql, outgoingSource.table, 'TABLE'),
    readMssqlObject(pool, mssql, incomingSource.table, 'TABLE'),
  ])
  const incomingDocNos = new Set(incomingRows.map((row) => normalizeMarketTransferRecord(row, incomingSource, fieldMap).legacyDocNo))
  const anomalies = outgoingRows
    .map((row) => normalizeMarketTransferRecord(row, outgoingSource, fieldMap))
    .filter((record) => !incomingDocNos.has(record.legacyDocNo))
  return anomalies
}

function csvEscape(value) {
  const raw = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

function toCsv(records) {
  const columns = [
    'category',
    'sourceCode',
    'sourceTable',
    'sourceLabel',
    'legacyRid',
    'legacyObyid',
    'legacyDocNo',
    'docDate',
    'marketName',
    'storeName',
    'customerId',
    'customerName',
    'completionField',
    'completionValue',
    'anomaly',
    'rebuildAction',
    'raw',
  ]
  const lines = [columns.join(',')]
  for (const record of records) {
    lines.push(columns.map((column) => csvEscape(column === 'raw' ? JSON.stringify(record.raw) : record[column])).join(','))
  }
  return `\uFEFF${lines.join('\n')}\n`
}

function writeOutput(outputPath, records, overwrite) {
  const resolved = path.resolve(outputPath)
  if (fs.existsSync(resolved) && !overwrite) {
    throw new Error(`输出文件已存在：${resolved}；如确认覆盖，请加 --overwrite`)
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const content = resolved.toLowerCase().endsWith('.csv')
    ? toCsv(records)
    : `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`
  fs.writeFileSync(resolved, content, 'utf8')
  return resolved
}

function printMetadataReport(metadata) {
  const sourceTables = PENDING_SOURCES.map((source) => source.table)
  const report = templateMetadataReport(metadata, sourceTables)
  log(`模板元数据：以下字段按 tb_sys_template_field.owner_id -> tb_sys_template_table.id 归属。`)
  for (const table of report) {
    log(`  ${table.physicalTable}（物理表 ID=${table.physicalTableId}，模板 ID=${table.templateId || '-'}，名称=${table.nativeName || '-'}）字段：${table.fields.map((field) => field.columnName).join(', ') || '(无 UDF 字段)'}`)
  }
}

async function inspect(pool, env, metadata) {
  printMetadataReport(metadata)
  for (const source of PENDING_SOURCES) {
    const result = await inspectMssqlObject(pool, mssql, source.table, 'TABLE')
    log(`${source.code}/${source.table} 字段：${result.columns.join(', ')}`)
  }
  const view = text(env.WORKFINE_UNCLAIMED_BENEFITS_VIEW)
  if (view) {
    const result = await inspectMssqlObject(pool, mssql, view, 'VIEW')
    log(`UNCLAIMED/${view} 字段：${result.columns.join(', ')}`)
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }
  const rules = parseJsonObject(env.WORKFINE_INVENTORY_PENDING_RULES, 'WORKFINE_INVENTORY_PENDING_RULES')
  const fieldMap = parseJsonObject(env.WORKFINE_INVENTORY_PENDING_FIELD_MAP, 'WORKFINE_INVENTORY_PENDING_FIELD_MAP')
  const expectedCounts = parseExpectedCounts(env)
  const pool = new mssql.ConnectionPool(createMssqlConfig(env))
  await pool.connect()
  try {
    const metadata = await loadTemplateMetadata(pool, mssql)
    if (args.inspect) {
      await inspect(pool, env, metadata)
      return 0
    }
    assertPendingSourceMetadata(metadata, PENDING_SOURCES, rules)
    const pending = await readPendingSources(pool, rules, fieldMap)
    const unclaimed = await readUnclaimedBenefits(pool, fieldMap, env)
    const anomalies = await readMarketTransferAnomalies(pool, fieldMap)
    const records = [...pending, ...unclaimed, ...anomalies]
    log(`重建清单：在办 ${pending.length} 条，未领取权益 ${unclaimed.length} 条，市场调货异常 ${anomalies.length} 条。`)
    if (args.dryRun) {
      log('DRY-RUN 完成，未写出文件。')
      return 0
    }
    if (args.verify) {
      const invalid = records.filter((record) => record.category !== '顾客未领取权益' && !record.legacyRid)
      if (invalid.length > 0) {
        log(`VERIFY FAIL：${invalid.length} 条在办记录缺少 RID`)
        return 1
      }
      const countFailures = [
        ...expectedCountCoverageFailures(expectedCounts),
        ...expectedCountFailures(pending, unclaimed, anomalies, expectedCounts),
      ]
      if (countFailures.length > 0) {
        for (const failure of countFailures) log(`VERIFY FAIL：${failure}`)
        return 1
      }
      log('VERIFY PASS：所有在办记录均有 RID，状态规则和异常清单已生成。')
      return 0
    }
    if (!args.output) throw new Error('请提供 --output PATH，或使用 --dry-run / --verify')
    const destination = writeOutput(args.output, records, args.overwrite)
    log(`已写入人工重建清单：${destination}`)
    return 0
  } finally {
    await pool.close()
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exitCode = code,
    (error) => {
      console.error(`[WORKFINE-INVENTORY-REBUILD] 失败：${error.message}`)
      process.exitCode = 1
    },
  )
}

module.exports = {
  PENDING_SOURCES,
  expectedCountCoverageFailures,
  expectedCountFailures,
  main,
  marketTransferAnomalies,
  normalizeMarketTransferRecord,
  parseExpectedCounts,
  parseArgs,
  readMarketTransferAnomalies,
  resolveRule,
  usage,
}
