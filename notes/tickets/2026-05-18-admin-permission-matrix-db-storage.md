> 生成日期：2026-05-18
> 严重级别：P0（来源 D-Q3 决策；audit-22 P1-22-08「PERMISSION_MATRIX 双真相源」+ SUMMARY.md v4 §6.3 E10）
> 端：**admin 单端 + db schema**（fengyu-admin / db）
> 影响面：
> - db：复用现有 `system_configs` KV 表，写入 `key='permission_matrix'` 一行 JSONB（value text 列内放 JSON 字符串，与 `share_gift_config` 同款模式）
> - admin lib：`src/lib/permissions.ts:15-96` PERMISSION_MATRIX 常量 → 改为 `getPermissionMatrix()` 异步读取 + 内存缓存
> - admin actions：新建 `src/actions/permission-matrix.ts`（getMatrix / saveMatrix / resetMatrix），扩 `'system:config'` permission（已存在）
> - admin UI：新建 `src/app/(main)/settings/permission-matrix/page.tsx` + `_components/permission-matrix-page.tsx`（表格编辑，行=action，列=role，单元格 checkbox）
> - 其他 actions / lib / menu：无须改动（hasPermission / requirePermission / computeActions 等通过同一 PERMISSION_MATRIX 入口，HOF withPermission 外部签名不变）
> 修复成本：M（5–7 天，含 cache invalidation 设计 + UI 编辑 + Vitest 覆盖 + 兼容性测试）
> 前置：无（`system_configs` 已存在；`settings.ts` 现有 share_gift_config / banner_count 等 KV 读写模式可作蓝本；`@/lib/with-permission` HOF 已落地）
> 来源：D-Q3-2026-04-26 决策 + audit-22-permission-matrix.md P1-22-08 + SUMMARY.md v4 §6.3 E10

**一句话目标**：把 `fengyu-admin/src/lib/permissions.ts:15-96` 硬编码的 PERMISSION_MATRIX（7 角色 × 51 action 真值表）下沉到 `system_configs.permission_matrix` JSONB，让 admin 通过 UI 编辑权限矩阵无需发版；同时不破坏 withPermission HOF + requirePermission + computeActions 三个入口的外部签名。

---

## 0 一句话背景

`PERMISSION_MATRIX` 当前是 `fengyu-admin/src/lib/permissions.ts:15-96` 的代码常量（grep 实证 2026-05-18），每次调整权限（如 2026-05-17 PR-Z2 把 admin 加 `sale_order:refund_approve`）都要发版。D-Q3-2026-04-26 已决要把它下沉到 DB，admin 增管理页。

`system_configs` 表已存在（`db/schema/system-config.ts`），admin `actions/settings.ts:308/347` 已有 `share_gift_config` 同款 KV 模式（key TEXT PK + value TEXT 存 JSON 字符串）— 本 ticket 完全套用此模板，零 schema 改动。

> 既有蓝本：`fengyu-admin/src/actions/settings.ts` `loadShareGiftConfig` (L308) / `saveShareGiftConfig` (L324) — 同款 UPSERT + JSON parse 模式 80% 复用。

---

## 1 现状盘点

### 1.1 PERMISSION_MATRIX 当前形态（grep 实证 2026-05-18）

`fengyu-admin/src/lib/permissions.ts:15-96`：

```ts
export const PERMISSION_MATRIX: Record<RoleType, string[]> = {
  admin: [ 'dashboard:view', 'org:list', 'org:create', ..., 'admin:reset_password',
           'sale_order:refund_create', 'sale_order:refund_approve' ],  // 32 actions
  manager: [ ..., 'sale_order:refund_create', 'sale_order:refund_approve' ],  // 28 actions
  finance: [ ... ],   // 11 actions
  hr: [ ... ],        // 10 actions
  product: [ ... ],   // 6 actions
  customer_mgr: [ ... ],  // 6 actions
  staff: [],          // 0 actions（哑角色，audit-22 P1-22-07 未关闭）
}
```

合计 7 角色 × 51 unique action（按 audit-22 §3.1 量化）。

### 1.2 入口与使用点

