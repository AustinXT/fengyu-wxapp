# Ticket: admin Server Action 抽统一鉴权 HOF（withPermission wrapper）

> **v2 修订摘要（2026-05-17 R2 复核后）**
>
> - **S1 升为强制门禁**：`positions.ts` 单文件改造后**必须**跑 `bun run build` + e2e 验证 Next.js 15 `'use server'` 与 `export const = withPermission(...)` 真能协同；**不通过则整 ticket 作废**，改走「方案 B：codemod 注入路径」（不抽 HOF，改在每个 action 顶部自动插 `requirePermission(...)` + lint 强制）。详见 §3 顶部「整体回退方案 B」。
> - **S3 工期重估为 3–5 天**（原 1–2 天严重低估），拆分为 S3a（HOF 代码迁移）/ S3b（18 个 action 测试文件全量改 mock + 调用 arity）。
> - **S4 显式处理 `getSessionFromCookie` vs `getSession` 差异**：`resetEmployeePassword` / `resetToDefaultPassword` 当前用 `getSessionFromCookie()`（auth.ts:227,274），HOF 草案用 `getSession()`（lib/auth.ts:12）——迁移时需统一为 `getSession`（推荐）或在 HOF 内显式注入 `getSessionFromCookie` 入口变体。
> - **lint 规则补 AST 正向校验**：原 `ExportNamedDeclaration > FunctionDeclaration[async=true]` 只能强制改写形态、无法验"是否真的调用了 HOF"。补正向规则示例：`VariableDeclarator[init.type="CallExpression"][init.callee.name=/^(withPermission|withAnyPermission)$/]` 必须匹配；不匹配则 error。
> - **HOF 实现 import 路径修正**：必须 `from '@/lib/permissions'`（不是 `@/lib/auth`），否则触发 PR-Z2 commit `8a30454` 加的 `no-restricted-imports` 守卫。原 §2.1 草案 import 写错了。
> - **AST CI 扫描升为整体回退方案 B 的一部分**：`scripts/audit-action-wrapper.mjs` 不再只是 lint 选择器失败时的兜底，而是 HOF 路径整体走不通时的**完整替代方案**（codemod 注入 + AST CI 守护）。
>
> ---
>
> 生成日期：2026-05-17
> 严重级别：P0（安全 / 默认安全 / 防漏写）
> 端：fengyu-admin（管理后台，**唯一影响面**）
> 影响面：`fengyu-admin/src/lib/permissions.ts`（HOF 新增）+ `fengyu-admin/src/actions/*.ts`（25 文件、171 个 export async function、208 处现有 `requirePermission` 调用）+ 18 个 action 测试文件（全量改 mock + 调用 arity）+ ESLint 守卫规则
> 修复成本：M-L（4–7 天，含测试迁移）
> 前置：无；commit `8a30454`（PR-Z2 hasPermission 模块归属重整）已先把 `hasPermission` / `requirePermission` / `requireAnyPermission` 全部归到 `@/lib/permissions`，并加了 `no-restricted-imports` 反向守卫——本 ticket 在此基础上抽 HOF
> 并行：可与其他 admin P1/P2 并行；与 `2026-04-24-admin-list-default-ordering.md` 互不冲突
> 来源：`SUMMARY.md v3 Top P0 #4` + audit `P0-CC4-02`
>
> **一句话目标**：admin 端 171 个 Server Action 当前靠"每个函数自觉调一次 `requirePermission`"维持鉴权——208 处显式调用 + `auth.ts` 已发现 2 处用手写 `isAdmin` 旁路（绕过统一拦截）；抽一个 `withPermission(action, fn)` HOF 把"`getSession` + 鉴权 + 调用业务函数"封装成一行声明式签名，并配 ESLint 规则强制 `actions/**/*.ts` 的 export 必须经由该 HOF，让"漏写鉴权"在 lint 阶段就 fail。

---

## 0 一句话背景

`fengyu-admin/src/lib/permissions.ts` 提供了三段式鉴权工具——`requirePermission(session, action)` / `requireAnyPermission(session, actions[])` / `hasPermission(session, action)`，每个 Server Action 必须**手动**：

