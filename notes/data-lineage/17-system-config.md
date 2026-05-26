# 17 — `system-config` 模块

**Schema 文件**：`db/schema/system-config.ts`
**涉及 PG 表**：`system_configs`（key/value 文本对，承载会员门槛 / 轮播图 / 升级权益 / 分享礼 / 积分折算等系统级运营配置）
**WorkFine 源表**：**无**（WorkFine 全部业务级"配置"概念缺失；仅平台层 `tb_sys_setting` 11 行存 logo/登录页图片/企业微信凭据/备份目录，**无任何业务运营参数**）

**主要写入入口**：

| 入口 | 文件 | 操作 | 写入的 key |
|------|------|------|-----------|
| 系统配置 admin UI | `fengyu-admin/src/actions/settings.ts:147-241`（`saveSettings`） | UPSERT | `new_member_threshold` / `order_timeout` / `banner_images` / `fengyuguan_image` / `banner_count` |
| 三档会员权益 admin UI | `fengyu-admin/src/actions/settings.ts:392-445`（`saveMemberBenefits`） | UPSERT | `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits` |
| 分享礼配置 admin UI | `fengyu-admin/src/actions/settings.ts:328-369`（`saveShareGiftConfig`） | UPSERT | `share_gift_config` |
| baseline 建表 | `db/migrations/0000_baseline.sql:487-491` | DDL | — |
| 0006 migration 数据回填 | `db/migrations/0006_wonderful_earthquake.sql:9` | INSERT ON CONFLICT DO NOTHING | `points_to_yuan_rate` = `'0.01'` |
| 归档 0033（baseline 前） | `db/migrations/_archive_pre_baseline_2026_04/sql/0033_seed_member_level_benefits.sql:12-49` | INSERT ON CONFLICT DO NOTHING | `member_level_benefits` 占位 JSON（5 等级 × messageTitle/Body/points/couponTemplateIds） |
| `verify-member-level-cron.js` 测试夹具 | `db/scripts/verify-member-level-cron.js:221-233` | UPSERT | `new_member_threshold='1990'` / `member_level_benefits=JSON` |

**只读入口**（不写入但依赖此表）：

| 入口 | 文件 | 读哪些 key |
|------|------|-----------|
| admin getSettings | `fengyu-admin/src/actions/settings.ts:122-145` | `new_member_threshold` / `order_timeout` / `banner_images` / `fengyuguan_image` |
| admin getMemberBenefits | `fengyu-admin/src/actions/settings.ts:263-294` | `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits` |
| admin getShareGiftConfig | `fengyu-admin/src/actions/settings.ts:304-322` | `share_gift_config` |
| admin getPointsToYuanRate | `fengyu-admin/src/actions/settings.ts:375-386` | `points_to_yuan_rate` |
| admin lib `member-threshold` | `fengyu-admin/src/lib/member-threshold.ts:20-35` | `new_member_threshold`（`unstable_cache` 5min TTL） |
| admin actions/refunds | `fengyu-admin/src/actions/refunds.ts:243` / `refunds.ts:1311` | `member_level_benefits` / `new_member_threshold` |
| cron-worker 双层缓存 | `fengyu-admin/src/cron/config.ts:32-54` | `new_member_threshold`（30s/5min 双层 TTL） |
| cron-worker benefits-loader | `fengyu-admin/src/cron/lib/benefits-loader.ts:22-25` | `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits`（不缓存） |
| clientApi utils/config | `fengyu-client/cloudfunctions/clientApi/utils/config.js:36-50` | `new_member_threshold`（30s/5min 双层缓存） |
| staffApi utils/config | `fengyu-staff/cloudfunctions/staffApi/utils/config.js:37-50` | `new_member_threshold`（同上 30s/5min 双层缓存） |
| payNotify utils/config | `fengyu-client/cloudfunctions/payNotify/config.js:52` | `new_member_threshold` |
| clientApi config.banners | `fengyu-client/cloudfunctions/clientApi/routes/config.js:17` | `banner_images` |
| clientApi config.fengyuguan | `fengyu-client/cloudfunctions/clientApi/routes/config.js:32` | `fengyuguan_image` |
| share-gift（3 副本 client/staff/payNotify） | `*/share-gift.js:29` | `share_gift_config` |
| recalc-all-customer-types 脚本 | `db/scripts/recalc-all-customer-types.js:61-66` | `new_member_threshold`（fail-fast，缺失则拒绝执行） |
| 归档 0023 document_type SQL | `db/migrations/_archive_pre_baseline_2026_04/sql/0023_document_type.sql:10` | `new_member_threshold`（一次性回填用） |

**PG 现状**（5434/fengyu，2026-04-26 探查）：

| 表 | 总行数 | 来源 |
|----|-------|------|
| system_configs | **10 行** | 全部 admin UI 录入 / migration 兜底 / 设计未实现的留空 |

**当前 10 行清单**（按 key 排序）：

