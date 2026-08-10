#!/usr/bin/env node
'use strict'

/**
 * Read-only verification for the inventory v3 schema and migration history.
 * Run this against each target database before enabling the v3 write paths.
 */

const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { Client } = require('pg')

const REQUIRED_TABLES = [
  'inventory_locations',
  'inventory_stock_lots',
  'inventory_docs',
  'inventory_doc_items',
  'inventory_doc_links',
  'inventory_movements',
]

const REQUIRED_COLUMNS = [
  ['inventory_locations', 'parent_location_id'],
  ['inventory_stock_lots', 'supplier_id'],
  ['inventory_stock_lots', 'source_doc_id'],
  ['inventory_doc_links', 'from_item_id'],
  ['inventory_doc_links', 'to_item_id'],
  ['inventory_movements', 'quantity_before'],
  ['inventory_movements', 'quantity_after'],
]

const FORBIDDEN_COLUMNS = [
  ['inventory_docs', 'related_doc_id'],
  ['inventory_docs', 'request_doc_id'],
]

const REQUIRED_CONSTRAINTS = [
  'inventory_locations_parent_location_id_inventory_locations_location_id_fk',
  'inventory_stock_lots_supplier_id_inventory_suppliers_supplier_id_fk',
  'inventory_stock_lots_source_doc_id_inventory_docs_id_fk',
  'inventory_doc_links_from_item_doc_fk',
  'inventory_doc_links_to_item_doc_fk',
  'inventory_movements_doc_item_doc_fk',
  'chk_inventory_docs_type',
  'chk_inventory_locations_parent_not_self',
  'chk_inventory_doc_links_item_pair',
  'chk_inventory_doc_links_quantity_shape',
  'chk_inventory_doc_links_relation_type',
  'chk_inventory_movements_direction_delta',
  'chk_inventory_movements_balance',
  'chk_inventory_movements_doc_item_pair',
]

const REQUIRED_INDEXES = [
  'uq_inventory_doc_items_id_doc',
]

const REQUIRED_TRIGGERS = [
  'trg_inventory_doc_links_validate',
  'trg_inventory_movements_apply_lot',
  'trg_inventory_stock_lots_guard_balance',
  'trg_inventory_movements_append_only',
  'trg_inventory_docs_validate_lifecycle',
  'trg_inventory_locations_validate_tree',
  'trg_org_nodes_sync_inventory_locations',
  'trg_stores_sync_inventory_locations',
]

const REQUIRED_MIGRATIONS = [
  '0007_moaning_salo',
  '0008_lucky_tag',
  '0009_inventory_integrity_guards',
  '0010_mute_black_bolt',
]

function postgresIdentifier(name) {
  return Buffer.byteLength(name, 'utf8') <= 63
    ? name
    : Buffer.from(name, 'utf8').subarray(0, 63).toString('utf8')
}

