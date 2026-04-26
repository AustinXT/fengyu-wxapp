# 11 — `prepaid-card` 模块

**Schema 文件**：`db/schema/prepaid-card.ts`
**涉及 PG 表**：`prepaid_cards`, `card_transactions`
**WorkFine 源表**：⚠️ **完全无独立充值卡实体**。WorkFine 把"充值/储值/预存款"作为 `UDT_M_213` 销售明细子表的一种 `UDF_M_4728='疗程卡'` 行（按 `UDF_M_393` 名称含「充值/储值/预存/余额」关键字识别），通过 `UDT_M_260` 核销次数推算余次后**派生**成 PG 充值卡账户

**主要写入入口**：
- `db/scripts/migrate-prepaid-cards.js` — 从 PG 已导入的 sale_items 重投生成 prepaid_cards + card_transactions（**唯一历史导入入口**；不直连 MSSQL，依赖 01/order migrate 跑完）
- `db/scripts/migrate-active-cards.js` — 从 MSSQL 直接导入"活跃疗程卡"到 sale_orders + sale_items（**不写 prepaid_cards**，仅作为 11/储值卡 上游数据准备步骤；本模块不直接受影响）
- `db/migrations/0003_abandoned_aqueduct.sql:L20-52` — 一次性合并：把 baseline reset 前按 (user_id, store_id) 拆分的多张卡合并到单一 canonical 卡 + DROP store_id 列
- `staffApi/routes/order.js:L946-979` (`confirmOffline`) — 运行时充值卡入账：店长开充值卡订单 → 顾客确认收款时 UPSERT prepaid_cards + INSERT card_transactions（type='充值'）
- `staffApi/routes/order.js:L840-880` (`confirmOffline` 储值卡抵扣) — 运行时扣卡：UPDATE balance + INSERT card_transactions（type='扣款'）
- `staffApi/routes/order.js:L1560-1595` / `L1820-1840` (`approveRefund` / `createRefund`) — 退款回冲：UPSERT prepaid_cards + INSERT card_transactions（type='充值' 回冲）

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | 来源拆分 |
|----|-------|----------|
| prepaid_cards | 1763 | 1761 行 `CARD-{storeId}-{userId}`（migrate-prepaid-cards 派生） + 2 行其他模式 UUID/FY-CARD（admin actions / 运行时） |
| card_transactions | 2499 | 2496 行 type='充值'/ref_order_id 指向 `WorkFine历史订单导入` 销售单（migrate-prepaid-cards 派生） + 3 行 ref 含 `-WX-`（运行时 PG 原生订单） |

**balance 分布**：< ¥100: 175 张; ¥100-500: 1024 张; ¥500-2000: 377 张; ¥2000-10000: 162 张; ¥10000+: 25 张; 总余额约 ¥170 万
**type 分布**：全部 2499 行 type='充值'（**zero `'扣款'` 行** — 全部为初始充值，运行时扣款链路在 5434 现状未产生过任何流水）
**balance vs SUM(amount) 一致性**：0 行偏差（migrate-prepaid-cards 写入时严格 `card.balance = Σ tx.amount`）

> **关键事实**：本模块整体 100% 是**派生**的，不直接读 WorkFine 任何列。脚本 SQL 在 PG 内 JOIN `sale_items + sale_orders`（remark='WorkFine历史订单导入' 标识）筛出"充值类"项目，按余次比例算出 balance 后聚合。**赖于 01/order 模块的 history 导入是否完整 + 项目命名规范是否一致**——脚本筛选条件是 `product_name LIKE '%充值%' OR LIKE '%储值%' OR LIKE '%预存%' OR LIKE '%余额%'`，命中性完全取决于业务侧命名习惯。

---

## 表 1：`prepaid_cards`

**派生口径**（migrate-prepaid-cards.js）：

```sql
SELECT si.sale_item_id, si.session_count, si.remaining_sessions,
       si.sale_amount, si.unit_price, si.received,
       so.sale_order_id, so.client_user_id, so.store_id, so.sale_order_datetime
FROM sale_items si JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
WHERE so.remark = 'WorkFine历史订单导入'
  AND si.remaining_sessions > 0
  AND so.client_user_id IS NOT NULL
  AND (si.product_name LIKE '%充值%' OR '%储值%' OR '%预存%' OR '%余额%')
```