```ts
export async function createPosition(data: { ... }) {
  const session = await getSession()
  requirePermission(session, 'employee:update')   // ← 漏一行就 0 鉴权
  // ... 业务逻辑
}
```

这条样板代码当前在 25 个 action 文件、171 个 export 上重复了 208 次。问题不在样板本身，而在：

1. **没有强制约束**：新增一个 action 漏写 `requirePermission` 不会有任何编译/lint 报错——只有人肉 review 拦截，cc4 审计已发现 `auth.ts` 中 2 处旁路（用手写 `isAdmin` 替代 requirePermission，分别在 `resetEmployeePassword` 和 `resetToDefaultPassword`）
2. **action 名 + permission 名分离**：函数名 `createPosition` 和 permission 字符串 `'employee:update'` 没有强关联，rename 时容易漂移
3. **session 命名/获取重复**：208 处都是 `const session = await getSession()`，HOF 抽完省 ~250 行样板

commit `8a30454`（2026-05-17）刚做完模块归属重整（`hasPermission` 从 `@/lib/auth` 搬到 `@/lib/permissions`），并加了 `no-restricted-imports` 反向守卫——抽 HOF 是这次重整的**下一步自然延续**，不是另起炉灶。

---

## 1 现状统计

### 1.1 调用分布（grep 实证，2026-05-17）

```bash
grep -rn "requirePermission\|requireAnyPermission" fengyu-admin/src/actions/ \
  | grep -v test | wc -l
# → 208 处显式调用

grep -rln "requirePermission\|requireAnyPermission" fengyu-admin/src/actions/ \
  | grep -v test | wc -l
# → 25 个文件

grep -c "^export async function" fengyu-admin/src/actions/*.ts \
  | grep -v test | awk -F: '{s+=$2} END {print s}'
# → 171 个 exported async function
```

按文件分布（Top 10）：

| 文件 | 鉴权调用数 |
|---|---|
| `products.ts` | 36 |
| `coupons.ts` | 14 |
| `customers.ts` | 13 |
| `orders.ts` | 11 |
| `services.ts` | 10 |
| `settings.ts` / `refunds.ts` / `permissions.ts` / `employees.ts` | 8 each |
| `messages.ts` | 7 |
| `skill-tags.ts` / `positions.ts` / `commission.ts` / `appointments.ts` | 6 each |

剩余 13 个文件各有 2–5 处调用。

### 1.2 漏写或旁路（cc4 审计样本）

跑以下 grep 可发现"export 数 > 鉴权调用数"的文件：

```bash
cd fengyu-admin && for f in src/actions/*.ts; do
  [[ "$f" == *.test.ts ]] && continue
  exports=$(grep -c "^export async function" "$f")
  perms=$(grep -c "requirePermission\|requireAnyPermission" "$f")
  if [ "$exports" -gt "$perms" ]; then echo "$f exports=$exports perms=$perms"; fi
done
# → src/actions/auth.ts exports=7 perms=0
```

`auth.ts` 是合理特例（`login` / `logout` / `getSessionFromCookie` / `checkMustChange` 是无 session 入口），但其中：

- **`resetEmployeePassword` (auth.ts:223–266)**：用 `session.roles.some(r => r.role === 'admin')` 手写判定 + 返回 `{ success: false, message: '仅系统管理员可重置密码' }`，**没经过 `requirePermission`**——这违反了"权限不足必须 throw `PERMISSION_DENIED:` 错误"的约定（`fengyu-admin/CLAUDE.md` 错误前缀规范）
- **`resetToDefaultPassword` (auth.ts:271–323)**：同上模式，同样的旁路

这 2 处的语义本应是"`auth:reset_password` 权限"，但 `PERMISSION_MATRIX` 里**没这个 permission key**——直接退化为字符串"admin 角色"判断。该模式一旦被新人参考复制到其他 action，鉴权矩阵就会出现大量"半显式半隐式"混用。

> **不严苛要求穷举**——cc4 是抽样审计；本 ticket 的目标是从机制上消除"新增 action 漏鉴权"的可能，而非把已有 2 处漏调当作核心修复对象。

### 1.3 已有 HOF？

```bash
grep -rn "withPermission\|withApiResponse\|withAuth" fengyu-admin/src/
# → 0 hit
```