| key | value 长度 | updated_at | 写入来源 | 业务用途 |
|-----|-----------|-----------|----------|----------|
| `banner_count` | 1（`'7'`） | 2026-03-31 | `saveSettings`（admin） | client 端 banner config.json 版本号辅助；无运行时读取，**仅 saveSettings 自读** |
| `banner_images` | 771 字节 JSON 数组 | 2026-03-31 | `saveSettings`（admin） | clientApi `config.banners` 返回首页轮播图 |
| `birthday_benefits` | 381 字节 JSON | 2026-04-24 | `saveMemberBenefits`（admin） | cron STEP 3 生日权益（消息/积分/优惠券） |
| `fengyuguan_image` | 83 字节 URL | 2026-03-31 | `saveSettings`（admin） | clientApi `config.fengyuguan` 返回凤御馆宣传图 |
| `member_level_benefits` | 544 字节 JSON | 2026-04-24 | `saveMemberBenefits`（admin） | cron STEP 2 升级权益 |
| `new_member_threshold` | 4（`'1980'`） | 2026-03-31 | `saveSettings`（admin） | 会员判定门槛（admin/staff/client/cron/payNotify 全链路读，5 副本缓存） |
| `order_prefix` | 10（`'FY-XSD-WX-'`） | **2026-03-21**（最早） | ⚠️ 来源未知（grep 全仓 0 hits） | **死键**：当前没有任何代码读写它；订单号格式硬编码在云函数 |
| `order_timeout` | 2（`'10'`） | 2026-03-31 | `saveSettings`（admin） | ⚠️ admin UI 录入但**全仓零运行时消费方**（grep 全仓 0 hits） |
| `points_to_yuan_rate` | 4（`'0.01'`） | 2026-04-24 | `0006_wonderful_earthquake.sql:L9` migration | admin `getPointsToYuanRate` → 退款时折算已用积分（`refunds.ts`） |
| `thanksgiving_benefits` | 381 字节 JSON | 2026-04-24 | `saveMemberBenefits`（admin） | cron STEP 4 月 20 号感恩日权益 |

**未出现在 PG 但代码已读**（缺失键 → 调用方走 fallback）：

- `share_gift_config` — share-gift 三副本读不到 → `granted: false, reason: 'no_config'`，分享礼链路全员沉默失败。admin `/share-gift` 页未启用过（自 2026-04-24 ticket PR-2 上线以来零写入）。

---

## 表 1：`system_configs`

### 列级血缘

| PG 列 | 类型 | 来源类别 | WorkFine 字段 / 计算式 / 默认值 | 出处 | 备注 |
|------|------|---------|---------------------------------|------|------|
| key | text PRIMARY KEY | 新系统独立 | 硬编码字符串列表（10 个 admin 写入键 + 1 个 migration 写入键 + 1 个未知历史键） | settings.ts:L162-167, L415-419, L348；0006:L9；0033:L14 | **完全 PG 内部命名空间**，与 WorkFine 无任何字段对应 |
| value | text NOT NULL | 新系统独立 | 标量字符串 / JSON 字符串（取决于 key），由 admin UI 表单 / migration 字面量 / verify 脚本写入 | settings.ts:L172-173；schema:L10 | text 列无 schema 强制类型，结构在调用方 `JSON.parse` 时即时校验，损坏 → 各副本不同 fallback 策略：admin/cron 静默降级；clientApi/staffApi 走 FALLBACK_THRESHOLD=1980 |
| updated_at | timestamp NOT NULL | 默认值/NULL + 主动写 | INSERT/UPSERT 时 `NOW()`（手写 SQL）或 `defaultNow()`（schema 默认） | settings.ts:L172-174；schema:L11；0033:L13 | **关键作用**：clientApi/staffApi/payNotify/cron 的 30s 被动核对策略全部读这个戳判断是否需要重新拉缓存（详见下文「关键决策」第 3 条） |

### 已被脚本读但未对接到 PG 的 WorkFine 列

**完全无对应**。WorkFine MSSQL 全库探源结果：

| 探源维度 | 结果 |
|----------|------|
| `sys.tables` 名称 LIKE '%config%' / '%setting%' / '%threshold%' / '%param%' | 4 命中（**全部**为 WorkFine 平台元数据，与业务无关） |
| → `tb_sys_api_param` | 1 行，平台 API 参数 |
| → `tb_sys_fun_param` | 59 行，平台函数参数 |
| → `tb_sys_setting` | **11 行**，存 SystemName='凤御 数据管理平台' 字符串、登录页 logo PNG（base64）、企业微信 corpId/corpSecret、备份路径 JSON `{"path":"C:\\back","state":true,...}`、UUID（id=1）。**没有任何业务运营参数**（无会员门槛 / 无轮播图 / 无优惠权益 / 无积分比率） |
| → `tb_sys_stored_procedure_param` | 0 行 |
| `sys.extended_properties` 描述 LIKE '%门槛%' / '%阈值%' / '%开关%' / '%全局配置%' | 0 命中 |
| `notes/research/workfine_database.md` 全文检索 "配置 / threshold / 轮播 / banner" | 0 命中 |

