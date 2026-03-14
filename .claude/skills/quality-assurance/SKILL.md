---
name: quality-assurance
title: Next.js 质量保障
description: >
  Next.js 项目通用 QA 技能——Vitest 单元/集成测试 + Playwright E2E/视觉回归测试 + CI/CD。
  不绑定特定项目代码，示例使用 Next.js 15 通用模式。
  当用户进行 Next.js 项目的测试策略制定、测试编写、E2E 测试、视觉回归、CI 配置时使用，
  帮助团队建立可靠的测试覆盖率与 CI 质量门禁。
metadata:
  author: nvoyager
  version: 2.0.0
---

## 何时使用 / 不适用

**使用：** Next.js 项目的测试策略、单元测试、组件测试、Server Actions 集成测试、E2E 测试、视觉回归测试、CI/CD 配置。

**不适用：**
- 微信小程序测试 → `wx-quality-assurance`
- CloudBase 云函数测试 → `wx-quality-assurance`
- UI 设计 → 各端 UI 技能

---

# §1 测试基础设施

## Vitest 配置模板

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/types.ts', 'src/**/*.stories.tsx'],
      thresholds: { statements: 70, branches: 60, functions: 70, lines: 70 },
    },
  },
})
```

```typescript
// tests/setup.ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
afterEach(() => { cleanup() })
```

## Playwright 配置模板

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : [['html']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
})
```

> **技术选型：** Vitest + happy-dom（单元/集成）、Playwright + chromium only（E2E/视觉回归）。不引入 jsdom、Jest、Cypress、多浏览器矩阵——简化维护成本。

## 文件组织约定

```text
src/
├── components/
│   └── forms/
│       ├── search-input.tsx
│       └── search-input.test.tsx   # 组件测试紧邻源码
├── lib/
│   ├── utils.ts
│   └── utils.test.ts               # 工具函数测试
└── actions/
    ├── order.ts
    └── order.test.ts                # Server Actions 测试
e2e/
├── auth.setup.ts                    # 认证 setup
├── auth.spec.ts                     # E2E 场景
├── crud.spec.ts
└── visual/
    ├── pages.spec.ts                # 视觉回归
    └── pages.spec.ts-snapshots/     # 基线截图（Git 跟踪）
tests/
└── setup.ts                         # Vitest 全局 setup
```

**命名规则：** 单元/组件 `*.test.ts(x)` 同目录、E2E `e2e/*.spec.ts`、视觉回归 `e2e/visual/*.spec.ts`。

## 依赖安装

```bash
# Vitest + Testing Library
npm i -D vitest @vitejs/plugin-react vite-tsconfig-paths \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event \
  happy-dom @vitest/coverage-v8

# Playwright
npm i -D @playwright/test && npx playwright install chromium
```

---

# §2 测试金字塔

```text
        ┌───────────────┐
        │  E2E / 视觉    │  15% — 关键用户旅程 + 截图对比
        ├───────────────┤
        │ Server Actions │  25% — 直接导入 action + 测试 DB
        ├───────────────┤
        │  组件测试       │  20% — Testing Library + RSC 注意事项
        ├───────────────┤
        │  单元测试       │  40% — 工具函数、Zod、类型守卫
        └───────────────┘
```

| 层级 | 占比 | 覆盖目标 | 工具 |
|---|---|---|---|
| 单元测试 | 40% | 纯函数、Zod schema、类型守卫 | Vitest |
| 组件测试 | 20% | 交互行为、条件渲染、表单验证 | Vitest + Testing Library |
| 集成测试 | 25% | Server Actions + 数据库 | Vitest + 测试 DB |
| E2E 测试 | 15% | 用户旅程、视觉回归 | Playwright |

---

# §3 单元测试

## 工具函数

```typescript
// src/lib/format.test.ts
import { describe, it, expect } from 'vitest'
import { formatCurrency, maskPhone } from './format'

describe('formatCurrency', () => {
  it('分转元', () => {
    expect(formatCurrency(10000)).toBe('¥100.00')
    expect(formatCurrency(99)).toBe('¥0.99')
    expect(formatCurrency(0)).toBe('¥0.00')
  })
})

describe('maskPhone', () => {
  it('标准手机号脱敏', () => expect(maskPhone('13812345678')).toBe('138****5678'))
  it('空值安全', () => { expect(maskPhone('')).toBe(''); expect(maskPhone(undefined as any)).toBe('') })
})
```

## Zod Schema

```typescript
// src/lib/schemas.test.ts
import { describe, it, expect } from 'vitest'
import { createOrderSchema } from './schemas'

describe('createOrderSchema', () => {
  const valid = { customerId: 'c001', items: [{ productId: 'p1', quantity: 1, price: 9900 }] }

  it('合法数据通过', () => expect(createOrderSchema.safeParse(valid).success).toBe(true))
  it('空商品列表拒绝', () => expect(createOrderSchema.safeParse({ ...valid, items: [] }).success).toBe(false))
  it('缺少客户 ID 拒绝', () => expect(createOrderSchema.safeParse({ ...valid, customerId: '' }).success).toBe(false))
  it('数量为负数拒绝', () => {
    const data = { ...valid, items: [{ productId: 'p1', quantity: -1, price: 100 }] }
    expect(createOrderSchema.safeParse(data).success).toBe(false)
  })
})
```

