#!/usr/bin/env node
/**
 * WorkFine → PostgreSQL 全量同步脚本
 *
 * 使用方法：
 *   node scripts/sync-workfine.js              # 全量同步 + 一次性导入
 *   node scripts/sync-workfine.js --sync-only   # 仅定期同步域（org/stores/employees/customers）
 *   node scripts/sync-workfine.js --import-only  # 仅一次性导入域（品项分类/商品）
 *   node scripts/sync-workfine.js --dry-run      # 预览模式
 *
 * 同步顺序（存在依赖）：
 *   1. org_nodes（组织架构树）— 无依赖
 *   2. stores（门店详情）— 依赖 org_nodes
 *   3. staff_wechat_users（员工）— 依赖 stores + org_nodes
 *   4. permission_roles（权限自动推导）— 依赖 staff_wechat_users + org_nodes
 *   5. client_wechat_users（顾客档案）— 依赖 stores
 *   6. product_categories（品项分类）— 无依赖（一次性导入）
 *   7. products + product_skus（商品）— 依赖 product_categories（一次性导入）
 */

const mssql = require('mssql')
const { Pool } = require('pg')
const crypto = require('crypto')

// ─── 配置 ────────────────────────────────────────────────

const MSSQL_CONFIG = {
  user: process.env.MSSQL_USER || 'SD',
  password: process.env.MSSQL_PASSWORD || 'Se4Qimoh',
  database: process.env.MSSQL_DATABASE || 'wkdb_20220804_86cd3292',
  server: process.env.MSSQL_SERVER || '47.96.87.33',
  port: parseInt(process.env.MSSQL_PORT) || 1433,
  pool: { max: 5, min: 1, idleTimeoutMillis: 30000 },
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
}

// DATABASE_URL 必填且必须精确指向两个业务库之一（db/CLAUDE.md 硬规则：显式传值 + 断言 host/port/dbname）。
// 只查"非空"不够：已弃用的旧库 47.113.202.7 至今仍可连通，手滑传进来会静默写错库。
// 仅在直接执行时校验——本目录部分脚本的导出函数被 __tests__ require，顶层 exit 会打断测试进程。
const DB_TARGET_RE = /^postgres(?:ql)?:\/\/[^@/]*@(101\.34\.242\.103|118\.178\.196\.26):5433\/fengyu_wxapp(\?.*)?$/
if (require.main === module && !DB_TARGET_RE.test(process.env.DATABASE_URL?.trim() || '')) {
  console.error('✗ DATABASE_URL 必须显式指向 dev=101.34.242.103:5433/fengyu_wxapp 或 prod=118.178.196.26:5433/fengyu_wxapp')
  process.exit(1)
}

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL?.trim(),
  max: 5,
}

// ─── 工具函数 ──────────────────────────────────────────────

/** 确定性 ID（相同输入 → 相同输出） */
function hashId(...parts) {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').substring(0, 16)
}

/**
 * 创建顾客 user_id 序列生成器：FYGK-{YYYYMMDD}-{5位序号}
 * 在事务内调用 init() 查询当日最大序号，后续调用 next() 递增
 */
function createClientIdGenerator() {
  let seq = 0
  let prefix = ''
  return {
    async init(client) {
      const now = new Date()
      const yyyy = String(now.getFullYear())
      const mm = String(now.getMonth() + 1).padStart(2, '0')
      const dd = String(now.getDate()).padStart(2, '0')
      prefix = `FYGK-${yyyy}${mm}${dd}-`
      const { rows } = await client.query(
        "SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 ORDER BY user_id DESC LIMIT 1",
        [prefix + '%']
      )
      seq = rows.length > 0 ? parseInt(rows[0].user_id.slice(prefix.length), 10) : 0
    },
    next() {
      seq++
      return prefix + String(seq).padStart(5, '0')
    },
  }
}

/** 文本 '是'/'否' → boolean */
function toBool(val) {
  if (val === null || val === undefined) return false
  return String(val).trim() === '是'
}

/** RTRIM + null 处理 */
function trim(val) {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  return s === '' ? null : s
}

const CUSTOMER_SOURCE_ALIASES = {
  推带新: '推广部',
  地推卡: '全员地推',
  拓客卡: '外请团队拓客',
  内部员工或家属: '员工或家属',
}

function normalizeCustomerSource(val) {
  const source = trim(val)
  return source ? (CUSTOMER_SOURCE_ALIASES[source] || source) : null
}

/** 中国手机号校验：11位数字、1开头，不符合则返回 null */
function validPhone(val) {
  if (!val) return null
  const s = String(val).trim()
  return /^1\d{10}$/.test(s) ? s : null
}