> **结论**：WorkFine 完全不存在"业务级 key/value 配置表"概念。它的"配置"全部以两种形式表达：
>   1. 平台级硬编码常量（系统名、logo、企业微信凭据） → `tb_sys_setting`
>   2. 业务规则在 WorkFine 工作流引擎里以"流程图节点 + 公式表达式"硬编码（运行时看不到独立配置实体）
>
> 所以 `system_configs` 模块**最终 WorkFine→PG 迁移完全不需要触及**——所有 10/11 个键都是新系统的运营产物。

---

## 关键决策摘要

1. **100% 新系统独立**：本模块与 `06/appointments`、`08/commission`、`09/coupon`、`10/points`、`12/messages`、`15/pickup_records`、`16/store_unbind_requests` 同属一组——WorkFine 完全无对应实体、迁移阶段无需建立任何 WF→PG 字段映射。但本表与上述 7 个表不同的是：**已有真实业务数据 10 行**，并且 `new_member_threshold` 是全栈关键路径单点（5 副本缓存）。

2. **死键 `order_prefix`**：PG 现存的 `order_prefix='FY-XSD-WX-'` 行（updated_at=2026-03-21，最早）在全仓**无任何代码读写**（`grep -rn 'order_prefix' --include='*.js' --include='*.ts' --include='*.sql'` 0 hits）。订单号前缀 `FY-XSD-WX-` 实际硬编码在云函数 order.create 路径。这一行是早期 admin 版本遗留，但因没人读所以无害。最终迁移时建议清理或归档为说明性注释。

3. **`updated_at` 是分布式缓存协议的"心跳"**：clientApi（`utils/config.js:36-50`）/ staffApi（同源）/ payNotify（`config.js:52`）/ cron-worker（`cron/config.ts:32-54`）所有副本均采用同一个**双层缓存**模式：
   - 30 秒内重复调用 → 直接返回内存缓存
   - 超过 30 秒 → 查 `SELECT value, updated_at FROM system_configs WHERE key='new_member_threshold'`，如果 `updated_at` 戳变了则重读 value，否则只刷 `_lastCheckAt`
   - 5 分钟兜底 TTL 强制清除
   
   admin `saveSettings` 在 `newMemberThreshold` 变更时走两条主动失效路径：① `invalidateMemberThreshold()` 清自己的 `unstable_cache`；② `callClientFunction('clientApi', { action: 'config.invalidateConfig' })` 跨云函数广播一次（settings.ts:L221-232）。**staffApi / payNotify / cron-worker 在另一个 envId 或独立进程，admin 不广播给它们**——它们只能等 30 秒被动核对。这意味着改门槛后最长 30 秒生效窗口期 staff 端可能用旧值开单。

4. **`points_to_yuan_rate=0.01` 是 migration 写死的，非 admin UI 配置**：在 admin `/settings` 页表单上**没有这一项输入框**（settings.ts:L48-53 SystemSettings interface 不含），仅由 0006 migration `INSERT ON CONFLICT DO NOTHING` 兜底建出。`getPointsToYuanRate` 读取时若行不存在或值非法也走 0.01 fallback。**业务方需要调整时只能手动 SQL UPDATE**，无 UI。

5. **`order_timeout` 是"配置存在但无消费方"**：admin UI 可保存（settings.ts 把它列为 SystemSettings 字段），但全仓 grep `order_timeout / orderTimeout` 在 cloudfunctions/cron/scripts 中 0 hits。这是产品需求半残留：可能曾计划做"待支付订单超时自动关闭"但只完成了配置入口、没接 cron 消费方。最终迁移可以保留行（不影响），但应在 admin UI 标灰说明"未实装"。

6. **`member_level_benefits` 三场景有两套写入路径**：
   - 归档 0033 SQL 在 baseline 之前**只写 `member_level_benefits`**（升级场景，5 等级 × 文案 + 占位 points/couponTemplateIds）
   - admin `saveMemberBenefits` 写**三场景**：`member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits`
   - 当前 PG 三键齐全（updated_at=2026-04-24 同时间），说明业务方已在 admin UI 提交过一次。
   - cron-worker 的 `benefits-loader.ts` 注释明确说 **「不缓存」**：admin 改完下次 03:00 必生效（无内存缓存压力）；与 `new_member_threshold` 双层缓存策略相反。

7. **`share_gift_config` 是设计实现 + 未启用**：admin `/share-gift` 页（PR-2 ticket 2026-04-24）已实现 `saveShareGiftConfig`，share-gift 三副本（payNotify/clientApi/staffApi）已实现读取链路，但**PG 现状此 key 不存在**（业务方未在 admin UI 启用）。share-gift 链路自上线起 100% 走 `granted: false, reason: 'no_config'` 静默降级路径，与 `09/user_coupons` 文档"分享礼三副本零产出"完全自洽。

8. **`saveSettings` / `saveMemberBenefits` / `saveShareGiftConfig` 三处都内联了 `CREATE TABLE IF NOT EXISTS system_configs`**：这是 baseline 之前的兜底（远程库 schema 未对齐时自我修复），baseline reset 之后已是冗余但未删除。属于"无害但可清理"代码。