WorkFine 端原口径（migrate-active-cards.js 上游）：`UDT_M_213.UDF_M_4728 IN ('疗程卡','自定义-疗程') AND UDF_M_394 > 0 AND UDF_M_394 - SUM(UDT_M_260.UDF_M_836) > 0`，即「疗程卡型 + 总次数 - 已核销次数 > 0」。

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| card_id | text (PK) | WorkFine 派生 | `'CARD-' + sale_orders.store_id + '-' + sale_orders.client_user_id` | migrate-prepaid-cards.js:L118 | 1761/1763 行符合该模式。⚠️ 0003 migration 后 schema 删除 `store_id` 列，但 card_id **仍保留 store_id 段在 PK 字符串中**（不可逆），最终迁移要规范化建议改用 UUID/`FY-CARD-{ts}{rand}` 与运行时统一 |
| user_id | text (FK → client_wechat_users.user_id) | WorkFine 派生 | `sale_orders.client_user_id`（即 customerMap[UDF_S_1485] lookup） | migrate-prepaid-cards.js:L106, L174 | UNIQUE — 一户一卡（0003 migration 把同 user 多卡合并） |
| balance | numeric(10,2) | WorkFine 派生 | 同一 (user_id) 下所有"充值类"sale_item 的 balance 之和；单 item balance = `round(remaining_sessions / session_count * sale_amount, 2)`；fallback 链：① session_count>0 且 sale_amount>0 → 主路径；② session_count>0 且 sale_amount=0 → 用 unit_price；③ remaining>0 且 received>0 → 用 received | migrate-prepaid-cards.js:L84-93, L127 | 三层 fallback 是关键派生逻辑。**赠品卡**（sale_amount=0）会走 unit_price fallback，可能高估实际"可退现金价值"|
| created_at | timestamp | WorkFine 派生 | 组内**最早 sale_order**的 `sale_order_datetime`（SQL `ORDER BY client_user_id, sale_item_id` 后取第一个） | migrate-prepaid-cards.js:L113-122, L180 | 后续合并的卡时取最早创建时间，但 0003 migration 合并时是按 `MIN(created_at)` ORDER BY 取 canonical 卡，所以最终 created_at 仍是最早值 |
| updated_at | timestamp | 默认值/NULL | `defaultNow()` + onUpdate；UPSERT 强制 `now()` | schema:L21 + migrate-prepaid-cards.js:L178 | 每次 UPSERT 重置；现状全部为最近一次脚本/运行时写入时刻 |

### 已被脚本读但未对接的字段（来自 sale_items / WorkFine）

migrate-prepaid-cards.js 读了 sale_items 的 `unit_price / received / expire_date / product_name / sale_order_datetime`，但 prepaid_cards 表只有 5 列，下列业务信息**没有承载列**：

| 来源字段 | 含义 | 现状 |
|---------|------|------|
| `sale_items.expire_date`（← UDT_M_213.UDF_M_7122） | 充值卡到期日 | ⚠️ **schema 设计漏过期机制**：prepaid_cards 表无 expire_date 列，余额永不过期。WorkFine 端 UDF_M_7122 是疗程卡到期约束（脚本 L116 还过滤 `expire_date > NOW()` 才算活跃），到 PG 端这个约束**完全消失** |
| `sale_items.product_name`（← UDT_M_213.UDF_M_393） | 充值卡名称（"2024 福利预存款"等） | 未对接到卡级。card_transactions 也未存，仅在源 sale_items 表残留 |
| `sale_items.unit_price` 用作 fallback 估值 | 赠品卡原价 | 仅参与 balance 计算（fallback 链 ②），不留任何痕迹于 PG。无法事后审计该卡是否走了 fallback |
| WorkFine `UDT_M_260` 核销明细 | 已核销次数（推算 remaining_sessions 用） | 已在 01/sale_items.remaining_sessions 间接体现，本模块二次派生 |
| WorkFine `UDF_M_4939`（赠送=是/否） | 赠品标志 | ⚠️ 已在 01-order _gaps 列出，本模块 fallback 链无法识别赠品 |

---

## 表 2：`card_transactions`

**派生口径**：migrate-prepaid-cards.js 为每个被聚合到 prepaid_card 的 sale_item 写一条 type='充值' 流水（不写 type='扣款'），即"把每张原始充值订单都当成一笔充值入账"。

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| id | bigserial (PK) | 新系统独立 | DB autoincrement | schema:L34 | |
| card_id | text (FK → prepaid_cards.card_id) | WorkFine 派生 | 同 prepaid_cards.card_id 派生（`'CARD-' + store_id + '-' + user_id`） | migrate-prepaid-cards.js:L185-202 | 0003 migration 后多张卡合并到 canonical 卡时，card_id 也被 UPDATE 重定向（migration L20-31）|
| type | card_transaction_type enum | 默认值/NULL | 硬编码 `'充值'` | migrate-prepaid-cards.js:L189, L196 | **历史 2496 行全部 `'充值'`**；运行时扣款链路（confirmOffline / approveRefund 等）在 5434 现状 zero 产出 |
| amount | numeric(10,2) | WorkFine 派生 | 单 sale_item 的 balance（即 prepaid_cards.balance 派生公式的逐 item 拆分值，不是按比例分摊到订单总额） | migrate-prepaid-cards.js:L86-93, L199 | type='充值' 为正；如未来出现 type='扣款' 应为负（运行时 SQL 写法 `balance + EXCLUDED.balance` 期望正值，扣款写负数 + balance + (-x) = 减少）|
| ref_order_id | varchar(30) (FK → sale_orders.sale_order_id) | WorkFine 直拷 | `sale_orders.sale_order_id`（即 RTRIM(UDT_S_209.UDF_S_372)） | migrate-prepaid-cards.js:L131, L189-202 | 2496/2499 行 ref 指向 `WorkFine历史订单导入` 销售单。3 行例外含 `-WX-` 是 PG 原生订单 |
| created_at | timestamp | WorkFine 直拷 | `sale_orders.sale_order_datetime`（即 UDT_S_209.UDF_S_350） | migrate-prepaid-cards.js:L131, L199 | 范围 2023-02 ~ 2026-04，最早即 sale_orders.sale_order_datetime 最小值 |

