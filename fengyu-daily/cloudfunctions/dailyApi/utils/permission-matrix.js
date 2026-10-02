/**
 * Staff management-view permission lookup.
 *
 * The source of truth is permission_role_definitions.actions, shared at the
 * database level with the admin application. This module intentionally keeps
 * an independent implementation because cloud functions must not share code
 * with the admin application.
 */

const pg = require('../db/pg')

const DATA_CENTER_DASHBOARD = 'data_center:dashboard'
const CACHE_TTL_MS = 30 * 1000

// Matches the current admin DEFAULT_PERMISSION_MATRIX fallback for this action.
const FALLBACK_DASHBOARD_ROLES = ['admin', 'manager', 'finance']

let cache = null

function fallbackRoles() {
  return new Set(FALLBACK_DASHBOARD_ROLES)
}

function parseDashboardRoles(raw) {
  let matrix
  try {
    matrix = JSON.parse(raw)
  } catch (err) {
    console.warn('[permission-matrix] JSON parse failed, fallback to default:', err.message)
    return null
  }

  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    console.warn('[permission-matrix] invalid matrix shape, fallback to default')
    return null
  }

  const roles = new Set()
  for (const [role, actions] of Object.entries(matrix)) {
    if (Array.isArray(actions) && actions.includes(DATA_CENTER_DASHBOARD)) {
      roles.add(role)
    }
  }
  return roles
}

/**
 * Load roles that currently own data_center:dashboard.
 *
 * A successful DB read is cached for 30 seconds. Failed/invalid reads are not
 * cached, matching the admin-side retry behavior.
 */
async function getDashboardRoles() {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.roles

  try {
    const rows = await pg.query(
      `SELECT role_key, actions
         FROM permission_role_definitions`,
    )
    if (!Array.isArray(rows)) throw new Error('invalid role definition result')
    if (rows.length === 0) {
      const roles = fallbackRoles()
      cache = { roles, expiresAt: now + CACHE_TTL_MS }
      return roles
    }

    // value 分支仅保留给滚动发布期间的旧测试桩兼容；生产查询返回 role_key。
    const roles = rows[0]?.value
      ? parseDashboardRoles(rows[0].value)
      : new Set(rows
        .filter((row) => Array.isArray(row.actions) && row.actions.includes(DATA_CENTER_DASHBOARD))
        .map((row) => row.role_key)
        .filter(Boolean))
    if (roles) {
      cache = { roles, expiresAt: now + CACHE_TTL_MS }
      return roles
    }
  } catch (err) {
    console.warn('[permission-matrix] DB read failed, fallback to default:', err.message)
  }

  return fallbackRoles()
}

/**
 * Whether any role binding grants the data center dashboard action.
 * Accepts role binding rows or plain role strings for testability.
 */
async function hasDataCenterDashboard(roleBindings) {
  const dashboardRoles = await getDashboardRoles()
  return (roleBindings || []).some((binding) => {
    const role = typeof binding === 'string' ? binding : binding?.role
    return !!role && dashboardRoles.has(role)
  })
}

function invalidatePermissionMatrixCache() {
  cache = null
}

module.exports = {
  DATA_CENTER_DASHBOARD,
  FALLBACK_DASHBOARD_ROLES,
  hasDataCenterDashboard,
  getDashboardRoles,
  invalidatePermissionMatrixCache,
}
