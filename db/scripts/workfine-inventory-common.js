#!/usr/bin/env node
'use strict'

/**
 * WorkFine 进销存一次性迁移脚本的共用只读/规范化工具。
 * 不在这里保存连接凭据；所有连接信息均由环境变量传入。
 */

const crypto = require('node:crypto')

const STOCK_VIEW_DEFINITIONS = [
  { view: 'UDV_519', label: '公司库存', locationType: '总部' },
  { view: 'UDV_538', label: '市场库存', locationType: '市场' },
  { view: 'UDV_607', label: '分院库存', locationType: '门店' },
]

const PRICE_VIEW_DEFINITIONS = [
  { view: 'UDV_1189', label: '批次价格补充一' },
  { view: 'UDV_2014', label: '批次价格补充二' },
]

/**
 * WorkFine 的模板显示名会被复用，不能用它推断业务含义。迁移只把模板
 * 元数据作为「物理表 -> 字段」的事实来源：field.owner_id 必须关联到
 * template_table.id，而不是 template_id。
 */
const TEMPLATE_METADATA_TABLES = {
  table: 'tb_sys_template_table',
  field: 'tb_sys_template_field',
}

const PHYSICAL_TABLE_PATTERN = /^UDT_[SM]_\d+$/i
const SYSTEM_IDENTITY_COLUMNS = new Set(['RID', 'OBYID'])

const IMPORT_REF_TABLE_CANDIDATES = [
  'inventory_import_refs',
  'inventory_import_references',
  'workfine_inventory_import_refs',
]

const WORKFINE_INVENTORY_CUTOVER_KEY = 'workfine_inventory'
const WORKFINE_INVENTORY_CUTOVER_STATUSES = Object.freeze({
  PENDING_INITIALIZATION: '待初始化',
  PENDING_VERIFICATION: '待核验',
  INITIALIZED: '已初始化',
})

const FIELD_CANDIDATES = {
  legacyTable: [
    'legacy_table',
    'source_table',
    'physical_table',
    'table_name',
    'source_table_name',
  ],
  legacyRid: ['legacy_rid', 'source_rid', 'rid', 'record_id'],
  legacyObyid: ['legacy_obyid', 'source_obyid', 'obyid', 'line_id', 'row_id'],
  legacyDocNo: [
    'legacy_doc_no',
    'doc_no',
    'document_no',
    'order_no',
    'udf_s_1881',
    'udf_v_1881',
  ],
  locationName: ['location_name', 'warehouse_name', 'stock_location', 'location'],
  marketName: ['market_name', 'market', 'udf_s_1882', 'udf_v_1882'],
  storeName: [
    'store_name',
    'branch_name',
    'hospital_name',
    'udf_s_4473',
    'udf_s_1883',
    'udf_v_4473',
    'udf_v_1883',
  ],
  productCode: [
    'product_code',
    'sku_code',
    'item_code',
    'product_no',
    'udf_m_1888',
    'udf_m_1870',
    'udf_v_1888',
    'udf_v_1870',
  ],
  productName: [
    'product_name',
    'sku_name',
    'item_name',
    'name',
    'udf_m_1889',
    'udf_m_1871',
    'udf_v_1889',
    'udf_v_1871',
  ],
  specName: ['spec_name', 'spec', 'specification', 'udf_m_1890', 'udf_m_1872', 'udf_v_1890'],
  supplier: ['supplier', 'supplier_name', 'vendor', 'udf_m_1873', 'udf_v_1873'],
  manufacturer: ['manufacturer', 'factory', 'manufacturer_name', 'udf_m_1891', 'udf_v_1891'],
  brand: ['brand', 'brand_name', 'udf_m_12636', 'udf_v_12636'],
  productSeries: [
    'product_series',
    'series_name',
    'series',
    'udf_m_1892',
    'udf_m_1874',
    'udf_v_1892',
  ],
  purchaseCategory: ['purchase_category', 'procurement_category', 'category'],
  sourceType: ['source_type', 'stock_source_type'],
  isReportable: ['is_reportable', 'reportable', 'udf_m_7494', 'udf_v_7494'],
  isActive: ['is_active', 'active', 'enabled'],
  batchNo: ['batch_no', 'batch', 'lot_no', 'udf_m_3878', 'udf_m_5172', 'udf_v_3878'],
  expiryDate: ['expiry_date', 'expire_date', 'valid_until', 'udf_m_4274', 'udf_m_5179', 'udf_v_4274'],
  isGift: ['is_gift', 'gift', 'udf_m_3911', 'udf_m_5689', 'udf_v_3911'],
  quantity: [
    'quantity_on_hand',
    'stock_quantity',
    'available_quantity',
    'quantity',
    'qty',
    'udf_m_5522',
    'udf_m_5521',
    'udf_m_5173',
    'udf_m_5523',
    'udf_v_5522',
    'udf_v_5521',
    'udf_v_5173',
    'udf_v_5523',
  ],
  retailPrice: ['retail_price', 'price', 'udf_m_1875', 'udf_v_1875'],
  accountingPrice: ['accounting_price', 'account_price', 'udf_m_1876', 'udf_v_1876'],
  supplyChainPurchasePrice: [
    'supply_chain_purchase_price',
    'company_purchase_price',
    'udf_m_7541',
    'udf_v_7541',
  ],
  marketPurchasePrice: ['market_purchase_price', 'udf_m_1880', 'udf_v_1880'],
  storePurchasePrice: ['store_purchase_price', 'branch_purchase_price', 'udf_m_1878', 'udf_v_1878'],
  marketStaffPurchasePrice: ['market_staff_purchase_price', 'staff_purchase_price', 'udf_m_4795', 'udf_v_4795'],
  marketPurchaseDiscount: ['market_purchase_discount', 'udf_m_1879', 'udf_v_1879'],
  storePurchaseDiscount: ['store_purchase_discount', 'udf_m_1877', 'udf_v_1877'],
  staffPurchaseDiscount: ['staff_purchase_discount'],
  itemCompanyPurchasePrice: ['item_company_purchase_price', 'company_purchase_price', 'udf_m_7541', 'udf_v_7541'],
  supplyChainUnitCost: ['supply_chain_unit_cost', 'unit_cost', 'company_unit_cost'],
  marketStandardUnitPrice: ['market_standard_unit_price', 'market_base_price', 'market_unit_price'],
  marketUnitDiscount: ['market_unit_discount', 'market_discount'],
  marketActualUnitPrice: ['market_actual_unit_price', 'market_actual_price'],
  storeStandardUnitPrice: ['store_standard_unit_price', 'store_base_price', 'store_unit_price'],
  storeUnitDiscount: ['store_unit_discount', 'store_discount'],
  storeActualUnitPrice: ['store_actual_unit_price', 'store_actual_price', 'unit_price', 'udf_m_6230', 'udf_v_6230'],
  amount: ['amount', 'total_amount', 'stock_amount', 'udf_m_6231', 'udf_m_19761', 'udf_v_6231'],
  remark: ['remark', 'note', 'memo', 'description', 'udf_m_5357', 'udf_m_6198', 'udf_v_5357'],
}

function text(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function parseJsonObject(value, variableName) {
  if (!text(value)) return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw new Error(`${variableName} 必须是 JSON 对象：${error.message}`)
  }
}

function parseViewName(value) {
  const raw = text(value)
  if (!raw) throw new Error('缺少 WorkFine 视图名')
  const parts = raw.split('.')
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`非法 WorkFine 对象名：${raw}`)
  }
  if (parts.length === 1) return { schema: 'dbo', name: parts[0] }
  return { schema: parts[0], name: parts[1] }
}

function quoteSqlServerObject(value) {
  const { schema, name } = parseViewName(value)
  return `[${schema}].[${name}]`
}

function quotePgIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`非法 PostgreSQL 标识符：${value}`)
  }
  return `"${value}"`
}

