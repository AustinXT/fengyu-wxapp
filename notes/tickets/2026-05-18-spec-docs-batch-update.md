# L9 Spec 文档 6 项 P1 批量校对（doc-only）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（SUMMARY §4 L9 列名） |
| 端 | docs（`.42cog/` + 根 `CLAUDE.md`） |
| 修复成本 | **S**（半天，纯文档） |
| 来源 | SUMMARY §6.4 L9 长期 — 6 项 spec 校对单 ticket |
| 关联 schema | `db/schema/product.ts:91, 156`（实际已用 `is_enabled`）|
| 关联 cron | `fengyu-admin/src/cron/steps/*`（schema docstring 守卫的对象） |
| 关联反馈 | `feedback_no_shared_cloudfunctions.md` / `feedback_test_colocation.md` |

---

## 0 一句话背景

SUMMARY v4 §4 L9 Spec 层列了 6 项 P1 文档校对，全部为"代码已变 / 决策已落 / 但 spec / CLAUDE.md 没同步"。本 ticket 合并为单张 doc-only ticket（无代码改动、无 schema 改动），每项各自 checkbox + before/after grep 实证 + 改动点 diff，避免拆 6 张小 ticket 的管理成本。

实施顺序与 §2 列表一致，由文档 maintainer（PM / arch lead）一次性 PR 提交。

## 1 现状（grep 实证）

### 1.1 backend.pr.spec.md `valid_start` / `valid_end` 残留

```
$ grep -nE "valid_start|valid_end" .42cog/pm/backend.pr.spec.md
141:| `valid_start` | date \| null | 有效期开始（null=立即生效） |
142:| `valid_end` | date \| null | 有效期结束（null=永久有效） |
144:> **关键设计**: `valid_start` + `valid_end` 替代 `is_active`；`sales_category` 在商品层（非 SKU 层）。
146:> **有效期叠加规则**: 商品和 SKU 各有 `valid_start/valid_end`，查询时**两层同时校验**，任一层过期即不可购买。
162:| `valid_start` | date \| null | 有效期开始 |
163:| `valid_end` | date \| null | 有效期结束 |
```

实际 schema `db/schema/product.ts:91, 156` 早已切换：

```ts
// products 表
isEnabled: boolean("is_enabled").notNull().default(true),
// product_skus 表
isEnabled: boolean("is_enabled").notNull().default(true),
```

→ spec 描述与实际 schema 偏差 6 处（仅 backend.pr.spec.md）。

### 1.2 admin.pr.spec.md / admin.ui.spec.md 同源残留

```
$ grep -nE "valid_start|valid_end" .42cog/pm/admin.pr.spec.md .42cog/design/admin.ui.spec.md
admin.pr.spec.md:160: **商品字段**: name, ..., valid_start, valid_end, sort_order
admin.pr.spec.md:162: **SKU 字段**: ..., valid_start, valid_end, **is_experience, is_recharge_card**...
admin.pr.spec.md:164: **约束**: ...有效期叠加...；下架=设 valid_end；...
admin.ui.spec.md:504:| 有效期 | valid_start, valid_end, sort_order | DatePicker, Input |
```

→ admin 系列 4 处。

### 1.3 储值卡抵扣启用范围说明

```
$ grep -nE "储值卡抵扣|prepaid_card" .42cog/pm/backend.pr.spec.md
522:| `clientApi.order.confirmPrepaidFull` | tx 末尾 | 全额储值卡抵扣支付（paid=0 → delta=0 无写入） |
```

实际触发点已扩到 5 个端 / 多场景（`backend.pr.spec.md:521-525` 已有完整表格），但**未单独说明"储值卡抵扣启用范围"**：当前实现是
- staff 开单时：员工端 UI 可选"储值卡抵扣"
- client 自助支付时：仅"待支付"订单可走 confirmPrepaidFull
- admin 录单时：暂不支持储值卡抵扣录入（admin/createOrder 仅 received 字段）

→ spec 缺一段"启用范围（哪个端 / 哪个场景）+ 全额抵扣 vs 部分抵扣 vs 与回款的关系"的小节。

### 1.4 admin.pr.spec.md 缺 prepaid_cards 余额管理 UI 描述

