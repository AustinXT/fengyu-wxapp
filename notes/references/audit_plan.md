# 三端逻辑审计计划 v1

**目标**：连续多轮自驱循环，**深度扫描** admin / staff / client 三端的自身逻辑漏洞与跨端逻辑一致性，覆盖 22 个 schema 模块、28 个枚举、7 条硬约束。

**范围（权威来源）**：
- admin = `fengyu-admin/src/app/(main)/*/{actions.ts,queries.ts,schemas.ts,_components}` + `fengyu-admin/src/lib/*`
- staff = `fengyu-staff/cloudfunctions/staffApi/{routes/,middlewares/,helpers/}*`
- client = `fengyu-client/cloudfunctions/clientApi/{routes/,middlewares/,helpers/}*`
- 共享：`db/schema/*.ts`（22 模块）、`db/migrations/*.sql`、`.42cog/pm/*.pr.spec.md`、`.42cog/dev/*.sys.spec.md`、`.42cog/real.md`、`.42cog/cog.md`
- 第三方触发器：`fengyu-staff/cloudfunctions/payNotify/`（微信支付回调）

**循环模式**：每轮固定时长（默认 25 分钟），处理 1 个域，按 PLAN 顺序取下一个 `⏳ pending` 项，输出报告到 `docs/audit/audit-{NN}-{slug}.md`，把进度表更新为 ✅ 并附"关键发现"摘要。

---

## 0. 执行配置（已确认 2026-04-26）

| Q | 项 | 选定 |
|---|------|------|
| Q1 | 横切检查域 | **(a) 全部纳入**，每个业务域审计时叠加跑 §3 的 9 项 CC |
| Q2 | 执行顺序 | **(a) 严格 P0→P1→P2 串行**，单 worktree |
| Q3 | 单轮时长 | **25 分钟** |
| Q4 | P0 发现策略 | **(b) 仅记录，最后汇总**；§6.4 P0 熔断条件不启用 |
| Q5 | 报告语言 | **中英混合**（中文叙述 + 英文代码/字段名） |
| Q6 | 验证 SQL | **生成**，仅 `SELECT` / `EXPLAIN`，目标 5434/fengyu，禁止写入 |
| Q7 | 报告冲突 | **(b) 追加 v2**：`audit-NN-slug-v2.md` |

---

## 1. 评级标准（避免循环间评级飘移）

### P0 阻断 / 资损 / 越权（必须修）
触发任一：
- **数据资损**：金额/次数计算错、重复扣款、重复扣次、价格快照被篡改
- **支付重入**：微信回调或确认收款不幂等
- **状态机崩坏**：状态非法跳变、跨端各自维护导致冲突
- **越权**：未鉴权路由、roles 校验缺失、scope_id 范围未过滤、跨用户/跨门店访问
- **SQL 注入**：字符串拼接 SQL、未参数化
- **唯一性破坏**：订单号/服务单号/支付流水号重复

### P1 数据一致 / 状态错乱（应修）
触发任一：
- 三端字段命名 / 枚举值集合不一致
- 三端校验规则不对齐（client 校验 staff 不校验）
- 时间字段写入责任不清（created_at vs updated_at 漂移）
- 列表分页/筛选/排序口径不一致
- 操作日志缺失或操作者识别错误

### P2 代码质量 / 可维护（建议修）
- 死代码、未引用 helper、注释错误
- 错误前缀不规范（不是 `UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:` 之一）
- N+1 查询、缺索引但不影响正确性
- 测试覆盖空白（无 unit / E2E）

---

## 2. 业务域清单（25 个）

### P0 核心交易链路（10 域）