| 入口 | 文件:行 | 使用频次 |
|---|---|---|
| `computeActions(roles)` | `lib/permissions.ts:101` | session 构造时调一次（auth.ts:201）|
| `hasPermission(session, action)` | `lib/permissions.ts:222` | 散落 28 处（grep） |
| `requirePermission(session, action)` | `lib/permissions.ts:231` | HOF `withPermission` 内部调；外部直调 0 处 |
| `requireAnyPermission(session, actions)` | `lib/permissions.ts:247` | HOF `withAnyPermission` 内部调 |
| `PERMISSION_MATRIX[role]` 直接索引 | `permissions.test.ts:58` + `permissions-page.tsx`（UI 展示矩阵）| 测试 / UI |

**关键**：`computeActions` 只在 `getSessionFromCookie` 内部调，不是 hot path（每请求查一次 + 写入 session.permissions.actions）。所以矩阵下沉 DB 只需要保证 `computeActions` 能拿到最新矩阵即可，**HOF 入口签名 0 变更**。

### 1.3 system_configs 现有 KV 模式（grep 实证 2026-05-18）

`db/schema/system-config.ts`：

```ts
export const systemConfigs = pgTable('system_configs', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),  // 注意：text 列存 JSON 字符串，不是 JSONB
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
```

`fengyu-admin/src/actions/settings.ts:308/347` `loadShareGiftConfig` / `saveShareGiftConfig` 已有同款 UPSERT + parse 模式：

