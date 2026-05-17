# Admin Chrome 手动 E2E 测试流程

**最近一次更新**：2026-05-17（迁移至 `fengyu-admin/scripts/manual-e2e/` + 新增 11 条业务扩展链路）
**目的**：为"用真实浏览器（人工 / Claude in Chrome / Playwright headed）走一遍 admin 业务流程"提供可执行的测试地图。
**与现有 Playwright E2E 的区别**：现有 25 个 `e2e/*.spec.ts` 中 87% 是页面渲染断言，本套 spec 聚焦**跨页面、跨角色、有状态机、有金额/积分会计恒等式**的端到端业务闭环——这些场景写自动化成本高、肉眼一眼能看出问题。

---

## 0. 目录约定（2026-05-17 之后）

所有 admin E2E 手动测试相关文件已统一收敛到 `fengyu-admin/scripts/manual-e2e/`：

```
fengyu-admin/scripts/manual-e2e/
├── README.md                       # 本文件（原 notes/research/admin-chrome-e2e-plan.md）
├── playwright.manual.config.ts     # 独立 Playwright 配置（不走主 e2e 流程）
├── test-fixtures.json              # 固定测试夹具索引（顾客/SKU/卡/券）
├── .last-test-context.json         # 跑批上下文（链路间产物传递）
├── _helpers/
│   └── cleanup.ts                  # 销售单全 FK 链清理工具
└── link-N-xxx.spec.ts              # 12+ 条业务链路
```

历史路径迁移对照：

| 旧路径（已弃） | 新路径 |
|---------------|--------|
| `notes/research/admin-chrome-e2e-plan.md` | `fengyu-admin/scripts/manual-e2e/README.md` |
| `notes/research/test-fixtures.json` | `fengyu-admin/scripts/manual-e2e/test-fixtures.json` |
| `notes/research/.last-test-context.json` | `fengyu-admin/scripts/manual-e2e/.last-test-context.json` |

→ spec 文件内 `CONTEXT_FILE` 已统一为 `path.resolve(__dirname, './.last-test-context.json')`。

---

## CC 必读（执行前请先读完）

**目标读者**：本文档由 Claude Code（CC）拿来按顺序驱动浏览器执行。

**CC 当前可用的浏览器驱动手段**（按优先级排序）：

1. **Playwright headed 临时脚本**（默认推荐）
   - 直接写到 `fengyu-admin/scripts/manual-e2e/link-N-xxx.spec.ts`
   - `cd fengyu-admin && bunx playwright test --config=scripts/manual-e2e/playwright.manual.config.ts scripts/manual-e2e/link-N-xxx.spec.ts`
   - 可看浏览器、可读 console、可截图、可断点
   - CC 写脚本 → 用户在终端跑 → CC 读输出 / 截图

2. **Claude in Chrome MCP**（要先装扩展并重启会话）
   - 工具名 `mcp__claude-in-chrome__*`
   - 仅在系统提示有 `<functions>` 注册时可用

3. **手工流程 + DB 抽查**（CC 不操作浏览器，只指导）
   - 用户按文档步骤手动点击
   - CC 跑 SQL 验证库状态

**CC 执行的纪律**：

- 跑链路前先读 §0.5 的固定夹具，**不要**自己造顾客 / SKU
- 每条链路结束后**必须**跑清理 SQL 或调用 `_helpers/cleanup.ts`，否则下次跑会数据冲突
- 跑 SQL 一律加 `PGPASSWORD=fengyu123 ` 前缀连 5433（参见 §0.3）
- 状态枚举值**全部用中文**（`已支付` `待确认` `已完成`），不是英文
- 链路间上下文（订单号 / 服务单号）通过 `./.last-test-context.json` 传递（§0.6）
- 写新 spec 之前，**必读** `_helpers/cleanup.ts` 与最近一次成功的相邻链路 spec，复用其 helper 与选择器
- 不能复用 `e2e/` 主流程下的 storageState（双方 fixture 假设不同），手动 e2e 自己维护 `.auth/` 子目录

---

## 0.1 服务

| 项 | 命令 / 地址 |
|----|------------|
| Admin dev server | `cd fengyu-admin && bun run dev` → `http://localhost:3000` |
| 数据库 | **测试库** `47.113.202.7:5433/fengyu_wxapp`（用户 `fengyu` 密码 `fengyu123`），主库 `5434/fengyu` 不要碰 |
| 切换 admin 连接 | 改 `fengyu-admin/.env.local` 的 `DATABASE_URL` 指向 5433/fengyu_wxapp，重启 dev server |
| Cron worker（按需） | `cd fengyu-admin && bun run cron:once` 手动触发会员/积分日任务 |

## 0.2 测试账号

> 库：5433/fengyu_wxapp。密码统一 `fengyu2026`（bcrypt hash 已写入 `admin_passwords`，`must_change=false`）。

| 角色 | employee_id | 手机号 | 姓名 | scope 类型 | scope_id | 用途 |
|------|------------|--------|------|-----------|----------|------|
| admin | FY-TEST-ADM | 13900139000 | 测试管理员 | 总部 | `16d1184b46db099a` | 数据源头（员工/产品/提成）+ 退款审批 |
| manager（市场） | FY-TEST-MKT | 13900139006 | 测试市场总 | 市场 | `6707cc8b88579108`（南昌市场，31 家店）| 跨店数据汇总 + 市场 scope 展开（市场 → 旗下门店列表） |
| manager（门店） | FY-TEST-MGR | 13900139001 | 测试店长 | 门店 | `org-store-nc01`（南昌旗舰店）| 业务全链（开单/分配/服务/预约确认）+ 单店 scope 隔离 |
| finance | FY-TEST-FIN | 13900139002 | 测试财务 | 总部 | `16d1184b46db099a` | 订单/分配只读 + 无创建权 + 退款审批 |
| hr | FY-TEST-HR | 13900139003 | 测试人事 | 总部 | `16d1184b46db099a` | 员工/权限/调店 scope 同步 |
| product | FY-TEST-PRD | 13900139004 | 测试品项 | 总部 | `16d1184b46db099a` | 商品/券管理可达 |
| customer_mgr | FY-TEST-CSM | 13900139005 | 测试客服 | 总部 | `16d1184b46db099a` | 仅顾客域可见 |

**store_id 与 org_node_id 设置**：
- 总部/门店 scope 角色（admin、finance、hr、product、customer_mgr、门店 manager）：`store_id='store-nc01'`、`org_node_id='org-store-nc01'`
- admin（FY-TEST-ADM）和市场 scope（FY-TEST-MKT）：`store_id=NULL`、`org_node_id='总部/市场 id'`（不属于具体门店）

> **注意**：原 admin 账号 FY-260321001 / 15958024944（双角色 admin+manager）保留不动，作为生产历史数据；测试请用上表的 7 个 `FY-TEST-*` 账号。

**三层 scope 测试矩阵**（用于验证 `expandScopeStoreIds` 行为）：

| 账号 | scope 类型 | 期望可见门店数 |
|------|-----------|--------------|
| admin / 总部 manager | 总部 | 全部门店 |
| FY-TEST-MKT | 市场（南昌） | 31 家南昌市场门店 |
| FY-TEST-MGR | 门店（南昌旗舰）| 仅 1 家 store-nc01 |

**测试账号清理**（测完后）：
```sql
DELETE FROM permission_roles WHERE employee_id LIKE 'FY-TEST-%';
DELETE FROM admin_passwords WHERE employee_id LIKE 'FY-TEST-%';
DELETE FROM staff_wechat_users WHERE employee_id LIKE 'FY-TEST-%';
```

## 0.3 数据快照与回滚

定义 shell 别名（CC 跑 bash 时直接复制）：

```bash
PSQL_TEST="PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp"
PGDUMP_TEST="PGPASSWORD=fengyu123 pg_dump -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp"
```

每条链路开跑前 / 跑完后：

```bash
# 跑前快照（关键业务表）
eval $PGDUMP_TEST \
  --table=sale_orders --table=sale_items --table=sale_allocations \
  --table=service_orders --table=service_items \
  --table=appointments --table=user_coupons --table=point_transactions \
  --data-only > /tmp/snap-before-$(date +%H%M).sql

# 跑后对比 / 必要时回滚（覆写而非合并，确保干净状态）
eval $PSQL_TEST < /tmp/snap-before-XXXX.sql
```

> 5433/fengyu_wxapp 是测试库，可放心折腾；主库 5434/fengyu **不要直接连**。

## 0.4 CC 操作浏览器的执行模式

**默认模式：Playwright headed 临时脚本**（无须 MCP，最稳）

骨架（CC 写到 `fengyu-admin/scripts/manual-e2e/link-N-xxx.spec.ts`）：

```ts
import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

test.use({ storageState: '.auth/manager-store.json' })

test('链路 N：xxx', async ({ page }) => {
  // ... 业务流程 ...

  // 截图 + 写订单号到上下文文件
  const orderId = await page.locator('[data-testid="order-id"]').textContent()
  await page.screenshot({ path: 'test-results/link-N.png' })
  const ctx = fs.existsSync(CONTEXT_FILE)
    ? JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) : {}
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...ctx, linkN: { orderId } }, null, 2))
})
```

跑命令：
```bash
cd fengyu-admin
bunx playwright test --config=scripts/manual-e2e/playwright.manual.config.ts \
  scripts/manual-e2e/link-N-xxx.spec.ts
```

**选择器优先级**（参考已有 `e2e/orders.spec.ts` 的写法）：
1. `getByRole('button'/'heading'/'columnheader', { name: /中文/ })` — 首选
2. `getByPlaceholder(/中文/)` — 输入框
3. `getByText('精确文案')` — 文案锚点
4. `locator('select')` / `locator('#phone')` — 兜底
5. `[data-testid=...]` — 关键路径建议补加（admin 当前测试 testid 较少，需要时让用户加）

**禁忌**：
- 不要 `page.waitForTimeout(N)` 写死等待——用 `expect(...).toBeVisible()` 替代
- 不要点会触发原生 `confirm()` 的元素（admin 用 AlertDialog，但极少数页面可能有）

### 0.4.1 多角色 storageState 准备

每个测试角色需要一份 `.auth/{role}.json`：

```ts
// scripts/manual-e2e/setup/login-roles.setup.ts
import { test as setup } from '@playwright/test'
const ROLES = [
  { phone: '13900139000', file: '.auth/admin.json' },
  { phone: '13900139001', file: '.auth/manager-store.json' },
  { phone: '13900139006', file: '.auth/manager-market.json' },
  { phone: '13900139002', file: '.auth/finance.json' },
  { phone: '13900139003', file: '.auth/hr.json' },
  { phone: '13900139004', file: '.auth/product.json' },
  { phone: '13900139005', file: '.auth/customer-mgr.json' },
]
for (const { phone, file } of ROLES) {
  setup(`login ${phone}`, async ({ page }) => {
    await page.goto('/login')
    await page.locator('#phone').pressSequentially(phone, { delay: 30 })
    await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
    await page.getByRole('button', { name: /登 录/ }).click()
    await page.waitForURL(/\/dashboard/, { timeout: 15000 })
    await page.context().storageState({ path: file })
  })
}
```

跑一次：`bunx playwright test --config=scripts/manual-e2e/playwright.manual.config.ts scripts/manual-e2e/setup/login-roles.setup.ts`

## 0.5 固定测试夹具（fixtures）

**已就绪**：fixture 已写入 [`test-fixtures.json`](./test-fixtures.json)（5433/fengyu_wxapp 上以 `FY-FIX-` 为前缀创建）。

