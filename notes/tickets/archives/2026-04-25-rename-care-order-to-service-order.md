# Ticket: 全局术语统一——"护理单" → "服务单"

> 生成日期：2026-04-25
> 严重级别：P3（术语一致性、用户体验；非功能/数据缺陷）
> 类型：UI 文案 + 错误消息 + 注释 + spec 文档术语统一（**纯字面量替换，零 schema/逻辑变更**）
> 端：fengyu-staff（主战场）+ fengyu-admin（1 处文案）
> 影响面：
>   - WXML 文案 4 处（员工端 staff）
>   - 错误消息 2 处（staffApi/routes/service.js）+ 配套测试 7 处
>   - admin TSX 文案 1 处（member-benefits-page.tsx）
>   - TS/JS 注释 8+ 处
>   - spec 文档 5 处（`.42cog/`）
>   - 员工端 TabBar / navigationBarTitleText 2 处（**待用户决策**：见 §2 决策 #1）
> 前置依赖：无
>
> **一句话目标**：把代码 / UI / spec 中所有指代"service_orders 表实体"的"护理单"统一改为"服务单"，**保留** WorkFine 历史文档中的"售前/售后护理单"原称（特指 WorkFine UDT_S_259/UDT_S_762），**保留**商品名/技能名/`product_kind='护理项目'` 中含"护理"的字符串（这些不是订单概念）。

---

## 0 一句话背景

需求原文：
> 统一全局护理单和服务单的名称为服务单。

调研发现仓库现状：**DB 表名已是 `service_orders`、`service_items`，前端路由也是 `pages/service/`，只有 UI 文案 / 错误消息 / 注释 / spec 文档残留"护理单"叫法**。这是一次纯术语收口工作，无逻辑、无 schema、无数据迁移。

| 维度 | 现状 | 一致性 |
|---|---|---|
| 数据库表 | `service_orders` / `service_items` | ✅ 已统一为"服务" |
| 数据库枚举 `service_order_type` | `["售前","售后"]`（不含"护理"二字）| ✅ |
| 路由 / 文件路径 | `pages/service/`、`packageService/` | ✅ |
| 详情页 `navigationBarTitleText` | "服务单详情" / "创建服务单" | ✅ |
| 列表页 `navigationBarTitleText` | "服务单"（旧 `service-list`，已废弃跳转）| ✅ |
| 员工端 TabBar | `text: "护理"` | ❌ 不一致 |
| 员工端 Tab 页 `navigationBarTitleText` | `"护理"` (`pages/service/service.json`) | ❌ 不一致 |
| 员工端 Tab 内 WXML 文案 | "护理单列表" / "新建护理单" / "暂无…的护理单" | ❌ 不一致 |
| 预约详情 / 客户详情 WXML | "创建护理单" / "关联护理单" / "护理单 ID" | ❌ 不一致 |
| admin 会员权益页文案 | "20 号下护理单的顾客" | ❌ 不一致 |
| 云函数错误消息 | `INVALID_PARAMS: 该顾客已有进行中的护理单` | ❌ 不一致 |
| spec / 注释 | 多处混用 | ❌ 不一致 |

---

## 1 受影响清单（已全仓 grep 完毕）

### 1.1 必改：UI 文案（用户可见，最高优先级）

| # | 文件 | 行 | 当前文本 | 期望文本 |
|---|------|----|---------|---------|
| A1 | `fengyu-staff/miniprogram/packageService/appointment-detail/appointment-detail.wxml` | 28 | `<!-- 关联护理单 -->` | `<!-- 关联服务单 -->` |
| A2 | 同上 | 29 | `title="关联护理单"` | `title="关联服务单"` |
| A3 | 同上 | 30 | `title="护理单 ID"` | `title="服务单 ID"` |
| A4 | 同上 | 61 | `>创建护理单</van-button>` | `>创建服务单</van-button>` |
| A5 | `fengyu-staff/miniprogram/packageCustomer/customer-detail/customer-detail.wxml` | 277 | `>创建护理单 ({{selectedCount}})</van-button>` | `>创建服务单 ({{selectedCount}})</van-button>` |
| A6 | `fengyu-staff/miniprogram/pages/service/service.wxml` | 25 | `description="暂无...的护理单"` | `description="暂无...的服务单"` |
| A7 | 同上 | 28 | `<!-- 护理单列表 -->` | `<!-- 服务单列表 -->` |
| A8 | 同上 | 101 | `<!-- FAB: 新建护理单 -->` | `<!-- FAB: 新建服务单 -->` |
| A9 | `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx` | 114 | `每月 20 号 下护理单的顾客（即当日存在已完成或进行中服务单）` | `每月 20 号 下服务单的顾客（即当日存在已完成或进行中服务单）` |

