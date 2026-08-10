'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const {
  applyPriceRows,
  assertConfiguredPhysicalFieldMappings,
  assertWorkfineBaselineExclusive,
  assertWorkfineInventoryCutoverCanApply,
  assertWorkfineInventoryCutoverCanVerify,
  assertMetadataField,
  deduplicateSnapshotRows,
  documentIdentity,
  getMetadataTable,
  groupRowsByDocument,
  LocationResolver,
  lotKey,
  normalizeSnapshotRow,
  normalizeTemplateMetadata,
  sourceKey,
  WORKFINE_INVENTORY_CUTOVER_KEY,
  WORKFINE_INVENTORY_CUTOVER_STATUSES,
} = require('../workfine-inventory-common')
const { importRows, parseArgs: parseImportArgs, verifyRows } = require('../import-workfine-inventory')
const {
  PENDING_SOURCES,
  expectedCountCoverageFailures,
  expectedCountFailures,
  marketTransferAnomalies,
  normalizeMarketTransferRecord,
  resolveRule,
} = require('../export-workfine-inventory-rebuild')

const options = {
  asOfDate: '2026-08-09',
  fieldMappings: {
    UDV_519: {
      legacyRid: 'RID',
      legacyObyid: 'OBYID',
      productCode: 'code',
      productName: 'name',
      quantity: 'qty',
      batchNo: 'batch',
      expiryDate: 'expiry',
      isGift: 'gift',
      locationName: 'location',
    },
  },
  legacyTableMap: { UDV_519: 'UDT_M_9000' },
}

function snapshotRow(overrides = {}) {
  return {
    RID: 100,
    OBYID: 3,
    code: 'SKU-001',
    name: '测试产品',
    qty: '12.50',
    batch: 'B-1',
    expiry: '2027-01-31',
    gift: '否',
    location: '总部',
    ...overrides,
  }
}