**当前不存在任何统一鉴权 wrapper**。所有鉴权都是 inline 模式。

### 1.4 PR-Z2 模块归属重整（commit 8a30454, 2026-05-17）做了什么

```
refactor(admin): PR-Z2 admin 拿回 refund_approve + hasPermission 模块归属重整
- PERMISSION_MATRIX: admin 增补 sale_order:refund_approve
- hasPermission 从 @/lib/auth 搬到 @/lib/permissions
  （auth 只留身份相关 hasRole/getRoleLabel）
- eslint no-restricted-imports 反向守卫同步更新
- 5 个调用点改 import
```

`fengyu-admin/eslint.config.mjs` 已配 `no-restricted-imports`：

- 从 `@/lib/auth` 进口 `hasPermission` / `requirePermission` / `requireAnyPermission` / `scopeCondition` / `isAdminScope` / `isInScope` / `PERMISSION_MATRIX` / `buildScopeWhere` / `computeActions` / `expandScopeStoreIds` → error
- 从 `@/lib/permissions` 进口 `hasRole` / `getRoleLabel` → error

这一层守卫解决了"进错门"的 TypeError 风险，但**没解决"根本忘记进门"的零鉴权风险**——本 ticket 要补的就是这一层。

---

## 2 设计目标

### 2.1 HOF 签名草案

> **import 路径修正（R2）**：`requirePermission` / `requireAnyPermission` 必须 `from '@/lib/permissions'`——这是 PR-Z2 commit `8a30454` 模块归属重整后的唯一合法入口；从 `@/lib/auth` import 会被 `no-restricted-imports` 守卫直接 ban。`getSession` 仍从 `@/lib/auth` import（auth.ts:12 是其唯一定义入口）。

```ts
// fengyu-admin/src/lib/with-permission.ts (新文件，或并入 permissions.ts)
import { getSession } from '@/lib/auth'                                // 身份入口
import { requirePermission, requireAnyPermission } from '@/lib/permissions' // 鉴权入口（PR-Z2 后唯一合法位置）
import type { AuthSession } from '@/lib/types'

/**
 * 包装一个 Server Action：先 getSession + requirePermission，再调业务函数。
 * 业务函数收到非空 AuthSession 作为第一参数。
 *
 * 用法：
 *   export const createPosition = withPermission('employee:update', async (
 *     session,
 *     data: { name: string; sortOrder: number },
 *   ) => {
 *     // session 已保证非空 + 已通过鉴权
 *     await db.insert(positions).values({ ...data })
 *     await logOperation(session, 'positions.create', 'position', '', data)
 *     return { success: true }
 *   })
 */
export function withPermission<Args extends unknown[], R>(
  action: string,
  fn: (session: AuthSession, ...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const session = await getSession()
    requirePermission(session, action) // throws PERMISSION_DENIED: 或 redirect /login
    return fn(session, ...args)
  }
}

/**
 * OR 关系版本：拥有 actions 中任一即可。
 * 用于退款详情、订单详情等"业务+审批"两类角色都能进的页面。
 */
export function withAnyPermission<Args extends unknown[], R>(
  actions: string[],
  fn: (session: AuthSession, ...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const session = await getSession()
    requireAnyPermission(session, actions)
    return fn(session, ...args)
  }
}
```

### 2.2 与 `scopeCondition` / `isInScope` / `hasPermission` 的关系

- `scopeCondition(session, table.col)` —— 业务函数体内**仍按需调用**，HOF 不接管 scope 过滤（每个 action 用到的 scope 字段不同，无法统一）
- `isInScope(session, storeId)` —— 同上，业务体内按需
- `hasPermission(session, 'xxx')` —— 用于"看到某 UI 区块但不做强 throw"的软判定（如 `canListAllocations`），不属 HOF 接管范围

> HOF 只接管"入口拦截"。一旦进入 fn 体内，原有 `scopeCondition` / `isInScope` / `hasPermission` 用法**完全不变**，零迁移成本。

### 2.3 错误语义保持一致

