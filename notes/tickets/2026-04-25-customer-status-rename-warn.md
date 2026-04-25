# Ticket: customer_status 枚举重命名 '预警沉睡' → '沉睡'（D-6 落地）

> 生成日期：2026-04-25
> 严重级别：P2（不影响数据正确性，仅是 schema 与 UI 命名对齐；破坏性 schema 变更需单独 PR）
> 端：DB schema + cronTask + db/scripts + admin + staff（mgmt-traffic-stats 子页 i18n）+ 测试 fixtures
> 关联：[`mgmt-traffic-stats-page`](./2026-04-25-mgmt-traffic-stats-page.md) §5 D-6=B 决策落地
>
> **一句话目标**：把 `customer_status` 枚举中的 `'预警沉睡'` 重命名为 `'沉睡'`，
> 让 schema 字面量与 UI 标签完全对齐，消除 i18n 文案层的"预警沉睡 → 沉睡"映射。

---

## 0 一句话背景

`db/schema/enums.ts:116-122` 定义 `customer_status` 5 档：保有会员-稳定 / 保有会员-有效 / **预警沉睡** / 冰冻 / 休眠。
UI（管理层数据中心 + 客量数据子页 + admin 客户列表）展示为 5 档：保有会员-稳定 / 保有会员-有效 / **沉睡** / 冰冻 / 休眠。
长期通过前端文案层兜底；客量数据子页（D-6=B 决策）选择修复源头，把 schema 字面量改为与 UI 一致。

---

## 1 影响范围扫描（grep 结论）

> grep `预警沉睡` 全仓（不含 node_modules / archive / changelogs）：

### 1.1 schema 与 migration

- `db/schema/enums.ts:119` — 枚举定义
- `db/migrations/0000_baseline.sql` — baseline `CREATE TYPE` 语句（**不要改归档；只在新 migration 中 RENAME VALUE**）
- `db/migrations/meta/000N_snapshot.json`（N=0..12）— Drizzle 快照（**新 migration 自动产出新快照，不手改老快照**）

### 1.2 业务代码（运行时读写）

| 文件 | 读/写 | 字面量出现位置 | 改造点 |
|------|------|--------------|------|
| `fengyu-client/cloudfunctions/cronTask/index.js` | 写 | STEP 1 customer_status 重算 SQL（约 4 处 `'预警沉睡'`）| 字面量替换 `'预警沉睡'` → `'沉睡'` |
| `fengyu-client/cloudfunctions/cronTask/__tests__/customer-status.test.js` | 测试 fixture | 期望值 | 同步替换 |
| `db/scripts/update-customer-status.js` | 写 | 备用脚本 SQL | 同步替换 |
| `db/scripts/fix-customer-status-non-member.sql` | 写 | 一次性数据修复脚本 | 同步替换（如尚未跑） |
| `db/scripts/calc-monthly-activity.js` | 写 | `calcCustomerStatus` 函数 | 同步替换 |
| `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` | 显示 / 筛选 | UI 选项映射 | 移除 i18n 映射，直接显示 schema 字面量 |
| `fengyu-admin/src/actions/customers.test.ts` | 测试 fixture | 期望值 | 同步替换 |

### 1.3 文档（口径定义）

| 文件 | 改造点 |
|------|------|
| `db/schema/enums.ts` 注释 | 同枚举值改 |
| `notes/references/metrics.md` | "沉睡人数 / 一次客活 / 二次客活" 行的 `customer_status='预警沉睡'` 字面量替换；"本月激活 SQL"中 anchor 反推用 `last_dt` 不读 `customer_status` 列字面量，无需改 |
| `notes/tickets/2026-04-25-mgmt-traffic-stats-page.md` | D-6 落地后改"前端 i18n 兜底"为"已对齐"|
| `notes/tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md` T0 SQL | 字面量替换 |
| `notes/adapt-plans/02-customer-classification.md` | 字面量替换 |

> 88 处 grep 命中里大部分在 `db/migrations/_archive_*` 与历史 snapshot —— **不动归档**。
> 实际 PR 触及 ~10 个文件。

---

## 2 Migration 设计

PG 支持 `ALTER TYPE ... RENAME VALUE`（PG 10+，本项目用 PG 16）。**不能在事务中执行**，但 Drizzle 的 `db:migrate` 会按文件粒度跑，每条语句独立提交，没问题。

**生成步骤**：

1. 改 `db/schema/enums.ts:119` 把 `'预警沉睡'` → `'沉睡'`
2. `npm run db:generate` → drizzle-kit 产出 `0013_<name>.sql` 含 `ALTER TYPE customer_status RENAME VALUE '预警沉睡' TO '沉睡'` 与对应 `meta/0013_snapshot.json` + `_journal.json` 更新
3. **本地空库验证**：起临时 docker PG（54399），跑 `db:migrate` 从零 apply，确认无错
4. 5434 + 5433 双库各跑一次 `db:migrate`