function createCutoverPgPool({ status = '待核验', badMovementCount = 0 } = {}) {
  const queries = []
  const client = {
    released: false,
    query: async (query, values = []) => {
      const sql = String(query)
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('FROM information_schema.tables')) {
        const requested = values[0] || []
        if (requested.includes('inventory_cutover_states')) {
          return { rows: requested.map((tableName) => ({ table_name: tableName })) }
        }
        return { rows: [{ table_name: 'inventory_import_refs' }] }
      }
      if (sql.includes('FROM information_schema.columns')) {
        return {
          rows: [
            'entity_type', 'entity_id', 'legacy_table', 'legacy_rid', 'legacy_obyid', 'legacy_doc_no',
          ].map((columnName) => ({ column_name: columnName })),
        }
      }
      if (sql.includes('INSERT INTO inventory_cutover_states')) return { rows: [] }
      if (sql.includes('SELECT cutover_key, status')) {
        return { rows: [{ cutover_key: WORKFINE_INVENTORY_CUTOVER_KEY, status }] }
      }
      if (sql.includes('UPDATE inventory_cutover_states')) return { rows: [] }
      if (sql.includes('FROM inventory_stock_lots lot')) {
        return { rows: [{ lot_count: 0, quantity: '0' }] }
      }
      if (sql.includes('FROM staff_wechat_users')) return { rows: [{ employee_id: 'employee-1' }] }
      if (sql.includes('INSERT INTO inventory_locations')) return { rows: [] }
      if (sql.includes('COUNT(*)::int AS bad_count')) return { rows: [{ bad_count: badMovementCount }] }
      if (sql.includes('SUM(m.quantity_delta)')) return { rows: [{ quantity: '0' }] }
      if (sql.includes('FROM "inventory_import_refs"')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() {
      this.released = true
    },
  }
  return { client, pgPool: { connect: async () => client }, queries }
}

function queryIndex(queries, fragment) {
  return queries.findIndex(({ sql }) => sql.includes(fragment))
}

test('期初库存行以物理表 + RID + OBYID 形成稳定追溯键', () => {
  const row = normalizeSnapshotRow(snapshotRow(), { view: 'UDV_519', label: '公司库存', locationType: '总部' }, options)
  assert.equal(row.legacyTable, 'UDT_M_9000')
  assert.equal(row.legacyRid, '100')
  assert.equal(row.legacyObyid, '3')
  assert.equal(sourceKey(row), 'UDT_M_9000\u001f100\u001f3')
  assert.equal(row.quantity, '12.50')
  assert.equal(row.expiryDate, '2027-01-31')
  assert.deepEqual(documentIdentity(row), {
    legacyTable: 'UDT_M_9000',
    legacyRid: '100',
    legacyObyid: '3',
  })
})

test('WorkFine 批次键按供应商和来源单据隔离追溯', () => {
  const row = {
    legacyTable: 'UDT_M_9000',
    legacyRid: '100',
    legacyObyid: '3',
    supplier: '供应商甲',
  }

  const key = lotKey(row, 'WF-INIT-DOC-1')
  assert.match(key, /\|supplier:供应商甲\|source:WF-INIT-DOC-1$/)
  assert.notEqual(key, lotKey({ ...row, supplier: '供应商乙' }, 'WF-INIT-DOC-1'))
  assert.notEqual(key, lotKey(row, 'WF-INIT-DOC-2'))
})

test('WorkFine 期初导入拒绝与未追溯的旧 PG 期初库存混用', async () => {
  const client = {
    query: async (query) => {
      assert.match(String(query), /FROM inventory_stock_lots/)
      assert.match(String(query), /inventory_import_refs/)
      return { rows: [{ lot_count: '2', quantity: '15.00' }] }
    },
  }
  await assert.rejects(
    () => assertWorkfineBaselineExclusive(client, { quotedTable: 'inventory_import_refs' }),
    /旧 PG 回填与 WorkFine 期初基线不能混用/,
  )
})

test('WorkFine 期初导入允许空库存域或已完整追溯的重跑', async () => {
  const client = { query: async () => ({ rows: [{ lot_count: 0, quantity: '0' }] }) }
  await assert.doesNotReject(
    () => assertWorkfineBaselineExclusive(client, { quotedTable: 'inventory_import_refs' }),
  )
})

test('v3 初始迁移不复制旧 PG 库存，WorkFine 是唯一的期初库存基线', () => {
  const migration = readFileSync(resolve(__dirname, '../../migrations/0007_moaning_salo.sql'), 'utf8')
  assert.doesNotMatch(migration, /\bFROM\s+store_inventory_/i)
  assert.doesNotMatch(migration, /\bJOIN\s+store_inventory_/i)
})

test('v3 初始迁移只对已确认的空历史骨架执行 bridge，不改写 Drizzle journal', () => {
  const migration = readFileSync(resolve(__dirname, '../../migrations/0007_moaning_salo.sql'), 'utf8')
  const bridge = migration.split('--> statement-breakpoint\nCREATE TABLE "inventory_cutover_states"')[0]

  assert.match(bridge, /e8814b39d735d4e2a4aa7657c9d3131382525037254ad9e74bb73d862f55d81c/)
  assert.match(bridge, /_inventory_v3_legacy_locations/)
  assert.match(bridge, /legacy table % contains % rows/)
  assert.match(bridge, /external foreign-key dependents exist/)
  assert.match(bridge, /DROP TABLE public\.inventory_movements/)
  assert.doesNotMatch(bridge, /\bCASCADE\b/i)
  assert.doesNotMatch(migration, /TRUNCATE\s+drizzle\.__drizzle_migrations/i)
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+drizzle\.__drizzle_migrations/i)
})

test('期初库存缺少 OBYID 时拒绝迁移，不能退化为表名加 RID', () => {
  assert.throws(
    () => normalizeSnapshotRow(
      snapshotRow({ OBYID: '' }),
      { view: 'UDV_519', label: '公司库存', locationType: '总部' },
      options,
    ),
    /缺少 OBYID/,
  )
})

test('未知库存来源类型拒绝迁移，不能擅自归为供应链', () => {
  assert.throws(
    () => normalizeSnapshotRow(
      snapshotRow({ source_type: '外部寄售' }),
      { view: 'UDV_519', label: '公司库存', locationType: '总部' },
      options,
    ),
    /未知库存来源类型/,
  )
})

test('无效批次有效期拒绝迁移', () => {
  assert.throws(
    () => normalizeSnapshotRow(
      snapshotRow({ expiry: '2027-02-30' }),
      { view: 'UDV_519', label: '公司库存', locationType: '总部' },
      options,
    ),
    /有效期\s+不是有效日期/,
  )
})

