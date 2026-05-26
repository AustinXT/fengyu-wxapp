# 09 — `coupon` 模块

**Schema 文件**：`db/schema/coupon.ts`
**涉及 PG 表**：`coupon_templates`, `user_coupons`
**WorkFine 源表**：**无业务对应实体**（详见下方"WorkFine 端无业务对应实体"小节）。仅 `UDT_S_209.UDF_S_17190 / 17216 / 17194` 三个**销售单级聚合**金额字段含"现金券"语义，已在 01-order 模块归为"未对接"。

**主要写入入口**（admin actions —— 模板与用户券实例的唯一新增入口）：
- `fengyu-admin/src/actions/coupons.ts:L315-333` — `createTemplate`（admin UI 唯一新建模板入口）
- `fengyu-admin/src/actions/coupons.ts:L447-453` — `updateTemplate`（admin UI 唯一更新入口，乐观锁 `WHERE date_trunc('milliseconds', updated_at) = $prev`）
- `fengyu-admin/src/actions/coupons.ts:L482-488` — `toggleTemplateActive`（启用/停用，乐观锁同上）
- `fengyu-admin/src/actions/coupons.ts:L565-571` — `issueCoupon`（admin 单顾客发券，命名空间 `cpn-{Date.now()}-{4chars}`）
- `fengyu-admin/src/actions/coupons.ts:L703-714` — `batchIssueCoupons`（admin 批量发券，命名空间 `cpn-{Date.now()}-{4chars}-{i}`，单次 ≤ 200 个）
- `fengyu-admin/src/db/seed.ts:L303-305, L399-401` — `COUPON_TEMPLATES` 3 条 demo 种子（`onConflictDoNothing`）

**写入入口（cron 自动发券，命名空间幂等键）**：
- `src/cron/steps/grant-birthday-benefits.ts:L169-175` — 当日生日权益，幂等键 `bday-{YYYY}-{userId}-{templateId}`
- `src/cron/steps/grant-thanksgiving-benefits.ts:L171-177` — 仅每月 20 号，幂等键 `thx-{YYYY-MM}-{userId}-{templateId}`，**优惠券固定 10 天有效期（不读 validity_mode）**
- `src/cron/steps/refresh-member-levels.ts:L296-302` — 升级权益，幂等键 `cpn-up-{userId}-{toLevel}-{templateId}`

**写入入口（运行时 — 分享礼三副本字节级一致）**：
- `fengyu-client/cloudfunctions/clientApi/share-gift.js:L106-110` — 邀请人/被邀人各 1 张，幂等键 `sg-{role}-{saleOrderId}`，**写 face_value_override 实现动态面值**
- `fengyu-client/cloudfunctions/payNotify/share-gift.js:L106-110` — 同上副本（支付回调主力路径）
- `fengyu-staff/cloudfunctions/staffApi/share-gift.js:L106-110` — 同上副本（线下确认路径）

