/**
 * e2e-inventory-ui/_helpers/seed-accounts.ts
 *
 * 幂等创建 INVT_ACCOUNTS 里的全部库存测试账号（INVT-*，现为 5 个）。dev 库没有 FY-TEST-* 那套 seed，
 * e2e-chains 的 TEST_PHONES 对本库无效，故自建。
 *
 * 三张表缺一不可：
 *   staff_wechat_users  —— 登录按 phone 查 employee_id
 *   admin_passwords     —— bcrypt(cost 12)；must_change 必须 false，否则登录后被
 *                          重定向到 /change-password，spec 的 waitForURL 会失败
 *   permission_roles    —— 受 DB 触发器 trg_permission_roles_validate_scope_type 校验，
 *                          scope_id 指向的 org_nodes.type 必须落在角色的 allowed_scope_types 内
 *
 * 每个账号**只绑一个角色 + 一个 scope**：多绑定会走 inventoryPriceScopeByTier() 的
 * 跨绑定 fail-closed 分支（src/lib/inventory/access.ts:87-117），把价格档打成空集，
 * 让 INV-08 的价格断言全部假阴性。
 */

import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { INVT_ACCOUNTS, INVT_PASS, PG_URL } from './env'

const BCRYPT_COST = 12

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: PG_URL, max: 3 })
  return pool
}

export async function closeSeedPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export interface SeedResult {
  employeeId: string
  phone: string
  role: string
  scopeId: string
  created: boolean
}

/**
 * 幂等 seed 全部账号。已存在则只补齐密码与角色绑定（密码每次重置，
 * 避免历史残留的旧口令导致登录失败 → 触发 login_attempts 5 次锁定）。
 */
export async function seedInventoryAccounts(): Promise<SeedResult[]> {
  const db = getPool()
  const hash = bcrypt.hashSync(INVT_PASS, BCRYPT_COST)
  const results: SeedResult[] = []

  for (const acct of Object.values(INVT_ACCOUNTS)) {
    const existing = await db.query(
      'SELECT 1 FROM staff_wechat_users WHERE employee_id = $1',
      [acct.employeeId],
    )
    const created = existing.rowCount === 0

    // 1) 员工主档。phone 唯一，故 ON CONFLICT 走 employee_id 主键。
    await db.query(
      `INSERT INTO staff_wechat_users (employee_id, name, phone, is_resigned)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (employee_id) DO UPDATE
         SET name = EXCLUDED.name, phone = EXCLUDED.phone, is_resigned = false`,
      [acct.employeeId, acct.name, acct.phone],
    )

    // 2) 密码。must_change=false 是关键 —— true 会把登录重定向到 /change-password。
    await db.query(
      `INSERT INTO admin_passwords (employee_id, password_hash, must_change, last_changed_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (employee_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             must_change = false,
             last_changed_at = NOW()`,
      [acct.employeeId, hash],
    )

    // 3) 角色绑定。先清掉该员工的其他绑定，保证「单角色单 scope」不变量。
    await db.query('DELETE FROM permission_roles WHERE employee_id = $1', [acct.employeeId])
    await db.query(
      `INSERT INTO permission_roles (employee_id, role, scope_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'e2e-inventory-ui', 'e2e-inventory-ui')`,
      [acct.employeeId, acct.role, acct.scopeId],
    )

    results.push({
      employeeId: acct.employeeId,
      phone: acct.phone,
      role: acct.role,
      scopeId: acct.scopeId,
      created,
    })
  }

  // 清掉可能的登录锁定残留：前一轮跑挂时留下的失败计数会让本轮直接被锁。
  await db.query(
    'DELETE FROM login_attempts WHERE phone = ANY($1::text[])',
    [Object.values(INVT_ACCOUNTS).map((a) => a.phone)],
  )

  return results
}

/** 校验 seed 结果：角色绑定确实落库且 scope 类型匹配（触发器没静默吞掉） */
export async function verifyInventoryAccounts(): Promise<Array<{
  employeeId: string
  role: string | null
  scopeId: string | null
  scopeType: string | null
  canAccessAdmin: boolean | null
  hasPassword: boolean
}>> {
  const db = getPool()
  const { rows } = await db.query(
    `SELECT s.employee_id           AS "employeeId",
            r.role                  AS "role",
            r.scope_id              AS "scopeId",
            o.type::text            AS "scopeType",
            d.can_access_admin      AS "canAccessAdmin",
            (p.employee_id IS NOT NULL) AS "hasPassword"
       FROM staff_wechat_users s
       LEFT JOIN permission_roles r ON r.employee_id = s.employee_id
       LEFT JOIN org_nodes o ON o.id = r.scope_id
       LEFT JOIN permission_role_definitions d ON d.role_key = r.role
       LEFT JOIN admin_passwords p ON p.employee_id = s.employee_id
      WHERE s.employee_id LIKE 'INVT-%'
      ORDER BY s.employee_id`,
  )
  return rows
}
