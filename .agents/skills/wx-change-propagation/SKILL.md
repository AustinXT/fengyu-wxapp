---
name: wx-change-propagation
description: |
  扫描并执行枚举/字段/表结构性变更的全量影响传播。
  编码项目 10 层依赖传播图，强制"先扫描后执行"工作流。
  当用户的需求涉及以下任何场景时自动激活：
  改枚举、删字段、加字段、重命名、表结构调整、
  新增一个类型、删除一个选项、改个状态值、改个分类、
  订单类型加一个、商品分类加一个、会员等级改名、
  product_kind、sale_order_type、member_level、
  db/schema/enums.ts 有改动、联合类型定义变更。
metadata:
  title: 结构性变更传播
  description_zh: 结构性变更全量扫描 → 变更清单 → 确认后一次性执行
  author: nvoyager
  version: 1.0.0
  license: 42plugin-personal
---

# 结构性变更传播

对枚举/字段/表的结构性变更，做全量影响扫描后一次性执行，避免遗漏。

## 何时使用

- 枚举值增加、删除、改名
- 数据库字段增加、删除、改名、类型变更
- 表增加、删除、改名

## 不适用

- 业务规则/流程调整 → `/wx-requirement-adapt`
- 全新功能开发 → `/wx-implement-feature`
- 仅后端 API 变更 → `/wx-implement-api`

---

## 1 依赖传播图

本项目结构性变更会沿以下 10 层传播。**每次变更前必须逐层扫描**。

| 层 | 路径模式 | 搜索要点 |
|----|---------|---------|
| L0 | `db/schema/enums.ts` | `pgEnum("name", [...])` — 所有枚举的**唯一源头** |
| L1 | `db/schema/*.ts`（21 个模块） | 列定义中引用枚举，如 `saleOrderTypeEnum('column')` |
| L2 | `db/migrations/*.sql` | 需生成新迁移（`npm run db:generate`），复杂转换需手写 |
| L3 | `db/scripts/sync-workfine.js`, `sync-products-from-workfine.js` | 映射函数如 `mapProductKind()`，原生 SQL 中的硬编码值 |
| L4 | `fengyu-admin/src/lib/types.ts` + `schemas.ts` | TypeScript 联合类型、Zod 枚举（`z.enum([...])`） |
| L5 | `fengyu-admin/src/actions/*.ts` | Server Actions 中的 SQL 字符串、switch/case、if 条件 |
| L6 | `fengyu-admin/src/db/seed.ts` | 测试数据对象 — **高频遗漏点** |
| L7 | `fengyu-client/cloudfunctions/clientApi/routes/*.js` + `fengyu-staff/cloudfunctions/staffApi/routes/*.js` | 云函数原生 SQL 硬编码：`IN ('值1', '值2')`、`=== '值'` |
| L8 | `fengyu-staff/miniprogram/utils/formatters.ts` + `fengyu-client/miniprogram/utils/format.ts` | 标签映射 Record — **两端文件名不同，容易只改一个** |
| L9 | `*/miniprogram/**/pages/**/*.{wxml,ts}` + `fengyu-admin/src/app/**/*.tsx` | WXML `wx:if`/`wx:elif` 条件、TSX 条件渲染、下拉选项数组 |
| L10 | `fengyu-admin/src/actions/*.test.ts` + `fengyu-admin/tests/e2e-pages/*.spec.ts` + `fengyu-admin/tests/e2e-chains/*.spec.ts` + `fengyu-staff/miniprogram/mock/*.ts` + `**/__tests__/**` | 测试断言、mock 数据、E2E selector 中的枚举文本 |

### 层序约束

- L0 → L1 → L2 **必须先行**（schema 是源头，迁移依赖 schema）
- L3–L10 可并行，但建议按编号顺序逐层处理

---

## 2 强制工作流

**绝对禁止跳过 Phase 2–3 直接改代码。** 这是消除反复修正的关键。

### Phase 1 — 分类变更