- `requirePermission` 内部 `redirect('/login?expired=1')`（session=null）+ `throw new Error('PERMISSION_DENIED: 无权执行 xxx')`（无权限）
- HOF 不吞错、不转换；Server Action 边界仍按现有 Next.js Server Action 错误模型处理
- `try/catch` 在业务体内的现有代码无需调整

### 2.4 与现有"非鉴权 action"的兼容

- `auth.ts` 中 `login` / `logout` / `getSessionFromCookie` / `checkMustChange` 是无 session 入口 → **不套 HOF**，在 lint 规则里 allowlist
- `dashboard.ts` 等 `requirePermission(session, 'dashboard:view')` 之外还需要 `hasRole(session, 'admin')` 分支判断的：业务体内继续判，HOF 只管入口
- `resetEmployeePassword` / `resetToDefaultPassword` —— 借本次迁移**修复**为 `withPermission('employee:update', ...)` 或在 `PERMISSION_MATRIX` 新增 `'admin:reset_password'`（推荐后者，语义更清晰）

---

## 3 迁移策略

### 3.0 整体回退方案 B（HOF 路径失败时启用）

**触发条件**：S1 在 `positions.ts` 单文件改造后跑 `bun run build` 或 e2e **任一不通过**——说明 Next.js 15 `'use server'` 文件不能稳定支持 `export const xx = withPermission(...)` 这种 HOF 表达式形态（RSC bundler 对 server reference 的注册可能解析失败）。

> **背景实证（R2 复核）**：现仓库 27 个 `actions/*.ts` 文件中**0 处**使用 `export const xx = async (...)` 模式，全部是 `export async function`——HOF 形态完全未经 Next.js 15 RSC 验证，存在 client → server reference 解析失败导致全部 action 调用挂掉的风险。

**方案 B（codemod 注入路径）核心要点**：
1. **不抽 HOF**——保留 `export async function` 形态，避开 Next.js 15 server reference 注册的歧义区
2. 写 `scripts/codemod-inject-permission.mjs`：基于 AST 在每个 action 函数体首行**自动注入** `const session = await getSession(); requirePermission(session, '<action:key>');` 双行样板（action:key 从函数名或 JSDoc tag 推断 + 人工 review）
3. 写 `scripts/audit-action-wrapper.mjs`：CI 阶段跑 AST 扫描，强制每个 `export async function` 的 body 第一条 statement 必须是 `requirePermission()` / `requireAnyPermission()` 调用；缺失则 fail build
4. 18 个 test 文件**零改动**——业务函数签名不变（`createPosition(args)`），原 `vi.mock('@/lib/permissions', ...)` 模式继续生效
5. `auth.ts` 2 处旁路同样通过 codemod 修复 + `PERMISSION_MATRIX` 新增 `admin:reset_password`

**方案 B 优势**：零运行时风险（不依赖 Next.js HOF + server reference 兼容性）、测试零改动、回退到原状只需 revert codemod 提交
**方案 B 劣势**：仍保留 208 行样板代码（HOF 的 DX 收益丢失），但"漏写鉴权"由 AST CI 守护——核心安全目标达成

---

### 3.1 HOF 路径（主方案）的两个候选：

### 方案 A：bigbang 一次性切换全部 171 action

**优点**：一个 PR 跑通，统一时间点，迁移完成后立即开 lint 规则强制
**缺点**：diff ≈ 25 个文件 ×（删 2 行 + 改函数签名）= ~700 行机械改动；单 PR review 体验差；冲突面大

### 方案 B：渐进逐模块迁移 + 早期开 lint 守护（推荐）

**优点**：
- 早期就开"新增 action 必须用 HOF"的 lint warn → error 渐进强制，新增代码 0 漏调
- 旧代码按模块（products / coupons / orders / ...）逐 PR 迁移，每个 PR diff 可控（~30 行）
- 每个 PR 独立可 review、可回滚
- 不阻塞业务迭代

**缺点**：迁移周期跨 1-2 周

**推荐渐进方案**，分阶段执行：