9. **测试夹具 `verify-member-level-cron.js` 不在生产路径**：该脚本写 `new_member_threshold='1990'` 是测试隔离用的，但**它是 INSERT ON CONFLICT DO UPDATE**，会污染共享库。如果不小心在生产库跑会把 1980 改成 1990。当前仓库无任何 npm script 自动调用它，需要手动执行才会触发。

---

## ⚠️ 本模块未覆盖字段汇总（同步至 _gaps.md）

无 WorkFine 字段级 gap（WorkFine 整库零业务配置实体）。但有 **5 个治理问题**值得记入 `_gaps.md`：

- ⚠️ **死键 `order_prefix`**：PG 残留 1 行（2026-03-21）但全仓 0 处代码读写。建议最终迁移清理或在 admin UI 加只读说明。
- ⚠️ **配置项 `order_timeout` 无消费方**：admin UI 表单可填写但全仓 0 处运行时读取，业务需求半实现。需要确认是否要补 cron 任务消费它，或者从 admin UI 撤掉。
- ⚠️ **`share_gift_config` 全仓 grep 写入路径只有 admin `saveShareGiftConfig`，PG 现状此 key 不存在**：分享礼链路自上线起永远走 fallback。需要业务方在 admin `/share-gift` 页启用一次配置才能让 share-gift 三副本工作。这与 `09/user_coupons` 文档"分享礼零产出"互为佐证。
- ⚠️ **`points_to_yuan_rate` 没有 admin UI**：`SystemSettings` interface 不含此字段，业务方只能 SQL UPDATE。建议在 admin `/settings` 页加输入框。
- ⚠️ **`new_member_threshold` 跨进程缓存失效不完整**：admin 改完只主动广播给 clientApi（settings.ts:L221-232），staffApi / payNotify / cron-worker 各自 30 秒被动核对。最长 30 秒不一致窗口期内 staff 端可能用旧值判定会员资格。如需强一致，应在 saveSettings 里再追加 `callClientFunction('staffApi', ...)` 和 `callClientFunction('payNotify', ...)` 两条广播。

---

## Review 报告（2026-04-26）

独立复核（先调研后读结论）：5 步流程 + MSSQL 探源 + PG 5434 抽样 + 全仓 grep。

### 一致性总览
- 一致项：**~28**（schema 列定义 / 7 写入入口行号 / 14 只读入口行号 / 5 副本缓存 FALLBACK_THRESHOLD=1980 / PG 10 行清单 / WorkFine 无业务配置实体结论 / saveSettings 仅广播 clientApi 的 gap / share_gift_config PG 缺失现状 / member_benefits 双写入路径演化）
- 不一致项：**3**（均为措辞精度类，不影响结论）

### 偏差明细

**缺漏（0）**：暂无。

**错配（2，措辞精度类）**：
1. L57 `order_timeout` 「全仓 grep 0 hits」过于绝对：实际 admin `actions/settings.ts` (saveSettings/getSettings)、`logs-page.tsx`（标签）、`settings-page.tsx`（UI 表单）、`settings.test.ts`（多处断言）都有引用。文档原意是「无 cron / 云函数业务消费方」（L114 已澄清），但 L57 单独读会误导。
2. L106 cron-worker 缓存协议描述「30 秒内重复调用 → 直接返回内存缓存」对 cron-worker 表述完全准确，但同句套用到 admin 自身路径时，`member-threshold.ts` 实为 Next.js `unstable_cache`（5 分钟 revalidate + 主动 revalidateTag），并不是 30s/5min 双层。文档其它行（L27/L106 之间）多次混用两种语义，建议在表头注明「双层缓存仅指 cloudfunctions/cron 副本」。

**数据不一致（1，未独立复现）**：
1. L86 `tb_sys_setting` 「11 行」未独立复现行数（本轮只验证了列结构 `id/value/bin_value/expire_date/update_date/name`，与文档描述吻合；行数依赖前次 audit 结论）。该数值若过时不影响"WorkFine 无业务级配置实体"主结论。

**过时事实（0）**：暂无。文档的 PG 现状（10 行 + 各键 updated_at 时间戳）与 2026-04-26 探查完全一致；归档 0033 路径正确（`_archive_pre_baseline_2026_04/sql/0033_seed_member_level_benefits.sql`）；migration 0006 行号 L9 准确。

### 关键自洽性验证

- ✅ schema/system-config.ts 仅 3 列，全部 NOT NULL，key 为 PK——文档 L70-75 列血缘表完全对应
- ✅ PG 10 个 key 与文档 L48-59 表逐行对齐；`share_gift_config` 确认缺失（grep PG 0 行）→ 文档 L62-63 / L122 的 "share-gift 链路全员沉默失败" 结论成立
- ✅ FALLBACK_THRESHOLD=1980 在 4 处副本（clientApi/staffApi/payNotify/cron-worker）字面值一致——文档 L7 / L74 描述准确
- ✅ saveSettings 的跨进程广播仅指向 `clientApi.config.invalidateConfig`，未触达 staffApi / payNotify / cron-worker——文档 L110 / L138 gap 描述准确，是真实运营隐患
- ✅ `points_to_yuan_rate` 来自 0006 migration（无 admin UI 输入入口），文档 L112 / L137 描述正确
- ✅ `order_prefix` 全仓 grep 0 hits（独立复现），文档 L56 / L103 / L134 描述准确