### 1.2 必改：错误消息（用户可见，会出现在 toast）

| # | 文件 | 行 | 当前文本 | 期望文本 |
|---|------|----|---------|---------|
| B1 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 142 | `// 校验：同一顾客只能有一个进行中的护理单` | `// 校验：同一顾客只能有一个进行中的服务单` |
| B2 | 同上 | 149 | `INVALID_PARAMS: 该顾客已有进行中的护理单（${...}），请先完成后再创建` | `INVALID_PARAMS: 该顾客已有进行中的服务单（${...}），请先完成后再创建` |

### 1.3 必改：测试断言（跟随 B2 的字符串变更）

| # | 文件 | 行 | 改动 |
|---|------|----|------|
| C1 | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js` | 40, 84, 214, 234, 303, 1419, 1466 | 注释 `已有进行中的护理单` → `已有进行中的服务单`；正则断言 `/INVALID_PARAMS.*已有进行中的护理单/` → `/INVALID_PARAMS.*已有进行中的服务单/`（L234）|

> **注意**：L234 是 `.rejects.toThrow(/.../)` 正则断言，必须与 B2 的新文案严格匹配，否则该用例失败。

### 1.4 待用户决策：员工端 TabBar / 标题（见 §2 决策 #1）

| # | 文件 | 行 | 当前 | 候选改法 |
|---|------|----|------|---------|
| D1 | `fengyu-staff/miniprogram/app.json` | 77 | `"text": "护理"` | `"text": "服务"`（与 Tab 业务对应；TabBar 限 4 字内）|
| D2 | `fengyu-staff/miniprogram/pages/service/service.json` | 2 | `"navigationBarTitleText": "护理"` | `"navigationBarTitleText": "服务"` |

### 1.5 建议改：代码注释（不影响运行，但建议跟随）

| # | 文件 | 行 | 改动 |
|---|------|----|------|
| E1 | `db/schema/service.ts` | 9 | `* 护理单主表` → `* 服务单主表` |
| E2 | `db/schema/service-commission.ts` | 9 | `* 护理单完成时触发...` → `* 服务单完成时触发...` |
| E3 | `db/schema/index.ts` | 19 | `// 护理单 + 护理明细` → `// 服务单 + 服务明细` |
| E4 | `fengyu-staff/miniprogram/packageService/service-list/service-list.ts` | 2-3 | 注释中 `护理单`→`服务单`，`护理 Tab`→`服务 Tab`（与 D1 决策一致）|
| E5 | `fengyu-staff/miniprogram/pages/service/service.wxml` | 1 | 顶部注释 `<!-- 护理 Tab -->` → `<!-- 服务 Tab -->`（与 D1 决策一致）|
| E6 | `fengyu-staff/miniprogram/pages/service/service.ts` | 1 | 同上 |
| E7 | `fengyu-staff/miniprogram/CLAUDE.md` | 18 | 表格行 `\| 护理 \| pages/service/service \| 护理单列表与管理 \|` → `\| 服务 \| pages/service/service \| 服务单列表与管理 \|` |

### 1.6 必改：spec 文档（项目术语规范）

| # | 文件 | 行 | 改动 |
|---|------|----|------|
| F1 | `.42cog/pm/backend.pr.spec.md` | 271 | `### 2.11 service_orders（护理单主表）` → `### 2.11 service_orders（服务单主表）` |
| F2 | 同上 | 663-664 | `护理单来源约束` → `服务单来源约束`；`再创建护理单` → `再创建服务单` |
| F3 | `.42cog/pm/staff.pr.spec.md` | 257 | `#### 3.8 服务单（护理单）` → `#### 3.8 服务单`（去掉别名括注）|
| F4 | `.42cog/dev/staff.sys.spec.md` | 300 | `创建护理单(service_order_type 由顾客...)` → `创建服务单(service_order_type 由顾客...)` |

### 1.7 **不改**：WorkFine 历史文档（特指 WorkFine 系统术语）

以下文件中的"护理单"特指 WorkFine 表 `UDT_S_259`（售后护理单）/ `UDT_S_762`（售前护理单），是 WorkFine 系统的中文表名，**保留原称**避免误导后续 WorkFine 数据查阅：