| Fixture | ID | 用途 |
|---------|-----|------|
| 测试顾客 | `FY-FIX-CLIENT-01` / phone `13800138000` | 链路 1-9 / 11 / 12 全部业务流水 |
| 储值卡 | `FY-FIX-CARD-01`（balance=1000，初始已写一条 +1000 流水）| 链路 10 |
| 优惠券模板 | `FY-FIX-CT-01`（现金券，满 200 减 30，30 天有效）| 链路 11 / 20 |
| user_coupon | `FY-FIX-COUPON-01`（未使用）| 链路 11 |
| 普通 SKU 1 | `c79157b29c9e974c`（缦之羽 - 洗-无创纹身 ¥100）| 链路 1 / 7 / 9 |
| 普通 SKU 2 | `2e388ba778334779`（假性皱纹管家 ¥100）| 链路 1 第二件 |
| 充值卡 SKU | `sku-007-01`（金卡 5000）| 链路 10 |
| 多次卡（已存在）| sale_item `FY-XSD-WX-2603210001-02`（脱毛 12 次卡）| 链路 12 次数对账 |

**CC 读 fixture**（从 `scripts/manual-e2e/` 内部读）：
```bash
CFIX="$(cat scripts/manual-e2e/test-fixtures.json)"
CLIENT_USER_ID=$(echo "$CFIX" | jq -r '.customer.user_id')
CLIENT_PHONE=$(echo "$CFIX" | jq -r '.customer.phone')
SKU_NORMAL=$(echo "$CFIX" | jq -r '.skus.normal_low.sku_id')
SKU_CARD=$(echo "$CFIX" | jq -r '.skus.card.sku_id')
CARD_ID=$(echo "$CFIX" | jq -r '.prepaid_card.card_id')
COUPON_ID=$(echo "$CFIX" | jq -r '.user_coupon.coupon_id')
```

**何时重建 fixture**：被链路测试污染（如 user_coupon 状态变 "已使用" 没还原）时跑：
```bash
eval $PSQL_TEST < <(jq -r '._cleanup.sql[]' scripts/manual-e2e/test-fixtures.json)
# 然后重新跑下方"重建 fixture" SQL 块（见文档历史 commit）
```

提成矩阵已确认：南昌市场配置见 `commission_rate_matrix WHERE market_name='南昌市场'`（15 行），覆盖各品类 × 角色组合，链路 1/9/15 可直接用。

## 0.6 链路上下文传递

链路有依赖（链路 4 需要链路 1 的订单），用上下文文件传递：

`scripts/manual-e2e/.last-test-context.json`（CC 自己维护，跟代码一起 commit）：
```json
{
  "link1": { "saleOrderId": "FY-XSD-WX-26042600001", "ranAt": "2026-04-26T10:00:00Z" },
  "link2": { "serviceOrderId": "FY-FW-XXXXX", "ranAt": "..." }
}
```

每条链路脚本：
- 跑前读这个文件取上一步产物
- 跑后写入自己的产物
- 链路 N 找不到链路 N-1 的产物时直接 skip 并提示

---

## 1. 核心业务链路（12 条已实现）

每条链路按"前置 → 步骤 → 检查点（UI + DB）→ 清理"四段式编排。

- 链路 1-6：业务功能闭环（开单 / 服务单 / 预约 / 退款 / 调店 / 会员升级）
- 链路 7-12：**数据一致性**专项（金额方程 / 回款累加 / 分配比例 / 卡余额 / 券状态 / 服务次数）
- §1.A：跨链路全库快照对账

### 链路 1：开单 → 收款确认 → 营业额分配 → 提成入账

**spec**：`link-1-order-allocation.spec.ts`
**角色**：FY-TEST-MGR（门店 manager）
**涉及页面**：`/orders/create` → `/orders/[saleOrderId]` → `/allocations`
**数据库副作用**：`sale_orders`（PK `sale_order_id`）+ `sale_items`（PK `sale_item_id`）+ `sale_allocations`

#### 前置
读 `test-fixtures.json` 拿到：`customer.phone`、`sku_normal.sku_id`、`sku_card.sku_id`。
确认该店该商品已配置提成矩阵（`commission_rate_matrix.market_name='南昌市场'` 至少一行）。

#### 步骤
1. 进 `/orders/create`，Step 1 用 `fixture.customer.phone` 搜顾客
2. Step 2 加购 2 个 SKU（`fixture.sku_normal` + `fixture.sku_card`），调价
3. Step 3 收银，选"线下支付"，提交
4. 跳到订单详情页，UI 显示状态徽章 **"待确认收款"**
5. 点 **"确认收款"** 按钮，徽章转为 **"已支付"**
6. 把页面 URL 上的 `saleOrderId` 写入 `.last-test-context.json` 的 `link1.saleOrderId`
7. 进 `/allocations?saleOrderId=...`，每个 `sale_item` 录入分配人 + 比例
8. 保存分配，UI 提示"分配完成"

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 订单号格式 `FY-XSD-WX-{YYMMDD}{4位}` |
| UI | 状态枚举严格中文：`待支付` → `待确认收款` → `已支付` |
| UI | 分配保存后 `/allocations?status=待分配` 不再出现该单 |
| DB | `SELECT status FROM sale_orders WHERE sale_order_id=:id` 应为 `已支付` |
| DB | `SELECT count(*) FROM sale_items WHERE sale_order_id=:id` ≥ 2 |
| DB | `SELECT count(*) FROM sale_allocations WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id=:id)` 等于 sale_items 行数 |
| DB | `SELECT allocation_status FROM sale_orders WHERE sale_order_id=:id` 应非空 |
| DB | `SELECT count(*) FROM operation_logs WHERE target_id=:id` ≥ 3（action 含 create/confirm/allocate）|

#### DB 验证脚本（CC 跑完链路后执行）
```bash
SOID=$(jq -r '.link1.saleOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
  SELECT 'order' AS kind, status, total_amount, paid_amount, allocation_status FROM sale_orders WHERE sale_order_id='$SOID'
  UNION ALL SELECT 'items', count(*)::text, NULL, NULL, NULL FROM sale_items WHERE sale_order_id='$SOID'
  UNION ALL SELECT 'allocations', count(*)::text, NULL, NULL, NULL FROM sale_allocations
    WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id='$SOID');"
```

#### 清理
调用 `cleanupSaleOrder(saleOrderId, psql)`（`_helpers/cleanup.ts`，按 L1-L7 顺序逐表删/NULL 化）。

---

### 链路 2：服务单生命周期 → 完成（提成结算依赖分配，本链路不验）

**spec**：`link-2-service-lifecycle.spec.ts`
**角色**：FY-TEST-MGR
**涉及页面**：`/services` → `/services/[serviceOrderId]`
**关键约束**：`completeServiceOrder` 是原子操作（写 completed_at + session_used 扣减 + 幂等）。服务可以在未分配 sale_allocations 的 sale_item 上正常完成；提成行依赖分配，不依赖完成服务。

#### 前置
读 `.last-test-context.json` 拿到链路 1 的 `saleOrderId`。
fixture 顾客绑定店为 store-nc01 且至少一个 sale_item 是护理项目类（`is_card_kind=false`）。

#### 步骤
1. 进 `/services`，点"新建服务单"
2. 选 fixture 顾客 → 选链路 1 订单产生的可消费项 → 选 fixture 美容师（FY-TEST-MGR 自己也行）→ 提交，状态徽章 **"待服务"**
3. 把 URL 上的 `serviceOrderId` 写入 `.last-test-context.json` 的 `link2`
4. 进服务单详情，点 **"开始服务"**，状态 **"服务中"**，DB `started_at` 写入
5. 点 **"完成服务"**，状态 **"已完成"**，DB `completed_at` 写入；`service_items.session_used` +1
6. 二次点击 "完成服务" 按钮（应已置灰）——通过 URL 直接 POST 验证幂等：状态不变，session_used 不再增加

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 状态徽章按 `待服务 → 服务中 → 已完成` 顺序流转；"完成"后按钮置灰 |
| DB | `SELECT status FROM service_orders WHERE service_order_id=:soid` = `已完成` |
| DB | `started_at` < `completed_at`，二者均非空 |
| DB | `SELECT sum(session_used) FROM service_items WHERE service_order_id=:soid` 等于本单 service_item 数（每项 1 次） |
| DB | `service_commissions` 行数 == `sale_allocations` 行数（提成由分配显式产生；本链路未走分配步骤时为 0，是预期） |
| DB（幂等）| 二次完成后 `commission_status` 不重复，`session_used` 不再加 |

#### DB 验证
```bash
SOID=$(jq -r '.link2.serviceOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
  SELECT 'order' AS k, status::text, started_at::text, completed_at::text, commission_status::text
    FROM service_orders WHERE service_order_id='$SOID'
  UNION ALL SELECT 'items_session_sum', sum(session_used)::text, NULL, NULL, NULL
    FROM service_items WHERE service_order_id='$SOID'
  UNION ALL SELECT 'commissions_rows', count(*)::text, NULL, NULL, NULL
    FROM service_commissions WHERE service_item_id IN
    (SELECT service_item_id FROM service_items WHERE service_order_id='$SOID');"
```

#### 清理
```sql
DELETE FROM service_commissions
  WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id=:soid);
DELETE FROM service_items WHERE service_order_id=:soid;
DELETE FROM service_orders WHERE service_order_id=:soid;
DELETE FROM operation_logs WHERE target_id=:soid;
```

---

### 链路 3：预约 → 确认 → 签到 → 转服务单

**spec**：`link-3-appointment-flow.spec.ts`
**角色**：FY-TEST-MGR
**涉及页面**：`/appointments` → `/services`
**关键约束**：只有 `已确认` 状态能签到（`appointment_status` 枚举：`待确认/已确认/已完成/已取消/已关闭`）

#### 前置
- fixture 顾客已建档
- admin 后台**没有**新建预约入口（业务上预约由客户端小程序产生），所以测试前需要手动 INSERT 一条预约：
```sql
INSERT INTO appointments (appointment_id, status, store_id, client_user_id, client_name, employee_id, employee_name, appointment_time)
VALUES ('TEST-APT-001', '待确认', 'store-nc01', :client_user_id, :client_name, 'FY-TEST-MGR', '测试店长', NOW() + INTERVAL '1 day');
```

#### 步骤
1. 进 `/appointments?status=待确认`
2. 找到 `TEST-APT-001`，点 **"确认"**，UI 该行从"待确认"Tab 消失，出现在"已确认"Tab
3. DB 应有 `confirmed_at IS NOT NULL`、`status='已确认'`
4. 在"已确认"Tab 找到该条，点 **"签到"**
5. DB `checkin_at` 写入；status 不一定立即变（具体看 admin 实现，可能仍为 `已确认` 直到对应服务单完成才转 `已完成`）
6. （手动）在 `/services/create` 新建服务单时选关联预约 `TEST-APT-001`，提交后 `service_orders.appointment_id='TEST-APT-001'`

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 状态 Tab 流转：待确认 → 已确认；"签到"按钮仅在已确认 Tab 出现 |
| DB | `confirmed_at`、`checkin_at` 均不为 NULL |
| DB | `service_orders.appointment_id='TEST-APT-001'` 关联成功 |
| 反例 | 待确认 Tab 中没有"签到"按钮；通过 URL 直接 POST 签到接口应被拒（admin server action 校验状态）|

#### 清理
```sql
UPDATE service_orders SET appointment_id=NULL WHERE appointment_id='TEST-APT-001';
DELETE FROM appointments WHERE appointment_id='TEST-APT-001';
DELETE FROM operation_logs WHERE target_id='TEST-APT-001';
```

---

### 链路 4：退款申请 → 审批 → 多表对冲

**spec**：`link-4-refund-approval.spec.ts`
**角色**：FY-TEST-FIN（创建）+ FY-TEST-ADM（审批）
**涉及页面**：`/orders/[id]`（创建）→ `/refunds/[paymentId]`（审批）
**关键事实**（2026-05-03 重构后）：退款数据完全在 `sale_order_payments` 表，**不再**新建 `sale_orders[type='退款单']` 实体：
- 在原销售单详情页点"创建退款" → Dialog 选要退的明细 → 写入一行 `sale_order_payments`（`change_type='退款'`、`amount<0`、`status='待审批'`）
- 审批通过：`sale_order_payments.status` → `已支付`，`audit_employee_id` + `audit_at` 写入
- 同一原单**不可重复**未审批退款（admin 校验 + DB 部分唯一索引）