| Stage | 内容 | 工期 |
|---|---|---|
| **S1（门禁）** | 抽 `withPermission` / `withAnyPermission` HOF + 单元测试 + 在 1 个示范模块（`positions.ts`，6 个 export，最小）迁移。**强制门禁**：必须跑 `bun run build`（验证 Next.js 15 `'use server'` + `export const = HOF(...)` 真能编译为合法 server reference）+ `bun run test:e2e` 中至少 1 个用到 positions action 的 spec 全绿。**任一不通过 → 立即切方案 B（§3.0 codemod 注入路径）**，本 ticket S2–S5 作废 | 0.5–1 天 |
| S2 | 开 ESLint 规则**仅 warn**（新增代码提示），含 §4.3 正向 AST 校验（HOF 调用名白名单）；更新 `fengyu-admin/CLAUDE.md` 写出新写法范式 | 0.5 天 |
| **S3a** | 按"export 数从少到多"逐文件迁移 HOF：positions(6) → skill-tags(6) → commission(6) → appointments(6) → org(5) → stores(5) → store-unbind(4) → cards(3) → logs(3) → ... → products(36)。**仅改业务代码** | 1.5–2.5 天 |
| **S3b** | **全量改 18 个 action 测试文件**：每个 `vi.mock('@/lib/permissions', ...)` 模式要么改为 mock `@/lib/with-permission` 的 HOF 让其 passthrough、要么改测试调用 arity 从 `createPosition(args)` → `createPosition.__inner(mockSession, args)`（如 HOF 暴露内部入口）。**严重低估警告**：测试连锁改动量是 18 个文件 × 每文件 5–10 个 spec = 100+ 处 mock/调用改写，原 ticket 列为 "同步迁单元测试" 完全不够 | 1.5–2.5 天 |
| S4 | `auth.ts` 中 2 处旁路修复：`resetEmployeePassword` (auth.ts:223–266) / `resetToDefaultPassword` (auth.ts:271–323) 走 HOF + `PERMISSION_MATRIX` 新增 `admin:reset_password`。**显式处理 session 入口差异**：原 2 处用 `getSessionFromCookie()`（auth.ts:227,274），HOF 默认用 `getSession()`（lib/auth.ts:12）——**统一为 `getSession`**（推荐，HOF 内部统一调用即可，行为等价），或在 HOF 提供 `withPermissionFromCookie(...)` 变体保留差异。S4 PR 描述必须明确选择哪一种方案并说明理由 | 0.5 天 |
| S5 | ESLint 规则从 warn 升 error；CI 校验全绿；删除原 `getSession + requirePermission` 双行样板 grep 应为 0 | 0.25 天 |

**总工期重估：4–7 天**（原 ticket "1–3 天" 漏算了 S3b 测试迁移 + S1 build 验证，已修正）。

---

## 4 详细 patch

### 4.1 新增 `fengyu-admin/src/lib/with-permission.ts`

见 §2.1 签名草案。

### 4.2 迁移示范（`positions.ts` 前后对比）

**Before**：
```ts
export async function createPosition(data: {
  name: string
  sortOrder: number
}) {
  const session = await getSession()
  requirePermission(session, 'employee:update')

  await db.insert(positions).values({ ...data })
  await logOperation(session, 'positions.create', 'position', '', data)
  return { success: true }
}
```

**After**：
```ts
export const createPosition = withPermission(
  'employee:update',
  async (session, data: { name: string; sortOrder: number }) => {
    await db.insert(positions).values({ ...data })
    await logOperation(session, 'positions.create', 'position', '', data)
    return { success: true }
  },
)
```

类型保持完全推导（HOF 返回 `(...args: Args) => Promise<R>`，签名等价）；调用方代码（页面 / form）零改动。

### 4.3 ESLint 规则草案

新增 `fengyu-admin/eslint.config.mjs` 一条 custom 规则（基于 `no-restricted-syntax` AST 选择器）：

```js
{
  files: ['src/actions/**/*.ts'],
  ignores: [
    'src/actions/**/*.test.ts',
    'src/actions/auth.ts',          // login/logout/getSession 等公共入口
  ],
  rules: {
    'no-restricted-syntax': ['error', {
      // 禁止：export async function xxx()
      // 必须用 export const xxx = withPermission(...) 或 withAnyPermission(...)
      selector: 'ExportNamedDeclaration > FunctionDeclaration[async=true]',
      message:
        'Server Actions must be wrapped with withPermission(...) or withAnyPermission(...). ' +
        'Use: export const myAction = withPermission("action:key", async (session, ...args) => { ... })',
    }],
  },
}
```