- `.42cog/pm/workfine-sync.spec.md`（多处：UDT_M_331 顾客护理明细子表、UDT_S_259 售后护理单、UDT_S_762 售前护理单等）
- `db/scripts/migrate-service-records.js`（迁移脚本注释 / 日志）
- `db/scripts/migrate-presale-services.js`（同上）
- `notes/research/workfine_database.md`（WorkFine 调研报告）
- `.claude/skills/syncing-workfine/SKILL.md`（WorkFine 同步技能说明）
- `notes/tickets/archives/2026-04-24-member-thanksgiving-benefits.md`（已归档 ticket，历史记录不动）

### 1.8 **不改**：商品名 / 技能名 / `product_kind` 含"护理"二字

这些不是订单概念，是商品/技能/分类的属性名，**保留原文**：

- `product_kind = '护理项目'`（DB 枚举值，4/17 会议决策已固化）
- 商品名：`蜜语水润嫩肤护理`、`经络疏通养生护理`、`光子嫩肤仪器护理`、`身体护理`、`面部护理` 等
- 员工技能：`'面部护理'`、`'身体护理'`（`staff_wechat_users.skills`）
- Mock 数据中商品名（`fengyu-*/miniprogram/mock/*.ts`）
- 测试 fixtures 中的 `product_name`（保持业务可读性）
- `clientApi/__tests__/routes/service.test.js:19` `service_order_type: '护理'` —— **这是 mock 测试数据**，但 `service_order_type` 枚举实际值是 `['售前','售后']`，该 mock 字面量与 schema 不一致（疑似遗留）；**本 ticket 不在范围**，建议另开 fix（`/wx-change-propagation`）单独处理

---

## 2 用户确认的规则（决策基准线）

| # | 决策点 | 决策 | 状态 |
|---|--------|------|------|
| 1 | 员工端 TabBar `text: "护理"` 是否改 `"服务"`？同步改 `pages/service/service.json` 的 `navigationBarTitleText` | **改**（TabBar 文案 + Tab 页 navTitle 都改"服务"，与全局统一） | ✅ 已确认（2026-04-25）|
| 2 | 测试用例中的 `service_order_type: '护理'` mock 字面量（client/__tests__/routes/service.test.js:19）| **另开独立 ticket**：`notes/tickets/2026-04-25-service-order-type-enum-mock-mismatch.md`（由 subagent 调研后产出，不在本 ticket 范围）| ✅ 已确认（2026-04-25）|
| 3 | spec 文档 `.42cog/pm/staff.pr.spec.md:257` 当前是 `服务单（护理单）` 同义括注 → 改为单纯 `服务单` 还是保留括注作过渡？| **去掉括注**（彻底统一，不保留旧名同义引用）| ✅ 已确认（2026-04-25）|
| 4 | `db/scripts/migrate-service-records.js` 等 WorkFine 迁移脚本中"护理单" | **保留**（特指 WorkFine 表 UDT_S_259/762 原名，与 PG 实体不混淆）| ✅ 已确认（2026-04-25）|
| 5 | 已归档 ticket（`notes/tickets/archives/`）中的"护理单" | **保留**（历史记录，改动会污染审计轨迹）| 默认接受 |
| 6 | 是否同步修改 `notes/references/` 下的 `员工端需求整理.md` / `staff_pr.md` 等参考资料？| **保留**（这些是历史需求文档，不是当前 spec 源）| 默认接受 |
| 7 | 是否更新 `MEMORY.md` 中相关记忆条目？| 不需要（MEMORY.md 当前没有"护理单"字面量）| 已确认无需改 |
| 8 | 改动是否拆 PR？| **合并为 1 PR**（纯字面量替换、无逻辑分支、改动小）| ✅ 已确认（2026-04-25）|

---

## 3 Schema 变更

**无**。本 ticket 不触及任何 DB 表 / 列 / 枚举 / 索引 / 约束。

- `service_orders.service_order_type` 枚举值 `['售前','售后']` —— 不动
- `service_orders` 表名 / 列名 —— 已是"服务"，不动
- 无需 migration

---

## 4 实施步骤

### 步骤 1：UI 文案 + 错误消息 + 测试断言（必改集合 A+B+C）

**改动文件**：
- `fengyu-staff/miniprogram/packageService/appointment-detail/appointment-detail.wxml`
- `fengyu-staff/miniprogram/packageCustomer/customer-detail/customer-detail.wxml`
- `fengyu-staff/miniprogram/pages/service/service.wxml`
- `fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx`
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js`
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js`

**操作**：按 §1.1 / §1.2 / §1.3 表格逐行替换。**注意**：
- WXML 中 Vant 组件属性值（如 `title="关联护理单"`）替换时保留引号
- service.test.js L234 的正则需同步：`/INVALID_PARAMS.*已有进行中的护理单/` → `/INVALID_PARAMS.*已有进行中的服务单/`