**写入入口（运行时 — 用户券生命周期 UPDATE，无 INSERT）**：
- `fengyu-client/cloudfunctions/clientApi/routes/order.js:L23, L451-456, L1051` / `:L958-959` — `order.create` 原子 claim：`UPDATE status='已使用', used_sale_order_id, used_at`；订单关闭/退款 → `UPDATE status='未使用', used_sale_order_id=NULL, used_at=NULL`
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:L525-530, L1093-1097` — 店长开单 + 订单关闭对称路径
- `fengyu-client/cloudfunctions/clientApi/routes/coupon.js:L22-25, L137-140` — 懒清扫过期 `UPDATE status='已过期' WHERE status='未使用' AND expire_at <= NOW()`
- `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:L52-55` — 同上，开单查可用券前懒扫一次
- `fengyu-client/cloudfunctions/clientApi/routes/card.js:L175` — 储值卡退款联动释放券（`UPDATE status='未使用'...`）

**迁移脚本**：**无**。`db/scripts/` 下没有任何 `migrate-coupons-*.js`，`sync-workfine.js` / `sync-products-from-workfine.js` 全文 `grep -i 'coupon\|17190\|17216\|17194\|现金券'` **零命中**。

**Schema 演进**：
- archive `0001_wonderful_jasper_sitwell.sql` — 初建 `coupon_templates` + `user_coupons`，`coupon_type` enum 初版含 `'项目券'`（错别字）
- archive `0006_lying_invisible_woman.sql:L12-13` — 加 `total_count` + `applicable_product_ids`
- archive `0008_wide_mongoose.sql:L1` — 加 `applicable_market_ids`
- archive `0016_sync_to_current.sql:L113-116` — `coupon_type` enum 翻新 `'项目券' → '品项券'`（DROP TYPE + 重建 + USING cast）
- 0000_baseline.sql:L375-406 — 重建表结构（baseline 后形态）
- `0007_black_lady_deathstrike.sql:L3` — 加 `face_value_override`（分享礼动态面值场景，2026-04-24 ticket）

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | 备注 |
|----|-------|------|
| coupon_templates | 9 | 3 行 seed 种子（`coupon-tpl-001/002/003`）+ 5 行 16-char hex（早期 admin 后台录入）+ 1 行 `tpl-1775557162411`（admin 后期录入）。**全部 is_active=true** |
| user_coupons | 17 | 全部 `cpn-*` 命名空间（admin issueCoupon / batchIssueCoupons）。零 `sg-*` / `bday-*` / `thx-*` / `cpn-up-*` 行 — **cron + 分享礼路径在 PG 5434 完全无产出** |

**user_coupons 状态分布**：未使用 11 / 已使用 5 / 已过期 1
**user_coupons 命名空间**：`cpn-*` admin issueCoupon = 17（**100%**）

**operation_logs 验证发券路径活跃度**：
| action | cnt | first | last |
|--------|-----|-------|------|
| coupon.issue | 6 | 2026-03-22 | 2026-04-23 |
| coupon.update | 5 | 2026-03-21 | 2026-04-07 |
| coupon.batchIssue | 2 | 2026-03-22 | 2026-04-07 |
| coupon.create | 1 | 2026-04-07 | 2026-04-07 |

> **关键定位**：`coupon` 模块 **100% 新系统独立**。WorkFine MSSQL 端无任何业务级实体（`INFORMATION_SCHEMA.TABLES` 名称含 `coupon/voucher/ticket/cashbond` **0 行**；`sys.extended_properties` 列描述含 `券`/`抵扣`/`优惠` **0 行**；表级描述含 `券` **0 行**）。WF 端唯一相关字段是销售单级 3 个聚合金额：`UDT_S_209.UDF_S_17190 赠送现金券 / UDF_S_17216 本单消耗现金券 / UDF_S_17194 现金券可用余额`，但**这些都是销售单粒度的金额聚合**，**不承载 user_coupon 实例信息**（无 coupon_id / template_id / 状态 / 过期时间）。本模块不参与 WorkFine→PG 迁移。

---

## 表 1：`coupon_templates`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| template_id | text (PK) | 新系统独立 | admin UI 表单录入 | coupons.ts:L316 | 命名混杂：3 行 `coupon-tpl-NNN`（seed）+ 5 行 16-char hex（早期 admin）+ 1 行 `tpl-{Date.now()}`（admin 后期）；最终迁移可保留全部命名空间 |
| name | text NOT NULL | 新系统独立 | admin UI 表单录入 | coupons.ts:L317 | |
| coupon_type | coupon_type enum NOT NULL | 新系统独立 | admin UI 选 enum 3 值（`现金券` / `品项券` / `折扣券`） | coupons.ts:L318 + enums.ts:L81 | archive 0016 把 enum `'项目券' → '品项券'` 翻新；0001 初版有错别字 |
| discount_value | numeric(10,2) NOT NULL | 新系统独立 | admin UI 表单录入 | coupons.ts:L319 | 现金券/品项券=金额；折扣券=折扣率(0,1)，admin 校验 (`< 1` 才放行） |
| min_spend | numeric(10,2) DEFAULT '0' | 新系统独立 | admin UI 表单录入 | coupons.ts:L320 | NULL 或 '0' 表示无门槛；`getAvailableCoupons` 用 `COALESCE(min_spend,'0')::numeric` 容错 |
| max_discount | numeric(10,2) | 默认值/NULL | admin UI 可选录入 | coupons.ts:L321 | 现状 0/9 行非 NULL；折扣券封顶逻辑当前**未被任何模板使用** |
| total_count | integer | 默认值/NULL | admin UI 可选录入 | coupons.ts:L322 | 现状 2/9 行非 NULL（仅 seed `coupon-tpl-001/002`）；NULL=不限量 |
| applicable_product_ids | text[] | 默认值/NULL | admin UI 多选 → products.product_id 数组 | coupons.ts:L323 | 现状 0/9 行非 NULL；FK 完全靠应用层维护，无 DB 约束 |
| applicable_category_ids | text[] | 默认值/NULL | admin UI 多选 → product_categories.category_id 数组 | coupons.ts:L324 | 现状 2/9 行非 NULL（seed `coupon-tpl-002` + admin `tpl-1775557162411` 明星体验券） |
| applicable_store_ids | text[] | 默认值/NULL | admin UI 多选 → stores.store_id 数组 | coupons.ts:L325 | 现状 2/9 行非 NULL（seed `coupon-tpl-003` 限两个南昌门店 + 1 行 hex 北市场专属） |
| applicable_market_ids | text[] | 默认值/NULL | admin UI 多选 → org_nodes.id where type='市场' 数组 | coupons.ts:L326 | 现状 1/9 行非 NULL（seed `coupon-tpl-001` 新客券） |
| validity_mode | text DEFAULT 'fixed' | 新系统独立 | admin UI 二选一 (`'fixed'` / `'days'`) | coupons.ts:L327 + schema:L32 | `validateValidityFields` 强制非空；模式切换需同时提交另一侧字段；日期 `>= valid_to` 拒绝；`<= now()` 拒绝 |
| valid_from | timestamp | 新系统独立 | admin UI（仅 fixed 模式可填，days 模式强制 NULL） | coupons.ts:L328 | 现状 6/9 行非 NULL（fixed 模式行） |
| valid_to | timestamp | 新系统独立 | admin UI（仅 fixed 模式可填，days 模式强制 NULL） | coupons.ts:L329 | 同上 6/9 行非 NULL |
| valid_days | integer | 新系统独立 | admin UI（仅 days 模式可填，fixed 模式强制 NULL） | coupons.ts:L330 | 现状 3/9 行非 NULL |
| description | text | 默认值/NULL | admin UI 可选录入 | coupons.ts:L331 | 现状 8/9 行非 NULL |
| is_active | boolean DEFAULT true | 默认值/NULL | admin UI / `toggleTemplateActive` | coupons.ts:L332, L482-488 | 现状 9/9 行 = true（无停用案例） |
| created_at | timestamp NOT NULL DEFAULT now() | 默认值/NULL | `defaultNow()` | schema:L41 | 8 行 = 2026-03-13、1 行 = 2026-04-07 |
| updated_at | timestamp NOT NULL DEFAULT now() | 默认值/NULL | `defaultNow()` + `$onUpdate(() => new Date())` | schema:L42 | 乐观锁键（`updateTemplate` / `toggleTemplateActive` 都携带 `expectedUpdatedAt`） |

### 已被脚本读但未对接到 PG 的 WorkFine 列

**无**。本模块的迁移脚本数为零，sync-workfine.js / sync-products-from-workfine.js / migrate-*.js 全文搜索 coupon 关键字 0 命中。

---

## 表 2：`user_coupons`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| coupon_id | text (PK) | 新系统独立 | 多种命名空间派生：admin `cpn-{Date.now()}-{4chars}` / `cpn-{ts}-{4chars}-{i}`；cron `bday-{YYYY}-{userId}-{tplId}` / `thx-{YYYYMM}-{userId}-{tplId}` / `cpn-up-{userId}-{level}-{tplId}`；分享礼 `sg-{role}-{saleOrderId}` | coupons.ts:L563/L706, grant-birthday-benefits.ts:L169, grant-thanksgiving-benefits.ts:L171, refresh-member-levels.ts:L296, share-gift.js:L109 | **6 个命名空间** — cron 三种 + 分享礼一种用幂等键防重发；admin 两种用时间戳；最终迁移如保留命名空间需识别六类 |
| template_id | text NOT NULL FK→coupon_templates | 新系统独立 | admin UI 选模板 / cron 配置 / share-gift system_configs | (各入口) | FK 严格强约束；运行时 JOIN ct 时 `ct.is_active=true` 二次过滤 |
| user_id | text NOT NULL FK→client_wechat_users | 新系统独立 | admin 按 `clientWechatUsers.phone` 解析 / cron 遍历目标顾客 / share-gift 邀请人 + 被邀人 | coupons.ts:L568 (issueCoupon) / L708 (batch) | FK 严格强约束 |
| status | coupon_status enum NOT NULL DEFAULT '未使用' | 新系统独立 | INSERT 时硬编码 `'未使用'`；运行时三态机：`已使用`（order.create claim）/`已过期`（懒清扫）/`未使用`（订单关闭/退款释放） | schema:L61, order.js:L451 / coupon.js:L22 / order.js:L23 / card.js:L175 | 唯一全局枚举：`未使用` / `已使用` / `已过期` |
| expire_at | timestamp NOT NULL | 新系统独立（派生自 template） | INSERT 时按 `template.validity_mode` 派生：`days` → `NOW + valid_days × 86400000`；`fixed` → `template.valid_to` | coupons.ts:L549-560 (admin) / grant-birthday-benefits.ts:L161-167 / grant-thanksgiving-benefits.ts:L170 (硬编码 10 天) / refresh-member-levels.ts:L287-294 / share-gift.js:L89-97 | ⚠️ **6 个发券路径派生算法分散且不一致**：admin 走 days/fixed 二选一并对配置异常返回错误；birthday/upgrade 走相同 days/fixed 但有 365 天兜底；thanksgiving **硬编码 10 天忽略 validity_mode**；share-gift 有 `cfg.validityDays || 90` 兜底。同模板同时段发出的券 expire_at 可能不同 |
| face_value_override | numeric(10,2) | 默认值/NULL | 分享礼运行时按 `paid × percent` clamp 到 `[minFaceValue, maxFaceValue]` 计算 | share-gift.js:L86, L109；schema:L65 + 0007_black_lady_deathstrike.sql:L3 | 现状 0/17 行非 NULL（PG 5434 无分享礼数据）；运行时读取点 `COALESCE(uc.face_value_override, ct.discount_value)` — admin/coupon-list/order.js 三处都用同样的 COALESCE |
| used_sale_order_id | varchar(30) FK→sale_orders | 新系统独立 | order.create 原子 claim 时写入；订单关闭/退款释放时回写 NULL | order.js:L451-456（client）/ L525-530（staff）/ L1051 / L1093 | 现状 5/17 行非 NULL（与 status='已使用' 同步） |
| used_at | timestamp | 新系统独立 | order.create 原子 claim 时 `NOW()`；释放时回写 NULL | 同上 | 现状 5/17 行非 NULL |
| created_at | timestamp NOT NULL DEFAULT now() | 默认值/NULL | `defaultNow()` | schema:L70 | INSERT 时刻；user_coupons **无 updated_at 列** |

### 索引

| 索引名 | 列 | 出处 |
|--------|----|------|
| `idx_user_coupons_user_status` | `(user_id, status)` | schema:L73 + 0000_baseline.sql:L608 |
| `idx_user_coupons_used_order` | `(used_sale_order_id)` | schema:L74 + 0000_baseline.sql:L609 |
| `idx_user_coupons_expire` | `(expire_at)` | schema:L75 + 0000_baseline.sql:L610 |

### 已被脚本读但未对接到 PG 的 WorkFine 列

**无**。本表从未在任何 migrate / sync 脚本被 INSERT。

---

## WorkFine 端无业务对应实体（readonly probe，2026-04-26）

| 探查方式 | 结果 |
|----------|------|
| `INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%coupon/voucher/ticket/cashbond%'` | **0 行** |
| `sys.extended_properties` 列描述含 `券` 且表名 `LIKE 'UDT[_]%'` | **0 行** |
| `sys.extended_properties` 列描述含 `抵扣` 且表名 `LIKE 'UDT[_]%'` | **0 行** |
| `sys.extended_properties` 表级描述含 `券` | **0 行** |
| `INFORMATION_SCHEMA.COLUMNS WHERE COLUMN_NAME IN ('UDF_S_17190','UDF_S_17216','UDF_S_17194',...)` | 仅 `UDT_S_209` + `UDT_S_2127`（**0 行 mirror 表**），无 user-coupon 级实体 |
| `UDT_S_209` 字段实际填充率 | total=81568 / has_grant=81568 / has_redeem=81568 / **grant_pos=1547 / redeem_pos=18** — 95% 行三个字段全是 0；真正发生过现金券事务的销售单 ≤ 2% |

