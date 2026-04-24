---
title: operation_logs 增加 operator_client_user_id 字段评估
date: 2026-04-16
status: 推迟（2026-04-16 客户端自助换绑已弃用，本评估对应的限流场景消失）
owner: dev
area: db / fengyu-client cloudfunctions / fengyu-admin
related:
  - db/schema/operation-log.ts
  - fengyu-client/cloudfunctions/clientApi/routes/auth.js (rebindPhone — 已删除)
  - fengyu-admin/src/actions/customers.ts (getCustomerPhoneChangeLogs)
  - notes/tickets/2026-04-16-client-rebind-phone.md §5.4 审计 / §6 P2 弃用决策
---

> **2026-04-16 决策回顾**：客户端 `auth.rebindPhone` 已下线（详见
> `2026-04-16-client-rebind-phone.md` §6 P2），原本评估的"客户端自助操作需要
> operator_client_user_id 字段以支持限流/反查"的场景**消失**。
>
> admin 改 phone 走 `customer.update` + 标准 logUpdate，operator_employee_id 始终
> 非空，原审计缺口不复存在。本评估文档保留作历史参考，**不实施**。

## 1. 现状

`operation_logs`（db/schema/operation-log.ts）当前列：

| 列 | 类型 | 可空 | 含义 |
|----|------|------|------|
| `operator_employee_id` | `varchar(30)` FK → `staff_wechat_users.employee_id` | **是** | 操作员工编号，系统级操作（cronTask/payNotify）可为 null |
| `operator_name` | `text` | 是 | 员工姓名快照；客户端自助写入`'顾客自助'` |
| `operator_role` | `text` | 是 | 员工角色快照（manager/beautician） |
| `org_node_id` | `text` FK → `org_nodes.id` | 是 | 员工组织节点 |
| `source` | `text` | 是 | staffApi / clientApi / adminApi |
| `detail` | `jsonb` | 是 | 结构化详情 |

现有索引：`idx_op_logs_operator(operator_employee_id)` / `idx_op_logs_target(target_type, target_id)` /
`idx_op_logs_action(action)` / `idx_op_logs_created_at(created_at)`。

**客户端自助操作（`auth.rebindPhone`）的写法**（P0 已落地）：

- `operator_employee_id = NULL`
- `operator_name = '顾客自助'`
- `source = 'clientApi'`
- `target_type = 'client_user'`, `target_id = <userId>`
- `detail = { oldPhone, newPhone, clientUserId: <userId>, mergedOrders }`（oldPhone/newPhone 已 mask）

## 2. 评估维度

### 2.1 可查询性 — detail.clientUserId 的 JSONB 路径查询

**写法**：`WHERE (detail->>'clientUserId') = $1`（P1 admin 合并工具和限流检查已在用）

**索引现状**：jsonb 上无索引，`detail->>'clientUserId'` 是全表扫描。当前 `operation_logs` 数据量小
（baseline reset 之后），性能无感。数据增长到 10w+ 行后，按"某客户所有审计"反查会退化成 seq scan。

**可优化项**（不需要改列，就能加速这个查询）：
- `CREATE INDEX idx_op_logs_client_user ON operation_logs ((detail->>'clientUserId')) WHERE detail->>'clientUserId' IS NOT NULL;`
- 这是"功能索引 + 部分索引"，不需要加列就能把 detail 的 clientUserId 反查做到 O(log n)。
- 写入开销很小（每条 insert 多 1 次 jsonb 取键 + 索引维护）。

### 2.2 按"客户发起的审计"反查效率

未来需求：admin 顾客详情的"换绑日志 Tab"、或未来"顾客自助操作日志"Tab。

- 当前依赖 `target_type='client_user' AND target_id=<userId>` 索引命中（idx_op_logs_target 已覆盖）。
- 只要 target_id 正确写入，**不加 operator_client_user_id 也足够**。
- 仅当 "客户既是 actor 也是 target" 且需要反查 "客户作为 actor 的所有日志（不一定 target 是它自己）" 时，
  现有方案才不够用。目前的审计模型里，**客户端能发起的操作目标一定是它自己**（换绑自己的手机号、绑自己的门店、
  更新自己的资料），actor = target，用 `target_id` 反查就行。

### 2.3 加列的迁移成本

若加 `operator_client_user_id varchar(30) FK → client_wechat_users.user_id` 可空：

- drizzle 改动：`schema/operation-log.ts` 增 1 列 + 1 索引
- migration：`ALTER TABLE operation_logs ADD COLUMN operator_client_user_id varchar(30) REFERENCES client_wechat_users(user_id);`
  + `CREATE INDEX idx_op_logs_client_operator ON operation_logs(operator_client_user_id) WHERE operator_client_user_id IS NOT NULL;`