**验证**：
- `cd fengyu-staff/cloudfunctions/staffApi && npm test -- service.test.js` → 全绿
- `cd fengyu-admin && npx tsc --noEmit` → 无新错误（仅文案改动，类型无关）

### 步骤 2：员工端 TabBar / 导航栏标题（待用户确认 §2 决策 #1）

**仅当决策 #1 = "改"**：
- `fengyu-staff/miniprogram/app.json` L77 `"text": "护理"` → `"text": "服务"`
- `fengyu-staff/miniprogram/pages/service/service.json` L2 `"navigationBarTitleText": "护理"` → `"navigationBarTitleText": "服务"`

**验证**：微信开发者工具打开 fengyu-staff/miniprogram/，目视检查 TabBar 文案 + 进入 Tab 后导航栏标题。

### 步骤 3：注释 + spec 文档（建议改集合 E+F）

**改动文件**：见 §1.5 / §1.6 表格。

**操作**：逐行替换。注意 `.42cog/pm/staff.pr.spec.md:257` `#### 3.8 服务单（护理单）` 直接去括注（按决策 #3）。

**验证**：`grep -rn "护理单" .42cog db/schema fengyu-staff/miniprogram/CLAUDE.md` → 应无残留（WorkFine spec 行除外）。

### 步骤 4：全仓回归 grep（验收门禁）

```bash
# 应仅剩 WorkFine 相关文件 + archives + 第三方/无关字符串
grep -rn "护理单" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.wxml" --include="*.json" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=miniprogram_npm \
  | grep -v "workfine\|WorkFine\|UDT_S_259\|UDT_S_762\|UDT_M_260\|UDT_M_263\|UDT_M_331\|notes/tickets/archives"
```

期望结果：**0 行**。如有残留，按本 ticket 表格补漏。

---

## 5 验收标准

1. ✅ 员工端"创建服务单"按钮（顾客详情页底部、预约详情页、服务 Tab FAB）所有按钮文案统一为"服务单"
2. ✅ 员工端服务 Tab 空状态文案 "暂无…的服务单"（不再出现"护理单"）
3. ✅ 员工端预约详情"关联服务单"区块标题、"服务单 ID" 行标题统一
4. ✅ admin 会员权益感恩日 Tab 文案"每月 20 号 下服务单的顾客"
5. ✅ 触发 staffApi `service.create`、顾客已有进行中服务单时 → toast 显示 `INVALID_PARAMS: 该顾客已有进行中的服务单（…）` （不再出现"护理单"）
6. ✅ `service.test.js` 7 处相关用例全绿（含 L234 正则断言）
7. ✅ §2 决策 #1 = "改" 时：员工端 TabBar 显示"服务"、点击进入后顶部导航栏标题"服务"
8. ✅ `.42cog/pm/backend.pr.spec.md` / `staff.pr.spec.md` / `dev/staff.sys.spec.md` 中所有"护理单"描述替换为"服务单"（除 WorkFine 历史相关行）
9. ✅ `db/schema/service.ts` / `service-commission.ts` / `index.ts` 顶部注释更新
10. ✅ §4 步骤 4 的全仓 grep 命令返回 0 行残留
11. ✅ admin `bun run build` 通过；client/staff `npm test` 通过；admin `npx tsc --noEmit` 通过

---

## 6 风险与决策点

| # | 风险/决策 | 处理方案 |
|---|---|---|
| 6.1 | service.test.js L234 正则断言未跟随改 → 用例失败 | 强制 §1.3 与 §1.2 同 PR 提交，code review checklist 项 |
| 6.2 | TabBar 文案改后用户认知断层（老员工已习惯"护理"）| 决策 #1 留给用户拍板；若改，建议在员工端发布说明同步 |
| 6.3 | WorkFine 同步脚本日志中"护理单"表述与新 UI 术语不一致 → 排障时混淆 | §1.7 明确只指 WorkFine 表名，建议在 `db/scripts/CLAUDE.md` 顶部加一句"本目录脚本中的'护理单'特指 WorkFine 表 UDT_S_259/762，与 PG `service_orders` 同义但保留原称"（**本 ticket 不做**，可作 follow-up） |
| 6.4 | spec 改动后历史 ticket 与新 spec 引用不一致 | 接受。历史 ticket 是审计快照，spec 是当前源；冲突时以 spec 为准 |
| 6.5 | client/__tests__/routes/service.test.js:19 的 mock `service_order_type: '护理'` 与 enum `['售前','售后']` 不符 | §2 决策 #2，单独追究；本 ticket 不动 |
| 6.6 | `notes/references/` 历史需求文档不改 → 新人对照容易混淆 | §2 决策 #6 留给用户；建议在 `notes/references/README.md` 顶部加"参考文档术语可能滞后于 .42cog/spec，以 spec 为准"提示（本 ticket 不做） |
| 6.7 | E2E 测试若有断言"护理单"文本（如检测按钮可点击）会失败 | 已 grep `fengyu-staff/miniprogram/e2e/*.test.js`：仅 `service.test.js:10` `describe('护理管理', ...)` 含字面量，建议改为 `describe('服务管理', ...)`（已含在 §1.5 隐含范围；步骤 1 顺手处理）|