function hashId(prefix, ...parts) {
  const body = parts.map((part) => String(part ?? '')).join('\u001f')
  return `${prefix}-${crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)}`
}

function normalizeBoolean(value, fallback = false) {
  const normalized = text(value)
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'y', '是', '已启用', '启用'].includes(normalized.toLowerCase())
}

function normalizeDate(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`缺少${label}`)
    return null
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    const formatted = `${y}-${m}-${d}`
    return formatted === '1900-01-01' ? null : formatted
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) throw new Error(`${label} 不是有效日期`)
  const formatted = `${match[1]}-${match[2]}-${match[3]}`
  if (!isValidIsoDate(formatted)) throw new Error(`${label} 不是有效日期`)
  return formatted === '1900-01-01' ? null : formatted
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function normalizeNumeric(value, label, { required = false, positive = false, scale = 2 } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`缺少${label}`)
    return null
  }
  const parsed = Number(String(value).replace(/,/g, ''))
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是有效数字`)
  if (positive ? parsed <= 0 : parsed < 0) {
    throw new Error(`${label}${positive ? '必须大于 0' : '不能小于 0'}`)
  }
  const factor = 10 ** scale
  const rounded = Math.round(parsed * factor) / factor
  if (Math.abs(parsed - rounded) > 1e-8) throw new Error(`${label} 小数位超过 ${scale} 位`)
  return rounded.toFixed(scale)
}

function canonicalNumber(value) {
  return value === null || value === undefined ? '' : String(value)
}

function normalizeSourceType(value) {
  const normalized = text(value)
  if (!normalized) return '供应链'
  if (normalized === '市场自采' || normalized === '转让店' || normalized === '供应链') return normalized
  throw new Error(`未知库存来源类型：${normalized}`)
}

function fieldMappingFor(viewName, mappings) {
  const lower = viewName.toLowerCase()
  return mappings[viewName] || mappings[lower] || mappings['*'] || {}
}

function findColumnValue(row, candidates) {
  if (!row || typeof row !== 'object') return null
  const entries = Object.entries(row)
  const lower = new Map(entries.map(([key, value]) => [key.toLowerCase(), value]))
  for (const candidate of candidates) {
    const key = String(candidate)
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined && row[key] !== '') {
      return row[key]
    }
    const value = lower.get(key.toLowerCase())
    if (value !== null && value !== undefined && value !== '') return value
  }
  return null
}

function normalizePhysicalTableName(value) {
  const raw = text(value)
  if (!raw) return null
  const match = raw.match(/^(?:dbo\.)?(UDT_[SM]_\d+)$/i)
  if (!match) return null
  return match[1].toUpperCase()
}

function physicalTableNameFromMetadataRow(row) {
  const preferred = findColumnValue(row, [
    'table_name',
    'physical_table_name',
    'physical_table',
    'table_code',
    'table',
  ])
  const candidates = [preferred, ...Object.values(row)]
  const physicalTables = new Set(
    candidates
      .flatMap((value) => {
        const normalized = text(value)
        if (!normalized) return []
        const exact = normalizePhysicalTableName(normalized)
        if (exact) return [exact]
        return [...normalized.matchAll(/\b(UDT_[SM]_\d+)\b/gi)].map((match) => match[1].toUpperCase())
      }),
  )
  if (physicalTables.size > 1) {
    throw new Error(`tb_sys_template_table 一条记录对应多个物理表：${[...physicalTables].join(', ')}`)
  }
  return [...physicalTables][0] || null
}

/**
 * 将 WorkFine 模板元数据归一为物理表和字段的关系。
 *
 * `tb_sys_template_field.owner_id` 关联 `tb_sys_template_table.id`，而非模板
 * ID。这里刻意不接受 template_id 作为字段归属回退，防止模板复用造成错配。
 */
function normalizeTemplateMetadata(templateTableRows, templateFieldRows) {
  const tables = []
  const tablesById = new Map()
  const tablesByName = new Map()

  for (const row of templateTableRows) {
    const physicalTable = physicalTableNameFromMetadataRow(row)
    if (!physicalTable) continue
    const id = text(findColumnValue(row, ['id', 'table_id', 'rid']))
    if (!id) {
      throw new Error(`tb_sys_template_table 中 ${physicalTable} 缺少物理表 ID`)
    }
    const existingById = tablesById.get(id)
    if (existingById && existingById.physicalTable !== physicalTable) {
      throw new Error(`tb_sys_template_table 物理表 ID ${id} 同时指向 ${existingById.physicalTable} 和 ${physicalTable}`)
    }
    const existingByName = tablesByName.get(physicalTable)
    if (existingByName && existingByName.id !== id) {
      throw new Error(`tb_sys_template_table 物理表 ${physicalTable} 存在多个 ID：${existingByName.id}、${id}`)
    }
    if (existingById || existingByName) continue

    const table = {
      id,
      physicalTable,
      nativeName: text(findColumnValue(row, ['native_name', 'display_name', 'name', 'title'])),
      templateId: text(findColumnValue(row, ['template_id', 'templateid'])),
      fields: [],
      fieldNames: new Set(),
    }
    tables.push(table)
    tablesById.set(id, table)
    tablesByName.set(physicalTable, table)
  }

  if (tables.length === 0) {
    throw new Error('tb_sys_template_table 未解析到任何 UDT_S_/UDT_M_ 物理表记录')
  }

  const orphanFields = []
  let hasOwnerId = false
  for (const row of templateFieldRows) {
    const ownerId = text(findColumnValue(row, ['owner_id', 'ownerid']))
    if (ownerId) hasOwnerId = true
    const columnName = text(findColumnValue(row, ['column_name', 'columnname', 'physical_column_name']))
    if (!ownerId || !columnName) continue
    const ownerTable = tablesById.get(ownerId)
    if (!ownerTable) {
      orphanFields.push({ ownerId, columnName })
      continue
    }
    const normalizedColumnName = columnName.toUpperCase()
    if (ownerTable.fieldNames.has(normalizedColumnName)) continue
    ownerTable.fieldNames.add(normalizedColumnName)
    ownerTable.fields.push({
      columnName,
      nativeName: text(findColumnValue(row, ['native_name', 'display_name', 'name', 'title'])),
    })
  }

  if (templateFieldRows.length > 0 && !hasOwnerId) {
    throw new Error('tb_sys_template_field 缺少 owner_id，不能以模板 ID 替代物理表归属')
  }

  return { tables, tablesById, tablesByName, orphanFields }
}

function getMetadataTable(metadata, physicalTable) {
  const normalized = normalizePhysicalTableName(physicalTable)
  if (!normalized) throw new Error(`不是合法 WorkFine 物理库存表：${physicalTable}`)
  const table = metadata.tablesByName.get(normalized)
  if (!table) {
    throw new Error(`tb_sys_template_table 未登记物理表：${normalized}`)
  }
  if (table.fields.length === 0) {
    throw new Error(`tb_sys_template_field 未解析到 ${normalized} 的字段；请确认 owner_id 指向物理表 ID`)
  }
  return table
}

function assertMetadataField(metadata, physicalTable, columnName, label = '字段') {
  const normalizedColumnName = text(columnName)
  if (!normalizedColumnName) throw new Error(`缺少需要核验的${label}`)
  if (SYSTEM_IDENTITY_COLUMNS.has(normalizedColumnName.toUpperCase())) return
  const table = getMetadataTable(metadata, physicalTable)
  if (!table.fieldNames.has(normalizedColumnName.toUpperCase())) {
    throw new Error(`${physicalTable} 的模板字段中不存在 ${label} ${normalizedColumnName}`)
  }
}

/**
 * UDV 列可能是 UDF_V_* 别名，不能强行要求它出现在物理表字段中；但配置
 * 直接指向 UDF_S_* / UDF_M_* 时，必须能在 owner_id 归属的物理表中找到。
 */
function assertConfiguredPhysicalFieldMappings(metadata, physicalTable, viewName, mappings) {
  const mapping = fieldMappingFor(viewName, mappings)
  const table = getMetadataTable(metadata, physicalTable)
  for (const [semanticName, configured] of Object.entries(mapping)) {
    const configuredValues = (Array.isArray(configured) ? configured : [configured])
      .map((value) => text(value))
      .filter(Boolean)
    const physicalFieldCandidates = configuredValues.filter((value) => /^UDF_[SM]_\d+$/i.test(value))
    if (physicalFieldCandidates.length === 0) continue
    const matched = physicalFieldCandidates.some((value) => table.fieldNames.has(value.toUpperCase()))
    if (!matched) {
      throw new Error(`${viewName}.${semanticName} 配置的物理字段未归属到 ${physicalTable}：${physicalFieldCandidates.join(', ')}`)
    }
  }
}

function templateMetadataReport(metadata, physicalTables = []) {
  const requested = physicalTables.length > 0
    ? physicalTables.map((table) => normalizePhysicalTableName(table)).filter(Boolean)
    : metadata.tables.map((table) => table.physicalTable)
  return [...new Set(requested)].map((physicalTable) => {
    const table = getMetadataTable(metadata, physicalTable)
    return {
      physicalTable: table.physicalTable,
      physicalTableId: table.id,
      templateId: table.templateId,
      nativeName: table.nativeName,
      fields: table.fields.map((field) => ({ ...field })),
    }
  })
}

function readField(row, viewName, fieldName, mappings) {
  const configured = fieldMappingFor(viewName, mappings)[fieldName]
  const configuredCandidates = Array.isArray(configured) ? configured : configured ? [configured] : []
  return findColumnValue(row, [...configuredCandidates, ...(FIELD_CANDIDATES[fieldName] || [])])
}

function sourceTableFor(row, definition, mappings, legacyTableMap) {
  const configured = legacyTableMap[definition.view] || legacyTableMap[definition.view.toLowerCase()]
  const candidate = text(configured) || text(readField(row, definition.view, 'legacyTable', mappings))
  if (!candidate) {
    throw new Error(`${definition.view} 缺少物理表名；请设置 WORKFINE_INVENTORY_LEGACY_TABLE_MAP 或字段映射 legacyTable`)
  }
  const physicalTable = normalizePhysicalTableName(candidate)
  if (!physicalTable || !PHYSICAL_TABLE_PATTERN.test(physicalTable)) {
    throw new Error(`物理表名必须是 UDT_S_xxx 或 UDT_M_xxx：${candidate}`)
  }
  return physicalTable
}

function sourceIdentity(row, definition, mappings, legacyTableMap) {
  const legacyTable = sourceTableFor(row, definition, mappings, legacyTableMap)
  const legacyRid = text(readField(row, definition.view, 'legacyRid', mappings))
  const legacyObyid = text(readField(row, definition.view, 'legacyObyid', mappings))
  if (!legacyRid) throw new Error(`${definition.view} 缺少 RID`)
  if (!legacyObyid) {
    throw new Error(`${definition.view} 缺少 OBYID；期初库存幂等键必须为物理表名 + RID + OBYID`)
  }
  return { legacyTable, legacyRid, legacyObyid }
}

function locationFor(row, definition, mappings) {
  const locationName = text(readField(row, definition.view, 'locationName', mappings))
  const marketName = text(readField(row, definition.view, 'marketName', mappings))
  const storeName = text(readField(row, definition.view, 'storeName', mappings))
  let name
  if (definition.locationType === '总部') name = locationName || '总部'
  if (definition.locationType === '市场') name = locationName || marketName
  if (definition.locationType === '门店') name = locationName || storeName
  if (!name) throw new Error(`${definition.view} 缺少${definition.locationType}名称`)
  return { locationType: definition.locationType, locationName: name, marketName, storeName }
}

function normalizeSnapshotRow(row, definition, options) {
  const identity = sourceIdentity(row, definition, options.fieldMappings, options.legacyTableMap)
  const location = locationFor(row, definition, options.fieldMappings)
  const productCode = text(readField(row, definition.view, 'productCode', options.fieldMappings))
  const productName = text(readField(row, definition.view, 'productName', options.fieldMappings))
  if (!productCode) throw new Error(`${definition.view} 缺少产品编号`)
  if (!productName) throw new Error(`${definition.view} 缺少产品名称`)
  const quantity = normalizeNumeric(readField(row, definition.view, 'quantity', options.fieldMappings), '期初库存数量', {
    required: true,
    positive: true,
  })
  const rawDocNo = text(readField(row, definition.view, 'legacyDocNo', options.fieldMappings))
  const rowDate = readField(row, definition.view, 'snapshotDate', options.fieldMappings)
  const sourceSnapshotDate = normalizeDate(rowDate, '期初日期')
  if (options.asOfDate && sourceSnapshotDate && sourceSnapshotDate !== options.asOfDate) {
    throw new Error(`${definition.view} 期初日期 ${sourceSnapshotDate} 与切换日期 ${options.asOfDate} 不一致`)
  }
  const snapshotDate = sourceSnapshotDate || normalizeDate(options.asOfDate, '期初日期', { required: Boolean(options.asOfDate) })

  return {
    ...identity,
    ...location,
    viewName: definition.view,
    viewLabel: definition.label,
    legacyDocNo: rawDocNo,
    snapshotDate,
    productCode,
    productName,
    specName: text(readField(row, definition.view, 'specName', options.fieldMappings)),
    supplier: text(readField(row, definition.view, 'supplier', options.fieldMappings)),
    manufacturer: text(readField(row, definition.view, 'manufacturer', options.fieldMappings)),
    brand: text(readField(row, definition.view, 'brand', options.fieldMappings)),
    productSeries: text(readField(row, definition.view, 'productSeries', options.fieldMappings)),
    purchaseCategory: text(readField(row, definition.view, 'purchaseCategory', options.fieldMappings)),
    sourceType: normalizeSourceType(readField(row, definition.view, 'sourceType', options.fieldMappings)),
    isReportable: normalizeBoolean(readField(row, definition.view, 'isReportable', options.fieldMappings), true),
    isActive: normalizeBoolean(readField(row, definition.view, 'isActive', options.fieldMappings), true),
    batchNo: text(readField(row, definition.view, 'batchNo', options.fieldMappings)) || '',
    expiryDate: normalizeDate(readField(row, definition.view, 'expiryDate', options.fieldMappings), '有效期'),
    isGift: normalizeBoolean(readField(row, definition.view, 'isGift', options.fieldMappings), false),
    quantity,
    retailPrice: normalizeNumeric(readField(row, definition.view, 'retailPrice', options.fieldMappings), '零售价'),
    accountingPrice: normalizeNumeric(readField(row, definition.view, 'accountingPrice', options.fieldMappings), '核算价'),
    supplyChainPurchasePrice: normalizeNumeric(readField(row, definition.view, 'supplyChainPurchasePrice', options.fieldMappings), '供应链采购价'),
    marketPurchasePrice: normalizeNumeric(readField(row, definition.view, 'marketPurchasePrice', options.fieldMappings), '市场进货价'),
    storePurchasePrice: normalizeNumeric(readField(row, definition.view, 'storePurchasePrice', options.fieldMappings), '门店进货价'),
    marketStaffPurchasePrice: normalizeNumeric(readField(row, definition.view, 'marketStaffPurchasePrice', options.fieldMappings), '市场员工购价'),
    marketPurchaseDiscount: normalizeNumeric(readField(row, definition.view, 'marketPurchaseDiscount', options.fieldMappings), '市场进货折扣', { scale: 4 }),
    storePurchaseDiscount: normalizeNumeric(readField(row, definition.view, 'storePurchaseDiscount', options.fieldMappings), '门店进货折扣', { scale: 4 }),
    staffPurchaseDiscount: normalizeNumeric(readField(row, definition.view, 'staffPurchaseDiscount', options.fieldMappings), '员工购折扣', { scale: 4 }),
    itemCompanyPurchasePrice: normalizeNumeric(readField(row, definition.view, 'itemCompanyPurchasePrice', options.fieldMappings), '品项公司进货价'),
    supplyChainUnitCost: normalizeNumeric(readField(row, definition.view, 'supplyChainUnitCost', options.fieldMappings), '供应链单位成本'),
    marketStandardUnitPrice: normalizeNumeric(readField(row, definition.view, 'marketStandardUnitPrice', options.fieldMappings), '市场标准单价'),
    marketUnitDiscount: normalizeNumeric(readField(row, definition.view, 'marketUnitDiscount', options.fieldMappings), '市场单价优惠'),
    marketActualUnitPrice: normalizeNumeric(readField(row, definition.view, 'marketActualUnitPrice', options.fieldMappings), '市场实际单价'),
    storeStandardUnitPrice: normalizeNumeric(readField(row, definition.view, 'storeStandardUnitPrice', options.fieldMappings), '门店标准单价'),
    storeUnitDiscount: normalizeNumeric(readField(row, definition.view, 'storeUnitDiscount', options.fieldMappings), '门店单价优惠'),
    storeActualUnitPrice: normalizeNumeric(readField(row, definition.view, 'storeActualUnitPrice', options.fieldMappings), '门店实际单价'),
    amount: normalizeNumeric(readField(row, definition.view, 'amount', options.fieldMappings), '金额'),
    remark: text(readField(row, definition.view, 'remark', options.fieldMappings)),
  }
}

function normalizePriceRow(row, definition, options) {
  const productCode = text(readField(row, definition.view, 'productCode', options.fieldMappings))
  if (!productCode) return null
  const locationName = text(readField(row, definition.view, 'locationName', options.fieldMappings))
  const marketName = text(readField(row, definition.view, 'marketName', options.fieldMappings))
  const storeName = text(readField(row, definition.view, 'storeName', options.fieldMappings))
  const batchNo = text(readField(row, definition.view, 'batchNo', options.fieldMappings)) || ''
  const expiryDate = normalizeDate(readField(row, definition.view, 'expiryDate', options.fieldMappings), '批次有效期')
  const isGift = normalizeBoolean(readField(row, definition.view, 'isGift', options.fieldMappings), false)
  const values = {}
  for (const field of [
    'supplyChainUnitCost',
    'marketStandardUnitPrice',
    'marketUnitDiscount',
    'marketActualUnitPrice',
    'storeStandardUnitPrice',
    'storeUnitDiscount',
    'storeActualUnitPrice',
  ]) {
    values[field] = normalizeNumeric(readField(row, definition.view, field, options.fieldMappings), `${definition.view}.${field}`)
  }
  if (Object.values(values).every((value) => value === null)) return null
  return { productCode, locationName, marketName, storeName, batchNo, expiryDate, isGift, values }
}

function priceKey(row, includeLocation) {
  const location = includeLocation ? row.locationName || row.storeName || row.marketName || '' : ''
  return [location, row.productCode, row.batchNo || '', row.expiryDate || '', row.isGift ? '1' : '0'].join('\u001f')
}

function samePriceValues(left, right) {
  const fields = [
    'supplyChainUnitCost',
    'marketStandardUnitPrice',
    'marketUnitDiscount',
    'marketActualUnitPrice',
    'storeStandardUnitPrice',
    'storeUnitDiscount',
    'storeActualUnitPrice',
  ]
  return fields.every((field) => canonicalNumber(left.values[field]) === canonicalNumber(right.values[field]))
}

function addPriceCandidate(map, key, row) {
  if (!map.has(key)) {
    map.set(key, row)
    return
  }
  const existing = map.get(key)
  if (existing && samePriceValues(existing, row)) return
  map.set(key, null)
}

function hasMissingBatchPrice(row) {
  return [
    'supplyChainUnitCost',
    'marketStandardUnitPrice',
    'marketUnitDiscount',
    'marketActualUnitPrice',
    'storeStandardUnitPrice',
    'storeUnitDiscount',
    'storeActualUnitPrice',
  ].some((field) => row[field] === null)
}

function applyPriceRows(snapshotRows, priceRows) {
  const exact = new Map()
  const loose = new Map()
  for (const row of priceRows) {
    const exactKey = priceKey(row, true)
    const looseKey = priceKey(row, false)
    addPriceCandidate(exact, exactKey, row)
    addPriceCandidate(loose, looseKey, row)
  }
  let enriched = 0
  for (const row of snapshotRows) {
    const exactKey = priceKey(row, true)
    const looseKey = priceKey(row, false)
    const candidate = exact.has(exactKey) ? exact.get(exactKey) : loose.get(looseKey)
    if (!candidate) {
      if ((exact.has(exactKey) || loose.has(looseKey)) && hasMissingBatchPrice(row)) {
        throw new Error(`批次价格匹配不唯一：${row.productCode}/${row.batchNo || '-'}；请补充库存主体、批号或有效期映射`)
      }
      continue
    }
    let changed = false
    for (const [field, value] of Object.entries(candidate.values)) {
      if (row[field] === null && value !== null) {
        row[field] = value
        changed = true
      }
    }
    if (changed) enriched += 1
  }
  return enriched
}

function sourceKey(row) {
  return `${row.legacyTable}\u001f${row.legacyRid}\u001f${row.legacyObyid}`
}

function docSourceKey(row) {
  return `${row.legacyTable}\u001f${row.legacyRid}\u001f`
}

function lotKey(row) {
  return `workfine-initial:${row.legacyTable}:${row.legacyRid}:${row.legacyObyid}`
}

function movementKey(row) {
  return `workfine-initial:${row.legacyTable}:${row.legacyRid}:${row.legacyObyid}`
}

function documentId(row, locationId) {
  return hashId('WF-INIT-DOC', row.legacyTable, row.legacyRid, locationId)
}

function skuId(productCode) {
  return hashId('WF-INV-SKU', productCode)
}

const SNAPSHOT_DEDUPLICATION_FIELDS = [
  'locationType',
  'locationName',
  'marketName',
  'storeName',
  'snapshotDate',
  'productCode',
  'productName',
  'specName',
  'supplier',
  'manufacturer',
  'brand',
  'productSeries',
  'purchaseCategory',
  'sourceType',
  'isReportable',
  'isActive',
  'batchNo',
  'expiryDate',
  'isGift',
  'quantity',
  'retailPrice',
  'accountingPrice',
  'supplyChainPurchasePrice',
  'marketPurchasePrice',
  'storePurchasePrice',
  'marketStaffPurchasePrice',
  'marketPurchaseDiscount',
  'storePurchaseDiscount',
  'staffPurchaseDiscount',
  'itemCompanyPurchasePrice',
  'supplyChainUnitCost',
  'marketStandardUnitPrice',
  'marketUnitDiscount',
  'marketActualUnitPrice',
  'storeStandardUnitPrice',
  'storeUnitDiscount',
  'storeActualUnitPrice',
  'amount',
  'remark',
]

function deduplicateSnapshotRows(rows) {
  const seen = new Map()
  for (const row of rows) {
    const key = sourceKey(row)
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, row)
      continue
    }
    if (SNAPSHOT_DEDUPLICATION_FIELDS.some((field) => canonicalNumber(existing[field]) !== canonicalNumber(row[field]))) {
      throw new Error(`WorkFine 期初库存存在冲突重复行：${key}`)
    }
  }
  return [...seen.values()]
}

function createMssqlConfig(env = process.env) {
  const connectionString = text(env.MSSQL_CONNECTION_STRING)
  if (connectionString) return connectionString
  const required = ['MSSQL_SERVER', 'MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE']
  const missing = required.filter((key) => !text(env[key]))
  if (missing.length > 0) {
    throw new Error(`缺少 WorkFine 连接配置：${missing.join(', ')}（或设置 MSSQL_CONNECTION_STRING）`)
  }
  return {
    server: env.MSSQL_SERVER,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    database: env.MSSQL_DATABASE,
    port: Number(env.MSSQL_PORT || 1433),
    connectionTimeout: Number(env.MSSQL_CONNECTION_TIMEOUT_MS || 8000),
    requestTimeout: Number(env.MSSQL_REQUEST_TIMEOUT_MS || 30000),
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  }
}

function createPgConfig(env = process.env) {
  if (!text(env.DATABASE_URL)) throw new Error('缺少 DATABASE_URL')
  return { connectionString: env.DATABASE_URL, max: 1 }
}

async function assertMssqlObject(pool, mssql, objectName, kind = 'VIEW') {
  const parsed = parseViewName(objectName)
  const catalog = kind === 'VIEW' ? 'INFORMATION_SCHEMA.VIEWS' : 'INFORMATION_SCHEMA.TABLES'
  const result = await pool
    .request()
    .input('schema_name', mssql.NVarChar(128), parsed.schema)
    .input('object_name', mssql.NVarChar(128), parsed.name)
    .query(`SELECT TABLE_SCHEMA, TABLE_NAME FROM ${catalog} WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = @object_name`)
  if (result.recordset.length === 0) throw new Error(`WorkFine ${kind} 不存在：${parsed.schema}.${parsed.name}`)
}

async function readMssqlObject(pool, mssql, objectName, kind = 'VIEW') {
  await assertMssqlObject(pool, mssql, objectName, kind)
  const result = await pool.request().query(`SELECT * FROM ${quoteSqlServerObject(objectName)}`)
  return result.recordset
}

async function inspectMssqlObject(pool, mssql, objectName, kind = 'VIEW') {
  await assertMssqlObject(pool, mssql, objectName, kind)
  const result = await pool.request().query(`SELECT TOP (1) * FROM ${quoteSqlServerObject(objectName)}`)
  const columns = result.recordset.columns ? Object.keys(result.recordset.columns) : Object.keys(result.recordset[0] || {})
  return { columns, sample: result.recordset[0] || null }
}

async function readMssqlColumns(pool, mssql, objectName, kind = 'TABLE') {
  const parsed = parseViewName(objectName)
  await assertMssqlObject(pool, mssql, objectName, kind)
  const result = await pool
    .request()
    .input('schema_name', mssql.NVarChar(128), parsed.schema)
    .input('object_name', mssql.NVarChar(128), parsed.name)
    .query(`SELECT COLUMN_NAME
              FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = @object_name
             ORDER BY ORDINAL_POSITION`)
  return result.recordset.map((row) => String(row.COLUMN_NAME || row.column_name))
}

async function loadTemplateMetadata(pool, mssql) {
  const [templateTables, templateFields] = await Promise.all([
    readMssqlObject(pool, mssql, TEMPLATE_METADATA_TABLES.table, 'TABLE'),
    readMssqlObject(pool, mssql, TEMPLATE_METADATA_TABLES.field, 'TABLE'),
  ])
  return normalizeTemplateMetadata(templateTables, templateFields)
}

/**
 * 验证存量快照中声明的物理表确实由模板元数据登记，且数据库表本身有
 * RID/OBYID 两个系统键。元数据通常不会列出这两个系统键，因此两处都要查。
 */
async function assertPhysicalSourceStructures(pool, mssql, metadata, physicalTables) {
  const seen = new Set()
  for (const sourceTable of physicalTables) {
    const physicalTable = normalizePhysicalTableName(sourceTable)
    if (!physicalTable || seen.has(physicalTable)) continue
    seen.add(physicalTable)
    getMetadataTable(metadata, physicalTable)
    const columns = await readMssqlColumns(pool, mssql, physicalTable, 'TABLE')
    const columnSet = new Set(columns.map((column) => column.toUpperCase()))
    const missing = [...SYSTEM_IDENTITY_COLUMNS].filter((column) => !columnSet.has(column))
    if (missing.length > 0) {
      throw new Error(`${physicalTable} 缺少系统幂等键字段：${missing.join(', ')}`)
    }
  }
}

async function resolveImportRefContract(client, env = process.env) {
  const requested = text(env.INVENTORY_IMPORT_REFS_TABLE)
  const candidates = [...new Set([requested, ...IMPORT_REF_TABLE_CANDIDATES].filter(Boolean))]
  const tables = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [candidates],
  )
  const selected = candidates.find((candidate) => tables.rows.some((row) => row.table_name === candidate))
  if (!selected) {
    throw new Error(`未找到导入追溯表；期望其一：${candidates.join(', ')}`)
  }
  const columns = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [selected],
  )
  const available = new Set(columns.rows.map((row) => row.column_name))
  const required = ['entity_type', 'entity_id', 'legacy_table', 'legacy_rid', 'legacy_obyid', 'legacy_doc_no']
  const missing = required.filter((column) => !available.has(column))
  if (missing.length > 0) {
    throw new Error(`${selected} 字段不兼容，缺少：${missing.join(', ')}`)
  }
  return { table: selected, quotedTable: quotePgIdentifier(selected) }
}

async function assertTargetTables(client) {
  const required = [
    'inventory_skus',
    'inventory_locations',
    'inventory_stock_lots',
    'inventory_docs',
    'inventory_doc_items',
    'inventory_movements',
    'org_nodes',
    'staff_wechat_users',
    'stores',
    'inventory_cutover_states',
  ]
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [required],
  )
  const existing = new Set(result.rows.map((row) => row.table_name))
  const missing = required.filter((table) => !existing.has(table))
  if (missing.length > 0) throw new Error(`PostgreSQL 尚未迁移库存 schema：${missing.join(', ')}`)
}

function normalizeWorkfineInventoryCutoverStatus(state) {
  const status = text(state && state.status)
  const knownStatuses = Object.values(WORKFINE_INVENTORY_CUTOVER_STATUSES)
  if (!knownStatuses.includes(status)) {
    throw new Error(`WorkFine 库存切换状态非法：${status || '(空)'}`)
  }
  return status
}

async function lockWorkfineInventoryCutover(client) {
  await client.query(
    `INSERT INTO inventory_cutover_states (cutover_key, status)
     VALUES ($1, $2)
     ON CONFLICT (cutover_key) DO NOTHING`,
    [WORKFINE_INVENTORY_CUTOVER_KEY, WORKFINE_INVENTORY_CUTOVER_STATUSES.PENDING_INITIALIZATION],
  )
  const result = await client.query(
    `SELECT cutover_key, status
       FROM inventory_cutover_states
      WHERE cutover_key = $1
      FOR UPDATE`,
    [WORKFINE_INVENTORY_CUTOVER_KEY],
  )
  if (result.rows.length !== 1) {
    throw new Error('无法锁定 WorkFine 库存切换状态')
  }
  const state = result.rows[0]
  normalizeWorkfineInventoryCutoverStatus(state)
  return state
}

function assertWorkfineInventoryCutoverCanApply(state, { reset = false } = {}) {
  const status = normalizeWorkfineInventoryCutoverStatus(state)
  if (status === WORKFINE_INVENTORY_CUTOVER_STATUSES.INITIALIZED && reset !== true) {
    throw new Error('WorkFine 库存期初已初始化；为避免重复导入，请在受控切换窗口显式使用 --apply --reset。')
  }
  return status
}

function assertWorkfineInventoryCutoverCanVerify(state) {
  const status = normalizeWorkfineInventoryCutoverStatus(state)
  if (status === WORKFINE_INVENTORY_CUTOVER_STATUSES.PENDING_INITIALIZATION) {
    throw new Error('WorkFine 库存期初尚未导入；请先成功执行 --apply。')
  }
  return status
}

async function markWorkfineInventoryPendingVerification(client, {
  asOfDate,
  sourceRowCount,
  sourceQuantity,
  importedDocCount,
  importedItemCount,
  initializedBy,
}) {
  await client.query(
    `UPDATE inventory_cutover_states
        SET status = $2,
            as_of_date = $3,
            source_row_count = $4,
            source_quantity = $5,
            imported_doc_count = $6,
            imported_item_count = $7,
            initialized_by = $8,
            initialized_at = NOW(),
            verified_at = NULL,
            updated_at = NOW()
      WHERE cutover_key = $1`,
    [
      WORKFINE_INVENTORY_CUTOVER_KEY,
      WORKFINE_INVENTORY_CUTOVER_STATUSES.PENDING_VERIFICATION,
      asOfDate || null,
      sourceRowCount,
      sourceQuantity,
      importedDocCount,
      importedItemCount,
      initializedBy,
    ],
  )
}

async function markWorkfineInventoryInitialized(client) {
  await client.query(
    `UPDATE inventory_cutover_states
        SET status = $2,
            verified_at = NOW(),
            updated_at = NOW()
      WHERE cutover_key = $1`,
    [WORKFINE_INVENTORY_CUTOVER_KEY, WORKFINE_INVENTORY_CUTOVER_STATUSES.INITIALIZED],
  )
}

/**
 * WorkFine 快照与旧 PG 库存回填是互斥的两种期初基线。
 *
 * 新库存余额直接读取 inventory_stock_lots；若未追溯到 WorkFine 的旧期初批次
 * 仍存在，再导入 WorkFine 会把同一库存相加。只拦截 source_doc_id 为空或期初
 * 单来源的批次，避免阻断切换后正常采购/配货产生的业务库存。
 */
async function assertWorkfineBaselineExclusive(client, contract) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS lot_count,
            COALESCE(SUM(lot.quantity_on_hand), 0)::text AS quantity
       FROM inventory_stock_lots lot
  LEFT JOIN inventory_docs doc ON doc.id = lot.source_doc_id
      WHERE NOT EXISTS (
              SELECT 1
                FROM ${contract.quotedTable} ref
               WHERE ref.entity_type = 'inventory_stock_lot'
                 AND ref.entity_id = lot.id::text
            )
        AND (lot.source_doc_id IS NULL OR doc.doc_type = '期初库存')`,
  )
  const count = Number(result.rows[0]?.lot_count || 0)
  if (count > 0) {
    const quantity = text(result.rows[0]?.quantity) || '0'
    throw new Error(
      `检测到 ${count} 条未追溯 WorkFine 的旧 PG 期初库存批次（数量 ${quantity}）。` +
      '旧 PG 回填与 WorkFine 期初基线不能混用；请在切换前只保留一种基线后再执行导入或复核。',
    )
  }
}

