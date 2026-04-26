# Admin Chrome 手动 E2E 测试流程设计

**日期**：2026-04-26
**目的**：为"用真实浏览器（人工 / Claude in Chrome / Playwright headed）走一遍 admin 业务流程"提供可执行的测试地图。
**与现有 Playwright E2E 区别**：现有 21 个 spec 中 87% 是页面渲染断言，此方案聚焦**跨页面、有状态机、跨角色**的端到端业务闭环——这些场景写自动化成本高、肉眼一眼能看出问题。

---

## CC 必读（执行前请先读完）

**目标读者**：本文档由 Claude Code（CC）拿来按顺序驱动浏览器执行。

**CC 当前可用的浏览器驱动手段**（按优先级排序）：

1. **Playwright headed 临时脚本**（默认推荐）
   - 不入 `e2e/`，写到 `fengyu-admin/scripts/manual-e2e/链路N.spec.ts`
   - `bunx playwright test scripts/manual-e2e/链路N.spec.ts --headed --project=chromium`
   - 可看浏览器、可读 console、可截图、可断点
   - CC 写脚本 → 用户在终端跑 → CC 读输出 / 截图

2. **Claude in Chrome MCP**（要先装扩展并重启会话）
   - 工具名 `mcp__claude-in-chrome__*`
   - 仅在系统提示有 `<functions>` 注册时可用，本会话**没有**

3. **手工流程 + DB 抽查**（CC 不操作浏览器，只指导）
   - 用户按文档步骤手动点击
   - CC 跑 SQL 验证库状态

**CC 执行的纪律**：

- 跑链路前先读 §0.5 的固定夹具，**不要**自己造顾客 / SKU
- 每条链路结束后**必须**跑 §0.6 的清理 SQL，否则下次跑会数据冲突
- 跑 SQL 一律加 `PGPASSWORD=fengyu123 ` 前缀连 5433（参见 §0.3）
- 状态枚举值**全部用中文**（`已支付` `待确认` `已完成`），不是 English
- 链路间上下文（订单号 / 服务单号）通过 `notes/research/.last-test-context.json` 传递（§0.6）

---

## 0. 测试环境准备

### 0.1 服务

| 项 | 命令 / 地址 |
|----|------------|
| Admin dev server | `cd fengyu-admin && bun run dev` → `http://localhost:3000` |
| 数据库 | **测试库** `47.113.202.7:5433/fengyu_wxapp`（用户 `fengyu` 密码 `fengyu123`），主库 `5434/fengyu` 不要碰 |
| 切换 admin 连接 | 改 `fengyu-admin/.env.local` 的 `DATABASE_URL` 指向 5433/fengyu_wxapp，重启 dev server |
| Cron worker（按需） | `cd fengyu-admin && bun run cron:once` 手动触发会员/积分日任务 |

### 0.2 测试账号

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

### 0.3 数据快照与回滚

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

### 0.4 CC 操作浏览器的执行模式

**默认模式：Playwright headed 临时脚本**（无须 MCP，最稳）

骨架（CC 写到 `fengyu-admin/scripts/manual-e2e/`，目录已加入 .gitignore）：

```ts
// scripts/manual-e2e/link-1-order-allocation.spec.ts
import { test, expect } from '@playwright/test'
import fs from 'fs'

test.use({ storageState: '.auth/manager-store.json' }) // 见下方 §0.4.1

test('链路1：开单 → 收款 → 分配', async ({ page }) => {
  // Step 1: 开单
  await page.goto('/orders/create')
  await page.getByPlaceholder(/手机号/).fill('FIXTURE_PHONE')
  await page.getByRole('button', { name: /搜索/ }).click()
  // ... 选商品 / 提交 ...

  // 截图 + 写订单号到上下文文件
  const orderId = await page.locator('[data-testid="order-id"]').textContent()
  await page.screenshot({ path: 'test-results/link-1-after-create.png' })
  fs.writeFileSync('../../notes/research/.last-test-context.json',
    JSON.stringify({ link1: { orderId, ts: Date.now() } }, null, 2))
})
```