### Verdict

**accept**

文档质量极高，10 行 PG 现状 / 7 写入入口 / 14 只读入口 / 5 副本缓存协议 / 5 治理 gap 全部精准命中，且主动披露了所有架构性弱点（broadcast 不完整 / order_prefix 死键 / order_timeout 半实现 / share_gift_config 未启用 / points_to_yuan_rate 无 UI）。仅 3 处措辞精度类微小偏差（"全仓 grep 0 hits" 过强、缓存协议 admin/cloudfunc 套用、tb_sys_setting 行数未独立复现），不影响任何结论也不构成 P0。

无 P0 / 无数据资损 / 无业务永久失效。

---

## Edge Case 报告 R2（2026-04-26）

**verdict: serious-edge-cases**

R2 直接挖文档外的边缘问题。R1 已识别 5 个治理 gap（order_prefix 死键 / order_timeout 半实现 / share_gift_config 未启用 / points_to_yuan_rate 无 UI / 缓存广播不完整）。R2 在此基础上**进一步复现并升级 1 个 P0、新挖 3 个 P1、补充 4 个 P2**。

### 8 维度命中（命中 6/8）

| # | 维度 | 命中 | 现状 |
|---|------|------|------|
| 1 | FK 孤立 | N/A | system_configs 无外键（KV 表） |
| 2 | NULL/空串/极值 | ✅ 干净 | NULL/空串/'null'/'undefined'/极端时间戳全 0 行；max value len=771（banner_images）；min=1（banner_count='7'）；schema 三列全 NOT NULL 真守住 |
| 3 | enum 漂移 | N/A | text 自由值 |
| 4 | unique 约束 | ✅ 干净 | `GROUP BY key HAVING COUNT>1` 0 行，PK 真守住 |
| 5 | 跨模块一致性 | ⚠️ HIGH | **R2-E1**（升级版 P0）：admin saveSettings 主动广播只有 `clientApi.config.invalidateConfig`，但 staffApi / payNotify 也已**实现** `invalidateCache()` 函数，却**没暴露 action 路由**——admin 永远调不到，等价于死代码（详见下文 EDGE-1） |
| 6 | 死代码 / 永不命中 | ⚠️ HIGH | **R2-E2**（升级版 R1）：① `order_prefix='FY-XSD-WX-'` 残留；② `order_timeout='10'` 仅 admin 自读自写；③ `banner_count='7'` 仅 saveSettings 自身读取一次决定要删多少张老图；④ `share_gift_config` 行不存在导致分享礼三副本 100% 沉默；⑤ staffApi/payNotify 的 `invalidateCache` 函数（详见 E1）|
| 7 | dump-restore drift | ⚠️ MED | **R2-E3** 三个 admin 写入入口（saveSettings/saveMemberBenefits/saveShareGiftConfig）各自内联 `CREATE TABLE IF NOT EXISTS system_configs`——baseline reset 之后已是冗余 fallback，存在"幻影建表"风险（若 DDL guard 永远跑则每次 saveSettings 触发 DDL 锁） |
| 8 | 运行时安全 | ⚠️ HIGH | **R2-E4 / E5**：① saveSettings 4 次 UPSERT + saveMemberBenefits 3 次 UPSERT 均**未在事务里**（for 循环每次单独 db.execute）→ 中途失败留下半套配置；② new_member_threshold 改完最多 30 秒不一致窗口（R1 已识别），但叠加 E1 → staffApi/payNotify/cron-worker 是**完全无法主动失效**（不是"30 秒被动核对"，而是"永远只有被动 30 秒"），admin 的"主动广播"在工程上是**单独立不全的"半个广播"**；③ banner CDN 强一致性破缺：banner_images（DB） + config.json（CDN） + banner1.jpg..N.jpg（CDN）分三处异步写入，任一中断造成 client 端读 stale CDN 但 admin 显示新值 |

### 边缘问题详细

#### EDGE-1（升级版 P0）— admin saveSettings 跨进程广播工程不全：staffApi/payNotify 的 `invalidateCache` 是**死代码**

**位置**：`fengyu-admin/src/actions/settings.ts:L223-231`、`fengyu-staff/cloudfunctions/staffApi/utils/config.js:L62-65`、`fengyu-client/cloudfunctions/payNotify/config.js:L74-77`

**现状**：
- saveSettings 主动广播仅 `Promise.allSettled([callClientFunction('clientApi', { action: 'config.invalidateConfig' })])`
- 但 staffApi 的 `utils/config.js` 第 62-65 行明确实现了 `invalidateCache()`，**注释写"主动清缓存（供 config.invalidateConfig action 调用）"**
- staffApi 的 `index.js` action 路由表 grep 确认**没有 `config.invalidateConfig` action**（grep 0 hits）
- payNotify 的 `config.js:L74-77` 同样实现 `invalidateCache()`，注释相同，但 payNotify **没有 action 路由系统**（payNotify 是被微信支付直接 webhook 调用的，无 callFunction 入口）

