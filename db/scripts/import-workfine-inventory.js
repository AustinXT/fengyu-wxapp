#!/usr/bin/env node
'use strict'

/**
 * WorkFine 三层期初库存一次性迁移。
 *
 * 只读取 UDV_519（公司）、UDV_538（市场）、UDV_607（分院）及两个批次价格视图。
 * 不读取历史单据，也不处理在办报货、发货、配货或调货。
 *
 * 用法：
 *   node db/scripts/import-workfine-inventory.js --dry-run --as-of 2026-08-09
 *   node db/scripts/import-workfine-inventory.js --verify --as-of 2026-08-09
 *   node db/scripts/import-workfine-inventory.js --apply --as-of 2026-08-09
 *   node db/scripts/import-workfine-inventory.js --inspect
 */

const mssql = require('mssql')
const { Pool } = require('pg')
const {
  PRICE_VIEW_DEFINITIONS,
  STOCK_VIEW_DEFINITIONS,
  LocationResolver,
  applyPriceRows,
  assertConfiguredPhysicalFieldMappings,
  assertImporterEmployee,
  assertPhysicalSourceStructures,
  assertTargetTables,
  assertWorkfineBaselineExclusive,
  createMssqlConfig,
  createPgConfig,
  deduplicateSnapshotRows,
  documentId,
  documentIdentity,
  groupRowsByDocument,
  inspectMssqlObject,
  loadTemplateMetadata,
  normalizePriceRow,
  normalizeSnapshotRow,
  parseJsonObject,
  printRowSummary,
  readMssqlObject,
  resolveImportRefContract,
  sourceKey,
  syncInventoryLocations,
  templateMetadataReport,
  text,
  upsertDocItem,
  upsertImportRef,
  upsertInitialDocument,
  upsertLot,
  upsertMovement,
  upsertSku,
} = require('./workfine-inventory-common')

const KNOWN_INVENTORY_METADATA_TABLES = [
  'UDT_S_340', 'UDT_M_341',
  'UDT_S_336', 'UDT_M_342',
  'UDT_S_539', 'UDT_M_540',
  'UDT_S_744', 'UDT_M_745',
  'UDT_S_601', 'UDT_M_602',
  'UDT_S_587', 'UDT_M_588',
  'UDT_S_585', 'UDT_M_586',
  'UDT_S_548', 'UDT_M_549',
  'UDT_S_612', 'UDT_M_613',
]

function usage() {
  return `
WorkFine 三层期初库存迁移（默认不写入）

  --dry-run                 读取并校验 WorkFine 期初库存，不写 PostgreSQL
  --verify                  只读比对 WorkFine 快照与 PostgreSQL 导入引用
  --apply                   显式执行幂等写入；不可与 --dry-run / --verify 同用
  --export-pending PATH     调用独立导出器，生成在办业务/未领取权益人工重建清单
  --inspect                 列出 UDV 字段，并从模板元数据输出物理表/字段归属
  --as-of YYYY-MM-DD        期初库存日期；--apply 时必填，也可用 WORKFINE_INVENTORY_CUTOVER_DATE
  --help                    显示本说明

必需环境变量：
  MSSQL_CONNECTION_STRING，或 MSSQL_SERVER/MSSQL_USER/MSSQL_PASSWORD/MSSQL_DATABASE
  DATABASE_URL（--apply / --verify 时）
  WORKFINE_INVENTORY_IMPORTER_EMPLOYEE_ID（--apply 时）

可选映射：
  WORKFINE_INVENTORY_FIELD_MAP='{"UDV_519":{"productCode":"UDF_V_xxx"}}'
  WORKFINE_INVENTORY_LEGACY_TABLE_MAP='{"UDV_519":"UDT_M_xxx"}'
  INVENTORY_IMPORT_REFS_TABLE=inventory_import_refs

说明：WORKFINE_INVENTORY_LEGACY_TABLE_MAP 中的 UDT 表必须能在
tb_sys_template_table/tb_sys_template_field 中按物理表 ID + owner_id 核验，
且实际表必须同时有 RID、OBYID。模板显示名不作为业务匹配条件。
`
}

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, apply: false, inspect: false, exportPending: null, asOfDate: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--verify') args.verify = true
    else if (arg === '--apply') args.apply = true
    else if (arg === '--inspect') args.inspect = true
    else if (arg === '--as-of') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--as-of 需要 YYYY-MM-DD')
      args.asOfDate = value
      index += 1
    } else if (arg === '--export-pending') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--export-pending 需要输出路径')
      args.exportPending = value
      index += 1
    } else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  const modes = [args.dryRun, args.verify, args.apply, args.inspect, Boolean(args.exportPending)].filter(Boolean).length
  if (modes > 1) throw new Error('--dry-run、--verify、--apply、--inspect、--export-pending 只能选择一个')
  if (args.asOfDate && !isIsoDate(args.asOfDate)) {
    throw new Error('--as-of 必须为 YYYY-MM-DD')
  }
  return args
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function log(message) {
  console.log(`[WORKFINE-INVENTORY-IMPORT] ${message}`)
}