跑命令：
```bash
cd fengyu-admin
bunx playwright test scripts/manual-e2e/link-1-order-allocation.spec.ts \
  --headed --project=chromium --reporter=list
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

#### 0.4.1 多角色 storageState 准备

每个测试角色需要一份 `.auth/{role}.json`：

```ts
// scripts/manual-e2e/setup/login-{role}.ts
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

跑一次：`bunx playwright test scripts/manual-e2e/setup/login-roles.ts`

### 0.5 固定测试夹具（fixtures）

**已就绪**：fixture 已写入 [`test-fixtures.json`](./test-fixtures.json)（5433/fengyu_wxapp 上以 `FY-FIX-` 为前缀创建）。

| Fixture | ID | 用途 |
|---------|-----|------|
| 测试顾客 | `FY-FIX-CLIENT-01` / phone `13800138000` | 链路 1-9 / 11 / 12 全部业务流水 |
| 储值卡 | `FY-FIX-CARD-01`（balance=1000，初始已写一条 +1000 流水）| 链路 10 |
| 优惠券模板 | `FY-FIX-CT-01`（现金券，满 200 减 30，30 天有效）| 链路 11 |
| user_coupon | `FY-FIX-COUPON-01`（未使用）| 链路 11 |
| 普通 SKU 1 | `c79157b29c9e974c`（缦之羽 - 洗-无创纹身 ¥100）| 链路 1 / 7 / 9 |
| 普通 SKU 2 | `2e388ba778334779`（假性皱纹管家 ¥100）| 链路 1 第二件 |
| 充值卡 SKU | `sku-007-01`（金卡 5000）| 链路 10 |
| 多次卡（已存在）| sale_item `FY-XSD-WX-2603210001-02`（脱毛 12 次卡）| 链路 12 次数对账 |

**CC 读 fixture**：
```bash
CFIX="$(cat notes/research/test-fixtures.json)"
CLIENT_USER_ID=$(echo "$CFIX" | jq -r '.customer.user_id')
CLIENT_PHONE=$(echo "$CFIX" | jq -r '.customer.phone')
SKU_NORMAL=$(echo "$CFIX" | jq -r '.skus.normal_low.sku_id')
SKU_CARD=$(echo "$CFIX" | jq -r '.skus.card.sku_id')
CARD_ID=$(echo "$CFIX" | jq -r '.prepaid_card.card_id')
COUPON_ID=$(echo "$CFIX" | jq -r '.user_coupon.coupon_id')
```

**何时重建 fixture**：被链路测试污染（如 user_coupon 状态变 "已使用" 没还原）时跑：
```bash
eval $PSQL_TEST < <(jq -r '._cleanup.sql[]' notes/research/test-fixtures.json)
# 然后重新跑下方"重建 fixture" SQL 块（见文档历史 commit）
```

提成矩阵已确认：南昌市场配置见 `commission_rate_matrix WHERE market_name='南昌市场'`（15 行），覆盖各品类 × 角色组合，链路 1/9 可直接用。

### 0.6 链路上下文传递

链路有依赖（链路 4 需要链路 1 的订单），用上下文文件传递：

`notes/research/.last-test-context.json`（CC 自己维护，**已加入 .gitignore**）：
```json
{
  "link1": { "saleOrderId": "FY-XSD-WX-26042600001", "ranAt": "2026-04-26T10:00:00Z" },
  "link2": { "serviceOrderId": "FY-FWD-XXXXX", "ranAt": "..." }
}
```

每条链路脚本：
- 跑前读这个文件取上一步产物
- 跑后写入自己的产物
- 链路 N 找不到链路 N-1 的产物时直接 skip 并提示

---

## 1. 核心业务链路（12 条）

每条链路按"前置 → 步骤 → 检查点（UI + DB）→ 清理"四段式编排。

- 链路 1-6：业务功能闭环（开单 / 服务单 / 预约 / 退款 / 调店 / 会员升级）
- 链路 7-12：**数据一致性**专项（金额方程 / 回款累加 / 分配比例 / 卡余额 / 券状态 / 服务次数）
- §1.A：跨链路全库快照对账

