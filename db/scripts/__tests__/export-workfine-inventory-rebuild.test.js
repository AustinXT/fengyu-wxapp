'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeTemplateMetadata } = require('../workfine-inventory-common')
const {
  PENDING_SOURCES,
  assertDetailMappingMetadata,
  attachPendingDetails,
  normalizePendingDetailRow,
  pendingDetailFailures,
  resolveDetailMapping,
} = require('../export-workfine-inventory-rebuild')

function source(code) {
  const result = PENDING_SOURCES.find((item) => item.code === code)
  if (!result) throw new Error(`missing source ${code}`)
  return result
}

function metadataFor(tables) {
  const templateTables = []
  const templateFields = []
  let id = 1
  for (const [tableName, fields] of Object.entries(tables)) {
    templateTables.push({ id, table_name: tableName, native_name: tableName })
    for (const field of fields) {
      templateFields.push({ owner_id: id, column_name: field, native_name: field })
    }
    id += 1
  }
  return normalizeTemplateMetadata(templateTables, templateFields)
}

function mssqlPool(tables) {
  return {
    request() {
      const inputs = {}
      return {
        input(name, _type, value) {
          inputs[name] = value
          return this
        },
        async query(sql) {
          if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
            return { recordset: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: inputs.object_name }] }
          }
          const match = sql.match(/FROM \[dbo\]\.\[([^\]]+)\]/)
          if (!match) throw new Error(`unexpected SQL: ${sql}`)
          return { recordset: tables[match[1]] || [] }
        },
      }
    },
  }
}

const m549Metadata = metadataFor({
  UDT_M_549: [
    'UDF_M_1888', 'UDF_M_1889', 'UDF_M_1890', 'UDF_M_1891', 'UDF_M_1892',
    'UDF_M_3912', 'UDF_M_3878', 'UDF_M_4274', 'UDF_M_3911', 'UDF_M_5523',
  ],
})

const m342Metadata = metadataFor({
  UDT_M_342: ['UDF_M_1888', 'UDF_M_1889', 'UDF_M_1890', 'UDF_M_1891', 'UDF_M_1892', 'UDF_M_1893'],
})

test('S336/M342 已确认没有批次、效期、赠送和单价时只输出 null', () => {
  const detailMapping = resolveDetailMapping(source('S336'))
  assert.doesNotThrow(() => assertDetailMappingMetadata(m342Metadata, source('S336'), detailMapping))
  const detail = normalizePendingDetailRow({
    RID: 336,
    OBYID: 1,
    UDF_M_1888: 'SKU-336',
    UDF_M_1893: '5.00',
  }, source('S336'), detailMapping)
  assert.deepEqual(detailMapping.confirmedAbsent, ['batchNo', 'expiryDate', 'isGift', 'unitPrice'])
  assert.equal(detail.batchNo, null)
  assert.equal(detail.expiryDate, null)
  assert.equal(detail.isGift, null)
  assert.equal(detail.unitPrice, null)
})

test('已核验的 S548/M549 明细保留批次、效期、赠送和来源三元键', () => {
  const detailMapping = resolveDetailMapping(source('S548'))
  assert.doesNotThrow(() => assertDetailMappingMetadata(m549Metadata, source('S548'), detailMapping))

  const detail = normalizePendingDetailRow({
    RID: 800,
    OBYID: 12,
    UDF_M_1888: 'SKU-001',
    UDF_M_1889: '测试产品',
    UDF_M_1890: '30ml',
    UDF_M_3912: '3.00',
    UDF_M_3878: 'BATCH-01',
    UDF_M_4274: new Date('2027-01-31T00:00:00.000Z'),
    UDF_M_3911: '否',
    UDF_M_5523: '9.00',
  }, source('S548'), detailMapping)

  assert.deepEqual(
    {
      sourceTable: detail.sourceTable,
      legacyRid: detail.legacyRid,
      legacyObyid: detail.legacyObyid,
      sku: detail.sku,
      quantity: detail.quantity,
      batchNo: detail.batchNo,
      expiryDate: detail.expiryDate,
      isGift: detail.isGift,
      unitPrice: detail.unitPrice,
      stockOnHand: detail.stockOnHand,
    },
    {
      sourceTable: 'UDT_M_549',
      legacyRid: '800',
      legacyObyid: '12',
      sku: 'SKU-001',
      quantity: '3.00',
      batchNo: 'BATCH-01',
      expiryDate: '2027-01-31',
      isGift: '否',
      unitPrice: null,
      stockOnHand: '9.00',
    },
  )
  assert.deepEqual(detailMapping.confirmedAbsent, ['unitPrice'])
})