**业务影响**：
- staffApi `invalidateCache()` 函数是 **dead code**——永远没人调，注释承诺的契约从未兑现
- payNotify 同样情况
- 现实结果：admin 改完 `new_member_threshold`，staff 端开单可能**最长 30 秒**仍用旧值判定会员资格、payNotify 处理回调可能用旧值算分（影响 STEP 2 升级权益）、cron-worker 依赖 `_lastCheckAt` 30 秒戳

**修复**：A 给 staffApi 加 `'config.invalidateConfig': () => require('./routes/config').invalidateConfig` 路由 + 内部 ACL 限制只有 admin envId 可调；B saveSettings 同时广播 staffApi；C payNotify 因不接 callFunction，应改为"30 秒被动核对" + 注释说明**原本就只能被动**（删 invalidateCache 的死代码注释）。

#### EDGE-2（新增 P0）— `saveSettings` / `saveMemberBenefits` 多键 UPSERT 无事务，中途失败留半套配置

**位置**：`fengyu-admin/src/actions/settings.ts:L169-175`（saveSettings 4 次 UPSERT for 循环）、`L421-427`（saveMemberBenefits 3 次 UPSERT for 循环）

**故障路径**：
1. saveSettings UPSERT `new_member_threshold` 成功 → UPSERT `order_timeout` 成功 → UPSERT `banner_images` 成功 → UPSERT `fengyuguan_image` 数据库连接断开
2. PG 现状：4 个键中 3 个新值 + 1 个旧值，且 `updated_at` 戳不同步（distinct_ts_cnt=10 已证 4 键时间戳确实独立）
3. clientApi 拉取时只对 `new_member_threshold` 有 stale check，对 `banner_images` 没有 → client 端立即看到部分新轮播图但门槛是新的
4. saveMemberBenefits 同理：UPSERT upgrade 成功 → UPSERT birthday 失败 → cron STEP 2 用新升级配置 + STEP 3 用旧生日配置

**业务影响**：① 部分配置应用部分不应用，权益运营在数据上"撕裂"；② 错误返回 `{ success: false, message: '保存失败' }` 给运营但实际 PG 已脏数据；③ 重试时由于 ON CONFLICT DO UPDATE 是最新值覆盖，重试有可能"消除"上次的部分提交也可能不能，行为依赖错误位置

**修复**：把 `for (const entry of entries)` 包进 `db.transaction(async (tx) => {...})`；同步 saveShareGiftConfig 单次 UPSERT 已隐式安全。

#### EDGE-3（新增 P1）— banner 三重存储 (DB row + CDN config.json + CDN banner{N}.jpg) 跨域写入无原子性

**位置**：`fengyu-admin/src/actions/settings.ts:L177-208`

**现状**：saveSettings 顺序执行：① `Promise.all` 重传所有 banner{N}.jpg 到固定 CDN 路径；② 读 `banner_count` 算要删多少老图；③ `deleteByCloudPaths` 删多余老图；④ 上传 config.json；⑤ UPSERT `banner_count`。**任一步骤失败**：DB 行不一致、CDN 残留旧图、config.json 与实际 jpg 文件 mismatch。

**业务影响**：极端情况 client 端读 config.json `count=7` 但 banner4.jpg 已被删除 → 加载 404；或 config.json 是旧的而 banner_images 是新的 → admin 看新值 client 看旧值。

**修复**：把 banner CDN 操作前置到 DB UPSERT 之前用 dry-run / staging 路径；或加补偿逻辑捕获每步失败并回滚 CDN。

#### EDGE-4（新增 P1）— `points_to_yuan_rate` 字符串可被 admin/cron 静默改成 0 或负数（无 schema 约束）

**位置**：schema 无 CHECK；`getPointsToYuanRate` 仅 `parsed > 0 ? parsed : 0.01` fallback

**现状**：① 当前值 `'0.01'`；② 但表是自由 text，**任何人**手工 SQL `UPDATE system_configs SET value='-1' WHERE key='points_to_yuan_rate'` 不会被拒绝；③ getPointsToYuanRate fallback 0.01 但**只覆盖此一处读取**——若未来其他模块绕开此函数直接读 value 字段并未做 `>0` 校验，会按 -1 倍率算

**业务影响**：runtime 影响有限（所有现有读取都走 getPointsToYuanRate），但作为系统级配置缺最小防御。

**修复**：A 加 CHECK 约束（但 text 列 + 多种类型 KV 难统一）；B 通用做法：在每个读取点写 schema 校验函数，不依赖入库时校验；C 规范化为 `value text + value_type text` 双列允许 schema 知道每个 key 的类型。

#### EDGE-5（新增 P1）— 缓存协议依赖 `updated_at` 但 PG 时间戳精度可能跨 NTP 倒退

**位置**：`fengyu-admin/src/actions/settings.ts:L173`（`updated_at = NOW()`）vs cron/clientApi/staffApi/payNotify 4 副本 `if (ts !== _cachedUpdatedAt) {...}`