async function syncInventoryLocations(client) {
  await client.query(`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id)
    SELECT id, type, name, id, parent_id
      FROM org_nodes
     WHERE type IN ('总部', '市场')
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          parent_location_id = EXCLUDED.parent_location_id,
          updated_at = NOW()
  `)
  await client.query(`
    INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id)
    SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id
      FROM stores s
      LEFT JOIN org_nodes o ON o.id = s.org_node_id
    ON CONFLICT (location_id) DO UPDATE
      SET location_type = EXCLUDED.location_type,
          name = EXCLUDED.name,
          org_node_id = EXCLUDED.org_node_id,
          store_id = EXCLUDED.store_id,
          parent_location_id = EXCLUDED.parent_location_id,
          updated_at = NOW()
  `)
}

class LocationResolver {
  constructor(client) {
    this.client = client
    this.cache = new Map()
  }

  async resolve(row) {
    const key = `${row.locationType}\u001f${row.locationName}`
    if (this.cache.has(key)) return this.cache.get(key)
    const result = await this.client.query(
      `SELECT location_id, org_node_id, parent_location_id
         FROM inventory_locations
        WHERE location_type = $1 AND name = $2`,
      [row.locationType, row.locationName],
    )
    if (result.rows.length !== 1) {
      throw new Error(`无法唯一匹配库存主体：${row.locationType}/${row.locationName}（${result.rows.length} 条）`)
    }
    const resolved = {
      locationId: result.rows[0].location_id,
      orgNodeId: result.rows[0].org_node_id,
      parentLocationId: result.rows[0].parent_location_id,
    }
    this.cache.set(key, resolved)
    return resolved
  }