function expectedMigrationTimes() {
  const journalPath = resolve(__dirname, '../migrations/meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const entries = new Map(journal.entries.map((entry) => [entry.tag, entry.when]))
  return REQUIRED_MIGRATIONS.map((tag) => ({ tag, when: entries.get(tag) }))
}

function report(label, missing) {
  if (missing.length === 0) {
    console.log(`PASS ${label}`)
    return true
  }
  console.error(`FAIL ${label}: ${missing.join(', ')}`)
  return false
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required; this verifier does not infer a target database.')
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    let ok = true
    const tableRows = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    )
    const existingTables = new Set(tableRows.rows.map((row) => row.table_name))
    ok = report('required tables', REQUIRED_TABLES.filter((name) => !existingTables.has(name))) && ok

    const columnRows = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [Array.from(new Set([
        ...REQUIRED_COLUMNS.map(([table]) => table),
        ...FORBIDDEN_COLUMNS.map(([table]) => table),
      ]))],
    )
    const columns = new Set(columnRows.rows.map((row) => `${row.table_name}.${row.column_name}`))
    ok = report(
      'required columns',
      REQUIRED_COLUMNS
        .filter(([table, column]) => !columns.has(`${table}.${column}`))
        .map(([table, column]) => `${table}.${column}`),
    ) && ok
    ok = report(
      'retired lineage columns',
      FORBIDDEN_COLUMNS
        .filter(([table, column]) => columns.has(`${table}.${column}`))
        .map(([table, column]) => `${table}.${column}`),
    ) && ok

    const expectedConstraints = REQUIRED_CONSTRAINTS.map((name) => ({
      name,
      databaseName: postgresIdentifier(name),
    }))
    const constraintRows = await client.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conname = ANY($1::text[])`,
      [expectedConstraints.map(({ databaseName }) => databaseName)],
    )
    const indexRows = await client.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])`,
      [REQUIRED_INDEXES],
    )
    const constraints = new Map(constraintRows.rows.map((row) => [row.conname, row.convalidated]))
    const indexes = new Set(indexRows.rows.map((row) => row.indexname))
    ok = report(
      'constraints and indexes',
      [
        ...expectedConstraints
          .filter(({ databaseName }) => !constraints.has(databaseName))
          .map(({ name }) => name),
        ...REQUIRED_INDEXES.filter((name) => !indexes.has(name)),
      ],
    ) && ok
    ok = report(
      'validated constraints',
      expectedConstraints
        .filter(({ databaseName }) => constraints.get(databaseName) !== true)
        .map(({ name }) => name),
    ) && ok

    const triggerRows = await client.query(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])`,
      [REQUIRED_TRIGGERS],
    )
    const existingTriggers = new Set(triggerRows.rows.map((row) => row.tgname))
    ok = report('integrity triggers', REQUIRED_TRIGGERS.filter((name) => !existingTriggers.has(name))) && ok

    const migrationTable = await client.query(
      "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name",
    )
    if (!migrationTable.rows[0]?.name) {
      ok = report('Drizzle migration records', REQUIRED_MIGRATIONS) && ok
    } else {
      const expected = expectedMigrationTimes()
      const unknown = expected.filter((entry) => entry.when == null).map((entry) => entry.tag)
      if (unknown.length > 0) {
        ok = report('local migration journal', unknown) && ok
      } else {
        const migrationRows = await client.query(
          'SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])',
          [expected.map((entry) => entry.when)],
        )
        const applied = new Set(migrationRows.rows.map((row) => Number(row.created_at)))
        ok = report(
          'Drizzle migration records',
          expected.filter((entry) => !applied.has(Number(entry.when))).map((entry) => entry.tag),
        ) && ok
      }
    }

    const auditRows = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM inventory_stock_lots
           WHERE lot_key NOT LIKE '%|supplier:%|source:%') AS legacy_lot_key_count,
         (SELECT COUNT(*)::int FROM inventory_doc_links
           WHERE relation_type <> '历史关联'
             AND (from_item_id IS NULL OR to_item_id IS NULL OR quantity IS NULL)) AS malformed_link_count,
         (SELECT COUNT(*)::int FROM inventory_movements
           WHERE (doc_item_id IS NULL) IS DISTINCT FROM (doc_id IS NULL)) AS malformed_movement_doc_pair_count`,
    )
    const audit = auditRows.rows[0]
    ok = report(
      'data backfill',
      [
        ...(Number(audit.legacy_lot_key_count) > 0 ? [`legacy lot keys=${audit.legacy_lot_key_count}`] : []),
        ...(Number(audit.malformed_link_count) > 0 ? [`malformed links=${audit.malformed_link_count}`] : []),
        ...(Number(audit.malformed_movement_doc_pair_count) > 0
          ? [`malformed movement document pairs=${audit.malformed_movement_doc_pair_count}`]
          : []),
      ],
    ) && ok

    if (!ok) process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(`VERIFY ERROR: ${error.message}`)
  process.exitCode = 1
})