test('源快照日期与切换日期不一致时拒绝写入', () => {
  const optionsWithSnapshotDate = {
    ...options,
    fieldMappings: {
      ...options.fieldMappings,
      UDV_519: { ...options.fieldMappings.UDV_519, snapshotDate: 'snapshot_date' },
    },
  }
  assert.throws(
    () => normalizeSnapshotRow(
      snapshotRow({ snapshot_date: '2026-08-08' }),
      { view: 'UDV_519', label: '公司库存', locationType: '总部' },
      optionsWithSnapshotDate,
    ),
    /与切换日期.*不一致/,
  )
})

test('同一来源单据固定选择最小三元键作为单据追溯引用', async () => {
  const rows = [
    { legacyTable: 'UDT_M_9000', legacyRid: '100', legacyObyid: '9', quantity: '1.00', amount: null },
    { legacyTable: 'UDT_M_9000', legacyRid: '100', legacyObyid: '2', quantity: '1.00', amount: null },
  ]
  const resolver = {
    resolve: async () => ({ locationId: 'store-1', orgNodeId: 'store-1' }),
    resolveMarketId: async () => 'market-1',
  }
  const groups = await groupRowsByDocument(rows, resolver)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].row.legacyObyid, '2')
})

test('门店快照未带市场名称时从库存主体父级反查市场', async () => {
  const client = {
    query: async (query) => {
      if (query.includes('WHERE location_type = $1 AND name = $2')) {
        return { rows: [{ location_id: 'store-1', org_node_id: 'store-org-1', parent_location_id: 'market-1' }] }
      }
      if (query.includes("WHERE location_id = $1 AND location_type = '市场'")) {
        return { rows: [{ org_node_id: 'market-1' }] }
      }
      throw new Error(`unexpected query: ${query}`)
    },
  }
  const resolver = new LocationResolver(client)
  const marketId = await resolver.resolveMarketId({
    locationType: '门店',
    locationName: '测试门店',
    marketName: null,
  })
  assert.equal(marketId, 'market-1')
})

test('模板字段必须用 owner_id 关联物理表 ID，不能退化为 template_id', () => {
  const metadata = normalizeTemplateMetadata(
    [
      { id: 101, template_id: 999, table_name: 'UDT_M_341', native_name: '产品明细' },
      { id: 999, template_id: 999, table_name: 'UDT_S_340', native_name: '产品主表' },
    ],
    [
      { owner_id: 101, column_name: 'UDF_M_1870', native_name: '产品编号' },
      { owner_id: 999, column_name: 'UDF_S_9392', native_name: '供应商' },
    ],
  )

  const detail = getMetadataTable(metadata, 'UDT_M_341')
  const header = getMetadataTable(metadata, 'UDT_S_340')
  assert.deepEqual(detail.fields.map((field) => field.columnName), ['UDF_M_1870'])
  assert.deepEqual(header.fields.map((field) => field.columnName), ['UDF_S_9392'])
  assert.doesNotThrow(() => assertMetadataField(metadata, 'UDT_M_341', 'UDF_M_1870'))
  assert.throws(() => assertMetadataField(metadata, 'UDT_M_341', 'UDF_S_9392'), /不存在/)
  assert.doesNotThrow(() => assertConfiguredPhysicalFieldMappings(
    metadata,
    'UDT_M_341',
    'UDV_519',
    { UDV_519: { productCode: 'UDF_M_1870', legacyRid: 'RID' } },
  ))
  assert.throws(
    () => assertConfiguredPhysicalFieldMappings(
      metadata,
      'UDT_M_341',
      'UDV_519',
      { UDV_519: { productCode: 'UDF_M_9999' } },
    ),
    /未归属/,
  )
  assert.throws(
    () => normalizeTemplateMetadata(
      [{ id: 101, table_name: 'UDT_M_341' }],
      [{ template_id: 101, column_name: 'UDF_M_1870' }],
    ),
    /缺少 owner_id/,
  )
})