  async resolveMarketId(row) {
    const marketName = row.locationType === '市场' ? row.locationName : row.marketName
    if (!marketName && row.locationType === '门店') {
      const location = await this.resolve(row)
      if (!location.parentLocationId) return null
      const parentResult = await this.client.query(
        `SELECT org_node_id
           FROM inventory_locations
          WHERE location_id = $1 AND location_type = '市场'`,
        [location.parentLocationId],
      )
      return parentResult.rows.length === 1 ? parentResult.rows[0].org_node_id || null : null
    }
    if (!marketName) return null
    const key = `市场\u001f${marketName}`
    if (this.cache.has(key)) return this.cache.get(key).orgNodeId || null
    const result = await this.client.query(
      `SELECT location_id, org_node_id, parent_location_id
         FROM inventory_locations
        WHERE location_type = '市场' AND name = $1`,
      [marketName],
    )
    if (result.rows.length !== 1) return null
    const resolved = {
      locationId: result.rows[0].location_id,
      orgNodeId: result.rows[0].org_node_id,
      parentLocationId: result.rows[0].parent_location_id,
    }
    this.cache.set(key, resolved)
    return resolved.orgNodeId || null
  }
}

async function assertImporterEmployee(client, employeeId) {
  const normalized = text(employeeId)
  if (!normalized) throw new Error('缺少 WORKFINE_INVENTORY_IMPORTER_EMPLOYEE_ID')
  const result = await client.query(
    'SELECT employee_id FROM staff_wechat_users WHERE employee_id = $1',
    [normalized],
  )
  if (result.rows.length !== 1) throw new Error(`找不到期初迁移记账员工：${normalized}`)
  return normalized
}

