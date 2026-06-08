---
name: admin-coding
description: |
  Next.js 15 管理后台（fengyu-admin）编码规范与模式参考。
  覆盖 Server Actions、Drizzle ORM 查询、Zod 校验、权限控制、
  Tailwind CSS v4、Vitest 和 Playwright E2E。
  当用户在 fengyu-admin 目录工作，或谈到以下内容时激活：
  admin 页面、管理后台、Server Actions、Drizzle 查询、
  权限矩阵、角色管理、订单管理、员工管理、商品管理、门店管理、
  顾客管理、提成矩阵、优惠券管理、预约管理、服务单管理、
  admin 测试、E2E 测试、Vitest、bun run build、
  表格组件、分页、筛选器、导出、数据看板、审计日志。
metadata:
  title: Next.js 管理后台编码规范
  description_zh: fengyu-admin Server Actions / Drizzle 查询 / 权限 / 测试模式参考
  author: nvoyager
  version: 1.0.0
---

## 何时使用 / 不适用

**使用：** fengyu-admin 下的 Server Actions、页面组件、类型定义、Zod schema、测试编写。
**不适用：** 小程序前端 → `wx-coding` | 云函数 → `wx-coding` | UI 设计 → `wx-ui-design`

---

## S1 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 15 (App Router, RSC, Server Actions) |
| 语言 | TypeScript (strict) |
| 样式 | Tailwind CSS v4 + CSS 变量 |
| ORM | Drizzle ORM（共享 `../db/schema/`） |
| 认证 | JWT (phone + bcrypt + httpOnly cookie `fy-admin-token`) |
| 校验 | Zod |
| 测试 | Vitest (80% 覆盖率门禁) + Playwright E2E |
| 包管理 | Bun |

**常用命令：**

```bash
cd fengyu-admin && bun run dev      # 开发服务器
cd fengyu-admin && bun run build    # TypeScript 类型检查 + 构建
cd fengyu-admin && bun run test     # Vitest 单元/集成测试
cd fengyu-admin && bun run test:e2e # Playwright E2E
```

---

## S2 Server Actions 模式

文件位置：`fengyu-admin/src/actions/*.ts`

### 标准文件头

```typescript
'use server'

import { db } from '@/db'
import { targetTable, relatedTable } from '@db/schema'
import { eq, and, desc, sql, ilike } from 'drizzle-orm'
import type { TargetType } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition, isAdminScope } from '@/lib/permissions'
import { logOperation, logUpdate } from '@/lib/operation-log'
```

### 核心模式

**1. 权限守卫（每个 action 首行）：**

```typescript
export async function listOrders(filters: OrderFilters) {
  const session = await getSession()
  if (!session) throw new Error('未登录')
  requirePermission(session, 'sale_order:list')
  // ...
}
```

**2. 行级范围隔离（WHERE 条件）：**

```typescript
const conditions: SQL[] = [scopeCondition(session, table.storeId)]
// admin 角色无过滤；其他角色按 scopeStoreIds 过滤
```

**3. 标量子查询（避免 N+1）：**

```typescript
const storeNameSq = db.select({ name: stores.storeName })
  .from(stores).where(eq(stores.storeId, orders.storeId))

const rows = await db.select({
  ...getTableColumns(orders),
  storeName: sql<string>`(${storeNameSq})`.as('store_name'),
}).from(orders).where(and(...conditions))
```

**4. 分页标准模式：**

```typescript
const page = Math.max(1, filters.page || 1)
const pageSize = [10, 20, 50].includes(filters.pageSize ?? 10) ? filters.pageSize! : 10
const offset = (page - 1) * pageSize

const [items, [{ count }]] = await Promise.all([
  db.select(...).limit(pageSize).offset(offset),
  db.select({ count: sql<number>`count(*)::int` }).from(table).where(and(...conditions)),
])
return { items: items.map(serialize), total: count, page, pageSize }
```

**5. 序列化函数（Date → ISO string）：**

```typescript
function serializeOrder(row: OrderRow): SaleOrder {
  return {
    ...row,
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  }
}
```

**6. 审计日志（mutation 操作后）：**

```typescript
await logOperation(session, '创建订单', 'sale_orders', newOrder.id)
await logUpdate(session, '修改备注', 'sale_orders', id, { remark: old }, { remark: newVal })
```

**7. 乐观锁（UPDATE 防并发覆盖）：**

```typescript
const result = await db.update(table)
  .set({ ...data, updatedAt: new Date() })
  .where(and(eq(table.id, id), eq(table.updatedAt, prevUpdatedAt)))
if (result.rowCount === 0) throw new Error('数据已被其他人修改，请刷新重试')
```

---

## S3 类型与 Zod 约定

### 类型 (`src/lib/types.ts`)

- Date 字段用 `string`（ISO 格式），不用 `Date`
- 可选的 join 字段用 `?`：`storeName?: string`
- 枚举用联合类型：`status: '待付款' | '已付款' | '已完成'`
- 扁平接口，无基类继承

### Zod Schema (`src/lib/schemas.ts`)