**正向 AST 校验（必须实装，不是可选）**：原仅靠 `ExportNamedDeclaration > FunctionDeclaration[async=true]` 是**结构性 ban**——只强制改写 export 形态，**不真正验证鉴权**。例如 `export const foo = async (...) => { /* 无 withPermission */ }` 仍能通过；这等于把核心守卫留作 TODO。

R2 复核要求必须补上正向规则，AST 选择器示例：

```js
{
  files: ['src/actions/**/*.ts'],
  ignores: ['src/actions/**/*.test.ts', 'src/actions/auth.ts'],
  rules: {
    'no-restricted-syntax': ['error',
      // 规则 1（反向）：禁止裸 export async function
      {
        selector: 'ExportNamedDeclaration > FunctionDeclaration[async=true]',
        message: 'Server Actions must be wrapped with withPermission(...) or withAnyPermission(...).',
      },
      // 规则 2（正向）：export const xxx = <非 HOF 调用> → error
      // 匹配「init 不是 CallExpression，或 callee.name 不在白名单」的 VariableDeclarator
      {
        selector:
          'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type!="CallExpression"]',
        message: 'Exported Server Action must be initialized by calling withPermission/withAnyPermission.',
      },
      {
        selector:
          'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type="CallExpression"][init.callee.type="Identifier"][init.callee.name!=/^(withPermission|withAnyPermission)$/]',
        message: 'Exported Server Action initializer must be withPermission or withAnyPermission.',
      },
    ],
  },
}
```

**核心要点**：第 3 条规则用 `init.callee.name` 白名单（`withPermission` | `withAnyPermission`），从 AST 层面验证"调用了 HOF"——这才是真正的鉴权守卫。没有这条规则，lint 等于只改形态不防漏。

`auth.ts` 必须 ignore（公共入口 `login` / `logout` / `getSessionFromCookie` / `checkMustChange`），其余文件如果出现 `login` 类无 session action 也可 allow-by-name。

### 4.4 `auth.ts` 旁路修复

```ts
// PERMISSION_MATRIX.admin 新增
'admin:reset_password',

// auth.ts:223
export const resetEmployeePassword = withPermission(
  'admin:reset_password',
  async (session, employeeId: string, newPassword: string) => {
    // ... 现有 UPSERT 逻辑
    // 旧的 isAdmin check 删除
  },
)

// auth.ts:271 同上
export const resetToDefaultPassword = withPermission(
  'admin:reset_password',
  async (session, employeeId: string) => {
    // ... 现有逻辑
  },
)
```

返回值约定调整：原"非 admin 返回 `{ success: false, message: '仅系统管理员可重置密码' }`"改为 `requirePermission` throw `PERMISSION_DENIED:`——这是**统一错误前缀**，与其他 action 一致；调用方的 try/catch 需顺带核对。

### 4.5 更新文档

- `fengyu-admin/CLAUDE.md`：
  - "架构要点"里新增一行 "**所有 Server Action 必经 `withPermission` HOF**：lint 强制"
  - 新增"Server Actions 写法范式"小节，给出 §4.2 的 Before/After 对比
- `.42cog/dev/admin.sys.spec.md`：加一节"权限拦截层"说明 HOF 是唯一鉴权入口

---

## 5 验证 Checklist

- [ ] `bun run lint` 0 报错、0 新增 warn（开 lint 规则后 baseline）
- [ ] `bun run test`（Vitest 537 用例）全绿；HOF 本身新增 unit test：成功路径 / session=null redirect / permission 不足 throw / `withAnyPermission` OR 关系（覆盖率不跌破现有阈值 80%）
- [ ] `npx tsc --noEmit` 0 类型错误（HOF 泛型 `Args extends unknown[]` 要保证不丢推导）
- [ ] `bun run test:e2e`（21 spec）全绿——尤其 link-4 退款审批（用到 `requireAnyPermission` 双角色）
- [ ] **漏写示例 grep**：迁移完成后 `cd fengyu-admin && grep -rn "^  const session = await getSession()" src/actions/ | grep -v test | wc -l` 应为 0（或仅 `auth.ts` 中 login 等公共入口）
- [ ] **lint 守卫验证**：故意提交一个 `export async function foo() { return 1 }` 到 `src/actions/test-fixture.ts` → `bun run lint` 应报 error（验证规则实际生效，验完删除 fixture）
- [ ] `auth.ts` 2 处旁路：迁移后 cc4 抽样 grep `roles\.some.*role === 'admin'` 在 `actions/` 下应为 0 hit
- [ ] PR 拆分顺序：S1 → S2 → S3 单模块 PR ×N → S4 → S5；每个 PR 独立 review、独立 merge