test('重复来源键但库存内容冲突时拒绝迁移', () => {
  const definition = { view: 'UDV_519', label: '公司库存', locationType: '总部' }
  const first = normalizeSnapshotRow(snapshotRow(), definition, options)
  const conflicting = normalizeSnapshotRow(snapshotRow({ qty: '11.00' }), definition, options)
  assert.throws(() => deduplicateSnapshotRows([first, conflicting]), /冲突重复行/)
})

test('重复来源键但价格快照冲突时同样拒绝迁移', () => {
  const definition = { view: 'UDV_519', label: '公司库存', locationType: '总部' }
  const first = normalizeSnapshotRow(snapshotRow(), definition, options)
  const conflicting = normalizeSnapshotRow(snapshotRow(), definition, options)
  first.marketActualUnitPrice = '18.00'
  conflicting.marketActualUnitPrice = '19.00'
  assert.throws(() => deduplicateSnapshotRows([first, conflicting]), /冲突重复行/)
})

test('批次价格只补空值，不覆盖库存视图已给出的实际单价', () => {
  const definition = { view: 'UDV_519', label: '公司库存', locationType: '总部' }
  const row = normalizeSnapshotRow(snapshotRow(), definition, options)
  row.storeActualUnitPrice = '20.00'
  const filled = applyPriceRows([row], [{
    productCode: 'SKU-001',
    locationName: '总部',
    marketName: null,
    storeName: null,
    batchNo: 'B-1',
    expiryDate: '2027-01-31',
    isGift: false,
    values: { supplyChainUnitCost: '8.00', storeActualUnitPrice: '18.00' },
  }])
  assert.equal(filled, 1)
  assert.equal(row.supplyChainUnitCost, '8.00')
  assert.equal(row.storeActualUnitPrice, '20.00')
})

test('批次价格存在冲突候选且库存行缺价时拒绝猜测', () => {
  const definition = { view: 'UDV_519', label: '公司库存', locationType: '总部' }
  const row = normalizeSnapshotRow(snapshotRow(), definition, options)
  assert.throws(
    () => applyPriceRows([row], [
      {
        productCode: 'SKU-001', locationName: '总部', marketName: null, storeName: null,
        batchNo: 'B-1', expiryDate: '2027-01-31', isGift: false,
        values: { supplyChainUnitCost: '8.00' },
      },
      {
        productCode: 'SKU-001', locationName: '总部', marketName: null, storeName: null,
        batchNo: 'B-1', expiryDate: '2027-01-31', isGift: false,
        values: { supplyChainUnitCost: '9.00' },
      },
    ]),
    /匹配不唯一/,
  )
})

test('迁移模式互斥，避免误把验证跑成写入', () => {
  assert.throws(() => parseImportArgs(['--apply', '--verify']), /只能选择一个/)
  assert.throws(() => parseImportArgs(['--reset']), /已废弃/)
  assert.equal(parseImportArgs(['--dry-run']).dryRun, true)
  assert.equal(parseImportArgs(['--export-pending', '/tmp/rebuild.json']).exportPending, '/tmp/rebuild.json')
})

test('WorkFine 库存切换状态禁止已初始化后重写期初流水', () => {
  assert.equal(
    assertWorkfineInventoryCutoverCanApply({ status: WORKFINE_INVENTORY_CUTOVER_STATUSES.PENDING_INITIALIZATION }),
    '待初始化',
  )
  assert.throws(
    () => assertWorkfineInventoryCutoverCanApply({ status: WORKFINE_INVENTORY_CUTOVER_STATUSES.INITIALIZED }),
    /已初始化.*不可重写/,
  )
  assert.throws(
    () => assertWorkfineInventoryCutoverCanVerify({ status: WORKFINE_INVENTORY_CUTOVER_STATUSES.PENDING_INITIALIZATION }),
    /尚未导入/,
  )
  assert.doesNotThrow(() => assertWorkfineInventoryCutoverCanVerify(
    { status: WORKFINE_INVENTORY_CUTOVER_STATUSES.PENDING_VERIFICATION },
  ))
})

test('已初始化的 apply 会回滚且不改写切换状态', async () => {
  const blocked = createCutoverPgPool({ status: '已初始化' })
  await assert.rejects(
    () => importRows(blocked.pgPool, [], { WORKFINE_INVENTORY_IMPORTER_EMPLOYEE_ID: 'employee-1' }),
    /已初始化.*不可重写/,
  )
  assert.ok(queryIndex(blocked.queries, 'ROLLBACK') >= 0)
  assert.equal(queryIndex(blocked.queries, 'UPDATE inventory_cutover_states'), -1)
  assert.equal(blocked.client.released, true)

})