async function findImportRef(client, contract, entityType, identity) {
  assertImportIdentity(identity)
  const result = await client.query(
    `SELECT entity_id
       FROM ${contract.quotedTable}
      WHERE entity_type = $1 AND legacy_table = $2 AND legacy_rid = $3 AND legacy_obyid = $4`,
    [entityType, identity.legacyTable, identity.legacyRid, identity.legacyObyid],
  )
  return result.rows[0] || null
}

function assertImportIdentity(identity) {
  const physicalTable = normalizePhysicalTableName(identity && identity.legacyTable)
  const rid = text(identity && identity.legacyRid)
  const obyid = text(identity && identity.legacyObyid)
  if (!physicalTable || !rid || !obyid) {
    throw new Error('导入追溯键必须同时包含物理表名、RID、OBYID')
  }
}

async function upsertImportRef(client, contract, entityType, entityId, identity, legacyDocNo) {
  assertImportIdentity(identity)
  const existing = await findImportRef(client, contract, entityType, identity)
  if (existing && String(existing.entity_id) !== String(entityId)) {
    throw new Error(`导入追溯键冲突：${entityType}/${identity.legacyTable}/${identity.legacyRid}/${identity.legacyObyid}`)
  }
  await client.query(
    `INSERT INTO ${contract.quotedTable}
      (entity_type, entity_id, legacy_table, legacy_rid, legacy_obyid, legacy_doc_no)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (entity_type, legacy_table, legacy_rid, legacy_obyid)
     DO UPDATE SET entity_id = EXCLUDED.entity_id,
                   legacy_doc_no = COALESCE(EXCLUDED.legacy_doc_no, legacy_doc_no),
                   imported_at = NOW()`,
    [entityType, String(entityId), identity.legacyTable, identity.legacyRid, identity.legacyObyid, legacyDocNo || null],
  )
}