| # | 域 | admin 入口 | staff 入口 | client 入口 | 关键检查点 |
|---|---|---|---|---|---|
| 01 | **认证 / 鉴权 / 双端用户表隔离** | `lib/auth.ts` + `(auth)/login` | `routes/auth.js` + middleware | `routes/auth.js` | OPENID 鉴权、roles 解析、scope_id 范围、`client_wechat_users` ↔ `staff_wechat_users` 隔离、bindPhone 找 row 写 openid |
| 02 | **开单 + 状态机 + 订单号唯一** | `(main)/orders/{actions,queries}.ts` | `routes/order.js` create/qrcode/confirmOffline/close/resetFailed | `routes/order.js` create/pay/cancel | sale_order_type 5 值（销售/内部/回款/转换/退款）、advisory lock、订单号 `FY-XSD-WX-{YYMMDD}{4位}`、价格从 product_skus 快照、状态机迁移合法性、待支付订单唯一约束 |
| 03 | **款项流水（sale_order_payments）** | `(main)/orders/[id]/payments` | `routes/order.confirmOffline` 写流水 | `routes/order.pay/alipayPay/offlinePay` 写流水 | paymentChangeType 4 值（首次支付/回款/退款/储值卡抵扣）、paymentFlowStatus 4 值、source_end 4 值（client/staff/admin/notify）、首次支付至多 1 行/订单、退款 amount 为负、`chk_sop_amount_sign` CHECK 约束 |
| 04 | **支付回调 / payNotify 幂等** | — | `cloudfunctions/payNotify/index.js` | — | 微信回调签名校验、orderId/transactionId 幂等键、状态推进幂等、回调重放安全 |
| 05 | **服务单 + 扣次原子性** | `(main)/services` | `routes/service.js` create/start/complete/cancel | `routes/service.js` detail/list | unit_real_price 快照、原子扣减（条件 UPDATE 不先读后写）、completed_at 幂等、appointment_id 关联、serviceOrderType 售前/售后、serviceOrderStatus 4 值 |
| 06 | **预约 + 签到 → 服务单流转** | `(main)/appointments` | `routes/appointment.js` confirm/checkin | `routes/appointment.js` create/cancel | appointmentStatus 5 值、checkin_at 写入、转服务单时机与 appointment_id 回填、过期自动 close |
| 07 | **销售提成分配（sale_allocations 扁平）** | `(main)/allocations/[orderId]` + `(main)/commission` | `routes/allocation.js` save/deleteAllocation/getCommissionRates/pendingList/suggest | — | 扁平表按 saleItemId 插入、salesCategoryEnum 4 值（自销自耗/他销自耗/他销他耗/生态合作）、commission_rate_matrix 查询一致、allocationStatus 待分配/已分配 |
| 08 | **服务提成（service_commissions）** | `(main)/commission` | `routes/service.complete` 触发写入 | — | 手工费/卡数提成、与 sale_allocations 口径一致、原子性 |
| 09 | **商品 + SKU + 价格 + 有效期** | `(main)/products/{create,[id],categories}` | `routes/product.js` + `routes/mgmt-product.js` | `routes/product.js` | product_kind 4 值（护理项目/家居产品/充值卡/体验卡）、is_bundle 表达组合套餐、price/special_price/valid_start/valid_end、shopInit 价格三处一致、productType 枚举（疗程卡/单品/家居产品） |
| 10 | **顾客（client_wechat_users 含档案）+ 会员等级** | `(main)/customers/[id]` | `routes/customer.js` + `routes/mgmt-customer.js` | `routes/auth.updateProfile/bindPhone` | openid 可空（老顾客）、phone UPSERT、bound_store_id 判定可开单、memberLevel 5 值滚动 12 月跳档、customerType 4 值、customerStatus 5 值、customerSource 10 值、spendingTier 6 档、monthlyActivity 3 档 |

### P1 业务支撑（10 域）