```
$ grep -nE "充值卡|储值卡|prepaid_cards|余额管理|recharge" .42cog/pm/admin.pr.spec.md
（0 命中）
```

但 admin 实际已经有这两个页面：

```
$ ls fengyu-admin/src/app/\(main\)
.../cards/                  ← 充值卡列表 + 余额查看
.../card-transactions/      ← 充值卡流水
```

→ admin.pr.spec.md 完全缺这块 AC。

### 1.5 sys.spec.md 错误前缀缺 9 项列表

```
$ grep -nE "UNAUTHORIZED|INVALID_PARAMS|PERMISSION_DENIED|错误前缀|errorType" .42cog/dev/sys.spec.md
（0 命中）
```

而：
- 根 `CLAUDE.md:53-66` 已正式列了 9 项白名单（含二级前缀语法 + snapshot 守护说明）
- `client.sys.spec.md:100-107` 与 `staff.sys.spec.md:171-178` 已各自列了 9 项

但**全局总览 `.42cog/dev/sys.spec.md` 完全没提错误前缀**（该文件只讲三端拓扑 + 文档索引，长度 48 行）→ "4→9 项扩展"实际应该是"sys.spec.md 总览补"+ "client/staff 已 9 项保留" + "admin.sys.spec.md 需补"双任务。

确认 admin.sys.spec.md：

```
$ grep -nE "UNAUTHORIZED|INVALID_PARAMS|错误前缀" .42cog/dev/admin.sys.spec.md
（0 命中）
```

→ admin.sys.spec.md 也无错误前缀小节，需补。

### 1.6 sys.spec.md 缺 cron STEP 配套 schema docstring 守卫

```
$ grep -nE "cron|定时任务|STEP|cron-worker" .42cog/dev/sys.spec.md .42cog/dev/admin.sys.spec.md
（0 命中）
```

cron 模块已有 8 个 STEP 落地（参考 fengyu-admin/src/cron/run.ts:40-53），但 sys spec 既没提到 cron-worker 的存在、也没要求 schema 字段添加守卫注释——例如 `db/schema/appointment.ts` 的 `status` 列若未来加新枚举值，cron `closeExpiredAppointments` 的 WHERE 子句不会跟着更新。需要在 sys.spec.md 增"凡是 cron STEP 在 WHERE/UPDATE 中硬编码的 enum 值，对应 schema/enums.ts 必须添加 docstring 反向引用"约定。

### 1.7 CLAUDE.md 缺跨端复制函数禁令

```
$ grep -nE "cloudfunctions-shared|跨端复制|复制函数|抽取共享|no-shared" CLAUDE.md .42cog/
（0 命中）
```

而 `notes/memory/feedback_no_shared_cloudfunctions.md` 已正式记录用户决策："不抽取 cloudfunctions-shared/workspace/symlink，三端云函数+admin 保留独立副本，一致性靠 snapshot 测试守护"。

→ 根 CLAUDE.md 应增一段"跨端复制函数：禁止抽 cloudfunctions-shared / workspace / symlink，重复代码靠 cross-end snapshot 守护"约定，防止新协作者再提相同方案。

## 2 修复方案（6 项逐条）

### 2.1 P1-#1 — backend.pr.spec.md valid_start/valid_end → is_enabled 全量替换

**目标文件**：`.42cog/pm/backend.pr.spec.md`

**改动**（6 处）：

| 行 | before | after |
|----|--------|-------|
| 141 | `valid_start` \| date \| null \| 有效期开始（null=立即生效） | `is_enabled` \| boolean \| 上下架（false=下架；默认 true） |
| 142 | `valid_end` \| date \| null \| 有效期结束（null=永久有效） | **删除整行**（已并入 is_enabled） |
| 144 | `valid_start` + `valid_end` 替代 `is_active`；... | `is_enabled` 上下架开关（替代 `is_active`，2026-04 schema reset 落地）；... |
| 146 | 有效期叠加规则：商品和 SKU 各有 `valid_start/valid_end`，查询时两层同时校验... | 上下架叠加规则：商品和 SKU 各有 `is_enabled`，查询时两层同时校验，任一层 false 即不可购买 |
| 162 | `valid_start` \| date \| null \| 有效期开始 | `is_enabled` \| boolean \| 上下架 |
| 163 | `valid_end` \| date \| null \| 有效期结束 | **删除整行** |