### 链路 1：开单 → 收款确认 → 营业额分配 → 提成入账

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
SOID=$(jq -r '.link1.saleOrderId' notes/research/.last-test-context.json)
eval $PSQL_TEST -c "
  SELECT 'order' AS kind, status, total_amount, paid_amount, allocation_status FROM sale_orders WHERE sale_order_id='$SOID'
  UNION ALL SELECT 'items', count(*)::text, NULL, NULL, NULL FROM sale_items WHERE sale_order_id='$SOID'
  UNION ALL SELECT 'allocations', count(*)::text, NULL, NULL, NULL FROM sale_allocations
    WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id='$SOID');"
```

#### 清理
```sql
DELETE FROM sale_allocations
  WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id=:id);
DELETE FROM sale_items WHERE sale_order_id=:id;
DELETE FROM sale_orders WHERE sale_order_id=:id;
DELETE FROM operation_logs WHERE target_id=:id;
```

---

### 链路 2：服务单生命周期 → 提成核算

**角色**：FY-TEST-MGR
**涉及页面**：`/services` → `/services/[serviceOrderId]`
**关键约束**：`completeServiceOrder` 是原子操作（写 completed_at + 写 service_commissions + 幂等）

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
| DB | `SELECT count(*) FROM service_commissions WHERE service_item_id IN (...)` 等于 service_items 行数（提成行已写）|
| DB（幂等）| 二次完成后 `commission_status` 不重复，`session_used` 不再加 |

#### DB 验证
```bash
SOID=$(jq -r '.link2.serviceOrderId' notes/research/.last-test-context.json)
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
5. DB 应有 `confirmed_at IS NOT NULL`、`status='已确认'`
3. 在"已确认"Tab 找到该条，点 **"签到"**
4. DB `checkin_at` 写入；status 不一定立即变（具体看 admin 实现，可能仍为 `已确认` 直到对应服务单完成才转 `已完成`）
5. （手动）在 `/services/create` 新建服务单时选关联预约 `TEST-APT-001`，提交后 `service_orders.appointment_id='TEST-APT-001'`

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

**角色**：FY-TEST-FIN（创建）+ FY-TEST-ADM（审批）
**涉及页面**：`/refunds` → `/refunds/[saleOrderId]`
**关键事实**：admin 项目**没有独立 `refund_orders` 表**——退款是新建一张 `sale_orders` 行：
- `sale_order_type='退款单'`（枚举值，不是英文）
- `ref_sale_order_id` 指向被退款的原订单
- `status` 走 `待审批 → 已支付`（已支付 = 已审批通过）或 `已关闭` (驳回)
- `refund_reason` / `handling_fee` / `approved_by` / `approved_at` / `rejected_reason` 字段在 sale_orders 上

#### 前置
读 `.last-test-context.json` 拿链路 1 的 `saleOrderId`（已支付 + 已分配的销售单）。
理想：该顾客刚通过链路 1 升了会员等级（验证回退逻辑）。

#### 步骤
1. FY-TEST-FIN 登录，进 `/refunds`
2. 点"新建退款" → 填原单号（链路 1 的 saleOrderId）→ 退款金额 / 理由 / 退款方式（原路 / 储值卡）
3. 提交，UI 跳到详情页，状态徽章 **"待审批"**
4. 把生成的退款单 `saleOrderId`（type=退款单 那张）写入 `.last-test-context.json` 的 `link4.refundSaleOrderId`
5. 退出，FY-TEST-ADM 登录，进 `/refunds/[refundSaleOrderId]`
6. 点 **"审批通过"**，状态徽章变 **"已支付"**
7. （反例）回 FY-TEST-FIN 再开一个相同原单的退款单，应被拦截（admin 项目里检查"已退过"）