### 幂等机制

migrate-prepaid-cards.js:L188-191 用 `(card_id, type='充值', ref_order_id)` 做幂等键查重；运行时 staffApi:L946 用 `ref_order_id + type='充值' LIMIT 1` 同款语义。**注意**：retain ref_order_id 唯一性依赖于"同一 sale_order 不会触发两次充值"，但本表无 UNIQUE 约束，仅靠应用层。

### 已被脚本读但未对接的字段

下列**业务信息流失**仅出现在本表（未提及上游 sale_items 已知 gaps）：

| 来源字段 | 含义 | 现状 |
|---------|------|------|
| `sale_items.product_name` | 充值卡名称（"2024 福利预存款"等命名差异） | 未对接：card_transactions 无 description / note 列，无法区分多张同价位卡的来源 |
| `sale_items.expire_date` | 充值卡到期日 | 同上，schema 完全无 expire 概念 |
| `sale_items.received`（实收金额） | 实付现金（区别于面值） | 未对接：本表 amount 用的是 balance 派生值，不是 received。如顾客 ¥1000 卡用 ¥800 现金 + ¥200 礼券购买，PG 端无法重建"实际现金支付"|

---

## 关键决策摘要

1. **零 WorkFine 直查**：本模块脚本不连 MSSQL，全部从 PG sale_items 二次派生。最终迁移如要更精准还原，应直接从 `UDT_M_213` 用 product_name 关键字筛选（MSSQL 端命中 3158 行，PG 派生命中 2496 行——差额 662 行可能是上游 01/order migrate 已过滤掉的过期/无客户/无门店行）。
2. **赠品卡估值不准**：fallback 链 ②（unit_price）和 ③（received）会出现 balance ≠ 顾客实际可退价值。最终迁移应抽 `UDT_M_213.UDF_M_4939` 赠送标志，赠品卡 balance 设 0 或单独标注。
3. **schema 漏 expire_date**：prepaid_cards 余额永不过期，违背 WorkFine 原约束。如业务侧依赖该约束（避免几年前的余额还能用），最终迁移需加 expire_date 列 + 过期清理 cron。
4. **product_name 关键字漏命中**：脚本筛选用 4 个关键字硬编码，MSSQL 端样本看到「2024 福利预存款」是命中的，但若有「会员卡充值卡」（无关键字）会被漏掉。最终迁移建议改用 `UDT_M_4728 IN ('疗程卡','自定义-疗程')` + `UDT_M_4728 IS NULL` 兜底（MSSQL 端 8 行类型为空）。
5. **0003 migration 不可逆合并**：baseline reset 前 (user_id, store_id) 多卡，0003 migration `DELETE prepaid_cards WHERE card_id NOT IN canonical` + 重定向 card_transactions.card_id。最终迁移如保留多店账户体系需重新设计 schema，**不能从现状反推原拆分**（store_id 信息只剩在 card_id 字符串前缀里）。
6. **0 张扣款流水**：5434 现状 type='充值' 2499/2499，type='扣款' 0/2499。意味着"运行时扣卡链路在 5434 baseline reset 后从未触发过"——与 10/points 模块同样的诊断（cron / 业务流可能未跑）。需运维侧验证：① staffApi 是否有顾客做过储值卡抵扣订单 → confirmOffline；② 充值卡订单是否走过创建-抵扣闭环。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- ⚠️ `prepaid_cards.expire_date` schema 完全缺列，WorkFine `UDF_M_7122` 充值卡到期约束**完全丢失**
- ⚠️ `card_transactions.amount` 对赠品卡用 fallback 链估值，不准确
- 充值卡名称（`UDT_M_213.UDF_M_393`）丢失，无法区分多张同价位卡
- WorkFine 端 product_name LIKE 关键字筛选仅 2496 行命中，剩余 662 行充值类未明（关键字不全 / 类型为空 / 上游 01/order 过滤跳过）
- 0 行 type='扣款'：扣卡运行时链路在 5434 现状无产出，疑似 confirmOffline 储值卡抵扣 / 退款回冲未实际触发
- card_id 形如 `'CARD-{storeId}-{userId}'`，0003 migration DROP store_id 列后 PK 字符串里仍残留 store_id 段（不可逆历史包袱）
- 业务侧 1990s 年代起的「2024 福利预存款」等命名分散，最终迁移如要 normalize 命名/分类需要在 product_name 上做语义聚类
- 同 user 历史多卡（0003 migration 前的拆分情况）信息已被合并丢失，无法回溯各店原始充值额

---

## Review 报告（2026-04-26）

**复核范围**：独立调研 schema / 写入入口（migrations / scripts / cloudfunctions / admin）/ PG 5434 抽样后再读本文档对比。MSSQL 凭据（admin/Se1Qimoh@ 与备份 SD/Se4Qimoh）均登录失败（密码过期），但本模块整体不直查 MSSQL，影响有限。

**verdict：minor-fix**

### 一致项（已逐一核实，准确）

