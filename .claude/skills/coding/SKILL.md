---
name: coding
description: >
  编码时约束检查卡——仅包含 AI 编码时会违反的项目硬约束。
  当实现业务逻辑、编写云函数路由、处理订单/服务/支付时激活。
metadata:
  title: 编码约束
  description_zh: 项目编码硬约束速查，仅写 AI 从代码中推断不出的约束
  author: nvoyager
  version: 2.0.0
---

# 编码约束速查

读者是 Claude Code。你精通 TypeScript、微信小程序、CloudBase、PostgreSQL。
**本文件只列你编码时会违反的项目硬约束。**

不要写的内容（已有覆盖）：
- Page/Component/云函数模板 → `wx-coding`
- 响应格式/错误前缀 → `wx-coding`
- 架构拓扑/决策理由 → `system-architecture`
- DB schema → 读 `db/schema/`

---

## C1 次数防超卖（原子扣减）

疗程核销 = 本系统的"库存扣减"，必须单条 UPDATE 原子操作。

```sql
-- ✅ 原子扣减 + rowCount 检查
UPDATE order_items SET remaining_sessions = remaining_sessions - $1
WHERE item_flow_no = $2 AND remaining_sessions >= $1;
-- rowCount === 0 → 次数不足，抛错回滚
```

❌ 禁止先 `SELECT remaining_sessions` 再 `UPDATE`（并发下超卖）

## C2 价格快照不可变

订单创建时将商品价格复制到 order_items（snapshot_price/snapshot_sessions），后续所有计算基于快照。

❌ 禁止在订单创建后引用 products/product_skus 的当前价格

## C3 支付幂等

所有支付确认（微信回调、线下确认、服务完成）必须幂等——重复触发不得重复入账/扣次/分配。

```sql
-- ✅ 条件更新，rowCount=0 即已处理过
UPDATE orders SET status = '已支付', paid_at = NOW()
WHERE order_no = $1 AND status = '待支付';
```

❌ 禁止先查状态再更新（TOCTOU 竞态）

## C4 状态单向推进

订单/服务单/预约的状态只能沿状态机正向流转。

```sql
-- ✅ WHERE 锁定当前状态
UPDATE service_orders SET status = '服务中'
WHERE service_order_no = $1 AND status = '待服务';
```

❌ 禁止 `UPDATE SET status=$new` 不带 `WHERE status=$current`
唯一例外：店长 `resetFailed`（支付失败 → 待支付）

## C5 后端统一鉴权

所有权限由云函数中间件校验（middleware/auth.js → middleware/role.js），不信任前端传参。
无权限记录时降级为最低权限（仅操作自己相关记录）。

❌ 禁止从 `event.payload` 取 user_id/role 做权限判断

## C6 组织域数据隔离

所有业务查询必须按组织域过滤：

| 角色 | WHERE 条件 |
|------|-----------|
| 顾客 | `client_user_id = 当前用户` |
| 店长 | `store_id = 当前门店` |
| 美容师 | `store_id = 当前门店 AND assigned_employee_id = self` |

❌ 禁止不带 store_id/client_user_id 的全表查询

## C7 待支付订单唯一

同一顾客同一时间只允许一笔待支付订单。

保障：PG 部分唯一索引 `UNIQUE (client_user_id) WHERE status='待支付'` + 应用层 pre-check。
创建订单前必须先查是否有未支付订单。

---

## 编码检查清单

- [ ] 涉及次数变更？→ 单条 UPDATE + rowCount 检查（C1）
- [ ] 涉及金额？→ 确认使用快照价格，不引用当前商品价（C2）
- [ ] 涉及状态变更？→ `WHERE status = 当前状态`（C3/C4）
- [ ] 涉及支付/核销回调？→ 确认幂等，重复调用无副作用（C3）
- [ ] 涉及数据查询？→ WHERE 含 store_id / client_user_id（C6）
- [ ] 涉及权限操作？→ 用 middleware 校验，不信任前端传参（C5）

## 关联技能

| 技能 | 关系 |
|------|------|
| `wx-coding` | 编码模板和模式（HOW） |
| `system-architecture` | 架构决策和约束保障（WHERE） |
| 本技能 | 编码时约束检查（WHAT） |