#### 检查点
| 类型 | 检查项 |
|------|--------|
| UI | 退款单状态：`待审批 → 已支付`（通过）/ `已关闭` + `rejected_reason`（驳回）|
| UI | 原销售单详情页应出现"已退款"或类似徽章 |
| DB | `SELECT status, sale_order_type, ref_sale_order_id, approved_by, approved_at FROM sale_orders WHERE sale_order_id=:refundId`：status=`已支付` type=`退款单` ref=原单 approved_by=`FY-TEST-ADM` |
| DB | 顾客积分被扣减（详见下方 SQL） |
| DB | （如适用）`client_wechat_users.member_level` 由 `已支付前的等级` → `回退等级`，`old_member_level` 写入 |
| DB | 储值卡退款方式：`card_transactions` 应有正向回冲行（type='充值'） |
| DB | `operation_logs` 至少 2 条（target_id=退款单 saleOrderId，action 含 create + approve）|

#### DB 验证
```bash
RID=$(jq -r '.link4.refundSaleOrderId' notes/research/.last-test-context.json)
SOID=$(jq -r '.link1.saleOrderId' notes/research/.last-test-context.json)
eval $PSQL_TEST -c "
  SELECT 'refund_order' AS k, status::text, sale_order_type::text, ref_sale_order_id, approved_by
    FROM sale_orders WHERE sale_order_id='$RID'
  UNION ALL SELECT 'origin_order', status::text, sale_order_type::text, NULL, NULL
    FROM sale_orders WHERE sale_order_id='$SOID'
  UNION ALL SELECT 'point_txn_after', sum(amount)::text, NULL, NULL, NULL
    FROM point_transactions WHERE ref_order_id='$RID'
  UNION ALL SELECT 'logs', count(*)::text, NULL, NULL, NULL
    FROM operation_logs WHERE target_id='$RID';"
```

#### 清理
```sql
-- 多表对冲难精确回滚，最稳是删退款单 + 还原顾客等级 + 删衍生流水
DELETE FROM point_transactions WHERE ref_order_id=:refundId;
DELETE FROM card_transactions  WHERE ref_order_id=:refundId;
DELETE FROM operation_logs WHERE target_id=:refundId;
DELETE FROM sale_items WHERE sale_order_id=:refundId;
DELETE FROM sale_orders WHERE sale_order_id=:refundId;
-- 顾客 member_level 还原需手工，依据 old_member_level 字段：
UPDATE client_wechat_users SET member_level=old_member_level, old_member_level=NULL,
       member_level_upgraded_at=NULL WHERE user_id=:clientUserId AND old_member_level IS NOT NULL;
```

---

### 链路 5：员工入职 → 角色分配 → 调店 scope 同步

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

**角色**：FY-TEST-ADM（手动触发 cron）
**涉及页面**：`/customers/[user_id]` → `/settings`（看权益规则）→ 客户端小程序"消息"页（可选）
**关键约束**：cron `0 3 * * *` Asia/Shanghai 自动跑，本地用 `bun run cron:once` 手动触发；STEP 2 = `refresh-customer-status` 后续的 `refresh-member-levels`

#### 前置
- 1 个顾客年度消费额接近升级阈值（差几百元，可在 `client_wechat_users` 找已绑店且 member_level 不是顶级"黑钻"的）
- `system_configs.config_key='member_level_benefits'` / `member_level_thresholds` 已配置（5434 库 0 行 → 跑 cron 前要先确认有配置或本测试 skip）

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
| DB | `point_transactions` 新增行：`user_id=:uid, type='获取', amount > 0, external_ref` 含等级名（如 `level_upgrade_粉钻_2026`）|
| DB | `user_coupons` 新增行：`user_id=:uid, template_id` 对应该等级权益券，`status='未使用'` |
| DB | `messages` 表新增 `recipient_user_id=:uid` 升级通知 |
| 幂等 | 同日重跑 `cron:once`：`point_transactions.external_ref` 唯一键拦截 → 0 新增；同 user 同等级 user_coupons 不重复 |