```typescript
// 章节分隔：// ─── 模块名 ───
export const createXxxSchema = z.object({
  phone: z.string().min(1, '请输入手机号').regex(/^1\d{10}$/, '请输入正确的手机号'),
  amount: z.coerce.number().positive('金额必须大于 0'),
  status: z.enum(['待处理', '进行中', '已完成']),
})
export type CreateXxxInput = z.infer<typeof createXxxSchema>
```

- 错误消息用中文
- `z.coerce.number()` 处理 FormData 字符串转数字
- 跨字段校验用 `.refine()`

---

## S4 权限矩阵

6 个角色：`admin | manager | finance | hr | product | customer_mgr`

权限命名：`resource:action`（如 `sale_order:list`、`employee:update`）

```typescript
// src/lib/permissions.ts
export const PERMISSION_MATRIX: Record<RoleType, string[]> = {
  admin: ['dashboard:view', 'org:list', 'org:create', ...],  // 全部权限
  manager: ['dashboard:view', 'store:list', 'customer:list', ...],  // 门店管理
  finance: ['dashboard:view', 'sale_order:list', ...],  // 财务只读+审批
  // ...
}
```

- `requirePermission(session, action)` — 无权限则抛错
- `scopeCondition(session, column)` — admin 无过滤，其他按 scopeStoreIds
- `isAdminScope(session)` — 判断是否全局权限

---

## S5 路由组织

```text
src/app/
├── (auth)/            # 登录/改密（独立布局）
└── (main)/            # 主布局（侧边栏 + 顶栏）
    ├── dashboard/
    ├── orders/        # 订单管理
    ├── services/      # 服务单
    ├── appointments/  # 预约
    ├── allocations/   # 营业额分配
    ├── customers/     # 顾客管理
    ├── employees/     # 员工管理
    ├── products/      # 商品管理
    ├── mall/          # 商城管理
    ├── commission/    # 提成规则
    ├── coupons/       # 优惠券
    ├── org/           # 组织架构
    ├── stores/        # 门店
    ├── permissions/   # 权限
    ├── logs/          # 操作日志
    └── settings/      # 系统设置
```

每个路由：
- `page.tsx` — RSC 数据获取（直接调 Server Action）
- `layout.tsx` — 可选路由级布局
- Client Components 用 `'use client'` 标记

---

## S6 测试模式

### Vitest 单元/集成测试

**覆盖率门禁**：statements/branches/functions/lines 均 >= 80%

```typescript
// src/actions/xxx.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock auth
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
import { getSession } from '@/lib/auth'
const mockSession = vi.mocked(getSession)

describe('listXxx', () => {
  beforeEach(() => {
    mockSession.mockResolvedValue({
      userId: 'test',
      roles: [{ role: 'admin' }],
      permissions: { actions: ['xxx:list'] },
      scopeStoreIds: [],
    })
  })

  it('返回分页数据', async () => {
    const result = await listXxx({ page: 1 })
    expect(result.items).toBeDefined()
    expect(result.total).toBeGreaterThanOrEqual(0)
  })

  it('权限不足拒绝', async () => {
    mockSession.mockResolvedValue(null)
    await expect(listXxx({ page: 1 })).rejects.toThrow('未登录')
  })
})
```

### Playwright E2E 测试

- 认证：cookie-based setup（`.auth/user.json`）
- 超时：60s page / 45s navigation / 15s action
- 仅 Chromium（简化维护）

```typescript
// e2e/xxx.spec.ts
import { test, expect } from '@playwright/test'

test('列表页加载', async ({ page }) => {
  await page.goto('/orders')
  await expect(page.getByRole('table')).toBeVisible()
})
```

### 运行命令

```bash
bun run test              # Vitest（监听模式用 bun run test:watch）
bun run test -- --coverage # 覆盖率报告
bun run test:e2e          # Playwright
bun run test:e2e -- --ui  # Playwright UI 模式
```

---

## S7 样式约定

- Tailwind CSS v4 + `cn()` 工具（clsx + tailwind-merge）
- 品牌主色：`#C0322A`（中国红）
- UI 组件：自建 shadcn/ui 风格（`src/components/ui/`）
- 响应式断点：遵循 Tailwind 默认（sm/md/lg/xl）

---

## S8 陷阱速查

| # | 陷阱 | 修复 |
|---|---|---|
| 1 | Server Action 返回 Date 对象 → 序列化失败 | 用 `serialize()` 转 ISO string |
| 2 | `scopeCondition` 忘记加 → 数据越权 | 每个 list/detail action 必加 |
| 3 | `logOperation` 忘记加 → 审计缺失 | mutation 操作后必加 |
| 4 | FormData 数字字段是 string → 类型错误 | Zod 用 `z.coerce.number()` |
| 5 | 乐观锁 `updatedAt` 不传 → 并发覆盖 | UPDATE WHERE 加 `updated_at = $prev` |
| 6 | seed.ts 枚举值与 schema 不同步 → 类型错误 | 枚举变更后检查 seed `as const` |

---

## 关联技能

| 技能 | 用途 |
|---|---|
| `wx-coding` | 小程序 + 云函数编码 |
| `wx-quality-assurance` | 小程序 + 云函数测试 |
| `seed-data` | 测试数据初始化 |
| `security-review` | 安全审查 |