**关联同步**（同 ticket 一并改）：

- `.42cog/pm/admin.pr.spec.md:160` "商品字段" 列表移除 `valid_start, valid_end`，加 `is_enabled`
- `.42cog/pm/admin.pr.spec.md:162` "SKU 字段" 同上
- `.42cog/pm/admin.pr.spec.md:164` "约束" 段："下架=设 valid_end" → "下架=设 is_enabled=false"；"有效期叠加" → "上下架叠加"
- `.42cog/design/admin.ui.spec.md:504` "有效期 | valid_start, valid_end, sort_order | DatePicker, Input" → "上下架 | is_enabled, sort_order | Switch, Input"

**after grep 期望**（DoD）：

```
$ grep -rnE "valid_start|valid_end" .42cog/
（0 命中 — 此后整个 .42cog/ 不应再出现 valid_start/valid_end 字面量）
```

### 2.2 P1-#2 — '储值卡抵扣' 启用范围说明刷新

**目标文件**：`.42cog/pm/backend.pr.spec.md` §2.21（触发点附近，line 515-525 后追加）

**新增小节**（建议 §2.21.7 或紧邻 settlePoints 触发点表后）：

```markdown
#### 2.21.X 储值卡抵扣启用范围（2026-05-18 补）

| 端 | 入口 | 支持范围 | 备注 |
|----|------|----------|------|
| client | `clientApi.order.confirmPrepaidFull` | 全额抵扣（paid=0） | 适用 "待支付" 订单一次性走完 |
| client | `clientApi.order.repay`（纯卡分支） | 回款抵扣 | 已支付订单二次回款 |
| staff  | `staffApi.order.confirmOffline` | 全额或部分抵扣 | 店长二次确认时可勾选 |
| admin  | — | **不支持** | admin 录单仅写 received（手工录票据，不动余额）|

**业务约束**：
- 卡余额扣减走 `prepaid_cards.balance` + 写 `card_transactions` 流水（一笔抵扣 = 一行流水）
- 不允许跨顾客抵扣（`prepaid_cards.user_id` 必须 = 订单的 `client_user_id`）
- 不允许跨门店：储值卡按 `bound_store_id` 维度结算（详见 `notes/tickets/archives/2026-04-23-prepaid-card-deduction-by-store.md`）
- 退款时按比例回冲：5 通道之 #5 反向 GREATEST + insert reverse card_transaction（已在 `lib/refund-cascade.ts` 落地）
```

### 2.3 P1-#3 — admin.pr.spec.md 增 prepaid_cards 余额管理 UI

**目标文件**：`.42cog/pm/admin.pr.spec.md`（在"充值卡"相邻位置，靠近订单管理 AC 之后）

**新增 AC**（建议序号 AC-19，紧贴现有页面顺序）：

```markdown
### AC-19 充值卡管理（`/cards` + `/card-transactions`）

#### AC-19.1 充值卡列表 `/cards`

| 列 | 字段 | 备注 |
|----|------|------|
| 卡号 | card_id | text |
| 持有顾客 | clientWechatUsers.name + phone | JOIN |
| 绑定门店 | stores.name | JOIN |
| 余额 | balance | 红色显示 < 0（异常 — DB 已 CHECK 防止） |
| 总充值 | SUM(amount > 0 from card_transactions) |  |
| 创建时间 | created_at | desc |
| 操作 | "查看流水" → `/card-transactions?card_id=` | |

权限：`prepaid_card:read`（admin / manager / finance）

#### AC-19.2 充值卡流水 `/card-transactions`

| 列 | 字段 |
|----|------|
| 时间 | created_at desc |
| 类型 | change_type enum（充值/抵扣/退款回冲/管理员调整） |
| 金额 | amount（正绿负红） |
| 关联订单 | ref_sale_order_id（点击跳订单详情） |
| 备注 | note |

筛选：card_id / 顾客手机号 / change_type / 时间范围

**手动调账**（仅 admin）：`adjustBalance(cardId, delta, reason)` 写 change_type='管理员调整' 流水，必经 logOperation 审计
```

### 2.4 P1-#4 — sys.spec.md 错误前缀 4→9 项扩展

**目标文件**：`.42cog/dev/sys.spec.md` 和 `.42cog/dev/admin.sys.spec.md`