function groupRowsByDocument(rows, locationResolver) {
  const groups = new Map()
  return Promise.all(
    rows.map(async (row) => {
      const location = await locationResolver.resolve(row)
      row.locationId = location.locationId
      row.marketId = await locationResolver.resolveMarketId(row)
      const key = `${docSourceKey(row)}\u001f${row.locationId}`
      if (!groups.has(key)) {
        groups.set(key, { row, location, rows: [], totalQuantity: 0, totalAmount: 0, hasAmount: false })
      }
      const group = groups.get(key)
      // 期初单只保存一条来源引用；选最小的完整三元键，避免 SQL Server
      // 返回顺序变化时同一单据在重复运行中累计多条追溯引用。
      if (sourceKey(row) < sourceKey(group.row)) group.row = row
      group.rows.push(row)
      group.totalQuantity += Number(row.quantity)
      if (row.amount !== null) {
        group.totalAmount += Number(row.amount)
        group.hasAmount = true
      }
    }),
  ).then(() => [...groups.values()])
}

function documentIdentity(row) {
  return { legacyTable: row.legacyTable, legacyRid: row.legacyRid, legacyObyid: row.legacyObyid }
}

function initialPriceForItem(row) {
  if (row.locationType === '总部') {
    return {
      standardUnitPrice: null,
      unitDiscount: null,
      actualUnitPrice: null,
    }
  }
  if (row.locationType === '市场') {
    return {
      standardUnitPrice: row.marketStandardUnitPrice,
      unitDiscount: row.marketUnitDiscount,
      actualUnitPrice: row.marketActualUnitPrice,
    }
  }
  return {
    standardUnitPrice: row.storeStandardUnitPrice,
    unitDiscount: row.storeUnitDiscount,
    actualUnitPrice: row.storeActualUnitPrice,
  }
}