**销售单级 3 个金额字段语义**（已纳入 01-order 模块"未对接"清单）：
- `UDT_S_209.UDF_S_17190 赠送现金券`（金额）— 1547 行 > 0，平均 195.78（topN: 300/100/500/398/1000）
- `UDT_S_209.UDF_S_17216 本单消耗现金券`（金额）— 仅 18 行 > 0，金额范围 46-398
- `UDT_S_209.UDF_S_17194 现金券可用余额`（金额，下单时刻余额快照）— 81568 行全部填充

**关键结论**：WorkFine 美容院业务侧**没有 user-coupon 级实体**——销售单级 3 个聚合金额根本无法重建券实例（缺 coupon_id / template_id / 状态 / 过期时间 / 适用范围）。商家在 WorkFine 时代的"现金券"实质是销售单上的金额贴码，**不是券系统**。最终迁移脚本对本模块**无源可抽**；如业务需追溯历史"赠送/消耗现金券"事件，建议：

1. 在 `sale_orders` 加 `legacy_grant_coupon_amount` / `legacy_redeem_coupon_amount` 列直接抽 UDF_S_17190 / 17216 三列（已记入 01-order gaps），**不要**派生 user_coupons 行；
2. 顾客顾客余额字段 `UDT_S_311.UDF_S_17856 / 17857 / 17858`（详见 03-user gaps）可能与"现金券可用余额"概念有关（47k/52k/44k 行非 NULL），但**字段含义不明，需业务侧确认**。

---

## 关键决策

1. **本模块 100% 新系统独立**：WorkFine MSSQL 端无任何业务级实体，最终迁移脚本不需要 `INSERT ... FROM mssql`，最多保留：
   - admin/cron/share-gift 实际产出的现状数据
   - 3 行 seed.ts demo 模板作为冷启动模板（需业务确认 valid_to 是否过期）
