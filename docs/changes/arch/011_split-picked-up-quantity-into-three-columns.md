# sale_items.picked_up_quantity 三语义拆列（新增 refunded_quantity / converted_quantity）

日期：2026-09-18

关联：issue #154（由 #125 的双谱系评审发现）；前序 #120 / #125 / #145 / #149 / #153

## 背景

`sale_items.picked_up_quantity` 这一列先后被塞进三种语义：

| 来源 | 写入方 | 引入时间 |
|---|---|---|
| 已提货 | `order.createPickup` / admin 提货 | 原始语义 |
| 已退款 | `refund-cascade` 通道 5 | 2026-06-08（schema-free 止血） |
| 已转换 | `createConversion` 家居折抵 | 2026-09-14（#125） |

2026-06-08 那次是止血：退家居退的是「未提货」数量，原先 `GREATEST(0, picked_up − qty)`
把退款数从已提货里减，损坏提货账并让 `refundable = quantity − picked_up` 回升致**可重复退**。
当时的修法是把已退数**加进** `picked_up`，语义升级为「已结算」，代价写在注释里：
「彻底分离待 `refunded_quantity` 列」。#125 又加了第三类，代价从「可容忍」变成有明确可触发的缺陷。

## 决策

拆成三个独立列，`picked_up_quantity` 回归「物理提货量」本义：

| 列 | 语义 | 权威交叉源 |
|---|---|---|
| `picked_up_quantity` | 已物理提货 | `SUM(pickup_records.pickup_quantity)` |
| `refunded_quantity` | 已退款结算 | **无独立源 —— 这是拆列的根本理由** |
| `converted_quantity` | 已转换折抵 | `SUM(转出行 quantity WHERE 转换单 status<>'已关闭')` |

「已结算」回归派生量：`settled = picked_up + refunded + converted`（`LEAST(quantity, …)` 封顶），
`可提 / 可退 = quantity − settled`。

### 为什么必须拆而不是继续打补丁

`deletePickupRecord` 的减法只对应三种来源之一，却作用在合计值上：
`quantity=10` → 提 3 盒 → 折抵 7 盒（`picked_up=10`）→ 删掉那条 3 盒的提货记录 → `picked_up=7`
→ 顾客可以再提 3 盒，而这 3 盒的价值已折进另一张转换单。
**没有 `refunded_quantity` 就无法在不新增列的前提下精确修**——「已退款量」没有列可查。

### 三列 NOT NULL + CHECK 约束

两个新列声明为 `integer NOT NULL DEFAULT 0`：它们是全新列、无历史 NULL，没有理由跟着
`picked_up_quantity`（历史 nullable）一起可空——可空会让每个读取点都背一个 `COALESCE`。
PG 11+ 起 `ADD COLUMN NOT NULL DEFAULT <常量>` 是纯 catalog 操作，不重写表、不延长锁窗口。

`CHECK (picked_up + refunded + converted <= quantity)` 作为该不变量的**唯一权威表达**：
写入点的 WHERE 守卫有 8 份手抄，漏一处就是资损；约束不可能被绕过。

> 本轮 pr-ready 对抗评审推翻了初版「不加约束」的理由。原理由是「`ADD CONSTRAINT` 会取
> ACCESS EXCLUSIVE」——但那把锁在本迁移第一条 `ADD COLUMN` 就已取到，且 drizzle 把整批迁移
> 包进单事务持有到提交，**追加约束的边际锁成本是 0**；全表扫描的代价也已被事后断言付过一遍。

约束在**回填之前**生效：此时 `refunded/converted` 恒为 0、`picked_up <= quantity`
（2026-09-18 实测两库 0 行越界），必然通过；回填是等量搬运、三列之和不变，回填后同样成立。

写入点的 WHERE 守卫仍保留——它负责把冲突转成友好的 `CONFLICT` 而不是裸 23514；
cron STEP 12 的 `C5b` 降级为二道保险（约束被误 DROP 时仍能次日发现）。

## migration 编号：刻意跳号到 0043

`test` 与 `dev` 两线的编号自 0039 起已分叉，且 `meta/0039_snapshot.json`、`0040_snapshot.json`
两线**内容不同**：

| idx | test | dev |
|---|---|---|
| 0039 | payment_attribution_date_always_set | inventory_org_endpoints_and_permissions |
| 0040 | bizarre_wolfpack | payment_attribution_date_always_set |
| 0041 | — | bizarre_wolfpack |
| 0042 | — | inventory_sku_supplier_fk |

在 test 线取自然号会得到 `0041_*`，与 dev 的 `0041_bizarre_wolfpack` 同名不同内容 ——
本仓已为此踩坑两次。0043 是两线均未占用的号；drizzle 的下一个号取「上一条 idx + 1」，
跳号不会产生空洞或二次冲突。

`payment-migrations-regression.test.js` 原有的 `idx === index` 守护相应改写为
「已发布段 0..40 逐位对齐 + 新增条目严格递增」——守住原意（已发布迁移不可改号）的同时允许跳号。