#### 前置
读 `.last-test-context.json` 拿链路 1 的 `saleOrderId`（已支付 + 已分配的销售单）。
理想：该顾客刚通过链路 1 升了会员等级（验证回退逻辑）。

#### 步骤
1. FY-TEST-FIN 登录，进 `/orders/<链路1 saleOrderId>`
2. 点"创建退款"按钮，Dialog 选要退的 sale_item，填退款金额 / 理由
3. 提交后该订单详情页应出现一行 `change_type=退款` `status=待审批`
4. 把 `sale_order_payments.id` 写入 `.last-test-context.json` 的 `link4.refundPaymentId`
5. 退出，FY-TEST-ADM 登录，进 `/refunds/<refundPaymentId>`
6. 点 **"审批通过"** → AlertDialog 确认 → `sale_order_payments.status` 翻 `已支付`
7. （反例）回 FY-TEST-FIN 再开一个相同明细的退款 → 应被 admin 校验拦截

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 退款行徽章：`待审批 → 已支付`（通过）/ `已关闭` + `rejected_reason`（驳回）|
| UI | 原销售单详情页支付历史出现退款行 |
| DB | `sale_order_payments`：status=`已支付` change_type=`退款` amount<0 audit_employee_id=`FY-TEST-ADM` |
| DB | 顾客积分被扣减（详见下方 SQL） |
| DB | （如适用）`client_wechat_users.member_level` 由 `已支付前的等级` → `回退等级`，`old_member_level` 写入 |
| DB | 储值卡退款方式：`card_transactions` 应有正向回冲行（type='充值'） |
| DB | `operation_logs` 至少 2 条（target_id 包含 sop.id + 原 saleOrderId，action 含 create + approve）|

#### DB 验证
```bash
RPID=$(jq -r '.link4.refundPaymentId' scripts/manual-e2e/.last-test-context.json)
SOID=$(jq -r '.link1.saleOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
  SELECT 'refund_payment' AS k, status::text, change_type::text, amount::text, audit_employee_id
    FROM sale_order_payments WHERE id=$RPID
  UNION ALL SELECT 'origin_order', status::text, sale_order_type::text, NULL, NULL
    FROM sale_orders WHERE sale_order_id='$SOID'
  UNION ALL SELECT 'point_txn_after', sum(amount)::text, NULL, NULL, NULL
    FROM point_transactions WHERE ref_payment_id=$RPID
  UNION ALL SELECT 'logs', count(*)::text, NULL, NULL, NULL
    FROM operation_logs WHERE target_id::text IN ('$SOID', '$RPID'::text);"
```

#### 清理
```sql
DELETE FROM point_transactions WHERE ref_payment_id=:refundPaymentId;
DELETE FROM card_transactions  WHERE ref_payment_id=:refundPaymentId;
DELETE FROM operation_logs WHERE target_id::text=:refundPaymentId::text;
DELETE FROM sale_order_payments WHERE id=:refundPaymentId;
-- 顾客 member_level 还原需手工，依据 old_member_level 字段：
UPDATE client_wechat_users SET member_level=old_member_level, old_member_level=NULL,
       member_level_upgraded_at=NULL WHERE user_id=:clientUserId AND old_member_level IS NOT NULL;
```

---

### 链路 5：员工入职 → 角色分配 → 调店 scope 同步

**spec**：`link-5-employee-relocate.spec.ts`
**角色**：FY-TEST-ADM / FY-TEST-HR
**涉及页面**：`/employees` → `/permissions` → `/employees/[id]/edit`
**关键约束**：`updateEmployee` 改 storeId 时**自动同步** `permission_roles.scope_id`（admin 项目 server action 行为）

#### 前置
两家门店（已存在生产数据中）：
- 门店 A：`store_id='store-nc01'`，`org_node_id='org-store-nc01'`（南昌旗舰店）
- 门店 B：找另一家南昌市场下的门店，例如 `store_id='store-nc02'` `org_node_id='org-store-nc02'`（青山湖店）

employee_id 用 `FY-TEST-MOVE`（专用迁移测试账号，与 FY-TEST-* 系列分开避免污染）

#### 步骤
1. FY-TEST-HR 登录，进 `/employees/create`
2. 创建员工 `FY-TEST-MOVE`（姓名"调店测试员"，phone='13900139007'，挂门店 A `store-nc01`）
3. 进 `/permissions`，给 FY-TEST-MOVE 分配 `manager` 角色，scope = 门店 A `org-store-nc01`
4. **关键步骤**：回 `/employees/FY-TEST-MOVE/edit`，把 store 改为门店 B `store-nc02` 保存
5. 验证 `/permissions` 上 FY-TEST-MOVE 那一行的 scope 自动变 `org-store-nc02`
6. 给 FY-TEST-MOVE 设密码（无 admin UI 入口，需手工 INSERT admin_passwords），用新会话登录该账号，`/orders` 列表应只见门店 B 数据

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 调店保存后 `/permissions` scope 列从 `org-store-nc01` 自动变 `org-store-nc02`（页面刷新后立即可见） |
| DB | `SELECT store_id, org_node_id FROM staff_wechat_users WHERE employee_id='FY-TEST-MOVE'` = `store-nc02` / `org-store-nc02` |
| DB | `SELECT scope_id FROM permission_roles WHERE employee_id='FY-TEST-MOVE' AND role='manager'` = `org-store-nc02` |
| DB | `SELECT count(*) FROM operation_logs WHERE target_id='FY-TEST-MOVE'` ≥ 2（create + update_store）|
| 行为 | FY-TEST-MOVE 登录后，`/orders` 仅出现 store_id='store-nc02' 的订单（验证 scope 隔离生效） |

#### 清理（注意 FK 顺序：permission_roles → admin_passwords → staff_wechat_users）
```sql
DELETE FROM operation_logs WHERE target_id='FY-TEST-MOVE';
DELETE FROM permission_roles WHERE employee_id='FY-TEST-MOVE';
DELETE FROM admin_passwords WHERE employee_id='FY-TEST-MOVE';
DELETE FROM staff_wechat_users WHERE employee_id='FY-TEST-MOVE';
```

---

### 链路 6：会员升级权益（cron 触发）

**spec**：`link-6-member-upgrade.spec.ts`
**角色**：FY-TEST-ADM（手动触发 cron）
**涉及页面**：`/customers/[user_id]` → `/settings`（看权益规则）→ 客户端小程序"消息"页（可选）
**关键约束**：cron `0 3 * * *` Asia/Shanghai 自动跑，本地用 `bun run cron:once` 手动触发；STEP 2 = `refresh-customer-status` 后续的 `refresh-member-levels`

> **修正说明**：`member_level_thresholds` 这个 config key 在代码里**从未存在**，4 个高等级阈值
> （黑钻 ≥100000 / 金钻 ≥60000 / 粉钻 ≥30000 / 星钻 ≥10000）**硬编码**在
> `fengyu-admin/src/cron/lib/member-level.ts:25-32`，不走 DB。
> 仅初钻阈值（`new_member_threshold`，默认 1980）走 `system_configs` 配置，5433 已就绪。

#### 前置
- 1 个顾客年度消费额接近升级阈值（差几百元，可在 `client_wechat_users` 找已绑店且 member_level 不是顶级"黑钻"的）
- `system_configs.key='member_level_benefits'`（5 等级权益配置，5433 已就绪）
- `system_configs.key='new_member_threshold'`（初钻阈值，默认 1980，5433 已就绪）
- **不要写 `member_level_thresholds`**：4 个高等级阈值是硬编码常量（`src/cron/lib/member-level.ts:25-32`），非 DB 配置
- 注意：`system_configs` 主键列名是 `key`（不是 `config_key`），过去文档误写为 `config_key`，以 `\d system_configs` 为准

#### 步骤
1. `/customers/{user_id}` 查看当前 `member_level`（例如"星钻"）+ 当前年度消费额
2. 用链路 1 给该顾客开一单跨过升级阈值的金额（`status='已支付'` 计入消费）
3. 终端跑：
   ```bash
   cd fengyu-admin && bun run cron:once
   ```
   观察日志含 `STEP 2 refresh-member-levels: <user_id> upgraded ...`
4. 重看 `/customers/{user_id}`，`member_level` 应升级，`old_member_level` 写入旧值，`member_level_upgraded_at` 时间戳更新
5. （客户端验证可选）该顾客小程序"消息"应见升级通知；优惠券新券；积分流水有奖励积分

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | `SELECT member_level, old_member_level, member_level_upgraded_at FROM client_wechat_users WHERE user_id=:uid`：等级升级 + old 写入 + 时间戳更新 |
| DB | `point_transactions` 新增行：`user_id=:uid, type='获取', amount > 0, external_ref` 形如 `member-upgrade-${uid}-${toLevel}`（最新实现见 `src/cron/steps/refresh-member-levels.ts`） |
| DB | `user_coupons` 新增行：`user_id=:uid, template_id` 对应该等级权益券，`status='未使用'` |
| DB | `messages` 表新增 `recipient_id=:uid AND recipient_type='客户'` 升级通知 |
| 幂等 | 同日重跑 `cron:once`：`uq_point_txns_external_ref` 唯一键拦截 → 0 新增；同 user 同等级 user_coupons 不重复 |

#### 清理
```sql
DELETE FROM point_transactions WHERE user_id=:uid AND external_ref LIKE 'member-upgrade-%';
DELETE FROM user_coupons WHERE user_id=:uid AND created_at > NOW() - INTERVAL '1 hour';
DELETE FROM messages WHERE recipient_id=:uid AND recipient_type='客户' AND created_at > NOW() - INTERVAL '1 hour';
UPDATE client_wechat_users
  SET member_level=old_member_level, old_member_level=NULL, member_level_upgraded_at=NULL
  WHERE user_id=:uid AND old_member_level IS NOT NULL;
```

---

### 链路 7：订单金额三方对账（创建-支付-清算闭环）

**spec**：`link-7-order-amount-check.spec.ts`
**主题**：单笔订单的金额方程恒成立。
**角色**：FY-TEST-MGR
**关键不变量**：
```
sale_orders.total_amount  ==  SUM(sale_items.sale_amount) - coupon_discount
sale_orders.total_amount  ==  paid_amount + payable_amount + prepaid_card_amount
sale_items.sale_amount    ==  unit_real_price * quantity      （CHECK 自验）
```

#### 步骤
1. 用链路 1 开一单：2 件商品（普通项目 ¥300×1，护理项目 ¥500×2）+ 一张面值 ¥100 的优惠券
2. 储值卡先抵 ¥100，剩余 ¥1100 - ¥100 - ¥100 = ¥900 走线下
3. 收银确认后核对金额方程

#### 检查点（一条 SQL 全验完）
```bash
SOID=$(jq -r '.link7.saleOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
WITH o AS (SELECT * FROM sale_orders WHERE sale_order_id='$SOID'),
     i AS (SELECT sum(sale_amount) AS s_items, sum(unit_real_price*quantity) AS s_calc
           FROM sale_items WHERE sale_order_id='$SOID')
SELECT
  o.total_amount, i.s_items, o.coupon_discount,
  (i.s_items - o.coupon_discount) AS calc_total,
  o.paid_amount + o.payable_amount + o.prepaid_card_amount AS sum_paid_kinds,
  CASE WHEN o.total_amount = (i.s_items - COALESCE(o.coupon_discount,0))
       AND o.total_amount = (o.paid_amount + o.payable_amount + o.prepaid_card_amount)
       AND i.s_items = i.s_calc THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM o, i;"
```

期望 `verdict='PASS'`。任一项 FAIL → 数据不一致 → bug 报告。