| # | 域 | admin | staff | client | 关键检查点 |
|---|---|---|---|---|---|
| 11 | **退款 / 退换货** | `(main)/refunds` | `routes/customer.refundHistory` | — | sale_order_type=退款单、payment_change_type=退款金额为负、原单 sale_orders 状态联动、coupon/积分回退 |
| 12 | **门店绑定 / 解绑申请流** | `(main)/stores` + `(main)/store-unbind` | `routes/store.list/unbindRequests/approve/reject` | `routes/store.requestUnbind/getUnbindRequest/cancelUnbindRequest` | storeUnbindRequestStatus 4 值、申请人/审批人不同店、bound_store_id 清空时机 |
| 13 | **优惠券** | `(main)/coupons/{create,[id]}` | `routes/coupon.available` | `routes/coupon.list/available` | couponType 3 值、couponStatus 3 值、available 计算（适用商品+门店+生效期）、使用幂等、过期自动置 status |
| 14 | **充值卡 + 卡流水** | `(main)/cards` + `(main)/card-transactions` | `routes/card.js` | `routes/card.list/history` | cardTransactionType 充值/扣款、余额扣减原子性、流水追溯、抵扣写 `sale_order_payments.储值卡抵扣` |
| 15 | **积分余额 + 流水 + 等级跳档触发** | `(main)/points` | — | `routes/points.balance/history` | point_transactions 流水、跳档由 client_wechat_users.member_level 维护、积分获得/消耗规则一致 |
| 16 | **消息中心** | `(main)/messages` | — | `routes/message.list/read/unreadCount` | messageRecipientType 客户/员工、已读/未读语义、推送触发与归档 |
| 17 | **数据看板（管理 + 员工）** | `(main)/dashboard` | `routes/mgmt-dashboard.js` + `routes/staff.dashboard` | — | 时间维度仅当天/本月/上月（[project_dashboard_time_dimensions](../../memory/project_dashboard_time_dimensions.md)）、与 sale_allocations / service_commissions 口径一致 |
| 18 | **员工绩效（performanceDetail）** | `(main)/employees/[id]` | `routes/staff.performanceDetail/dashboard/todayCommission/monthlyCalendar` | — | 与 sale_allocations 加总一致、filterType 参数语义、月度日历空数据日处理 |
| 19 | **赠送 / 分享 / 客户分配** | `(main)/share-gift` | `routes/customer.giftHistory/assign` | — | 分配仅店长（roles.includes('manager')）、记录可追溯、跨店分配限制 |
| 20 | **家居产品提货** | `(main)/pickup-records` | — | — | itemDirection 4 值（购买/转出/转入/退出）、提货剩余次数计算、提货记录与 sale_items 关联 |

### P2 后台管理与配置（5 域）

| # | 域 | admin | staff | client | 关键检查点 |
|---|---|---|---|---|---|
| 21 | **组织架构（org_nodes 邻接表 + stores 1:1）** | `(main)/org` + `(main)/stores/[id]` | `routes/store.list` | `routes/store.list/detail` | orgNodeType 4 值、邻接表无环、type=门店 1:1 stores、scope_id FK 完整性 |
| 22 | **权限矩阵 + 角色（permission_roles）** | `(main)/permissions` | middleware 读取 | — | roles 数组解析、scope_id 范围控制、positionScope 3 值（总部/市场/门店） |
| 23 | **操作日志（operation_logs）** | `(main)/logs` | 写入 | 写入 | operator_employee_id 写入完整（v3.3 后）、关键动作（开单/退款/分配/解绑审批）必写、operator_user_id 已废弃 |
| 24 | **品项分类动态字段** | `(main)/products/categories` | — | `routes/product.categories` | migration 0014 字段（isCardKind/displayColor/displayIcon/requiresShengmeiFlag）一致 |
| 25 | **流量 / 推广员链路** | — | `routes/mgmt-traffic.js` | `routes/auth.bindStore` 写 sourceChannel/promoterEmployeeId | 推广员业绩归属、来源渠道枚举、推广员变更追溯 |

---

## 3. 横切检查域（9 个，每个域审计时都跑这套清单）