- **Schema 列清单**：5 列 prepaid_cards + 6 列 card_transactions、UNIQUE(user_id) 唯一索引、card_id text PK、ref_order_id varchar(30) FK 全部一致
- **PG 现状量化指标**：1763 prepaid_cards / 2499 card_transactions / 1761 `CARD-` + 2 非 `CARD-` 模式 / 2496 `WorkFine历史订单导入` ref + 3 PG-native `-WX-` ref / type='充值' 2499、type='扣款' 0 / balance vs SUM(amount) 0 偏差 / 总余额 ¥1,703,470.19，全部一致
- **Migration 0003 时序**：DROP store_id + 合并多卡 + UNIQUE(user_id) 在 0003_abandoned_aqueduct.sql L5-52 一致
- **派生口径 SQL**：migrate-prepaid-cards.js L38-64 SQL + L84-93 fallback 链 + L185-202 幂等 全部 line ref 准确
- **ref_order_id 与 sale_orders 链接率 100%**（dangling=0）

### 偏差明细

#### 缺漏（Missing entry points）

- **payNotify/index.js 主写入入口完全未列**（L283 INSERT card_transactions type='充值' + L319 INSERT type='扣款' + L274/L307 prepaid_cards 写入）—— 这是**线上充值 / 扣款的主路径**，运行时 95% 流量走这里，文档"主要写入入口"清单零提及
- **clientApi/routes/order.js 4 个写入路径漏列**：
  - `confirmPrepaidFull` (L518) — 顾客扫码全额抵扣场景，事务内扣余额 + INSERT type='扣款'
  - `cancel` (L1078) — 已扣款订单取消时反向 INSERT type='充值' 回冲
  - `pay` (L1442) — 微信支付通道储值卡部分抵扣
  - `repay` / 部分支付补款 (L1661) — 客户端发起回款时的储值卡扣款
- **staffApi/routes/order.js 漏列**：
  - `createRepayment` (L1820-1834) 真实场景是**回款单储值卡扣款**（INSERT type='扣款' amount=-prepaidCardAmount），不是文档归属的"approveRefund/createRefund 退款回冲"
  - `createConversion` (L2276-2293) 转换单负差额 UPSERT prepaid_cards + INSERT type='充值'
- **admin/actions/refunds.ts L884-894** 退款审批路径漏列，admin 端也参与回冲
- **staffApi/routes/customer.js:L874** 读取 balance 入口（已被 customerBalance 接口使用）漏列

#### 错配（Mis-attribution）

- **L1820-1840 行号归属错误**：文档把它归到 `approveRefund / createRefund` 路径，实际是 `createRepayment`（回款单创建），且方向是**扣款（type='扣款'）**而非"退款回冲"。两者业务语义、type、金额符号完全相反，归错会让读者反推错业务流
- **第 11 行行号**："confirmOffline 充值卡入账 L946-979" 中 INSERT card_transactions 实际在 L974-978，UPSERT 在 L965-972，引用块虽涵盖正确范围但具体 INSERT 行号偏 28 行
- 第 88 行 "运行时 staffApi:L946 用 ref_order_id + type='充值' LIMIT 1" 的实际行号是 L947（dupCheck 的 SELECT），非关键性偏差

#### 数据不一致

- 无。所有量化指标（counts / balance / type 分布 / 一致性 / ref_order 链接）100% 复现

#### 过时事实

- 第 9 行 `migrate-active-cards.js` 描述为"上游数据准备步骤"——该脚本仍在仓库内且有 grep 命中，但 5434 数据按 0003 migration 后已彻底固化，最终迁移已无须再跑 migrate-active-cards/migrate-prepaid-cards。文档可补一句"两个脚本均为一次性历史导入，已完成；运行时不再调用"，避免读者误以为仍是活跃链路
- 第 81 行"运行时扣款链路（confirmOffline / approveRefund 等）在 5434 现状 zero 产出"——结论正确（type='扣款' 0/2499），但解释面应扩到包括上面漏列的 6 个扣款入口（payNotify L319、clientApi confirmPrepaidFull / pay / repay / cancel、staffApi confirmOffline / createRepayment）。"全部链路从未触发"是更精确的描述

### 总评

文档**对历史导入派生逻辑的列级血缘 / 量化指标 / migration 0003 时序追踪极为准确**，是本系列已审模块中数据准确度最高的之一。但**严重低估了运行时的写入路径覆盖**：把 11 个运行时入口压缩成 3 个 staffApi 行号块，且其中 1 个（L1820-1840）业务语义归错。这影响的是"未来追踪扣款链路为什么 0 行"的诊断路径——读者会去 grep `approveRefund` 而漏掉 payNotify / clientApi 主路径。

**P0 评估**：无。本模块运行时扣款 0 行虽然异常，但与文档第 109 行已自陈一致，且不构成业务永久失效（充值流量正常 ¥170 万）。无数据资损或越权风险。

**修复建议**（minor-fix 级）：
1. "主要写入入口"清单补全 8 个漏列入口（payNotify / clientApi 4 个 / staffApi createConversion / staffApi createRepayment 改归属 / admin/refunds / staffApi/customer 读）
2. L1820-1840 归属修正为 `createRepayment` 扣款（不是 refund 回冲）
3. 行号 L946 → L974（INSERT 实际位置）

---

## Edge Case 报告 R2（2026-04-26）

**verdict：serious-edge-cases**

