# Ticket: `service_order_type` 枚举值与 mock/迁移脚本不一致修复

> 生成日期：2026-04-25
> 严重级别：P3（mock 不会污染线上；但**两个 WorkFine 迁移脚本仍持有旧枚举字面量，再次执行将被 PG 拒绝**——这才是隐藏的 P2 风险点）
> 端：
>   - fengyu-client/cloudfunctions/clientApi（**测试 fixture 唯一 1 行**）
>   - db/scripts（**WorkFine 一次性迁移脚本 2 个**——已停用但代码留存）
> 影响面：
>   - `fengyu-client/cloudfunctions/clientApi/__tests__/routes/service.test.js:19` mock fixture 用了 `'护理'`（伪造值，从未在 enum 出现过）
>   - `db/scripts/migrate-service-records.js:157` 派生字段 `serviceType` 取值 `'体验'/'普通'`（旧 enum 值，已被 migration 0024 重命名）
>   - `db/scripts/migrate-presale-services.js:290` 硬编码 `serviceType: '体验'`、`:421` SQL 字面量 `WHERE service_order_type = '体验'`
>   - 前端运行时 / Server Action / staffApi 创建路径已**全部正确**使用 `'售前'/'售后'`，无线上影响
> 前置依赖：无（单纯 mock + 死代码勘误）
>
> **一句话目标**：把 `'护理'`（伪造）/ `'体验'/'普通'`（旧 enum 历史值）3 处字面量纠正为当前 enum 合法值 `'售前'/'售后'`，消除"代码字面量与 schema 不同步"的潜在地雷。

---

## 0 一句话背景

`db/schema/enums.ts:68` 定义 `serviceOrderTypeEnum = pgEnum("service_order_type", ["售前", "售后"])`，但 `clientApi/__tests__/routes/service.test.js:19` mock 数据用了 `'护理'`、两个 WorkFine 迁移脚本仍用旧值 `'体验'/'普通'`——这些字面量都不在当前 enum 内，下次执行会被 PG 拒绝。

---

## 1 问题定位

### 1.1 证据 A：enum 演进时间线

| 日期 | commit | 操作 | enum 状态 |
|---|---|---|---|
| 2026-03-13 之前 | — | 初始定义 | `('普通', '体验')` |
| 2026-03-13 17:59 | `90ff538` | 重命名 sale_order_type 时同期建模 | `('普通', '体验')` 仍生效 |
| 2026-04-02 23:03 | `a5cbf1c` | refactor: service_order_type **普通/体验 → 售前/售后** 自动判定（migration `_archive_pre_baseline_2026_04/sql/0024_service_order_type_rename.sql`）| `('售前', '售后')` ← 当前 |
| 2026-04-10 00:36 | `381ba61` | refactor: 售前/售后判定改用 `became_member_at` 时间戳快照（仅判定逻辑变，枚举值不变）| `('售前', '售后')` |
| 2026-04-10 baseline reset | `0000_baseline.sql:23` | drizzle-kit 把当前 enum 固化进 baseline | `('售前', '售后')` |

**migration 0024 的回填逻辑**（`_archive_pre_baseline_2026_04/sql/0024_service_order_type_rename.sql:11-20`）：
```sql
UPDATE service_orders so
SET service_order_type = CASE
  WHEN EXISTS ( SELECT 1 FROM client_wechat_users c
                WHERE c.user_id = so.client_user_id
                  AND c.customer_type = '会员客' )
  THEN '售后'::service_order_type
  ELSE '售前'::service_order_type
END
WHERE service_order_type IN ('普通', '体验');
```
**enum 历史中从未出现过 `'护理'`**——`'护理'` 是 mock 作者凭语义自造的字面量。

### 1.2 证据 B：全仓字面量分布表

执行了 3 次不同 pattern 的 grep（`service_order_type|serviceOrderType` / `'护理'|"护理"` / `service_order_type` 在 SQL/MD），分类如下：