test('verify 仅在所有核验通过后于同一事务标记已初始化', async () => {
  const passing = createCutoverPgPool({ status: '待核验' })
  const passed = await verifyRows(passing.pgPool, [])
  assert.deepEqual(passed.failures, [])
  const lock = passing.queries.find(({ sql }) => sql.includes('SELECT cutover_key, status'))
  assert.match(lock.sql, /FOR UPDATE/)
  const update = passing.queries.find(({ sql }) => sql.includes('UPDATE inventory_cutover_states'))
  assert.deepEqual(update.values, [WORKFINE_INVENTORY_CUTOVER_KEY, '已初始化'])
  assert.match(update.sql, /verified_at = NOW\(\)/)
  assert.ok(queryIndex(passing.queries, 'BEGIN') < queryIndex(passing.queries, 'UPDATE inventory_cutover_states'))
  assert.ok(queryIndex(passing.queries, 'UPDATE inventory_cutover_states') < queryIndex(passing.queries, 'COMMIT'))
  assert.equal(queryIndex(passing.queries, 'ROLLBACK'), -1)

  const failing = createCutoverPgPool({ status: '待核验', badMovementCount: 1 })
  const failed = await verifyRows(failing.pgPool, [])
  assert.match(failed.failures[0], /非期初入库形态/)
  assert.equal(queryIndex(failing.queries, 'UPDATE inventory_cutover_states'), -1)
  assert.ok(queryIndex(failing.queries, 'ROLLBACK') >= 0)
  assert.equal(queryIndex(failing.queries, 'COMMIT'), -1)
})

test('无状态规则的在办来源拒绝导出，防止把历史完成单混入重建清单', () => {
  assert.throws(
    () => resolveRule({ code: 'S494' }, {}),
    /未配置 completionField/,
  )
})

test('在办规则必须显式列出待办和完成状态，未知状态不能默认导出', () => {
  assert.throws(
    () => resolveRule({ code: 'S999' }, {
      S999: { completionField: 'UDF_S_1', completedValues: ['已完成'] },
    }),
    /pendingValues/,
  )
  const s336Rule = resolveRule(PENDING_SOURCES[0], {})
  assert.deepEqual(s336Rule.pendingValues, ['否'])
  assert.deepEqual(s336Rule.completedValues, ['是'])
})

test('切换基线数量可逐来源和异常类型核验', () => {
  const pending = [
    { sourceCode: 'S336' },
    { sourceCode: 'S336' },
    { sourceCode: 'S494' },
  ]
  assert.deepEqual(
    expectedCountFailures(pending, [{ sourceCode: 'UNCLAIMED' }], [{ anomaly: 'x' }], {
      S336: 2,
      S494: 1,
      UNCLAIMED: 1,
      MARKET_TRANSFER_ANOMALIES: 1,
    }),
    [],
  )
  assert.match(
    expectedCountFailures(pending, [], [], { S336: 3 })[0],
    /S336 数量不一致/,
  )
  assert.ok(expectedCountCoverageFailures({ S336: 2 }).some((failure) => failure.includes('S548')))
})

test('市场调货出库无对应入库时单列为人工重建异常', () => {
  const records = [
    { sourceCode: 'S580', legacyDocNo: 'MT-001', category: '在办库存业务' },
    { sourceCode: 'S580', legacyDocNo: 'MT-002', category: '在办库存业务' },
    { sourceCode: 'S582', legacyDocNo: 'MT-002', category: '在办库存业务' },
  ]
  const anomalies = marketTransferAnomalies(records)
  assert.equal(anomalies.length, 1)
  assert.equal(anomalies[0].legacyDocNo, 'MT-001')
  assert.equal(anomalies[0].anomaly, 'market_transfer_counterpart_inbound_deleted')
})

test('市场调货对方入库核对缺少单据号时停止，不能静默漏掉异常', () => {
  assert.throws(
    () => normalizeMarketTransferRecord({ RID: 123 }, { code: 'S580', table: 'UDT_S_580' }, {}),
    /缺少单据号/,
  )
})