function loadOptions(args, env = process.env) {
  const asOfDate = args.asOfDate || text(env.WORKFINE_INVENTORY_CUTOVER_DATE)
  if (asOfDate && !isIsoDate(asOfDate)) {
    throw new Error('WORKFINE_INVENTORY_CUTOVER_DATE 必须为 YYYY-MM-DD')
  }
  return {
    asOfDate,
    fieldMappings: parseJsonObject(env.WORKFINE_INVENTORY_FIELD_MAP, 'WORKFINE_INVENTORY_FIELD_MAP'),
    legacyTableMap: parseJsonObject(env.WORKFINE_INVENTORY_LEGACY_TABLE_MAP, 'WORKFINE_INVENTORY_LEGACY_TABLE_MAP'),
  }
}

async function loadSourceSnapshot(mssqlPool, options, metadata) {
  const rows = []
  const rejected = []
  for (const definition of STOCK_VIEW_DEFINITIONS) {
    const rawRows = await readMssqlObject(mssqlPool, mssql, definition.view, 'VIEW')
    log(`${definition.view}（${definition.label}）读取 ${rawRows.length} 行`)
    for (let index = 0; index < rawRows.length; index += 1) {
      try {
        rows.push(normalizeSnapshotRow(rawRows[index], definition, options))
      } catch (error) {
        rejected.push({ view: definition.view, row: index + 1, reason: error.message })
      }
    }
  }
  if (rejected.length > 0) return { rows: [], rejected }
  const deduped = deduplicateSnapshotRows(rows)
  for (const row of deduped) {
    assertConfiguredPhysicalFieldMappings(metadata, row.legacyTable, row.viewName, options.fieldMappings)
  }
  await assertPhysicalSourceStructures(mssqlPool, mssql, metadata, deduped.map((row) => row.legacyTable))

  const priceRows = []
  for (const definition of PRICE_VIEW_DEFINITIONS) {
    const rawRows = await readMssqlObject(mssqlPool, mssql, definition.view, 'VIEW')
    log(`${definition.view}（${definition.label}）读取 ${rawRows.length} 行`)
    for (const rawRow of rawRows) {
      const normalized = normalizePriceRow(rawRow, definition, options)
      if (normalized) priceRows.push(normalized)
    }
  }
  const enriched = applyPriceRows(deduped, priceRows)
  return { rows: deduped, rejected: [], priceRows: priceRows.length, enriched }
}

function reportRejected(rejected) {
  log(`发现 ${rejected.length} 条不能安全迁移的源记录，已停止。`)
  for (const row of rejected.slice(0, 20)) {
    log(`  ${row.view} 第 ${row.row} 行：${row.reason}`)
  }
  if (rejected.length > 20) log(`  其余 ${rejected.length - 20} 条省略`)
}

function printMetadataReport(metadata, options) {
  const configuredTables = Object.values(options.legacyTableMap)
  const requestedTables = [...new Set([...KNOWN_INVENTORY_METADATA_TABLES, ...configuredTables])]
  const registeredTables = requestedTables.filter((table) => metadata.tablesByName.has(String(table).toUpperCase()))
  const missingTables = requestedTables.filter((table) => !metadata.tablesByName.has(String(table).toUpperCase()))
  log(`模板元数据：已解析 ${metadata.tables.length} 张 UDT 物理表；以下仅列出已核验的库存相关表。`)
  if (missingTables.length > 0) log(`  未登记或尚未核验：${missingTables.join(', ')}`)
  const report = templateMetadataReport(metadata, registeredTables)
  for (const table of report) {
    log(`  ${table.physicalTable}（物理表 ID=${table.physicalTableId}，模板 ID=${table.templateId || '-'}，名称=${table.nativeName || '-'}）字段：${table.fields.map((field) => field.columnName).join(', ') || '(无 UDF 字段)'}`)
  }
}

