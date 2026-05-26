/**
 * 数据中心 scope 冒烟专用 preload。
 *
 * 与 _admin-preload.mjs 的关键区别：**只 mock getSession**（可切换 session，用于多角色 scope 测试），
 * 保留真实 @/lib/permissions（isAdminScope / expandVisibleMarketIds / requirePermission）
 * 与 @/lib/data-center/*（scopeFilterSql / prepareBoardContext），以便对真实库验证 scope 隔离。
 *
 * getSession 返回 globalThis.__DC_SESSION（impl 在每个用例前设置）。
 * next/navigation.redirect 仅在 session 为 null 时被 requirePermission 调用（本冒烟不触发），mock 成抛错占位。
 */
import { plugin } from 'bun'

plugin({
  name: 'dc-scope-smoke-mocks',
  setup(build) {
    build.module('@/lib/auth', () => ({
      exports: {
        getSession: async () => globalThis.__DC_SESSION ?? null,
        hasPermission: (s, a) => !!s?.permissions?.actions?.includes(a),
        hasRole: (s, r) => !!s?.roles?.some((x) => x.role === r),
        getRoleLabel: (r) => r,
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