#### DB 验证
```bash
UID="<test_user_id>"  # 从 client_wechat_users 选取
eval $PSQL_TEST -c "
  SELECT 'level' AS k, member_level::text, old_member_level::text, member_level_upgraded_at::text
    FROM client_wechat_users WHERE user_id='$UID'
  UNION ALL SELECT 'pt_count', count(*)::text, NULL, NULL
    FROM point_transactions WHERE user_id='$UID' AND created_at > now() - interval '1 hour'
  UNION ALL SELECT 'coupons_count', count(*)::text, NULL, NULL
    FROM user_coupons WHERE user_id='$UID' AND created_at > now() - interval '1 hour'
  UNION ALL SELECT 'messages_count', count(*)::text, NULL, NULL
    FROM messages WHERE recipient_user_id='$UID' AND created_at > now() - interval '1 hour';"
```

#### 清理
```sql
DELETE FROM point_transactions WHERE user_id=:uid AND external_ref LIKE 'level_upgrade%';
DELETE FROM user_coupons WHERE user_id=:uid AND created_at > NOW() - INTERVAL '1 hour';
DELETE FROM messages WHERE recipient_user_id=:uid AND created_at > NOW() - INTERVAL '1 hour';
UPDATE client_wechat_users
  SET member_level=old_member_level, old_member_level=NULL, member_level_upgraded_at=NULL
  WHERE user_id=:uid AND old_member_level IS NOT NULL;
```

---

### 链路 7：订单金额三方对账（创建-支付-清算闭环）

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
SOID=$(jq -r '.link7.saleOrderId' notes/research/.last-test-context.json)
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
同链路 1 的清理脚本。

---

### 链路 8：多次回款累加一致性

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
SOID=$(jq -r '.link1.saleOrderId' notes/research/.last-test-context.json)
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
SOID=$(jq -r '.link1.saleOrderId' notes/research/.last-test-context.json)
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
找一张：
```sql
SELECT uc.coupon_id, uc.user_id, uc.template_id, uc.status, uc.expire_at, ct.discount_value, ct.coupon_type, ct.min_spend
FROM user_coupons uc JOIN coupon_templates ct ON ct.template_id = uc.template_id
WHERE uc.status='未使用' AND uc.expire_at > NOW() AND uc.user_id=:fixture_uid LIMIT 5;
```

#### 步骤
1. 链路 1 开单时勾选该 user_coupon
2. 提交订单后立即查 user_coupons 状态
3. 反例：在 step 1 前并发开两单都用同一张券 → 第二单应失败
4. 反例：链路 4 退款这单 → 券是否回滚为"未使用"？需查 admin 实现（业务上一般**不回滚**）

#### 检查点
```bash
COUPON_ID="<coupon_id>"
SOID=$(jq -r '.link1.saleOrderId' notes/research/.last-test-context.json)
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

**主题**：包卡 / 多次卡的次数会计恒成立。
**角色**：FY-TEST-MGR
**关键不变量**（按 sale_item 维度）：
```
sale_items.session_count
  ==  sale_items.remaining_sessions  +  SUM(service_items.session_used WHERE sale_item_id=X)
```

#### 前置
找 / 开一单 session_count > 1 的可消费项（充值卡 / 多次护理）。
```sql
SELECT sale_item_id, sale_order_id, session_count, remaining_sessions, product_name
FROM sale_items
WHERE session_count > 1 AND remaining_sessions IS NOT NULL
  AND sale_order_id IN (SELECT sale_order_id FROM sale_orders WHERE client_user_id=:fixture_uid)
LIMIT 5;
```

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

## 1.A 跨链路全局一致性快照

**用途**：跑完所有链路后，跑一次全库对账，确认没有污染遗留。CC 在每次 batch 测试结束时调用。

```bash
eval $PSQL_TEST <<'SQL'
-- 1. 所有 sale_orders 金额方程
SELECT 'sale_orders_money' AS check_name, count(*) AS bad_rows FROM (
  SELECT sale_order_id FROM sale_orders so
  WHERE so.total_amount <> so.paid_amount + so.payable_amount + so.prepaid_card_amount
) x;