> **回滚策略**：本 migration 是可逆的（再写一条 `RENAME VALUE '沉睡' TO '预警沉睡'` 即可），但执行后，所有读老字面量的代码都会找不到值。**强约束：migration 必须与代码字面量替换在同一 PR，merge 后立即对双库执行 migrate**。

---

## 3 改造步骤（PR 内顺序）

1. **schema + migration**：
   - 改 `db/schema/enums.ts`
   - `npm run db:generate` 产出 `0013_*.sql` + meta
   - 本地 docker 空库 apply 验证
2. **业务代码字面量替换**：
   - cronTask + scripts + admin（grep `'预警沉睡'` 替换为 `'沉睡'`）
   - 测试 fixtures 同步
3. **文档**：metrics.md / 相关 ticket / changelogs（仅当前 ticket 范围）
4. **本地全量测试**：
   - `cd db && npm run db:migrate` 双库
   - cronTask 单测：`cd fengyu-client/cloudfunctions/cronTask && npm test`
   - admin 单测：`cd fengyu-admin && npm test`
   - staffApi 单测：`cd fengyu-staff/cloudfunctions/staffApi && npm test`
5. **数据自检**：
   ```sql
   -- 旧值应不存在
   SELECT COUNT(*) FROM client_wechat_users WHERE customer_status::text = '预警沉睡';
   -- 应返回 0

   -- 新值应有数据（如有保有会员到沉睡的客户）
   SELECT COUNT(*) FROM client_wechat_users WHERE customer_status = '沉睡';
   -- 应 >=0
   ```
6. **部署**：cloudbase-deploy 重新部署 cronTask（字面量在云函数 SQL 内）+ admin Docker 镜像

---

## 4 测试与验收

### 4.1 自动化

- 全仓 grep `'预警沉睡'` 应无业务代码命中（仅文档历史归档可保留）
- 全部单测全绿

### 4.2 端到端

- admin 客户列表筛选「沉睡」→ 返回正确顾客（与改名前同样数据集）
- mgmt-dashboard 客量数据子页"沉睡人数"卡片：
  - schema 字面量已改：值与 admin 客户列表一致
  - 前端文案：直接显示 `'沉睡'`（无需 i18n 映射）
- cronTask 凌晨 03:00 跑完后，自检 SQL 返回 0

### 4.3 灰度

- 双库 migration 同时跑，避免一边老字面量一边新字面量造成枚举类型 mismatch
- 部署窗口选业务低峰（凌晨 03:00 cronTask 之前完成 migration + 部署）

---

## 5 不在本 ticket 范围

- UI 文案样式调整（仅字面量改动，UI 卡片样式不动）
- 其他 customer_status 枚举值的语义调整（"保有会员-稳定/有效"、"冰冻"、"休眠" 字面量保持）
- mgmt-traffic-stats-page 子页本身的开发（独立 ticket）

---

## 6 工程量预估

- schema + migration：S（1 小时）
- 字面量替换 + 测试 fixtures：S（1.5 小时）
- 文档同步：S（0.5 小时）
- 双库 migrate + 验证：S（0.5 小时）
- **合计**：~半天

---

## 7 交付物清单

- [ ] `db/schema/enums.ts` `'预警沉睡'` → `'沉睡'`
- [ ] `db/migrations/0013_<name>.sql` + `meta/0013_snapshot.json` + `_journal.json`（drizzle-kit 自动生成）
- [ ] `fengyu-client/cloudfunctions/cronTask/index.js` 字面量替换
- [ ] `fengyu-client/cloudfunctions/cronTask/__tests__/customer-status.test.js` fixture 替换
- [ ] `db/scripts/update-customer-status.js` 替换
- [ ] `db/scripts/calc-monthly-activity.js` 替换
- [ ] `db/scripts/fix-customer-status-non-member.sql` 替换（如未执行）
- [ ] `fengyu-admin/src/app/(main)/customers/_components/customers-page.tsx` 移除 i18n 映射
- [ ] `fengyu-admin/src/actions/customers.test.ts` fixture 替换
- [ ] `notes/references/metrics.md` 字面量替换 + 变更记录追加
- [ ] `notes/tickets/2026-04-25-mgmt-traffic-stats-page.md` D-6 状态从"独立 ticket 推进中"→"已对齐"
- [ ] `notes/tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md` T0 SQL 替换
- [ ] `notes/adapt-plans/02-customer-classification.md` 替换
- [ ] 5434 + 5433 双库 `db:migrate` 已执行
- [ ] cloudbase 部署 cronTask + admin docker 镜像
- [ ] 数据自检 SQL 返回 0