| 类别 | 文件:行 | 字面量 | 是否合法 | 说明 |
|---|---|---|---|---|
| **schema 定义** | `db/schema/enums.ts:68` | `["售前", "售后"]` | ✅ | 唯一权威 |
| **schema 列定义** | `db/schema/service.ts:20` | `default('售前')` | ✅ | |
| **baseline migration** | `db/migrations/0000_baseline.sql:23,307` | `('售前', '售后')` + `DEFAULT '售前'` | ✅ | |
| **staffApi 创建（运行时）** | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:155,162,179` | `'售前'/'售后'` 变量赋值 + INSERT | ✅ | 已按 `became_member_at` 自动判定 |
| **admin Server Action（运行时）** | `fengyu-admin/src/actions/services.ts:466-467,520` | TS 联合类型 `'售前' \| '售后'` + insert | ✅ | |
| **admin 类型定义** | `fengyu-admin/src/lib/types.ts:195` | `type ServiceOrderType = '售前' \| '售后'` | ✅ | |
| **admin UI 渲染** | `fengyu-admin/src/app/(main)/services/_components/{services,service-detail}-page.tsx` | 比较 `=== '售前'` 着色 | ✅ | |
| **admin seed** | `fengyu-admin/src/db/seed.ts:261-264` | `'售前'/'售后' as const` | ✅ | |
| **admin 单测** | `fengyu-admin/src/actions/services.test.ts:420` | `serviceOrderType: '售前'` | ✅ | |
| **clientApi 读取（运行时）** | `fengyu-client/cloudfunctions/clientApi/routes/service.js:27` | `SELECT so.service_order_type` 透传 | ✅ | 不解释取值，仅原样返回 |
| **❌ clientApi 测试 mock** | `fengyu-client/cloudfunctions/clientApi/__tests__/routes/service.test.js:19` | `service_order_type: '护理'` | ❌ | **enum 历史中从未存在的伪造值** |
| **❌ db 迁移脚本（INSERT 字面量）** | `db/scripts/migrate-service-records.js:157` | `serviceType: trim(row.service_type) === '售前' ? '体验' : '普通'` | ❌ | 旧 enum 值；输入若是 WorkFine `'售前'` 会被翻成 `'体验'`，但下游 enum 已不接受 `'体验'` |
| **❌ db 迁移脚本（INSERT 字面量）** | `db/scripts/migrate-presale-services.js:290` | `serviceType: '体验'` 硬编码 | ❌ | 旧 enum 值 |
| **❌ db 迁移脚本（SQL WHERE）** | `db/scripts/migrate-presale-services.js:421` | `WHERE service_order_type = '体验'` | ❌ | 验证查询，`'体验'` 已不在 enum，PG 会报 `invalid input value for enum service_order_type: "体验"` |
| 文档 / spec | `.42cog/pm/backend.pr.spec.md:279`、`.42cog/dev/staff.sys.spec.md:300`、`docs/changelogs/2026-04-01-to-2026-04-02-summary.md:48-49`、`notes/adapt-plans/05-service-presale-cycle.md` 多处 | `'售前'/'售后'` | ✅ | |

**结论**：仓库里 `service_order_type` 字面量出现 ~30 处，只有上述 4 行（1 测试 mock + 3 迁移脚本片段）与 enum 不同步。

### 1.3 证据 C：生产 INSERT 路径全部已用 `'售前'/'售后'`

唯二写入 `service_orders.service_order_type` 的运行时路径都已正确：

| 路径 | 文件 | 取值来源 |
|---|---|---|
| 员工端创建服务单 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:153-189` | `let serviceOrderType = '售前'; if (became_member_at <= NOW()) serviceOrderType = '售后'` → 写 INSERT |
| Admin 创建服务单 | `fengyu-admin/src/actions/services.ts:459-528` | 同样基于 `customerRow.becameMemberAt` 判定 → `'售前' \| '售后'` 联合类型写 insert |