---

## 6 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| HOF 泛型推导丢失，导致调用方需手写类型 | TS DX 退化 | §4.2 已验证 `(...args: Args) => Promise<R>` 推导链；S1 阶段写单测覆盖至少 1 个有 `{ data: ... }` 复杂入参的迁移案例 |
| ESLint AST 选择器跨 typescript-eslint / @next/eslint-config 版本不兼容 | 规则无效 | S2 阶段先 dry-run 在 1 个模块上手动制造违例 → 验证规则触发；若选择器不可靠，**降级**到 `scripts/audit-action-wrapper.mjs` AST 脚本在 CI 跑（与 lint 同效但不依赖 eslint AST） |
| **HOF + `'use server'` + RSC server reference 不兼容** | 全部 action 调用挂掉 | **整体回退方案 B（§3.0 codemod 注入路径）**：S1 build/e2e 任一失败 → 立即弃 HOF 路径、改 codemod 注入 + AST CI 守护；测试 0 改动、运行时 0 风险 |
| `auth.ts` 修复后调用方的 try/catch 错误处理改变（原"return success: false" → 现 throw） | 5 个调用页面可能崩 | S4 阶段先 grep `resetEmployeePassword` / `resetToDefaultPassword` 所有调用方（预期 ≤ 5 处），同 PR 内一起改 |
| 渐进迁移期"新旧双形态共存"造成 review 混乱 | code style 不一致期 | S2 在 CLAUDE.md 写明范式 + 写明"S5 前是过渡期"；每个迁移 PR 标题统一 `refactor(admin): withPermission 迁移 - <模块名>` |
| 函数声明 → const 表达式：函数 hoisting 行为变化 | 文件内自调用可能 TDZ | grep `actions/*.ts` 内是否有"同文件内函数互调"且早调用晚定义；预期罕见，发现时调序即可 |
| revalidatePath / `'use server'` 指令在 HOF 内是否生效 | Next.js Server Action 边界异常 | S1 阶段在 `positions.ts` 示范迁移完后跑 e2e 验证；`'use server'` 是模块级指令，HOF 在模块内导出 const 不影响 RSC 识别——但需实测确认 |

**回滚策略**：每个迁移 PR 是 mechanical refactor，单独 revert 即可；HOF 本身（S1）作为新增文件不影响旧代码，回滚零风险。

---

## 7 关联

- **来源**：`SUMMARY.md v3 Top P0 #4`（admin server action 缺统一鉴权 wrapper）+ audit `P0-CC4-02`
- **前置**：commit `8a30454` PR-Z2（2026-05-17 hasPermission 模块归属重整 + `no-restricted-imports` 反向守卫）
- **相关代码**：
  - `fengyu-admin/src/lib/permissions.ts:220-256` —— `hasPermission` / `requirePermission` / `requireAnyPermission` 定义
  - `fengyu-admin/src/lib/auth.ts:12` —— `getSession` 入口
  - `fengyu-admin/src/actions/auth.ts:223,271` —— 2 处 `isAdmin` 旁路（本 ticket S4 修复目标）
  - `fengyu-admin/eslint.config.mjs:46-91` —— 已有 `no-restricted-imports`，本 ticket 在同一 config 新增 `no-restricted-syntax`
