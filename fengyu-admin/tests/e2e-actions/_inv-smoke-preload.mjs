/**
 * 进销存链路冒烟专用 preload。
 *
 * 与 _dc-smoke-preload.mjs 同构：**只 mock getSession**（getSession 读
 * globalThis.__INV_SESSION，impl 在每步前切换供应链/市场/门店三级会话），
 * 保留真实 @/lib/permissions、@/lib/action-scope（scopeSessionToActions 收紧）、
 * @/lib/inventory/access（scope 唯一真相源）与 @/db，对真实 5433 开发库验证：
 *   - 三级链路（报货→采购→发货→入库→配货→收货）的真实 SQL 与 DB 触发器（金额/市场归属）
 *   - scope 隔离与价格档位裁剪
 *
 * 额外 mock：
 *   - server-only        → business.ts/engine.ts 顶部 import，需空模块占位
 *   - @/lib/operation-log → noop（避免测试写审计日志表）
 *   - next/cache、next/navigation → noop / 抛错占位
 */
import { plugin } from 'bun'

plugin({
  name: 'inventory-smoke-mocks',
  setup(build) {
    build.module('server-only', () => ({ exports: {}, loader: 'object' }))
    build.module('@/lib/auth', () => ({
      exports: {
        getSession: async () => globalThis.__INV_SESSION ?? null,
        hasPermission: (s, a) => !!s?.permissions?.actions?.includes(a),
        hasRole: (s, r) => !!s?.roles?.some((x) => x.role === r),
        getRoleLabel: (r) => r,
      },
      loader: 'object',
    }))
    build.module('@/lib/operation-log', () => ({
      exports: {
        logOperation: async () => {},
        logTransition: async () => {},
        logUpdate: async () => {},
        computeChanges: () => null,
      },
      loader: 'object',
    }))
    build.module('next/navigation', () => ({
      exports: {
        redirect: (url) => {
          throw new Error(`NEXT_REDIRECT:${url}`)
        },
        notFound: () => {
          throw new Error('NEXT_NOT_FOUND')
        },
      },
      loader: 'object',
    }))
    build.module('next/cache', () => ({
      exports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn) => fn },
      loader: 'object',
    }))
  },
})