clientApi 不创建服务单（路由表只有 `detail` / `list` 只读），因此 mock 里的 `'护理'` **永远不会被写回 PG**——它只在 test fixture 内当字符串字段透传，从未参与任何断言（见 §1.4）。

### 1.4 证据 D：mock 字面量在测试中的作用——零有效断言

`fengyu-client/cloudfunctions/clientApi/__tests__/routes/service.test.js:15-33` 唯一用例 `service.detail "返回服务单详情及明细"`：

```js
test('返回服务单详情及明细', async () => {
  pg.query.mockResolvedValueOnce([{
    service_order_id: 'SVC-001', status: '进行中',
    service_order_type: '护理', store_id: 's1', store_name: '凤御A店',  // ← 第 19 行
  }])
  pg.query.mockResolvedValueOnce([{ ... }])

  const ctx = createBoundCtx({ serviceOrderId: 'SVC-001' })
  await routes.detail(ctx)

  expect(ctx.result.serviceOrder.service_order_id).toBe('SVC-001')   // ← 只断 service_order_id
  expect(ctx.result.items).toHaveLength(1)
  expect(ctx.result.items[0].product_name).toBe('美白护理')
})
```

`service_order_type: '护理'` 字段：
- **不在任何 `expect(...)` 中** → 取错值不会让测试失败
- 路由 `clientApi/routes/service.js:23-46` 的 SQL `SELECT so.service_order_type, ...` 把它透传给 `ctx.result.serviceOrder` → mock 给什么都"通过"
- 同文件其它 5 个用例（status='已完成'/'进行中'/'待服务' 等）压根没设置 `service_order_type` → 返回 `undefined`，依然 PASS

**测试有效性影响**：无（这是个"哑字段"，但保留了"枚举字面量错配"的不良示范，对未来 reviewer 误导）。

### 1.5 证据 E：迁移脚本目前是否会被执行

| 脚本 | 用途 | 当前状态 | 风险 |
|---|---|---|---|
| `db/scripts/migrate-service-records.js` | 一次性迁移 WorkFine UDT_S_259 售后护理单 → PG | 创建 2026-03-15（commit `992a756`）；按 `notes/adapt-plans/03-staff-commission.md:115` 注释提示，已执行完毕，处于"留档"状态 | 若未来运营要求"补迁某区间数据"或新人重跑，**INSERT 会因 `serviceType='普通'/'体验'` 被 PG enum 拒绝** |
| `db/scripts/migrate-presale-services.js` | 一次性迁移 WorkFine UDT_S_762 售前护理单 + TKKLS 拓客卡 → PG | 创建 2026-03-15（commit `5de0a24`），同样为"已完成 + 留档" | 同上；额外的 §1.2 第 421 行 SELECT 验证查询也会同步 throw |

虽然 [workfine-sync-stopped](../../MEMORY.md `project_workfine_sync_stopped.md`) 已宣告 2026-04-16 后停用 WorkFine 同步，但 `db/scripts/` 下脚本既未删除也未加 `process.exit(1)` 守卫。**死代码 + 错误字面量** 的组合是后续踩坑的温床。

---

## 2 决策建议

| 方案 | 描述 | 优点 | 缺点 | 推荐 |
|---|---|---|---|---|
| **A** | 改 mock + 改迁移脚本，统一为 `'售前'/'售后'` | 最小变更；与 enum 一致；零运行时风险 | 需要为迁移脚本里的 `'售前'/'售后'` 重新匹配 WorkFine 输入语义（`migrate-service-records.js:157` 的三元表达式现在做"WorkFine 售前→PG 体验"的反向映射，要改成"WorkFine 售前→PG 售前"才对） | ✅ **推荐** |
| B | 扩展 enum，加入 `'护理'/'普通'/'体验'` | 不动现有字面量 | **业务上没有"护理"这个第三类**（运营文案：售前/售后两种）；admin UI 二元着色逻辑会塌；migration 0024 回填语义会被颠覆；纯倒退 | ❌ |
| C | 接受现状（mock 是"哑字段" + 迁移脚本"已停用"） | 零代码改动 | 迁移脚本下次被任何人 / cron / 应急脚本调用就 throw；mock 给后来者错误示范；与 `db/CLAUDE.md` "全仓字面量统一"风格冲突（参见近期 commit `53573a4` 的 product_type 整理） | ❌ |