### CC1 数值精度与金额计算（P0）
- [ ] 金额字段 NUMERIC(N,2) 而非 FLOAT
- [ ] JS 端用字符串/Decimal 库，不用 `Number` 直接相加
- [ ] 提成比例 NUMERIC(5,4) 或 (3,4)，舍入策略一致
- [ ] 退款 amount 为负的符号约束（`chk_sop_amount_sign`）
- [ ] 折扣计算顺序（券→卡→积分）三端一致
- [ ] 总价 = sum(unit_real_price × quantity) 在三端口径一致

### CC2 并发与幂等（P0）
- [ ] advisory lock：订单号生成、待支付订单唯一
- [ ] CAS UPDATE：`UPDATE ... WHERE status = 'expected' AND ...` 后 `result.rowCount === 1` 校验
- [ ] UNIQUE 约束：sale_order_id、service_order_id、wx_transaction_id
- [ ] 回调重放：transactionId / out_trade_no 作为幂等键
- [ ] 重复 click：前端 loading + 后端 idempotency-key

### CC3 组织域数据隔离（P0）
- [ ] 所有 SELECT 包含 `org_node_id IN (?)` 或 `store_id = ?` 过滤
- [ ] 一线员工额外限定 `employee_id = $current` 或 `assignee_id = $current`
- [ ] 客户端按 openid / customer_id 过滤
- [ ] 跨域 / 跨用户访问被显式拒绝

### CC4 后端统一鉴权（P0）
- [ ] 所有 staffApi / clientApi 路由先过 middleware
- [ ] roles 数组从 DB 读取，不信任前端传参
- [ ] 无权限记录降级为最低权限（仅自己相关记录）
- [ ] admin 用 server actions 而非裸 API，session 校验在 layout.tsx

### CC5 错误码与错误前缀（P1）
- [ ] 错误前缀符合约定：`UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`
- [ ] 响应格式 `{ code: 0|-1|-400|-401|-403, message, data }`
- [ ] 三端处理同一错误的 UI 文案一致

### CC6 PII / 敏感数据（P1）
- [ ] 日志输出不包含完整手机号 / 身份证 / openid
- [ ] 错误信息不泄露 SQL / 表结构
- [ ] admin 列表展示遵循脱敏规则（中间 4 位 `*`）

### CC7 时间字段责任（P1）
- [ ] created_at / updated_at 由 DB DEFAULT 或触发器统一写入
- [ ] {action}_at（checkin_at / started_at / completed_at / paid_at）由对应 action 写
- [ ] 时区一致（统一 UTC 或 Asia/Shanghai）
- [ ] DateTime 序列化跨端一致（ISO 8601 vs timestamp）

### CC8 WXML / Vant 一致性（P2）
- [ ] Vant 组件属性名（v-bind 风格）三端一致
- [ ] 状态机 → UI 文案映射一致（"待服务"/"服务中"/"已完成"/"已取消"）
- [ ] 列表空态、loading 态、错误态组件一致

### CC9 测试与迁移残留（P2）
- [ ] 关键路径有 unit test（Vitest）或 E2E（Playwright）
- [ ] 已废弃字段无引用残留（catalog_items、material_products、promotion_schemes、product_spu、product_spu_sku_map、user_id、operator_user_id、order_no/item_flow_no/service_order_no/store_name/customer_name/staff_name/sku_display_name/receivable）
- [ ] 已废弃枚举无引用残留（big_category、workfine_source、组合套餐、福利活动）

---

## 4. 单域审计输出格式

每轮循环产出 `docs/audit/audit-{NN}-{slug}.md`：

````markdown
# 审计报告：{域名} ({NN})

**审计时间**：YYYY-MM-DD HH:MM
**域 ID**：{NN}
**审计员**：claude-opus-4-7
**审计时长**：{分钟}
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/xxx.ts:LL` | ↑ | ↑ |
| Action/Route | `xxx/actions.ts:LL` | `routes/xxx.js:LL` | `routes/xxx.js:LL` |
| 前端 | `xxx/page.tsx:LL` + `_components/xxx.tsx` | `pages/xxx/index.ts:LL` | `pages/xxx/index.ts:LL` |
| 测试 | `xxx.spec.ts:LL` | — | — |

## 2. 数据流图（必要时）

```
client.create → sale_orders.待支付 (+ advisory lock)
              → sale_order_payments.首次支付/待支付 (1 行)