---

## 7 不在本 ticket 范围

- DB 表 / 列 / 枚举重命名（已是 service_*，无需）
- API action 名变更（`service.*` 已统一）
- 路由 / 文件路径重命名（`pages/service/` / `packageService/` 已统一）
- 商品名 / 技能名 / `product_kind='护理项目'` 中"护理"字面量（与订单概念无关）
- WorkFine 同步脚本 / WorkFine spec / WorkFine 调研文档中"售前/售后护理单"（特指 WorkFine 表）
- 已归档 ticket（`notes/tickets/archives/`）中的"护理单"（审计轨迹）
- `clientApi/__tests__/routes/service.test.js:19` mock 的 `service_order_type: '护理'`（schema 一致性 bug，另开 ticket）
- `db/scripts/CLAUDE.md` 顶部加 WorkFine 术语免责声明（follow-up，§6.3）
- `notes/references/README.md` 加术语滞后提示（follow-up，§6.6）
- 微信开发者工具截图 / TabBar 图标（仅文字改，icon 不动）
- 用户文档 / 培训材料更新（无此物，员工通过 Tab 视觉认知切换）

---

## 8 工作量预估

| 步骤 | 工作量 | 说明 |
|---|---|---|
| 步骤 1（必改 UI + 错误消息 + 测试）| 30 分钟 | 6 个文件，~12 处替换；测试用 npm test 验证 |
| 步骤 2（TabBar / nav title，待决策）| 5 分钟 | 2 个 JSON 一处改 |
| 步骤 3（注释 + spec 文档）| 15 分钟 | 8+ 处替换；无运行时影响 |
| 步骤 4（回归 grep + tsc + bun build + npm test）| 10 分钟 | 命令验证 |
| **合计** | **~1 小时** | 单 PR 即可，纯字面量 diff |

---

## 9 相关引用

### 现有代码
- 员工端服务 Tab 主页：`fengyu-staff/miniprogram/pages/service/service.wxml` / `service.ts` / `service.json`
- 员工端 TabBar：`fengyu-staff/miniprogram/app.json:75-79`
- 员工端预约详情：`fengyu-staff/miniprogram/packageService/appointment-detail/appointment-detail.wxml`
- 员工端顾客详情：`fengyu-staff/miniprogram/packageCustomer/customer-detail/customer-detail.wxml:277`
- 员工端服务详情 / 创建：`fengyu-staff/miniprogram/packageService/service-detail/` / `service-create/`（已是"服务单"，参照系）
- staffApi service 路由：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:142-149`
- staffApi service 测试：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js`
- admin 会员权益页：`fengyu-admin/src/app/(main)/member-benefits/_components/member-benefits-page.tsx:114`
- service_orders schema：`db/schema/service.ts:9`
- service-commission schema：`db/schema/service-commission.ts:9`
- schema 索引：`db/schema/index.ts:19`
- 员工端 CLAUDE：`fengyu-staff/miniprogram/CLAUDE.md:18`

### spec 文档
- `.42cog/pm/backend.pr.spec.md:271,663,664`
- `.42cog/pm/staff.pr.spec.md:257`
- `.42cog/dev/staff.sys.spec.md:300`
- `.42cog/pm/workfine-sync.spec.md`（**保留**）

### 关联约束
- `service_order_type` 枚举：`db/schema/enums.ts:68` `["售前", "售后"]`（不变）
- `service_orders.status` 枚举：`db/schema/enums.ts:66` `["待服务","服务中","已完成","已取消"]`（不变）

### 协作技能
- 本 ticket 类型：UI 文案统一（**纯字面量替换**），按 `wx-requirement-adapt` skill §5.4"概念合并"模式处理
- **不**走 `wx-change-propagation`：无 schema/枚举/字段变更，不触发 10 层传播图
- 落地后建议用 smart-commit 单 PR 提交，按"docs+ui 文案统一"主题分组