### 推荐方案：**A**

理由：
1. enum 是权威（migration 0024 已 prod 落地 + baseline 固化），错的是字面量
2. 业务无第三类需求（admin UI、staffApi 业务流、文档 spec、seed 全部二元）
3. 迁移脚本字面量错配是**真实的隐藏 bug**——一旦再跑就 throw，不是纯死代码
4. 与本月已完成的 `53573a4`（product_type 全仓字面量统一）、`fb74728`（customer_status 全仓传播）、`b1f9401`（sales_category 全仓传播）一脉相承，遵循"枚举字面量必须与 enum 同步"的项目惯例

---

## 3 Schema 变更

**本 ticket 不做 schema 变更。** enum `serviceOrderTypeEnum` 当前的 `["售前", "售后"]` 是正确的，不动。

---

## 4 实施步骤

### 4.1 修复 client mock（1 行）

`fengyu-client/cloudfunctions/clientApi/__tests__/routes/service.test.js:19`
```diff
-      service_order_type: '护理', store_id: 's1', store_name: '凤御A店',
+      service_order_type: '售前', store_id: 's1', store_name: '凤御A店',
```

为什么选 `'售前'`：与同文件 line 18 的 `status: '进行中'` 语义自洽（仅店内服务进行中，未必触达售后阶段）。该字段无断言，取 `'售后'` 也技术等价；选 `'售前'` 与 `db/schema/service.ts:20` 的 default 一致即可。

### 4.2 修复 `migrate-service-records.js`（1 处三元表达式）

`db/scripts/migrate-service-records.js:157`

原代码：
```js
serviceType: trim(row.service_type) === '售前' ? '体验' : '普通',
```

PG 当前 enum `('售前', '售后')`，WorkFine 字段 `UDF_S_1417` 在源系统使用 `'售前'/'售后'/null` 字面量（见 `db/scripts/sync-workfine.js` 同步映射约定）。语义上 WorkFine 与 PG 完全一致即可：

```js
serviceType: trim(row.service_type) === '售前' ? '售前' : '售后',
```

> ⚠️ 待确认：原三元表达式的奇怪语义（"WorkFine 售前 → PG 体验" 反向映射）疑似 2026-03-15 编写时按"短期占位"思路写的（当时 PG enum 是 `('普通','体验')`，作者把 WorkFine 售前映成 PG 体验勉强对齐）。本 ticket 假设 **WorkFine 与 PG 应一一对应**（WorkFine 售前 ↔ PG 售前；WorkFine 售后 ↔ PG 售后）。若运维侧另有"售前必须落 PG 售后"等业务诉求，请在 review 时拍板。

### 4.3 修复 `migrate-presale-services.js`（2 处）

`db/scripts/migrate-presale-services.js:290`
```diff
-        serviceType: '体验', // 售前/体验
+        serviceType: '售前', // 售前护理单（TKKLS 拓客卡场景）
```
（这个脚本是**售前护理单专用迁移**，硬编码 `'售前'` 与脚本主旨完全一致。）

`db/scripts/migrate-presale-services.js:421`
```diff
-    "(SELECT COUNT(*) FROM service_orders) AS total_so FROM service_orders WHERE service_order_type = '体验'"
+    "(SELECT COUNT(*) FROM service_orders) AS total_so FROM service_orders WHERE service_order_type = '售前'"
```

### 4.4 自检