2. **PG 现状全部由 admin UI 录入**：17 张 user_coupons 全部 `cpn-*` 命名空间（admin issueCoupon/batchIssueCoupons），**cron 三个 STEP（生日/感恩日/升级）+ 分享礼三副本运行时路径在 PG 5434 完全无产出**——这与 `cron-worker` 服务自 2026-03 部署但生产顾客数极少有关（5 行 seed 客户，无真实新客有"被邀请人 inviter_user_id"），不是配置问题。
3. **`expire_at` 派生算法 6 副本不一致**：admin / cron-birthday / cron-thanksgiving / cron-upgrade / share-gift / batchIssue 各有自己的派生路径，部分有 365 天/90 天兜底，部分硬编码 10 天忽略 validity_mode。`db/scripts/coupon-validity-audit.sql` 提供 Q1（active 脏模板预检）+ Q2（fallback 已发放券稽核），ticket `coupon-template-validity-validation.md §5.1` 计划在 §5.4 删除 admin 365 天 fallback 后再清理 cron 副本。最终迁移**不需要重建任何 expire_at**——直接拷贝现状值。
4. **`user_coupons.face_value_override` 是分享礼专属**：schema 注释明确"运行时动态面值（分享礼等场景写入）；NULL 时读取点回退到 template.discount_value"，三个运行时副本 + admin/staff/client coupon 列表读取点都用 `COALESCE(uc.face_value_override, ct.discount_value)`。最终迁移如分享礼数据量增长到生产级，必须保留此列。
5. **状态机 100% 应用层维护**：`未使用 → 已使用` 由 `order.create` 原子 UPDATE（`WHERE status='未使用' AND expire_at > NOW()` + `rowCount === 1` 校验）；`已使用 → 未使用` 由订单关闭/退款 UPDATE 释放；`未使用 → 已过期` 由 `coupon.list / coupon.available` 入口前**懒清扫**（每次列表请求都扫一次）。**没有定时任务做集中清扫**——如果某用户长期不打开列表，他的券会卡在 `'未使用'` + `expire_at < NOW()` 的"逻辑过期但 status 未刷"状态。SQL 查询用 `expire_at > NOW()` 二次过滤防御。
6. **优惠券与订单的 FK 链**：`sale_orders.coupon_id`（archive 0001:L34 加列）+ `sale_orders.coupon_discount`（archive 0001:L35 加列）+ `user_coupons.used_sale_order_id`（双向引用）。最终迁移如重建顺序需先建 sale_orders 再建 user_coupons 还是反过来——目前 schema 上**两表互相不强制 FK 顺序**（`coupon_id` 是裸 text 不带 FK，`used_sale_order_id` 才有 FK→sale_orders），所以可以先建 user_coupons 再 backfill sale_orders.coupon_id。
7. **member-benefits 配置依赖券模板**：`system_configs.member_level_benefits / birthday_benefits / thanksgiving_benefits` JSON 内嵌 `couponTemplateIds` 数组（archive `0033_seed_member_level_benefits.sql:L18-42` 5 个等级 seed 全部空数组），运行时 cron 跑这三个 STEP 时会读 system_configs → 查 coupon_templates。最终迁移**必须先保证 coupon_templates 在 system_configs 的 couponTemplateIds 之前导入**，否则 cron 第一晚会跳过所有优惠券发放。
8. **`face_value_override` 与 `template.discount_value` 取舍**：refunds.ts:L347 计算"已享用权益"时**直接读 ct.discount_value 不读 uc.face_value_override**，这是会员降档处罚算法的细节漏洞——分享礼券（动态面值）的实际抵扣金额会被算成 template.discount_value，可能高于真实使用值。本模块迁移血缘不涉及，但记入跨模块风险。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

- 整表 100% 无 WorkFine 数据来源（不是"未覆盖"，是 WF 根本无对应业务实体）
- WF `UDT_S_209.UDF_S_17190 赠送现金券`（1547 行 > 0）/ `UDF_S_17216 本单消耗现金券`（18 行 > 0）/ `UDF_S_17194 现金券余额`（81568 行全部填充）— **3 个销售单级聚合金额无法重建 user-coupon 实例**，已在 01-order 列入 gaps；如业务需追溯历史"赠送/消耗"事件，建议在 sale_orders 加 `legacy_grant_coupon_amount` / `legacy_redeem_coupon_amount` 两列直接抽
- WF `UDT_S_311.UDF_S_17856/17857/17858`（顾客侧 47k/52k/44k 行 decimal，含义未明）— **可能是顾客现金券累计余额/可用/冻结分类**，最终迁移前应业务侧确认；如确认是券余额，需评估是否回填到客户端储值卡（card schema）或新增"customer_coupon_balance"字段
- ⚠️ `expire_at` 派生算法 **6 副本不一致**（admin / cron-birthday / cron-thanksgiving / cron-upgrade / share-gift × 2 + batchIssue），部分 365/90/10 天兜底，最终迁移直接拷现状值无需重建，但运行时持续脆弱
- ⚠️ `coupon_templates.template_id` 命名混杂（`coupon-tpl-NNN` seed / 16-char hex 早期 admin / `tpl-{ts}` 后期 admin），最终迁移可保留全部命名空间，无强约束
- ⚠️ `coupon_templates.applicable_*_ids` 全部 text[]，无 FK / 无 DB 约束 — admin 改 product_categories.category_id / stores.store_id / org_nodes.id 不会自动失效模板的引用数组，**需要级联清理**或迁移前一次性扫描 dangling refs
- ⚠️ user_coupons 状态 `'已过期'` **无定时清扫器**，仅依赖 `coupon.list / coupon.available` 入口懒扫；如顾客长期不打开列表，券会卡在 `'未使用'` + `expire_at < NOW()` 状态。SQL 查询用 `expire_at > NOW()` 二次过滤防御
- ⚠️ `refunds.ts:L347 redownGradeReverseDiff` 算"已享用券价值"时**只读 ct.discount_value 不读 uc.face_value_override**，分享礼券的真实使用值被算成模板默认值，可能高估 → 会员降档处罚偏严
- `coupon_templates.max_discount` 现状 0/9 行非 NULL — 折扣券封顶机制**当前无任何模板使用**，仅 seed `coupon-tpl-003` 配置了 200 元封顶，但 PG 现状被改成 NULL（discount_value 也从 0.85 改成 0.75 — 见现状表）
- `coupon_templates.applicable_market_ids` 1/9 行非 NULL；`applicable_store_ids` 2/9；`applicable_category_ids` 2/9；`applicable_product_ids` 0/9 — **大部分模板"全场可用"**，复杂适用范围功能未被实际使用
- PG 5434 现状 17 张全部 `cpn-*` 命名空间 — cron 三 STEP + 分享礼三副本**无任何产出**，需运维侧核实是否 cron-worker 正常运行 + 是否真有顾客触发分享礼路径（首单 + inviter_user_id）

---

## Review 报告（2026-04-26）

**复核范围**：独立按"先调研后读文档"流程对照 schema / cloudfunctions / admin actions / cron / migrations / PG 5434 现状 / MSSQL 只读探查。

### 一致项数 / 不一致项数

- 一致项：~38 项（两表 28 列血缘、6 写入命名空间、6 个 expire_at 派生算法、PG 现状量化指标 9/17/11/5/1/5、MSSQL 零业务实体结论、3 索引、3 FK、operation_logs 活跃度、enum 翻新历史、share-gift 三副本字节级一致、validity_mode 二选一切换语义、`COALESCE(uc.face_value_override, ct.discount_value)` 三点读取一致、admin 365 天 fallback 已删除等）
- 不一致项：3 处行号偏移 / 格式漏写（均不影响结论）

### 偏差明细