-- 2. 所有支付流水累加 = paid_amount
SELECT 'payments_sum' AS check_name, count(*) AS bad_rows FROM (
  SELECT so.sale_order_id FROM sale_orders so
  LEFT JOIN (
    SELECT sale_order_id,
      sum(CASE WHEN change_type IN ('首次支付','回款','储值卡抵扣') THEN amount
               WHEN change_type='退款' THEN amount ELSE 0 END) AS net
    FROM sale_order_payments GROUP BY sale_order_id
  ) p ON p.sale_order_id = so.sale_order_id
  WHERE so.paid_amount IS DISTINCT FROM COALESCE(p.net, 0)
    AND so.sale_order_type='销售单'
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
SQL
```

每条 `bad_rows=0` = 全库一致；`>0` = 历史数据 / 测试遗留 / bug 致污染，需查证。

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
| P1 | 链路 1（开单 → 分配）| 最高频业务，链路 7-9 的前置 |
| P1 | 链路 8（多次回款累加）| 部分支付 → 全付的状态机 |
| P1 | 链路 9（分配比例对账）| 提成核算关键 |
| P1 | 链路 2（服务单完成幂等）| 重复点击 / 网络重试多发 |
| P1 | 链路 12（服务次数对账）| 包卡次数错算客诉率高 |
| P2 | 链路 11（优惠券使用幂等）| 单券一次，并发场景需关注 |
| P2 | 链路 6（cron 会员升级）| 异步任务，滞后但不阻塞 |
| P2 | 链路 3（预约转服务单）| 转换路径手动，不必经 |
| P2 | 1.A（全库快照对账）| 每个 batch 结尾跑一次 |
| P3 | 角色切换矩阵 | 部分 e2e 已覆盖 |

### 4.1 链路依赖图

```
链路 1（开单 → 分配） ─┬─→ 链路 2（服务单完成）─→ 链路 12（次数对账）
                      ├─→ 链路 4（退款）        ─→ 链路 6（会员升级回退）
                      ├─→ 链路 7（金额三方对账）
                      ├─→ 链路 8（多次回款）
                      ├─→ 链路 9（分配比例）
                      ├─→ 链路 10（储值卡）
                      └─→ 链路 11（优惠券）

链路 5（员工调店）       ── 独立
链路 3（预约 → 签到）    ── 独立（自带 fixture）
1.A 全库快照            ── 任何 batch 结尾
```

---

## 5. 后续行动建议

1. ~~补 5 个非 admin 测试账号~~ ✅ 已完成（§0.2 7 个 FY-TEST-* 账号已建）
2. ~~建测试库~~ ✅ 已完成（5433/fengyu_wxapp 已与 5434 全量对齐）
3. **建 fixture 文件** → 跑 §0.5 的 SQL，把固定测试顾客/SKU/卡 写到 `notes/research/test-fixtures.json`
4. **链路 1 / 7 / 9 / 10 优先自动化**（金额一致性 + 高频）→ 写成 Playwright spec
5. **链路 4 / 6 手动跑**（多表对冲、cron 异步）→ 用本文档当 checklist
6. **补 verify SQL 集** → 每条链路一个 `db/scripts/verify-link-N.sql`，跑完链路 `eval $PSQL_TEST -f` 验证
7. **集成 1.A 全局对账到 cron** → 加一个 STEP 0 在每日 cron 跑前先验，发现污染立即告警

---

## 6. 与现有 21 个 Playwright Spec 的关系

| 现有 spec 性质 | 占比 | 本文档关系 |
|--------------|------|----------|
| 页面渲染断言 | 18/21 | 不重叠，本文档跳过 |
| 开单向导 wizard 步骤 | 3/21 | 链路 1 的 UI 子集，本文档延伸到 DB 验证 + 金额对账（链路 7） |
| 回款 dialog | 1/21 | 链路 8 多次回款的 UI 子集 |
| 登录表单 | 1/21 | §0.2 测试账号前置依赖 |

**结论**：本文档是对现有 e2e 的**业务深度 + 数据一致性补充**，不替代渲染层测试。链路 7-12 全部聚焦"金额/次数/积分/余额"的会计恒等式校验——这种 bug 一旦漏掉就是真金白银的损失，是渲染层 spec 完全覆盖不到的死角。