```bash
# 1. clientApi 单测
cd fengyu-client/cloudfunctions/clientApi
npm test -- service.test.js
# 预期：6 个用例全 PASS（与改前完全一样，无新增/删除断言）

# 2. 迁移脚本 dry-run（不实际跑，仅 require 检查语法）
cd db
node -e "require('./scripts/migrate-service-records.js')" 2>&1 | head -3
node -e "require('./scripts/migrate-presale-services.js')" 2>&1 | head -3
# 预期：脚本入口未自动执行（require 时只定义函数），无 syntax error

# 3. 全仓字面量统一性复核
grep -rn "service_order_type\|serviceOrderType" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sql' \
  --exclude-dir=node_modules --exclude-dir=miniprogram_npm \
  --exclude-dir=_archive_pre_baseline_2026_04 --exclude-dir=meta \
  /Users/nv/proj.xt.com/fengyu-wxapp \
  | grep -E "'(护理|普通|体验)'"
# 预期：零行输出
```

### 4.5 commit 拆分（建议）

按 `feedback_commit_grouping` 偏好"按特性维度而非模块"分组——本 ticket 主题是"`service_order_type` 字面量统一"，4 处改动同属一个特性，**单 commit 即可**：

```
fix(service-order-type): 全仓字面量与 enum 同步（mock + 迁移脚本）

- clientApi 测试 mock '护理' → '售前'（伪造值，从未在 enum）
- migrate-service-records.js 旧映射 '体验/普通' → '售前/售后' 直传
- migrate-presale-services.js 硬编码 '体验' → '售前'（脚本本就专做售前迁移）
- migrate-presale-services.js 验证 SQL WHERE = '体验' → '售前'

历史脉络：migration 0024（_archive_pre_baseline_2026_04/sql/0024_service_order_type_rename.sql）
2026-04-02 把 enum 从 ('普通','体验') 重命名为 ('售前','售后')，
2026-03-15 编写的 2 个 WorkFine 迁移脚本未跟进；clientApi 测试 mock
2026-03-14 创建时直接写了 '护理'（从未在任何版本的 enum 内）。
```

---

## 5 验收标准

| # | 标准 | 验证 |
|---|---|---|
| AC-1 | enum `serviceOrderTypeEnum` 仍为 `['售前', '售后']` 不变 | `cat db/schema/enums.ts:68` |
| AC-2 | 全仓搜索 `service_order_type` 字面量后无 `'护理' / '普通' / '体验'` | §4.4 步骤 3 命令零输出 |
| AC-3 | `service.test.js` 6 个用例全 PASS | `npm test -- service.test.js` |
| AC-4 | 现有 admin / staffApi / client 运行时 SQL/类型均不变 | `git diff --stat` 限定本次只改测试 + db/scripts 两个目录 |
| AC-5 | 修改后 `db/scripts/migrate-presale-services.js --verify` 重跑可成功（即便 0 行也不报 enum 错） | `node db/scripts/migrate-presale-services.js --verify`（可选，需 MSSQL/PG 连接，本地不强制） |

---

## 6 风险点

| # | 风险 | 缓解 |
|---|---|---|
| R-1 | `migrate-service-records.js:157` 改写后语义反转：原"WorkFine 售前 → PG 体验"现"WorkFine 售前 → PG 售前"。如果 prod 已经按旧映射跑过部分数据，存在历史不一致 | 已确认本脚本是**一次性历史迁移**（commit message 表述 + `workfine-sync-stopped` 决议）；当前 PG `service_orders` 中所有 `'售前'/'售后'` 均由 migration 0024 的 `customer_type` 派生回填，**与脚本字面映射无关**。如果未来要再跑，先用 `--dry-run` 复核映射 |
| R-2 | 测试 mock 改值后，未来若有人误以为 `service_order_type` 字段在 `service.detail` 用例被验证，会被字面量误导 | 4 处改动同步进行；commit message 显式说明"该字段无断言"；可考虑在用例后追加一个 `expect(ctx.result.serviceOrder.service_order_type).toBe('售前')` 显式断言（**本 ticket 不做**，避免范围扩大） |
| R-3 | 迁移脚本里隐藏其它 stale 字面量未被发现 | §4.4 步骤 3 全仓 grep 已覆盖 enum 所有历史值（护理/普通/体验/售前/售后），输出表见 §1.2 |