**sys.spec.md** 在"三端速查"表之后追加：

```markdown
## 错误码体系（三端统一 9 项白名单）

云函数响应：`{ code, message, data, errorType }`，前端按 `errorType` 二级路由（不只看 `code`，因 -403/-400 共享多前缀）。

| 前缀 | code | 含义 |
|------|------|------|
| `UNAUTHORIZED:` | -401 | 未登录 / openid 失效 |
| `PHONE_REQUIRED:` | -403 | 未绑定手机号 |
| `INVALID_PARAMS:` | -400 | 入参不合法 |
| `PERMISSION_DENIED:` | -403 | 鉴权失败 |
| `NOT_FOUND:` | -404 | 资源不存在 / 不可见 |
| `INSUFFICIENT_BALANCE:` | -400 | 储值卡余额 / 剩余次数不足 |
| `CONFLICT:` | -409 | 并发冲突 / 唯一约束 / 状态被改 |
| `INVALID_STATE:` | -400 | 状态机不允许该操作 |
| `CLIENT_NOT_REGISTERED:` | -400 | 顾客未注册（staff/admin 抛） |

二级前缀语法：`<一级前缀>: <子标签>: <用户消息>`（如 `INVALID_STATE: STATE_TRANSITION_BLOCKED: ...`）。

跨端一致性由 snapshot 守护：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js` + `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 任一漂移立即失败。

详见各端 `utils/error-codes.js` + `fengyu-admin/src/lib/api-error.ts`。
```

**admin.sys.spec.md** 同步增等同小节（已在 client.sys.spec.md / staff.sys.spec.md 各有 9 项；admin 需补 ApiError 类介绍 + permission/state error 抛出路径）。

### 2.5 P1-#5 — sys.spec.md 添加 cron STEP 配套 schema docstring 守卫

**目标文件**：`.42cog/dev/sys.spec.md`（接 §2.4 之后或单设"自动化守护"小节）

**新增约定**：

```markdown
## cron STEP 与 schema docstring 反向引用

`fengyu-admin/src/cron/steps/*.ts` 的 STEP 实现中，凡是 WHERE / UPDATE 子句硬编码以下 3 类字面量的，**对应 schema 字段必须在 docstring 中反向标注**，避免未来枚举值新增时 cron 漏更：

1. **enum 值字面量**（如 `status IN ('待确认','已确认')`、`change_type = '退款'`）
   - 对应 `db/schema/enums.ts` 的 enum 定义需加注：`/** 引用方：cron.closeExpiredAppointments WHERE 子句 */`
2. **system_configs.key 字面量**（如 `key = 'new_member_threshold'`）
   - 对应 `db/schema/system-config.ts` 列定义需加注：`/** cron 消费者：getMemberThreshold（双层缓存） */`
3. **operation_logs.action 命名空间**（如 `'cron.audit_invariants'`）
   - 同名约束记录在 `db/schema/operation-log.ts` 注释或 `notes/references/cron-action-namespace.md` 单源

**审计**：CI 中新加 `bun run scripts/lint-cron-schema-coupling.mjs`（待开），grep 全部 cron/steps/*.ts 的 enum 字面量，反向 grep schema 是否含 "cron." 反向注释；缺失即 fail。
```

> 注：CI lint 脚本本身不在本 ticket 范围（doc only），仅记录决策，单开 ticket 实现。

### 2.6 P1-#6 — CLAUDE.md 增跨端复制函数禁令

**目标文件**：`/Users/nv/proj.xt.com/fengyu-wxapp/CLAUDE.md`（"全局规范"段落末尾追加）

**新增条目**：

```markdown
- **禁止跨端共享代码目录** — 不抽取 `cloudfunctions-shared/` / npm workspace / git submodule / symlink；clientApi、staffApi、payNotify、fengyu-admin 四端共有的工具函数（如 `refund-cascade`、`settlePoints`、`scope`、`error-codes`）一律**各自保留独立副本**，一致性靠 `cross-end-sql-snapshot.test.js` / `cross-end-error-codes-snapshot.test.js` 字面量 snapshot 守护。改一端必同步其它端 + 跑 snapshot 测试，任何漂移立即红。**用户已 veto cloudfunctions-shared 方案**（参考 `notes/memory/feedback_no_shared_cloudfunctions.md`）。
```