R2 在 R1 的基础上不再复核映射，转向独立调研 schema / migrate 脚本 / 5 个运行时入口（payNotify L274/L319、staffApi confirmOffline L840-880/L946-979、admin refunds L884-894）+ 5434 PG 主动 8 维探针（probe r2-11 / r2-11b 跑完即删）。MSSQL 凭据 admin/Se1Qimoh@、SD/Se4Qimoh、sa 等全部失败（密码过期），但本模块本身不直查 MSSQL，影响有限。

### 8 维度命中清单

| # | 维度 | 命中 | 严重度 |
|---|------|------|--------|
| 1 | FK 孤立 | ❌ 0 行 | clean |
| 2 | NULL/空串/极值 | ⚠️ balance 最小值 0.80 + expire_date '1899-12-31' 哨兵 16 行 + expire_date >2099 远未来 56 行 + 5-99 年区间 2404 行（仅 sale_items 上游，未传到 prepaid_cards） | minor |
| 3 | enum 漂移 | ❌ 干净（type 仅用 '充值'，'扣款' 0 行但 enum 声明完整） | clean |
| 4 | unique 守住与否 | 🔴 **27 组 (card_id, type='充值', ref_order_id) 三元组重复 — 38 行重复流水合计 ¥35,692.80** | **HIGH** |
| 5 | 跨模块一致性 | 🔴 **1 张运行时充值订单（FY-XSD-WX-2604160002，金卡充值卡 ¥2500）已支付但 0 充值流水 — 入账漏写** | **HIGH** |
| 6 | 死代码/永不命中 | ⚠️ type='扣款' 0 行（R1 已记） + 9.7 探针看到 5132+ 行 product_name 未被关键字命中（综合卡/一卡通/养生套餐/黑金 等大量"疗程类"非"充值类"）— 这部分**正确**漏过；但**充卡 (199 行)/充值ym (7 行)/诚意金 (155+130 行)/福利预存款 (102+37+19+16+8+7+6+5+5 ≈ 200+) 等命中应被关键字捕获却被脚本错过** | medium |
| 7 | dump-restore drift | ⚠️ 1761 行 card_id 形如 `CARD-{storeId}-{userId}` PK 字符串残留 store_id 段（R1 已记 + 0003 migration 不可逆）；7.4 探针确认 prepaid_cards 5 列 schema 与文档一致，无 drift | minor |
| 8 | 运行时安全 | 🔴 **payNotify L283/L319 + admin refunds L894 + clientApi confirmPrepaidFull/repay/cancel 等 6 个扣款链路全部以 `(card_id, ref_order_id, type)` 做幂等 SELECT 但 schema 无 UNIQUE 约束 — 维度 4 的根因，并发回调可双写** | **HIGH** |

### 高危发现详情

#### E1（HIGH，schema 闸门缺失 + 数据已存在重复 38 行）：`card_transactions` 缺 UNIQUE(card_id, type, ref_order_id) 约束，27 组重复幂等键

- **位置**：`db/schema/prepaid-card.ts:L31-48` `card_transactions` 仅有 `idx_card_txns_card_id` 普通索引，无 UNIQUE
- **数据现状**（探针 4.3/4.4/4.6/12.2）：
  - 27 组 (card_id, type='充值', ref_order_id) 三元组 GROUP BY HAVING COUNT(*) > 1
  - 单组重复 2-3 行（FY-XSD2503180007 该 sale_order 4 个充值类 sale_item，其 card 只见 3 行重复）
  - 38 行重复流水合计 ¥35,692.80（占总充值流水 ¥1,703,470.19 的 ~2%）
  - 重复行 `created_at` 间隔 0.000000 秒（同事务内同时 INSERT，确认非"重跑"导致）
  - 27 组的 sale_orders 全部为 WorkFine 历史导入（remark='WorkFine历史订单导入'），即一个销售单挂了 2-4 个"充值/储值/预存"类 sale_items（业务侧把"组合包"拆成多条明细）
- **根因**：`migrate-prepaid-cards.js:L188-191` 幂等键 `(card_id, type='充值', ref_order_id)` **粒度不到 sale_item_id**：当一个 sale_order 含多个充值类 sale_items 时，第一笔 INSERT 后第二笔的 dupCheck 应找到首笔，但探针显示两笔同时刻 INSERT（推测 SELECT 出现在 INSERT 前的 SAVEPOINT/快照里看不到自己的写入；或脚本之前版本无 dupCheck 跑过一次）— 不论什么原因，**schema 没有 UNIQUE 约束兜底**，应用层幂等失效就立刻产生重复
- **业务影响**：
  - 38 行流水冗余 → 未来对账/审计 SUM(amount) 仍 = balance（探针 5.1 不一致 0 行），因为 migrate-prepaid-cards.js:L172-178 是 `EXCLUDED.balance` 覆盖式 UPSERT，**balance 取的是聚合后 totalCardBalance，与 SUM(txn.amount) 巧合相等**（验算：每个 dup 组 INSERT 两次相同 amount，但 balance 只累加一次正确值，由 cardMap.balance 控制）
  - **运行时风险**：payNotify L255 / L283 同款 `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 LIMIT 1` 幂等检查；如 wx 回调 retry 在 0.5 秒内连发两次（典型并发场景：网关重试），两笔 BEGIN 同时进入，dupCheck 都返回 0 行 → 都 INSERT → balance 经 ON CONFLICT(user_id) DO UPDATE 累加两次 → **真实资损**
  - **admin refunds L878-894 / staffApi createRepayment L1828-1834 / staffApi createConversion L2288 同样无 UNIQUE 兜底**，但 dupCheck 用 `card_id + ref_order_id`（不含 type），并发场景下退款回冲 + 充值同 ref_order_id 也会双写