#### 反例（应被拦截）
- 在 `/orders/[id]/edit`（如果有）改 `unit_real_price` 但不重算 sale_amount → admin server action 应阻止
- 通过 SQL 直接 UPDATE total_amount 制造不一致 → admin UI 列表/详情应能侦测（手动构造此场景验证 admin 是否做了 sanity check）

#### 清理
调用 `cleanupSaleOrder(saleOrderId, psql)`。

---

### 链路 8：多次回款累加一致性

**spec**：`link-8-installment-payment.spec.ts`
**主题**：欠款单的"已收 = SUM(回款流水)"且不超过订单总额。
**角色**：FY-TEST-ADM（操作回款）
**关键不变量**：
```
sale_orders.paid_amount  ==  SUM(sale_order_payments.amount WHERE change_type IN '首次支付','回款','储值卡抵扣')
                            - SUM(sale_order_payments.amount WHERE change_type='退款')
sale_orders.payable_amount  ==  total_amount - prepaid_card_amount - paid_amount
```
（`sale_order_payments.amount` 在退款时为负，CHECK 约束自验）

#### 前置
链路 1 一单部分支付（payable_amount > 0）。

#### 步骤
1. `/orders/[id]` 详情页点 "录入回款"
2. 填本次回款额（< payable_amount）+ 支付方式（线下/储值卡）+ 备注，提交
3. 重复 2-3 次，每次回款额渐少，直到 payable_amount=0
4. 第一次回款后状态徽章应仍是 `部分支付`，最后一次后转 `已支付`

#### 检查点
```bash
SOID=$(jq -r '.link1.saleOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
WITH o AS (SELECT * FROM sale_orders WHERE sale_order_id='$SOID'),
     p AS (SELECT
             sum(CASE WHEN change_type IN ('首次支付','回款','储值卡抵扣') THEN amount ELSE 0 END) AS positive,
             sum(CASE WHEN change_type = '退款' THEN -amount ELSE 0 END) AS negative,
             count(*) AS rows
           FROM sale_order_payments WHERE sale_order_id='$SOID')
SELECT
  o.status::text, o.total_amount, o.paid_amount, o.payable_amount, o.prepaid_card_amount,
  p.positive, p.negative, p.rows AS payments_rows,
  CASE WHEN o.paid_amount = (p.positive - p.negative)
       AND o.payable_amount = o.total_amount - o.prepaid_card_amount - o.paid_amount
       THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM o, p;"
```

#### 反例
- 录入回款额 > payable_amount → 应被表单校验或 server action 拦截
- 同一线上交易 ID 二次提交（external_txn_id 重复）→ 唯一索引 `uq_sop_txn` 拦截

#### 清理
```sql
DELETE FROM sale_order_payments WHERE sale_order_id=:soid AND created_at > :test_start;
UPDATE sale_orders SET paid_amount=:original, payable_amount=:original, status=:original WHERE sale_order_id=:soid;
```

---

### 链路 9：营业额分配比例 + 实际分配额对账

**spec**：`link-9-allocation-ratio-check.spec.ts`
**主题**：分配比例之和=100%，且每行 ratio×total 求和=订单营业额。
**角色**：FY-TEST-MGR
**关键不变量**（按 sale_item 维度）：
```
SUM(sale_allocations.allocation_ratio WHERE sale_item_id=X AND is_void=false)  ==  100.00
SUM(sale_allocations.allocation_ratio * sale_allocations.total_amount / 100)
  ≈  sale_items.sale_amount    （考虑 0.01 进位误差）
```

#### 步骤
跟链路 1 第 7 步：每个 sale_item 录入若干分配人 + 比例。
- 故意试错：让某个 item 比例总和=99% 或 101% → admin 应拒绝保存
- 故意试错：选 is_resigned=true 的员工 → admin 应警告或拒绝

#### 检查点
```bash
SOID=$(jq -r '.link1.saleOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
WITH per_item AS (
  SELECT si.sale_item_id, si.sale_amount,
         sum(sa.allocation_ratio) FILTER (WHERE sa.is_void=false) AS ratio_sum,
         sum(sa.allocation_ratio * sa.total_amount / 100.0) FILTER (WHERE sa.is_void=false) AS amt_sum
  FROM sale_items si
  LEFT JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id
  WHERE si.sale_order_id='$SOID'
  GROUP BY si.sale_item_id, si.sale_amount
)
SELECT sale_item_id, sale_amount, ratio_sum, amt_sum,
  CASE WHEN ratio_sum=100.00 AND ABS(amt_sum - sale_amount) < 0.05 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM per_item;"
```

#### 清理
同链路 1。

---

### 链路 10：储值卡余额 ≡ 流水累加（防丢钱）

**spec**：`link-10-card-balance-check.spec.ts`
**主题**：储值卡账面余额必须永远等于流水净额。
**角色**：FY-TEST-MGR
**关键不变量**：
```
prepaid_cards.balance  ==  SUM(card_transactions.amount * sign(type))
其中 sign('充值')=+1, sign('扣款')=-1
（card_transaction_type 实际只有 2 值：充值 / 扣款。退款回冲 = 一行 type='充值' + ref_order_id 是退款单）
```
枚举值需以 `card_transaction_type` 为准（CC 跑前先 `SELECT enum_range(NULL::card_transaction_type)`）。

#### 步骤
1. 选 fixture 顾客的储值卡（`SELECT card_id, balance FROM prepaid_cards WHERE user_id=:uid`）
2. 用链路 1 开一单"充值卡"型 SKU（充值 ¥500），收银 → balance 应 +500
3. 用同顾客开一单普通项目 ¥200，收银时勾选"储值卡支付" → balance 应 -200
4. 链路 4 退掉第二单（金额 ¥200，方式=储值卡） → balance 应 +200

#### 检查点（每步后跑）
```bash
CARD_ID="<card_id>"
eval $PSQL_TEST -c "
SELECT
  pc.balance AS book_balance,
  COALESCE(sum(ct.amount * CASE
    WHEN ct.type::text = '充值' THEN 1
    WHEN ct.type::text = '扣款' THEN -1
    ELSE 0 END), 0) AS calc_balance
FROM prepaid_cards pc
LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
WHERE pc.card_id='$CARD_ID'
GROUP BY pc.balance;"
```

期望 `book_balance == calc_balance`。如有差异，要么是漏写流水（admin bug）要么是手动改了 balance（数据污染）。

#### 反例
- 储值卡支付金额 > balance → admin 应拒绝（CHECK 或 server action）
- 直接 SQL 改 balance 不写流水 → 本测试就是检测此类污染

#### 清理
按测试中产生的订单走链路 1/4 的清理；卡 balance 由清理流水后重算确保一致。

---

### 链路 11：优惠券使用一致性

**spec**：`link-11-coupon-consistency.spec.ts`
**主题**：券一旦在订单上使用，状态机不可逆。
**角色**：FY-TEST-MGR
**关键不变量**：
```
user_coupons.status='已使用'  ↔  user_coupons.used_sale_order_id IS NOT NULL  ↔  used_at IS NOT NULL
sale_orders.coupon_id  ==  user_coupons.coupon_id  且 user_coupons.user_id == sale_orders.client_user_id
sale_orders.coupon_discount  <=  COALESCE(user_coupons.face_value_override, coupon_templates.discount_value)
（coupon_templates 实际字段是 `discount_value` 不是 face_value；type=`满减`时还需校验 min_spend）
```

#### 前置
fixture 顾客有 1 张状态='未使用'、未过期的 user_coupon。

#### 步骤
1. 链路 1 开单时勾选该 user_coupon
2. 提交订单后立即查 user_coupons 状态
3. 反例：在 step 1 前并发开两单都用同一张券 → 第二单应失败
4. 反例：链路 4 退款这单 → 券是否回滚为"未使用"？业务上一般**不回滚**（已在 link-11 spec 中确认为预期行为）

#### 检查点
```bash
COUPON_ID="<coupon_id>"
SOID=$(jq -r '.link1.saleOrderId' scripts/manual-e2e/.last-test-context.json)
eval $PSQL_TEST -c "
SELECT
  uc.status::text, uc.used_sale_order_id, uc.used_at,
  o.coupon_id, o.coupon_discount, o.client_user_id,
  ct.discount_value, ct.coupon_type::text,
  CASE WHEN uc.status='已使用' AND uc.used_sale_order_id='$SOID'
        AND uc.used_at IS NOT NULL
        AND o.coupon_id=uc.coupon_id
        AND o.client_user_id=uc.user_id
        AND o.coupon_discount <= COALESCE(uc.face_value_override, ct.discount_value)
       THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM user_coupons uc
JOIN coupon_templates ct ON ct.template_id = uc.template_id
LEFT JOIN sale_orders o ON o.sale_order_id='$SOID'
WHERE uc.coupon_id='$COUPON_ID';"
```

#### 清理
```sql
UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL WHERE coupon_id=:coupon_id;
-- 同时清掉链路 1 的订单
```

---

### 链路 12：服务次数对账（购买 - 已用 = 剩余）

**spec**：`link-12-session-count-check.spec.ts`
**主题**：包卡 / 多次卡的次数会计恒成立。
**角色**：FY-TEST-MGR
**关键不变量**（按 sale_item 维度）：
```
sale_items.session_count
  ==  sale_items.remaining_sessions  +  SUM(service_items.session_used WHERE sale_item_id=X)
```

#### 前置
找 / 开一单 session_count > 1 的可消费项（充值卡 / 多次护理）。

#### 步骤
1. 用链路 2 走完一次服务（消耗 1 次） → `service_items.session_used` 写 1
2. `sale_items.remaining_sessions` 减 1
3. 重复 N 次直到 remaining_sessions=0
4. 反例：剩 0 次后再开服务单 → admin server action 应拒绝

#### 检查点
```bash
SIID="<sale_item_id>"
eval $PSQL_TEST -c "
SELECT
  si.session_count, si.remaining_sessions,
  COALESCE(sum(svi.session_used), 0) AS total_used,
  CASE WHEN si.session_count = si.remaining_sessions + COALESCE(sum(svi.session_used), 0)
       THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM sale_items si
LEFT JOIN service_items svi ON svi.sale_item_id = si.sale_item_id
WHERE si.sale_item_id='$SIID'
GROUP BY si.session_count, si.remaining_sessions;"
```

#### 清理
撤销链路 2 的服务单 + 还原 remaining_sessions。

---

## 1.B 业务扩展链路（13-23，已实现 spec）

> 以下 11 条 spec 已实现并落地到 `link-N-*.spec.ts`（2026-05-17）。覆盖**积分体系、商品/提成主数据、跨角色聚合、并发与权限收回、批量发券、实物出库、cron 边界、状态回退**等场景。每条 spec 在与 README 设计存在差异时按真实实现写、文件内顶部注释 `// NOTE:` 标差异（避免下次维护误信文档而忽略代码）。
>
> 11 条 spec 与 README 描述的**主要差异摘要**（详见各 spec 头部 NOTE）：
> - 链路 13 — `point_transactions.type` 是自由文本（已知值：等级升级奖励/消费赠送/消费冲销/生日积分），不是 README 写的枚举；admin 无积分手工操作 action；无 `system_configs.points_earn_rate` 配置
> - 链路 14 — 快照字段是 `sale_items.unit_price`，不是 README 写的 `unit_real_price`（后者是分账后单价）
> - 链路 15 — `sale_allocations` 无 `commission_rate` 列；真正的快照在 `service_commissions.commission_rate`（服务单完成时写入）
> - 链路 16 — `sale_orders` 无 `consultant_employee_id`，相关字段是 `preferred_employee_id` + `opened_by`；promoter 不被复制到订单 → 历史订单天然零回溯
> - 链路 17 — `/dashboard` 无 `?storeFilter` URL 入参，scope 全靠 session 注入
> - 链路 18 — `operation_logs.source='adminApi'`（不是 'admin'）；`detail` 字段（非 'payload'）；结构 `{ _v:2, _t:'update', changes:{field:{from,to}} }`
> - 链路 19 — `revokeRole(id)` 按主键 id 删除，不是 employee_id+role 组合
> - 链路 20 — `coupon_templates` 无 `granted_count` 列；用 `COUNT(*) FROM user_coupons` 对账；action 名是 `batchIssueCoupons(templateId, phones)`
> - 链路 21 — `sale_items.picked_up_quantity`（累加字段），`pickup_records.pickup_quantity`（行级字段）；README 写的 `remaining_pickup` 不存在
> - 链路 22 — 无 `birthday_grant_log` 表；幂等键三件套：`birthday-pts-{YYYY}-{userId}` / `birthday-msg-{YYYY}-{userId}` / `bday-{YYYY}-{userId}-{tplId}`
> - 链路 23 — `service_orders` 无 `cancelled_at` 列；仅 `status='已取消'` 标记；`cancelServiceOrder` 不主动 void `service_commissions`