**after grep 期望**：

```
$ grep -nE "cloudfunctions-shared|跨端共享|独立副本.*snapshot" CLAUDE.md
（应命中新增的 1 行）
```

## 3 整体 DoD（验收 Checklist）

每项独立 checkbox + before/after grep 命令：

- [ ] **P1-#1**：`grep -rnE "valid_start|valid_end" .42cog/` 0 命中（before: 10 命中）
- [ ] **P1-#1**：`grep -rnE "is_enabled" .42cog/pm/` ≥ 4 命中（products/skus × 2 spec × 2）
- [ ] **P1-#2**：`grep -n "2.21.X\|储值卡抵扣启用范围" .42cog/pm/backend.pr.spec.md` 1 命中
- [ ] **P1-#3**：`grep -n "AC-19\|充值卡管理\|/cards\|/card-transactions" .42cog/pm/admin.pr.spec.md` ≥ 3 命中
- [ ] **P1-#4**：`grep -n "UNAUTHORIZED:\|9 项" .42cog/dev/sys.spec.md` ≥ 1 命中（before: 0）
- [ ] **P1-#4**：`grep -n "UNAUTHORIZED:\|9 项" .42cog/dev/admin.sys.spec.md` ≥ 1 命中（before: 0）
- [ ] **P1-#5**：`grep -n "cron STEP\|schema docstring" .42cog/dev/sys.spec.md` ≥ 1 命中
- [ ] **P1-#6**：`grep -nE "cloudfunctions-shared|独立副本.*snapshot" CLAUDE.md` 1 命中
- [ ] **总**：6 项 PR commit 描述中分别引用 SUMMARY §4 L9 对应行号 + ticket §2.x 子标题
- [ ] **总**：admin / staff / client 3 端 sys.spec.md 错误前缀小节句式一致（diff 一致性 review）
- [ ] **总**：本 ticket 一旦 merge，可关闭 SUMMARY §4 L9 P1 列表 6 项中**全部** 6 项；§4 L9 P1 数 6 → 0；§4 总表更新

## 4 风险与回滚

| 风险点 | 评估 | 缓解 |
|--------|------|------|
| spec 改动引发关联 ticket 误判（如审计报告引用旧字段名）| 低 | 仅文档，不影响代码；audit-09 / audit-14 报告内残留 valid_start 字面量保持不动（审计快照属于历史，不追溯） |
| §2.3 admin AC-19 与 admin.ui.spec.md 描述不一致 | 中 | 本 ticket 仅落 PR spec（pm/）；ui spec 同步在另一 PR 跟（小步迭代） |
| §2.4 sys.spec.md 加 9 项后与 client/staff 各自 9 项产生 SSoT 三处分散 | 低 | 在 sys.spec.md 列表后加一句"细节以各端 utils/error-codes.js 为单源"，明确 spec 仅描述形态、字面量去代码 |
| §2.5 docstring 守卫缺 CI 落地 | 中 | 本 ticket 仅记决策；CI 实现单开 ticket（"cron-schema-coupling-lint" 后续） |
| §2.6 CLAUDE.md 加完后，仍有协作者在 PR 提 cloudfunctions-shared | 低 | CLAUDE.md 已是 AI 与人共读的最高规约；review 时直接引用 |

**回滚**：纯 markdown，git revert PR 即恢复；spec 改回不影响任何运行时代码。

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | [SUMMARY §6.4 / §4 L9 Spec 层](../../docs/audit/SUMMARY.md) |
| 关联 schema | `db/schema/product.ts:91, 156`（is_enabled 实际定义） |
| 关联 反馈 memory | `feedback_no_shared_cloudfunctions.md` / `feedback_skill_scope.md` / `feedback_test_colocation.md` |
| 关联 archived | `notes/tickets/archives/2026-04-23-prepaid-card-deduction-by-store.md`（储值卡按门店结算业务约束） |
| 关联 cron | `fengyu-admin/src/cron/steps/*`（schema docstring 守卫的对象） |
| 关联 守护 | `cross-end-sql-snapshot.test.js` / `cross-end-error-codes-snapshot.test.js`（snapshot 测试） |
| 部署 | 文档 PR merge 即生效，无部署步骤 |