- 代码改动：
  - `fengyu-client/cloudfunctions/clientApi/routes/auth.js` rebindPhone 事务 insert operation_logs 增加列
  - 其他客户端自助审计入口（bindStore / requestUnbind / updateProfile 等，但目前**都没写审计日志**，
    一旦做 operator_client_user_id 就可以统一补齐）
  - `fengyu-admin/src/actions/customers.ts` getCustomerPhoneChangeLogs 可选择用新列读取 operator
- 成本评估：**迁移+代码改动 ~2h**，低风险（新列可空，旧数据不需要回填），但需要两库（5433+5434）同步跑 migrate。

### 2.4 约束：operator_employee_id 与 operator_client_user_id 的关系

如果加新列，自然会问："一行日志能不能两列都非空？能不能两列都为 null？"

三种可能策略：

| 策略 | 语义 | 表达 |
|------|------|------|
| A. 严格二选一 | CHECK 约束：`(employee_id IS NULL) != (client_user_id IS NULL)` | 但系统级日志（payNotify/cronTask）需两者都 null，方案否决 |
| B. 至多一个非空 | CHECK `NOT (employee_id IS NOT NULL AND client_user_id IS NOT NULL)` | 允许两者都 null（系统级），禁止同时非空 |
| C. 不加约束 | 业务侧保证 | 灵活但易写错 |

推荐 **B**（若最终决定加列）。

### 2.5 与 P2 phone_history 表的关系

ticket §5.6 提到 P2 考虑 `client_phone_history` 独立表（`user_id / phone / changed_at / changed_by`）。
一旦该表存在：

- "手机号变更日志"Tab 可直接从 phone_history 读（比从 operation_logs 过滤 action 更专用、更快）
- phone_history 行本身就自带 `changed_by`（client_user_id），operation_logs 的 operator_client_user_id 作用**退化**
- phone_history 表不替代 operation_logs（仍需审计，但有了 phone_history 就不是"唯一反查路径"了）

因此：**operator_client_user_id 的价值主要是"在 phone_history 表出来之前的过渡方案"**。
如果 P2 很快落地，过渡方案的投入产出比就偏低。

## 3. 建议：**推迟到 P2 与 phone_history 表一起做**

理由：

1. **当前需求已由 detail.clientUserId + target_type/target_id 满足**
   - P1 admin 合并工具（本 ticket）和换绑日志 Tab（本 ticket）都已基于 detail.clientUserId 实现
   - rebindPhone 限流（本 ticket）同样基于 detail.clientUserId，工作正常
2. **性能不是当前瓶颈**
   - 若真出现 jsonb 查询慢的情况，加一个**表达式索引**（不加列）即可解决，改动成本更小
3. **P2 phone_history 会使该列价值降低**
   - phone_history 行自带 changed_by，"按客户反查换绑历史"用 phone_history 更自然
   - 真到 P2，把 operator_client_user_id + phone_history 一起设计，避免先加后改
4. **避免在 P1 增加数据迁移风险**
   - 本 ticket 的 P1 已经涉及 admin 合并工具（多表 UPDATE），再叠加 schema 迁移会放大风险面

## 4. 短期推荐（不迁移 schema 也能做的优化）

### 4.1 如果生产 operation_logs 表行数将超过 10w（~6 个月内）

加一个表达式索引（无 schema 层面含义变更，只是查询优化）：

```sql
-- migrations 里新建一个 .sql 追加（生成方式：先 schema/operation-log.ts 里通过
--   index('idx_op_logs_client_user').on(sql`(detail->>'clientUserId')`).where(sql`detail->>'clientUserId' IS NOT NULL`)
-- 让 drizzle-kit 生成，或手写 migration 由维护者 apply）
CREATE INDEX idx_op_logs_client_user
  ON operation_logs ((detail->>'clientUserId'))
  WHERE detail->>'clientUserId' IS NOT NULL;
```

### 4.2 文档化"客户端自助审计写法"

在 `.42cog/dev/client.sys.spec.md`（或 clientApi/CLAUDE.md）加一节：

> 客户端自助触发的审计日志（auth.rebindPhone、未来 auth.updateProfile 等）统一写法：
> - operator_employee_id = NULL
> - operator_name = '顾客自助'
> - source = 'clientApi'
> - detail 中必须包含 clientUserId 字段，供反查

这样将来即使决定加列，迁移脚本只要扫描 `detail->>'clientUserId'` 就能批量回填 operator_client_user_id。

## 5. 触发重新评估的信号

如果下面任一条件出现，应重新评估加列：

- operation_logs 行数突破 100w 且表达式索引仍不够快
- 业务要加"客户为 actor 但 target 不是自身"的审计场景（当前没有）
- P2 phone_history 表确认不做 / 推迟到更远
- 需要把 operator 字段做 FK 级别的强约束（拒绝脏数据）

## 6. 结论

| 维度 | 结论 |
|------|------|
| 当前是否做 | ❌ 否 |
| 推迟到 P2 | ✅ 与 phone_history 表一起设计 |
| 短期补偿方案 | 需要时加 `(detail->>'clientUserId')` 表达式索引 + 文档化写法 |
| 本 ticket 任何代码/schema 变更 | 无 |