- **修复**（顺序）：
  - A（一次性 SQL）：删除 38 行重复 + 重算 balance — 见末尾"建议数据修复 SQL"
  - B（schema）：`db/migrations/00NN_card_txns_unique.sql` 加 `CREATE UNIQUE INDEX uq_card_txns_dedupe ON card_transactions (card_id, type, ref_order_id)`，把幂等约束从应用层下沉到 DB 层
  - C（schema 强化）：再加 partial unique 排除 ref_order_id IS NULL 行（运行时管理员调账场景），或单独加 `idempotency_key` 列做幂等键
  - D（应用层）：把所有 6 处 `SELECT 1 FROM card_transactions ... LIMIT 1` 改为 `INSERT ... ON CONFLICT (card_id, type, ref_order_id) DO NOTHING RETURNING id` 真正原子幂等

#### E2（HIGH，运行时入账漏写 1 行）：金卡充值卡订单 FY-XSD-WX-2604160002 status='已支付' 但 0 充值流水

- **位置**：`fengyu-client/cloudfunctions/payNotify/index.js:L243-292`（充值入账分支）
- **数据现状**（探针 8.2）：
  - `sale_order_id='FY-XSD-WX-2604160002'`，`client_user_id='FYGK-20260314-00001'`，`total_amount=2500.00`，`status='已支付'`，`created_at='2026-04-16 05:11:25'`，`remark=NULL`
  - sale_items 仅 1 行 product_name='金卡充值卡'
  - 该 user_id 同时存在另一张 prepaid_card（card_id='41af639b-…'，balance=¥7378.52，对应 ref_order_id='FY-XSD-WX-2604160004' 的 ¥6378.52 充值 + 后续抵扣测试，详见探针 4.7 / 7.2）
- **可能根因**：
  - ① payNotify L246-250 SQL `JOIN product_skus sk ON si.sku_id = sk.sku_id JOIN product_categories pc ON sk.category_id = pc.category_id WHERE pc.product_kind='充值卡'` — 该订单 sale_items.sku_id 可能是 NULL 或对应的 product_skus.category_id 指向的 category 当时 product_kind ≠ '充值卡'（探针 8.2 用的是当前 product_kind，可能 4-16 时间点 category 配置不同 → schema 漂移）
  - ② sale_items 的 sku_id 是虚拟充值 SKU（admin/orders.ts:L80 RECHARGE_VIRTUAL_SKU_ID）但 product_kind 字典在那个时间点未配置
  - ③ 该订单是 admin/orders.ts 的 `applyRechargeOnOrderPaid` 路径而非 payNotify（admin record-payment-dialog 触发），且 admin 路径在 4-16 的版本可能没接入充值入账逻辑（admin/orders.ts:L80-100 现在有，但提交时间）
- **业务影响**：顾客 FYGK-20260314-00001 充了 ¥2500 金卡但 prepaid_cards.balance 没记 —— ⚠️ **业务方对账时差 ¥2500，顾客投诉风险**
- **修复**（顺序）：
  - A（一次性 SQL）：手工 INSERT 该订单的充值流水 + UPDATE prepaid_cards.balance += 2500（前提：与业务方确认确实未在线下补过）
  - B（cron-worker 一致性 STEP）：每日 03:15 跑 `SELECT so.sale_order_id FROM sale_orders so JOIN sale_items si … WHERE pc.product_kind='充值卡' AND so.status='已支付' AND so.client_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM card_transactions ct WHERE ct.ref_order_id=so.sale_order_id AND ct.type='充值')` 主动告警（已有 cron-worker 框架，加 STEP 6.5）
  - C（payNotify 强化）：JOIN 改为 `WHERE (pc.product_kind='充值卡' OR si.sku_id=$RECHARGE_VIRTUAL_SKU_ID OR si.product_name LIKE '%充值%')` 三层兜底匹配

#### E3（HIGH，schema 闸门缺失 → 资损）：扣款流水路径 `card_transactions.amount < 0` schema 无 CHECK 约束 + balance 列也无 `>= 0` 约束

- **位置**：`db/schema/prepaid-card.ts:L19/L40` 两列都仅 `numeric(10,2).notNull().default('0')`
- **现状**：探针 2.1 balance min=0.80 max=¥41,000（数据上无 negative，因为 0 行扣款），但 schema 无 CHECK
- **业务影响**：
  - **运行时漏判**：clientApi/order.js:L429 `inputAmount < 0` 校验 + L1648 `currentBalance + 0.001 < prepaidCardAmount` 余额校验 + payNotify L310-312 二次校验 — 都在应用层；如 cron 脚本 / admin 跨表手动 SQL 走非云函数路径修改 balance（如 admin/refunds.ts:L884 是 INSERT 而非 UPDATE，不会负值），无 DB CHECK 兜底
  - **type='扣款' 业务约定** schema 注释 L39 写的是 "topup 为正，deduct 为负"，但当前 0 行扣款数据无法验证；clientApi/cancel L1078 + admin/refunds L878 写的是 type='充值' 回冲（amount 为正）— 业务流约定与 schema 注释一致，但缺 CHECK 守护