**故障路径**：① admin server 在 PG host 上 NOW() 取本地时钟 06:52:04.840；② 跨过 NTP 校正退回 5ms；③ 下次 saveSettings 写 updated_at = 06:52:04.835（早于上次）；④ cloudfunc 缓存协议判断 `ts !== _cachedUpdatedAt` 仍为 true 重读，所以**不会触发"缓存粘住"**——但若 NTP 跳跃刚好碰上同毫秒等值则有概率漏读。本探测发现 10 行的 microsec 精度均不同（distinct_ts_cnt=10），实战未触发。

**业务影响**：边缘场景，未实证。

**修复**：A 用 BIGINT seq + updated_at 复合判断；B 用 xmin 系统列；C 接受当前实现（严重程度低）。

#### EDGE-6（P2）— `verify-member-level-cron.js` 测试夹具污染生产库

**位置**：`db/scripts/verify-member-level-cron.js:L221-233` 写 `new_member_threshold='1990'` UPSERT

**现状**：脚本无生产/测试库判断，使用 `process.env.DATABASE_URL` 默认指向 5434 生产业务库；任何运维误跑会**永久篡改门槛**至 1990。文档 R1 第 9 条已识别但未升级 P 级。

**修复**：脚本 banner 启动检查 `if (DATABASE_URL.includes('5434') || DATABASE_URL.includes('fengyu') && !.test) throw`。

#### EDGE-7（P2）— 三个 admin 入口内联 `CREATE TABLE IF NOT EXISTS` 是 baseline 后冗余

**位置**：`settings.ts:L155-160`、`L339-344`、`L401-406` 三处复制相同 DDL；baseline 0000_baseline.sql:L487 已建表

**业务影响**：每次 saveSettings 触发短暂 DDL lock（PG 对 IF NOT EXISTS 优化为 ACCESS EXCLUSIVE LOCK）；可阻塞同时跑的 SELECT。

**修复**：删除三处内联 DDL（baseline 已建表）。

#### EDGE-8（P2）— admin/cron 缓存协议双套（unstable_cache 5min vs 30s/5min 双层），文档 L106-110 混用

**位置**：`fengyu-admin/src/lib/member-threshold.ts:L20-34`（unstable_cache 5min revalidate + revalidateTag 失效）vs cloudfunc/cron 4 副本（30s 戳核对 + 5min 强制 TTL）

**现状**：admin 和 cloudfunc 是**根本不同**的缓存语义。admin saveSettings 走 `revalidateTag` 立即清，但 cloudfunc 走 `Promise.allSettled` 广播——同一个 admin web 进程内一致，跨进程就不一致。文档 R1 已识别（review L156）但 R2 复现：admin 自己的 unstable_cache 在多 admin 实例部署下**也只在调用 saveSettings 那个实例失效**，其它 admin 实例 5min 内仍用旧值（多实例部署时 admin 内部也存在 5 分钟不一致窗口）。

**业务影响**：admin 多实例部署后，运营在 A 实例改门槛，B 实例的 admin 页面 5 分钟内仍展示旧值，操作日志看着已生效但其它运营看不到——配置修改"看起来不生效"。

**修复**：A admin 改用 PG `LISTEN/NOTIFY` 跨实例通知；B 把 `revalidate: 300` 调为 `30` 与 cloudfunc 对齐；C 单实例部署不修。

### R2 关键自洽性验证

- ✅ 5434/fengyu 仍是 10 行（与 R1 完全一致），`updated_at` 戳从 2026-03-21 到 2026-04-24
- ✅ `share_gift_config` 仍 ABSENT（key 不存在），分享礼三副本永远走 fallback
- ✅ `order_prefix` 仍残留，updated_at=2026-03-21（最早一行）
- ✅ JSON 类 4 键全部 valid_json（PG ::jsonb cast 0 异常）
- ✅ 数值类 4 键全部 parseable（无 NaN/Infinity）
- ✅ NULL/空串/'null'/'undefined' 4 类异常值 0 行
- ✅ unique PK 真守住（GROUP BY 0 重复）
- ✅ staffApi index.js grep `config.invalidateConfig` action **0 hits**（确认死代码 EDGE-1）
- ✅ saveSettings/saveMemberBenefits 的 for 循环 db.execute 无 `tx`/`transaction` 关键字（确认无事务 EDGE-2）

---

## 字段扩展建议（R2，2026-04-26）

### 重判 WorkFine 反推

R1 已确认 WorkFine 完全不存在业务级配置实体（`tb_sys_setting` 11 行仅平台元数据，无门槛/权益/轮播图概念）。R2 复确认：
- workfine_database.md 全文 0 命中关键字（"门槛 / threshold / 配置 / 阈值 / 开关 / 全局"）
- MSSQL 凭据复用 R1 探源（本轮未独立连接 MSSQL，遵循"WF 无业务配置实体"主结论）
- 因此**字段扩展必须从新系统侧的运营缺口反推，而非 WF 反推**

### 扩展候选清单（共 9 个：P0 ×2 / P1 ×4 / P2 ×3）