---

## 7 不在范围

- ❌ **不动 enum 定义**（`db/schema/enums.ts:68` 保持 `["售前", "售后"]`）
- ❌ **不删迁移脚本**（即便已停用，删除是另一个决策；本 ticket 仅勘误字面量）
- ❌ **不加 enum 校验测试**（不为 mock 增加断言；保持本 ticket 范围最小）
- ❌ **不重构 staffApi/admin 的 `serviceOrderType` 派生逻辑**（`became_member_at` 判定已是当前正确实现）
- ❌ **不改 `document_type` enum**（`document_type` 也是 `('售前','售后')`，但属于 sale_orders 域，本次不涉及）
- ❌ **不动同名变量 `serviceType`**（迁移脚本里的 JS 局部变量名，仅修改其取值字面量）

---

## 8 相关引用

### 代码
- `db/schema/enums.ts:68` — `serviceOrderTypeEnum` 定义
- `db/schema/service.ts:20` — `serviceOrders.serviceOrderType` 列定义
- `db/migrations/0000_baseline.sql:23,307` — baseline 中的 enum + 列默认值
- `db/migrations/_archive_pre_baseline_2026_04/sql/0024_service_order_type_rename.sql` — 2026-04-02 enum 重命名 + 数据回填
- `fengyu-client/cloudfunctions/clientApi/__tests__/routes/service.test.js:19` — **本 ticket 修复点 #1**
- `db/scripts/migrate-service-records.js:157` — **本 ticket 修复点 #2**
- `db/scripts/migrate-presale-services.js:290,421` — **本 ticket 修复点 #3、#4**
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js:153-189` — 运行时正确实现（参考）
- `fengyu-admin/src/actions/services.ts:459-528` — Server Action 正确实现（参考）

### 文档
- `.42cog/pm/backend.pr.spec.md:279` — 业务定义"售前/售后由 customer_type 自动判定"（注：现已升级为按 `became_member_at` 判定，spec 文案稍滞后但语义不变）
- `.42cog/dev/staff.sys.spec.md:300` — 同上
- `docs/changelogs/2026-04-01-to-2026-04-02-summary.md:48-49` — enum 重命名变更记录
- `notes/adapt-plans/05-service-presale-cycle.md:25,32,55-56,130-136` — 售前/售后判定规则演进笔记
- `notes/tickets/2026-04-25-rename-care-order-to-service-order.md:123,225,239` — 本问题被该 ticket §6 标记为"另开 fix"——本 ticket 即闭环
- `notes/adapt-plans/00-decisions.md:31,51` — 决策 #4：枚举回滚 `[售前,售后]→[普通,体验]` 已**取消**，保留 `[售前,售后]`

### Git 历史
- `a5cbf1c` (2026-04-02 23:03) refactor: service_order_type 普通/体验→售前/售后自动判定
- `381ba61` (2026-04-10 00:36) refactor(service): 售前/售后判定改用顾客入会时间戳快照
- `7a05442` (2026-03-14 02:50) test(client): 添加 clientApi 和小程序前端测试基础设施 — mock 文件骨架
- `383518c` (2026-03-14 09:37) test(clientApi): mock 重构 — `'护理'` 字面量首次出现（此时 enum 还是 `('普通','体验')`，从未匹配）
- `992a756` (2026-03-15 09:53) feat(db): 新增数据迁移脚本 — `migrate-service-records.js` 携带 `'体验'/'普通'`
- `5de0a24` (2026-03-15 17:02) refactor(db): 迁移脚本优化与预售服务迁移新增 — `migrate-presale-services.js` 携带 `'体验'`

### Memory / 决策
- `feedback_no_legacy_compat` — 开发阶段无需历史兼容；直接改字面量即可
- `feedback_commit_grouping` — 按特性维度（"service_order_type 字面量统一"）单 commit
- `project_workfine_sync_stopped` — 2026-04-16 后停用 WorkFine 同步；迁移脚本归"已完成 + 留档"