- **修复**：
  - A 加 `CHECK (balance >= 0)` 到 `prepaid_cards.balance`
  - B 加 `CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))` 到 `card_transactions`
  - C 在 1 张 admin 扣款手工调账场景前先放开（admin/refunds 调用频率低）

### 中等风险

#### E4（medium，命名规范不统一 + 命中遗漏）：migrate-prepaid-cards.js:L57-62 product_name LIKE 4 关键字漏命中

- 探针 9.3 显示 `预存金 (1801) / 娇莉芙-预存金 (278) / 预存 (274) / 充值 (165) / 预存款 (133)` 等 30+ 命名变体均能命中，但 9.7 显示 `充卡 (199) / 充值ym (7) / 微电充值 (3)` 等被脚本切片漏过的"应充值"行至少 200+ 行，原因：
  - **充卡** 不含 4 关键字 → 漏过
  - **诚意金** (155 + 130 = 285 行) 业务侧多用作"代言卡定金"，是否充值类需业务确认
- 业务影响：662 行（11-prepaid 文档已标）差额可能由这部分 + 上游 01/order migrate 过滤的"过期/无客户"行共同贡献。最终迁移如改用 `UDT_M_4728 IN ('疗程卡','自定义-疗程') + UDF_M_393 LIKE '%(充值|储值|预存|余额|充卡|预存金)%'` 6 关键字 + WorkFine 端 UDF_M_4939 赠送标志区分赠品卡，命中率应能从 79.7% (2496/3132) 提升到 90%+

#### E5（medium，2125 张活卡余额永不过期）：prepaid_cards 缺 expire_date 列（R1 已标）+ 5434 sale_items 充值类有 56 行 expire_date > 2099-01-01 哨兵

- 探针 9.6：56 行 expire_date > 2099（是 WorkFine 端"永久卡"哨兵 +99 年）+ 2404 行 5-99 年区间（典型 +30~50 年）+ 542 行 5 年内有效 + 130 行已过期但 remaining_sessions > 0
- 业务影响：130 行已过期但 prepaid_cards 已包含其 balance 派生 → 顾客余额"已过期但仍可用"违规；最终迁移加 expire_date 列后必须二选一：① 失效已过期卡 → 余额不可用 + 通知顾客 / ② 协议改"已发预存余额无限期" → schema 不加 expire_date（业务方决策）

### 建议数据修复 SQL（一次性）

```sql
-- 修复 E1：删除 38 行重复 card_transactions（保留每组最早 id）
DELETE FROM card_transactions
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY card_id, type, ref_order_id ORDER BY id) AS rn
    FROM card_transactions
    WHERE (card_id, type, ref_order_id) IN (
      SELECT card_id, type, ref_order_id FROM card_transactions
      WHERE type='充值' GROUP BY card_id, type, ref_order_id HAVING COUNT(*) > 1
    )
  ) t WHERE rn > 1
);
-- 之后 balance 仍正确（migrate-prepaid-cards 写入时 EXCLUDED.balance 覆盖式 UPSERT，与 SUM(amount) 巧合相等）

-- 修复 E2：补 1 行 FY-XSD-WX-2604160002 的充值流水（业务方确认后执行）
INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
VALUES ('FY-CARD-CORRECT-' || extract(epoch from now())::bigint, 'FYGK-20260314-00001', 2500, NOW(), NOW())
ON CONFLICT (user_id) DO UPDATE SET balance = prepaid_cards.balance + 2500, updated_at = NOW()
RETURNING card_id;
INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
VALUES ((SELECT card_id FROM prepaid_cards WHERE user_id='FYGK-20260314-00001'), '充值', 2500, 'FY-XSD-WX-2604160002', '2026-04-16 05:11:25');
```

---

## 字段扩展建议 R2（2026-04-26）

R1 文档已识别 `prepaid_cards.expire_date` 列缺失（UDF_M_7122 充值卡到期日丢失）。R2 重新审视后**确认 P0 = 1（expire_date）**，并新挖出 P1 5 个 / P2 4 个候选。MSSQL 凭据失败但参考 workfine_database.md L502-528 UDT_M_213 字段表 + migrate-active-cards.js L80-119 已落到 sale_items 的列推断。

### 字段候选清单