## 类型守卫

```typescript
// src/lib/guards.test.ts
import { describe, it, expect } from 'vitest'
import { isNonNullable, isErrorWithMessage } from './guards'

describe('isNonNullable', () => {
  it('过滤 null/undefined', () => {
    expect(isNonNullable(null)).toBe(false)
    expect(isNonNullable(undefined)).toBe(false)
    expect(isNonNullable(0)).toBe(true)
  })
})

describe('isErrorWithMessage', () => {
  it('识别 Error', () => expect(isErrorWithMessage(new Error('x'))).toBe(true))
  it('拒绝非 Error', () => expect(isErrorWithMessage('string')).toBe(false))
})
```

---

# §4 组件测试

**关键原则：**
- 只测 Client Components（`"use client"`），RSC 不可直接 render
- 用 `userEvent` 替代 `fireEvent`（模拟真实交互）
- 按用户可见行为断言，不按实现细节

```typescript
// src/components/forms/search-input.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchInput } from './search-input'

describe('SearchInput', () => {
  it('提交时触发 onSearch', async () => {
    const user = userEvent.setup()
    const onSearch = vi.fn()
    render(<SearchInput onSearch={onSearch} />)
    await user.type(screen.getByLabelText('搜索'), '关键词')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(onSearch).toHaveBeenCalledWith('关键词')
  })
})
```

**条件渲染——`it.each` 模式：**

```typescript
describe('StatusBadge', () => {
  it.each([
    ['pending', '待处理'],
    ['active', '进行中'],
    ['completed', '已完成'],
  ])('状态 %s 渲染正确', (status, label) => {
    render(<StatusBadge status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
```

**表单验证：**

```typescript
describe('LoginForm', () => {
  // 需额外导入：import { render, screen, waitFor } from '@testing-library/react'
  it('空提交显示验证错误', async () => {
    const user = userEvent.setup()
    render(<LoginForm onSubmit={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText(/请输入邮箱/)).toBeInTheDocument())
  })

  it('合法提交调用 onSubmit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)
    await user.type(screen.getByLabelText('邮箱'), 'test@example.com')
    await user.type(screen.getByLabelText('密码'), 'password123')
    await user.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      email: 'test@example.com', password: 'password123',
    }))
  })
})
```

---

# §5 Server Actions 集成测试

直接导入 Server Action 函数，连接测试数据库执行真实 SQL。不 mock 数据库。

## 事务隔离 setup

```typescript
// tests/setup-db.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
export const testDb = drizzle(pool)

export async function setupTestDb() { await migrate(testDb, { migrationsFolder: './drizzle' }) }
export async function teardownTestDb() { await pool.end() }

export async function withTestTransaction<T>(fn: (tx: typeof testDb) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(drizzle(client))
    await client.query('ROLLBACK')
    return result
  } finally { client.release() }
}
```

## Action 测试模板

```typescript
// src/actions/order.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, withTestTransaction } from '../../tests/setup-db'
import { createOrder } from './order'

beforeAll(() => setupTestDb())
afterAll(() => teardownTestDb())

describe('createOrder action', () => {
  it('参数校验失败返回 validationError', async () => {
    const result = await createOrder({}, new FormData())
    expect(result?.errors).toBeDefined()
  })

  it('合法参数创建订单', async () => {
    await withTestTransaction(async (tx) => {
      // 需导入：import { customers } from '@/db/schema'
      const [customer] = await tx.insert(customers).values({ name: '测试客户', phone: '13800000001' }).returning()
      const formData = new FormData()
      formData.set('customerId', customer.id)
      formData.set('items', JSON.stringify([{ productId: 'p1', quantity: 1, price: 9900 }]))
      const result = await createOrder({}, formData)
      expect(result?.errors).toBeUndefined()
    })
  })
})
```

## 权限测试模板

```typescript
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))
import { getSession } from '@/lib/auth'
const mockGetSession = vi.mocked(getSession)

describe('deleteUser（权限控制）', () => {
  it('未登录拒绝', async () => {
    mockGetSession.mockResolvedValue(null)
    expect((await deleteUser('u1')).error).toBe('未授权')
  })
  it('普通用户拒绝', async () => {
    mockGetSession.mockResolvedValue({ user: { role: 'user' } } as any)
    expect((await deleteUser('u1')).error).toBe('权限不足')
  })
  it('管理员允许', async () => {
    mockGetSession.mockResolvedValue({ user: { role: 'admin' } } as any)
    expect((await deleteUser('u1')).error).toBeUndefined()
  })
})
```

---

# §6 Playwright E2E 测试

## 认证 setup

```typescript
// e2e/auth.setup.ts
import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(__dirname, '../.auth/user.json')

setup('认证', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('邮箱').fill('test@example.com')
  await page.getByLabel('密码').fill('password123')
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL('/')
  await page.context().storageState({ path: authFile })
})
```