### 链路 13：积分体系闭环（余额对账）

**spec**：`link-13-points-balance-check.spec.ts`
**主题**：积分作为虚拟资产，与订单双向联动；余额必须永远等于流水净额。
**角色**：FY-TEST-MGR（开单）+ FY-TEST-ADM（cron 触发审计）
**涉及页面**：`/orders/create` → `/orders/[id]`
**关键不变量**：
```
client_wechat_users.points_balance
  ==  SUM(point_transactions.amount WHERE type IN ('获取','调整')) - SUM(amount WHERE type IN ('消费','过期','退款扣回'))
sale_orders.points_used  <=  COALESCE(client_wechat_users.points_balance AT 下单时, 0)
退款 → point_transactions 应自动写一行 type='退款扣回' amount<0 ref_payment_id 关联退款 sop
```

#### 前置
- fixture 顾客 `FY-FIX-CLIENT-01` 当前 points_balance（先查一次记基线）
- `system_configs.key='points_earn_rate'`（如：每 ¥1 = 1 积分）已在 5433 配置
- cron STEP 5（`audit-points-balance`）已就绪

#### 步骤
1. 开一单 ¥500 走线下支付，确认收款 → 顾客积分应 +500（按 rate=1.0）
2. 同顾客再开 ¥300 单，选"使用 200 积分抵扣" → 实付 ¥298（按 1 积分=1 分）+ points_balance -200
3. FY-TEST-FIN 退掉第一单 → points_balance 应 -500 + 退款金额对应的 `退款扣回` 行
4. 跑 `cron:once` → STEP 5 `audit-points-balance` 应输出 "all balanced"（无告警）

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | `points_balance = SUM(earn) - SUM(spend)` 等式始终成立 |
| DB | `point_transactions.ref_payment_id` 退款行非空，可回溯到对应 sop |
| DB | `point_transactions.external_ref` 唯一（同订单不重复发分） |
| 反例 | 抵扣超过当前 balance → admin 应拒绝 |
| 反例 | 同订单二次确认收款 → 不再加积分 |
| cron | STEP 5 输出 `balanced=N skipped=0 mismatch=0` |

#### DB 验证
```bash
UID="FY-FIX-CLIENT-01"
eval $PSQL_TEST -c "
WITH t AS (
  SELECT user_id,
    SUM(amount) FILTER (WHERE type IN ('获取','调整')) AS gain,
    SUM(amount) FILTER (WHERE type IN ('消费','过期','退款扣回')) AS spend
  FROM point_transactions WHERE user_id='$UID' GROUP BY user_id
)
SELECT u.points_balance, t.gain, t.spend, (t.gain - t.spend) AS calc,
  CASE WHEN u.points_balance = (t.gain - t.spend) THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM client_wechat_users u JOIN t ON t.user_id=u.user_id WHERE u.user_id='$UID';"
```

#### 清理
通过链路 1 / 4 清理订单 + 退款；不要手工删 `point_transactions`，让流水保持完整链路。

---

### 链路 14：SKU 价格变更不影响历史订单（snapshot 保护）

**spec**：`link-14-sku-price-snapshot.spec.ts`
**主题**：商品价格修改后，历史 `sale_items.unit_price`（真实快照字段）必须保持下单时的快照；新单按新价。
**角色**：FY-TEST-PRD（改价）+ FY-TEST-MGR（验证开单）
**涉及页面**：`/products/[id]/edit` → `/orders/create`
**关键不变量**：
```
sale_items.unit_real_price  ==  product_skus.price AT (sale_orders.created_at)
改价后 product_skus.price 变化，但已有 sale_items.unit_real_price 永不被回溯更新
```

#### 前置
- 链路 1 已建一单（含 fixture SKU），记其 `unit_real_price`（如 ¥100）

#### 步骤
1. FY-TEST-PRD 登录 `/products`，编辑 fixture SKU `c79157b29c9e974c`，price ¥100 → ¥120 保存
2. 查链路 1 订单详情：`sale_items.unit_real_price` 仍为 ¥100（不变）
3. FY-TEST-MGR 新开一单同 SKU → 新 sale_items.unit_real_price=¥120
4. 反例：直接 SQL `UPDATE sale_items SET unit_real_price=120` → admin 应在订单详情侦测不一致并提示（依赖 admin sanity check 实现）

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | 老订单 unit_real_price 不变；新订单按新价 |
| DB | product_skus.updated_at 已更新 |
| DB | operation_logs 含 `product.update` 行，old_price/new_price 在 payload 中 |
| UI | 老订单详情未显示"价格已变更"误报 |

#### 清理
```sql
UPDATE product_skus SET price=100, updated_at=NOW() WHERE sku_id='c79157b29c9e974c';
DELETE FROM operation_logs WHERE target_id='c79157b29c9e974c' AND created_at > :test_start;
```

---

### 链路 15：提成矩阵编辑即时生效 + 历史保留

**spec**：`link-15-commission-matrix-snapshot.spec.ts`
**主题**：`commission_rate_matrix` 修改对**新建分配**立即按新比例计算；已写入的 `service_commissions.commission_rate`（真实快照字段）不被回溯。
**角色**：FY-TEST-ADM（改矩阵）+ FY-TEST-MGR（开单分配）
**涉及页面**：`/commission` → `/allocations`
**关键不变量**：
```
sale_allocations.commission_rate  ==  commission_rate_matrix.rate AT (allocation.created_at)
新分配的 commission_rate 应反映最新矩阵；老分配的 commission_rate 永不被回溯
```

#### 前置
- 选某条已存在矩阵：`market_name='南昌市场' AND category='护理项目' AND role='主咨询'`，原 rate=0.05

#### 步骤
1. 走链路 1 开单 + 分配，记当前 sale_allocations.commission_rate=0.05
2. FY-TEST-ADM 进 `/commission`，把上述矩阵行 rate 改为 0.10 保存
3. FY-TEST-MGR 再走链路 1 + 分配 → 新 allocation.commission_rate=0.10
4. 老 allocation.commission_rate 仍为 0.05（未被回溯）
5. 反例：FY-TEST-MGR 直接修改矩阵 → 应被权限拦截（admin 角色才行）

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | 老分配 commission_rate=0.05；新分配 commission_rate=0.10 |
| DB | commission_rate_matrix.updated_at 已更新 |
| DB | operation_logs 含 `commission.update` 行 |
| 反例 | 非 admin 角色 PATCH /commission → 403 |

#### 清理
```sql
UPDATE commission_rate_matrix SET rate=0.05, updated_at=NOW() WHERE id=:matrix_id;
-- 走链路 1 清理脚本删两单
```

---

### 链路 16：顾客重分配 / 顾问转移

**spec**：`link-16-customer-promoter-snapshot.spec.ts`
**主题**：顾客的 `promoter_employee_id` / `bound_store_id` 变更后，历史预约/服务单/订单**保持不变**（实际 sale_orders 表无 consultant 列，promoter 不被复制 → 天然零回溯）。
**角色**：FY-TEST-CSM（修改顾客归属）+ FY-TEST-MGR（开新单验证）
**涉及页面**：`/customers/[uid]/edit` → `/orders/create`
**关键不变量**：
```
sale_orders.client_user_id      不变（顾客身份）
sale_orders.consultant_employee_id  保持下单时的快照
service_orders.employee_id           保持开服务单时的快照
client_wechat_users.promoter_employee_id  可被重新分配，仅影响后续单
```

#### 前置
- fixture 顾客 promoter=A 员工，已有链路 1 历史订单（consultant_employee_id=A）
- 准备员工 B（同店、未离职）

#### 步骤
1. FY-TEST-CSM 进 `/customers/{uid}/edit`，把 promoter_employee_id 从 A 改为 B 保存
2. 查 client_wechat_users.promoter_employee_id=B
3. 查链路 1 历史订单：sale_orders.consultant_employee_id 仍=A（不动）
4. FY-TEST-MGR 给该顾客开新单 → consultant_employee_id 默认 = B
5. 反例：把 promoter 改成 is_resigned=true 的员工 → 应被拒绝
6. 反例：把 promoter 改成跨店员工 → 视业务规则，可能允许或拒绝（参考 `.42cog/pm/admin.pr.spec.md` AC-15）

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | client_wechat_users.promoter_employee_id=B，updated_at 已更新 |
| DB | 历史 sale_orders/service_orders.employee_id 不变 |
| DB | 新订单 consultant_employee_id=B |
| DB | operation_logs 含 `customer.update_promoter` 行 |

#### 清理
```sql
UPDATE client_wechat_users SET promoter_employee_id=:old_employee_id, updated_at=NOW()
  WHERE user_id=:uid;
DELETE FROM operation_logs WHERE target_id=:uid AND action LIKE 'customer%';
```

---

### 链路 17：数据看板三角色聚合一致性

**spec**：`link-17-dashboard-three-role-aggregation.spec.ts`
**主题**：同一时段，admin / 市场 manager / 门店 manager 在 `/dashboard` 看到的"今日业绩"应满足**包含关系**（admin ≥ market ≥ store）。注：admin 角色 dashboard 渲染 admin/hr/product 类卡片，不一定有"今日业绩" → spec 该项可能 SKIP。
**角色**：3 个 storageState（admin / market / store）同时使用
**涉及页面**：`/dashboard?period=今天` 等
**关键不变量**：
```
admin.totalRevenue   ==  SUM(各市场 totalRevenue)
market.totalRevenue  ==  SUM(其下属门店 totalRevenue)
单店指标三角色完全相等：admin 选 store=X == market 选 store=X == store(只能看 X)
```

#### 前置
- 用链路 1 在 store-nc01 开 1 单 ¥500、已确认收款
- 时间维度选"今天"（避免 cron 滚动数据干扰）

#### 步骤
1. 用 3 个 browser context 分别以 admin / market / store storageState 打开 `/dashboard?period=今天`
2. 抓 3 个面板的 KPI 数值（totalRevenue / orderCount / serviceCount / activeCustomers）
3. 校验：admin 总数 ≥ market 总数 ≥ store 总数
4. 校验：admin 选 storeFilter=store-nc01 显示的数字 == market 看到 store-nc01 行 == store 看到的总数
5. 反例：store 角色 URL 强改 `?storeFilter=别的店` → admin 应忽略并仍按本店统计

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 三角色 KPI 数值满足包含关系 |
| UI | 单店指标三角色完全相等 |
| API | dashboard server action 入参 `scope` 自动按 session 注入 |
| 反例 | store 不能通过 URL 越权看别店 |

#### 清理
本链路不写库，无须清理。

---

### 链路 18：操作日志完整性 + 审计