```ts
// L308 read
const result = await db.execute(
  sql`SELECT value FROM system_configs WHERE key = ${SHARE_GIFT_CONFIG_KEY} LIMIT 1`
)
const raw = result.rows[0]?.value
const parsed = raw ? JSON.parse(raw) : null

// L347 write
await db.execute(sql`
  INSERT INTO system_configs (key, value, updated_at)
  VALUES (${SHARE_GIFT_CONFIG_KEY}, ${JSON.stringify(config)}, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
`)
```

本 ticket 完全复用此模式。

### 1.4 admin /permissions UI 现状

`fengyu-admin/src/app/(main)/permissions/page.tsx` + `_components/permissions-page.tsx:34` — 仅展示**已分配角色**列表，**不展示矩阵本身**。本 ticket 新增独立 `/settings/permission-matrix` 页面专管"action × role 真值表"，与"角色分配"页面分工清晰。

---

## 2 关键架构决策

### 2.1 存储格式：text 存 JSON 字符串 vs JSONB

| 方案 | 优 | 劣 |
|---|---|---|
| **A：text 存 JSON 字符串**（与 share_gift_config 一致）| 0 schema 改动；已有 UPSERT 模板 | 不可 partial update；不可 SQL 直查 action |
| **B：迁移 value 列到 JSONB** | 可直查 `value->'admin'`；可 partial update | 需 migration 0033；其他 KV（share_gift_config / banner_count / sync timestamps）一并迁；风险面大 |

**推荐方案 A**：本 ticket 只下沉 1 个 key 不动 schema；后续若 system_configs 整体迁 JSONB 单独 ticket 处理。

### 2.2 缓存策略：In-memory TTL vs revalidatePath vs 无缓存

`computeActions` 在每次 `getSessionFromCookie()` 时调用一次；admin web 每请求都 fetch session（middleware.ts JWT 校验 + 重建 session），如果矩阵每次都查 DB → 每请求多一次 `SELECT * FROM system_configs WHERE key='permission_matrix'`。

| 策略 | 优 | 劣 |
|---|---|---|
| **C1：无缓存** | 实时生效 | 每请求多 1 次 DB roundtrip |
| **C2：进程级内存缓存 + TTL 60s** | 多请求复用 | TTL 期间编辑不立即生效 |
| **C3：进程级内存缓存 + 主动失效** | 编辑后立刻 invalidate | 多进程部署（admin web 多副本）失效不传播 |
| **C4：进程级 TTL 30s + 编辑后主动 invalidate** | 兼容 C2/C3 优点 | 多进程仍有 30s 偏差窗口 |

**推荐 C4**：
- 进程内 `let _cache: { matrix: Matrix; expiresAt: number } | null`
- TTL 30 秒（与 cron worker 配置缓存的 30s/5min TTL 一致，admin.sys.spec.md §config）
- `saveMatrix` 调用后 `_cache = null` + `revalidatePath('/settings/permission-matrix')`（仅当前进程；多进程 30s 内自然过期）
- admin 部署体量小（docker-compose 单副本，参考 `.claude/skills/remote-deploy/deploy-admin.sh`），多进程窗口非紧迫问题

### 2.3 兼容性：DB 缺失 / JSON 解析失败时如何降级

`saveMatrix` 失败/DB 不可用时若 `getPermissionMatrix` 抛错 → admin 全站登录失败。**降级策略**：

1. `getPermissionMatrix` 内部 try/catch
2. 失败时 fallback 到代码内置的 `DEFAULT_PERMISSION_MATRIX`（保留 `lib/permissions.ts:15-96` 当前内容作为兜底）
3. 同时 `console.error('[permission-matrix] DB read failed, using fallback', err)`
4. 30s 后下次请求重试

确保**任何时候 admin 都能登录**。

### 2.4 编辑 UI 形态

`src/app/(main)/settings/permission-matrix/_components/permission-matrix-page.tsx`：

- 表格：row=action（51 行），column=role（7 列），cell=checkbox
- Header sticky；左列 action 名 sticky
- 顶部"重置为默认"按钮（reset 走 `resetMatrix()`）
- 顶部"保存"按钮（差异化 diff 高亮，未保存 leave page 提示）
- 校验：admin 列至少持有 `permission:assign_admin` 和 `admin:reset_password` 两个 action（否则系统死锁，与 audit-22 P0-22-03 同款约束）

### 2.5 权限项：admin 自己也要走 'system:config'

修改矩阵的 server action 走 `withPermission('system:config', ...)`（已在 PERMISSION_MATRIX.admin 内）。non-admin 无 `system:config`，UI 入口隐藏。

---

## 3 设计目标

### 3.1 数据流

```
admin login
  └── getSessionFromCookie()
        └── computeActions(roles)
              └── getPermissionMatrix()                ← 新增
                    ├─ if _cache && now<expiresAt:    return _cache.matrix
                    └─ else:
                          SELECT value FROM system_configs WHERE key='permission_matrix'
                          if 行存在: parse → _cache → return
                          if 行缺失 / 解析失败: 用 DEFAULT_PERMISSION_MATRIX + console.warn

admin /settings/permission-matrix
  └── getMatrix()                                     ← 直查 DB 不走缓存
  └── saveMatrix(newMatrix)
        ├── withPermission('system:config')
        ├── 校验：admin role 持 ['permission:assign_admin','admin:reset_password']
        ├── UPSERT system_configs(key='permission_matrix', value=JSON.stringify(newMatrix))
        ├── logOperation(session, 'permission_matrix.update', 'system_config', 'permission_matrix', {diff})
        ├── _cache = null
        └── revalidatePath('/settings/permission-matrix')
```

### 3.2 API 增量清单

#### admin 新建 `src/actions/permission-matrix.ts`

```ts
'use server'
import { withPermission } from '@/lib/with-permission'
import { logOperation } from '@/lib/operation-log'
import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { DEFAULT_PERMISSION_MATRIX, invalidatePermissionMatrixCache } from '@/lib/permissions'
import type { RoleType } from '@/lib/types'

const KEY = 'permission_matrix'

export const getMatrix = withPermission(
  'system:config',
  async (_session): Promise<Record<RoleType, string[]>> => {
    const r = await db.execute(sql`SELECT value FROM system_configs WHERE key=${KEY} LIMIT 1`)
    if (r.rows.length === 0) return structuredClone(DEFAULT_PERMISSION_MATRIX)
    try { return JSON.parse((r.rows[0] as any).value) }
    catch { return structuredClone(DEFAULT_PERMISSION_MATRIX) }
  },
)

export const saveMatrix = withPermission(
  'system:config',
  async (session, newMatrix: Record<RoleType, string[]>): Promise<{success:boolean;message:string}> => {
    // 业务校验：admin 必须保留 'permission:assign_admin' + 'admin:reset_password'
    const adminActions = newMatrix.admin || []
    if (!adminActions.includes('permission:assign_admin') || !adminActions.includes('admin:reset_password')) {
      throw new Error('INVALID_PARAMS: admin 角色必须保留 permission:assign_admin 和 admin:reset_password')
    }
    // before snapshot for diff log
    const beforeRes = await db.execute(sql`SELECT value FROM system_configs WHERE key=${KEY} LIMIT 1`)
    const before = beforeRes.rows[0] ? JSON.parse((beforeRes.rows[0] as any).value) : DEFAULT_PERMISSION_MATRIX
    await db.execute(sql`
      INSERT INTO system_configs (key, value, updated_at)
      VALUES (${KEY}, ${JSON.stringify(newMatrix)}, now())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at
    `)
    await logOperation(session, 'permission_matrix.update', 'system_config', KEY, { before, after: newMatrix })
    invalidatePermissionMatrixCache()
    revalidatePath('/settings/permission-matrix')
    return { success: true, message: '权限矩阵已保存' }
  },
)

export const resetMatrix = withPermission(
  'system:config',
  async (session): Promise<{success:boolean;message:string}> => {
    await db.execute(sql`DELETE FROM system_configs WHERE key=${KEY}`)
    await logOperation(session, 'permission_matrix.reset', 'system_config', KEY, {})
    invalidatePermissionMatrixCache()
    revalidatePath('/settings/permission-matrix')
    return { success: true, message: '已重置为默认矩阵' }
  },
)
```

#### admin 改 `src/lib/permissions.ts`

```ts
// 保留 DEFAULT_PERMISSION_MATRIX（原 PERMISSION_MATRIX 内容不动，仅改名 + 加 export）
export const DEFAULT_PERMISSION_MATRIX: Record<RoleType, string[]> = { admin: [...], manager: [...], ... }

// 新增 cache 层
const CACHE_TTL_MS = 30_000
let _cache: { matrix: Record<RoleType, string[]>; expiresAt: number } | null = null

export function invalidatePermissionMatrixCache() { _cache = null }

export async function getPermissionMatrix(): Promise<Record<RoleType, string[]>> {
  const now = Date.now()
  if (_cache && _cache.expiresAt > now) return _cache.matrix
  try {
    const { db } = await import('@/db')
    const { sql } = await import('drizzle-orm')
    const r = await db.execute(sql`SELECT value FROM system_configs WHERE key='permission_matrix' LIMIT 1`)
    let matrix: Record<RoleType, string[]>
    if (r.rows.length === 0) {
      matrix = DEFAULT_PERMISSION_MATRIX
    } else {
      try { matrix = JSON.parse((r.rows[0] as any).value) }
      catch (parseErr) {
        console.error('[permission-matrix] JSON parse failed, fallback to default', parseErr)
        matrix = DEFAULT_PERMISSION_MATRIX
      }
    }
    _cache = { matrix, expiresAt: now + CACHE_TTL_MS }
    return matrix
  } catch (err) {
    console.error('[permission-matrix] DB read failed, fallback to default', err)
    return DEFAULT_PERMISSION_MATRIX
  }
}

// PERMISSION_MATRIX 保留为同步 getter（向后兼容 + 测试用）
// 关键：因为 computeActions 是同步函数（auth.ts 内调），矩阵下沉需把 computeActions 改异步
export async function computeActions(roles: Array<{role: RoleType}>): Promise<string[]> {
  const matrix = await getPermissionMatrix()
  const actionSet = new Set<string>()
  for (const { role } of roles) {
    const actions = matrix[role]
    if (actions) for (const a of actions) actionSet.add(a)
  }
  return Array.from(actionSet)
}
```

**关键变更**：`computeActions` 由同步 → async。调用方 `auth.ts:201`（`getSessionFromCookie` 内）改 `await computeActions(roles)`。grep 该函数所有调用点：

```bash
grep -rn "computeActions" fengyu-admin/src/ --include="*.ts"
```

仅 2 处：`lib/auth.ts:201`（生产调用）+ `lib/permissions.test.ts`（测试断言）。两处都需要改 `await`。

#### admin 新建 `src/app/(main)/settings/permission-matrix/page.tsx`

```tsx
import { redirect } from 'next/navigation'
import { getSessionFromCookie } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { getMatrix } from '@/actions/permission-matrix'
import { PermissionMatrixPage } from './_components/permission-matrix-page'

export default async function Page() {
  const session = await getSessionFromCookie()
  if (!session) redirect('/login?expired=1')
  if (!hasPermission(session, 'system:config')) redirect('/403')
  const matrix = await getMatrix()
  return <PermissionMatrixPage initial={matrix} />
}
```

#### admin 新建 `src/app/(main)/settings/permission-matrix/_components/permission-matrix-page.tsx`

(详见 §4.4)

### 3.3 不在本 ticket 范围

- staff 端 `roles.includes('manager')` 散落 21 处（audit-22 P1-22-09）—独立 ticket
- assignRole scope.type 校验 + admin 自删保护（audit-22 P0-22-01/02/03/04/05）— 见 ticket 2
- staff 端 AUTH_CACHE 失效（audit-22 P2-22-13）— 独立 ticket（多进程 invalidate 涉及跨 CloudBase 通信，复杂度大）

---

## 4 详细变更清单（按层）

### 4.1 L0 — DB schema / migration

**0 改动**。`system_configs` 表已存在，复用现有 KV 模式。

可选：写一次性 seed migration（如 `0033_seed_permission_matrix.sql`）把当前 `DEFAULT_PERMISSION_MATRIX` 写入 DB；**不推荐**，因为 fallback 已覆盖"DB 缺失"路径，行不存在等价于默认值，避免双源同步问题。

### 4.2 L7 — admin lib `src/lib/permissions.ts`

| 修改 | 行号 | 说明 |
|---|---|---|
| 重命名 PERMISSION_MATRIX → DEFAULT_PERMISSION_MATRIX | L15-96 | 内容不动；仅 export 名变 |
| 新增 `_cache` / `CACHE_TTL_MS` / `invalidatePermissionMatrixCache` | L97 后 | 进程级缓存 |
| 新增 `getPermissionMatrix(): Promise<Matrix>` | L97 后 | 带 TTL + DB fallback |
| `computeActions` 改 async | L101 | 内部 `await getPermissionMatrix()` |
| `hasPermission` / `requirePermission` / `requireAnyPermission` | 不动 | 这三个吃 `session.permissions.actions`（已扁平），不直接吃矩阵 |

**Hot path 风险**：`computeActions` 改 async 后，所有调用点必须 `await`。grep 调用点（生产代码 2 处 + 测试若干）。

### 4.3 L7 — admin actions `src/actions/permission-matrix.ts`（新建）

详见 §3.2。约 80 行。

### 4.4 L7 — admin auth `src/lib/auth.ts:201`

```ts
// before
const actions = computeActions(roles)
// after
const actions = await computeActions(roles)
```

注：getSessionFromCookie 本身已是 async，append `await` 即可。

### 4.5 L9 — admin UI

#### 新建 `src/app/(main)/settings/permission-matrix/page.tsx`（见 §3.2）

#### 新建 `src/app/(main)/settings/permission-matrix/_components/permission-matrix-page.tsx`

```tsx
'use client'
import { useState, useTransition } from 'react'
import { saveMatrix, resetMatrix } from '@/actions/permission-matrix'
import { Button } from '@/components/ui/button'
import { useUnsavedChanges } from '@/lib/hooks'
import type { RoleType } from '@/lib/types'

const ROLES: RoleType[] = ['admin','manager','finance','hr','product','customer_mgr','staff']

// 所有已知 actions（从 DEFAULT_PERMISSION_MATRIX flatten 出 + sort）
const ALL_ACTIONS: string[] = [/* 51 actions 字面量数组 + sort 后渲染 */]

export function PermissionMatrixPage({ initial }: { initial: Record<RoleType, string[]> }) {
  const [matrix, setMatrix] = useState(initial)
  const [pending, startTransition] = useTransition()
  const dirty = JSON.stringify(matrix) !== JSON.stringify(initial)
  useUnsavedChanges(dirty)

  function toggle(role: RoleType, action: string) {
    const next = { ...matrix, [role]: matrix[role].includes(action)
      ? matrix[role].filter(a => a !== action)
      : [...matrix[role], action].sort()
    }
    setMatrix(next)
  }

  async function onSave() {
    startTransition(async () => {
      const res = await saveMatrix(matrix)
      if (res.success) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  async function onReset() {
    if (!confirm('确定重置为默认矩阵？所有自定义改动将丢失')) return
    startTransition(async () => { await resetMatrix(); location.reload() })
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h1>权限矩阵</h1>
        <Button onClick={onSave} disabled={!dirty || pending}>保存</Button>
        <Button onClick={onReset} variant="ghost" disabled={pending}>重置默认</Button>
      </div>
      <table className="border-collapse">
        <thead><tr><th>Action</th>{ROLES.map(r => <th key={r}>{r}</th>)}</tr></thead>
        <tbody>
          {ALL_ACTIONS.map(a => (
            <tr key={a}>
              <td className="sticky left-0 bg-white">{a}</td>
              {ROLES.map(r => (
                <td key={r}>
                  <input
                    type="checkbox"
                    checked={matrix[r]?.includes(a) ?? false}
                    onChange={() => toggle(r, a)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

#### Sidebar 菜单加入口

`src/components/layout/sidebar.tsx`（或 menu.ts）增 `{ name: '权限矩阵', href: '/settings/permission-matrix', permission: 'system:config' }`，归属"系统设置"分组。

### 4.6 L9 — tests

| 文件 | 增量 |
|---|---|
| `src/lib/permissions.test.ts` | 改 `computeActions` 测试为 async + `await`；新增 getPermissionMatrix cache 行为测试（TTL / invalidate / DB fallback） |
| `src/actions/__tests__/permission-matrix.test.ts`（新建）| saveMatrix happy / admin 必备 action 校验 / resetMatrix / 非 system:config 权限拒绝 |
| `src/lib/__tests__/permission-matrix-fallback.test.ts`（新建）| mock db.execute throw → 验证 fallback 到 DEFAULT |

---

## 5 迁移策略（按 Stage）

| Stage | 内容 | 工期 |
|---|---|---|
| **S0（设计 spike）** | 验证 `computeActions` async 化对 middleware.ts 的影响（middleware 是 edge runtime，能否 await DB？）；若不能，需把 session.permissions.actions 预生成在 cookie 内 | 0.5 天 |
| **S1（L7 lib + actions）** | DEFAULT 改名 + getPermissionMatrix + cache + permission-matrix.ts 新建；computeActions async + auth.ts:201 await | 1.5 天 |
| **S2（L9 UI）** | settings/permission-matrix 页面 + _components 表格 + Sidebar 菜单 | 2 天 |
| **S3（tests）** | Vitest 单测（cache / fallback / saveMatrix / 校验路径）+ E2E 1 spec（登录 admin → 编辑矩阵 → 保存 → 重新登录验证生效） | 1.5 天 |
| **S4（docs）** | 更新 admin.sys.spec.md §2.2 权限矩阵段：从"代码常量"改"DB 存 + 内存缓存 30s TTL"；CLAUDE.md fengyu-admin 增 `system_configs.permission_matrix` 说明 | 0.5 天 |

**总工期：6 天**（含 S0 spike 与 docs）

S0 spike **必须先做**：Next.js 15 middleware.ts 在 edge runtime 跑，若 JWT 校验阶段需要矩阵（不需要——middleware 仅查 cookie 不算 actions），可继续。若需要，要重构成"actions 写入 JWT payload"模式（成本+++）。

---

## 6 验证 Checklist

### 6.1 后端

- [ ] `cd fengyu-admin && npx tsc --noEmit` 0 错（async 传染面验证）
- [ ] `bun run test` Vitest 全绿（含新增 cache / fallback / permission-matrix.test.ts 共 ~15 用例）
- [ ] `bun run build` Next.js 15 构建通过
- [ ] grep `computeActions(` 调用点 0 处未加 `await`（除测试 mock 外）

### 6.2 UI 手工

- [ ] admin 登录 → /settings/permission-matrix → 看到 7×51 矩阵 + admin 角色 32 处勾选
- [ ] 取消 admin 的 `permission:assign_admin` → 点保存 → 报错"必须保留..."
- [ ] hr 角色加 `coupon:create` → 保存 → 退出 → hr 用户登录 → 30 秒后看到优惠券创建按钮
- [ ] 点"重置默认" → DB 行被 DELETE → 下次读 fallback 到 DEFAULT
- [ ] 非 admin 角色（hr）访问 /settings/permission-matrix → 重定向 /403

### 6.3 缓存行为

- [ ] 测试：连续 2 次 `getPermissionMatrix()` 仅 1 次 DB query
- [ ] `invalidatePermissionMatrixCache()` 后再调 → 重新 DB query
- [ ] mock db.execute throw → fallback 返回 DEFAULT + console.error 一行

### 6.4 跨端守护

- [ ] staff 端 21 处 `roles.includes('manager')` **不在本 ticket 范围**（独立 P1 ticket）
- [ ] error-codes snapshot 测试不漂移（仅添加 'INVALID_PARAMS:' 前缀）

---

## 7 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| **computeActions async 传染面太大** | middleware.ts edge runtime 拒绝 await DB | S0 spike 提前验证；不通过则保留"代码常量 + DB 仅做覆盖层"双轨方案 |
| **DB 单行 SELECT 拖累 hot path** | 每请求 +1 query | 30s TTL 已覆盖；可加 console.time 验证 < 5ms |
| **多进程缓存不一致** | A 进程改完 B 进程 30s 内不感知 | admin 当前单副本部署；多副本时改 PG LISTEN/NOTIFY 或 admin 主动 POST 各副本 invalidate endpoint |
| **JSON 解析失败导致登录失败** | 全员登录卡 | fallback DEFAULT 已覆盖 + console.error 告警 |
| **admin 自己删了 system:config 权限** | 自我锁死 | `saveMatrix` 内强校验 admin 必备 actions；不允许提交"删除 admin.system:config"的 diff |
| **PERMISSION_MATRIX 旧 import 残留** | 编译过但运行时不读 DB | grep `import.*PERMISSION_MATRIX` 全仓清理 → 改 `DEFAULT_PERMISSION_MATRIX` 或 `getPermissionMatrix()` |

**回滚策略**：
- Code rollback：revert 单个 PR 即可，DB 行可留可删（无外键依赖）
- 紧急 hotfix：直接 `DELETE FROM system_configs WHERE key='permission_matrix'` → 即时 fallback 到 DEFAULT（代码常量）

---

## 8 关联

- **决策**：D-Q3-2026-04-26（`docs/audit/SUMMARY.md` §5.1）
- **审计来源**：`docs/audit/audit-22-permission-matrix.md` P1-22-08（双真相源量化）+ SUMMARY.md v4 §6.3 E10
- **既有蓝本**：`fengyu-admin/src/actions/settings.ts:308/347` `loadShareGiftConfig` / `saveShareGiftConfig` KV 模式
- **不在范围**：staff 端 21 处 manager 散落判断（P1-22-09）；admin 撤销保护（独立 ticket 2）；AUTH_CACHE 失效（P2-22-13）
- **相关 memory**：feedback `no-shared-cloudfunctions`（不抽 shared，staff 端守卫保留各自副本）
- **后续可能 ticket**：
  - PERMISSION_MATRIX 加 audit log diff 高亮 UI
  - staff 端 PERMISSION_MATRIX 读取（如果决定下沉到 staff）— 当前仅 admin 单端

---

## 9 复核反馈区（R1 待填）

> 实施前/中由 code reviewer 在此追加反馈块。重点复核：
>
> 1. S0 spike 结果（async computeActions 是否冲击 middleware.ts edge runtime）
> 2. 30s TTL 是否过长（建议下调到 10s？）
> 3. 编辑 UI 是否需要"action 描述"展示（51 个英文 key 用户难辨识）
> 4. 多副本部署时 invalidate 跨进程方案（LISTEN/NOTIFY vs HTTP broadcast）
> 5. system_configs.permission_matrix 行是否要写一次性 seed migration（避免首次 admin 看到"空矩阵"误判）
