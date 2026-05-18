# Ticket: admin /services/create 顾客搜索可能要求 openid（疑似违反 client-identity-rule）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待排查 |
| 优先级 | **P2**（block link-12 / 可能 block link-3 B2；老顾客接入场景受影响）|
| 端 | fengyu-admin |
| 修复成本 | **S**（一次性改 server action where 子句）|
| 来源 | 2026-05-18 e2e-chains 跑批 link-12 失败 |
| 关联文件 | `src/actions/services.ts` 或 `src/actions/customers.ts`（services/create 顾客搜索路径，待定位） |
| 关联约束 | memory `project_client_identity_rule.md`：顾客"可开单"身份判定仅用 `bound_store_id IS NOT NULL`，**不要求 openid** |

---

## 0 一句话

`/services/create` 页用手机号 `13800138000` 搜 fixture 顾客 `FY-FIX-CLIENT-01`（`bound_store_id='store-nc01'` / `customer_status='保有会员-稳定'` / `openid IS NULL`），搜不到。怀疑后端 SQL 加了 `AND openid IS NOT NULL` 过滤，违反 client-identity-rule。

---

## 1 现象

### 1.1 link-12 log

```
[链路12] Step1 初始不变量 PASS: 10=10+0          ← SQL 注入的 sale_item 没问题
[链路12] Step2 创建服务单...                       ← 进 /services/create 页
[链路12] Step2 创建服务单 — 顾客搜 13800138000     ← 输入手机
Error: fixture 顾客 13800138000 未找到（service create）
```

### 1.2 fixture 顾客 DB 实际状态

```sql
user_id          | name          | phone       | bound_store_id | customer_status | no_openid
FY-FIX-CLIENT-01 | Fixture测试客 | 13800138000 | store-nc01     | 保有会员-稳定   | t
```

→ **bound_store_id 不为空，理论上 admin 应能搜到**。但搜不到。

### 1.3 对照实验

- link-1（`/orders/create` 顾客搜索）：能搜到同一 fixture 顾客 → ✅ PASS
- link-2 / link-25-31（`/orders/create`）：能搜到 → ✅ PASS

**→ 问题不在顾客本身，在 `/services/create` 页的搜索 server action**。

---

## 2 排查方向

### 2.1 嫌疑 SQL（grep 提示）

`src/actions/services.ts` 中可能存在类似：

```ts
where(and(
  ilike(clientWechatUsers.phone, `%${phone}%`),
  isNotNull(clientWechatUsers.openid),    // ← 嫌疑
  ...
))
```

或：

```ts
inArray(clientWechatUsers.customer_status, ['可开单', '保有会员'])
```

排查步骤：
1. `grep -rn "service.*customer\|customerSearch\|searchCustomerForService" src/actions/`
2. 找到对应 action 看 where 子句
3. 对比 `src/actions/customers.ts` 的搜索 where（应该是 client-identity-rule 的权威实现）

### 2.2 备选嫌疑（次概率）

- /services/create 只允许"已绑店 + 至少 1 个未消费完的 sale_item"的顾客出现 → 那 fixture 已经满足（link-12 Step0 注入了 10次卡）
- /services/create 入口的 store scope 过滤把 fixture 顾客的 store-nc01 也过滤掉了（不太可能，FY-TEST-MGR scope 就是 store-nc01）

---

## 3 决策点

### 选项 A：如果 SQL 真有 `isNotNull(openid)` 过滤

→ 直接 DROP 这条过滤，对齐 client-identity-rule。

**风险**：极小——admin 业务上不应该区分有/无 openid 顾客（WorkFine 同步进来的老顾客都没 openid）。

### 选项 B：如果是 customer_status 白名单过滤

→ 把 `'保有会员-稳定'` 加进白名单，或者改用 `customer_status NOT IN ('已流失')` 反向过滤。

### 选项 C：如果是 sale_item 库存查询 join 出问题

→ 这就不是同一根因；link-12 单独问题。

---

## 4 我需要你判断的

**Q1**：要不要我先花 10 分钟 grep + 读 src/actions/ 定位真根因再回来？还是你直接选方案？

**Q2**：如果定位发现是别的（不是 openid），我能否原地继续修？

---

## 5 关联引用

- `notes/memory/project_client_identity_rule.md`（client-identity-rule 权威定义）
- `tests/e2e-chains/link-12-session-count-check.spec.ts:210`
- `tests/e2e-chains/link-3-appointment-flow.spec.ts:280`（B2 可能同根因，待复核）