async function inspect(mssqlPool, metadata, options) {
  printMetadataReport(metadata, options)
  for (const definition of [...STOCK_VIEW_DEFINITIONS, ...PRICE_VIEW_DEFINITIONS]) {
    const result = await inspectMssqlObject(mssqlPool, mssql, definition.view, 'VIEW')
    log(`${definition.view} 字段：${result.columns.join(', ') || '(无字段)'}`)
  }
}

async function importRows(pgPool, rows, env = process.env) {
  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')
    await assertTargetTables(client)
    const contract = await resolveImportRefContract(client, env)
    await assertWorkfineBaselineExclusive(client, contract)
    const createdBy = await assertImporterEmployee(client, env.WORKFINE_INVENTORY_IMPORTER_EMPLOYEE_ID)
    await syncInventoryLocations(client)
    const resolver = new LocationResolver(client)
    const groups = await groupRowsByDocument(rows, resolver)

    let documentCount = 0
    let itemCount = 0
    for (const group of groups) {
      const docId = await upsertInitialDocument(client, group, createdBy)
      await upsertImportRef(client, contract, 'inventory_doc', docId, documentIdentity(group.row), group.row.legacyDocNo)
      documentCount += 1

      for (const row of group.rows) {
        const skuId = await upsertSku(client, row)
        await upsertImportRef(client, contract, 'inventory_sku', skuId, row, row.legacyDocNo)
        await upsertImportRef(client, contract, 'inventory_location', row.locationId, row, row.legacyDocNo)

        const lotId = await upsertLot(client, row, skuId, docId)
        await upsertImportRef(client, contract, 'inventory_stock_lot', lotId, row, row.legacyDocNo)

        const itemId = await upsertDocItem(client, contract, row, docId, lotId, skuId)
        await upsertImportRef(client, contract, 'inventory_doc_item', itemId, row, row.legacyDocNo)

        const movementId = await upsertMovement(client, row, docId, itemId, lotId, skuId, createdBy)
        await upsertImportRef(client, contract, 'inventory_movement', movementId, row, row.legacyDocNo)
        itemCount += 1
      }
    }
    await client.query('COMMIT')
    return { documentCount, itemCount }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function verifyRows(pgPool, rows, env = process.env) {
  const client = await pgPool.connect()
  try {
    await assertTargetTables(client)
    const contract = await resolveImportRefContract(client, env)
    await assertWorkfineBaselineExclusive(client, contract)
    const sourceRows = new Map(rows.map((row) => [sourceKey(row), row]))
    const entityTypes = [
      'inventory_sku',
      'inventory_location',
      'inventory_stock_lot',
      'inventory_doc_item',
      'inventory_movement',
    ]
    const failures = []
    for (const entityType of entityTypes) {
      const result = await client.query(
        `SELECT legacy_table, legacy_rid, legacy_obyid, entity_id
           FROM ${contract.quotedTable}
          WHERE entity_type = $1`,
        [entityType],
      )
      const refs = new Map(result.rows.map((row) => [`${row.legacy_table}\u001f${row.legacy_rid}\u001f${row.legacy_obyid || ''}`, row]))
      const missing = [...sourceRows.keys()].filter((key) => !refs.has(key))
      if (missing.length > 0) failures.push(`${entityType} 缺少 ${missing.length} 条追溯引用`)
      const unexpected = [...refs.keys()].filter((key) => !sourceRows.has(key))
      if (unexpected.length > 0) failures.push(`${entityType} 存在 ${unexpected.length} 条不在当前快照中的追溯引用`)
    }

    const resolver = new LocationResolver(client)
    const documentGroups = await groupRowsByDocument(rows, resolver)
    const expectedDocuments = new Map(
      documentGroups.map((group) => [
        documentId(group.row, group.location.locationId),
        new Set(group.rows.map((row) => sourceKey(row))),
      ]),
    )
    const docRefs = await client.query(
      `SELECT entity_id, legacy_table, legacy_rid, legacy_obyid
         FROM ${contract.quotedTable}
        WHERE entity_type = 'inventory_doc'`,
    )
    const actualDocumentIds = new Set()
    const unexpectedDocumentRefs = []
    for (const row of docRefs.rows) {
      const key = `${row.legacy_table}\u001f${row.legacy_rid}\u001f${row.legacy_obyid}`
      const expectedSourceKeys = expectedDocuments.get(row.entity_id)
      if (!expectedSourceKeys || !expectedSourceKeys.has(key)) {
        unexpectedDocumentRefs.push(`${row.entity_id}/${key}`)
      }
      actualDocumentIds.add(row.entity_id)
    }
    const missingDocuments = [...expectedDocuments.keys()].filter((id) => !actualDocumentIds.has(id))
    if (missingDocuments.length > 0) failures.push(`inventory_doc 缺少 ${missingDocuments.length} 条追溯引用`)
    if (unexpectedDocumentRefs.length > 0) failures.push(`inventory_doc 存在 ${unexpectedDocumentRefs.length} 条不在当前快照中的追溯引用`)

    const movementCheck = await client.query(
      `SELECT COUNT(*)::int AS bad_count
         FROM inventory_movements m
         JOIN ${contract.quotedTable} r
           ON r.entity_type = 'inventory_movement' AND r.entity_id = m.id::text
        WHERE m.direction <> '入库'
           OR m.quantity_delta <= 0
           OR m.quantity_before <> 0
           OR m.quantity_after <> m.quantity_delta`,
    )
    if (movementCheck.rows[0].bad_count > 0) {
      failures.push(`导入流水存在 ${movementCheck.rows[0].bad_count} 条非期初入库形态记录`)
    }

    const totalResult = await client.query(
      `SELECT COALESCE(SUM(m.quantity_delta), 0)::text AS quantity
         FROM inventory_movements m
         JOIN ${contract.quotedTable} r
           ON r.entity_type = 'inventory_movement' AND r.entity_id = m.id::text`,
    )
    const sourceTotal = rows.reduce((total, row) => total + Number(row.quantity), 0).toFixed(2)
    if (Number(totalResult.rows[0].quantity).toFixed(2) !== sourceTotal) {
      failures.push(`期初数量不一致：WorkFine=${sourceTotal}，PG=${totalResult.rows[0].quantity}`)
    }
    return { failures, sourceTotal, movementTotal: totalResult.rows[0].quantity }
  } finally {
    client.release()
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }
  if (args.exportPending) {
    const { main: exportPending } = require('./export-workfine-inventory-rebuild')
    return exportPending(['--output', args.exportPending], env)
  }
  const options = loadOptions(args, env)
  if (args.apply && !options.asOfDate) throw new Error('--apply 必须提供 --as-of 或 WORKFINE_INVENTORY_CUTOVER_DATE')

  const mssqlPool = new mssql.ConnectionPool(createMssqlConfig(env))
  await mssqlPool.connect()
  try {
    const metadata = await loadTemplateMetadata(mssqlPool, mssql)
    if (args.inspect) {
      await inspect(mssqlPool, metadata, options)
      return 0
    }
    const source = await loadSourceSnapshot(mssqlPool, options, metadata)
    if (source.rejected.length > 0) {
      reportRejected(source.rejected)
      return 1
    }
    log('源快照校验完成：')
    printRowSummary(source.rows, log)
    log(`批次价格候选 ${source.priceRows} 行，补充到 ${source.enriched} 条库存行`)

    if (args.dryRun || (!args.apply && !args.verify)) {
      log('DRY-RUN 完成，未连接或写入 PostgreSQL。')
      return 0
    }

    const pgPool = new Pool(createPgConfig(env))
    try {
      if (args.verify) {
        const verified = await verifyRows(pgPool, source.rows, env)
        if (verified.failures.length > 0) {
          for (const failure of verified.failures) log(`VERIFY FAIL: ${failure}`)
          return 1
        }
        log(`VERIFY PASS：${source.rows.length} 条源行，期初数量 ${verified.sourceTotal}`)
        return 0
      }
      const result = await importRows(pgPool, source.rows, env)
      log(`写入完成：${result.documentCount} 张期初单，${result.itemCount} 条库存明细/流水。`)
      return 0
    } finally {
      await pgPool.end()
    }
  } finally {
    await mssqlPool.close()
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exitCode = code,
    (error) => {
      console.error(`[WORKFINE-INVENTORY-IMPORT] 失败：${error.message}`)
      process.exitCode = 1
    },
  )
}

module.exports = { loadOptions, main, parseArgs, usage, verifyRows }