**spec**：`link-18-operation-log-integrity.spec.ts`
**主题**：所有 admin 变更操作必产生 1 条 `operation_logs`，operator/target/source/detail 完整可追溯；同资源多次编辑产生多条日志（append-only，不被覆盖）。
**角色**：FY-TEST-ADM
**涉及页面**：`/logs` + 任意编辑页（如 `/customers/[uid]/edit`）
**关键不变量**：
```
每次编辑 → operation_logs +1 行
operator_employee_id  == session.employee_id（不可伪造）
target_id             == 被编辑资源的主键
source                ∈ ('admin','cronTask','clientApi','staffApi','sync')，admin 操作必须='admin'
payload (jsonb)       含 before/after diff
```

#### 步骤
1. 选 fixture 顾客，连续编辑 3 次"备注"字段（每次写不同内容）→ 应产生 3 条 `customer.update` 日志
2. 进 `/logs?target_id=:uid`，确认 3 条都列出，按时间倒序
3. 反例：用 FY-TEST-CSM 修改 fixture 顾客（应可），日志 operator_employee_id=`FY-TEST-CSM`
4. 反例：手工 SQL `INSERT INTO operation_logs (source) VALUES ('admin')` 后查 `/logs` → 列表显示（admin 不会拒绝展示，但作为反例提醒：日志不可篡改是靠 DB 权限，不是 admin 校验）

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | 3 次编辑产生 3 行日志，无 UPDATE 覆盖 |
| DB | operator_employee_id 与 session 严格一致 |
| DB | payload.before / payload.after 都非 NULL |
| UI | `/logs` 列表按 created_at desc，分页正常 |

#### 清理
```sql
DELETE FROM operation_logs WHERE target_id=:uid AND created_at > :test_start AND action='customer.update';
-- 还原顾客 notes 字段为初始值
UPDATE client_wechat_users SET notes=:original_notes WHERE user_id=:uid;
```

---

### 链路 19：角色降级 / 权限即时收回

**spec**：`link-19-permission-revoke-immediate.spec.ts`
**主题**：删除/降级 `permission_roles` 后，该 employee 已登录的 session 应立即失去对应权限（下一次 server action 调用被 requirePermission 拒）。
**角色**：FY-TEST-ADM（操作权限）+ FY-TEST-MGR（被降级方）
**涉及页面**：`/permissions` → 任意需要权限的页
**关键不变量**：
```
JWT cookie 持续有效（未过期 + 未刷 cookie），但 server action 校验时实时查 permission_roles
→ DELETE FROM permission_roles WHERE employee_id=X AND role=Y 后
   X 调用需要 Y 角色的 action 应被拒
```

#### 前置
- FY-TEST-MGR 已登录并打开 `/orders/create`

#### 步骤
1. FY-TEST-ADM 进 `/permissions`，删除 FY-TEST-MGR 的 `manager` 角色保存
2. 切回 FY-TEST-MGR 浏览器（cookie 仍在）
3. 在 `/orders/create` 提交订单 → 应收到 403 / 重定向到 /dashboard / Toast 报错
4. 进 `/dashboard` → 应正常显示（仍有基础角色）或被重定向到登录页（具体看实现）
5. 反例：FY-TEST-MGR 自己尝试 PATCH 自己的 permission_roles → 应被 admin 校验拒绝
6. 测完后重新分配 manager 角色给 FY-TEST-MGR

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | permission_roles 行已删除 |
| 行为 | 已开的页 cookie 仍在，但提交动作即刻 403 |
| DB | operation_logs 含 `permission.delete` 行 |
| 反例 | 自己改自己权限 → 拒绝 |

#### 清理
```sql
INSERT INTO permission_roles (employee_id, role, scope_id, created_at, updated_at)
VALUES ('FY-TEST-MGR', 'manager', 'org-store-nc01', NOW(), NOW())
ON CONFLICT (employee_id, role) DO NOTHING;
```

---

### 链路 20：优惠券模板批量发放

**spec**：`link-20-coupon-batch-issue.spec.ts`
**主题**：admin 通过模板批量给一批顾客发券；`user_coupons` 新增行数 == 输入手机号数（`coupon_templates` 无 granted_count 列，用 COUNT 聚合对账）。
**角色**：FY-TEST-PRD
**涉及页面**：`/coupons/[template_id]/grant`
**关键不变量**：
```
grant 操作前 user_coupons WHERE template_id=T 的行数 = N0
grant 操作后行数 = N0 + 被勾选顾客数
coupon_templates.granted_count += 同样数量
不会给已经持有该模板未过期券的顾客重复发放（视业务规则）
```

#### 前置
- fixture 优惠券模板 `FY-FIX-CT-01`（满 200 减 30）
- 准备 3 个顾客 user_id：fixture 顾客 + 另 2 个测试顾客（可临时插入）

#### 步骤
1. FY-TEST-PRD 进 `/coupons/FY-FIX-CT-01/grant`
2. 勾选 3 个顾客，提交
3. 查 user_coupons 应 +3 行（template_id=FY-FIX-CT-01）
4. 反例：fixture 顾客已有未使用券时，再次勾选发放 → 视业务规则可能新增或拒绝（参考 admin 实现）
5. 反例：勾选大于 1000 顾客 → 应分批处理或提示

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | user_coupons 行数 = N0 + 勾选数 |
| DB | coupon_templates.granted_count += 同样数量 |
| DB | operation_logs 含 `coupon.grant_batch` 行，payload.recipients 列出顾客 |
| UI | grant 完成 Toast 显示发放数量 |

#### 清理
```sql
DELETE FROM user_coupons WHERE template_id='FY-FIX-CT-01' AND created_at > :test_start AND user_id <> 'FY-FIX-CLIENT-01';
UPDATE coupon_templates SET granted_count = (
  SELECT count(*) FROM user_coupons WHERE template_id='FY-FIX-CT-01'
) WHERE template_id='FY-FIX-CT-01';
```

---

### 链路 21：取货流程（pickup_records）→ 实物商品出库

**spec**：`link-21-pickup-records.spec.ts`
**主题**：实物 SKU（`product_type='家居产品'`）下单后须经过取货流程，`sum(pickup_records.pickup_quantity) == sale_items.picked_up_quantity <= quantity`。
**角色**：FY-TEST-MGR
**涉及页面**：`/orders/[id]` → `/pickups`（如有独立页面）
**关键不变量**：
```
SUM(pickup_records.quantity WHERE sale_item_id=X)  <=  sale_items.quantity
sale_items.remaining_pickup  ==  quantity - SUM(pickup_records.quantity)
remaining_pickup=0 时不可再取
```

#### 前置
- fixture 中需新增一个 product_kind='家居产品' 的 SKU（如有，否则需临时插入），quantity=3 单数 ¥80

#### 步骤
1. 走链路 1 开一单"家居产品 x3"已支付
2. 进 /orders/[id] 详情，点"取货"，本次取 1 件提交 → pickup_records +1（quantity=1）
3. remaining_pickup=2
4. 再取 2 件 → pickup_records 共 2 行，累计 3 件 → remaining_pickup=0
5. 反例：再次点"取货" → 应被拒绝 / 按钮置灰
6. 反例：单次取货数量 > remaining_pickup → 表单校验拦截

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | pickup_records 行数 = 取货操作次数 |
| DB | sum(quantity) = sale_items.quantity |
| DB | remaining_pickup 实时同步 |
| UI | 取尽后 "取货" 按钮置灰；显示"已全部取完" |

#### 清理
```sql
DELETE FROM pickup_records WHERE sale_item_id IN (
  SELECT sale_item_id FROM sale_items WHERE sale_order_id=:soid
);
-- 走链路 1 清理整个销售单
```

---

### 链路 22：跨日 cron 边界（生日 / 感恩日）

**spec**：`link-22-cron-birthday-boundary.spec.ts`
**主题**：cron `0 3 * * *` Asia/Shanghai 触发，生日 / 感恩日（每月 20 号）权益按"当前 cron tick 的日期"判定；同年内幂等（external_ref / idempotency_key / coupon_id 三件套唯一约束）。
**角色**：FY-TEST-ADM（手动触发 + 改系统时间）
**涉及页面**：cron 日志 + `/customers/[uid]`
**关键不变量**：
```
STEP 3 grant-birthday-benefits：年度幂等键 `bday-{YYYY}`，同年内只发一次
STEP 4 grant-thanksgiving-benefits：仅当 day_of_month=20 跑，月度幂等键 `thx-{YYYYMM}`
跨日边界（23:59 vs 00:01）：以 cron tick 当时 NOW()::date 为准，无双发
```

#### 前置
- fixture 顾客 birthday 改为今天的日期（测试用，记原始值用于清理）
- 当前日期非 20 号时跑感恩日：应 skip

#### 步骤
1. `UPDATE client_wechat_users SET birthday=:today WHERE user_id='FY-FIX-CLIENT-01'`
2. 跑 `bun run cron:once` → 日志含 STEP 3 `granted=1`
3. 再跑一次 → STEP 3 `skipped=1`（幂等键命中）
4. 模拟跨年：临时把幂等键删了（`DELETE FROM birthday_grant_log WHERE user_id=:uid AND year=:y`） + 再跑 → 重新发放
5. 跨日测试（如可，调系统时间或在 SQL 模拟）：把上一年的幂等键留着 + 今年跑 → 正常发新一年的
6. 感恩日：如今天非 20 号，cron 应跳过 STEP 4

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | birthday_grant_log 行存在，year=当前 |
| DB | user_coupons 新增"生日礼"券，expire_at=created_at+30 天 |
| DB | point_transactions 新增"生日加积分"行 |
| 幂等 | 同年内重跑 0 新增 |
| 日历 | 仅 20 号跑感恩日；其他日期日志含 `thx-skipped: not-20th` |

#### 清理
```sql
-- 还原 fixture 顾客 birthday
UPDATE client_wechat_users SET birthday=:original WHERE user_id='FY-FIX-CLIENT-01';
-- 清掉本次发放
DELETE FROM birthday_grant_log WHERE user_id='FY-FIX-CLIENT-01' AND year=EXTRACT(YEAR FROM NOW());
DELETE FROM user_coupons WHERE user_id='FY-FIX-CLIENT-01' AND created_at > :test_start;
DELETE FROM point_transactions WHERE user_id='FY-FIX-CLIENT-01' AND external_ref LIKE 'bday-%';
```

---

### 链路 23：服务单"待服务"取消 → session 不回退（未曾扣减）

**spec**：`link-23-service-cancel-session-rollback.spec.ts`
**主题**：服务单在"待服务"被取消时，`sale_items.remaining_sessions` 未扣减无需回退；`service_commissions` 不写。`cancelServiceOrder` 仅允许 `待服务 → 已取消`（已完成 / 服务中不可取消）。
**角色**：FY-TEST-MGR
**涉及页面**：`/services/[soid]`
**关键不变量**：
```
待服务 → 取消：session_used 未扣减 → 无需回退
服务中 → 取消：通常仍未扣（扣减在 complete 时） → 无需回退
已完成 → 不可取消（应转走退款流程）
若 admin 允许"已完成→撤销"（业务上少见）：session_used -1 + service_commissions DELETE
```

#### 前置
- 链路 2 走完一次"开始服务"（status=服务中，未完成）

#### 步骤
1. 在服务单详情页点"取消" / "异常关闭"
2. 状态 → `已取消`，DB cancelled_at 写入
3. sale_items.remaining_sessions 不应被错误扣减（保持原值）
4. service_commissions 不应有本服务单行
5. 反例：已完成的服务单点"取消" → 按钮应不存在或被拒
6. 反例（如 admin 提供撤销）：已完成 → 撤销 → remaining_sessions +1 + service_commissions DELETE

#### 检查点
| 类型 | 检查项 |
|------|--------|
| DB | service_orders.status='已取消'，cancelled_at 非空 |
| DB | sale_items.remaining_sessions 不变（与取消前一致） |
| DB | service_commissions 无该服务单的行 |
| DB | operation_logs 含 `service.cancel` 行 |