async function upsertSku(client, row) {
  const id = skuId(row.productCode)
  const result = await client.query(
    `INSERT INTO inventory_skus (
       sku_id, product_code, product_name, spec_name, supplier, manufacturer, brand,
       product_series, purchase_category, source_type, owner_market_id,
       retail_price, accounting_price, supply_chain_purchase_price, market_purchase_price,
       store_purchase_price, market_staff_purchase_price, market_purchase_discount,
       store_purchase_discount, staff_purchase_discount, item_company_purchase_price,
       is_reportable, is_active, remark
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
     )
     ON CONFLICT (product_code) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       spec_name = COALESCE(EXCLUDED.spec_name, inventory_skus.spec_name),
       supplier = COALESCE(EXCLUDED.supplier, inventory_skus.supplier),
       manufacturer = COALESCE(EXCLUDED.manufacturer, inventory_skus.manufacturer),
       brand = COALESCE(EXCLUDED.brand, inventory_skus.brand),
       product_series = COALESCE(EXCLUDED.product_series, inventory_skus.product_series),
       purchase_category = COALESCE(EXCLUDED.purchase_category, inventory_skus.purchase_category),
       source_type = EXCLUDED.source_type,
       owner_market_id = COALESCE(EXCLUDED.owner_market_id, inventory_skus.owner_market_id),
       retail_price = COALESCE(EXCLUDED.retail_price, inventory_skus.retail_price),
       accounting_price = COALESCE(EXCLUDED.accounting_price, inventory_skus.accounting_price),
       supply_chain_purchase_price = COALESCE(EXCLUDED.supply_chain_purchase_price, inventory_skus.supply_chain_purchase_price),
       market_purchase_price = COALESCE(EXCLUDED.market_purchase_price, inventory_skus.market_purchase_price),
       store_purchase_price = COALESCE(EXCLUDED.store_purchase_price, inventory_skus.store_purchase_price),
       market_staff_purchase_price = COALESCE(EXCLUDED.market_staff_purchase_price, inventory_skus.market_staff_purchase_price),
       market_purchase_discount = COALESCE(EXCLUDED.market_purchase_discount, inventory_skus.market_purchase_discount),
       store_purchase_discount = COALESCE(EXCLUDED.store_purchase_discount, inventory_skus.store_purchase_discount),
       staff_purchase_discount = COALESCE(EXCLUDED.staff_purchase_discount, inventory_skus.staff_purchase_discount),
       item_company_purchase_price = COALESCE(EXCLUDED.item_company_purchase_price, inventory_skus.item_company_purchase_price),
       is_reportable = EXCLUDED.is_reportable,
       is_active = EXCLUDED.is_active,
       remark = COALESCE(EXCLUDED.remark, inventory_skus.remark),
       updated_at = NOW()
     RETURNING sku_id`,
    [
      id,
      row.productCode,
      row.productName,
      row.specName,
      row.supplier,
      row.manufacturer,
      row.brand,
      row.productSeries,
      row.purchaseCategory,
      row.sourceType,
      row.marketId,
      row.retailPrice,
      row.accountingPrice,
      row.supplyChainPurchasePrice,
      row.marketPurchasePrice,
      row.storePurchasePrice,
      row.marketStaffPurchasePrice,
      row.marketPurchaseDiscount,
      row.storePurchaseDiscount,
      row.staffPurchaseDiscount,
      row.itemCompanyPurchasePrice,
      row.isReportable,
      row.isActive,
      row.remark,
    ],
  )
  return result.rows[0].sku_id
}

async function upsertInitialDocument(client, group, createdBy) {
  const docId = documentId(group.row, group.location.locationId)
  const result = await client.query(
    `INSERT INTO inventory_docs (
       id, doc_type, status, target_location_id, market_id, doc_date,
       total_quantity, total_amount, remark, created_by, confirmed_by, confirmed_at
     ) VALUES ($1, '期初库存', '已完成', $2, $3, $4, $5, $6, $7, $8, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       doc_type = '期初库存',
       status = '已完成',
       target_location_id = EXCLUDED.target_location_id,
       market_id = COALESCE(EXCLUDED.market_id, inventory_docs.market_id),
       doc_date = EXCLUDED.doc_date,
       total_quantity = EXCLUDED.total_quantity,
       total_amount = EXCLUDED.total_amount,
       remark = COALESCE(EXCLUDED.remark, inventory_docs.remark),
       updated_at = NOW()
     RETURNING id`,
    [
      docId,
      group.location.locationId,
      group.row.marketId,
      group.row.snapshotDate,
      group.totalQuantity.toFixed(2),
      group.hasAmount ? group.totalAmount.toFixed(2) : null,
      `WorkFine 期初库存迁移：${group.row.legacyTable}/${group.row.legacyRid}`,
      createdBy,
    ],
  )
  return result.rows[0].id
}