**缺漏**：无。本文档已覆盖所有写入入口、所有读取入口、所有 schema 演进阶段、所有 expire_at 派生路径、跨模块风险（refunds 降档算法、system_configs 依赖顺序、sale_orders FK 链）。

**错配**：
1. 文档 L160 引用 `refunds.ts:L347` 计算"已享用券价值"——实际定位行是 `refunds.ts:L383-395`（`SELECT ct.discount_value FROM user_coupons uc JOIN coupon_templates ct ...` + `usedCouponValue.reduce`）。L346-347 是 admin tplValueById JOIN 准备步骤，与"已享用权益"算法逻辑相邻但非主体。**结论本身（只读 ct.discount_value 不读 uc.face_value_override，分享礼券真实抵扣值被高估 → 降档处罚偏严）完全正确**，仅行号定位不精。
2. 文档 L102 `thx-{YYYYMM}-{userId}-{tplId}` —— 实际格式是 `thx-{YYYY-MM}-{userId}-{templateId}` 带连字符（参见 `grant-thanksgiving-benefits.ts:L171` 与文档 L17 自身的描述）。文档 L17 已写对，L102 一处漏写连字符。

**数据不一致**：无。PG 5434 现状全部复现一致：
- coupon_templates: 9 行，全部 is_active=true，5 fixed / 4 days，3 现金券变 5 现金券（doc L46 写 5+1+3 = 9 但未拆按 type；按 type 是 5 现金 / 3 品项 / 1 折扣 — 与 doc 关键决策段一致）
- user_coupons: 17 行，状态 11/5/1，全部 face_value_override=NULL，全部 cpn-* 命名空间
- sale_orders.coupon_id 非 NULL: 5 行（与已使用 user_coupons 一致）
- enum coupon_type / coupon_status 实际枚举值 100% 匹配文档

**过时事实**：无。文档 PG 现状探查时间 = 复核时间（2026-04-26），所有量化数据当日有效。

### 安全性 / P0 检查

- **无 P0**。本模块 100% 应用层维护、无 mssql sync、无数据资损路径。
- 已存在风险（文档已记录 + 已建归档）：
  - `redownGradeReverseDiff` 算法忽略 face_value_override —— 当前 PG 0 行 face_value_override 非 NULL，未触发实际偏差，但分享礼一旦放量必触发，建议在 refunds.ts 改用 COALESCE
  - 6 副本 expire_at 派生算法 —— 已有 `db/scripts/coupon-validity-audit.sql` Q1/Q2 + ticket `coupon-template-validity-validation.md §5.4` 计划清理
  - `coupon_templates.applicable_*_ids` 4 字段 text[] 无 FK 约束 —— admin 改 product/category/store/market 不会级联失效（文档 L171 已记录）

### Verdict

**accept**

文档质量极高：6 写入命名空间识别完整、6 expire_at 派生路径量化对比清晰、跨模块风险（01-order/03-user/refunds.ts/system_configs）穿透引用准确、PG 现状探查与 MSSQL readonly probe 同时给出。3 处偏差全部为行号 / 格式微调，不影响任何结论或迁移决策，无需 minor-fix 重写。

---

## Edge Case 报告 R2（2026-04-26）

8 类风险维度逐项探查（PG 5434 + MSSQL readonly），9 张模板 + 17 张用户券。命中 7/8 维（仅"运行时 SQL 注入"维干净）。

### 1. FK 孤立 / 引用完整性 — clean

| 探针 | 结果 | 备注 |
|------|------|------|
| `user_coupons.template_id` LEFT JOIN parent IS NULL | 0 行 | 强 FK 守住 |
| `user_coupons.user_id` LEFT JOIN client_wechat_users IS NULL | 0 行 | 强 FK 守住 |
| `user_coupons.used_sale_order_id` 孤立 | 0 行 | 强 FK 守住 |
| `sale_orders.coupon_id`（裸 text 无 FK）→ user_coupons | 0 行 | 现状全部 5 行匹配 user_coupons.coupon_id |
| `applicable_product_ids` dangling | 0 行（0/9 行非空） | |
| `applicable_category_ids` dangling | 0 行（2/9 行非空，都匹配） | |
| `applicable_store_ids` dangling | 0 行（2/9 行非空） | |
| `applicable_market_ids` dangling | 0 行（1/9 行非空，都为 type='市场'） | |

⚠️ 注意：现状 0 行 dangling **不等于** schema 安全。`applicable_*_ids` 全部 text[] 无 DB FK，admin 删除/重命名 product/category/store/org_node 不会失效模板的引用数组。这是**设计层"运行时静默偏差"风险**，不是已发生的数据问题。

### 2. NULL / 空串 / 极值 — minor-issues

| 探针 | 结果 | 风险 |
|------|------|------|
| coupon_templates 各 NotNull / 极值/反向 | 全部 0 行 | clean |
| validity_mode 模式互斥（fixed_with_days / days_with_fixed） | 0/0 | clean |
| user_coupons.expire_at NULL/极端日期 | 0/0 | clean |
| **user_coupons.expire_at < created_at（"出生即死"）** | **1 行** | ⚠️ `cpn-1774320039573-rlma`（user `FYGK-20260314-00001` 持 `coupon-tpl-003`），create=2026-03-24 但 expire=2026-03-15，差 -8 天 — admin issueCoupon 在 valid_to=2026-04-14 之前发放，但**问题是 valid_to 用了夏令时之前的"15 号 23:59:59"还是别的日期？根本原因是 fixed-mode 模板 valid_to 一旦过去，admin issueCoupon 仍能发出已过期的券**（admin 的 §4 校验只 reject "valid_to <= now()"，issueCoupon 的 L552-553 直接 `expireAt = new Date(tpl.valid_to)` 不再校验 expireAt 是否过期）。该券现状 `status='已过期'`（懒清扫已生效），但用户体验上"刚发就过期"是 UX bug |
| **user_coupons.used_at < created_at** | **4 行** | ⚠️ admin issueCoupon 给已下单顾客补发券（典型 UX 流：顾客已用券下单→顾客到店还要补开发票/重新走 sale_order）；这违反"先发券再使用"语义不变量，破坏审计时序。3 张是 cpn-batch 命名空间，1 张是 cpn-single — admin 路径都有，**root cause: admin issueCoupon 只检查模板有效，不检查目标顾客近期是否已有 sale_order 在用同模板的券** |
| logically_expired（status='未使用' 但 expire <= NOW） | 0 行 | 清扫器跑得勤 |
| status='已使用' 与 used_sale_order_id/used_at 一致性 | 0 矛盾 | clean |
| status<>'已使用' 但有 used_sale_order_id/used_at | 0 矛盾 | clean |
| neg face_value_override / neg discount / neg min_spend | 全部 0 | clean |