payNotify    → sale_order_payments.已支付 (CAS UPDATE)
              → sale_orders.已支付
staff.complete → service_orders.已完成 (CAS, 扣次)
              → service_commissions (write)
```

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）
- **[P0-NN-01]** 标题（一句话）
  - 文件：`xxx.js:LL`
  - 现象：…
  - 风险：…（资损金额量级 / 越权范围）
  - 复现：1) … 2) … 3) …
  - 修复：(L0/L3/L7/L9 哪一层)

### 3.2 P1
### 3.3 P2

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 字段命名 | `xxx` | `yyy` | `xxx` | … | P1 |
| 枚举值 | 5 值全 | 仅 4 值 | 5 值全 | staff 漏 1 | P1 |
| 状态机 | 允许 A→C | 不允许 | 不感知 | 状态崩坏 | P0 |
| 校验规则 | 必填 | 必填 | 选填 | 数据不全 | P1 |

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [x] CC1 数值：金额字段 OK
- [ ] CC2 并发：order.create 缺 advisory lock → P0
- [x] CC3 隔离：OK
- ...

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | — | — | — |
| L3 云函数 routes | `staffApi/routes/order.js:120` | 加 advisory lock | P0-02-01 |
| L7 admin actions | `orders/actions.ts:80` | 校验 sale_order_type | P1-02-03 |
| L9 前端 | `pages/order/index.ts:200` | UI loading 状态 | P2-02-01 |

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 验证待支付订单唯一约束
SELECT customer_id, count(*)
FROM sale_orders WHERE status = '待支付'
GROUP BY customer_id HAVING count(*) > 1;
```

## 8. 回归测试用例（建议）

1. ...
2. ...

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☐
- 修复成本：S / M / L

## 10. 后续待办

- [ ] 与 …  对齐
- [ ] 写补丁迁移
````

---

## 5. 单域审计 Checklist（每轮必跑，与 §2 关键检查点配合）

### 自身漏洞（13 项）
- [ ] SQL 全部参数化（`$1, $2`，无字符串拼接，无 `template literal` SQL）
- [ ] OPENID 鉴权在路由入口校验（不在业务逻辑中）
- [ ] 错误前缀符合 4 项约定
- [ ] 涉及金额/扣次/状态的 UPDATE 用 CAS 或在事务内
- [ ] 状态机迁移有显式枚举校验，禁止任意 status 赋值
- [ ] 数值用 NUMERIC，避免 JS Number 精度
- [ ] 幂等：UNIQUE 约束 + 应用层防重
- [ ] 7 条硬约束 (`real.md`) 检查（次数防超卖、价格快照、支付幂等、状态单向、后端鉴权、组织隔离、待支付唯一）
- [ ] 错误处理覆盖：try/catch 包裹 DB 操作，PG 连接池正确释放
- [ ] 输入校验：phone/openid/orderId 格式校验
- [ ] 时间字段时区一致
- [ ] 返回 data 不含敏感字段（密码、salt、内部 ID）
- [ ] 大列表查询有分页

### 跨端一致性（10 项）
- [ ] 字段命名对齐 db schema（v4.0 重命名）
- [ ] 枚举值集合对齐（28 个枚举）
- [ ] 状态机：admin 修改路径被 staff/client 状态校验覆盖
- [ ] 时间字段写入责任明确
- [ ] 主键：employee_id 已升 PK，所有 FK 已迁移
- [ ] 错误码统一
- [ ] 列表分页 / 排序 / 筛选口径一致
- [ ] 时区与日期格式一致
- [ ] roles / scope_id 一致解析
- [ ] 操作日志写入触发点完整