#### 清理
```sql
DELETE FROM service_commissions WHERE service_item_id IN (
  SELECT service_item_id FROM service_items WHERE service_order_id=:soid
);
DELETE FROM service_items WHERE service_order_id=:soid;
DELETE FROM service_orders WHERE service_order_id=:soid;
DELETE FROM operation_logs WHERE target_id=:soid;
```

---

### §1.B 跑批结果（首跑 2026-05-17）

> **维护规则**：每次 spec 或对应 admin 实现修复后，必须回来更新本表 + 行末 `状态 / 最近一次结果` 字段。
> 列含义：
> - **结果**：最近一次跑批的终态（PASS / PARTIAL / FAIL / TODO）
> - **类别**：FAIL/PARTIAL 时此问题归属（admin bug / spec UI 选择器 / spec 设计交互 / spec 检测逻辑 / 设计 SKIP — 后者非问题）
> - **行动**：still-FAIL 项的 next step（fix admin / fix spec / 接受 SKIP）

| 链路 | spec 文件 | 最近结果 | verdicts | 关键问题 | 类别 | 行动 |
|------|----------|---------|---------|---------|------|------|
| 13 | link-13-points-balance-check | ✅ PARTIAL | 3/4 PASS + 1 SKIP | `new_txns_external_ref` SKIP：消费触发的 +2 积分不带 external_ref（cron 内 type='消费冲销' 不写 external_ref，只有奖励类才写）| 设计 SKIP | 接受 |
| 14 | link-14-sku-price-snapshot | ✅ PASS | 5/5 | — | — | — |
| 15 | link-15-commission-matrix-snapshot | ✅ PARTIAL | 2/4 PASS + 2 SKIP | `service_commission_snapshot_preserved` SKIP：环境无既有 rate=0.08 美容师 service_commissions 行可参照；`neg_mgr_cannot_update` SKIP 是设计 | spec 设计 | 跑前先用 link-2 流程产生一条该 role/category 的服务结算行 |
| 16 | link-16-customer-promoter-snapshot | ❌ FAIL | — | CSM 进 `/customers/[id]` 触发 `getEmployees()` → `PERMISSION_DENIED: 无权执行 employee:list` → ErrorBoundary 弹出 → 找不到"顾客详情"标题 | 🔴 **admin bug** | **fix admin**：`/customers/[id]/page.tsx` 不该无条件 `getEmployees()`，或把 employee:list 加到 customer_mgr 权限矩阵 |
| 17 | link-17-dashboard-three-role-aggregation | ✅ PARTIAL | 2/5 PASS + 3 SKIP | admin 角色 dashboard 不渲染"今日业绩"卡片（roleContext='admin' 走另一套）；`neg_url_storeFilter` 设计 SKIP（无此 URL 入参）| 设计 SKIP | 接受 |
| 18 | link-18-operation-log-integrity | ❌ FAIL | — | 同 link-16 同根因：CSM 进 `/customers/[id]` 崩溃 | 🔴 **admin bug** | 同 link-16 一并修 |
| 19 | link-19-permission-revoke-immediate | ✅ PARTIAL | 2/4 PASS + 2 SKIP | `mgr_immediate_loss_of_access` SKIP — 检测逻辑过严：实际 `/orders` 已 PERMISSION_DENIED + `hasOrdersMenu=false`，spec 应判 PASS 而非 SKIP | spec 检测逻辑 | **fix spec**：把 `hasOrdersMenu=false` 或 ErrorBoundary 命中也视为 access lost |
| 20 | link-20-coupon-batch-issue | ❌ FAIL | — | 提交按钮选择器歧义：`getByRole('button', { name: '批量发放' }).last()` 在外层 dialog 触发器与弹窗内提交按钮都有 → backdrop 拦截 click 重试 30+ 次超时 | spec UI 选择器 | **fix spec**：在 `locator('dialog[open]')` 作用域内找提交按钮 |
| 21 | link-21-pickup-records | ❌ FAIL | — | 开单 wizard Step 2 找不到分类"歆笙泰妍" / SKU"法米索深层清洁啫喱"。admin 开单页 Step 2 可能默认不展示家居 product_kind（需切大类 Tab）| spec UI 流程 | **fix spec**：探明 admin 开单是否支持家居 product_kind；若不支持则改走 SQL 直建订单 |
| 22 | link-22-cron-birthday-boundary | ❌ FAIL | 2/9 PASS + 7 FAIL | cron STEP 2 refresh-member-levels 因 fixture 当前 rolling-12mo spend=¥1242 < ¥1980 阈值，把 beforeAll 设的"初钻"**降级回 NULL**，STEP 3 birthday 查询过滤掉 → total=0；所有 grant 项 0 | spec 设计交互 | **fix spec**：beforeAll 先开 ¥1000 单 + 确认收款补足 spend 到 ≥1980，afterAll 一并清；或直接调 grant-birthday 单 STEP 跳过 cron-once 全跑 |
| 23 | link-23-service-cancel-session-rollback | ✅ PASS | 4/4 PASS + 2 SKIP | 2 项 SKIP 是设计（已完成单不可取消 + 无 cancelled_at 列）| 设计 SKIP | 接受 |

**统计**：6 PASS（含 4 PARTIAL）+ 5 FAIL，其中 2 条 admin bug、3 条 spec 问题。

**未持久化产物**：
- 跑批原始 stdout 日志保存在 `/tmp/link-runs/link-{13..23}.log`（重启后丢失，需要再跑可重新生成）
- `.last-test-context.json` 仅含 PASS/PARTIAL 6 条 + link-22 失败明细；4 条 FAIL（link-16/18/20/21）因在 writeCtx 之前抛错未写 context

---

## 1.C 跨链路全局一致性快照

**用途**：跑完所有链路后，跑一次全库对账，确认没有污染遗留。CC 在每次 batch 测试结束时调用。

> **Schema 注意（2026-05-03 后）**：`sale_orders.paid_amount` 列已被 DROP；款项侧权威源是
> `sale_order_payments` 表。`sale_orders` 上保留 `received` / `refunded_amount` /
> `prepaid_card_amount` / `payable_amount` 作为冗余快照（应用层同事务双写）。下列查询使用
> `received - refunded_amount` 替代旧 `paid_amount`，并把支付分项检查改写为 JOIN
> `sale_order_payments` 聚合。
>
> **历史数据噪声**：WorkFine 一次性导入的旧订单 `sale_order_payments` 含数据但
> `sale_orders.received` 未回填，跑下面 1/2 两条会得到约 7.5 万 baseline `bad_rows`；
> 调用方应以"测试前后 delta == 0"作为判定，而非要求绝对 `bad_rows=0`。

```bash
eval $PSQL_TEST <<'SQL'
-- 1. sale_orders 金额方程：total_amount = (received - refunded_amount) + payable_amount
SELECT 'sale_orders_money' AS check_name, count(*) AS bad_rows FROM (
  SELECT sale_order_id FROM sale_orders so
  WHERE so.total_amount IS DISTINCT FROM
        (so.received::numeric - so.refunded_amount::numeric) + so.payable_amount::numeric
    AND so.sale_order_type IN ('销售单','转换单')
    AND so.status IN ('已支付','已完成','部分支付')
) x;

-- 2. sale_orders.received / refunded_amount / prepaid_card_amount 三个冗余快照
--    必须等于 sale_order_payments 同方向聚合（权威源）
SELECT 'payments_sum' AS check_name, count(*) AS bad_rows FROM (
  SELECT so.sale_order_id FROM sale_orders so
  LEFT JOIN (
    SELECT sale_order_id,
      COALESCE(SUM(amount) FILTER (
        WHERE change_type IN ('首次支付','回款','储值卡抵扣') AND status='已支付'), 0) AS paid,
      COALESCE(SUM(amount) FILTER (
        WHERE change_type='储值卡抵扣' AND status='已支付'), 0) AS prepaid_card,
      COALESCE(-SUM(amount) FILTER (
        WHERE change_type='退款' AND status='已支付'), 0) AS refunded
    FROM sale_order_payments
    GROUP BY sale_order_id
  ) p ON p.sale_order_id = so.sale_order_id
  WHERE so.sale_order_type='销售单'
    AND (
      so.received            IS DISTINCT FROM COALESCE(p.paid, 0)
      OR so.prepaid_card_amount IS DISTINCT FROM COALESCE(p.prepaid_card, 0)
      OR so.refunded_amount     IS DISTINCT FROM COALESCE(p.refunded, 0)
    )
) x;

-- 3. 储值卡 balance ≡ 流水累加
SELECT 'cards_balance' AS check_name, count(*) AS bad_rows FROM (
  SELECT pc.card_id
  FROM prepaid_cards pc
  LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
  GROUP BY pc.card_id, pc.balance
  HAVING pc.balance <> COALESCE(sum(ct.amount * CASE
    WHEN ct.type::text = '充值' THEN 1
    WHEN ct.type::text = '扣款' THEN -1
    ELSE 0 END), 0)
) x;

-- 4. 服务次数对账
SELECT 'sessions_balance' AS check_name, count(*) AS bad_rows FROM (
  SELECT si.sale_item_id FROM sale_items si
  LEFT JOIN (SELECT sale_item_id, sum(session_used) AS used FROM service_items GROUP BY 1) u
    ON u.sale_item_id = si.sale_item_id
  WHERE si.session_count IS NOT NULL
    AND si.session_count <> si.remaining_sessions + COALESCE(u.used, 0)
) x;

-- 5. 营业额分配 ratio_sum
SELECT 'allocation_ratio' AS check_name, count(*) AS bad_rows FROM (
  SELECT sa.sale_item_id, sum(sa.allocation_ratio) AS r
  FROM sale_allocations sa WHERE sa.is_void=false
  GROUP BY sa.sale_item_id HAVING sum(sa.allocation_ratio) NOT BETWEEN 99.99 AND 100.01
) x;

-- 6. 积分余额 ≡ 流水累加（链路 13 引入）
SELECT 'points_balance' AS check_name, count(*) AS bad_rows FROM (
  SELECT u.user_id FROM client_wechat_users u
  LEFT JOIN (
    SELECT user_id,
      COALESCE(SUM(amount) FILTER (WHERE type IN ('获取','调整')), 0) AS gain,
      COALESCE(SUM(amount) FILTER (WHERE type IN ('消费','过期','退款扣回')), 0) AS spend
    FROM point_transactions GROUP BY user_id
  ) t ON t.user_id=u.user_id
  WHERE COALESCE(u.points_balance, 0) <> (COALESCE(t.gain, 0) - COALESCE(t.spend, 0))
) x;

-- 7. 取货数量对账（链路 21 引入）
SELECT 'pickup_quantity' AS check_name, count(*) AS bad_rows FROM (
  SELECT si.sale_item_id FROM sale_items si
  LEFT JOIN (SELECT sale_item_id, sum(quantity) AS q FROM pickup_records GROUP BY 1) p
    ON p.sale_item_id = si.sale_item_id
  WHERE p.q IS NOT NULL AND p.q > si.quantity
) x;

-- 8. user_coupons 状态机自洽（链路 11 引入）
SELECT 'coupon_state' AS check_name, count(*) AS bad_rows FROM (
  SELECT coupon_id FROM user_coupons
  WHERE (status='已使用' AND (used_sale_order_id IS NULL OR used_at IS NULL))
     OR (status='未使用' AND (used_sale_order_id IS NOT NULL OR used_at IS NOT NULL))
) x;
SQL
```

每条检查的判定：
- `cards_balance` / `sessions_balance` / `allocation_ratio` / `points_balance` / `pickup_quantity` / `coupon_state`：`bad_rows=0` 即全库一致；`>0` 多半是测试遗留或 bug。
- `sale_orders_money` / `payments_sum`：先在 batch 测试开始前跑一次取 baseline，结束时再跑取 after，
  比对 `after - before == 0` 即为本轮无污染。绝对值 `bad_rows≈7.5 万` 是 WorkFine 历史导入遗留（详见上方
  schema 注意框）。

---

## 2. 角色切换矩阵（一次性扫面）

