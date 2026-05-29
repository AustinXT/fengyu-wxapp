/**
 * bun --preload entry: install mocks for admin Server Action dependencies before
 * any admin module loads.
 *
 * Mocked:
 *   - @/lib/auth          → getSession returns test admin session
 *   - @/lib/permissions   → requirePermission noop, isInScope true, scopeCondition undef
 *   - @/lib/operation-log → logOperation / logTransition noop
 *   - next/cache          → revalidatePath / revalidateTag noop
 *
 * 不能让 admin 通过这些路径调到真实 Next.js Server Action context（cookies/redirect 都用不了）。
 */
import { plugin } from 'bun'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

const SESSION = {
  employeeId: process.env.TEST_ADMIN_EMP_ID || 'TE2A_MGR',
  name: '测试店长',
  phone: '19999088001',
  roles: [{ role: 'manager', scopeId: 'TEST', scopeType: '门店' }],
  permissions: {
    actions: [
      'sale_order:create', 'sale_order:update', 'sale_order:record_payment',
      'sale_order:read', 'sale_order:close', 'sale_order:confirm_offline',
      'sale_order:refund_create', 'sale_order:refund_approve',
    ],
    scopeStoreIds: [process.env.TEST_STORE_ID || 'TE2A_STORE'],
  },
}

plugin({
  name: 'admin-e2e-mocks',
  setup(build) {
    // mock @/lib/auth
    build.module('@/lib/auth', () => ({
      exports: {
        getSession: async () => SESSION,
        hasPermission: () => true,
        hasRole: () => true,
        getRoleLabel: (r) => r,
      },
      loader: 'object',
    }))
    // mock @/lib/permissions
    build.module('@/lib/permissions', () => ({
      exports: {
        requirePermission: () => {},
        requireAnyPermission: () => {},
        isInScope: () => true,
        scopeCondition: () => undefined,
        hasPermission: () => true,
        PERMISSION_MATRIX: {},
      },
      loader: 'object',
    }))
    // mock @/lib/operation-log
    build.module('@/lib/operation-log', () => ({
      exports: {
        logOperation: async () => {},
        logTransition: async () => {},
        logUpdate: async () => {},
        computeChanges: () => null,
      },
      loader: 'object',
    }))
    // mock next/cache
    build.module('next/cache', () => ({
      exports: {
        revalidatePath: () => {},
        revalidateTag: () => {},
        unstable_cache: (fn) => fn,
      },
      loader: 'object',
    }))
  },
})