### 横切（9 项，见 §3）
- [ ] CC1 数值精度
- [ ] CC2 并发幂等
- [ ] CC3 组织隔离
- [ ] CC4 后端鉴权
- [ ] CC5 错误码
- [ ] CC6 PII
- [ ] CC7 时间字段
- [ ] CC8 WXML/Vant
- [ ] CC9 测试与残留

---

## 6. 循环执行规范

### 6.1 启动命令

```bash
mkdir -p docs/audit
/loop 25m 按 notes/references/audit_plan.md §2 顺序，每轮取下一个 ⏳ pending 域：
  1. 读 §2 该行 + §3 横切清单 + §5 Checklist
  2. 用 Explore agent 扫描三端入口（限定 thoroughness=medium）
  3. 输出 docs/audit/audit-{NN}-{slug}.md（按 §4 模板）
  4. 更新本文件 §8 进度表（⏳ → ✅，附 1 行关键发现）
  5. 若发现 P0 且 Q4=(b)，仅记录不暂停；若 Q4=(a)，append 一段 BLOCKED 提示后退出
```

### 6.2 断点恢复

- 每轮开头先读 PLAN §8 进度表，跳过 ✅，取第一个 ⏳
- 报告号 NN = 域 ID，slug = 域名 kebab-case 翻译
- 报告冲突按 Q7 处理

### 6.3 跨轮上下文沉淀

- 每轮发现的 **横切问题**（同一类问题在多个域出现）写入 `docs/audit/CROSS-CUTTING.md`，避免重复发现
- 每轮发现的 **schema/enums 修改建议** 写入 `docs/audit/SCHEMA-CHANGES.md`，最终统一评审
- 每轮发现的 **新枚举值/废弃枚举** 写入 `docs/audit/ENUM-AUDIT.md`

### 6.4 P0 熔断条件（Q4=(a) 时）

任一触发即退出循环：
- 发现 ≥3 个 P0
- 发现 1 个涉及资损的 P0（金额/扣次错误）
- 发现 1 个未鉴权路由

### 6.5 超时与失败

- 单轮超过 25 分钟仍未输出报告：标记该域为 🟡 partial，记录已完成部分，进入下一轮
- Explore agent 失败 2 次：降级为直接 grep + Read，不再用 agent
- 任何工具连续失败 3 次：退出循环，等待用户

### 6.6 最终汇总（所有域完成后自动触发）

输出 `docs/audit/SUMMARY.md`：
- 总览（25 域 P0/P1/P2 计数）
- Top 10 P0
- 横切热点（出现次数 ≥ 3 的同类问题）
- 修复 roadmap（按层 L0→L10 排序）

---

## 7. 实操注意

### 7.1 只读不写

- 审计循环 **绝不** 修改业务代码 / schema / migrations
- 仅写入 `docs/audit/*.md`、本文件 §8 进度表、`CROSS-CUTTING.md` 等审计产物
- SQL 仅 `SELECT` / `EXPLAIN`，禁止 `INSERT/UPDATE/DELETE/DDL`

### 7.2 不打扰生产

- 不连接生产 PG（5434）做写入操作
- 不部署云函数
- 不触发微信回调测试

### 7.3 报告引用规范

- 文件路径用 `path:line` 格式（让用户能 cmd+click 跳转）
- 引用 schema 用 `db/schema/xxx.ts:LL`
- 引用 spec 用 `.42cog/pm/xxx.spec.md#section`
- 引用 memory 用 `memory/xxx.md`

---

## 8. 进度追踪表

### P0 核心交易链路

| # | 域 | 状态 | 报告路径 | 关键发现 |
|---|---|---|---|---|
| 01 | 认证 / 鉴权 / 双端用户表隔离 | ⏳ pending | | |
| 02 | 开单 + 状态机 + 订单号唯一 | ⏳ pending | | |
| 03 | 款项流水（sale_order_payments） | ⏳ pending | | |
| 04 | 支付回调 / payNotify 幂等 | ⏳ pending | | |
| 05 | 服务单 + 扣次原子性 | ⏳ pending | | |
| 06 | 预约 + 签到 → 服务单流转 | ⏳ pending | | |
| 07 | 销售提成分配 (sale_allocations) | ⏳ pending | | |
| 08 | 服务提成 (service_commissions) | ⏳ pending | | |
| 09 | 商品 + SKU + 价格 + 有效期 | ⏳ pending | | |
| 10 | 顾客 + 会员等级 | ⏳ pending | | |