test('未知来源必须显式配置明细表和全部必需字段或经确认的缺失字段', () => {
  assert.throws(
    () => resolveDetailMapping({ code: 'S494' }, {}, { required: true }),
    /未配置 WORKFINE_INVENTORY_PENDING_DETAIL_MAP.S494/,
  )
  assert.throws(
    () => resolveDetailMapping({ code: 'S494' }, {
      S494: {
        table: 'UDT_M_994',
        sku: 'UDF_M_9001',
        quantity: 'UDF_M_9002',
      },
    }),
    /批号 映射/,
  )
})

test('明细映射必须归属其 UDT_M 的 owner_id，不能借用其他表字段', () => {
  const mapping = resolveDetailMapping({ code: 'S494' }, {
    S494: {
      table: 'UDT_M_994',
      sku: 'UDF_M_9001',
      quantity: 'UDF_M_9002',
      batchNo: 'UDF_M_9003',
      expiryDate: 'UDF_M_9004',
      isGift: 'UDF_M_9005',
      unitPrice: 'UDF_M_9006',
    },
  })
  const metadata = metadataFor({
    UDT_M_342: ['UDF_M_9001'],
    UDT_M_994: ['UDF_M_9002', 'UDF_M_9003', 'UDF_M_9004', 'UDF_M_9005', 'UDF_M_9006'],
  })
  assert.throws(
    () => assertDetailMappingMetadata(metadata, { code: 'S494' }, mapping),
    /UDT_M_994 的模板字段中不存在 S494 明细SKU UDF_M_9001/,
  )
})

test('明细按主表 RID 关联并按 OBYID 稳定排序，缺失明细时拒绝输出', async () => {
  const records = [{ sourceCode: 'S548', legacyRid: '800', legacyDocNo: 'DB-1' }]
  const pool = mssqlPool({
    UDT_M_549: [
      {
        RID: 800, OBYID: 12, UDF_M_1888: 'SKU-012', UDF_M_3912: '1.00',
        UDF_M_3878: 'B-12', UDF_M_4274: '2027-12-31', UDF_M_3911: '是', UDF_M_5523: '1.00',
      },
      {
        RID: 800, OBYID: 2, UDF_M_1888: 'SKU-002', UDF_M_3912: '2.00',
        UDF_M_3878: 'B-02', UDF_M_4274: '2027-02-28', UDF_M_3911: '否', UDF_M_5523: '2.00',
      },
      {
        RID: 801, OBYID: 1, UDF_M_1888: 'SKU-UNRELATED', UDF_M_3912: '1.00',
        UDF_M_3878: 'B-X', UDF_M_4274: '2027-01-01', UDF_M_3911: '否', UDF_M_5523: '1.00',
      },
    ],
  })
  const attached = await attachPendingDetails(pool, source('S548'), records, {}, m549Metadata)
  assert.equal(attached[0].detailCount, 2)
  assert.deepEqual(attached[0].details.map((detail) => detail.legacyObyid), ['2', '12'])
  assert.deepEqual(pendingDetailFailures(attached), [])

  await assert.rejects(
    () => attachPendingDetails(mssqlPool({ UDT_M_549: [] }), source('S548'), records, {}, m549Metadata),
    /未找到 UDT_M_549 已核验明细/,
  )
})

test('明细 RID/OBYID、SKU 或数量缺失时拒绝生成不可追溯行', () => {
  const detailMapping = resolveDetailMapping(source('S548'))
  assert.throws(
    () => normalizePendingDetailRow({ RID: 800, UDF_M_1888: 'SKU-001', UDF_M_3912: '1.00' }, source('S548'), detailMapping),
    /缺少 RID 或 OBYID/,
  )
  assert.throws(
    () => normalizePendingDetailRow({ RID: 800, OBYID: 1, UDF_M_3912: '1.00' }, source('S548'), detailMapping),
    /缺少 SKU 或数量/,
  )
})