- **测试基线**：Vitest 537 用例（含 `permissions.test.ts` / `auth.test.ts` 等 18 个 action 测试套件）+ Playwright 21 E2E spec
- **不在本 ticket 范围**：
  - 把 `scopeCondition` 也抽进 HOF（不可行——每个 action 用的 scope 字段不同）
  - 把 `logOperation` 抽进 HOF（语义不同——logOperation 是审计，发生在业务完成后；HOF 是入口拦截）
  - client / staff 云函数侧的 action 路由鉴权（另起 ticket，云函数是 `wx-server-sdk` + JS，不能复用此 HOF）

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**：
1. **HOF 与 `'use server'` 模块的 Next.js 限制冲突（高危）**。Next.js 15 `'use server'` 文件**只允许 export async function 或 export const = async function**，且每个 export 在 RSC bundler 中独立注册为 server reference。`withPermission` 返回的是高阶函数包装结果——Next.js 编译器对此模式的支持有歧义；现仓库内 27 个 actions/*.ts 文件 0 处使用 `export const xx = async (...)` 模式，**未经验证**。S1 必须先在 `positions.ts` 真跑 `bun run build` + e2e，否则可能整批 action 调用直接失败（client → server reference 解析不到）。
2. **HOF 包装会破坏现有 18 个 action 测试文件的 `vi.mock('@/lib/permissions', ...)` 模式**。当前 `vi.mock` 替换 `requirePermission` 为 noop spy，测试调用 `createPosition(args)` 直接进入业务逻辑；改 HOF 后业务函数签名变成 `(session, ...args)`，但 `vi.mock` 把 `requirePermission` mock 掉后，HOF 内部 `getSession()` 返回的 session 会传给 fn——所有现有测试**调用 arity 都会断**（少了 session 参数），ticket S3 "同步迁单元测试" 严重低估了 18 个 test 文件的连锁改动量。

**Warn 级问题**：
1. ticket S4 修复 `auth.ts` 时未提及 `resetEmployeePassword` / `resetToDefaultPassword` 用的是 `getSessionFromCookie()`（auth.ts:227,274），而 HOF 草案用 `getSession()`（lib/auth.ts:12）——两者是不同入口，迁移时需统一或保留差异。
2. lint 规则 `selector: 'ExportNamedDeclaration > FunctionDeclaration[async=true]'` 是结构性 ban，无法识别"是否调用了 HOF"——它只逼迫改写 export 形态，**不真正验证鉴权**。例如 `export const foo = async (...) => { /* 无 withPermission */ }` 仍通过 lint。ticket §4.3 末段提到"更具体的选择器"但只给方向不给实现，等于把核心守卫留作 TODO。
3. ticket 未提 PR-Z2 引入的 `no-restricted-imports` 守卫：HOF 新文件若 from `@/lib/auth` import `requirePermission` 会被 ESLint 直接 ban——必须 from `@/lib/permissions`。草案 §2.1 的 import 写错了。

**OK**：
- grep 实证全部正确：`requirePermission` 208 处、`export async function` 171 处、`auth.ts` 2 处 isAdmin 旁路位置精确（行 233/234, 279/280）。
- `auth.ts` 是 `actions/` 内唯一 7 export / 0 perms 的文件，allowlist 决策合理。
- `src/cron/` 0 处 import permissions/auth lib，HOF 与 cron 完全无交集。
- 泛型签名 `<Args extends unknown[], R>` 类型推导可保留。
- 5 stage 渐进 + warn → error 升级策略对单 PR diff 风控合理。

**改进建议**：
1. S1 必须包含 `bun run build` 验证 `'use server'` + `export const = HOF(...)` 在 Next.js 15 实际可用，**不通过则整 ticket 作废**改走 codemod 注入而非 HOF。
2. lint 规则补齐 AST 正向校验（`init.callee.name in [withPermission, withAnyPermission]`），否则只是改写形态不解决"漏鉴权"。
3. HOF 实现里 import 必须 `from '@/lib/permissions'`（不是 `@/lib/auth`），避免触发 `no-restricted-imports`。
4. S3 工期"1–2 天迁 25 文件 + 18 个 test 文件全部改 mock + 调用 arity" 严重低估，建议拆 S3a/S3b 或重估为 3–5 天。
5. 加一个回退方案：若 HOF 路径走不通，改用 `scripts/audit-action-wrapper.mjs` 在 CI 跑 AST 扫描（ticket §6 已提，但只作 lint 选择器兼容性回退，应升为 HOF 路径整体回退）。
