# Ticket-10d: admin actions/* withPermission HOF 迁移补齐（7 文件 ~93 处）

> 生成日期：2026-05-17
> 实施状态：⚪ 未开工
> 严重级别：**P3**（技术债，非阻塞 — `npx tsc --noEmit` 当前通过，commit `bad9c5f` 已完成 18/25 文件的迁移，剩 7 文件混用旧 `getSession()/requirePermission(session)` 模式与新 `withPermission` HOF）
> 端：fengyu-admin
> 修复成本：**M**（数小时 — 7 文件 ~93 处机械迁移，每文件迁完跑该模块单元测试）
> 来源：[commit `bad9c5f` 半完成迁移](https://github.com/...) + 主 ticket §6 验证 checklist 补完

---

## 0 一句话背景

commit `bad9c5f`（"refactor(admin/with-permission): 引入 HOF + ESLint AST 强制规则 + 全 actions 迁移"）声称"全 actions 迁移"，但实际只完成 18/25 文件。仍有 7 文件使用旧的 `const session = await getSession(); requirePermission(session, '<perm>')` 模式，未改用 `withPermission(<perm>, async (session, ...args) => {...})` HOF。

**当前不阻塞 build**：`npx tsc --noEmit` 静默通过。本 ticket 属"技术债收尾"，让 admin actions 风格统一 + ESLint AST 规则（如有）能强制守护。

---

## 1 现状（grep 实证 2026-05-17）

```bash
cd fengyu-admin

grep -rl "getSession()\|requirePermission(session" src/actions/ | sort
# → 7 文件未迁

grep -rl "withPermission(" src/actions/ | sort | wc -l
# → 18 文件已迁
```

### 1.1 已迁文件（18 个）

`allocations.ts` / `appointments.ts` / `card-transactions.ts` / `cards.ts` / `commission.ts` / `dashboard.ts` / `logs.ts` / `messages.ts` / `org.ts` / `permissions.ts` / `pickup-records.ts` / `points.ts` / `positions.ts` / `service-commissions.ts` / `settings.ts` / `skill-tags.ts` / `store-unbind.ts` / `stores.ts`

### 1.2 未迁文件（7 个，共 ~93 处 `getSession()`）

| 文件 | `getSession()` 次数 | 备注 |
|------|--------------------|------|
| `src/actions/products.ts` | 35 | 最大，含 SKU/category 大量子函数 |
| `src/actions/coupons.ts` | 13 | |
| `src/actions/customers.ts` | 12 | |
| `src/actions/orders.ts` | 10 | 与 ticket-10c 同一文件，注意 PR 顺序 |
| `src/actions/services.ts` | 9 | |
| `src/actions/employees.ts` | 7 | 与 ticket-10 employees.ts 示范同文件，注意 PR 顺序 |
| `src/actions/refunds.ts` | 7 | 与 ticket-10c 同一文件 |
| **合计** | **93** | |

> 调研发现 `tsc` 当前不报错，之前快照中看到的 `store-unbind.ts` "Cannot find name 'getSession'" 错误已在 commit `9651afd` / 之后修复。

---

## 2 迁移设计

### 2.1 模式转换

**旧（待替换）**：
```ts
export async function fooAction(arg1: string, arg2: number): Promise<Result> {
  const session = await getSession()
  requirePermission(session, 'foo:do')
  // 业务逻辑用 session
  ...
}
```

**新（withPermission HOF，参考 `src/actions/store-unbind.ts` / `src/lib/with-permission.ts`）**：
```ts
export const fooAction = withPermission(
  'foo:do',
  async (session, arg1: string, arg2: number): Promise<Result> => {
    // 业务逻辑用 session（HOF 注入）
    ...
  },
)
```

### 2.2 分批顺序（按依赖度从小到大）

| 批次 | 文件 | 次数 | 配套测试 |
|------|------|------|---------|
| 1 | `refunds.ts` | 7 | `refunds.test.ts` |
| 2 | `employees.ts` | 7 | `employees.test.ts` |
| 3 | `services.ts` | 9 | `services.test.ts` |
| 4 | `customers.ts` | 12 | `customers.test.ts` |
| 5 | `coupons.ts` | 13 | `coupons.test.ts` |
| 6 | `orders.ts` | 10 | `orders.test.ts`（108 用例，与 ticket-10c 协调） |
| 7 | `products.ts` | 35 | `products.test.ts` |

每批迁完：
1. `bun run test src/actions/<file>.test.ts` 全绿
2. `npx tsc --noEmit` 全绿
3. 独立 commit，便于回滚

### 2.3 ESLint AST 规则（可选确认）

commit `bad9c5f` 声称"引入 ESLint AST 强制规则"。本 ticket 实施前先确认：
```bash
grep -rn "getSession\|requirePermission" fengyu-admin/eslint.config.* fengyu-admin/.eslintrc.*
```
如规则已存在并允许豁免，本 ticket 完成后**移除豁免**让规则强制全仓零容忍。

---

## 3 与 ticket-10c 的冲突协调

`refunds.ts` / `orders.ts` 同时是 ticket-10c（裸 throw 收敛）的范围。

**推荐 PR 顺序**：
- **ticket-10d 先**：完成 7 文件 withPermission 迁移（不动 throw 语句）
- **ticket-10c 后**：在 10d 落地后接手 `refunds.ts` / `orders.ts` 的 throw 替换（路径不重叠 — 10d 改函数签名/包装，10c 改函数体内的 throw 语句）

若并行执行（不同分支），合并时冲突点：函数签名行（10d 改 `export async function X` → `export const X = withPermission(...)`），可手工 merge。

---

## 4 验证

```bash
cd fengyu-admin

# 所有 action 单元测试
bun run test src/actions/

# 类型检查
npx tsc --noEmit

# 完整 build
bun run build

# 反向 grep：getSession()/requirePermission(session) 应在 actions/ 内归零
grep -rln "getSession()\|requirePermission(session" src/actions/ | wc -l
# 预期：0
```

---

## 5 风险

| 风险 | 缓解 |
|------|------|
| `withPermission` HOF 返回类型推断丢失（如 Drizzle 复杂 select 类型） | 按 `store-unbind.ts` 示范的显式 `Promise<XxxType>` 注解保持类型完整 |
| 测试 mock `getSession` 失效（HOF 包装后 session 由 HOF 注入） | 各 `*.test.ts` 同步迁移 mock 方式（参考已迁文件如 `allocations.test.ts`） |
| 大文件 `products.ts` 35 处一次迁完风险高 | 单文件再拆 2-3 个 commit（按 SKU / category / spec 子域） |

---

## 6 关联

| 项 | 说明 |
|----|------|
| **来源 commit** | `bad9c5f`（半完成）+ `9651afd`（部分修） |
| **依赖** | `fengyu-admin/src/lib/with-permission.ts`（HOF + ESLint 规则，已就位） |
| **可能冲突** | [ticket-10c admin actions/* 33 处批量替换](2026-05-17-admin-actions-throw-batch-migration.md) — 共改 `orders.ts` / `refunds.ts`，推荐 10d 先 |
| **不冲突** | [ticket-10b admin lib/* 2 处](2026-05-17-admin-lib-throw-to-apierror.md) — 路径完全无重叠，可并行 |
| **主 ticket** | [2026-05-17-error-code-prefix-whitelist-and-admin-throw.md](2026-05-17-error-code-prefix-whitelist-and-admin-throw.md) §6 验证 checklist `bun run build` 通过 |

---

## 7 实施完成的判定（DoD）

- [ ] 7 文件 ~93 处 `getSession()/requirePermission(session)` 全部消除
- [ ] `bun run test src/actions/` 全绿
- [ ] `npx tsc --noEmit` 全绿
- [ ] `bun run build` 通过
- [ ] ESLint AST 规则（若已建）开启零容忍并通过