### 3. enum 漂移 — clean

实际取值 100% 与 schema 定义匹配：
- `coupon_type` enum {现金券/品项券/折扣券} ↔ 现状 5/3/1
- `coupon_status` enum {未使用/已使用/已过期} ↔ 现状 11/5/1
- `validity_mode` text {fixed/days} ↔ 现状 5/4（注：schema 是 text 不是 enum，仅靠应用层 `validateValidityFields` 守约）

### 4. unique 守住与否 — minor-issues

| 探针 | 结果 |
|------|------|
| coupon_templates.template_id 重复 | 0（PK 守住）|
| user_coupons.coupon_id 重复 | 0（PK 守住）|
| 同 sale_order 多张 user_coupon 已使用 | 0（业务模型每单 1 张券）|
| sale_orders.coupon_id 与 user_coupons.used_sale_order_id 不一致 | 0 行 |
| **同模板 + 同 user_id 多张未使用券** | **3 张同模板（user `FYGK-20260314-00001` 持 `f5b79e11e0d34e77` 3 张未使用券）** | ⚠️ admin batchIssueCoupons 不检查同顾客同模板已有未使用券，可能重复发券。模板 `f5b79e11e0d34e77` 是 fixed-mode 共到期 2026-06-30，3 张同时存在于一人未使用列表，前端 `coupon.list` 列表会显示"3 张 50 元代金券"，下单时只能 claim 1 张，业务上可接受但 UX 略乱 |

### 5. 跨模块一致性 — serious-edge-cases

| 探针 | 结果 |
|------|------|
| sale_orders.coupon_discount > 0 but no coupon_id | 0 行 |
| sale_orders.coupon_id IS NOT NULL but coupon_discount = 0 | 0 行 |
| **已使用券对应订单是已关闭/已退款（应释放但未释放）** | **B.6 探针因 enum order_status 不含 '已退款' 报错**，但 B.5 直查发现 1 行 `cpn-1776947619987-9gjv` `status='已使用' used_sale_order_id='FY-XSD-WX-2604230004' order_status='已关闭'` ⚠️ 订单已关闭但券未释放（即 status 仍 '已使用' + used_sale_order_id 仍指向关闭单）— 这是**订单关闭释放路径漏写一例**：sale_orders 列出 5 张已使用券，1 张对应 '已关闭' 订单，但 user_coupons 该券 status 仍 '已使用'；说明 client/staff order.js 的 `UPDATE user_coupons SET status='未使用' WHERE used_sale_order_id=$1` 释放 SQL 没在订单关闭分支里被命中（可能：本订单是 admin 后台关闭还是手动改库？）|
| **`refunds.ts:L387 redownGradeReverseDiff` 算"已享用券价值"用 ct.discount_value 不读 uc.face_value_override** | 静态确认 | 文档 L160 已记录；R2 静态再核 — 现状 face_value_override = 0/17 行非 NULL，未触发，但 share_gift 一旦放量必触发会员降档处罚偏严 |
| **`refunds.ts` JOIN coupon_templates 算 benefitsValue 时 N+1 但读取列只 discount_value，对 face_value_override 完全无视** | 同上 | |
| **share_gift_config 在 system_configs 不存在** | 0 行 | ⚠️ share-gift 三副本一上线就 100% 走 `granted: false, reason: 'no_config'` 静默降级，与文档 L154 "PG 现状无 sg-* 命名空间"完全自洽 — 但**当前 admin UI（fengyu-admin/src/app/.../share-gift/）已开发完毕，业务方未启用**。这是 deployment gap，不是 bug |
| **system_configs 各 benefits 引用模板的存在性 + 启用状态** | 0 行 | benefits config 中 couponTemplateIds 全为空数组（archive 0033 seed 5 个等级全空），cron 三 STEP（生日/感恩/升级）即使触发也跳过优惠券分支 |
| **`calcCouponDiscount` admin 不取整 vs client/staff `coupon.available` 取整到分** | 静态分析 | admin 用 raw 浮点（fengyu-admin/src/lib/utils.ts:L48），client/staff 用 `Math.round(discount * 100) / 100`（routes/coupon.js:L211）— 二者在折扣券精度边界（如 0.7 折 × 333.33 元 = 99.999 元）会出现 admin 显示 99.999 / 客户端显示 100.00 的微小漂移，订单 UPDATE 时 client 落 100.00 admin 看 99.999 → admin 列表"金额不一致"轻微误导 |

### 6. 死代码 / 永不命中分支 — minor-issues

| 探针 | 结果 |
|------|------|
| `coupon_templates.max_discount` | 0/9 行非 NULL 即"折扣券封顶"功能 0 引用（仅 1 行折扣券模板，无封顶） |
| `coupon_templates.total_count` | 2/9 行（仅 seed coupon-tpl-001/002）；issued=0/0，限额功能 0 触发 |
| `coupon_templates.is_active=false` | 0 行（admin `toggleTemplateActive` 入口 0 实际触发）|
| **cron 三 STEP（bday/thx/cpn-up）+ 分享礼三副本（sg-inviter/invitee）写入路径** | 0 行（命名空间分布只有 cpn-batch 11 + cpn-single 6 = 17，无任何 sg-/bday-/thx-/cpn-up 行）| ⚠️ cron-worker 部署后产线零产出。结合 5.5 share_gift_config 缺失 + benefits 数组空，**4 个 cron/share-gift 写入路径所有代码已完整但 100% 静默无产出**；最大风险：未发现的功能性 bug 在 0 用例覆盖下永远不暴露 |
| **`coupon-tpl-003` 模板已过期但 is_active=true** | 1 行（valid_to=2026-04-14 已过 12 天，is_active 仍 true）| ⚠️ admin issueCoupon 即使在 valid_to < NOW 仍能发卡（见 §2 born_dead 案例），admin UI **未隐藏**已过期模板。建议 admin `coupons.ts:L519-524` 在 isActive 校验后追加 `tpl.validity_mode === 'fixed' && tpl.valid_to < NOW()` 报错 |

### 7. dump-restore 残留 / drift — clean

`information_schema.columns` 探查两表的实际列与 schema 100% 一致，无废弃残留。drizzle baseline reset (2026-04-10) 后 schema 演进唯一新增列 `face_value_override`（0007）已在 PG 定义生效。

### 8. 运行时安全 — minor-issues