## 历史数据回填

写在 0043 同事务内（drizzle migrator 把整个文件包进单事务，`RAISE EXCEPTION` 才能真正回滚）：

```
picked_phys := SUM(pickup_records.pickup_quantity)
conv        := SUM(转出行 quantity WHERE 转换单 status <> '已关闭')
residual    := 旧 picked_up_quantity − picked_phys − conv

residual < 0                                      → RAISE（守恒破坏）
residual > 0 且订单有已支付退款                    → refunded_quantity
residual > 0、无退款、且该行没有 pickup_records     → 留在 picked_up_quantity（历史提货未留记录）
residual > 0、无退款、但该行有 pickup_records       → RAISE（无从解释的结算量）
```

最后一类必须拦：并回 `picked_up_quantity` 会让该行 `picked_up > SUM(pickup_records)`，
与事后断言 2 及 cron C5 的守恒判据直接冲突。

**2026-09-18 只读实测**：存量 `picked_up_quantity > 0` 的行 dev 14 行 / prod 18 行，
**100% 是退款语义**（两库 `pickup_records` 全表为空、家居转出行零数据），残差为负 0 行。

## 部署顺序（硬约束）

0043 **不向前也不向后兼容**。

```bash
# ① 部署前：确认暴露面为 0，并预演回填
DATABASE_URL="<目标库>" node db/scripts/verify-quantity-split.js
# ② 迁移（必须走 db:migrate；禁止 apply-pending-migrations.js，它逐条 autocommit 会丢原子性）
TARGET_DATABASE_URL=... npm --prefix db run db:migrate
# ③ 紧接着部署三端（不可只部分）
scripts/deploy-cloudfunctions.sh          # staffApi / clientApi
.claude/skills/remote-deploy/deploy-admin.sh <env>
# ④ 部署后：校验 AC4 不变量
DATABASE_URL="<目标库>" node db/scripts/verify-quantity-split.js
```

- **正向窗口**（迁移已跑、新代码未部署）：旧代码把 `picked_up_quantity` 读成「已结算」，
  被拆走的份额短暂回到可提/可退。整单退款的订单被派生查询的状态白名单
  （`o.status IN ('已支付','部分支付','已完成')`）挡住；**部分退款**订单不受保护。
  2026-09-18 实测两库暴露面均为 0，部署前必须复跑脚本确认仍为 0。
- **反向禁止回滚**：新列写过之后回滚代码，旧代码会把已退款/已折抵份额读回可提可退（资损）。
  只能 forward-fix。

## 影响面

- db：`schema/order.ts`、migration 0043、`scripts/verify-quantity-split.js`（新增只读核对脚本）
- 云函数：staffApi（refund-cascade 通道 5、order.js 的提货/折抵/回滚/派生、customer.js、
  mgmt-customer.js、utils/refund.js）、clientApi（routes/order.js 派生）
- admin：`lib/{refund-cascade,home-product,refund,types}`、
  `actions/{pickup-records,orders,customers,cards,refunds}`、cron STEP 12、订单详情与提货记录 UI
- 小程序：staff 订单详情 / 提货列表 / 管理层顾客详情（文案回归「已提货」+ 新增已退款、已转换）

payNotify 不涉及家居数量（已验证：11 个 .js 中 `quantity` 出现 0 次）。

## cron STEP 12 的 C5 判据同步重写

旧判据「原单提过货且 `picked_up >= SUM(pickup_records)` 即告警」写于 2026-06-08 止血**之前**
（那时 cascade 用减法回滚）。止血改成加法之后，该式对「既提过货又退过款」的行恒成立 = 必然误报；
#125 的折抵又加了一类。两库 `pickup_records` 至今为空，所以雷还没炸。

新判据回到列本义并与退款彻底解耦：`picked_up_quantity == SUM(pickup_records)`
（豁免「无 pickup_records 的历史提货」行，与迁移口径一致），并新增
`C5b settled_quantity_overflow` 作为 CHECK 约束被误 DROP 时的二道保险。

## 后续项（本 PR 未做）

pr-ready 的 altitude 评审指出：拆列把「已结算」变成了一个**在四端字面重复约 49 次**的派生式，
漏抄一项就是资损——而这正是 #154 要修的那类 bug 的成因。彻底的解法是加一个生成列：

```sql
settled_quantity int GENERATED ALWAYS AS (picked_up_quantity + refunded_quantity + converted_quantity) STORED
```

四端一律直读 `si.settled_quantity`，守卫变成 `settled_quantity + N <= quantity`；定义落在 DB 而非任何一端，
不违反「禁止跨端共享代码目录」。本表已有先例（`cash_received` 就是生成列）。

**本 PR 没做**，理由是：`STORED` 生成列要重写 12.6 万行，改变了本次迁移的风险剖面；
且要重排四端约 49 处 + 全部 snapshot 字面量守护，这个规模的返工放在双谱系评审之前不划算。
CHECK 约束已经把「漏抄一项」从资损降级为写入被拒，风险面大幅收窄。建议另开 issue 跟进。