不走业务链路，纯**登录 → 看菜单 → 看页面是否 403**。每个角色 ~5 分钟。

| 角色 | 应可见菜单 | 应不可见 / 403 | 重点验证页 |
|------|----------|--------------|----------|
| admin | 全部 | 无 | `/permissions` 可分配 admin 角色 |
| manager | dashboard / orders / services / appointments / allocations / refunds / customers / coupons (只读) | employees / org / commission / permissions | `/orders` 仅本店；`/allocations` 可保存 |
| finance | dashboard / orders / allocations / refunds / customers / points / card-transactions | 业务创建按钮（开单/服务/预约）应隐藏 | `/refunds` 可创建可审批；`/orders` 无"新建" |
| hr | dashboard / employees / org / stores / permissions | orders / services / refunds | `/employees` 可改 storeId；`/permissions` 不能给 admin 角色 |
| product | dashboard / products / coupons / categories | orders / services / employees | `/products` 可 CRUD SKU |
| customer_mgr | dashboard / customers | 几乎其他全部 | `/customers` 可编辑 |

**反例测试**（每个角色测 1-2 个）：
- manager 直接访问 `/employees` → 应跳转或 403
- hr 直接访问 `/orders/create` → 应跳转或 403
- product 在 URL 直接访问 `/orders/[id]?action=confirm` → 操作应被拦截

---

## 3. 浏览器操控注意事项（Claude in Chrome / 人工通用）

| 场景 | 注意 |
|------|------|
| **避免对话框** | admin 用了自建 `AlertDialog`（非原生 `confirm()`），但部分浏览器 `beforeunload` 仍会拦截。改 storeId / 删员工等关键操作前确认 |
| **乐观锁刷新** | 编辑表单都带 `expectedUpdatedAt`，如果 UI 提示"数据已被他人修改"，刷新页面再操作（不是 bug） |
| **截图节奏** | 每个链路在"提交前 / 提交后 / DB 验证"三个时间点截图，便于事后复盘 |
| **console 监听** | 每跳一个页面读一次 console，Next.js 的 hydration 错误 / Drizzle SQL 警告会在这里冒出来 |
| **网络面板** | 关注 Server Action 的 POST 状态码：200 = 成功，500 = 服务端异常（看 dev server 日志），4xx = 校验失败（看 toast） |
| **多角色并行** | 用浏览器多 profile 或隐身窗口，避免 cookie 冲突；prepare 步骤可一次性创建 6 个 profile |

---

## 4. 测试执行优先级

按 ROI（缺陷收益 / 投入成本）排序：

| 优先级 | 链路 | 理由 |
|--------|------|------|
| P0 | 链路 5（员工调店 scope 同步）| 唯一数据隔离路径，写错会越权 |
| P0 | 链路 4（退款审批多表对冲）| 钱+积分+等级，错一个就是客诉 |
| P0 | 链路 10（储值卡余额对账）| 直接对账金额，丢钱不可逆 |
| P0 | 链路 7（订单金额三方对账）| 单笔金额方程不立 → 财务报表错 |
| P0 | 链路 13（积分体系闭环）| 与等级/退款双向联动，是另一条"虚拟钱"通道 |
| P0 | 链路 19（角色权限即时收回）| 安全相关，离职/调岗场景必测 |
| P1 | 链路 1（开单 → 分配）| 最高频业务，链路 7-9 的前置 |
| P1 | 链路 8（多次回款累加）| 部分支付 → 全付的状态机 |
| P1 | 链路 9（分配比例对账）| 提成核算关键 |
| P1 | 链路 2（服务单完成幂等）| 重复点击 / 网络重试多发 |
| P1 | 链路 12（服务次数对账）| 包卡次数错算客诉率高 |
| P1 | 链路 14（SKU 价格快照保护）| 改价后历史漂移=报表灾难 |
| P1 | 链路 15（提成矩阵即时生效）| 老分配被新比例污染=月底提成对不上账 |
| P1 | 链路 18（操作日志完整性）| 审计合规底线 |
| P2 | 链路 11（优惠券使用幂等）| 单券一次，并发场景需关注 |
| P2 | 链路 6（cron 会员升级）| 异步任务，滞后但不阻塞 |
| P2 | 链路 16（顾客重分配快照保留）| 业绩归属相关，错配导致顾问纠纷 |
| P2 | 链路 17（看板三角色聚合）| 报表正确性，仅在前端展示 |
| P2 | 链路 20（优惠券批量发放）| 写多行，要看是否漏发或重复 |
| P2 | 链路 21（取货流程）| 实物 SKU 占比低，但不可超取 |
| P2 | 链路 22（cron 边界）| 一年一次的生日等，跨日误判会造成漏发 |
| P2 | 链路 23（服务单异常关闭）| 取消路径较冷，但 session 错扣不可逆 |
| P3 | 链路 3（预约转服务单）| 转换路径手动，不必经 |
| P3 | 1.C（全库快照对账）| 每个 batch 结尾跑一次 |
| P3 | 角色切换矩阵 | 部分 e2e 已覆盖 |

### 4.1 链路依赖图

```
链路 1（开单 → 分配） ─┬─→ 链路 2（服务单完成）─→ 链路 12（次数对账）─→ 链路 23（服务取消回退）
                      ├─→ 链路 4（退款）        ─→ 链路 6（会员升级回退）
                      │                        └─→ 链路 13（积分退款扣回）
                      ├─→ 链路 7（金额三方对账）
                      ├─→ 链路 8（多次回款）
                      ├─→ 链路 9（分配比例）
                      ├─→ 链路 10（储值卡）
                      ├─→ 链路 11（优惠券）
                      ├─→ 链路 13（积分获取）
                      └─→ 链路 14（SKU 价格快照）

链路 5（员工调店）       ── 独立
链路 3（预约 → 签到）    ── 独立（自带 fixture）
链路 15（提成矩阵）      ── 独立（前置：链路 1 比较新旧 commission_rate）
链路 16（顾客重分配）    ── 独立
链路 17（看板聚合）      ── 跑前需链路 1 / 2 产生当日数据
链路 18（操作日志）      ── 独立（任何编辑页都可触发）
链路 19（权限收回）      ── 独立（仅依赖 FY-TEST-MGR 账号存在）
链路 20（券批量发放）    ── 独立
链路 21（取货）          ── 需新建实物 SKU
链路 22（cron 边界）     ── 独立
1.C 全库快照            ── 任何 batch 结尾
```

---

## 5. 后续行动建议

1. ~~补 5 个非 admin 测试账号~~ ✅ 已完成（§0.2 7 个 FY-TEST-* 账号已建）
2. ~~建测试库~~ ✅ 已完成（5433/fengyu_wxapp 已与 5434 全量对齐）
3. ~~建 fixture 文件~~ ✅ 已完成（`test-fixtures.json` 已就绪）
4. ~~链路 1 / 7 / 9 / 10 优先自动化~~ ✅ 已完成（spec 已写并跑通）
5. ~~链路 13 / 14 / 15 优先写 spec~~ ✅ 已完成（2026-05-17）
6. ~~链路 19 优先写 spec~~ ✅ 已完成（2026-05-17）
7. ~~链路 17 / 18 写 spec~~ ✅ 已完成（2026-05-17）
8. ~~链路 22 单独跑~~ ✅ 已完成（含 cron × 2 次幂等验证，2026-05-17）；首次跑前注意 fixture.member_level 临时改为"初钻"，afterAll 自动还原
9. **补 verify SQL 集** → 每条链路一个 `db/scripts/verify-link-N.sql`，跑完链路 `eval $PSQL_TEST -f` 验证
10. **集成 1.C 全局对账到 cron** → 加一个 STEP 0 在每日 cron 跑前先验，发现污染立即告警
11. **CI 集成**：把已经通过的 link-1 / 5 / 11 加入 CI（headless 模式），后续逐条加入

---

## 6. 与现有 25 个 Playwright Spec 的关系

| 现有 spec 性质 | 占比 | 本文档关系 |
|--------------|------|----------|
| 页面渲染断言 | 22/25 | 不重叠，本文档跳过 |
| 开单向导 wizard 步骤 | 1/25 (orders-create-flow) | 链路 1 的 UI 子集，本文档延伸到 DB 验证 + 金额对账（链路 7） |
| 回款 dialog | 1/25 (orders-repayment) | 链路 8 多次回款的 UI 子集 |
| 登录表单 | 1/25 (auth) | §0.2 测试账号前置依赖 |

**结论**：本文档是对现有 e2e 的**业务深度 + 数据一致性补充**，不替代渲染层测试。链路 7-23 全部聚焦"金额/次数/积分/余额/权限"的会计恒等式与状态机校验——这种 bug 一旦漏掉就是真金白银的损失或数据隔离失守，是渲染层 spec 完全覆盖不到的死角。

---

## 7. 文件清单（2026-05-17 整合后）

| 类型 | 文件 | 说明 |
|------|------|------|
| 文档 | `README.md` | 本文件（业务链路设计 + 执行规范） |
| 配置 | `playwright.manual.config.ts` | 独立配置，避免污染 `e2e/` 主流程 |
| 夹具 | `test-fixtures.json` | 固定测试夹具 ID / phone 索引 |
| 状态 | `.last-test-context.json` | 跨链路上下文（订单号 / 服务单号 / payment id） |
| 工具 | `_helpers/cleanup.ts` | 销售单全 FK 链清理（L1-L7 顺序，单条 try/catch 不中断） |
| 链路 1 | `link-1-order-allocation.spec.ts` | 已实现，PASS |
| 链路 2 | `link-2-service-lifecycle.spec.ts` | 已实现，PASS |
| 链路 3 | `link-3-appointment-flow.spec.ts` | 已实现，PARTIAL（DB confirmedAt 已修复） |
| 链路 4 | `link-4-refund-approval.spec.ts` | 已实现，PASS |
| 链路 5 | `link-5-employee-relocate.spec.ts` | 已实现，PASS |
| 链路 6 | `link-6-member-upgrade.spec.ts` | 已实现 |
| 链路 7 | `link-7-order-amount-check.spec.ts` | 已实现 |
| 链路 8 | `link-8-installment-payment.spec.ts` | 已实现 |
| 链路 9 | `link-9-allocation-ratio-check.spec.ts` | 已实现，PASS |
| 链路 10 | `link-10-card-balance-check.spec.ts` | 已实现 |
| 链路 11 | `link-11-coupon-consistency.spec.ts` | 已实现，PASS |
| 链路 12 | `link-12-session-count-check.spec.ts` | 已实现 |
| 链路 13 | `link-13-points-balance-check.spec.ts` | 已实现（2026-05-17，含 cron 调用） |
| 链路 14 | `link-14-sku-price-snapshot.spec.ts` | 已实现（2026-05-17） |
| 链路 15 | `link-15-commission-matrix-snapshot.spec.ts` | 已实现（2026-05-17，UI 改价走 SQL 等价） |
| 链路 16 | `link-16-customer-promoter-snapshot.spec.ts` | 已实现（2026-05-17） |
| 链路 17 | `link-17-dashboard-three-role-aggregation.spec.ts` | 已实现（2026-05-17，3 contexts 并行） |
| 链路 18 | `link-18-operation-log-integrity.spec.ts` | 已实现（2026-05-17） |
| 链路 19 | `link-19-permission-revoke-immediate.spec.ts` | 已实现（2026-05-17） |
| 链路 20 | `link-20-coupon-batch-issue.spec.ts` | 已实现（2026-05-17，含 fixture valid_to 临时填充） |
| 链路 21 | `link-21-pickup-records.spec.ts` | 已实现（2026-05-17，使用已存在家居 SKU） |
| 链路 22 | `link-22-cron-birthday-boundary.spec.ts` | 已实现（2026-05-17，含 cron × 2 次幂等验证） |
| 链路 23 | `link-23-service-cancel-session-rollback.spec.ts` | 已实现（2026-05-17） |