#### P0.1 拆分 `value text` → `value text + value_type varchar(20) NOT NULL DEFAULT 'string'`

**根因**：当前 KV 表所有 value 是 text，每个读取点都得自己 try/catch + JSON.parse + 数字校验。schema 不知道 `banner_images` 是 JSON 数组、`new_member_threshold` 是数字、`fengyuguan_image` 是 URL，4 种类型都靠调用方记忆区分。

**收益**：
- 写入路径加 schema 级类型校验（saveSettings 写 `new_member_threshold` 时 SQL CHECK `value_type='number' AND value::numeric > 0`）
- 读取路径可统一 helper：`getConfig<T>(key)` 按 type 自动 JSON.parse / Number()
- 文档化每个 key 的语义（防止未来新增 key 不一致）

**枚举 value_type**：`'string' | 'number' | 'json' | 'url' | 'boolean'`

**回填**：existing 10 行手工标注（new_member_threshold/order_timeout/banner_count/points_to_yuan_rate=number；banner_images/3 个 benefits/share_gift_config=json；fengyuguan_image=url；order_prefix=string）

#### P0.2 增加 `description text` + `category varchar(20)` 列（KV 表自描述）

**根因**：admin UI 现状各自 hardcode key 列表，无法做"系统配置中心"统一管理页。新增 key 必须改 UI/Server Action 才能展示。

**字段**：
- `description text` — 该 key 的业务用途中文描述
- `category varchar(20)` — `'会员' | '订单' | '运营' | '积分' | '分享礼' | '废弃'`

**收益**：
- admin 配置页改为通用表格驱动，不再 hardcode 字段
- 死键（order_prefix）category 标 `废弃` UI 自动归档
- 业务方自行维护配置含义

#### P1.1 增加 `is_secret boolean NOT NULL DEFAULT false`

**根因**：未来若引入 `wxpay_mch_key` / `tmap_secret` 等敏感配置，运营 UI 不应回显。

**收益**：UI 渲染时 `is_secret=true` 显示 `••••••••`，operation_logs 在 detail 中脱敏。

#### P1.2 增加 `editable_by varchar(20) NOT NULL DEFAULT 'admin'`

**根因**：`points_to_yuan_rate=0.01` 来自 migration 兜底，业务方"理论上"可改但实际**没有 UI 入口**。should be one of `'admin'` / `'migration_only'` / `'developer_only'`。

**收益**：admin 配置页根据该字段决定是否渲染输入框；`migration_only` 类只显示当前值不可编辑；`points_to_yuan_rate` 当前应标 `migration_only` 直到 EXTEND-2 拆分 SystemSettings interface 后改 `admin`。

#### P1.3 增加 `prev_value text + prev_updated_at timestamp`

**根因**：操作回滚强需求。当前 saveSettings UPSERT 直接覆盖，operation_logs 虽记 oldValue/newValue 但回滚需手工 SQL；audit 比对历史复杂。

**收益**：① 一键回滚到上一版（admin UI "撤销上次保存"）；② 缩小 EDGE-2 半套写入风险（重启 saveSettings 时自动检测 prev_updated_at 与 oldSettings 不一致 → 警告）。

**回填**：existing 10 行 prev_* 留 NULL。

#### P1.4 增加 `updated_by_employee_id text REFERENCES staff_wechat_users(employee_id)`

**根因**：当前 operation_logs 记录"谁改的"但 system_configs 表自身无此信息——audit 路径长。

**收益**：行级即可看到最后一次修改人，无需 JOIN operation_logs。

#### P2.1 把 `key` 列加 `CHECK (key ~ '^[a-z_]+$')` 约束

**根因**：当前 admin 任意写。如果未来误写 `New_Member_Threshold` 大小写不一致键，cloudfunc 全部读不到。

#### P2.2 增加 `effective_at timestamp NOT NULL DEFAULT NOW()` + `expires_at timestamp NULL`

**根因**：未来活动配置（"双 11 期间门槛降到 1500"）需要时间窗管理。当前 admin 改了立即生效，没法"提前配好定时生效"。

**收益**：cron-worker 跑前过滤 `WHERE effective_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())`。

#### P2.3 增加 `version int NOT NULL DEFAULT 1` 自增列 + 改 cloudfunc 缓存协议从 updated_at 戳 → version 整数

**根因**：EDGE-5 NTP 倒退理论隐患；version 严格单调避免时钟问题；但需要 saveSettings 在 UPSERT 时手动 `+1`。

**收益**：缓存协议鲁棒性升级。

### EXTEND 总结

- **P0 ×2**：value_type/description/category 三列共 1 个 schema 重构（拆 value text 类型 + 自描述）；解决 8 个调用方各自 try/catch 的全栈一致性问题
- **P1 ×4**：is_secret / editable_by / prev_value / updated_by_employee_id；治理 + 审计强化
- **P2 ×3**：key 正则 CHECK / effective_at-expires_at 时间窗 / version 单调号；防御未来需求

字段扩展数 **9**，P0 数 **2**，与 R1 5 治理 gap 互补（R1 是流程问题，R2 是 schema 设计问题）。