| # | PG 应新增列 | WorkFine 源 / 推算 | 优先级 | 业务理由 |
|---|------------|-------------------|--------|---------|
| **P0.1** | `prepaid_cards.expire_date timestamp` | `UDT_M_213.UDF_M_7122`（已落到 sale_items.expire_date） | **P0** | 余额永不过期违背 WorkFine 原约束；2125 张活卡的 130 张实际已过期仍可用 |
| **P1.1** | `card_transactions.sale_item_id varchar(30) FK→sale_items` | `UDT_M_213.UDF_M_852`（已落到 sale_items.sale_item_id） | P1 | 解决 E1 幂等键粒度问题；27 组重复就是因为 (card_id, ref_order_id) 不够细 |
| **P1.2** | `prepaid_cards.card_name text` | `UDT_M_213.UDF_M_393` 第一个 sale_item 的 product_name | P1 | "2024 福利预存款 / 金卡充值卡 / 预存金" 等命名差异，UI 展示"哪张卡剩多少"必需 |
| **P1.3** | `card_transactions.is_gift boolean` | `UDT_M_213.UDF_M_4939='是'`（已落到 sale_items.is_gift） | P1 | 赠品卡 fallback 链 ②/③ balance 失真；admin 退款时需区分"现金购买可退" vs "赠品不可退" |
| **P1.4** | `prepaid_cards.face_value numeric(10,2)` | `UDT_M_213.UDF_M_395` 累加（已落到 sale_items.sale_amount） | P1 | balance 是剩余余额；面值 = 历史累计充值额（用于"已使用 ¥N / 共 ¥M"展示） |
| **P1.5** | `card_transactions.original_amount numeric(10,2)` | 派生：充值时 = sale_items.received（实付现金），扣款时 = 0 | P1 | 区分"赠品币" vs "现金币"，退款只退现金部分 |
| **P2.1** | `prepaid_cards.first_recharge_at timestamp` | 同 created_at（已隐含），但建议显式列 | P2 | 数据看板"新储值客户"指标，避免 created_at 被合并 migration 改动 |
| **P2.2** | `card_transactions.operator_employee_id text FK` | 运行时 ctx.auth.staffWfId / 历史脚本 NULL | P2 | 审计"谁帮顾客充的卡 / 谁帮扣的"，配合 operation_logs 双重审计 |
| **P2.3** | `prepaid_cards.last_used_at timestamp` | MAX(card_transactions.created_at WHERE type='扣款') | P2 | 数据看板"沉睡储值卡"指标（≥6 月未消费） |
| **P2.4** | `card_transactions.balance_after numeric(10,2)` | 派生：每行写入时的 prepaid_cards.balance 快照 | P2 | 流水审计：单行还原"扣款后余额是多少"，无需 SUM(amount) 反算 |

### P0 详细抽取脚本（migrate-prepaid-cards.js 增量改动）

```sql
-- 在 migrate-prepaid-cards.js:L84-93 fallback 链之后追加：
-- 取组内最早 sale_item 的 expire_date 作为卡有效期（一户一卡跨多 sale_item，取 MIN）
SELECT MIN(si.expire_date) AS expire_date
FROM sale_items si JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
WHERE so.client_user_id = $1 AND si.remaining_sessions > 0
  AND so.remark = 'WorkFine历史订单导入'
  AND (si.product_name LIKE '%充值%' OR si.product_name LIKE '%储值%' OR si.product_name LIKE '%预存%' OR si.product_name LIKE '%余额%')

-- 处理边界：
-- ① expire_date IS NULL → 设 NULL（永久卡，与 schema 现状对齐）
-- ② expire_date = '1899-12-31' 哨兵（16 行）→ 设 NULL（视为脏数据）
-- ③ expire_date > '2099-01-01' → 视为永久卡，设 NULL（56 行）
-- ④ expire_date < NOW() → 写入但运行时余额读取处加 expire_date > NOW() 过滤
```

### P0/P1 数据量

- P0.1 expire_date 覆盖率：3132/3132 = 100% sale_items 有该列；prepaid_cards 1763 行 100% 可派生
- P1.1 sale_item_id 加列后无 NULL 风险（每条 card_transactions 都对应唯一 sale_item_id；运行时 confirmOffline 写入时 sale_items 已 INSERT 完毕）；27 组重复改为 sale_item_id 幂等键后会自动消失
- P1.2 card_name 数据量：1763 行；命名空间 30+ 个变体（探针 9.3）
- P1.3 is_gift 数据量：sale_items.is_gift 已存在（参考 04-product / 05-service _gaps），需 backfill prepaid_cards 历史卡

### 对漏过 662 行的补救路径

R1 标的"662 行"差额（MSSQL 端 LIKE 命中 3158 行 vs PG 派生命中 2496 行）现在重新拆解：

- **3132 行**：5434 PG sale_items 命中关键字总数（探针 9.1）— 与 R1 原文 "MSSQL 端 3158" 接近但不一致（差 26 行可能是 MSSQL 端 0003 baseline reset 之后又有新增）
- **636 行**：3132 - 2496 = 命中关键字但 prepaid 派生未生成卡 — **不是 662 行**（探针 12.1 显示 0 user 漏，即关键字命中的 user 全部已建卡）。**636 行差额来自 remaining_sessions = 0**（已用完）或 balance ≤ 0 → migrate-prepaid-cards.js:L95-98 跳过零余额
- **额外 200+ 行（非 4 关键字命中）**：探针 9.7 中"充卡 (199)/充值ym (7)/微电充值 (3)"等是关键字未命中但 product_name 含"充"字 → migrate 关键字加上"`%充%`"后可命中，但需业务方确认是否会误伤"重充申请单"等非充值类

### 总评

- 字段扩展候选 10 个（P0×1 / P1×5 / P2×4）
- P0 = 1（expire_date 与 R1 一致）
- 8 维度命中：FK 0、NULL 1、enum 0、unique 1（HIGH）、跨模块 1（HIGH）、死代码 2、drift 1、运行时 1（HIGH）— **命中 6 维**
- 高危 3 项（E1 重复幂等键、E2 漏 1 行入账、E3 schema 缺 CHECK）