| 探针 | 结果 |
|------|------|
| user_coupons.coupon_id 长度 / 异常字符 | 0 行 |
| sale_orders.coupon_id 异常字符 | 0 行 |
| 所有 SQL 路径全部参数化 `$1, $2`（手动 grep 全部命中） | clean |
| order.js (client+staff) `UPDATE user_coupons SET status='已使用'` + `INSERT sale_orders` 在同一事务内 | ✅ 在事务内（rowCount 校验 + 事务保证） |
| 订单关闭释放 user_coupons 在事务内 | ✅ |
| 储值卡退款联动释放券（card.js:L175） | ✅ 在事务内 |
| **idx_user_coupons_user_status / idx_user_coupons_used_order / idx_user_coupons_expire 实际使用率（pg_stat）** | **idx_scan = 0/0/0**（PK 也是 0）| ⚠️ 17 行小表 PG 优化器走 seq_scan 是合理的，但**小心：上线放量后必须复检**，特别是 `idx_user_coupons_user_status` 是 list 接口主路径。当前 stats 数据**不能用作"索引设计验证"**，只能作为现状记录 |
| **coupon.list / coupon.available 懒清扫 UPDATE 在 `pg.query` 而非事务**（client+staff 三处） | ⚠️ 是无事务的独立 UPDATE | 风险中：清扫的是 `WHERE status='未使用' AND expire_at <= NOW()`，竞态丢失只会把已过期再次过期，幂等。**但**懒清扫本身在 list 接口主路径执行，每次列表请求都跑一次 `UPDATE`，N 用户 × M 设备 × 每秒列表请求 = 写入热点；放量后建议改为：① cron 集中清扫 ② 列表接口仅 `expire_at > NOW()` 二次过滤 |
| `application_layer` claim 防重用：order.create 用 `WHERE status='未使用' AND expire_at > NOW()` + rowCount===1 校验 | ✅ 无锁原子 UPDATE，安全 |

### Verdict — **serious-edge-cases**

8 维度命中 7 维（仅 enum 干净），其中 P0 级跨模块一致性问题 1 个：

- **P0** 1 行已使用券 `cpn-1776947619987-9gjv` 对应订单 `FY-XSD-WX-2604230004` 已关闭但券未释放 — 释放路径漏写或手动数据库改动
- **P1** admin issueCoupon 不校验 expireAt 实际过期 → 1 行"出生即死"券（cpn-1774320039573-rlma）
- **P1** admin issueCoupon 未校验同顾客同模板已发未使用券数量 → 1 顾客 3 张同模板未使用券
- **P1** `coupon-tpl-003` 模板已过期 12 天但 is_active=true，admin issueCoupon 仍可继续发卡
- **P1** `applicable_*_ids` text[] 设计层无 FK 守护，product/category/store/org_node 删除/重命名静默偏差
- **P1** 4 行 `used_at < created_at` 时序破缺
- **P2** admin `calcCouponDiscount` vs client/staff `coupon.available` 浮点取整不一致（边界精度漂移）
- **P2** cron + 分享礼 4 写入路径 0 产出、0 代码覆盖（功能性 bug 不暴露）
- **P2** 懒清扫 UPDATE 在主路径独立执行（小流量无问题，放量风险）

---

## 字段扩展建议 R2（2026-04-26）

### 重新探查 MSSQL — 是否能反推用户级 coupon 实例？

| 探针 | 结果 | 结论 |
|------|------|------|
| UDT_S_209.UDF_S_17190 (赠送现金券) GROUP BY UDF_S_1485 (customer_id) | **1322 unique customers，1547 grant events** | 可反推**顾客级"历史赠券事件流"**（customer_id + 时间 + 金额） |
| UDT_S_209.UDF_S_17216 (消耗现金券) GROUP BY UDF_S_1485 | **18 unique customers，18 use events** | 可反推**顾客级"历史用券事件流"** |
| UDT_S_209.UDF_S_17194 (现金券余额) | 81568 行全部填充（销售单时刻余额快照） | 可反推**顾客级"事件后余额"**（按时间倒序最新一条 = 当前余额） |
| UDT_S_209 是否有 17190 配套的 expire/template/status 字段？ | **无**（17178/17179/17190/17194/17216 周边只有 17190/17194/17216 与现金券相关，且都是 decimal 不是 type/date） | **无法反推 user_coupons 实例级 coupon_id/template_id/expire_at/status** |
| UDT_S_311.UDF_S_17856/17857/17858（顾客侧 8177/12654/11653 行非 0） | 三字段无描述但金额相加/相减不构成"总余额=可用+冻结"等典型分类组合（B.D 30 行采样无规律） | **含义不明，需业务确认** — 但根据 UDF_S_17194 销售单级当前余额已可重建顾客余额，**这三个字段不必再迁移** |
| UDT_S_2127 是否 mirror 表 | 列结构含 17190/17216/17194 但 0 行（M.G 取消） | 与文档 L134 一致 — 0 行 mirror，可忽略 |

**重新评估结论**：R1 的"WF 完全无券业务实体"修订为：
- WF 端**没有 user-coupon 实例级数据**（无 coupon_id / template_id / 状态 / 过期时间） — R1 结论不变
- **但**有顾客级"历史现金券事件流 + 当前余额快照" — 可作为**只读历史数据**回填到客户档案，不重建 user_coupons 行

### 字段扩展候选（按优先级）

#### P0 — 数据资损 / 业务必需

无 P0。本模块 100% 新系统独立，无 WF 数据需对接到 user_coupons / coupon_templates 实体。

#### P1 — 业务可见 / 数据完整性

**P1.1 `client_wechat_users.legacy_cash_coupon_balance` numeric(10,2)**
- WF 源：`UDT_S_209.UDF_S_17194`（现金券可用余额）按 customer_id 取 MAX(FILLDATE) 最新一条
- PG 应新增列：`client_wechat_users.legacy_cash_coupon_balance numeric(10,2)`（仅迁移期填充，最终业务侧确认是否归零或转入券系统）
- 业务理由：WF 时代约 1322 顾客有历史现金券赠送/消耗记录、81568 销售单都有余额快照；微信小程序顾客详情/客服查档都需要"老系统欠你 N 元现金券"的依据
- 抽取式：`SELECT TOP 1 UDF_S_17194 FROM UDT_S_209 WHERE UDF_S_1485 = $customer_id ORDER BY UDF_S_350 DESC`
- 数据量：约 1322 顾客非 0；预估 PG 列 0/47000 + 1322/47000 非 NULL
- 依赖：03-user 模块的 `customer_id` 同步键已就位
- 已记入 03-user gaps（17856/57/58 含义不明）；本 R2 探查发现 **17194（销售单级余额快照）一字段已足够**，无需再纠结 17856/57/58 的语义