从用户描述中判断变更类型，确定影响层级：

| 变更类型 | 影响层 | 搜索模式 |
|---------|--------|---------|
| 枚举值新增 | L0, L2, L3, L4, L6, L8, L9, L10 | 搜索枚举名（确认哪些地方需新增分支） |
| 枚举值删除 | **全 10 层** | 搜索被删值的字面文本 |
| 枚举值改名 | **全 10 层** | 搜索旧值字面文本 |
| 字段新增 | L0, L1, L2, L4, L5, L6, L7, L9, L10 | 新字段无需搜索，但需确认 SELECT/INSERT 语句 |
| 字段删除 | **全 10 层** | 搜索 snake_case + camelCase 双形式 |
| 字段改名 | **全 10 层** | 搜索旧名 snake_case + camelCase 双形式 |

### Phase 2 — 全量扫描

对变更目标值执行 **全仓库 Grep**：

```
搜索规则：
- 中文枚举值（如 '福利活动'）：直接搜原文
- 字段名（如 sale_order_source）：搜 snake_case 和 camelCase 两种形式
  - sale_order_source（SQL、schema）
  - saleOrderSource（TypeScript、JavaScript）
  - orderSource（可能的简写形式）
- 排除目录：node_modules, .git, miniprogram_npm, dist
```

对每个搜索结果，记录文件路径和行号。

### Phase 3 — 生成变更清单

按 10 层结构化输出，格式如下：

```markdown
## 变更清单: [变更描述]

### L0 db/schema/enums.ts
- [ ] 行 XX: [具体改动描述]

### L1 db/schema/order.ts
- [ ] 行 XX: [具体改动描述]

### L2 db/migrations/
- [ ] 需生成新迁移: [迁移内容描述]

... 逐层列出 ...

### 已确认不受影响
- fengyu-admin/src/actions/auth.ts — 无相关引用
- ...
```

### Phase 4 — 用户确认门控

将变更清单展示给用户，**等待明确确认后才开始执行**。用户可能：
- 确认执行
- 补充遗漏的文件
- 调整变更策略

### Phase 5 — 执行 + 验证

**执行顺序**：L0–L2 先行，然后 L3–L10。

**验证三步**：
1. **Grep 旧值**：对被替换/删除的值再次全仓库搜索，确认零残留
2. **编译检查**：`cd fengyu-admin && bun run build`（TypeScript 类型检查）
3. **测试执行**：`cd fengyu-admin && bun run test`（捕获测试数据不一致）

---

## 3 各变更类型速查

### 3.1 枚举值新增

```
L0  db/schema/enums.ts          — 数组新增值
L2  db/migrations/              — ALTER TYPE ... ADD VALUE '新值'
L3  db/scripts/sync-*.js        — 映射函数新增分支（如 mapProductKind）
L4  fengyu-admin/src/lib/       — types.ts 联合类型 + schemas.ts Zod 枚举
L6  fengyu-admin/src/db/seed.ts — 考虑新增测试数据覆盖新值
L8  */utils/formatters.ts|format.ts — 新增显示标签
L9  页面组件                     — 新增条件渲染分支（标签色、图标等）
L10 测试文件                     — 新增测试用例
```

### 3.2 枚举值删除

**全 10 层受影响。** 额外注意：
- L2 迁移需处理存量数据（UPDATE ... SET column = '新值' WHERE column = '旧值'）
- 先 grep 确认所有引用，再评估数据迁移策略
- 考虑是否需要先改名再删除（PostgreSQL 枚举不支持直接 DROP VALUE）

### 3.3 枚举值改名

**全 10 层受影响。** 步骤：
- L2 迁移：`ALTER TYPE enum_name RENAME VALUE '旧' TO '新'`
- 其余层：全文替换旧值为新值

### 3.4 字段新增

