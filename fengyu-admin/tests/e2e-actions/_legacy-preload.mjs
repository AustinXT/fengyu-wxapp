/**
 * bun --preload entry for smoke-legacy-orders.
 *
 * 复用 _admin-preload.mjs 的 admin Server Action mock（auth / permissions /
 * operation-log / next-cache），并额外 mock @/lib/workfine-mssql，使
 * importWorkfineOrdersByCustomer 不依赖外部 SQL Server。
 *
 * mock 的 queryOrdersByCustomerId 在调用时读取 globalThis.__WF_ORDERS，
 * 由 impl 在调用 importWorkfineOrdersByCustomer 前装填。
 */
import './_admin-preload.mjs'
import { plugin } from 'bun'

plugin({
  name: 'legacy-workfine-mock',
  setup(build) {
    build.module('@/lib/workfine-mssql', () => ({
      exports: {
        searchCustomersByPhone: async () => globalThis.__WF_CUSTOMERS ?? [],
        searchCustomerByCustomerId: async () => globalThis.__WF_CUSTOMER ?? null,
        queryOrdersByCustomerId: async () => globalThis.__WF_ORDERS ?? [],
      },
      loader: 'object',
    }))
  },
})