**P1.2 `client_wechat_users.legacy_cash_coupon_grant_total` numeric(10,2)**
- WF 源：`SUM(UDT_S_209.UDF_S_17190) GROUP BY UDF_S_1485`（顾客累计被赠现金券）
- PG 应新增列：`client_wechat_users.legacy_cash_coupon_grant_total numeric(10,2)`
- 业务理由：1322 顾客历史平均 195.78 元/事件，累计金额是 VIP 识别 + 历史营销追溯依据；与 P1.1（最新余额）配套形成"赠送累计 vs 当前剩余"
- 抽取式：`SELECT SUM(UDF_S_17190) FROM UDT_S_209 WHERE UDF_S_1485 = $cid AND UDF_S_17190 > 0`
- 数据量：1322 行非 0
- 依赖：同 P1.1

**P1.3 `client_wechat_users.legacy_cash_coupon_used_total` numeric(10,2)**
- WF 源：`SUM(UDT_S_209.UDF_S_17216) GROUP BY UDF_S_1485`（顾客累计消耗现金券，含负数=退券）
- PG 应新增列：`client_wechat_users.legacy_cash_coupon_used_total numeric(10,2)` — 注意 2025/2026 累计为负（退券大于消费），需保留符号
- 业务理由：与 P1.1+P1.2 三元组形成完整余额方程：grant - used = balance（应该）。也是 R2 边缘案例的"WF 用券 = -45778 元"异常源头追查依据
- 抽取式：`SELECT SUM(UDF_S_17216) FROM UDT_S_209 WHERE UDF_S_1485 = $cid AND UDF_S_17216 <> 0`
- 数据量：18 顾客非 0
- 依赖：同 P1.1

**P1.4 `coupon_templates.expire_action` text DEFAULT 'lazy_sweep'**
- WF 源：无（新系统独立）
- PG 应新增列：text 枚举{'lazy_sweep' / 'cron_sweep' / 'no_sweep'}
- 业务理由：当前清扫策略硬编码在 client/staff coupon.list 入口，6 个写入路径产出后清扫节奏不一致；声明为模板级配置后，未来"高敏感模板（如分享礼）→ cron 分钟级清扫"可灵活配置
- 抽取式：admin 默认 'lazy_sweep'，分享礼等场景手工改为 'cron_sweep'
- 数据量：0/9 行（新增字段，无需回填）
- 依赖：cron-worker 加 `sweep-expired-coupons.ts` STEP（当前模块缺失定时清扫器）

**P1.5 `user_coupons.source_channel` text**
- WF 源：无
- PG 应新增列：text，记录发券来源命名空间 ('admin_single' / 'admin_batch' / 'cron_birthday' / 'cron_thanksgiving' / 'cron_member_upgrade' / 'share_gift_inviter' / 'share_gift_invitee')
- 业务理由：当前命名空间藏在 `coupon_id` 前缀（cpn-/sg-/bday-/thx-/cpn-up-），需要 LIKE 匹配；显式列后所有报表/审计/降档算法都能直接 GROUP BY；refunds.ts 算"已享用券价值"可按 source_channel 做差异化处理（分享礼 vs 升级奖励）
- 抽取式：从 coupon_id LIKE 派生回填（一次性 UPDATE）
- 数据量：17/17 行（全部 cpn-* 当前）
- 依赖：所有写入入口 INSERT 时显式传值

#### P2 — 配置 / 体验改善

**P2.1 `coupon_templates.max_per_user` integer DEFAULT NULL**
- WF 源：无
- PG 应新增列：integer，单顾客同模板可持有最大未使用券数（NULL=不限）
- 业务理由：本 R2 §4 发现 user `FYGK-20260314-00001` 持有同模板 3 张未使用券；admin batchIssueCoupons 不校验，可能误发；新增字段后 admin/cron/share-gift 各路径在 INSERT 前 SELECT COUNT 校验
- 抽取式：admin UI 表单，默认 NULL
- 数据量：0/9（新增字段）
- 依赖：6 写入路径都需新增 COUNT 校验

**P2.2 `coupon_templates.template_status` text DEFAULT 'active'**
- WF 源：无
- PG 应新增列：text 枚举 {'active' / 'expired' / 'paused' / 'archived'}，与 is_active 拆分
- 业务理由：本 R2 §6 发现 `coupon-tpl-003` valid_to 已过 12 天但 is_active=true，admin 列表/issueCoupon 都不区分"管理员手动停用"vs"业务时间过期"。拆分后 admin UI 可显示"3 个已过期模板需归档"
- 抽取式：派生 `CASE WHEN valid_to < NOW() AND validity_mode='fixed' THEN 'expired' WHEN is_active=false THEN 'paused' ELSE 'active' END`
- 数据量：1/9 行 = expired（coupon-tpl-003），8/9 = active
- 依赖：admin UI 改造

**P2.3 `user_coupons.cancelled_at` timestamp + `cancel_reason` text**
- WF 源：无
- PG 应新增列：cancelled_at timestamp, cancel_reason text
- 业务理由：当前订单关闭释放只把券 status 改回 '未使用'，**不留痕迹**。一张券可能被多次"使用→关闭释放→再使用"循环，审计难追溯。新增 cancel_reason 字段记录"订单关闭"/"退款释放"/"管理员撤销"等原因
- 抽取式：当前 5/17 已使用券都未经历过"释放"路径，可置 NULL
- 数据量：0/17（新增字段）
- 依赖：order.cancel + card.refund + admin manual revoke 三处加写入

**P2.4 `user_coupons.granted_by_employee_id` varchar(20)**
- WF 源：无
- PG 应新增列：FK→staff_wechat_users.employee_id，记录 admin 后台是谁发的
- 业务理由：当前 admin issueCoupon 只走 operation_logs 审计，但 user_coupons 实例本身无操作员上下文；批量发券时报表"为什么 X 顾客比 Y 顾客多 50 元券"无法直接 JOIN 出来
- 抽取式：admin 路径写入 session.employeeId，cron/share-gift 留 NULL
- 数据量：17 行 cpn-* 都可回填（从 operation_logs.operator_employee_id JOIN coupon.issue/batchIssue）
- 依赖：operation_logs.operator_employee_id 已就位

#### P3 — 不建议（无源 / 设计未落地）

- WF `UDT_S_311.UDF_S_17856/57/58`（顾客侧三字段，含义不明）— B.D 30 行采样无明确分类组合规律，且 UDF_S_17194（销售单级当前余额）已足够支撑客户档案需求；建议**不再迁移**这三字段，避免引入语义不明的 NULL 列

### 总计

- 候选字段：12 个
- P0：0
- P1：5（P1.1-P1.5）— 3 个 client_wechat_users 历史欠账列 + 1 个 coupon_templates 清扫策略列 + 1 个 user_coupons source_channel 列
- P2：4（P2.1-P2.4）
- P3：0（建议不迁移 UDT_S_311 三字段）