## CRUD 完整流程

```typescript
// e2e/crud.spec.ts
import { test, expect } from '@playwright/test'

test.describe('订单管理', () => {
  test('创建', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('button', { name: '新建订单' }).click()
    await page.getByLabel('客户').click()
    await page.getByRole('option', { name: /张/ }).click()
    await page.getByRole('button', { name: '提交订单' }).click()
    await expect(page.getByText('创建成功')).toBeVisible()
  })

  test('编辑', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('row').first().getByRole('link', { name: '编辑' }).click()
    await page.getByLabel('备注').fill('测试备注')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('保存成功')).toBeVisible()
  })

  test('删除需确认', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('row').first().getByRole('button', { name: '删除' }).click()
    await page.getByRole('button', { name: '确认' }).click()
    await expect(page.getByText('删除成功')).toBeVisible()
  })
})

test('未认证重定向', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/orders')
  await expect(page).toHaveURL(/\/login/)
  await ctx.close()
})
```

---

# §7 视觉回归测试

使用 Playwright 内置 `toHaveScreenshot()`，无需额外依赖。

```typescript
// e2e/visual/pages.spec.ts
import { test, expect } from '@playwright/test'

test('登录页', async ({ page }) => {
  await page.goto('/login')
  await expect(page).toHaveScreenshot('login.png', { fullPage: true, maxDiffPixelRatio: 0.01 })
})

test('数据表格（遮盖动态内容）', async ({ page }) => {
  await page.goto('/orders')
  await page.getByRole('table').waitFor()
  await expect(page).toHaveScreenshot('orders-table.png', {
    mask: [page.locator('[data-testid="order-date"]'), page.locator('[data-testid="order-id"]')],
  })
})

test('深色模式', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/login')
  await expect(page).toHaveScreenshot('login-dark.png', { fullPage: true })
})
```

**基线管理：**

```bash
npx playwright test e2e/visual --update-snapshots  # 首次/更新基线
npx playwright test e2e/visual                      # 正常对比
```

基线截图 `e2e/visual/*.spec.ts-snapshots/` 纳入 Git。处理误报：字体差异→固定 Docker 镜像、动画→CSS 变量置零、动态数据→`mask` 遮盖。

---

# §8 CI/CD 流水线

```yaml
# .github/workflows/test.yml
name: Test
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

env:
  TEST_DATABASE_URL: postgresql://test:test@localhost:5432/test_db

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: test, POSTGRES_PASSWORD: test, POSTGRES_DB: test_db }
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'npm' }
      - run: npm ci

      # 单元 + 集成测试
      - run: npx vitest run --coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: coverage-report, path: coverage/ }

      # E2E + 视觉回归
      - run: npx playwright install chromium --with-deps
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: playwright-report, path: playwright-report/ }
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: visual-diff, path: test-results/ }
```

**package.json scripts：**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:visual": "playwright test e2e/visual",
    "test:visual:update": "playwright test e2e/visual --update-snapshots",
    "test:all": "vitest run && playwright test"
  }
}
```

---

# §9 断言速查

| 类别 | Vitest | Playwright |
|---|---|---|
| 相等 | `toBe(v)` / `toEqual(deep)` | — |
| 空值 | `toBeNull()` / `toBeDefined()` | — |
| 集合 | `toHaveLength(n)` / `toContain(v)` | — |
| 对象 | `toHaveProperty('k', v)` / `toMatchObject({})` | — |
| 异常 | `toThrow()` / `rejects.toThrow()` | — |
| Mock | `toHaveBeenCalledWith(a)` / `toHaveBeenCalledTimes(n)` | — |
| DOM | `toBeInTheDocument()` / `toHaveTextContent()` / `toBeVisible()` | — |
| 可见 | — | `toBeVisible()` / `toBeHidden()` |
| 文本 | — | `toHaveText('x')` / `toContainText('x')` |
| 路由 | — | `toHaveURL(/p/)` / `toHaveTitle('t')` |
| 截图 | — | `toHaveScreenshot('n.png')` |

---

# §10 测试编写原则

1. **按行为测试，不按实现**——断言用户可观察的结果，不断言内部状态
2. **测试名描述期望行为**——`it('空提交显示验证错误')` 而非 `it('test form')`
3. **Arrange-Act-Assert**——每个测试三段式：准备、执行、断言
4. **每个测试独立**——不依赖其他测试的执行顺序或副作用
5. **避免测试实现细节**——不测 `useState` 值、不测内部方法调用次数
6. **Mock 最少化**——仅 mock 外部依赖，不 mock 被测模块内部
7. **E2E 覆盖关键路径**——登录、核心 CRUD、支付，而非每个按钮

---

## 关联技能

| 技能 | 用途 |
|---|---|
| `wx-quality-assurance` | 微信小程序 + CloudBase 项目的质量保障 |

| `seed-data` | 测试数据初始化（Drizzle + PostgreSQL） |
| `coding` | 编码约束检查 |