async function upsertLot(client, row, skuIdValue, docId, { allowOverwriteQuantity = false } = {}) {
  const quantityOnHand = allowOverwriteQuantity === true
    ? 'EXCLUDED.quantity_on_hand'
    : 'inventory_stock_lots.quantity_on_hand'
  const result = await client.query(
    `INSERT INTO inventory_stock_lots (
       location_id, sku_id, lot_key, sku_name, spec_name, supplier, product_series,
       batch_no, expiry_date, expiry_date_key, is_gift, quantity_on_hand,
       supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
       market_actual_unit_price, store_standard_unit_price, store_unit_discount,
       store_actual_unit_price, source_doc_id, remark
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (location_id, lot_key) DO UPDATE SET
       sku_id = EXCLUDED.sku_id,
       sku_name = EXCLUDED.sku_name,
       spec_name = COALESCE(EXCLUDED.spec_name, inventory_stock_lots.spec_name),
       supplier = COALESCE(EXCLUDED.supplier, inventory_stock_lots.supplier),
       product_series = COALESCE(EXCLUDED.product_series, inventory_stock_lots.product_series),
       batch_no = EXCLUDED.batch_no,
       expiry_date = EXCLUDED.expiry_date,
       expiry_date_key = EXCLUDED.expiry_date_key,
       is_gift = EXCLUDED.is_gift,
       quantity_on_hand = ${quantityOnHand},
       supply_chain_unit_cost = COALESCE(EXCLUDED.supply_chain_unit_cost, inventory_stock_lots.supply_chain_unit_cost),
       market_standard_unit_price = COALESCE(EXCLUDED.market_standard_unit_price, inventory_stock_lots.market_standard_unit_price),
       market_unit_discount = COALESCE(EXCLUDED.market_unit_discount, inventory_stock_lots.market_unit_discount),
       market_actual_unit_price = COALESCE(EXCLUDED.market_actual_unit_price, inventory_stock_lots.market_actual_unit_price),
       store_standard_unit_price = COALESCE(EXCLUDED.store_standard_unit_price, inventory_stock_lots.store_standard_unit_price),
       store_unit_discount = COALESCE(EXCLUDED.store_unit_discount, inventory_stock_lots.store_unit_discount),
       store_actual_unit_price = COALESCE(EXCLUDED.store_actual_unit_price, inventory_stock_lots.store_actual_unit_price),
       source_doc_id = EXCLUDED.source_doc_id,
       remark = COALESCE(EXCLUDED.remark, inventory_stock_lots.remark),
       updated_at = NOW()
     RETURNING id`,
    [
      row.locationId,
      skuIdValue,
      lotKey(row),
      row.productName,
      row.specName,
      row.supplier,
      row.productSeries,
      row.batchNo,
      row.expiryDate,
      row.expiryDate || '',
      row.isGift,
      row.quantity,
      row.supplyChainUnitCost,
      row.marketStandardUnitPrice,
      row.marketUnitDiscount,
      row.marketActualUnitPrice,
      row.storeStandardUnitPrice,
      row.storeUnitDiscount,
      row.storeActualUnitPrice,
      docId,
      row.remark,
    ],
  )
  return result.rows[0].id
}

async function upsertDocItem(client, contract, row, docId, lotId, skuIdValue) {
  const existing = await findImportRef(client, contract, 'inventory_doc_item', row)
  const prices = initialPriceForItem(row)
  const values = [
    docId,
    lotId,
    skuIdValue,
    row.productName,
    row.specName,
    row.supplier,
    row.productSeries,
    row.batchNo,
    row.expiryDate,
    row.isGift,
    row.quantity,
    prices.standardUnitPrice,
    prices.unitDiscount,
    prices.actualUnitPrice,
    row.amount,
    row.supplyChainUnitCost,
    row.marketStandardUnitPrice,
    row.marketUnitDiscount,
    row.marketActualUnitPrice,
    row.storeStandardUnitPrice,
    row.storeUnitDiscount,
    row.storeActualUnitPrice,
    row.remark,
  ]
  if (existing) {
    const id = Number(existing.entity_id)
    if (!Number.isSafeInteger(id)) throw new Error(`库存明细导入引用损坏：${existing.entity_id}`)
    await client.query(
      `UPDATE inventory_doc_items SET
         doc_id=$1, lot_id=$2, sku_id=$3, sku_name=$4, spec_name=$5, supplier=$6,
         product_series=$7, batch_no=$8, expiry_date=$9, is_gift=$10, quantity=$11,
         stock_snapshot='0', standard_unit_price=$12, unit_discount=$13, actual_unit_price=$14,
         amount=$15, supply_chain_unit_cost=$16, market_standard_unit_price=$17,
         market_unit_discount=$18, market_actual_unit_price=$19, store_standard_unit_price=$20,
         store_unit_discount=$21, store_actual_unit_price=$22, remark=$23
       WHERE id=$24`,
      [...values, id],
    )
    return id
  }
  const result = await client.query(
    `INSERT INTO inventory_doc_items (
       doc_id, lot_id, sku_id, sku_name, spec_name, supplier, product_series,
       batch_no, expiry_date, is_gift, quantity, stock_snapshot,
       standard_unit_price, unit_discount, actual_unit_price, amount,
       supply_chain_unit_cost, market_standard_unit_price, market_unit_discount,
       market_actual_unit_price, store_standard_unit_price, store_unit_discount,
       store_actual_unit_price, remark
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'0',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id`,
    values,
  )
  return result.rows[0].id
}

async function upsertMovement(client, row, docId, docItemId, lotId, skuIdValue, createdBy) {
  const result = await client.query(
    `INSERT INTO inventory_movements (
       movement_key, lot_id, location_id, sku_id, doc_id, doc_item_id,
       direction, quantity_delta, quantity_before, quantity_after, created_by, remark
     ) VALUES ($1,$2,$3,$4,$5,$6,'入库',$7,'0',$7,$8,$9)
     ON CONFLICT (movement_key) DO UPDATE SET
       lot_id = EXCLUDED.lot_id,
       location_id = EXCLUDED.location_id,
       sku_id = EXCLUDED.sku_id,
       doc_id = EXCLUDED.doc_id,
       doc_item_id = EXCLUDED.doc_item_id,
       direction = '入库',
       quantity_delta = EXCLUDED.quantity_delta,
       quantity_before = '0',
       quantity_after = EXCLUDED.quantity_after,
       created_by = EXCLUDED.created_by,
       remark = COALESCE(EXCLUDED.remark, inventory_movements.remark)
     RETURNING id`,
    [movementKey(row), lotId, row.locationId, skuIdValue, docId, docItemId, row.quantity, createdBy, row.remark],
  )
  return result.rows[0].id
}

function printRowSummary(rows, log = console.log) {
  const byView = new Map()
  const byLocation = new Map()
  let quantity = 0
  for (const row of rows) {
    byView.set(row.viewName, (byView.get(row.viewName) || 0) + 1)
    const location = `${row.locationType}/${row.locationName}`
    byLocation.set(location, (byLocation.get(location) || 0) + 1)
    quantity += Number(row.quantity)
  }
  for (const [view, count] of byView) log(`  ${view}: ${count} 行`)
  log(`  合计：${rows.length} 行，数量 ${quantity.toFixed(2)}`)
  log(`  库存主体：${byLocation.size} 个`)
}

module.exports = {
  FIELD_CANDIDATES,
  IMPORT_REF_TABLE_CANDIDATES,
  PRICE_VIEW_DEFINITIONS,
  STOCK_VIEW_DEFINITIONS,
  TEMPLATE_METADATA_TABLES,
  WORKFINE_INVENTORY_CUTOVER_KEY,
  WORKFINE_INVENTORY_CUTOVER_STATUSES,
  LocationResolver,
  applyPriceRows,
  assertImportIdentity,
  assertImporterEmployee,
  assertConfiguredPhysicalFieldMappings,
  assertMetadataField,
  assertMssqlObject,
  assertPhysicalSourceStructures,
  assertTargetTables,
  assertWorkfineBaselineExclusive,
  assertWorkfineInventoryCutoverCanApply,
  assertWorkfineInventoryCutoverCanVerify,
  createMssqlConfig,
  createPgConfig,
  deduplicateSnapshotRows,
  documentId,
  documentIdentity,
  findImportRef,
  groupRowsByDocument,
  hashId,
  inspectMssqlObject,
  getMetadataTable,
  lotKey,
  loadTemplateMetadata,
  movementKey,
  markWorkfineInventoryInitialized,
  markWorkfineInventoryPendingVerification,
  normalizePhysicalTableName,
  normalizePriceRow,
  normalizeSnapshotRow,
  normalizeTemplateMetadata,
  normalizeWorkfineInventoryCutoverStatus,
  parseJsonObject,
  printRowSummary,
  quotePgIdentifier,
  readMssqlColumns,
  readMssqlObject,
  resolveImportRefContract,
  skuId,
  sourceKey,
  syncInventoryLocations,
  templateMetadataReport,
  text,
  lockWorkfineInventoryCutover,
  upsertDocItem,
  upsertImportRef,
  upsertInitialDocument,
  upsertLot,
  upsertMovement,
  upsertSku,
}