### P1 业务支撑

| # | 域 | 状态 | 报告路径 | 关键发现 |
|---|---|---|---|---|
| 11 | 退款 / 退换货 | ⏳ pending | | |
| 12 | 门店绑定 / 解绑流 | ⏳ pending | | |
| 13 | 优惠券 | ⏳ pending | | |
| 14 | 充值卡 + 卡流水 | ⏳ pending | | |
| 15 | 积分 + 等级跳档 | ⏳ pending | | |
| 16 | 消息中心 | ⏳ pending | | |
| 17 | 数据看板 | ⏳ pending | | |
| 18 | 员工绩效 | ⏳ pending | | |
| 19 | 赠送 / 分享 / 客户分配 | ⏳ pending | | |
| 20 | 家居产品提货 | ⏳ pending | | |

### P2 后台管理

| # | 域 | 状态 | 报告路径 | 关键发现 |
|---|---|---|---|---|
| 21 | 组织架构 (org_nodes + stores) | ⏳ pending | | |
| 22 | 权限矩阵 + 角色 | ⏳ pending | | |
| 23 | 操作日志 (operation_logs) | ⏳ pending | | |
| 24 | 品项分类动态字段 | ⏳ pending | | |
| 25 | 流量 / 推广员 | ⏳ pending | | |

### 横切检查（最后一轮汇总，或并行散落到各域报告）

| # | 横切域 | 状态 | 汇总路径 |
|---|---|---|---|
| CC1 | 数值精度与金额 | ⏳ pending | |
| CC2 | 并发与幂等 | ⏳ pending | |
| CC3 | 组织域隔离 | ⏳ pending | |
| CC4 | 后端鉴权 | ⏳ pending | |
| CC5 | 错误码 | ⏳ pending | |
| CC6 | PII | ⏳ pending | |
| CC7 | 时间字段 | ⏳ pending | |
| CC8 | WXML/Vant | ⏳ pending | |
| CC9 | 测试与迁移残留 | ⏳ pending | |

---

## 9. 参考资料索引（每轮循环必读）

| 文件 | 内容 |
|------|------|
| `.42cog/real.md` | 7 条硬约束（违反后果最严重） |
| `.42cog/cog.md` | 业务实体与流程认知模型 |
| `.42cog/pm/backend.pr.spec.md` | 后端产品规范（v2.1.0） |
| `.42cog/pm/admin.pr.spec.md` | admin 产品规范 |
| `.42cog/pm/staff.pr.spec.md` | staff 产品规范 |
| `.42cog/pm/client.pr.spec.md` | client 产品规范 |
| `.42cog/dev/sys.spec.md` + 三端 sys.spec | 系统架构规范 |
| `db/schema/enums.ts` | 28 个枚举的权威来源 |
| `db/schema/index.ts` | 22 个 schema 模块导出 |
| `db/CLAUDE.md` | DB schema 工作流（不能 push、不能手写 SQL） |
| `CLAUDE.md` | 项目全局规范 |
| `memory/MEMORY.md` | 项目记忆（v3.x/v4.x 重命名、客户端身份判定等） |

---

## 10. 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-25 | v0 | 初始 21 个域草案 |
| 2026-04-26 | v1 | 深度优化：补足款项流水/payNotify/服务提成/提货 4 个 P0/P1 域，新增 9 个横切检查域（25 业务 + 9 横切），细化报告模板（10 节），补足循环执行规范（断点/熔断/超时/汇总），引入 7 条硬约束的强制检查 |