```
L0  db/schema/*.ts              — 新增列定义
L1  db/schema/*.ts              — 如有引用关系
L2  db/migrations/              — ALTER TABLE ADD COLUMN
L4  fengyu-admin/src/lib/       — 类型定义新增字段
L5  fengyu-admin/src/actions/   — SELECT/INSERT 语句新增字段
L6  seed.ts                     — 测试数据新增字段
L7  云函数 routes/              — SQL 查询新增字段
L9  页面组件                     — 新增字段的 UI 展示
L10 测试                        — 新增字段的断言
```

### 3.5 字段删除

**全 10 层受影响。** 搜索 snake_case + camelCase：
- `column_name`（SQL、schema 定义）
- `columnName`（TypeScript/JS 变量名）
- 可能的缩写形式

### 3.6 字段改名

同字段删除的搜索范围，但执行 rename 而非 delete。注意：
- SQL 层：`ALTER TABLE ... RENAME COLUMN old TO new`
- 代码层：同时更新 snake_case 和 camelCase 引用

---

## 4 已知陷阱

从真实项目 git 历史中提取的高频遗漏点：

### 4.1 seed.ts 的 `as const` 陷阱

`fengyu-admin/src/db/seed.ts` 中枚举值使用 `as const` 类型断言。如果枚举值改了但 seed 数据没更新，TypeScript **不一定报错**（取决于类型推断路径）。commit `45d924d` 就是修复此问题。

**对策**：每次枚举变更后，必须检查 seed.ts。

### 4.2 云函数原生 SQL

云函数 routes/*.js 使用原生 `pg` 库写 SQL，不经过 Drizzle ORM，因此 TypeScript 无法检查 SQL 中的硬编码枚举值（如 `WHERE type = '销售单'`）。

**对策**：Phase 2 的 grep 是唯一保障。

### 4.3 WXML 条件表达式

`wx:if="{{item.status === '退款单'}}"` 这类模板表达式完全在 TypeScript 检查范围之外。

**对策**：grep 时包含 `.wxml` 文件。

### 4.4 WorkFine 同步映射

`db/scripts/sync-workfine.js` 中的映射函数（如 `mapProductKind()`）包含硬编码的 return 值。虽然同步脚本不是运行时路径，但会影响数据导入。

### 4.5 两端 formatter 文件名不同

- 员工端：`fengyu-staff/miniprogram/utils/formatters.ts`（带 s）
- 客户端：`fengyu-client/miniprogram/utils/format.ts`（不带 s）

极易只搜到一个而遗漏另一个。**Phase 2 grep 时两个都要出现在结果中。**

### 4.6 staff mock 数据

`fengyu-staff/miniprogram/mock/` 下有 10 个 mock 文件（auth, order, customer, product, service, allocation, appointment, store, workbench, index），都包含硬编码枚举值。

### 4.7 admin E2E 测试

`fengyu-admin/tests/e2e-pages/*.spec.ts` 与 `fengyu-admin/tests/e2e-chains/*.spec.ts` 中的 selector 和断言可能包含枚举文本（如按钮文字、下拉选项）。

---

## 5 Commit 策略

按项目约定分层提交（参照 git log 中 product_kind 重构的 4 commit 模式）：

```
1. refactor(db):    — Schema + 迁移 + 同步脚本 (L0–L3)
2. refactor(admin): — 类型、actions、seed、页面、测试 (L4–L6, admin 部分 L9–L10)
3. refactor(client): — 云函数 + 小程序 (L7–L10 client)
4. refactor(staff):  — 云函数 + 小程序 (L7–L10 staff)
```

commit message 使用 Conventional Commits 格式，scope 标注子项目。

---

## 示例

```bash
/wx-change-propagation product_kind 新增"体验卡"
/wx-change-propagation 删除 sale_order_source 字段
/wx-change-propagation sale_order_type 改名 '普通' → '销售单'
```

以 `product_kind 新增"体验卡"` 为例，Phase 2 将 grep `体验卡` 和 `product_kind`（含 camelCase `productKind`），生成覆盖 L0–L10 的变更清单，等待用户确认后一次性执行全部修改。