/** 日期格式化（MSSQL Date → YYYY-MM-DD 字符串） */
function toDateStr(val) {
  if (!val) return null
  if (val instanceof Date) {
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(val).substring(0, 10)
}

function log(domain, msg) {
  console.log(`[${domain}] ${msg}`)
}

// ─── 1. 同步 org_nodes + stores ──────────────────────────────

async function syncOrgNodesAndStores(mssqlPool, pgPool, dryRun) {
  log('ORG+STORES', '开始同步...')

  // 查询 WorkFine 门店数据
  const { recordset: rows } = await mssqlPool.request().query(`
    SELECT
      RTRIM(UDF_M_437) AS market_name,
      RTRIM(UDF_M_438) AS store_name,
      UDF_M_1777       AS opening_date,
      UDF_M_8590       AS bed_count,
      RTRIM(UDF_M_11956) AS is_closed_raw
    FROM UDT_M_219
    WHERE UDF_M_438 IS NOT NULL AND RTRIM(UDF_M_438) != ''
  `)
  log('ORG+STORES', `WorkFine 查询到 ${rows.length} 条门店记录`)

  if (dryRun) {
    rows.forEach(r => console.log(`  [DRY] store=${r.store_name}, market=${r.market_name}`))
    return
  }

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    // 1. UPSERT 总部节点
    const hqId = hashId('org', 'headquarters', '总部')
    await client.query(`
      INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
      VALUES ($1, '总部', '总部', NULL, 0, true)
      ON CONFLICT (id) DO UPDATE SET name = '总部', updated_at = now()
    `, [hqId])

    // 2. 收集唯一市场
    const markets = [...new Set(rows.map(r => trim(r.market_name)).filter(Boolean))]
    const marketIdMap = {} // marketName → orgNodeId

    for (let i = 0; i < markets.length; i++) {
      const marketId = hashId('org', 'market', markets[i])
      marketIdMap[markets[i]] = marketId
      await client.query(`
        INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
        VALUES ($1, $2, '市场', $3, $4, true)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, updated_at = now()
      `, [marketId, markets[i], hqId, i])
    }
    log('ORG+STORES', `UPSERT ${markets.length} 个市场节点`)

    // 3. 为每个门店 UPSERT org_nodes(type='store') + stores
    let storeCount = 0
    for (const row of rows) {
      const storeName = trim(row.store_name)
      const marketName = trim(row.market_name)
      if (!storeName) continue

      const storeOrgNodeId = hashId('org', 'store', storeName)
      const parentMarketId = marketName ? marketIdMap[marketName] : hqId

      // org_nodes store 节点
      await client.query(`
        INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
        VALUES ($1, $2, '门店', $3, 0, true)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, updated_at = now()
      `, [storeOrgNodeId, storeName, parentMarketId])

      // stores 详情
      const storeId = hashId('store', storeName)
      const isClosed = toBool(row.is_closed_raw)
      await client.query(`
        INSERT INTO stores (store_id, store_name, org_node_id, opening_date, bed_count, is_closed)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (store_id) DO UPDATE SET
          store_name = EXCLUDED.store_name,
          org_node_id = EXCLUDED.org_node_id,
          opening_date = EXCLUDED.opening_date,
          bed_count = EXCLUDED.bed_count,
          is_closed = EXCLUDED.is_closed,
          updated_at = now()
      `, [storeId, storeName, storeOrgNodeId, toDateStr(row.opening_date), row.bed_count || null, isClosed])

      storeCount++
    }

    await client.query('COMMIT')
    log('ORG+STORES', `完成：1 总部 + ${markets.length} 市场 + ${storeCount} 门店`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── 2. 同步员工 → staff_wechat_users ──────────────────────────

async function syncEmployees(mssqlPool, pgPool, dryRun) {
  log('EMPLOYEES', '开始同步...')

  const { recordset: rows } = await mssqlPool.request().query(`
    SELECT
      RTRIM(UDF_S_1147) AS employee_id,
      RTRIM(UDF_S_1155) AS name,
      RTRIM(UDF_S_1148) AS gender,
      RTRIM(UDF_S_1152) AS phone,
      RTRIM(UDF_S_1154) AS id_card,
      RTRIM(UDF_S_1163) AS store_name,
      RTRIM(UDF_S_1513) AS dept_name,
      RTRIM(UDF_S_1161) AS position_name,
      UDF_S_1149        AS birthday,
      RTRIM(UDF_S_1624) AS is_resigned_raw
    FROM UDT_S_287
    WHERE UDF_S_1147 IS NOT NULL AND RTRIM(UDF_S_1147) != ''
  `)
  log('EMPLOYEES', `WorkFine 查询到 ${rows.length} 条员工记录`)

  if (dryRun) {
    log('EMPLOYEES', `[DRY] 将同步 ${rows.length} 条`)
    return
  }

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    // 预加载 stores lookup (store_name → store_id + org_node_id)
    const storesRes = await client.query('SELECT store_id, store_name, org_node_id FROM stores')
    const storeMap = {}          // store_name → store_id
    const storeOrgNodeMap = {}   // store_name → org_node_id (org tree)
    storesRes.rows.forEach(r => {
      storeMap[r.store_name] = r.store_id
      storeOrgNodeMap[r.store_name] = r.org_node_id
    })

    // 收集门店级部门对 + 无门店的全局部门
    const hqRes = await client.query("SELECT id FROM org_nodes WHERE type = '总部' LIMIT 1")
    const hqId = hqRes.rows[0]?.id
    const storeDeptPairs = new Set()  // "storeName|deptName"
    const globalDeptNames = new Set() // 无门店员工的部门
    for (const row of rows) {
      const storeName = trim(row.store_name)
      const deptName = trim(row.dept_name)
      if (!deptName) continue
      if (storeName && storeOrgNodeMap[storeName]) {
        storeDeptPairs.add(storeName + '|' + deptName)
      } else {
        globalDeptNames.add(deptName)
      }
    }

    // 创建门店级部门节点（挂在各门店 org_node 下）
    const storeDeptMap = {} // "storeName|deptName" → orgNodeId
    for (const pair of storeDeptPairs) {
      const [storeName, deptName] = pair.split('|')
      const deptId = hashId('org', 'department', storeName, deptName)
      const parentId = storeOrgNodeMap[storeName]
      await client.query(`
        INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
        VALUES ($1, $2, '部门', $3, 0, true)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, updated_at = now()
      `, [deptId, deptName, parentId])
      storeDeptMap[pair] = deptId
    }

    // 创建全局部门节点（无门店员工的 fallback，挂在总部下）
    const globalDeptMap = {}
    if (hqId) {
      for (const deptName of globalDeptNames) {
        const deptId = hashId('org', 'department', deptName)
        await client.query(`
          INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
          VALUES ($1, $2, '部门', $3, 0, true)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
        `, [deptId, deptName, hqId])
        globalDeptMap[deptName] = deptId
      }
    }
    log('EMPLOYEES', `UPSERT ${storeDeptPairs.size} 个门店部门 + ${globalDeptNames.size} 个全局部门`)

    // 处理手机号去重：同一手机号多条记录，在职优先保留一条，其余设为 null
    // 同时过滤占位符手机号（如全 1、全 0）
    const empPhones = {} // employee_id → phone（最终分配）

    for (const row of rows) {
      const empId = trim(row.employee_id)
      if (!empId) continue
      empPhones[empId] = validPhone(row.phone)
    }

    // 手机号去重：在职优先，先到先得
    const phoneCount = {}
    for (const row of rows) {
      const empId = trim(row.employee_id)
      if (!empId) continue
      const phone = empPhones[empId]
      if (!phone) continue
      if (!phoneCount[phone]) phoneCount[phone] = []
      phoneCount[phone].push({ empId, isResigned: toBool(row.is_resigned_raw) })
    }
    let dupPhoneCleared = 0
    for (const [phone, emps] of Object.entries(phoneCount)) {
      if (emps.length <= 1) continue
      // 在职优先，其次按 employee_id 字典序
      emps.sort((a, b) => {
        if (a.isResigned !== b.isResigned) return a.isResigned ? 1 : -1
        return a.empId.localeCompare(b.empId)
      })
      // 仅第一条保留手机号
      for (let i = 1; i < emps.length; i++) {
        empPhones[emps[i].empId] = null
        dupPhoneCleared++
      }
    }
    if (dupPhoneCleared > 0) {
      log('EMPLOYEES', `手机号去重：${dupPhoneCleared} 条重复手机号已清除`)
    }

    // 先清空所有员工手机号，避免 UPSERT 时触发 phone 唯一约束冲突
    // （因为同步重新分配手机号，旧数据可能占位）
    await client.query("UPDATE staff_wechat_users SET phone = NULL WHERE phone IS NOT NULL")

    // UPSERT staff_wechat_users（以 employee_id 为冲突键，openid 可为 null）
    let count = 0
    for (const row of rows) {
      const empId = trim(row.employee_id)
      if (!empId) continue

      const storeName = trim(row.store_name)
      const storeId = storeName ? (storeMap[storeName] || null) : null
      const deptName = trim(row.dept_name)
      let orgNodeId = null
      if (deptName && storeName && storeOrgNodeMap[storeName]) {
        orgNodeId = storeDeptMap[storeName + '|' + deptName] || null
      } else if (deptName) {
        orgNodeId = globalDeptMap[deptName] || null
      }
      const phone = empPhones[empId]

      await client.query(`
        INSERT INTO staff_wechat_users (employee_id, phone, name, gender, id_card, store_id, org_node_id, position_name, birthday, is_resigned)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (employee_id) DO UPDATE SET
          name = EXCLUDED.name,
          gender = EXCLUDED.gender,
          phone = EXCLUDED.phone,
          id_card = EXCLUDED.id_card,
          store_id = EXCLUDED.store_id,
          org_node_id = EXCLUDED.org_node_id,
          position_name = EXCLUDED.position_name,
          birthday = EXCLUDED.birthday,
          is_resigned = EXCLUDED.is_resigned,
          updated_at = now()
      `, [
        empId,
        phone,
        trim(row.name) || empId,
        trim(row.gender),
        trim(row.id_card),
        storeId,
        orgNodeId,
        trim(row.position_name),
        toDateStr(row.birthday),
        toBool(row.is_resigned_raw),
      ])
      count++
    }

    // 清理不再被引用的全局部门节点（挂在总部下但无员工指向的）
    if (hqId) {
      const { rowCount } = await client.query(`
        DELETE FROM org_nodes
        WHERE type = '部门'
          AND parent_id = $1
          AND id NOT IN (SELECT DISTINCT org_node_id FROM staff_wechat_users WHERE org_node_id IS NOT NULL)
      `, [hqId])
      if (rowCount > 0) {
        log('EMPLOYEES', `清理 ${rowCount} 个孤儿全局部门节点`)
      }
    }

    await client.query('COMMIT')
    log('EMPLOYEES', `完成：UPSERT ${count} 条员工`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── 3. 自动推导 permission_roles ──────────────────────────────

async function syncPermissionRoles(pgPool, dryRun) {
  log('PERMISSIONS', '开始自动推导...')

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    // 查询在职员工 + store org_node + department name
    const { rows: emps } = await client.query(`
      SELECT
        e.employee_id,
        e.position_name,
        e.store_id,
        s.org_node_id AS store_org_node_id,
        dept.name     AS dept_name,
        parent_store.parent_id AS market_org_node_id
      FROM staff_wechat_users e
      LEFT JOIN stores s ON e.store_id = s.store_id
      LEFT JOIN org_nodes dept ON e.org_node_id = dept.id
      LEFT JOIN org_nodes parent_store ON s.org_node_id = parent_store.id
      WHERE e.is_resigned = false AND e.employee_id IS NOT NULL
    `)
    log('PERMISSIONS', `在职员工 ${emps.length} 人`)

    if (dryRun) {
      log('PERMISSIONS', '[DRY] 将为在职员工推导权限')
      await client.query('ROLLBACK')
      return
    }

    let count = 0
    for (const emp of emps) {
      const pos = (emp.position_name || '').trim()
      const dept = (emp.dept_name || '').trim()
      const storeScope = emp.store_org_node_id
      const marketScope = emp.market_org_node_id

      if (!storeScope) continue // 无门店归属的员工跳过

      let role = 'staff'
      let scopeId = storeScope

      // 代理经理 → 默认 staff
      if (pos.includes('代理')) {
        role = 'staff'
      } else if (pos === '门店经理') {
        role = 'manager'
      } else if (pos === '市场总监' || pos === '片区经理') {
        role = 'manager'
        scopeId = marketScope || storeScope
      } else if (dept === '财智部') {
        role = 'finance'
      }

      // UPSERT（仅 sync 创建的记录）
      await client.query(`
        INSERT INTO permission_roles (employee_id, role, scope_id, created_by, updated_by)
        VALUES ($1, $2, $3, 'sync', 'sync')
        ON CONFLICT (employee_id, role, scope_id)
        DO UPDATE SET updated_by = 'sync', updated_at = now()
          WHERE permission_roles.created_by = 'sync'
      `, [emp.employee_id, role, scopeId])
      count++
    }

    await client.query('COMMIT')
    log('PERMISSIONS', `完成：推导 ${count} 条权限记录`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── 4. 同步顾客档案（批量优化版） ───────────────────────────────

async function syncCustomers(mssqlPool, pgPool, dryRun) {
  log('CUSTOMERS', '开始同步...')

  const { recordset: rows } = await mssqlPool.request().query(`
    SELECT
      RTRIM(UDF_S_1475) AS customer_id,
      RTRIM(UDF_S_1476) AS name,
      RTRIM(UDF_S_1478) AS phone,
      RTRIM(UDF_S_6443) AS store_name,
      RTRIM(UDF_S_6444) AS bound_employee_id,
      RTRIM(UDF_S_1477) AS member_level,
      RTRIM(UDF_S_6446) AS customer_source,
      RTRIM(UDF_S_1712) AS category,
      UDF_S_1479        AS birthday,
      RTRIM(UDF_S_1481) AS occupation,
      RTRIM(UDF_S_1482) AS is_married_raw,
      RTRIM(UDF_S_6445) AS wechat_name,
      RTRIM(UDF_S_6447) AS skin_type,
      RTRIM(UDF_S_6448) AS improvement_focus,
      RTRIM(UDF_S_19093) AS skin_issue,
      RTRIM(UDF_S_19094) AS wellness_preference
    FROM UDT_S_311
    WHERE UDF_S_1475 IS NOT NULL AND RTRIM(UDF_S_1475) != ''
  `)
  log('CUSTOMERS', `WorkFine 查询到 ${rows.length} 条顾客记录`)

  if (dryRun) {
    log('CUSTOMERS', `[DRY] 将同步 ${rows.length} 条`)
    return
  }

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    // 预加载 stores lookup
    const storesRes = await client.query('SELECT store_id, store_name FROM stores')
    const storeMap = {}
    storesRes.rows.forEach(r => { storeMap[r.store_name] = r.store_id })

    // 1. 创建临时 staging 表
    await client.query(`
      CREATE TEMP TABLE _cust_staging (
        user_id text NOT NULL,
        customer_id text,
        phone text,
        name text,
        bound_store_id text,
        bound_employee_id text,
        member_level text,
        customer_source text,
        category text,
        birthday date,
        occupation text,
        is_married boolean,
        wechat_name text,
        skin_type text,
        improvement_focus text,
        skin_issue text,
        wellness_preference text
      )
    `)

    // 2. 批量插入到 staging 表（每批 500 行）
    const BATCH = 500
    let skipped = 0
    const staged = []

    // 初始化顾客 ID 生成器（FYGK-{YYYYMMDD}-{4位序号}）
    const idGen = createClientIdGenerator()
    await idGen.init(client)

    for (const row of rows) {
      const phone = validPhone(row.phone)
      const customerId = trim(row.customer_id)
      if (!phone && !customerId) { skipped++; continue }

      const storeName = trim(row.store_name)
      staged.push([
        idGen.next(), customerId, phone,
        trim(row.name),
        storeName ? (storeMap[storeName] || null) : null,
        trim(row.bound_employee_id), trim(row.member_level),
        normalizeCustomerSource(row.customer_source), trim(row.category),
        toDateStr(row.birthday), trim(row.occupation),
        toBool(row.is_married_raw), trim(row.wechat_name),
        trim(row.skin_type),
        trim(row.improvement_focus), trim(row.skin_issue),
        trim(row.wellness_preference),
      ])
    }
    log('CUSTOMERS', `准备写入 ${staged.length} 条 staging 数据，跳过 ${skipped} 条`)

    for (let i = 0; i < staged.length; i += BATCH) {
      const batch = staged.slice(i, i + BATCH)
      const placeholders = []
      const values = []
      let paramIdx = 1

      for (const row of batch) {
        const ph = []
        for (const val of row) {
          ph.push(`$${paramIdx++}`)
          values.push(val)
        }
        placeholders.push(`(${ph.join(',')})`)
      }

      await client.query(`
        INSERT INTO _cust_staging (user_id, customer_id, phone, name, bound_store_id,
          bound_employee_id, member_level, customer_source, category,
          birthday, occupation, is_married, wechat_name,
          skin_type, improvement_focus, skin_issue, wellness_preference)
        VALUES ${placeholders.join(',')}
      `, values)

      if ((i + BATCH) % 5000 === 0 || i + BATCH >= staged.length) {
        log('CUSTOMERS', `staging 进度: ${Math.min(i + BATCH, staged.length)}/${staged.length}`)
      }
    }

    // 3-pre. 先按 customer_id 更新已有行（处理 PG 中无 phone 但 WorkFine 新增 phone 的场景）
    // 避免 step 3a INSERT 时触发 customer_id 唯一约束冲突
    const preUpdate = await client.query(`
      UPDATE client_wechat_users c SET
        phone = CASE
          WHEN s.phone IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM client_wechat_users o WHERE o.phone = s.phone AND o.user_id != c.user_id
          ) THEN s.phone
          ELSE c.phone
        END,
        name = s.name, bound_store_id = s.bound_store_id, bound_employee_id = s.bound_employee_id,
        customer_source = CASE WHEN 'customer_source' = ANY(c.workfine_override_fields) THEN c.customer_source ELSE s.customer_source END,
        category = s.category,
        birthday = CASE WHEN 'birthday' = ANY(c.workfine_override_fields) THEN c.birthday ELSE s.birthday END,
        occupation = CASE WHEN 'occupation' = ANY(c.workfine_override_fields) THEN c.occupation ELSE s.occupation END,
        is_married = CASE WHEN 'is_married' = ANY(c.workfine_override_fields) THEN c.is_married ELSE s.is_married END,
        wechat_name = s.wechat_name,
        skin_type = s.skin_type, improvement_focus = s.improvement_focus,
        skin_issue = CASE WHEN 'skin_issue' = ANY(c.workfine_override_fields) THEN c.skin_issue ELSE s.skin_issue END,
        wellness_preference = CASE WHEN 'wellness_preference' = ANY(c.workfine_override_fields) THEN c.wellness_preference ELSE s.wellness_preference END,
        updated_at = now()
      FROM (
        SELECT DISTINCT ON (customer_id) *
        FROM _cust_staging
        WHERE customer_id IS NOT NULL
        ORDER BY customer_id, phone NULLS LAST
      ) s
      WHERE c.customer_id = s.customer_id
    `)
    log('CUSTOMERS', `PRE-UPDATE by customer_id: ${preUpdate.rowCount} 条`)

    // 从 staging 中移除已按 customer_id 更新的行，避免 step 3a 重复处理
    await client.query(`
      DELETE FROM _cust_staging s
      USING client_wechat_users c
      WHERE s.customer_id IS NOT NULL AND s.customer_id = c.customer_id
    `)

    // 3a. 有手机号：UPSERT by phone（去重，不覆盖微信身份字段）
    const upsertByPhone = await client.query(`
      INSERT INTO client_wechat_users AS c (
        user_id, phone, customer_id, name, bound_store_id, bound_employee_id,
        member_level, customer_source, category, birthday, occupation, is_married,
        wechat_name, skin_type, improvement_focus, skin_issue, wellness_preference
      )
      SELECT user_id, phone, customer_id, name, bound_store_id, bound_employee_id,
        member_level, customer_source, category, birthday, occupation, is_married,
        wechat_name, skin_type, improvement_focus, skin_issue, wellness_preference
      FROM (
        SELECT DISTINCT ON (phone) *
        FROM _cust_staging
        WHERE phone IS NOT NULL
        ORDER BY phone, customer_id NULLS LAST
      ) deduped
      ON CONFLICT (phone) WHERE phone IS NOT NULL
      DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        name = EXCLUDED.name,
        bound_store_id = EXCLUDED.bound_store_id,
        bound_employee_id = EXCLUDED.bound_employee_id,
        customer_source = CASE WHEN 'customer_source' = ANY(c.workfine_override_fields) THEN c.customer_source ELSE EXCLUDED.customer_source END,
        category = EXCLUDED.category,
        birthday = CASE WHEN 'birthday' = ANY(c.workfine_override_fields) THEN c.birthday ELSE EXCLUDED.birthday END,
        occupation = CASE WHEN 'occupation' = ANY(c.workfine_override_fields) THEN c.occupation ELSE EXCLUDED.occupation END,
        is_married = CASE WHEN 'is_married' = ANY(c.workfine_override_fields) THEN c.is_married ELSE EXCLUDED.is_married END,
        wechat_name = EXCLUDED.wechat_name,
        skin_type = EXCLUDED.skin_type,
        improvement_focus = EXCLUDED.improvement_focus,
        skin_issue = CASE WHEN 'skin_issue' = ANY(c.workfine_override_fields) THEN c.skin_issue ELSE EXCLUDED.skin_issue END,
        wellness_preference = CASE WHEN 'wellness_preference' = ANY(c.workfine_override_fields) THEN c.wellness_preference ELSE EXCLUDED.wellness_preference END,
        updated_at = now()
    `)
    log('CUSTOMERS', `UPSERT by phone: ${upsertByPhone.rowCount} 条`)

    // 3b. 无手机号但有 customer_id：UPDATE 已存在的行（去重）
    const updateByCustId = await client.query(`
      UPDATE client_wechat_users c SET
        name = s.name, bound_store_id = s.bound_store_id, bound_employee_id = s.bound_employee_id,
        customer_source = CASE WHEN 'customer_source' = ANY(c.workfine_override_fields) THEN c.customer_source ELSE s.customer_source END,
        category = s.category,
        birthday = CASE WHEN 'birthday' = ANY(c.workfine_override_fields) THEN c.birthday ELSE s.birthday END,
        occupation = CASE WHEN 'occupation' = ANY(c.workfine_override_fields) THEN c.occupation ELSE s.occupation END,
        is_married = CASE WHEN 'is_married' = ANY(c.workfine_override_fields) THEN c.is_married ELSE s.is_married END,
        wechat_name = s.wechat_name,
        skin_type = s.skin_type, improvement_focus = s.improvement_focus,
        skin_issue = CASE WHEN 'skin_issue' = ANY(c.workfine_override_fields) THEN c.skin_issue ELSE s.skin_issue END,
        wellness_preference = CASE WHEN 'wellness_preference' = ANY(c.workfine_override_fields) THEN c.wellness_preference ELSE s.wellness_preference END,
        updated_at = now()
      FROM (
        SELECT DISTINCT ON (customer_id) *
        FROM _cust_staging
        WHERE phone IS NULL AND customer_id IS NOT NULL
        ORDER BY customer_id
      ) s
      WHERE c.customer_id = s.customer_id
    `)
    log('CUSTOMERS', `UPDATE by customer_id (无手机号): ${updateByCustId.rowCount} 条`)

    // 3c. 无手机号有 customer_id 但不存在：INSERT 新行（去重）
    const insertNew = await client.query(`
      INSERT INTO client_wechat_users (
        user_id, customer_id, name, bound_store_id, bound_employee_id,
        member_level, customer_source, category, birthday, occupation, is_married,
        wechat_name, skin_type, improvement_focus, skin_issue, wellness_preference
      )
      SELECT s.user_id, s.customer_id, s.name, s.bound_store_id, s.bound_employee_id,
        s.member_level, s.customer_source, s.category, s.birthday, s.occupation, s.is_married,
        s.wechat_name, s.skin_type, s.improvement_focus, s.skin_issue, s.wellness_preference
      FROM (
        SELECT DISTINCT ON (customer_id) *
        FROM _cust_staging
        WHERE phone IS NULL AND customer_id IS NOT NULL
        ORDER BY customer_id
      ) s
      WHERE NOT EXISTS (SELECT 1 FROM client_wechat_users c WHERE c.customer_id = s.customer_id)
    `)
    log('CUSTOMERS', `INSERT 新顾客 (无手机号): ${insertNew.rowCount} 条`)

    await client.query('DROP TABLE _cust_staging')
    await client.query('COMMIT')
    log('CUSTOMERS', `完成：共处理 ${upsertByPhone.rowCount + updateByCustId.rowCount + insertNew.rowCount} 条，跳过 ${skipped} 条`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── 5. 导入品项分类 ─────────────────────────────────────────

async function importProductCategories(mssqlPool, pgPool, dryRun) {
  log('CATEGORIES', '开始导入品项分类...')

  const { recordset: rows } = await mssqlPool.request().query(`
    SELECT
      UDF_M_521       AS sort_order,
      RTRIM(UDF_M_522) AS category_name,
      RTRIM(UDF_M_15996) AS is_valid_raw,
      RTRIM(UDF_M_17416) AS big_category_raw
    FROM UDT_M_229
    WHERE UDF_M_522 IS NOT NULL AND RTRIM(UDF_M_522) != ''
  `)
  log('CATEGORIES', `WorkFine 查询到 ${rows.length} 条`)

  if (dryRun) {
    rows.forEach(r => console.log(`  [DRY] ${r.category_name} (${r.big_category_raw})`))
    return
  }

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    let count = 0
    for (const row of rows) {
      const name = trim(row.category_name)
      if (!name) continue

      const productKind = mapProductKind(trim(row.big_category_raw))
      const catId = hashId('cat', name, productKind)

      await client.query(`
        INSERT INTO product_categories (category_id, category_name, product_kind, sort_order, is_valid)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (category_id) DO UPDATE SET
          category_name = EXCLUDED.category_name,
          product_kind = EXCLUDED.product_kind,
          sort_order = EXCLUDED.sort_order,
          is_valid = EXCLUDED.is_valid,
          updated_at = now()
      `, [catId, name, productKind, row.sort_order || 0, toBool(row.is_valid_raw)])
      count++
    }

    await client.query('COMMIT')
    log('CATEGORIES', `完成：UPSERT ${count} 条品项分类`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** 映射 big_category_raw → product_kind 枚举 */
function mapProductKind(raw) {
  if (!raw) return '护理项目'
  if (raw.includes('充值')) return '充值卡'
  if (raw.includes('家居') || raw.includes('院装')) return '家居产品'
  if (raw.includes('福利') || raw.includes('促销') || raw.includes('活动') || raw.includes('套餐') || raw.includes('组合')) return '组合套餐'
  if (raw.includes('体验')) return '体验卡'
  return '护理项目'
}

/** 映射产品类型（2026-05-21 单品合并：单品 → 疗程卡 1 次，不再产出 '单品'） */
function mapProductType(raw) {
  if (!raw) return '家居产品'
  if (raw.includes('疗程')) return '疗程卡'
  if (raw.includes('单品')) return '疗程卡'
  return '疗程卡'
}

// ─── 6. 导入商品 + 规格 ─────────────────────────────────────

async function importProducts(mssqlPool, pgPool, dryRun) {
  log('PRODUCTS', '开始导入商品...')

  // 6a. 查询各数据源
  const queries = {
    UDT_M_1281: `
      SELECT
        RTRIM(UDF_M_14503) AS wf_item_id,
        RTRIM(UDF_M_14505) AS name,
        RTRIM(UDF_M_14504) AS category_name,
        RTRIM(UDF_M_17783) AS is_shengmei_raw,
        UDF_M_14506 AS session_count,
        UDF_M_14508 AS price,
        RTRIM(UDF_M_14502) AS product_type_raw,
        NULL AS market_scope,
        NULL AS manage_scope
      FROM UDT_M_1281
      WHERE UDF_M_14508 > 0 AND UDF_M_14503 IS NOT NULL AND UDF_M_14505 IS NOT NULL
    `,
    UDT_M_1383: `
      SELECT
        RTRIM(m.UDF_M_14503) AS wf_item_id,
        RTRIM(m.UDF_M_14505) AS name,
        RTRIM(m.UDF_M_14504) AS category_name,
        RTRIM(m.UDF_M_17784) AS is_shengmei_raw,
        m.UDF_M_14506 AS session_count,
        m.UDF_M_14508 AS price,
        RTRIM(m.UDF_M_14502) AS product_type_raw,
        RTRIM(s.UDF_S_15997) AS market_scope,
        RTRIM(s.UDF_S_15997) AS manage_scope
      FROM UDT_M_1383 m
      INNER JOIN UDT_S_1382 s ON m.RID = s.RID
      WHERE m.UDF_M_17415 = '是' AND m.UDF_M_14503 IS NOT NULL AND m.UDF_M_14505 IS NOT NULL
    `,
    UDT_M_341: `
      SELECT
        RTRIM(UDF_M_1870) AS wf_item_id,
        RTRIM(UDF_M_1871) AS name,
        RTRIM(UDF_M_1872) AS spec_name,
        RTRIM(UDF_M_1874) AS category_name,
        UDF_M_1875 AS price,
        RTRIM(UDF_M_7494) AS is_active_raw
      FROM UDT_M_341
      WHERE UDF_M_7494 = '是' AND UDF_M_1870 IS NOT NULL AND UDF_M_1871 IS NOT NULL
    `,
  }

  const wfData = {}
  for (const [source, query] of Object.entries(queries)) {
    try {
      const { recordset } = await mssqlPool.request().query(query)
      wfData[source] = recordset
      log('PRODUCTS', `${source}: ${recordset.length} 条`)
    } catch (err) {
      log('PRODUCTS', `${source} 查询失败: ${err.message}`)
      wfData[source] = []
    }
  }

  // 促销方案
  try {
    const { recordset } = await mssqlPool.request().query(`
      SELECT
        s.RID,
        RTRIM(s.UDF_S_17159) AS scheme_id,
        RTRIM(s.UDF_S_17175) AS scheme_name,
        s.UDF_S_17193        AS scheme_price,
        RTRIM(s.UDF_S_17793) AS market_scope,
        RTRIM(m.UDF_M_17163) AS wf_item_id,
        RTRIM(m.UDF_M_17165) AS item_name,
        m.UDF_M_17171        AS item_price,
        RTRIM(m.UDF_M_17174) AS is_gift_raw,
        m.UDF_M_17167        AS session_count,
        RTRIM(m.UDF_M_17162) AS product_type_raw
      FROM UDT_S_1459 s
      INNER JOIN UDT_M_1460 m ON m.RID = s.RID
      WHERE s.UDF_S_17175 IS NOT NULL AND m.UDF_M_17163 IS NOT NULL
    `)
    wfData.PROMOTIONS = recordset
    log('PRODUCTS', `促销方案: ${recordset.length} 条明细`)
  } catch (err) {
    log('PRODUCTS', `促销方案查询失败: ${err.message}`)
    wfData.PROMOTIONS = []
  }

  if (dryRun) {
    log('PRODUCTS', '[DRY] 预览模式，不写入')
    return
  }

  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')

    // 预加载品项分类 lookup
    const catRes = await client.query('SELECT category_id, category_name, product_kind FROM product_categories')
    const catMap = {} // categoryName → { category_id, product_kind }
    catRes.rows.forEach(r => { catMap[r.category_name] = { id: r.category_id, kind: r.product_kind } })

    // 找到或创建默认分类（无法匹配时使用）
    let defaultCatId = catMap['其他']?.id
    if (!defaultCatId) {
      defaultCatId = hashId('cat', '其他', '护理项目')
      await client.query(`
        INSERT INTO product_categories (category_id, category_name, product_kind, sort_order, is_valid)
        VALUES ($1, '其他', '护理项目', 999, true)
        ON CONFLICT (category_id) DO NOTHING
      `, [defaultCatId])
      catMap['其他'] = { id: defaultCatId, kind: '护理项目' }
    }

    let productCount = 0, skuCount = 0

    // ── 6b. 可售项目（UDT_M_1281 + UDT_M_1383）──
    const serviceItems = [...(wfData.UDT_M_1281 || []), ...(wfData.UDT_M_1383 || [])]

    // 按 (category_name, name) 分组 → 一条 product，不同规格各生成一条 sku
    const productGroups = new Map() // key → { rows, category_name, name, ... }

    for (const row of serviceItems) {
      const name = trim(row.name)
      const catName = trim(row.category_name) || '其他'
      const key = `${catName}||${name}`

      if (!productGroups.has(key)) {
        productGroups.set(key, {
          name,
          categoryName: catName,
          isShengmei: trim(row.is_shengmei_raw) === '生美',
          marketScope: trim(row.market_scope),
          manageScope: trim(row.manage_scope),
          skus: [],
        })
      }
      productGroups.get(key).skus.push(row)
    }

    for (const [key, group] of productGroups) {
      const cat = catMap[group.categoryName] || catMap['其他']
      const catId = cat.id
      const productId = hashId('product', key)

      // 计算标价（取 SKU 最低价）
      const prices = group.skus.map(s => parseFloat(s.price) || 0).filter(p => p > 0)
      const minPrice = prices.length > 0 ? Math.min(...prices) : 0

      await client.query(`
        INSERT INTO products (product_id, category_id, name, is_shengmei, is_bundle, price, sales_category,
          manage_scope, market_scope, sort_order)
        VALUES ($1, $2, $3, $4, false, $5, '自销自耗', $6, $7, 0)
        ON CONFLICT (product_id) DO UPDATE SET
          category_id = EXCLUDED.category_id, name = EXCLUDED.name,
          is_shengmei = EXCLUDED.is_shengmei, price = EXCLUDED.price,
          manage_scope = EXCLUDED.manage_scope, market_scope = EXCLUDED.market_scope,
          updated_at = now()
      `, [productId, catId, group.name, group.isShengmei, minPrice, group.manageScope, group.marketScope])
      productCount++

      // 创建 SKU
      for (const sku of group.skus) {
        const productType = mapProductType(trim(sku.product_type_raw))
        // 疗程卡至少 1 次（原"单品"并入疗程卡=1 次卡）；家居产品无次数
        const sessionCount = productType === '家居产品' ? null : (parseInt(sku.session_count) || 1)
        const specName = sessionCount && sessionCount > 1 ? `${sessionCount}次卡` : '单次体验'
        const skuId = hashId('sku', productId, trim(sku.wf_item_id))

        await client.query(`
          INSERT INTO product_skus (sku_id, product_id, product_type, spec_name, price, session_count, unit, sort_order, service_fee)
          VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = '家居产品' THEN '盒' ELSE '次' END, 0, 0)
          ON CONFLICT (sku_id) DO UPDATE SET
            product_type = EXCLUDED.product_type, spec_name = EXCLUDED.spec_name,
            price = EXCLUDED.price, session_count = EXCLUDED.session_count, unit = EXCLUDED.unit, updated_at = now()
        `, [skuId, productId, productType, specName, parseFloat(sku.price) || 0, sessionCount])
        skuCount++
      }
    }

    // ── 6c. 家居产品（UDT_M_341，WorkFine 原表为"院装产品"）── 每条 1:1 product + sku
    // 优先找 product_kind='家居产品' 的分类，按名称匹配；无匹配则用 '美容耗材' 兜底
    let homeCatId = null
    for (const [, v] of Object.entries(catMap)) {
      if (v.kind === '家居产品') { homeCatId = v.id; break }
    }
    if (!homeCatId) {
      homeCatId = hashId('cat', '美容耗材', '家居产品')
      await client.query(`
        INSERT INTO product_categories (category_id, category_name, product_kind, sort_order, is_valid)
        VALUES ($1, '美容耗材', '家居产品', 10, true)
        ON CONFLICT (category_id) DO NOTHING
      `, [homeCatId])
      catMap['美容耗材'] = { id: homeCatId, kind: '家居产品' }
    }
    for (const row of (wfData.UDT_M_341 || [])) {
      const name = trim(row.name)
      if (!name) continue

      const catName = trim(row.category_name) || '美容耗材'
      // 优先按名称匹配已有分类，否则用 家居产品 类下的兜底分类
      const cat = catMap[catName] || { id: homeCatId }
      const productId = hashId('product', 'home', trim(row.wf_item_id))

      await client.query(`
        INSERT INTO products (product_id, category_id, name, is_bundle, price, sales_category, sort_order)
        VALUES ($1, $2, $3, false, $4, '自销自耗', 0)
        ON CONFLICT (product_id) DO UPDATE SET
          name = EXCLUDED.name, price = EXCLUDED.price, updated_at = now()
      `, [productId, cat.id, name, parseFloat(row.price) || 0])
      productCount++

      const specName = trim(row.spec_name) || '院装'
      const skuId = hashId('sku', productId, trim(row.wf_item_id))
      await client.query(`
        INSERT INTO product_skus (sku_id, product_id, product_type, spec_name, price, unit, sort_order, service_fee)
        VALUES ($1, $2, '家居产品', $3, $4, '盒', 0, 0)
        ON CONFLICT (sku_id) DO UPDATE SET
          spec_name = EXCLUDED.spec_name, price = EXCLUDED.price, unit = EXCLUDED.unit, updated_at = now()
      `, [skuId, productId, specName, parseFloat(row.price) || 0])
      skuCount++
    }

    // ── 6d. 促销方案 → products (is_bundle=true) + product_skus (is_bundle_sku=true) ──
    const promoGroups = new Map() // scheme_id → { name, price, market_scope, items[] }
    for (const row of (wfData.PROMOTIONS || [])) {
      const schemeId = trim(row.scheme_id)
      if (!schemeId) continue

      if (!promoGroups.has(schemeId)) {
        promoGroups.set(schemeId, {
          name: trim(row.scheme_name) || schemeId,
          price: parseFloat(row.scheme_price) || 0,
          marketScope: trim(row.market_scope),
          items: [],
        })
      }
      promoGroups.get(schemeId).items.push(row)
    }

    // 找到或创建组合套餐分类
    let promoCatId = null
    for (const [, v] of Object.entries(catMap)) {
      if (v.kind === '组合套餐') { promoCatId = v.id; break }
    }
    if (!promoCatId) {
      promoCatId = hashId('cat', '组合套餐', '组合套餐')
      await client.query(`
        INSERT INTO product_categories (category_id, category_name, product_kind, sort_order, is_valid)
        VALUES ($1, '组合套餐', '组合套餐', 0, true)
        ON CONFLICT (category_id) DO NOTHING
      `, [promoCatId])
    }

    for (const [schemeId, promo] of promoGroups) {
      const productId = hashId('product', 'promo', schemeId)

      await client.query(`
        INSERT INTO products (product_id, category_id, name, is_bundle, price, market_scope, sales_category, sort_order)
        VALUES ($1, $2, $3, true, $4, $5, '自销自耗', 0)
        ON CONFLICT (product_id) DO UPDATE SET
          name = EXCLUDED.name, price = EXCLUDED.price, market_scope = EXCLUDED.market_scope, updated_at = now()
      `, [productId, promoCatId, promo.name, promo.price, promo.marketScope])
      productCount++

      for (const item of promo.items) {
        const isGift = toBool(item.is_gift_raw)
        const itemPrice = isGift ? 0 : (parseFloat(item.item_price) || 0)
        const productType = mapProductType(trim(item.product_type_raw))
        // 疗程卡至少 1 次（原"单品"并入疗程卡=1 次卡）；家居产品无次数
        const sessionCount = productType === '家居产品' ? null : (parseInt(item.session_count) || 1)
        const specName = trim(item.item_name) || '促销项'
        const skuId = hashId('sku', productId, trim(item.wf_item_id))

        await client.query(`
          INSERT INTO product_skus (sku_id, product_id, product_type, spec_name, price, session_count, unit,
            is_bundle_sku, sort_order, service_fee)
          VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = '家居产品' THEN '盒' ELSE '次' END, true, 0, 0)
          ON CONFLICT (sku_id) DO UPDATE SET
            spec_name = EXCLUDED.spec_name, price = EXCLUDED.price,
            session_count = EXCLUDED.session_count, unit = EXCLUDED.unit, updated_at = now()
        `, [skuId, productId, productType, specName, itemPrice, sessionCount])
        skuCount++
      }
    }

    await client.query('COMMIT')
    log('PRODUCTS', `完成：${productCount} 条商品, ${skuCount} 条规格`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── 验证 ──────────────────────────────────────────────────

async function verify(pgPool) {
  console.log('\n=== 数据验证 ===')
  const tables = [
    'org_nodes', 'stores', 'staff_wechat_users', 'permission_roles',
    'client_wechat_users', 'product_categories', 'products', 'product_skus',
  ]
  for (const t of tables) {
    const { rows } = await pgPool.query(`SELECT count(*) AS cnt FROM ${t}`)
    console.log(`  ${t}: ${rows[0].cnt} 条`)
  }

  // org_nodes 按类型
  const { rows: orgTypes } = await pgPool.query(
    "SELECT type, count(*) AS cnt FROM org_nodes GROUP BY type ORDER BY type"
  )
  console.log('\n  org_nodes 按类型:')
  orgTypes.forEach(r => console.log(`    ${r.type}: ${r.cnt}`))

  // staff_wechat_users 在职/离职（含员工编号的行）
  const { rows: empStatus } = await pgPool.query(
    "SELECT is_resigned, count(*) AS cnt FROM staff_wechat_users WHERE employee_id IS NOT NULL GROUP BY is_resigned"
  )
  console.log('\n  staff_wechat_users 员工状态:')
  empStatus.forEach(r => console.log(`    ${r.is_resigned ? '离职' : '在职'}: ${r.cnt}`))

  // permission_roles 按角色
  const { rows: roles } = await pgPool.query(
    "SELECT role, count(*) AS cnt FROM permission_roles GROUP BY role ORDER BY role"
  )
  console.log('\n  permission_roles 按角色:')
  roles.forEach(r => console.log(`    ${r.role}: ${r.cnt}`))

  // product_categories 按 product_kind
  const { rows: catKinds } = await pgPool.query(
    "SELECT product_kind, count(*) AS cnt FROM product_categories GROUP BY product_kind ORDER BY product_kind"
  )
  console.log('\n  product_categories 按类型:')
  catKinds.forEach(r => console.log(`    ${r.product_kind}: ${r.cnt}`))

  // product_skus 按 product_type
  const { rows: skuTypes } = await pgPool.query(
    "SELECT product_type, count(*) AS cnt FROM product_skus GROUP BY product_type ORDER BY product_type"
  )
  console.log('\n  product_skus 按类型:')
  skuTypes.forEach(r => console.log(`    ${r.product_type}: ${r.cnt}`))
}

// ─── 主函数 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const syncOnly = args.includes('--sync-only')
  const importOnly = args.includes('--import-only')

  console.log('=== WorkFine → PostgreSQL 同步脚本 ===')
  console.log(`模式: ${dryRun ? 'DRY-RUN' : '正式执行'} ${syncOnly ? '(仅同步域)' : ''} ${importOnly ? '(仅导入域)' : ''}\n`)

  let mssqlPool = null
  let pgPool = null

  try {
    // 连接
    console.log('连接 WorkFine SQL Server...')
    mssqlPool = await mssql.connect(MSSQL_CONFIG)
    console.log('✓ MSSQL 连接成功')

    pgPool = new Pool(PG_CONFIG)
    await pgPool.query('SELECT 1')
    console.log('✓ PostgreSQL 连接成功\n')

    // 定期同步域
    if (!importOnly) {
      await syncOrgNodesAndStores(mssqlPool, pgPool, dryRun)
      await syncEmployees(mssqlPool, pgPool, dryRun)
      await syncPermissionRoles(pgPool, dryRun)
      await syncCustomers(mssqlPool, pgPool, dryRun)
    }

    // 一次性导入域
    if (!syncOnly) {
      await importProductCategories(mssqlPool, pgPool, dryRun)
      await importProducts(mssqlPool, pgPool, dryRun)
    }

    // 验证
    if (!dryRun) {
      await verify(pgPool)
    }

    console.log('\n✓ 全部完成!')
  } catch (err) {
    console.error('\n✗ 同步失败:', err)
    process.exit(1)
  } finally {
    if (mssqlPool) await mssqlPool.close()
    if (pgPool) await pgPool.end()
  }
}

// 仅在直接执行时运行：被 require 时不得有副作用（顶层校验同理，见文件头部）
if (require.main === module) main()
