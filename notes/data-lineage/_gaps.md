# 未覆盖字段汇总

来自各模块文档中**来源类别 = ⚠️ 未覆盖（疑似遗漏）** 的字段。这是后续生成最终迁移脚本时**最需要补的清单**。

---

## ⚠️ EDGE / 17-system-config

**P0：admin saveSettings 跨进程缓存广播工程不全 — staffApi/payNotify 的 `invalidateCache()` 是死代码**

- 位置：`fengyu-admin/src/actions/settings.ts:L223-231`（仅广播 `clientApi.config.invalidateConfig`）；`fengyu-staff/cloudfunctions/staffApi/utils/config.js:L62-65` 实现 invalidateCache 但 `index.js` action 路由表 grep `config.invalidateConfig` 0 hits（**未暴露 action 路由**）；`fengyu-client/cloudfunctions/payNotify/config.js:L74-77` 同样实现 invalidateCache 但 payNotify 是支付 webhook 入口无 callFunction 触发途径
- 现状：staffApi/payNotify 的 `invalidateCache` 函数定义+注释承诺契约，但**永远没人调用**——admin 改完 `new_member_threshold`，staff 端开单可能最长 30 秒仍用旧值判定会员资格、payNotify 处理回调用旧值算 STEP 2 升级权益、cron-worker 依赖 `_lastCheckAt` 30 秒戳被动核对
- 故障路径：① admin saveSettings 改门槛 → revalidateTag 清自己 unstable_cache；② Promise.allSettled 仅广播 clientApi；③ staffApi 进程内 `_cachedValue=旧门槛` + `_lastCheckAt=29秒前` → 此 30 秒窗口期内员工开单按旧门槛判会员；④ payNotify 同理（30 秒窗口期内的会员升级判定全错）；⑤ cron-worker 影响最小（每日 03:00 跑一次正好缓存 0），但若 cron 子任务跨多个客户走多 SELECT 中途 admin 改门槛仍可能拼新旧
- 业务影响：① 跨进程一致性"工程半成品"——文档 R1 已识别但未升级到死代码层；② saveSettings 给运营返回 `success: true` 但 staff 端 30 秒内仍用旧值，"看起来生效但开单还是旧的"；③ 短暂会员资格漂移影响福利发放
- 修复：A staffApi index.js 加 `'config.invalidateConfig': () => require('./routes/config').invalidateConfig` 路由 + ACL 限定 admin envId；B saveSettings 同时调 staffApi；C payNotify 接受被动 30 秒被动核对（删 invalidateCache 的死代码 + 注释承诺）；D 文档明确标注"分布式缓存协议为最终一致 30 秒窗口"

**P0：saveSettings / saveMemberBenefits 多键 UPSERT 无事务，中途失败留半套配置**

- 位置：`fengyu-admin/src/actions/settings.ts:L169-175`（saveSettings 4 次 UPSERT for 循环）；`L421-427`（saveMemberBenefits 3 次 UPSERT for 循环）
- 故障路径：① UPSERT new_member_threshold 成功；② UPSERT order_timeout 成功；③ UPSERT banner_images 成功；④ UPSERT fengyuguan_image PG 连接断开 → PG 现状：4 个键中 3 个新值 + 1 个旧值，`updated_at` 戳不同步（实测 distinct_ts_cnt=10 已证 4 键时间戳相互独立 ms 级偏差）；⑤ saveSettings catch 返回 `success: false` 给运营但 PG 已脏数据
- 业务影响：① 部分配置应用部分不应用，权益运营在数据上"撕裂"；② 重试 ON CONFLICT DO UPDATE 是最新值覆盖，**但旧值已永久丢失**（无 prev_value 列回滚）；③ saveMemberBenefits 撕裂场景：cron STEP 2 用新升级配置 + STEP 3 用旧生日配置，业务方不知情
- 实测：当前 PG 4 个 saveSettings 键 updated_at 戳跨 4 秒（06:52:04.707 → 06:52:08.420），banner_count 比其它键晚 4 秒进入是因为 banner CDN 上传步骤夹在中间 → 证明这一段确实非事务，且现实已观察到"4 秒撕裂窗口"
- 修复：把 `for (const entry of entries)` 包进 `db.transaction(async (tx) => { ... })`；同步 saveShareGiftConfig 单次 UPSERT 已隐式安全

**P1：banner 三重存储（DB row + CDN config.json + CDN banner{N}.jpg）跨域写入无原子性**

- 位置：`fengyu-admin/src/actions/settings.ts:L177-208`
- 故障路径：① Promise.all 重传所有 banner{N}.jpg；② 读 banner_count 算要删多少老图；③ deleteByCloudPaths 删多余老图；④ 上传 config.json；⑤ UPSERT banner_count——任一步骤失败留下不一致
- 业务影响：极端场景 client 端读 config.json count=7 但 banner4.jpg 已被删除 → 加载 404；或 config.json 是旧的而 DB banner_images 是新的 → admin 看新值 client 看旧值
- 修复：A staging 路径上传 + 双写完成后 atomic rename；B 加补偿逻辑捕获每步失败回滚 CDN

**P1：`points_to_yuan_rate` 字段无 schema CHECK，可被静默改成 0/-1（仅 getPointsToYuanRate 单点 fallback）**

- 位置：schema 无 CHECK 约束；`getPointsToYuanRate` 仅在读取时 `parsed > 0 ? parsed : 0.01` 兜底
- 故障路径：① 任何人手工 SQL `UPDATE system_configs SET value='-1' WHERE key='points_to_yuan_rate'` 不会被拒；② 现有读取走 getPointsToYuanRate 安全；③ 未来其它模块绕开此函数直接读 value 字段并未做 `>0` 校验，按 -1 倍率算
- 业务影响：runtime 影响有限但缺最小防御；`refunds.ts` 退款计算依赖此值，错值直接错算
- 修复：A schema 加 `CHECK (key != 'points_to_yuan_rate' OR value::numeric > 0)`（PG CHECK 支持函数）；B 通用 helper 在每个读取点强制校验；C 拆分 EXTEND P0.1 `value_type` 列后从 schema 层强约束

**P1：admin 多实例部署下，admin 自身 unstable_cache 也存在 5 分钟跨实例不一致窗口（R1 review L156 已点出但未升级）**

- 位置：`fengyu-admin/src/lib/member-threshold.ts:L20-34`
- 现状：`unstable_cache(..., { revalidate: 300 })` + `revalidateTag` 仅在调用 saveSettings 那个 admin 实例失效，其它 admin 实例 5 分钟内仍用旧值
- 故障路径：① 运营在 admin 实例 A 改门槛 → A 实例 revalidateTag 清；② B 实例 5 分钟内 admin/orders 列表 + admin/refunds 计算用旧值；③ 运营 B 在 B 实例看不到新值，可能再保存一次"覆盖"
- 业务影响：单实例部署不影响（fengyu-admin 当前是单实例）；多实例部署后会现
- 修复：A 把 revalidate 从 300 调到 30 与 cloudfunc 对齐；B 加 PG `LISTEN/NOTIFY` 跨 admin 实例广播；C 当前单实例可推迟修

**P2：三个 admin 入口内联 `CREATE TABLE IF NOT EXISTS system_configs` baseline 后冗余 + 触发 ACCESS EXCLUSIVE LOCK**

- 位置：`settings.ts:L155-160 / L339-344 / L401-406` 三处复制相同 DDL；baseline 0000_baseline.sql:L487 已建表
- 业务影响：每次 saveSettings/saveMemberBenefits/saveShareGiftConfig 都触发短暂 DDL lock；可阻塞同时跑的 SELECT；fengyu-admin 写入频率低问题不显但属代码气味
- 修复：删除三处内联 DDL（baseline 已建表）

**P2：`order_prefix` / `order_timeout` / `banner_count` 三死键 + `share_gift_config` 行不存在 — 文档 R1 已识别**

- 位置：详见 17-system-config.md L56/L57/L62-63/L134-138（R1 治理 gap）
- 现状：order_prefix='FY-XSD-WX-' 全仓 0 处读写；order_timeout='10' 仅 admin UI 读写无 cron 消费方；banner_count='7' 仅 saveSettings 自读决定要删多少张老图（无业务消费）；share_gift_config key 不存在导致分享礼三副本永远走 fallback
- 修复：（运营/产品决策类）A 撤掉 admin order_timeout 输入框；B clean order_prefix 行；C 业务方在 admin /share-gift 页启用一次配置；D banner_count 改为内部计算变量不持久化

**P2：`verify-member-level-cron.js` 测试夹具 UPSERT new_member_threshold='1990' 可污染生产库**

- 位置：`db/scripts/verify-member-level-cron.js:L221-233`
- 现状：脚本无生产/测试库判断，process.env.DATABASE_URL 默认指向 5434 生产业务库
- 修复：脚本启动加 `if (DATABASE_URL.includes('5434') || (DATABASE_URL.includes('fengyu') && !process.env.ALLOW_PROD_TEST)) throw`

---

## 🔧 EXTEND / 17-system-config

**P0.1** 拆分 `value text` → `value text + value_type varchar(20) NOT NULL DEFAULT 'string'`

- 根因：当前 KV 表所有 value 是 text，每个读取点都得自己 try/catch + JSON.parse + 数字校验。schema 不知道 banner_images 是 JSON 数组、new_member_threshold 是数字、fengyuguan_image 是 URL，4 种类型靠调用方记忆区分（实测 8 个调用方各自实现）
- 收益：① schema 级类型校验；② 统一 helper `getConfig<T>(key)` 按 type 自动 parse；③ 文档化每个 key 的语义防止未来不一致
- 枚举 value_type：`'string' | 'number' | 'json' | 'url' | 'boolean'`
- 回填：existing 10 行手工标注（new_member_threshold/order_timeout/banner_count/points_to_yuan_rate=number；banner_images/3 个 benefits/share_gift_config=json；fengyuguan_image=url；order_prefix=string）

**P0.2** 增加 `description text` + `category varchar(20)` 列（KV 表自描述）

- 根因：admin UI 现状各自 hardcode key 列表，新增 key 必须改 UI/Server Action 才能展示。死键（order_prefix）无法 UI 自动归档
- 收益：① admin 配置页改为通用表格驱动；② category='废弃' UI 自动归档；③ 业务方自维护配置含义
- 枚举 category：`'会员' | '订单' | '运营' | '积分' | '分享礼' | '废弃'`

**P1.1** 增加 `is_secret boolean NOT NULL DEFAULT false`

- 根因：未来引入 wxpay_mch_key / tmap_secret 等敏感配置，运营 UI 不应回显 + operation_logs 应脱敏
- 收益：UI 渲染 `is_secret=true` 显示 ••••••••；operation_logs.detail 在 saveSettings logUpdate 时脱敏

**P1.2** 增加 `editable_by varchar(20) NOT NULL DEFAULT 'admin'`

- 根因：points_to_yuan_rate=0.01 来自 migration 兜底，业务方"理论上"可改但**没有 UI 入口**——配置语义在 schema 上不可见
- 收益：admin 配置页根据该字段决定是否渲染输入框；migration_only 类只读
- 枚举 editable_by：`'admin' | 'migration_only' | 'developer_only'`

**P1.3** 增加 `prev_value text + prev_updated_at timestamp`

- 根因：操作回滚强需求。当前 saveSettings UPSERT 直接覆盖，operation_logs 虽记 oldValue/newValue 但回滚需手工 SQL；EDGE-2 半套写入风险后无法识别
- 收益：① 一键回滚到上一版（admin UI "撤销上次保存"）；② 重启 saveSettings 时检测 prev_updated_at 与本次 oldSettings 不一致 → 警告
- 回填：existing 10 行 prev_* 留 NULL

**P1.4** 增加 `updated_by_employee_id text REFERENCES staff_wechat_users(employee_id)`

- 根因：当前 operation_logs 记录"谁改的"但 system_configs 表自身无此信息——audit 路径长需 JOIN
- 收益：行级即可看到最后一次修改人

**P2.1** 把 `key` 列加 `CHECK (key ~ '^[a-z_]+$')` 约束

- 根因：当前 admin/migration 任意写。误写 `New_Member_Threshold` 大小写不一致键，cloudfunc 读不到静默 fallback

**P2.2** 增加 `effective_at timestamp NOT NULL DEFAULT NOW()` + `expires_at timestamp NULL`

- 根因：未来活动配置（"双 11 期间门槛降到 1500"）需要时间窗管理。当前 admin 改了立即生效
- 收益：cron-worker 跑前过滤 `WHERE effective_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())`

**P2.3** 增加 `version int NOT NULL DEFAULT 1` 自增列 + 改 cloudfunc 缓存协议从 updated_at 戳 → version 整数

- 根因：EDGE-5 NTP 倒退理论隐患；version 严格单调避免时钟问题
- 收益：缓存协议鲁棒性升级
- 实现：UPSERT 时 `version = system_configs.version + 1`

---

## ⚠️ EDGE / 14-service-commission

**P0：commission_rate_matrix `服务单` 仅 2 条规则覆盖率 1.7%（21 市场 × 3 角色 × 3 sales_category 应有 ~189 组合，实有 2 条）→ runtime service.complete 命中"推广师 / 他销他耗 / 生态合作"任一即 silent rate=0**

- 位置：`commission_rate_matrix WHERE order_type='服务单'` 实测 PG 5434 仅 2 行：`美容师/自销自耗/0.12` + `养生师/自销自耗/0.12`；`fengyu-staff/cloudfunctions/staffApi/routes/service.js:L401-411` 查不到时 rate=0 + `operation_logs.action='service.complete.rate_missing'` 但**仅写日志不阻塞 INSERT**
- 现状：runtime service.complete operation_logs 共 3 行（HLD-WX-2603110001 / FY-FW-2603210001 / FY-FW-2604230001），对应 service_commissions 0 行（**调用了 3 次但 svcComm 产出 0 行**），commission_status NULL 残留 3 行
- 故障路径：① service_orders.status='已完成' 已转换；② service.js:L394 循环每个 row INSERT svcComm；③ 矩阵 0 行 → rate=0；④ employee_id IS NULL（`UDT_M_260.UDF_M_2472` 272 行 NULL；运行时 service_items.employee_id 也可能 NULL）→ INSERT 抛 23502 NOT NULL violation；⑤ 外层事务 ROLLBACK 但 status 已通过 service_orders.status='已完成' UPDATE 写入；**事务回滚后 svcComm 0 行 + service_orders 不变（在同一事务内全部 ROLLBACK）；但 operation_logs 在外部事务先写入 → operation_logs 3 行残留 + commission_status NULL 3 行**
- 业务影响：① 全部 21 市场推广师服务单 100% 提成丢失（runtime 路径）；② 任何 sales_category!='自销自耗' 的服务单 silent rate=0；③ 一旦放量后业务永久无感损失
- 修复：A 立即补 commission_rate_matrix 至完整 21 市场 × 3 角色 × 3 sales_category；B service.js INSERT svcComm 失败路径写 commission_status='分配失败'（详见 EDGE E6）；C 长期把 silent rate=0 改为 throw（业务侧需先确保矩阵齐全）；D audit cron 加 `service_orders.status='已完成' AND commission_status NULL` 告警

**P0：3 笔脏数据未做卫语句 — sess_used 99,769/100/999,999 致 commission_amount 9.99M~22.86M 直接写入 PG（合计 ~50M 影响 mgmt-dashboard 总额）**

- 位置：`db/scripts/migrate-service-records.js:L280-286` 直接传入 commission_amount，`L281` `Math.min(9.9999, ratio)` 仅 cap rate 不 cap amount
- 实测 MAX 5 笔：
  - SVCI-HLD-2409280171-2 / FY-230918001 / 22,864,061.73（sess_used=99,769 / unit_price=229.17）
  - SVCI-HLD-2602040360-0 / FY-250609002 / 11,755,596.00（sess_used=100 / unit_price=117,555.96 单价异常）
  - SVCI-HLD-2602040154-0 / FY-250116001 / 9,999,990.00（sess_used=999,999 / unit_price=10）
  - SVCI-HLD-2602040106-0 / FY-250728001 / 9,998,220.00（sess_used=999,822）
  - SVCI-HLD-2602040194-0 / FY-250116001 / 5,878,159.56（sess_used=999,687）
- 业务影响：① mgmt-dashboard 服务提成 SUM 含 22.86M，前 3 笔合计 ~50.5M 占总 84.13M 的 60%；② 员工 FY-230918001/FY-250609002/FY-250116001 个人绩效页面历史展示天文数字提成；③ archive 0018 兜底固化（fixed_fee=commission_amount=22M）
- 修复：A 一次性 UPDATE service_commissions SET commission_amount=...用 sess_used CAP 100 重算 WHERE commission_amount > 1,000,000；B migrate 脚本加 `if (sessionUsed > 100 || sessionUsed < 1) skip` 卫语句；C schema 加 CHECK `sale_items.session_count <= 100` + `service_items.session_used <= 100`；D 业务侧人工复核 11 行 commission_amount > 100k 的真伪

**P0：runtime service.complete 调用 3 次产出 0 行 svcComm + commission_status NULL 残留 — 事务边界 + employee_id NULL 双重静默失败**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:L394-449`
- 现状：operation_logs 3 行 service.complete + service_commissions WHERE allocation_ratio IS NOT NULL = 0 行 + service_orders WHERE commission_status IS NULL = 3 行（与 3 个 runtime 调用对齐）
- 故障路径：① service_items.employee_id IS NULL（svcComm employee_id NOT NULL）→ INSERT 抛 23502；② commission_rate_matrix 缺规则 → rate=0 + 写 operation_logs（在 INSERT svcComm 之前），事务 ROLLBACK 后 operation_logs 已脏数据进入；③ 外层 try/catch 吞错没有写 commission_status='分配失败'，导致 commission_status NULL 残留
- 业务影响：① 投产后 staffApi service.complete 100% 业务可能失效（取决于历史 employee_id NULL 比例）；② commission_status 三态破缺（schema 没定义"分配失败"）；③ 02-org `effectiveStoreId` mgr 规则在 mgmt-dashboard 中 hidden 也会一起放大
- 修复：A service.js:L394 加 guard `if (!row.employee_id) { 写 operation_logs+continue }`；B service.js INSERT svcComm 失败路径写 service_orders.commission_status='分配失败' + 抛错让 service_orders.status='已完成' 被回滚（要求 service.complete 全事务化）；C audit-role-type-nulls cron 加 `commission_status NULL AND status='已完成'` 检查；D schema 加 `CHECK (commission_status IN ('待分配','已分配','分配失败'))`

**P1：mgmt-dashboard 推广师 1,160 行 / 20,700.62 元 silent 剔除 + sale_allocations 推广师 127 名员工 vs svcComm 推广师 10 名员工严重不对齐**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:L349` `WHERE sc2.role_type IN ('美容师', '养生师')`
- 实测：visible 615,050 行 / hidden 1,160 行；hidden_amt = 20,700.62；销售侧 sale_allocations 127 distinct 推广师 vs 服务侧 svcComm 10 distinct 推广师
- 业务影响：① 数据看板"服务提成总额"少计 0.025%；② 推广师角色业务定义在销售/服务两个维度严重割裂，可能是销售侧抽推广师全员，服务侧仅 10 个老员工被错误标 role_type='推广师'
- 修复：A 业务侧明确推广师服务提成口径；B mgmt-dashboard 改 `role_type IN (SELECT role_type FROM commission_rate_matrix WHERE order_type='服务单')` 矩阵驱动；C role_type='推广师' 的 svcComm 10 名员工人工核对是否应改为美容师/养生师

**P1：admin batchSaveServiceCommissions UPDATE+INSERT 双步无 advisory lock，并发双调用脏读窗口**

- 位置：`fengyu-admin/src/actions/service-commissions.ts:L142-168`
- 故障路径：① 用户 A tx.UPDATE is_void=true → 还未 INSERT；② 用户 B 同时 tx.UPDATE is_void=true（UPDATE 已无效但不报错）+ tx.INSERT B 版本；③ 用户 A 继续 INSERT A 版本 → 同 service_order 不同 service_item 可绕过 uq → 多份合法
- 现状：admin 当前 commission_status='已分配' 0 行（运行时 0 调用），暂无实证；放量后必现
- 修复：tx 开头加 `SELECT pg_advisory_xact_lock(hashtext('svccomm:'||serviceOrderId))`

**P1：service_orders.commission_status 三态破缺 — NULL/待分配/已分配 缺 'rate_missing'/'分配失败' 状态**

- 位置：`db/schema/service.ts` commission_status 列定义为自由 text；service.js / batchSave / migrate 三路径写值不统一
- 实测：commission_status='待分配' 607,844 + NULL 3 + '已分配' 0
- 修复：见上 P0 第 3 条修复方案

**P2：commission_rate 分布 90% rate=1.0000 + 9.4% rate∈(1, 9.9999) — 字段语义在历史数据中已破损**

- 实测：rate=1.0000 共 554,721 行（unit_price=0 fallback + service_fee/unit_price=1.0 自然命中）；rate=9.9999 hard cap 1,364；rate∈(1, 9.9999) 共 58,132（service_fee>unit_price 异常）；仅 1,993 行 rate∈(0,1) 与"提成矩阵"语义重合
- 业务影响：commission_rate 字段在历史数据是"派生比例"非"提成比例"，admin 展示该字段误导用户
- 修复：admin UI 把 commission_rate 列从历史行清掉或改名"派生比例"

**P2：service_date 跨 7 年含 2055/2099 三笔脏数据**

- 实测：2028=2 / 2055=2 / 2099=1（WF 端 UDF_S_822 录入脏值未做 RANGE 校验）
- 修复：A migrate 脚本加 `WHERE UDF_S_822 BETWEEN '2010-01-01' AND DATEADD(YEAR, 1, GETDATE())`；B PG schema 加 CHECK service_orders.service_date BETWEEN '2010-01-01' AND '2030-12-31'

---

## 🔧 EXTEND / 14-service-commission

**P0.1** `service_commissions.is_gift boolean NOT NULL DEFAULT false` — 来源 `UDT_M_260.UDF_M_6902='是'`；估 17% 行 = ~104,756 需 true；与 05/service EXT-2 同源；当前 100% 视赠送行如正常，财务对账数据失真；migrate 脚本加抽取，admin 提成展示加标签，提成算法 is_gift=true 时 commission_amount=0

**P0.2** `service_commissions.satisfaction varchar(20)` — 来源 `UDT_M_260.UDF_M_842` 顾客满意度（满意/一般/不满意）；员工绩效评估强关联，admin 员工绩效页面"满意度分布"卡片；估 30%~50% 行有值；nullable

**P0.3** `service_commissions.position_name varchar(50)` + `position_seq varchar(20)` — 来源 `UDT_M_260.UDF_M_838`+`UDF_M_2473`；**根本性修复 role_type 派生路径双源不一致**（migrate=skills[0] / backfill=skills[1] / runtime=skills[0]）；与 08/commission EXT 同源；估 90%+ 覆盖率

**P1.1** `service_commissions.is_void_reason text` — 新系统作废原因，审计层回溯；0 行回填

**P1.2** `service_commissions.commission_kind varchar(20)` — 区分"固定手工费/消耗提成/拓客提成"；archive 0018 双字段崩，新增 kind 列保留语义；为推广师"拓客提成"独立类目铺路；616,210 行回填全部 'handicraft_fee'

**P1.3** `service_commissions.matrix_rule_id bigint FK→commission_rate_matrix` — 运行时 svcComm 命中的矩阵规则 id，可回溯 commission_rate 来源；service.js:L401-411 LIMIT 1 改为 RETURNING id；0 行历史回填

**P1.4** `service_commissions.duration_minutes int` — 来源 `UDT_M_260.UDF_M_840`（**workfine_database.md L689 标注"金额"是错的**，实测 99.997% 行 ≤ 300 分钟）；员工绩效"工时-收入比"卡片；与 service_items.service_duration 共源，svcComm 加列减少 JOIN

**P2.1** `service_commissions.item_count int` — 来源 `UDT_M_260.UDF_M_841`；估 ~5% 行 > 1（套餐/组合服务）

**P2.2** `service_commissions.legacy_filled_at timestamp` — 来源 `UDT_S_259.UDF_S_822`；冗余降低 mgmt-dashboard / staff.performanceDetail 三表 JOIN 链 -2

**P2.3** `service_commissions.legacy_card_validity_until date` — 来源 `UDT_M_260.UDF_M_7135` 拓客卡到期日；推广师提成统计可加"已过期卡"筛选；估 ~10% 拓客卡相关行有值

**总计 10 个**（P0×3 / P1×4 / P2×3）。WF 字段抽取覆盖率从 ~10% 提升至 ~40%（UDT_M_260 26 列中可用业务列 ~17 列，本次新增抽 7 列）。

---

## ⚠️ EDGE / 13-operation-log

**P2：cloudfunctions 11 副本入口生产 45 天 0 行实际产出**
- share-gift × 3 / settlePointsSafe × 3 / service.complete.rate_missing × 1 / dataIntegrity × 3 STEP / payNotify points × 1 — 共 11 个 INSERT 点位
- 数据：source=staffApi 4 行全部是 seed.ts demo（id 3/4/5/6，2026-03-10/11）；cronTask 仅 1 行真实产出（2026-04-25 customer.memberLevelChange）
- 影响：审计监控通道完全沉默，依靠 `WHERE action='points.balanceMismatch'` 等 SQL 做"系统健康巡检"的报表全部假阴
- 根因：上游业务链路全面未接通的下游征兆（与 10-points 49,072 单 0 积分流水 / 12-message 6/7 入口 17 天 0 写 / 09-coupon 4 路径 0 产出 同源）
- 处置：跟踪上游模块修复（10/12/09），本表无需独立修复

**P2：(target_type, target_id) 跨表语义污染**
- target_type='permission_role' 22 行中：14 行 target_id=employeeId（FY-xxx，permission.assign 路径）；8 行 target_id=数字 db row id（permission.revoke 路径）
- 影响：admin 后台按 (target_type, target_id) 聚类时把"角色行 id"和"员工 id"当同实体，伪同实体聚类
- 处置：`fengyu-admin/src/actions/permissions.ts:L279` revoke 改用 `targetId = employeeId`，permissionRoleId 移到 detail 字段

**P2：detail 明文 PII 泄露面**
- detail 含 phone 关键字 17 行 + idCard 11 行（store.update / employee.create 把手机号原文写进 detail）
- 影响：admin 后台日志查看页对操作员开放，不脱敏裸奔
- 处置：`fengyu-admin/src/lib/operation-log.ts` 增加敏感字段白名单或自动脱敏（138****8008）

**P2：unique 缺约束 — 双击落两行（id 243/244 detail 完全相同）**
- mall_product_sku.update bundlePrice null→0 双写（2026-04-07 10:16:57.241 + .741 同秒，detail 字符串完全相等）
- 影响：admin UI 防抖未守住时长期累积无意义重复行
- 处置：lib/operation-log.ts 增加 in-process 1秒去重 cache 或 partial unique index `(operator_employee_id, action, target_id, md5(detail::text))` WHERE created_at > now() - 5s

**P3：admin 路径 audit 不在主事务内（争议设计）**
- `fengyu-admin/src/lib/operation-log.ts:L61` `db.insert(operationLogs)` 用全局 db 而非事务 client；admin 业务事务 ROLLBACK 时 audit 行已独立 COMMIT
- 影响：可能形成"日志说做了但业务表没改"的反向 drift（幻影日志）
- 与 cloudfunctions 不一致：`service.js:L419` / `share-gift.js:L141` / `points.js:L114` 全用 `client.query`（事务内 INSERT）
- 处置：长期统一接 tx client；短期保留（业务失败不留痕反而是问题）

**P3：source enum schema 注释 stale**
- schema:L34 注释 `'staffApi / clientApi / adminApi'`，实际还有 `cronTask`（1 行）和未来 `payNotify`（代码已写 0 行）
- 处置：更新 schema 注释，或加 CHECK 约束 enum

**P3：detail._v 三套版本无 migration**
- V1=209 行（_v 缺失，2025-02 至 2026-04-23）/ V2 update=39 行 / V2 transition=17 行 / V3 transition=1 行
- V3 是 cron customer.memberLevelChange 独有 schema（含 direction/rolling12mSpend/trigger）与 V2 字段不兼容
- 处置：admin logs.ts 渲染层加 _v 分流；未来 V4 升级前先做 V1→V2 backfill

---

## 🔧 EXTEND / 13-operation-log

**P0 候选 3 个**

| 字段 | 类型 | 业务理由 |
|------|------|---------|
| `request_id` + 索引 | varchar(36) + btree | 跨表事务追踪：admin 一次 confirmPayment 涉及 sale_orders + sale_allocations + sale_items 多表 UPDATE 但 audit 只一行；接入后可串联同请求所有变更（含 cron 同 STEP 多顾客升级） |
| `client_ip` | varchar(45) | 安全审计基线：当前 0 IP 信息，越权或敏感变更（permission.assign / coupon.batchIssue）无法溯源外网入口 |

**P1 候选 5 个**：user_agent / result_status / error_code / pii_masked / entity_version
**P2 候选 3 个**：detail->>'_v' 表达式索引 / target_org_node_id / idempotency_key
**P3 候选 1 个**：prev_state_hash

**WF 反推 0 个**：MSSQL `tb_sys_log`（2,089,146 行）/ `tb_sys_workflow_task_log`（11,079 行）100% 平台层日志，业务关键字 LIKE 仅命中 22 行管理动作；R1 结论 R2 重判维持。

---

## ⚠️ EDGE / 15-pickup

**HIGH：staffApi `createPickup` 缺角色守卫 → 任意已绑定员工可写 picked_up_quantity + pickup_records**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2383-2444`
- 现状：函数仅 `await requireStaffBound()(ctx, async () => {})`，**不要求 manager 角色或权限位**
- 对比基准：admin `createPickupRecord` 走 `requirePermission(session, 'pickup_record:create')`（PERMISSION_MATRIX 仅 admin/manager 含此 action）
- 影响：员工端前端任何未来一次接入 createPickup 调用，普通门店 staff / beautician 即可绕过店长权限模型直接累加 picked_up_quantity 并写 pickup_records；与 order.create / order.confirmOffline 等"店长专属"接口设计不一致
- 验证：5434 现状 pickup_records=0 行 + 前端 grep 0 命中（probe PG.0 / PG.7），漏洞尚未被利用，但路由已部署一旦前端接入即生效
- 修复：函数头部加 `await requireManager()(ctx, async () => {})` 与同文件 createConversion / approveRefund 对齐

**HIGH：picked_up_quantity 双写一致性已被 staffApi createConversion 旁路破坏**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2230-2242`（转换单 `productType === '单品'` 分支）
- 行为：`UPDATE sale_items SET picked_up_quantity = quantity` 直接清零原"单品"卡可提余量，**不写 pickup_records 行**
- 不变量：`SUM(pickup_records.pickup_quantity GROUP BY sale_item_id) = sale_items.picked_up_quantity` 在转换链上**永久 < 右**（每次转换会让 picked_up 跳到 quantity 而记录端无对应行）
- 影响：admin `getPickupRecordsPaginated` 漏统计转换单消耗的"单品"数量；提货流水汇总与 sale_items.picked_up_quantity **永远对不上账**
- 5434 现状：probe PG.4 `sum_records_lt_picked_up=0` 仅因转换单与 pickup_records 双 0 行；转换业务启动即立刻浮现
- 修复（低成本）：在 createConversion 分支同步写一行 pickup_records 标 `remark='转换单清零'`；或加运维 audit SQL 每日 alert 左 < 右

**HIGH：sum(pickup) ≤ picked_up_quantity ≤ quantity 双侧不变量无 DB 兜底**

- 现状：admin/staffApi 两个入口在 UPDATE WHERE 子句里守住，但 schema 无 `CHECK (picked_up_quantity <= quantity)`，无触发器，无 partial unique
- 风险：任何手工 UPDATE / `db/scripts/migrate-*.js` 系列 backfill 脚本若误写 picked_up_quantity，可绕过应用层守卫直接破不变量
- 5434 现状：probe PG.4 `picked_up_over_quantity_si=0`，未发生；记入 best-practice gap

### 死代码 / 永不命中

- staffApi `order.createPickup` 路由已注册 + 测试有 5 用例，但前端 0 调用（grep `createPickup` `fengyu-staff/miniprogram/` = 0 命中）；已部署但生产从未触发（probe `operation_logs.target_type='pickup_record' source='staffApi'` = 0 行）
- admin `mergeClientProfile` 重挂 pickup_records.client_user_id 的 UPDATE 永远 rowCount=0（pickup_records=0 行）

### 运行时风险（已并入 15 / pickup_records 段补充，非高危但记入）

- admin `createPickupRecord` `logOperation()` 在 transaction 外执行（pickup-records.ts:L346），事务 commit 后进程崩溃即丢审计行；与"全审计"设计模型有 1 行偏差
- admin/staffApi 两入口对 store_id 的语义不同（admin 允许跨店表单选择 + isInScope 校验；staffApi 强制 ctx.auth.effectiveStoreId 本店）；如果 staffApi 前端接入后跨店提货成需求，需要补"提货门店选择"参数与 admin 对齐

## 🔧 EXTEND / 15-pickup

R1 + R1 复核 + R2 三轮重判一致："WorkFine 完全无 pickup 实体"，所有候选字段均**确认无 WF 反向源**（MSSQL 凭据已过期，但 R1 8 套关键字探针已穷尽）。本节字段全部为新业务/不变量补强，非 WF→PG 字段映射。

| # | 字段 | 优先级 | 类型 | 业务理由 | WF 源 |
|---|------|--------|------|----------|-------|
| 1 | `sale_items` 加 `CHECK (picked_up_quantity <= quantity)` | **P0** | DDL CONSTRAINT | 现两条入口靠应用层 WHERE 单语句守住，但 staffApi createConversion 已绕开 + schema 0 兜底；任何 backfill SQL 误写即破不变量 | 无候选 |
| 2 | `pickup_records.sale_order_id` | P1 | varchar(30) NOT NULL FK→sale_orders | admin 列表当前 2 跳 JOIN 拉订单号；跨店提货时无法直接按销售订单维度查；INSERT 时 SELECT 派生 | 无候选 |
| 3 | `pickup_records.product_snapshot` | P1 | jsonb | SKU 改名/下架后旧流水拉到错误信息；快照解耦时间漂移 | 无候选 |
| 4 | `pickup_records.delivery_method` | P1 | varchar(20) DEFAULT '到店自提' | 业务实务存在"到店自提 / 配送 / 邮寄"两条流；schema 0 字段承接 | 无候选 |
| 5 | `pickup_records.delivery_address` + `delivery_phone` | P1 | text NULLABLE × 2 | 搭配 #4，配送方式下需地址 | 无候选 |
| 6 | `pickup_records.confirmed_by_role` | P1 | text NULLABLE | 员工调岗后回查无法判断"当时谁有权限做这事"；快照避免审计困难 | 无候选 |
| 7 | `pickup_records.batch_id` | P2 | uuid NULLABLE | 一次性勾选 N 个明细全部提货；admin UI 重做时引入 | 无候选 |
| 8 | `pickup_records.cancelled_at + cancelled_by + cancel_reason` | P2 | 3 列 NULLABLE | 当前模型 INSERT 即终态无撤销路径；质量退回需手工 SQL | 无候选 |
| 9 | `pickup_records.client_phone_snapshot` | P2 | varchar(20) NULLABLE | client_user_id 可 NULL + client_wechat_users 可被合并；快照保留当时联系号 | 无候选 |
| 10 | `pickup_records.signature_url` | P3 | text NULLABLE | 合规手写签字；CloudBase COS URL | 无候选 |

**统计**：候选 10 个 / P0×1 / P1×5 / P2×3 / P3×1 / WF 反推命中 = 0

---

## ⚠️ EDGE / 10-points

**P0：消费链积分正式运行 0 命中（49,072 销售单 paid_amount≥100 但 0 流水）**

- 位置：5 个写入入口（`fengyu-admin/src/cron/steps/grant-{birthday,thanksgiving}-benefits.ts` + `refresh-member-levels.ts` + `fengyu-{client,staff}/cloudfunctions/{clientApi,staffApi}/utils/points.js` + `fengyu-client/cloudfunctions/payNotify/points.js`）
- 现状：5434 现状 `point_transactions` 0 行 / `client_wechat_users.points_balance > 0` 用户数 = 0 / `operation_logs WHERE action LIKE 'points.%'` = 0 行 / `points.settleFailed` = 0 行（说明 `settlePointsSafe` 一次都没被调用过，不是被 catch 吞错）
- 业务影响：① 顾客积分余额永远为 0 → client `points.balance` API 返回 0 → 顾客感知"无积分系统"；② member_level 升档时三件套权益里的"积分赠送"100% 失效；③ admin `/points` 页面永远空 + `distinctTypes` 下拉永远为空数组
- 根因候选（按可能性降序）：① migrate-* 历史回填脚本（订单/服务/卡）确认未补发积分（10-points.md L22 已标），所有 142,811 行历史订单是 batch import，积分流水从未补发；② 真实生产 wxpay/alipay webhook 自 2026-04-10 baseline reset 后未触发过任何成功支付；③ `POINTS_ACCRUAL_ENABLED=false` 环境变量被部署侧默认禁用；④ cron-worker 容器未启动 / STEP 2/3/4 未被 cron 触发
- 修复（顺序）：A `tcb fn invokefunction --name payNotify` 用真实订单 id 跑一次 dry-run 看是否 `feature-flag-disabled` 短路；B `docker exec fengyu-cron-worker node --conditions=react-server cron-worker.mjs --once` 看 STEP 5 audit 输出；C 写一次性补偿脚本 `db/scripts/backfill-points-from-orders.js` 扫描历史 sale_orders 调 `settlePointsForOrder` 回填（差值法天然幂等）

**P0：派生单 `ref_sale_order_id` 6 行全部 NULL，链净额计算依据缺失**

- 位置：5434 现状 `回款单`/`转换单`/`退款单`/`内部单` 共 6 行（4 转换 + 2 内部）全部 `ref_sale_order_id IS NULL`
- 故障路径：`utils/points.js settlePointsForOrder` SQL `WHERE sale_order_id=$1 OR ref_sale_order_id=$1` 上溯链路靠 `ref_sale_order_id`；现状 6 行无 ref → 派生单触发 settle 时 `SELECT FROM sale_orders WHERE sale_order_id=$1` 命中派生单本身，sale_order_type 不是 '销售单' → `return { skipped: 'order-type-...' }`，原销售单的 paid_amount 不被纳入链净额
- 业务影响：放量后所有派生单触发的 settle 路径默认 skip；admin/staff 退款分支 `routes/order.js:L1631 await settlePointsSafe(client, refSaleOrderId, ...)` 取自 `sale_orders.ref_sale_order_id` 列，**该列 NULL 时取到 undefined → settlePointsSafe 直接 return**
- 修复：A schema 加 `CHECK (sale_order_type = '销售单' OR ref_sale_order_id IS NOT NULL)`；B 一次性回填 SQL 把现有 6 行 ref 关联到原单（人工核对，量小可手工）；C cron-worker 加 STEP `audit-derived-orders-without-ref` 主动告警；D admin/staffApi 创建派生单的 SQL 必须强制 INSERT ref_sale_order_id

**P1：`type` 自由文本无 enum / CHECK 约束（archive 0016 退化遗产）**

- 位置：`db/schema/points.ts:L18` `type: text('type').notNull().default('获取')`；archive 0016:L57-58 把 enum 改 text + default '获取'
- 现状：5434 distinct_types 0 个值（无运行时数据，无对照基线）；schema default '获取' 永远命中不到（5 入口都显式传 type）
- 故障路径：①任意写入入口 typo（如 `'消费冲销'` 写成 `'消费冲消'`）→ admin 下拉多一条新值、refunds.ts FIFO 算法仍按 amount<0 全聚合无副作用，但**新人重写积分逻辑时不知道命名约定**；②如果有人手工 INSERT 不传 type，会写一条 type='获取' 的流水**与 5 个已知值脱节**
- 业务影响：当前 0 行 → 0 错算；放量后任何一次 typo 永久污染 distinctTypes 下拉
- 修复：A schema 加 `CHECK (type IN ('生日积分','感恩回馈','等级升级奖励','消费赠送','消费冲销'))` 或回归 enum；B 删除 `default '获取'`（永远命中不到的"假语义" debt）；C admin/cloudfunctions/utils 加导出常量 `POINT_TXN_TYPES`，所有 INSERT 强制引用常量

**P1：`refunds.ts` FIFO 归属算法把 `'消费冲销'` 也算成"升级奖励消耗" → 高估 suggestedOverdraftDeduction**

- 位置：`fengyu-admin/src/actions/refunds.ts:L406-413` `usedPointsSince = SUM(-amount) WHERE amount < 0 AND created_at >= upgradedAtThreshold`；`amount<0` 包括 ① 顾客主动用积分抵扣（未实现）② 退款触发的 `'消费冲销'`
- 故障路径：顾客升级 → 销售单 1000 元（积分=10）→ 退款触发 `'消费冲销' amount=-10` → admin 跌档计算时把这 10 算成"升级奖励消耗" → suggestedOverdraftDeduction 高估
- 现状：当前 0 行流水 → 0 错算；放量后只要 `'消费冲销'` + 跌档同时发生就触发
- 修复：A refunds.ts SQL 加 `AND type NOT IN ('消费冲销')` 过滤；B 长期方案 EXTEND P0.2 加 `balance_after` 后可直接对比"升级时刻 balance"和"当前 balance"差值，无需 FIFO 近似

**P1：`settlePointsSafe` 内 `INSERT operation_logs` 共享主事务 client，主事务 abort 时 error log 也丢失**

- 位置：3 副本一致 `utils/points.js:L94-104`（client/staff/payNotify）
- 故障路径：`catch (err)` 后 `client.query('INSERT operation_logs ...')` 在同一个 pg client（即同一事务），如果上层已让事务进入 abort 状态，再 INSERT 会抛 `current transaction is aborted`
- 业务影响：`points.settleFailed` 永远不会被记录、外层 try/catch 静默吞掉 → 排查现场缺失
- 修复：用独立连接（payNotify 已有 pool，可拿独立 client）写 `points.settleFailed`，与主事务解耦

**P2：`type='获取'` schema default 永远命中不到的"假语义" debt**

- 位置：`db/schema/points.ts:L18` 与 archive 0016 的 ALTER TYPE 残留
- 修复：删 `default '获取'`，notNull 维持，靠应用层校验

---

## 🔧 EXTEND / 10-points

**字段扩展候选（P0 = 2、P1 = 4、P2 = 4，详见 `10-points.md ## 字段扩展建议 R2`）**

R2 重新探查 MSSQL 后**复现 R1 结论**：WF 完全无积分实体可抽，5 维探针（列描述 / 列名 / 表名 / 等级语义 / 赠送语义）全部 0 命中或全部命中无关 SaaS 平台字段。所有扩展候选 100% 新系统独立设计，**不存在"WF 有但抽不出"的失败候选**（这与 09-coupon 的 UDT_S_209 反推机会不同）。

- **P0.1** `point_transactions.type` 收紧为 enum 5 值（`'生日积分'`/`'感恩回馈'`/`'等级升级奖励'`/`'消费赠送'`/`'消费冲销'`）；archive 0016 退化遗产；现 0 行转换零成本；**最终迁移强烈建议带上**
- **P0.2** `point_transactions.balance_after` integer NOT NULL — 写入时累计余额行级缓存；流水 + 余额双源真相缺失，便于审计 + 跌档退款 FIFO 算法升级；5 入口三副本同步加 `balance_after = (SELECT COALESCE(MAX(balance_after),0) FROM ...) + amount`
- **P1.1** `point_transactions.ref_sale_item_id` text — 关联到 sale_items 行级，配套高危 #2 派生单 ref 修复 + 卡分录退款细到 item 级
- **P1.2** `point_transactions.idempotency_key` text + UNIQUE — 与 external_ref 互补；将来"积分商城兑换"或"主动抵扣"路径需要统一调用键
- **P1.3** `point_transactions.granted_by_employee_id` text FK — admin 手工调整流水溯源
- **P1.4** `point_transactions.note` text — 审计补充说明，type 收紧 enum 后子原因描述
- **P2.1** `point_transactions.expire_at` timestamp — 积分过期机制（行业惯例 1-2 年）；当前积分**永不过期**
- **P2.2** `point_transactions.amount_yuan_value` numeric(10,2) — 写入时快照"等价人民币"，避免 `points_to_yuan_rate` 配置变更后历史流水失真
- **P2.3** `client_wechat_users.points_lifetime_earned/spent` integer × 2 — 累计赚/花缓存，配合 03-user `total_spend_cache` 维护方式
- **P2.4** `point_transactions.source` enum('cron','clientApi','staffApi','payNotify','admin') — 写入路径来源标记，与 operation_logs.source 平行

**总计 10 个候选**（P0×2 / P1×4 / P2×4），无 P3（放弃档），因为 WF 完全无源所有候选都是新系统独立设计。

---

## ⚠️ EDGE / 11-prepaid-card

**HIGH：27 组 (card_id, type='充值', ref_order_id) 三元组重复 — 38 行重复流水合计 ¥35,692.80（schema 缺 UNIQUE 兜底）**

- 位置：`db/schema/prepaid-card.ts:L31-48` `card_transactions` 仅有 `idx_card_txns_card_id` 普通索引，无 UNIQUE 约束
- 探针：`db/.tmp-probe-r2-11.js` 4.3/4.4/4.6/12.2 — 27 组重复，全部对应 WorkFine 历史导入订单含 2-4 个充值类 sale_items；FY-XSD2503180007 单订单 4 充值 sale_item / FY-XSD2401140029 3 个；重复行 created_at 间隔 0.000000 秒（同事务内同时刻）；amount 不同（500/100、590/6、180/20 等）→ 即多个 sale_items 都被写入了流水
- 故障路径：①migrate-prepaid-cards.js:L188-191 幂等键 `(card_id, type='充值', ref_order_id)` 粒度不到 sale_item_id，当 1 sale_order 多 sale_item 时只该写一次但实际写多次 ②运行时 payNotify L255 / staffApi confirmOffline L947 / admin refunds L878 / staffApi createRepayment L1828 / staffApi createConversion L2288 全部用同款幂等 SELECT，无 UNIQUE 兜底，并发回调可双写
- 业务影响：当前 38 行冗余对账无碍（migrate-prepaid-cards UPSERT EXCLUDED.balance 覆盖式，与 SUM(amount) 巧合相等，探针 5.1 不一致 0 行）；但运行时 wx 网关 retry 0.5s 内重发同回调，两笔 BEGIN 都通过 dupCheck → 都 INSERT → balance 累加两次 → **真实资损**
- 修复（顺序）：A 一次性 SQL `DELETE FROM card_transactions WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY card_id, type, ref_order_id ORDER BY id) AS rn FROM card_transactions WHERE (card_id, type, ref_order_id) IN (SELECT card_id, type, ref_order_id FROM card_transactions WHERE type='充值' GROUP BY 1,2,3 HAVING COUNT(*)>1)) t WHERE rn>1)`；B schema migration 加 `CREATE UNIQUE INDEX uq_card_txns_dedupe ON card_transactions (card_id, type, ref_order_id)`；C 6 处运行时入口 `SELECT 1 ... LIMIT 1` 改为 `INSERT ... ON CONFLICT (...) DO NOTHING RETURNING id` 真正原子幂等

**HIGH：1 张运行时充值订单 FY-XSD-WX-2604160002 status='已支付' ¥2500 但 0 充值流水（payNotify 漏写）**

- 位置：`fengyu-client/cloudfunctions/payNotify/index.js:L243-292` 充值入账分支
- 探针：8.2 — sale_order_id='FY-XSD-WX-2604160002' / client_user_id='FYGK-20260314-00001' / total_amount=2500.00 / status='已支付' / sale_items '金卡充值卡' 1 行 / 该 user 同时有另一张 prepaid_card='41af639b-…' balance=¥7378.52（来自后续订单 FY-XSD-WX-2604160004 ¥6378.52 + 抵扣测试，详见探针 4.7/7.2）
- 故障路径推测：①payNotify L246-250 SQL JOIN product_categories 当时该 SKU 关联 category 的 product_kind 不是 '充值卡'（schema 漂移）②或该订单走的是 admin/orders.ts:L80 `applyRechargeOnOrderPaid` 路径而 4-16 时间点该函数有 bug ③或 sku_id 是虚拟 SKU 但 RECHARGE_VIRTUAL_SKU_ID 常量未匹配
- 业务影响：顾客 FYGK-20260314-00001 充了 ¥2500 金卡但 prepaid_cards.balance 没记 → 业务方对账差 ¥2500，顾客投诉风险
- 修复：A 一次性 SQL 补 1 行流水 + UPDATE balance += 2500（业务方确认未线下补过的前提下）；B cron-worker 加 STEP 6.5 主动告警 `JOIN product_categories ... WHERE pc.product_kind='充值卡' AND so.status='已支付' AND NOT EXISTS (SELECT 1 FROM card_transactions WHERE ref_order_id=so.sale_order_id AND type='充值')`；C payNotify L246-250 三层兜底 `WHERE pc.product_kind='充值卡' OR si.sku_id=$RECHARGE_VIRTUAL_SKU_ID OR si.product_name LIKE '%充值%'`

**HIGH：schema 缺 CHECK 约束 — `prepaid_cards.balance >= 0` + `card_transactions.amount` 符号匹配 type**

- 位置：`db/schema/prepaid-card.ts:L19/L40` 仅 `numeric(10,2).notNull().default('0')`，无 CHECK
- 现状：探针 2.1 balance min=0.80 max=¥41,000（无负），但 schema 不守
- 故障路径：admin 跨表手工 SQL（如 admin/refunds.ts:L884 INSERT 而非 UPDATE）若误写为 UPDATE balance = balance - amount 时 amount > balance → 负余额；schema 注释 L39 写 "topup 为正，deduct 为负" 但 0 行扣款数据无法验证
- 修复：migration 加 `ALTER TABLE prepaid_cards ADD CONSTRAINT chk_balance_non_negative CHECK (balance >= 0)` + `ALTER TABLE card_transactions ADD CONSTRAINT chk_amount_sign CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0))`

**P1：migrate-prepaid-cards.js 4 关键字 LIKE 命中漏 200+ 行（充卡/充值ym/微电充值 等）**

- 位置：`db/scripts/migrate-prepaid-cards.js:L57-62` 关键字 `%充值% / %储值% / %预存% / %余额%`
- 探针：9.7 显示 199 行 product_name='充卡' / 7 行 '充值ym' / 3 行 '微电充值' / 155+130 行 '诚意金' 业务侧多用作"代言卡定金"是否充值类需业务确认
- 业务影响：本应建卡的 200+ 行漏过；但探针 12.1 显示 0 user 漏（即关键字命中的 user 全部已建卡）→ 这部分 user 同时有其他命中关键字的卡，所以 user 维度无丢失；但**单卡 balance 丢失**（顾客可能 ¥500 命中关键字 + ¥199 充卡 漏 → balance 只记 ¥500）
- 修复：最终迁移加关键字 `%充卡% / %充值卡% / %预存金% / %会员充值%`；业务方确认 `诚意金` 是否充值类后决定是否纳入

**P1：130 行已过期（expire_date < NOW()）但 remaining_sessions > 0 的 sale_items 已被派生进 prepaid_cards.balance（违规）**

- 位置：`db/scripts/migrate-prepaid-cards.js:L38-64` SELECT 不过滤 expire_date（仅过滤 remaining_sessions > 0）
- 探针：9.2 — 3132 行充值类 sale_items 中 130 行 expire_date < NOW() 但 remaining_sessions > 0 仍被聚合进卡余额；16 行 expire_date='1899-12-31' 哨兵脏值；56 行 expire_date > 2099 永久卡哨兵
- 业务影响：顾客余额"已过期但仍可用"违背 WorkFine 原约束（migrate-active-cards.js L116 是有 expire_date 过滤的，本脚本独立链路忘了加）
- 修复：A schema 加 `prepaid_cards.expire_date timestamp` 列（见 EXTEND P0.1）；B migrate-prepaid-cards.js 加 `AND (si.expire_date IS NULL OR si.expire_date > NOW())` 过滤；C 业务方决策：① 失效已过期卡 ② 协议改"无限期"

---

## 🔧 EXTEND / 11-prepaid-card

**字段扩展候选（P0 = 1、P1 = 5、P2 = 4，详见 `11-prepaid-card.md ## 字段扩展建议 R2`）**

- **P0.1** `prepaid_cards.expire_date timestamp` — 来源 `UDT_M_213.UDF_M_7122`（已落到 sale_items.expire_date）；migrate-prepaid-cards.js 取组内最早 sale_item MIN(expire_date)；2125 张活卡的 130 张实际已过期仍被算入余额，schema 完全无 expire 概念违背 WorkFine 原约束
- **P1.1** `card_transactions.sale_item_id varchar(30) FK→sale_items` — 来源 `UDT_M_213.UDF_M_852`（已落到 sale_items.sale_item_id）；解决 EDGE E1 幂等键粒度问题；27 组重复就是因为 (card_id, ref_order_id) 不够细
- **P1.2** `prepaid_cards.card_name text` — 来源 `UDT_M_213.UDF_M_393` 第一个 sale_item 的 product_name；"2024 福利预存款 / 金卡充值卡 / 预存金" 等命名差异，UI 展示"哪张卡剩多少"必需
- **P1.3** `card_transactions.is_gift boolean` — 来源 `UDT_M_213.UDF_M_4939='是'`（已落到 sale_items.is_gift）；赠品卡 fallback 链 ②/③ balance 失真，admin 退款时需区分"现金购买可退" vs "赠品不可退"
- **P1.4** `prepaid_cards.face_value numeric(10,2)` — 来源 `UDT_M_213.UDF_M_395` 累加（已落到 sale_items.sale_amount）；balance 是剩余，face_value 是历史累计充值额，UI "已使用 ¥N / 共 ¥M" 必需
- **P1.5** `card_transactions.original_amount numeric(10,2)` — 派生：充值时 = sale_items.received（实付现金）/ 扣款时 = 0；区分"赠品币" vs "现金币"，退款只退现金部分
- **P2.1** `prepaid_cards.first_recharge_at timestamp` — 同 created_at 但 0003 migration 合并卡时 created_at 取 MIN，不显式加列在未来再合并时易丢失
- **P2.2** `card_transactions.operator_employee_id text FK→staff_wechat_users` — 运行时 ctx.auth.staffWfId，历史脚本 NULL；审计"谁帮顾客充的卡 / 谁帮扣的"
- **P2.3** `prepaid_cards.last_used_at timestamp` — 派生 `MAX(card_transactions.created_at WHERE type='扣款')`；数据看板"沉睡储值卡"（≥6 月未消费）指标
- **P2.4** `card_transactions.balance_after numeric(10,2)` — 每行写入时的 prepaid_cards.balance 快照；流水审计单行还原"扣款后余额是多少"，无需 SUM(amount) 反算

---

## ⚠️ EDGE / 12-message

**P0：share-gift 三副本写 `ref_entity_type='sale_order'` 但客户端跳转判断 `record.refEntity === 'order'` 字符串不等 → 分享礼消息点击跳订单详情 100% 失败（运行时 bug）**

- 位置：
  - 写：`fengyu-client/cloudfunctions/payNotify/share-gift.js:133`、`fengyu-client/cloudfunctions/clientApi/share-gift.js:133`、`fengyu-staff/cloudfunctions/staffApi/share-gift.js:133`（三处一致写 `'sale_order'`）
  - 读：`fengyu-client/miniprogram/pagesProfile/messages/messages.ts:114` `if (record.refEntity === 'order' && record.refId)`
- 实测（2026-04-26 5434）：messages 当前 0 条 share-gift 行（生产 0 写入），暴露在生产前修复成本最低
- 修法二选一：① 改 3 副本写 `'order'`（破坏 schema 注释 L24 表名规范）；② 前端兼容判断 `(record.refEntity === 'sale_order' || record.refEntity === 'order')`。**推荐 ②**

**P0：cron 三 STEP（升级/生日/感恩）写消息时 `ref_entity_type/id` 全 NULL → 客户端跳详情逻辑无 case → 永远走 else 即"点击无反应"**

- 位置：cron `refresh-member-levels.ts:239` / `grant-birthday-benefits.ts:112` / `grant-thanksgiving-benefits.ts:128` 三处 INSERT 不含 ref_entity_type/id；前端 `messages.ts:114-118` 仅 case `'order'`/`'appointment'`
- 修法：cron 三 STEP 加 `ref_entity_type='customer', ref_entity_id=userId`；前端补 `case 'customer': navigateTo /pagesProfile/profile-edit`

**P0：`recipient_type='员工'` enum 值死分支 — 7 个写入入口 0 个写员工，staffApi 无 message 路由，但 admin getMessagesPaginated/JOIN/筛选 UI 已实现**

- 实测：PG 5434 全表 0 行 `员工`；`grep -rn "recipient_type.*员工\|recipientType.*员工" cloudfunctions/ src/cron/` 0 命中（admin batchSend 显式 `recipientType: '客户' as const` 拒绝）
- 决策点：① 删 `员工` enum 值 + admin 相关 UI；② 落地员工消息（staffApi 加 message 路由 + 至少 1 触发器）

**P0：6/7 个生产入口在 PG 5434（baseline reset 17 天）0 写入 — cron 三 STEP / share-gift 三副本 / admin batchSendMessages 全空**

- 实测：messages 当前 1 行（id=2 title='测试' body='测试' recipient='FYGK-20260314-00001' created_at=2026-04-09，手工测试残留）
- 与 10/points 同源症状；运维侧需提供 cron-worker 容器 17 天 stdout / payNotify 30 天调用次数 / admin /messages 页是否有过点击 三道证据
- 暴露问题：是 cron-worker 没启动 / system_configs.member_level_benefits.messageTitle 缺失 / 还是分享链路从未触发？三种根因要求三种修法

**P1：admin batchSendMessages 接受任意 messageType 字符串（仅 length≤50 校验）→ 客户端 TYPE_COLOR_MAP 仅识别 `appointment/order/system` 三键，运营写 `'活动'/'优惠'/'公告'` 全部静默降级为灰图标**

- 位置：`fengyu-admin/src/actions/messages.ts:407-410` 仅长度校验；`fengyu-client/miniprogram/pagesProfile/messages/messages.ts:8-18` TYPE_COLOR_MAP 三键
- 修法：admin actions 加 messageType enum 校验 + UI 改下拉

**P1：messages 无应用层 title 非空守卫（仅 schema NOT NULL）— cron 三 STEP `if (config.messageTitle)` 不防全空格 `'   '`**

- 位置：`refresh-member-levels.ts:237` / `grant-birthday-benefits.ts:109` / `grant-thanksgiving-benefits.ts:125` 均 `if (config.messageTitle)`
- 实测：PG 当前唯一行 title='测试' 无问题；建议加 schema CHECK `length(trim(title)) > 0`

**P1：admin getMessageTypes 跑 `SELECT DISTINCT message_type FROM messages` 无 LIMIT 全表扫；`messageType` / `dateFrom..dateTo` 筛选无索引**

- 位置：`fengyu-admin/src/actions/messages.ts:160-167`
- 当前数据量 1 行无影响；产品上线 N 万行/月增长后 admin 列表筛选会拖慢

**P1：admin batchSendMessages 分片 500 写入未包事务 → 前 500 成功后失败，已发出去的不可回滚 + 仅成功才写 audit log**

- 位置：`fengyu-admin/src/actions/messages.ts:471-484`（CHUNK 循环外无 BEGIN/COMMIT）
- 修法：包在 `db.transaction(...)` 内 + try/catch 包 logOperation 也写失败日志

**P2：唯一行 id=2 title='测试' body='测试' 是手工测试残留 — 上线前应 `DELETE FROM messages WHERE id=2 AND title='测试'`，否则客户首次进消息中心看到"测试"**

**P2：admin deleteMessage 物理删除无 expectedUpdatedAt 乐观锁（因表无 updated_at 列）— 并发同 id 删可能出现"提示删除成功但 result.count=0"状态紊乱**

- 位置：`fengyu-admin/src/actions/messages.ts:179-184`

**8 维命中**：FK 孤立 ❌干净 / NULL 极值 ⚠️P1 / enum 漂移 ⚠️P0 / unique ❌干净（数据量=1 未实证） / 跨模块一致性 ⚠️P0 / 死代码 ⚠️P0 / dump 残留 ⚠️P2 / 运行时安全 ⚠️P1（共 6/8 命中）

---

## 🔧 EXTEND / 12-message

**WF 复核结果**：MSSQL 凭据已过期（账户密码失效），回退至 `notes/research/workfine_database.md` 全文检索关键词 `消息/notification/通知/message/站内/公告/短信/sms/push/提醒` **0 命中**。R1 结论"WF 完全无消息实体"在 R2 维持不变。**0 字段从 WF 反推**，全部候选基于"产品形态走向生产"反推。

**P0（2 个）**：

1. **`messages.read_at TIMESTAMP NULL`** — 现状 is_read 翻转无时间戳；表无 updated_at；admin 审计 / 数据看板"打开率/打开时长"全无法做。改 `clientApi/routes/message.js:read` 加 `read_at=NOW()`；现存 1 行回填 `read_at=created_at`
2. **`messages.priority SMALLINT NOT NULL DEFAULT 0`** — 值域 0 普通 / 1 高 / 2 系统强制弹窗。cron 升级=2 / 生日=1 / 感恩=1 / share-gift=1 / admin 默认 0。客户端列表 orderBy 改 `priority DESC, created_at DESC`

**P1（4 个）**：

3. **`messages.expires_at TIMESTAMP NULL`** — share-gift 通知含"X 天后过期"信息但消息永不过期挂在列表里；cron 生日权益月初发也有时效。share-gift 副本可直接复用已计算的 `expireAt`
4. **`messages.action_url TEXT NULL` / `messages.action_payload JSONB NULL`** — 当前点击跳转**硬编码**前端，新增任何业务消息都要改前端。改为后端写 action_url，前端通用 `if (record.actionUrl) navigateTo(record.actionUrl)`
5. **`messages.recipient_type` enum 值 `员工` 落地** — 决策依赖产品方；推荐 staffApi 加 message 路由 + 至少 1 个员工触发器（审批/解绑/月度业绩）
6. **`messages.message_type` 升级为 enum** — 当前 varchar(50) 任意字符串。改为 `pgEnum('message_type', ['system','order','appointment','service','points','coupon','prepaid_card','share_gift','activity'])`；前端 TYPE_COLOR_MAP 同步扩 9 键

**P2（2 个）**：

7. **`messages.sender_type / sender_id`** — admin batchSendMessages 仅写 operation_logs(operator_employee_id) 但 messages 表本身不知是哪个 admin 发的；客户消息中心永远显示"系统消息"
8. **`messages.tenant_store_id TEXT NULL`** — admin getMessagesPaginated 显式说"messages 表无 store_id 不走 scope"；产品上线后店长想查"我门店顾客的消息流水"无法 scope；可从 `client_wechat_users.bound_store_id` 派生

**P3（1 个）**：

9. **`messages.delivery_channel SMALLINT`** — 位标记 in-app=1 / wechat-subscribe=2 / sms=4。当前 1 通道默认 1；提案性候选，未来接微信订阅消息或短信通道时再加

**总扩展候选 9 个**（P0×2 / P1×4 / P2×2 / P3×1），**0 个 WF 反推**。

---

## ⚠️ EDGE / 09-coupon

**P0：1 行已使用券对应订单已关闭但券未释放（订单生命周期不变量破缺）**

- 位置：PG 5434 现状 `user_coupons.coupon_id='cpn-1776947619987-9gjv'` `status='已使用' used_sale_order_id='FY-XSD-WX-2604230004'`，对应 `sale_orders.status='已关闭'`
- 故障路径：clientApi `routes/order.js:L1051` / staffApi `routes/order.js:L1093` 订单关闭释放 `UPDATE user_coupons SET status='未使用' WHERE used_sale_order_id=$1` 在事务内，**应该被命中**，但当前 PG 该券状态仍 '已使用'
- 推测：① 订单是 admin 后台/手工 SQL 关闭，未走云函数路径；② 关闭路径走的是其他分支（refund / closeFailed），未释放券
- 修复（顺序）：A 加 cron-worker 一致性检查 STEP — `SELECT uc.coupon_id, so.status FROM user_coupons uc JOIN sale_orders so ON so.sale_order_id = uc.used_sale_order_id WHERE uc.status='已使用' AND so.status IN ('已关闭','已退款')` 主动告警；B 一次性 SQL 修复 `UPDATE user_coupons uc SET status='未使用', used_sale_order_id=NULL, used_at=NULL FROM sale_orders so WHERE uc.used_sale_order_id=so.sale_order_id AND uc.status='已使用' AND so.status='已关闭'`；C admin 后台所有"关闭订单"按钮统一走云函数路径而非直 SQL

**P1：admin issueCoupon 不校验目标 expireAt 是否已过期 → 1 张"出生即死"券**

- 位置：`fengyu-admin/src/actions/coupons.ts:L549-560 issueCoupon`，`L686-699 batchIssueCoupons`，校验只 reject 模板配置异常（valid_to 缺失），不 reject `tpl.valid_to < NOW()`
- 实测：1 张 `cpn-1774320039573-rlma` 创建于 2026-03-24，expire_at=2026-03-15（来自模板 `coupon-tpl-003.valid_to`）即 created 比 expire 晚 8 天 → 立刻 status='已过期'
- 业务影响：顾客收到一张刚发就过期的券，UX 事故 + 客服压力
- 修复：A `coupons.ts:L552-553`（issueCoupon）改为 `expireAt = new Date(tpl.valid_to); if (expireAt <= new Date()) return { success: false, message: '模板有效期已过，请先延长 valid_to 再发放' }`；B 同步修复 batchIssueCoupons L691-693；C admin UI 列表过滤"已过期模板"提示停用 + 隐藏发放按钮

**P1：`coupon-tpl-003` 模板已过期 12 天但 is_active=true**

- 位置：PG 5434 `coupon_templates.template_id='coupon-tpl-003'` valid_to='2026-04-14'（已过 12 天） is_active=true
- 故障路径：admin issueCoupon 只检查 `is_active`，不检查 `valid_to < NOW()` → 仍可继续发券（与上一条配套）
- 修复：A 加 cron 每日 03:05 STEP → 自动 `UPDATE coupon_templates SET is_active=false WHERE validity_mode='fixed' AND valid_to < NOW() AND is_active=true`；B admin issueCoupon/batchIssueCoupons L519-524 / L645-650 加 `tpl.validity_mode === 'fixed' && tpl.valid_to < NOW()` 第二道闸门

**P1：admin batchIssueCoupons 不校验同顾客同模板已发未使用券数量**

- 位置：`coupons.ts:L703-714` 批量 INSERT 直接 `phones.map`，无 SELECT COUNT 守卫
- 实测：1 顾客 (`FYGK-20260314-00001`) 持有同模板 (`f5b79e11e0d34e77` 50 元代金券) 3 张未使用券
- 业务影响：UX 乱（前端列表显示 3 张同名券） + 库存浪费（一单只能用 1 张）
- 修复：A 在 L668-672 phone batch 查询后追加"同模板已发未使用 COUNT"查询，超过阈值（默认 1）报错；B 长期方案见 EXTEND P2.1 — schema 加 `coupon_templates.max_per_user` 列（fengyu-admin/src/actions/coupons.ts L703-714）

**P1：`applicable_*_ids` text[] 设计层无 FK / 无 DB 约束（4 个字段：product/category/store/market）**

- 位置：`db/schema/coupon.ts:L23-30` 全部 `text('applicable_*_ids').array()`
- 故障路径：admin 删除/重命名下游主键（`products.product_id` / `product_categories.category_id` / `stores.store_id` / `org_nodes.id`）不会自动失效模板的引用数组 → 静默偏差（券显示"全场可用"或"门店无效"）
- 现状：5434 现状 0 行 dangling，但**这是因为 admin 还没人改过下游主键**，不等于设计安全
- 修复：A 一次性扫描器 `db/scripts/coupon-applicable-refs-audit.sql` 周期跑（cron 每周）→ dangling 出现告警；B 长期方案：把 4 个字段拆出 `coupon_template_*_scope` 关联表（FK + ON DELETE CASCADE），但**改造工作量大、当前 0 行 dangling、数据量小**，可暂缓。短期靠 audit + 业务规约（admin 删品类前要先 SELECT 引用了它的模板）

**P1：4 行 user_coupons.used_at < created_at 时序破缺**

- 位置：admin issueCoupon 主路径，4 行 `cpn-*` admin 命名空间
- 故障路径：admin 给已下单顾客补发券（顾客已用券下单→还要补开发票/重走 sale_order）
- 业务影响：审计时序破坏；refunds.ts redownGradeReverseDiff 算"升级期内已用券价值"按 used_at 过滤会包含这些"反向时序券" → 降档处罚不准确
- 修复：A admin issueCoupon 加 SELECT 守卫"目标顾客近 24h 是否有 sale_order 关联同模板的券" → 警告；B 长期方案：拆 EXTEND P2.4 `granted_by_employee_id` 字段后，审计层可识别"补发"操作并打标记

**P2：admin `calcCouponDiscount` vs client/staff `coupon.available` 浮点取整不一致**

- 位置：`fengyu-admin/src/lib/utils.ts:L48` `Math.min(dv, totalAmount)` 不取整 vs `routes/coupon.js:L211` `Math.round(discount * 100) / 100`
- 故障路径：折扣券精度边界（如 0.7 折 × 333.33 元 = 99.999）admin 显示 99.999，client/staff 落 100.00 → admin 列表"金额不一致"误导
- 实测：当前 1 行折扣券模板（`coupon-tpl-003`）已过期未发券，0 行实际触发；但分享礼放量后 face_value_override × 折扣计算会触发
- 修复：admin `calcCouponDiscount` 末尾加 `return Math.round(result * 100) / 100`

**P2：cron 三 STEP（生日/感恩/升级）+ 分享礼三副本 4 写入路径所有代码已写但 0 产出 / 0 覆盖**

- 位置：`fengyu-admin/src/cron/steps/grant-{birthday,thanksgiving,refresh-member-levels}.ts` + `fengyu-{client,staff}/cloudfunctions/{clientApi,staffApi,payNotify}/share-gift.js`（三副本字节级一致）
- 现状：PG 5434 user_coupons 17 行全部 `cpn-*` 命名空间，无任何 `bday-/thx-/cpn-up-/sg-` 行（详见 09-coupon.md `## Edge Case 报告 R2 §6`）
- 根因：`system_configs.share_gift_config` 不存在（admin UI 已开发但业务方未启用） + `system_configs.{member_level_benefits,birthday_benefits,thanksgiving_benefits}` 的 `couponTemplateIds` 数组全为空（archive 0033 seed 时 5 个等级全空）
- 业务影响：未发现的功能性 bug 在 0 用例覆盖下永远不暴露；放量后第一波生产数据可能集体踩坑
- 修复：A 业务方在 admin 后台启用 `/share-gift` 配置 + 5 个会员等级各 benefits 配置至少 1 个 couponTemplateId；B 加 e2e 测试断言（`@admin/e2e/cron-grant.spec.ts` 模拟 cron 单次执行后断言 user_coupons 行数 > 0）

**P2：懒清扫 UPDATE 在主路径独立执行 + 索引未启用**

- 位置：`coupon.list / coupon.available` 三处入口（client+staff），`UPDATE user_coupons SET status='已过期'` 在 `pg.query` 而非 transaction
- 故障路径：当前小流量无问题；放量后写入热点 + idx_user_coupons_user_status 索引已存在但 pg_stat 显示 idx_scan=0（17 行小表自然走 seq_scan，**不能作为索引验证**）
- 修复：A cron-worker 加 `sweep-expired-coupons.ts` STEP（每日 03:10 集中清扫）→ 列表入口仅 `WHERE expire_at > NOW()` 二次过滤；B 放量后用 `pg_stat_user_indexes` 复查索引使用率

---

## 🔧 EXTEND / 09-coupon

**字段扩展候选（P0 = 0、P1 = 5、P2 = 4，详见 `09-coupon.md ## 字段扩展建议 R2`）**

R2 重新探查 MSSQL 后**修订 R1 结论**：WF 端无 user-coupon 实例级数据（无 coupon_id/template_id/状态/过期时间）这一结论不变，**但** UDT_S_209 三个销售单级金额字段（17190/17216/17194）按 customer_id (UDF_S_1485) GROUP BY 后**可反推顾客级"历史赠/用现金券"事件流 + 当前余额快照**（1322 unique customers 受赠，18 顾客消耗，81568 行余额快照）。下列 P1.1/P1.2/P1.3 三字段就是基于此发现。

- **P1.1** `client_wechat_users.legacy_cash_coupon_balance` numeric(10,2) — 来源 `UDT_S_209.UDF_S_17194` 按 customer_id 取 MAX(FILLDATE) 最新一条；约 1322 顾客非 0；与 03-user 现有 customer_id 同步键配套
- **P1.2** `client_wechat_users.legacy_cash_coupon_grant_total` numeric(10,2) — 来源 `SUM(UDT_S_209.UDF_S_17190) GROUP BY UDF_S_1485`；1322 行非 0；累计赠送
- **P1.3** `client_wechat_users.legacy_cash_coupon_used_total` numeric(10,2) — 来源 `SUM(UDF_S_17216) GROUP BY UDF_S_1485`（保留符号，2025/2026 累计为负）；18 行非 0；累计消耗
- **P1.4** `coupon_templates.expire_action` text DEFAULT 'lazy_sweep' — 模板级清扫策略 {'lazy_sweep'/'cron_sweep'/'no_sweep'}；与 EDGE P2 cron 集中清扫器配套
- **P1.5** `user_coupons.source_channel` text — 显式记录发券来源命名空间（admin_single/admin_batch/cron_birthday/cron_thanksgiving/cron_member_upgrade/share_gift_inviter/share_gift_invitee），从 coupon_id LIKE 派生回填；refunds.ts 降档算法可按 source_channel 差异化处理
- **P2.1** `coupon_templates.max_per_user` integer — 单顾客同模板最大未使用券数（解决 R2 §4 发现的 1 顾客 3 张同模板未使用券）
- **P2.2** `coupon_templates.template_status` text — {'active'/'expired'/'paused'/'archived'}，与 is_active 拆分（解决 R2 §6 已过期模板仍 is_active=true 问题）
- **P2.3** `user_coupons.cancelled_at` timestamp + `cancel_reason` text — 释放路径留痕（订单关闭/退款释放/管理员撤销）
- **P2.4** `user_coupons.granted_by_employee_id` varchar(20) → staff_wechat_users.employee_id — admin 发券操作员上下文，从 operation_logs.operator_employee_id JOIN coupon.issue/batchIssue 一次性回填

**P3 不建议**：WF `UDT_S_311.UDF_S_17856/17857/17858`（顾客侧三字段，B.D 30 行采样无规律组合，含义不明），因 UDF_S_17194 已足够支撑客户档案需求；建议**不再迁移**这三字段，避免引入语义不明的 NULL 列。覆盖 03-user gaps 中"含义不明，需业务侧确认"的悬而未决项 — 本 R2 给出**确定结论：放弃迁移**

---

## ⚠️ EDGE / 08-commission

**P0：service.complete 取 `roleType = staff_wechat_users.skills[0] || '美容师'`，11 名员工 skills[0] 落到非标值（管理 / 面部护理 / 经络调理 / 身体护理 / 艾灸 / 皮肤管理）→ commission_rate_matrix 必查不到 → silent rate=0**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:L396` `const roleType = skills[0] || '美容师'`
- 实测（5434/fengyu）：`UNNEST(staff_wechat_users.skills)` 共 9 类值，其中 `美容师`(647)、`推广师`(200)、`养生师`(113) 是 commission_rate_matrix 矩阵 role_type 集合（实际 3 类），剩余 6 类 `管理`(4)、`面部护理`(3)、`经络调理`(1)、`身体护理`(1)、`艾灸`(1)、`皮肤管理`(1) 共 11 行员工的 skills[0] 可能命中
- 故障路径：员工 skills=`['管理', '美容师']` → service.complete 取 `'管理'` → SELECT commission_rate_matrix WHERE role_type='管理' AND ... → 0 行 → rate=0 → consume_amount=0 → 提成静默缺失
- 漏告警：实测 service_commissions 616,210 行 100% rate>0 + operation_logs 0 行 `service.complete.rate_missing` → 历史路径绕过此校验（疑由 backfill-service-commissions-roletype.js 直接导入），生产新单一旦命中此分支**业务永久无感损失**
- 修复：
  - A 立即：service.js:L396 改 `const roleType = skills.find(s => ['美容师','养生师','推广师'].includes(s)) || '美容师'`，确保取规范角色
  - B 长期：staff_wechat_users.skills 加 CHECK 约束限定首项必为 3 角色之一；或 schema 拆 `primary_role` 列与 `extra_skills` 列
  - C 监控：admin/dashboard 加视图 "服务单提成率为 0 的明细"（`service_commissions WHERE commission_rate = 0 AND consume_amount > 0`）

**P1：commission_rate_matrix 21 个市场零规则 + 1 行死规则 `role_type='推广'` (id=3) 对应南昌市场推广师 16,629 笔 sale_allocations 全部 rate 建议=0**

- 位置：`commission_rate_matrix.id=3 role_type='推广' org_id='6707cc8b88579108'(南昌市场)`
- 实测：`sale_allocations.role_type` 实际写 `推广师`(16629)/`美容师`(132429)/`养生师`(7657)；commission_rate_matrix 写 `推广`/`美容师`/`养生师`——两端字符串不等
- 影响：南昌市场 16,629 笔含推广师参与的销售分配，店长在 admin 看 commission.suggest 永远是 0，需手填——产品体验崩坏
- 修复（一次性）：
  ```sql
  UPDATE commission_rate_matrix SET role_type='推广师' WHERE role_type='推广';
  -- 0 行重叠风险（仅 1 行符合）
  ```
- 长期：admin/commission.ts createRate / updateRate 加 enum 校验 `roleType IN ('美容师','养生师','推广师')`

**P1：sales_category 死分支 `他销他耗 / 生态合作` 在 allocation.js 写死却永不接收非零 rate（dead default 4 元 set，仅 2 元有数据）**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:L285-286, L426`
- 实测：`sale_items.sales_category` 仅 `自销自耗`(208018)/`他销自耗`(1) 共 2 类；commission_rate_matrix 同
- 修复：
  - A 删除 dead defaults：`{自销自耗:0, 他销自耗:0}` 即可
  - B `sales_category` 字段加 enum 限定 2 值（schema commission.ts:L19 / order.ts sale_items 同步）

**P2：commission_rate_matrix 缺 DB-level CHECK 约束**

- 位置：schema/commission.ts 0 个 CHECK；pg_constraint 仅 PK / UNIQUE / FK
- 风险：admin UI 校验 ≠ DB 强约束。`amount_tier_max < amount_tier_min` 这种非法区间应用层 hasTierOverlap 不会检测
- 修复：加 3 条 CHECK
  ```sql
  ALTER TABLE commission_rate_matrix
    ADD CONSTRAINT chk_crm_rate_range CHECK (commission_rate >= 0 AND commission_rate <= 1),
    ADD CONSTRAINT chk_crm_tier_min CHECK (amount_tier_min >= 0),
    ADD CONSTRAINT chk_crm_tier_order CHECK (amount_tier_max IS NULL OR amount_tier_max > amount_tier_min);
  ```

**P3：commission_rate_matrix.org_id FK 缺 ON DELETE 显式语义（默认 NO ACTION），admin 删 org 时 23503 报错给运营**

- 位置：`db/schema/commission.ts:L14-16` `references(() => orgNodes.id)`（无 onDelete）
- 修复：`{ onDelete: 'restrict' }` 显式表达，或 admin/org/actions 加级联预清理

---

## 🔧 EXTEND / 08-commission

**P0：commission_rate_matrix 当前 15 行只覆盖 3/24 市场；产品决策点是否扩展 schema 表达力**

R2 重判：MSSQL `UDT_M_217`（124,682 行 × 70,899 distinct RID 营业额分配子表）虽不直接 1:1 映射，但承载历史**25+ 角色 × 5 部门 × 5 类金额维度**的全部分配快照。R1 的"无源可抽"应改为"无 1:1 映射，但有反向衍生路径"。

| 字段 | 类型 | WF 源 | 业务理由 | 优先级 |
|------|------|-------|---------|--------|
| `position_name` | varchar(50) NULL | UDT_M_217.UDF_M_418（25+ 值） | 当前 role_type 3 类强归一**信息有损**；管理层（代理经理/督导/实习经理）激励无法表达 | P0 |
| `department_name` | varchar(50) NULL | UDT_M_217.UDF_M_13713（5 主部门） | 同角色跨部门提成不同的规则当前无法表达；`sales_category` 是销售口径不是部门 | P0 |
| `commission_kind` | varchar(20) NULL | UDF_M_420/421/422/423 互斥 4 字段反推 | 当前 commission_rate 单字段不分"手工费率 / 消耗率 / 业绩率"；fixed_fee 走绝对额没率 | P0 |
| `effective_from` / `effective_to` | timestamp NULL × 2 | 无 | 调薪时旧订单按旧率计提；当前矩阵改率瞬时影响所有未结提成 | P1 |
| `created_by_employee_id` / `updated_by_employee_id` | varchar(30) NULL × 2 | 无（admin session.employeeId） | 审计无需 JOIN operation_logs | P1 |
| `notes` | text NULL | 无 | 业务侧"为什么这样设"备注（如"2026-04 集团激励调整 / 总裁特批"）当前无字段可存 | P1 |
| `is_active` | boolean NOT NULL DEFAULT true | 无 | 当前物理删除追溯需查 logs；改软删保留历史完整 | P1 |
| `min_qualifying_amount` | numeric(10,2) NULL | UDT_M_217 反推（聚合分析） | "月销低于 5000 不计提"业务规则 | P2 |
| `max_cap_amount` | numeric(10,2) NULL | UDT_M_217.UDF_M_13715 max=50000 | 防单笔大订单提成失控 | P2 |
| `priority` | int DEFAULT 0 | 无 | 多规则重叠时优先级（替代 hasTierOverlap 的禁止策略） | P2 |

**P0 共 3 个字段，P1 共 4 个，P2 共 3 个，总候选 10 个。**

**反向衍生脚本（如 P0 全加）**：`db/scripts/derive-commission-matrix-from-udf-m-217.js` — 按 (UDF_M_418, UDF_M_13713) 分组对 RID 71k 反推等效 rate，预估生成 5 市场 × 25 角色 × 5 部门 × 3 阶段 ≈ 1,875 行冷启动矩阵。**前置依赖**：UDT_M_213 须含 market_id 字段（待 02-org R2 验证），否则历史 RID 无法回溯所属市场，本路径作废。

**依赖**：①PM 确认是否扩展角色粒度（P0 #1/#2/#3 决策）；②admin commission/page.tsx UI 改造；③allocation.suggest / service.complete SQL 加新维度过滤；④若加 effective_from/to，service_commissions 写入路径需取规则的 effective_at 快照。

---

## ⚠️ EDGE / 07-permission

**P0：admin/actions/permissions.ts:assignRole 缺少 "role × scope_type" 白名单守卫，4 行 manager/staff/finance:总部 已构成员工端 staffApi 自动升级到 headquarters 越权**

- 位置：`fengyu-admin/src/actions/permissions.ts:L191-201` 仅守卫 `role='admin' → 必须总部`，**未守卫"非 admin 角色不应分配到总部"反向约束**
- 故障路径：admin 用户给员工分配 `manager:总部` 或 `staff:总部` → 员工登录员工端 → `staffApi/utils/scope.js:L46 deriveStaffLevel` 命中 `if (hasHq) return LEVEL_HEADQUARTERS` → `expandScopeStoreIds` 把全部 stores 纳入 scope → 越权全店可见
- 实测越权数据（5434/fengyu）：4 行
  - id=52072 manager:测试员(FY-260321001)@16d1184b46db099a(总部)
  - id=52078 staff:丁俊兰(FY-230717004)@总部
  - id=52076 finance:丁俊兰(FY-230717004)@总部 (此条若 finance 设计为 HQ-only 则合规)
  - id=52073 hr:刘梦洁(FY-230321001)@门店级 + id=52074 hr:丁思思(FY-250801001)@市场级（hr 应为 HQ-only）
- 修复（必须）：
  - A 加 `assertRoleScopeMatches(role, scopeType)` 白名单：admin/hr/customer_mgr/product/finance → 仅 '总部'；manager → '门店'/'市场'；staff → '门店'
  - B 一次性 SQL 清理：`DELETE FROM permission_roles WHERE id IN (52072, 52073, 52074, 52078)` + `DELETE WHERE role='finance' AND scope_id='16d1184b46db099a' AND id <> ...`（按业务确认是否保留 finance:总部）
  - C `staffApi/utils/scope.js:expandScopeStoreIds` 加防御："总部 scope 仅对 admin/hr/finance/customer_mgr/product 角色生效；manager/staff:总部 视为非法直接忽略"
  - D 单测覆盖：admin/permissions.test.ts 加 `it('rejects manager assigned to HQ scope')` 等 7 case role × scope 矩阵

**P1：调店后旧店 staff 权限行未清理，数据可见范围越权累积**

- 位置：`fengyu-admin/src/actions/employees.ts:L460` 调店时 `UPDATE permission_roles SET scope_id=新店 WHERE scope_id=旧店`，但 sync-workfine.js 在新店 INSERT 时 ON CONFLICT 已命中（同 employee_id+role+scope_id 的新店行已存在）→ 旧店行无人删除
- 实测：1 行（FY-260311001 马晓丽 当前 store=南昌丽景店，但持有 staff:南昌锦城店 + staff:南昌丽景店 两行）
- 业务影响：staffApi expandScopeStoreIds 把"南昌锦城店 + 南昌丽景店"双店纳入 scope，跨店顾客/订单/服务单可见
- 修复：A 一次性 SQL `DELETE FROM permission_roles pr WHERE pr.created_by='sync' AND pr.role='staff' AND NOT EXISTS (SELECT 1 FROM staff_wechat_users s JOIN stores st ON st.store_id = s.store_id WHERE s.employee_id = pr.employee_id AND st.org_node_id = pr.scope_id)`；B `employees.ts:L460` 改 UPDATE 为 DELETE 旧 + INSERT 新；C 同步脚本恢复后加同样兜底

**P1：updateEmployee 离职 + 调店三步无事务包裹**

- 位置：`fengyu-admin/src/actions/employees.ts:L329-444` `UPDATE staff_wechat_users` + `DELETE permission_roles` + `UPDATE permission_roles scope` 三个独立 db.* 调用
- 故障路径：第二步 DELETE 在崩溃间隙未执行 → 员工 `is_resigned=true` 但 perm 行残留（已发现 1 行：FY-260125002 檀思思）
- 业务影响：auth.js:L189 `is_resigned` 闸门兜底，**不构成越权**，但管理后台审计/报表脏数据
- 修复：包成 `db.transaction(async (tx) => { ... })`（参考同文件 L299 createEmployee 已用事务的写法）

**P2：seed user FY-260101-0001（张明）admin/hr/manager/staff 4 行 demo 数据流入生产，最终迁移应清理**

- 位置：`fengyu-admin/src/db/seed.ts:L272-284, L393` 写入 4 行 demo 角色（admin/hr/manager/staff）
- 实测：5434/fengyu 4 行存在（id=7969/7970/7971/7972/7979），生产环境无人使用
- 修复：最终迁移阶段 `DELETE FROM permission_roles WHERE employee_id = 'FY-260101-0001'` + 同步删除 staff_wechat_users 的对应行（注意 FK NO ACTION 可能阻塞 → 先清 perm 再清 user）

---

## ⚠️ EDGE / 06-appointment

**P1：clientApi `appointment.create` 防止重复预约的"已有待确认/已确认"守卫只走业务 SELECT 不走 DB 唯一约束，并发双击可破**

- 位置：`fengyu-client/cloudfunctions/clientApi/routes/appointment.js:L82-91` SELECT existing + L108-118 INSERT，**两步独立无事务/无行锁**
- 故障路径：顾客同一 sale_item_id 双击"立即预约"→ 两个 ctx 同时 SELECT 都返回 0 → 两个都进入 INSERT → 同一 sale_item 落 2 行 待确认 状态
- DB 端无约束兜底：`appointments` 表无 partial unique index 保护此约束
- 修复（优先 A）：
  - A 加 partial unique：`CREATE UNIQUE INDEX uq_appt_active_per_sale_item ON appointments (sale_item_id) WHERE status IN ('待确认','已确认') AND sale_item_id IS NOT NULL;` 配合 INSERT ... ON CONFLICT DO NOTHING + 应用层友好报错
  - B 用事务 + `SELECT ... FOR UPDATE` 锁 sale_items 行
- 测试覆盖：当前 PG 5 行 demo 数据 0 触发，但生产上线后并发风险真实存在

**P2：schema 注释承诺的"超过预约时间一天未到店 → 已关闭"无 cron 实现（设计意图未落地）**

- 位置：`db/schema/appointment.ts:L14` "已关闭" 状态注释 → 期望由定时任务自动触发
- 实际：`fengyu-admin/src/cron/steps/` 共 5 STEP（refresh-customer-status / refresh-member-levels / grant-birthday-benefits / grant-thanksgiving-benefits / audit-points-balance）**无任何 appointment 处理**；"已关闭" 状态目前唯一触发点是 `staffApi/routes/service.js:L379-385`（次数归零联动）
- 影响：超时未到店的 待确认/已确认 永久挂起，不会被自动关闭；admin 报表"待确认数"会无限累积
- 修复：要么在 cron-worker 加 STEP 6 `close-overdue-appointments.ts`（每天 03:00 跑 `UPDATE appointments SET status='已关闭', updated_at=NOW() WHERE status IN ('待确认','已确认') AND appointment_time < NOW() - INTERVAL '1 day'`），要么从 schema L14 注释删掉该承诺

**P2：2 行 stale appointment（status∈{待确认,已确认} 但 sale_item.remaining_sessions=0），admin/staff 列表会误显示为可服务**

- 实测（5434/fengyu）：appointments 5 行中 2 行 status='已确认' 但其挂的 sale_item 已 remaining_sessions=0
- 来源：admin/seed.ts demo 数据，未调用 staff service.complete 联动关闭路径
- 影响：员工端 `appointment.list` 仍把这 2 行排进"待服务"清单，店员看到会困惑（顾客已无次数）
- 修复：seed 修正 + 加 admin 报表"剩余次数 0 但预约活跃"的预警视图

**P2：admin `confirmAppointment` 漏写 `confirmed_at`**（R1 已识别，本轮 5 行实测确认）

- 位置：`fengyu-admin/src/actions/appointments.ts:L186` `set({ status: '已确认' })` 未带 confirmedAt
- 实测：PG 5 行中 4 行 status∈{已确认,已完成} 全部 confirmed_at 为 NULL
- 修复：一行改：`set({ status: '已确认', confirmedAt: new Date() })`

**P3：admin `cancelAppointment` 不接收 cancelledReason 也不写 cancelled_reason 列**

- 位置：`fengyu-admin/src/actions/appointments.ts:L262-268` 函数签名仅 `(appointmentId)`，UI 只传 ID 不传 reason
- 实测：5 行中 1 行 status='已取消' 但 cancelled_reason 为 NULL
- 修复：admin UI 加取消理由 modal + 函数签名加参数 + UPDATE 加 cancelled_reason 写入

---

## 🔧 EXTEND / 06-appointment

**P0：`appointments` 表当前 5 行 demo，零 WorkFine 迁移路径。用户要求"迁移数据覆盖更多字段" → 需新建迁移脚本派生 109,429 行**

数据源：MSSQL `UDT_S_762`（售前护理单主表）共 109,429 行，UDF_S_843（预约/到店时间）100% 非空。

需先做 schema 变更：

| 列名（snake_case） | 类型 | 来源 | 示例值 |
|---|---|---|---|
| `duration_minutes` | `integer` (nullable) | `UDT_S_762.UDF_S_826` 解析 | 45 / 60 / 50 / 90（Top4 占 86%） |
| `satisfaction_rating` | `varchar(10)` (nullable) | `UDT_M_763.UDF_M_842`（取该 HLD 子表第一行） | 满意 / 一般 / 未评价 / 不满意 |
| `customer_type_at_visit` | `varchar(20)` (nullable) | `UDT_S_762.UDF_S_819` | 售前一次 / 售后 / 售前二次 / 线上/美团首次 / 老带新 |

迁移脚本 `db/scripts/migrate-appointments-from-presale.js`（新建）：

- 109,429 行 UDT_S_762 → 109,429 行 appointments（status='已完成'）
- 派生 ID 规则：`apt-mig-{UDF_S_821}` （与 service_orders.service_order_id 形成 1:1，方便反查）
- appointment_time = UDF_S_843；checkin_at = UDF_S_822（实际服务发生日，34% 与预约日不同）
- notes = UDF_S_982（43,578 行有内容，max_len 37 字符）
- 同时 `UPDATE service_orders SET appointment_id = 'apt-mig-' || service_order_id WHERE service_order_id IN (...)` 反向关联打通

**特别注意**：UDF_S_843 实际语义不是"本次到店时间"而是"下次预约时间"快照——37,696 行（34%）UDF_S_843 > UDF_S_822（服务日期），平均 -11h。所以派生时如要让 PG 反映"本次预约"，应用 UDF_S_822 而非 UDF_S_843；如要保留"下次预约"语义则用 UDF_S_843。**建议**：`appointment_time = LEAST(UDF_S_843, UDF_S_822)`（取较早值作"本次预约时间"），同时考虑加一列 `next_visit_time` 存 UDF_S_843 的"下次预约"语义（若大于服务日）。

业务影响：109k 行批量回填会让 admin 客户详情/员工绩效页负载激增，需先加 `(status, appointment_time desc)` 复合索引保护"今日待确认"高频查询。

依赖：①schema 变更 PR；②迁移脚本；③admin UI 配套展示满意度 + 历史预约 Tab 分页；④cron-worker 加 STEP 6 close-overdue-appointments（避免历史回填行如有 status 异常被无限挂起）。

---

## ⚠️ EDGE / 01-order

**P0：`sale_orders.paid_amount` 与 `sale_order_payments` 双写不变量已破，15 行运行时数据资损**

- 位置：schema 注释 `db/schema/order.ts:65-69` 声明 paid_amount 必须 == Σ(sale_order_payments where 已支付且 change_type ∈ 首次支付/回款/退款) 的同事务双写快照
- 实测（2026-04-26 5434/fengyu）：15 行 sale_orders 有 paid_amount > 0 但 SUM(sale_order_payments.amount) = 0
- 涉及订单：FY-XSD-WX-260310-0001、FY-XSD-WX-260312-0003/0004、FY-XSD-WX-260313-0005/0006、FY-XSD-WX-2603210001/0002/0003/0004、FY-XSD-WX-2603220001/0002/0003、FY-XSD-WX-2604160001/0002/0003 系列
- 类型分布：销售单 11 / 内部单 2 / 转换单 2
- 根因（双重）：
  1. **运行时缺写**：早期开发期（2026-03-10 ~ 2026-04-16）staffApi/order.create / confirmOffline / payNotify 中有路径写 paid_amount 时漏插 sale_order_payments
  2. **0004 backfill 漏盖**：post-baseline `db/migrations/0004_yellow_magma.sql:L41-110` 的回填 SELECT 只覆盖 sale_order_type IN (销售单/回款单/退款单)，**内部单 / 转换单（migration 0028-0031 之后的扩展枚举）不在 backfill 集合**
- 业务影响：财务对账（sale_order_payments 流水汇总）将看不到这 15 笔资金动作；任何"已收/未收"统计会和 sale_orders.paid_amount 矛盾
- 修复：
  - A 立即：写一次性 backfill SQL，按现有 paid_amount 反推 INSERT 缺失的 sale_order_payments 行（含 sale_order_type IN (内部单, 转换单) 的扩展守卫）
  - B 单测保护：staffApi/order/order.test.js + payNotify/index.test.js 强制断言"事务结束后 SUM(payments.amount) === paid_amount"
  - C admin/refunds.ts:L924 / orders.ts:L1743 同款检查

**P0：`sale_items.expire_date = 1900-01-01` 共 5130 行致疗程卡 active_expired 2125 行被误判已过期**

- 位置：`db/scripts/migrate-history-orders.js:L196` `expireDate: row.UDF_M_7122`，缺空值守护
- 实测：5130 行 expire_date < '2000-01-01'（min 1900-01-01, max 1900-01-18，全部源自 UDF_M_7122 NULL → SQL Server datetime 0 epoch 误转）；其中 product_type='疗程卡' AND remaining_sessions > 0 AND expire_date < CURRENT_DATE 共 **2125 行**（肝胆净化 / 四季养生 / 肩颈头疗 等核心项目，剩余次数 1~17 不等）
- 业务影响（**业务永久失效**）：staffApi/clientApi 任何"剩余有效卡"列表（按 expire_date >= today 过滤）会把这 2125 张真实有剩余次数的卡误判为已过期 → 顾客无法预约 / 员工无法核销 → 服务单流程被卡死
- 修复：
  - A 立即：`UPDATE sale_items SET expire_date = NULL WHERE expire_date < '2000-01-01'`（5130 行，幂等批量）
  - B 长期：migrate-history-orders.js:L196 改为 `expireDate: (val && new Date(val).getFullYear() > 2000) ? val : null`
  - C 检查 staffApi/clientApi 所有 expire_date 比较点是否对 NULL 友好（NULL = 永不过期 vs 必填）

**P1：`sale_allocations.allocation_ratio` 73214 行 > 1.00（含 2 行触顶 999.99）— schema 语义与代码语义不一致**

- 位置：schema `db/schema/order.ts:206` 列名 ratio 暗示 0~1 比例；migrate-allocations.js:L174-221 实际计算 = `total_amount / sale_amount`
- 实测：ratio∈[0,1]=156504、ratio∈(1,100]=73211、ratio>100=3，max=999.99（numeric(5,2) 上限）
- 后续溢出风险：未来某员工跨大订单分配单 item alloc / sale_amount > 999.99 时会撞 numeric 精度上限（已有 2 行触顶）
- 修复：
  - A schema 扩 numeric 精度到 (8,4) + 文档明确语义"该员工分得金额 / 该 item 销售金额，可 > 1"
  - B admin 展示侧不要按 % 展示该列

**P2：sale_orders dropped column ghost（`........pg.dropped.13........`）— baseline reset 未真重建 sale_orders 表**

- 实测：5434/fengyu sale_orders pg_attribute 仍有 attnum=13 的 attisdropped=true 列（旧 `sale_order_source`，archive `0028_drop_sale_order_source.sql` 已 DROP）
- 0000_baseline.sql:238-272 重建定义 30 列，无此列；live PG 实际有 30+1=31 attnum 槽位
- 含义：2026-04-10 baseline reset 时 sale_orders 表 DDL 没真正 DROP/CREATE 重建，drizzle 把它视为 nochange skip 了
- 影响：142811 行 × 4 字节 ≈ 558KB 死空间；功能无影响但表元数据不干净；其他 14 张表是否也有同类残留 dropped 列需排查

**P3：sale_orders.allocation_status='已分配' 但 0 alloc 行 共 75313 行（53%）**

- 拆分：拓客卡 24966 + phantom 22784 + 结存 15517 + history 12046
- 三个非 history migration 脚本硬编码 allocation_status='已分配' 但没写 sale_allocations 数据；history 那 12046 是 sale_amount=0 被 migrate-allocations 跳过
- 影响：前端如果做"已分配 → 锁定不可改"守卫，这 75313 行无法补录分配人
- 修复：扩 allocation_status enum 加 '不适用'，或最终迁移把这部分 → '待分配'

**P3：sale_items 31780 行 unit_real_price > unit_price（折扣字段语义颠倒）**

- 根因：migrate-history-orders.js 把 UDF_M_4949（市场标价）→ unit_price，UDF_M_395（实际销售金额，含套餐补差价）→ unit_real_price；UI 端按"原价 vs 现价"展示会颠倒
- 例：肩颈疏通(单次) unit_price=18 unit_real_price=108；全身排毒(MQ单次) unit_price=28 unit_real_price=700
- 修复：UI 对 urp > up 的行不显示原价划线，或 migrate 时取 max(unit_price, unit_real_price) 兜底

**P3：sale_items 6 行 product_type='疗程卡' 但 remaining_sessions IS NULL（全为转出行）**

- 影响：转出行业务上应 remaining_sessions=0；当前 NULL 让 UI"已耗尽 vs 未知"模糊
- 修复：staffApi/order.createConversion 写 sale_items 时显式 remaining_sessions=0；批量 UPDATE 修正现有 6 行

---

## ⚠️ EDGE / 02-org

**P0：staffApi `expandScopeStoreIds` UUID 强制类型转换 → 2014 员工登录后台业务必抛 42883**

- 位置：`fengyu-staff/cloudfunctions/staffApi/utils/scope.js:112` 与 `scope.js:120`
- 故障 SQL：
  - L112：`WHERE o.parent_id = ANY($1::uuid[]) AND o.type = '门店'`
  - L120：`WHERE org_node_id = ANY($1::uuid[])`
- 实际列类型：`org_nodes.id` 与 `org_nodes.parent_id` 均为 `text`（schema/org.ts:20,23），PG 5434 实测 ID 形态混合 16 字符 sha256 hex（533 行）+ seed 字符串如 `org-store-jj01`（16 行），全部不是合法 UUID
- 实测验证（5434/fengyu）：
  ```
  ERROR: operator does not exist: text = uuid (code 42883)
  ```
- 调用链：`staffApi/index.js → middleware/auth.js:205 → expandScopeStoreIds()` — 任何活跃员工 staff 登录或带身份请求都会进入
- 生产 blast radius：**permission_roles 共 2038 行，持有 (scope_type IN ('市场','门店')) 绑定的 distinct employee 数 = 2014**；这 2014 名员工任何 staffApi 调用经过 auth 中间件都会抛 42883 → index.js 全局 catch → 前端报"系统错误"
- 单测未抓到：`__tests__/utils/scope.test.js` 用 `vi.fn()` mock pg.query，永不触达真实 PG 类型 parser
- 修复（一行 diff，零风险）：
  - A 推荐：`::uuid[]` → `::text[]`（两处）
  - B 备选：去掉强制类型，pg-node 会按数组元素类型自动推断
- 部署后回归：用任意 store_manager / market_manager 角色员工跑通 `auth.login` + `service.list` + `staff.todoList` 三个最常用 action

**P1：派生 ID 三套规则共存，无 schema 守护**

- 16 字符 sha256 hex（`sync-workfine.js:hashId(...)`），存量 533 org_nodes + 144 stores
- seed.ts 硬编码 `org-store-{slug}` / `store-{slug}`（长度 10-23），存量 16 org_nodes + 4 stores
- admin `fengyu-admin/src/actions/stores.ts:111` createStore 写死 `org_nodeId = 'store-' + data.storeId`（**第三套规则**，与 seed 不一致也与 sync 不一致）
- 后果：未来 sync-workfine 重启 + 同一物理门店在 admin 改名后，会以新输入算出新 hashId，与已存的 seed/admin 派生的 store_id 永不收敛 → 旧 inbound FK 变成 dangling pointer
- 修复方向：抽 `db/scripts/idgen.js` 作为唯一权威派生函数，三处统一调用 + schema 加 `CHECK (id ~ '^[0-9a-f]{16}$|^(org-|store-|dept-)')`

**P2：closed_at 16 行全部失真（已知，doc 已列）**

- PG `stores.closed_at` 16 行全部 `= updated_at::date`（migration 0012 兜底回填）
- WorkFine 真实闭店日期在 `UDT_M_219.UDF_M_11957`，但 sync-workfine.js 未抽
- 新观察：6 个 Y- 前缀 WF 新行（2025-11~2026-04 创建）`UDF_M_11957` 全 NULL，说明 WF 端 11957 仅闭店时填，正常营业为 NULL — 最终迁移按"稀疏列"处理即可

---

## ⚠️ EDGE / 03-user

**P0：`client_wechat_users.bound_employee_id` 列名声称"员工编号"但 4188/4218 (99.3%) 行实际是员工姓名**

- 位置：
  - 数据来源 `db/scripts/sync-workfine.js:L491` `RTRIM(UDF_S_6444) AS bound_employee_id`
  - 运行时使用 `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:L711`（员工"我的新会员" SQL）
  - 运行时使用 `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:L1042-1048`（店长 staffRanking 归属）
  - 运行时使用 `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:L305-310`（顾客详情查指定美容师）
- 问题：WorkFine `UDT_S_311.UDF_S_6444` 实际是"绑定美容师姓名"，sync-workfine.js 把这个值原样塞进了语义为"美容师 employee_id" 的 PG 列。schema 注释也写的是"绑定美容师"但 FK 语义已暗示该列应是 employee_id：`promoter_employee_id` 列就有 FK → staff_wechat_users.employee_id 约束，而 bound_employee_id 没有 FK 约束（这是 sync 时绕过校验的关键）
- 实测（2026-04-26）：
  - `bound_employee_id` 非 NULL 总行数 4218
  - 中文姓名格式 `^[一-龥]+$` 匹配 4188 行
  - `^FY-...$` 标准员工 ID 格式匹配 0 行
  - 其余 30 行：垃圾值 `-` (20)、`—` (1)、`罗礼芬2` (1)、`无` (混入 sample)、几条 `FY-260101-...` 等
  - 4218 行用 `bound_employee_id = staff_wechat_users.employee_id` join 时孤立 4210 行（distinct 400 个不同名字）
- 后果（**业务永久失效，资损级**）：
  - 美容师在员工端"我的工作台"查"我的新会员"，查询条件 `c.bound_employee_id = $1`（$1 是 employee_id 如 `FY-220801001`）。员工的同步行 employee_id 是 `FY-` 格式，不可能命中 4188 行中文名。**美容师看到的"我的新会员"恒为 0（除了运行时 admin 端手动赋值的极少数行）**
  - mgmt-dashboard.staffRanking 按 `c.bound_employee_id` GROUP BY，**4188 个中文名行被聚合成 400 个伪员工分组**，与真实员工绩效完全错位
  - customer.detail 接口"指定美容师名"用 `bound_employee_id` 反查 staff name，4188/4218 = 99.3% 顾客的"指定美容师" UI 显示为空（因 staff.employee_id 找不到 join）
- 修复方向：
  - A（推荐，根治）：写 backfill 脚本——按 `staff_wechat_users.name` 反查 employee_id（注意：staff name 有重复，`陈倩 / 王丽 / 李娟` 各 3 个，需结合 `staff.store_id = client.bound_store_id` 二次唯一化）。404 个 distinct name 中 405/419 可由 staff_name 单点匹配（前面探针 AF），剩 14 个无对应需置 NULL
  - B（兼容现状）：新增 `bound_employee_name varchar(50)` 列保存原文，bound_employee_id 列全部 NULL 化，运行时 SQL 改用 name join；但 staff.js L711"我的新会员" SQL 由于姓名不唯一会有错配
  - C（最简）：直接给 bound_employee_id 加 FK + check 约束 `^FY-` 格式校验 → 强制 sync 必须解析；旧数据由 backfill 修
- 备注：**bound_employee_name 冗余列在 PG 0/58803 行写入**——schema 注释要求"随 bound_employee_id 同步写入"，sync-workfine.js / 管理后台均未实现。该列实际是死代码

**P1：`client_wechat_users.birthday` 含 7 行公元 0172/0186/0190/0199 等"古代"日期 + 26 行未来 birthday（最远 2043）**

- 实测：
  - `birthday < '1900-01-01'` 7 行（最早 0172-11-10，"陈宝红"，user_id `FYGK-20260313-24406`）
  - `birthday > CURRENT_DATE` 26 行（最远 2043-03-17，"方菊花"）
  - `birthday` 之间 1899-12-30 也命中 1 行（江军连）
- 来源：sync-workfine.js:L495 `toDateStr(UDT_S_311.UDF_S_1479)`，未做日期合理范围校验
- 后果：
  - admin 顾客生日提醒/筛选会异常显示（前端可能崩在 `new Date('0172-11-10')` 解析）
  - 数据看板"本月生日 / 下月生日"统计准确性受影响（虽然量级小，约 33 行）
  - dashboard "1647 会员客" 中是否含极值生日，会员活动短信群发时可能给死人或未出生婴儿发消息
- 修复：在 sync 与 admin actions.customers.update 处增加 `[1900, current_year]` 校验

**P2：`staff_wechat_users.birthday` 49 行 < 15 岁（最近 2026-01-24 出生），其中 18 行 `is_resigned=false`**

- 实测：49 个员工 birthday 在过去 15 年内，`潘小伟 / 钟羽婷 / 张乐怡` 出生于 2026 / 2025 年（分别 employee_id `FY-260124001` / `FY-260124002` / `FY-251216001`）
- 来源：WorkFine UDT_S_287.UDF_S_1149 sync 直拷，未校验
- 后果：童工嫌疑/数据脏；staff.gender 中 1 行值为 "汉"（应是民族字段填错位置）
- 修复：sync 端加合理范围校验 + 现存数据 NULL 化

**P3：`client_wechat_users.phone` 81 行格式异常但通过了 sync 的 validPhone 校验（说明校验逻辑漏掉了某些情况）**

- 实测：
  - `空号` (1 行)、`.` (1)、`0` (1)、`1` (1)、`013595968804` (1)、`13530986989/15907907823` (1)、`131+9769733` (1)、`1363.8829322` (1) 等
  - 大部分是 10 位数字（如 `1899005949`、`1890013062`），通过率高于预期
- 来源：sync-workfine.js validPhone 仅校验"11 位且 1 开头"——10 位数字 / 含分隔符 / "空号" 字面值都漏过
- 后果：
  - `uq_client_users_phone` 唯一索引被这些垃圾值占位，正常用户绑同一号码时 UPSERT 命中错误行
  - clientApi.auth.bindPhone 用 phone 找同步行，可能误关联到含 `空号` / `.` 的脏行
- 修复：validPhone 加严：`^1[3-9][0-9]{9}$`

**P4：异常 user_id `FYGK-b3abfd8bb034` (1 行) 不符合 `FYGK-YYYYMMDD-NNNNN` 格式**

- 实测：`FYGK-b3abfd8bb034`，name=张凯，phone=13617216903，customer_type=会员客，无 customer_id，created_at=2026-04-23 12:32（baseline reset 后）
- 来源：admin 端某路径手动 INSERT 时用了 hashId 生成器（推测 admin/src/actions/customers.ts createCustomer 路径），与 sync 的序号生成器（FYGK-{YYYYMMDD}-{5位序号}）格式冲突
- 后果：现有报表 / 客户分类筛选若用 `user_id ~ '^FYGK-[0-9]{8}'` regex 会漏掉该行；目前无脚本这样过滤，但是 future-proof 风险

**P5：5 行 member_level 数据状态不自洽**

- 实测（探针 5.5 + 9.2 + J + K）：
  - 1 行 customer_type=流量客 但 member_level=黑钻（`FYGK-20260315-59738` 欧桂莲，无 became_member_at 也无 upgraded_at）— 说明她的 member_level 来自 sync UPSERT 偶然命中（前面文档分析的 5 行存活），但 recalc-all-customer-types.js 后续把她降级为流量客时**没清空 member_level**（recalc 脚本只升不降 member_level）
  - 1 行 member_level=NULL 但 old_member_level=粉钻（`FYGK-20260313-26919` 刘春霞，customer_type=会员客）— 异常状态，old_member_level 设计语义是"升级前的快照"，没有 member_level 时不应有 old；推测 cron-worker processUpgrade 的失败回滚不完整
- 后果：会员等级推送、保级提醒等业务逻辑面对这 2 行会有 UI 异常或空指针
- 修复：写一次性 cleanup 脚本：customer_type ≠ 会员客 → member_level = NULL；member_level IS NULL → old_member_level = NULL

**P6：`staff_wechat_users.id_card` schema 注释"AES-256-GCM 加密"但 3251/3251 行均为 18 位明文（含 1 行 15 位旧版身份证）**

- 实测：min_len=15, max_len=18, avg_len=18, encrypted_like (60+ 字符 base64)=0
- PII 合规风险：身份证号明文存储是已发生的合规问题
- 与 03-user.md L131 + L206 论断一致，本轮 R2 数据强化证据

**死代码 / 永不命中**

- `bound_employee_name` (varchar 50)：schema 标"冗余字段"，sync + admin 均未写入；PG 0/58803 行有值。**可删列**
- `session_key` (client + staff)：PG 0/58803 + 0/3299 行有值。运行时 staffApi.auth.login 似乎没用上（cloud 函数有自己的 session 缓存）。**可能可删列**
- `customer_source` enum 中 `地推卡 / 内部员工或家属 / 推带新` 3 个值在 PG 中 0 行，且 WorkFine 端没有对应原文，永远不会命中
- `member_level` enum 中 `金钻 / 星钻 / 粉钻` 3 个值 PG 0 行（WF 端 `粉钻` 仅 1 行同步未生效）
- `spending_tier` enum 6 个值中只有 `<1990` 实有 58803 行，其他 5 档 0 行（前面文档已记，重申：spending_tier 字段实际全表恒为默认值，整个枚举与字段是死配置）
- `monthly_activity` 整列 100% NULL（calc-monthly-activity.js cron 从未跑过）

**FK 删除行为风险**

- `client_wechat_users.bound_store_id`、`promoter_employee_id`、`inviter_user_id` 全部 `ON DELETE NO ACTION`
- `staff_wechat_users.store_id`、`org_node_id` 同样 NO ACTION
- 后果：删除 stores / staff_wechat_users 行时若存在引用，操作会被 PG 拒绝；但**这是 NULL 化也做不到的隐患**——admin 端目前没有删除接口，但若未来加一个"清理离职员工"按钮，会因为大量 client.bound_employee_id 引用而失败（虽然该列没有 FK，但 promoter_employee_id 等列会拦）

---

## ⚠️ EDGE / 05-service

**P0：38,562 sale_items 累计扣次 > 原 session_count（service_items 超消业务永久不变量破缺）**

- 实测（2026-04-26 5434/fengyu）：`SUM(service_items.session_used) GROUP BY sale_item_id WHERE service_orders.status='已完成'` 与 `sale_items.session_count` 对比，38,562 行 sale_items 出现累计扣次 > 原次数；样本：`JCLSH-20230202018 used=24/session_count=15`、`JCLSH-20230202030 used=25/12`、`JCLSH-20230202001 used=48/32`、`FY-ABZH2507270032 used=11/10`、`FY-ABZH2509060035 used=15/14`
- 根因：sale_items.session_count 来自 UDF_M_4938 / 14495（销售时点），service_items.session_used 来自 UDF_M_836（服务时点）；两侧在 WF 端**不强一致**，migrate-service-records.js 与 migrate-history-orders.js 双向独立抽取，PG 端无 CHECK 约束防御
- 业务影响（**业务永久不变量**）：顾客"剩余次数"展示与服务单创建时的次数预校验全部失真；尤其疗程卡场景：`product_type='疗程卡'` 占超消行 100%（38,562/38,562 都是疗程卡）
- 修复：
  - A 立即：写一次性诊断 SQL 列出 38,562 行的 sale_item_id + 超消差额 + 涉及顾客，业务侧 case-by-case 复核（追加次数还是扣回服务）
  - B 长期：staffApi/admin 服务单创建路径增加预校验 `已用次数 + 待扣次数 ≤ session_count` + schema 加 trigger 防新数据再次破坏
  - C 数据修复方案二选一：① UPDATE sale_items SET session_count = used 与已扣次数对齐；② 标记为"超消"补单走业务流程

**P1：service_items.employee_id ≠ service_orders.assigned_employee_id 79,058 单（13%）— 团队成员丢失**

- 实测：`SELECT COUNT(DISTINCT so.service_order_id) FROM service_orders so JOIN service_items si ON si.service_order_id=so.service_order_id WHERE si.employee_id != so.assigned_employee_id` = **79,058**
- 根因：migrate-service-records.js:L156 `assignedEmployeeId: employeeId  // 第一个明细的员工`，多明细多员工场景仅取首条；UDT_S_259.UDF_S_2599 主表本就有"该单负责人"语义但脚本未抽
- 业务影响：admin/staff 任何按 `assigned_employee_id` 检索/统计的视图（如 staff.todoList、顾客详情"服务过我的员工"）都会少 13% 单的团队成员；提成路径走 service_items.employee_id 实际不受影响
- 修复方向：
  - A 最终迁移加 `service_orders.responsible_employee_id` 列从 UDF_S_2599 抽取（详见 EXTEND § P1.7）
  - B admin "服务单详情"页面改为同时展示 assigned_employee_id（负责人） + service_items.employee_id 列表（执行员工）

**P1：6,745 行 service_orders.service_date > sale_items.expire_date（过期后服务，schema 无 CHECK 防御）**

- 实测：`COUNT(*) FROM service_items si JOIN service_orders so JOIN sale_items sa WHERE sa.expire_date IS NOT NULL AND so.service_date > sa.expire_date AND so.status='已完成'` = **6,745**；其中 6,637 行 expire_date ∈ ['2000-01-01', CURRENT_DATE]（真实过期日），仅 106 行落入 1900-01-01 脏值（与 01-order EDGE 5130 行 expire_date='1900' 同源）
- 样本：`HLD-2603150440 service_date=2026-03-14 expire_date=2025-09-16` `HLD-2601030088 service_date=2025-12-31 expire_date=2024-03-30`（已过期 21 个月仍在服务）
- 业务影响：6,637 单服务发生在卡到期之后；可能是 WF 历史导入时 expire_date 错填或员工延期服务未走系统延期流程；PG schema 无 trigger / CHECK 约束防御新数据
- 修复：业务复核 6,637 行；PG 加 trigger `BEFORE INSERT/UPDATE service_items` 校验 `service_date <= expire_date OR expire_date IS NULL`

**P1：service_items.unit_real_price ≠ sale_items.unit_real_price 659,968 行（77%）— schema 注释失实**

- 实测：`COUNT(*) WHERE si.unit_real_price IS DISTINCT FROM sa.unit_real_price` = 659,968；样本：`JCLSH-20230219423 si=7.50 sa=0.00`（service 端有价 sale 端零）、`XSLSH-20230918039 si=7.22 sa=260`（service 端折算单次 sale 端整体价）
- 根因：schema/service.ts:L60 注释"sale_items.unit_real_price 快照"，但 migrate-service-records.js:L164/L177 实际从 WF UDT_M_260.UDF_M_6869 直接抽（"单次价格"），与 PG sale_items.unit_real_price 来源 UDF_M_395（"实际销售金额"）**不同字段**
- 业务影响：service_items.unit_real_price 198,372 行 = 0（23%）+ 460,669 行 sale_items 端 = 0；任何按 service_items.unit_real_price 计算服务收入的口径都会丢/偏；admin 服务单详情可能展示"该次价格"与销售订单详情展示的"原始单价"互相矛盾
- 修复：① 修正 schema 注释为"WF UDF_M_6869 直接抽 = 单次价格，与 sale_items.unit_real_price 不同源"；② migrate 改为优先从 sale_items 派生（保 schema 原意）— 但会丢失 65% 数据 — **建议保持 WF 直拷，仅修注释**

**P2：service_items.session_used max=999,999（180 行 > 100，无上界守护）**

- 实测：`SELECT MIN/MAX session_used FROM service_items` min=1 / max=999,999 / over_100=180
- 根因：migrate-service-records.js `Math.max(1, parseInt(row.session_used) \|\| 1)` 仅守下界，不守上界；UDF_M_836 在 WF 端可能有"无限制疗程"硬编码 999999
- 业务影响：sum(session_used) 类提成统计被这 180 行污染；目前提成 service_commissions 已写入历史值无法回滚
- 修复：migrate 加上界 `Math.min(parseInt(row.session_used) \|\| 1, 50)` + UPDATE 现有 180 行为合理上限

**P3：service_items 残留 dropped column（attnum=10）**

- 实测：`pg_attribute WHERE attisdropped=true AND relname='service_items'` 命中 attnum=10 ghost；与 01-order P2 sale_orders attnum=13 同源（baseline reset 时部分表被 drizzle nochange skip 未真重建）
- 影响：851,624 行 × 4 字节 ≈ 3.4MB 死空间；功能无影响

**P3：状态机软约束 3 行违反 + 1 行 commission_status 不变量破缺 + 2 行零明细 service_orders**

- `status='已完成' AND completed_at IS NULL` = 2 行（schema 无 CHECK 防御）
- `status='服务中' AND started_at IS NULL` = 1 行
- `status='已完成' AND commission_status IS NULL` = 1 行（99.999% 行 = 待分配）
- 2 行 service_orders 无任何 service_items
- 修复：低优先级；schema 加 CHECK + 单点修正这 6 行

---

## 🔧 EXTEND / 05-service

P0 字段扩展候选（业务依赖、缺它影响功能、最终迁移必须补）：

**EXT-1（P0）：`service_orders.service_order_type` 重写**

- 源：`RTRIM(UDT_S_259.UDF_S_1417)` 直拷 + UDT_S_762 全部硬编码 `'售前'`
- 现状：PG 100% `'售前'`（607,847/607,847），WF 真值 96.7% `'售后'` / 3.3% `'售前'`（MSSQL 2025+ 抽样 250,469/8,624）
- 业务理由：当前所有按 service_order_type 筛选/分组的 admin/staff 报表完全错乱；任何"今日售后服务量""售前转化率"统计都失真
- 数据量：607,847 行全量回填；分两支：UDT_S_259 来源走 UDF_S_1417 派生 / UDT_S_762 来源全部 `'售前'`
- 依赖：**必须废弃 archive 0024 派生规则**（不要用 customer_type='会员客' 推导）；最终迁移直接 UPDATE 修存量
- admin UI 配套：服务单列表/统计卡片需重新校准

**EXT-2（P0）：`service_items.is_gift boolean` 新增列**

- 源：`UDT_M_260.UDF_M_6902 = '是'` → true / '否'+空 → false
- 业务理由：143,797 行（17%）赠送服务在 PG 完全无标识；提成计算可能赠送行也算业绩，财务对账数据不实
- 数据量：851,624 行回填（含 svc-/FY-FW- 7 行运行时数据，建议默认 false）
- 依赖：schema 加列；migrate 脚本加抽取；admin "服务单明细"展示标签；提成计算 service_commissions 路径决定是否对赠送行 commission_amount=0

**EXT-3（P0）：`service_items.sku_id text` 新增列 + FK product_skus.sku_id**

- 源：`UDT_M_260.UDF_M_16309` 疗程项目编号（关联 UDT_M_1281.UDF_M_14503）
- 业务理由：①100% 覆盖（301,274/301,274）；②当前 service_items 无法直接关联商品 SKU，统计"按品类服务次数"必须 JOIN sale_items 二跳；③一次性解决 staffApi service.js:L208-211 sku_id 列错配 P0 问题（已记 16-store-unbind 上方 ⚠️ P0 / 05-service 段）
- 数据量：851,624 行回填；映射依赖 UDT_M_1281 当时点的 SKU 表
- 依赖：① schema 加 sku_id 列 + FK；② staffApi service.js + admin createServiceOrder 已 INSERT sku_id（无需改代码，只需补列）；③ migrate-service-records.js 加抽取逻辑

**EXT-P1 优先级条目（共 7 个）见 05-service.md `## 字段扩展建议 R2` 段，覆盖：满意度 satisfaction、service_fee、legacy_appt_time（售前预约时间）、responsible_employee_id（主表负责人，可救 79,058 行 assigned_emp 丢失）、legacy_card_calc + legacy_promo_type + legacy_promoter_employee_id（拓客标签）、category_name 冗余、legacy_filled_at + legacy_modified_at（WF 真实时间戳）。**

---

## ⚠️ EDGE / 04-product

**P0：466 行 product_type='疗程卡' 但 session_count<2，违反 schema 注释业务约束（"疗程卡 ≥ 2"）**

- 位置：schema `db/schema/product.ts:53` 注释 + L69 CHECK `session_count IS NULL OR session_count >= 1`
- 实测（2026-04-26 5434/fengyu）：`product_type='疗程卡' AND (session_count IS NULL OR session_count<2)` = **466/769 行（60.6%）**
- 实数据样例：`spec_name='深V文胸 单次体验'`、`'紫熏之花文胸 单次体验'`，product_type 全是 `'疗程卡'` 但实际是单次体验单品
- 根因：老脚本 `mapProductType` 对 UDT_M_1281.UDF_M_14502 含 "疗程卡" 字样的全归为 product_type='疗程卡'，但 SKU 实际只 1 次（"单次体验"），CHECK 仅守 `>= 1` 没拦住
- 业务影响：开单/服务核销/卡明细按 `product_type='疗程卡'` 二分逻辑取 session_count 做剩余次数快照；466 个 SKU 是单品被误打成疗程卡，下游 UI 称"疗程卡剩余 1 次" 但应是单品消耗
- 修复：
  - A 数据：批量把 spec_name LIKE '%单次体验%' 且 session_count=1 → product_type='单品'
  - B schema 严化 CHECK：`(product_type='疗程卡' AND session_count >= 2) OR (product_type='单品' AND session_count = 1) OR (product_type='家居产品' AND session_count IS NULL)`

**P0：mall_product_skus 17 行 bundle_group_id 非 NULL 但 bundle_price NULL（套餐内 N 选 M 优惠价丢失）**

- 实测：`COUNT(*) FILTER (WHERE bundle_group_id IS NOT NULL AND bundle_price IS NULL) = 17`
- 业务影响：套餐结算时该 SKU 命中分组但取价 fallback 到 product_skus.price（标价），用户预期套餐内优惠价但实际收全价 → 资损
- 修复：
  - A 立即：批量把 17 行 bundle_price 设为 product_skus.price 或显式 0
  - B admin/products.ts:706 updateSkuBundlePrice 与 addSkuToProduct 解耦的设计需合并入参，强制同时填 bundle_price
  - C schema 加 CHECK `(bundle_group_id IS NULL) OR (bundle_price IS NOT NULL)`

**P0：products.is_bundle=true 但无 mall_bundle_groups 行：149/151 套餐缺分组（98.7%）**

- 实测：`is_bundle=true 共 151 行，其中 149 行 NOT EXISTS bundle_groups`；同时 18 行 is_bundle=true 但 mall_product_skus 关联 ≤ 1 个 SKU
- 业务影响：149 个套餐前端"分组选项"为空，"N 选 M" 校验静默放过；客户端可任选所有 SKU 不受 pickCount 限制
- 修复：
  - A 数据：149 个套餐补一个默认 `groupName='全选'` + `pickCount=NULL`
  - B admin createProduct 标记 isBundle=true 时强制同事务创建至少 1 个 bundle_group

**P1：204 行 product_skus.price = 0 + 4 行 products.price = 0 通过了 chk_sku_price >= 0**

- 实测：`product_skus.price = 0 共 204 行`、`products.price = 0 共 4 行`
- CHECK 仅守非负但语义异常；开单 unit_price=0 → 客户免单 / 折扣引擎可能除零
- 修复：CHECK `price > 0`，福利赠品改用 EXTEND #2 is_gift 标志；admin 表单禁止 price=0 提交

**P1：10 个 dropped column 残留（products 5 / product_skus 4 / mall_categories 1）**

- 实测（pg_attribute attisdropped=true）：products attnum 7/11/15/16/19；product_skus attnum 2/8/11/12；mall_categories attnum 4
- 与 01 模块 sale_orders attnum=13 同类问题，baseline reset 不彻底；表元数据不干净，无业务影响
- 修复：`pg_repack` 或 `VACUUM FULL`

**P1：product_skus.spec_name 严重重复（"深V文胸 单次体验" 单一 spec 出现 31 次！）**

- 实测：top 5 重复全是"单次体验"类（深V文胸 31, 紫熏之花文胸 31, 微雕聚拢文胸黑 15, 优弧微雕黑 12, 微雕聚拢文胸粉 11）；products 名也重 — `测试1` 3 次、多个法米索品 2 次
- 来源：archive 0012 把 product.name 拼到 spec_name 后没去重；早期同名促销活动各自生成不同 sku_id 但同 spec_name
- 影响：开单/前端搜索"深V文胸"列出 31 行价格相同的伪 SKU，员工无法区分哪一行
- 修复：
  - A 数据：合并 spec_name+price 相同的 SKU，迁移 sale_items.sku_id 引用
  - B schema：UNIQUE INDEX(spec_name, price) 防后续重复

**P1：product_kind text 列无 enum 守护，admin 误填即可写脏值**

- schema 是 text 无任何 CHECK / enum 约束（migration 0005 把原 enum DROP TYPE）
- 实测 5 个 distinct 值（护理项目=39 / NULL=9 / 家居产品=4 / 充值卡=2 / 体验卡=1）
- 9 行一级行中 4 行（"222/招牌/王牌/明星"）capability 全 NULL，是 admin 后台手填测试残留 — 暴露了"product_kind 字段无校验"的副作用
- 影响：mgmt-product.js / order.js / card.js 各处 SQL `WHERE product_kind = '充值卡'` 是字面量；任何错填（如尾空格）会导致整片业务消失
- 修复：恢复 enum + admin 表单改下拉枚举

**P2：market_scope 残留 sync 脚本内部前缀 "Y" — 9 行 product_skus.market_scope='Y九江市场' / 1 行 products.market_scope='Y九江市场'**

- 来源：sync-workfine 用 Y- 前缀区分新旧门店，写库前未脱前缀
- 影响：按"九江市场"筛选漏 9 SKU；按"Y九江市场"筛选 0（前端不暴露 Y- 选项）
- 修复：一次性 UPDATE 去前缀 + 同步脚本写库前 RTRIM Y-

**P2：1674/1720 行 SKU 在 sale_items 中从未引用（97.3% SKU 是死数据）**

- 含义：迁移期一次性灌入 WF 历史 SKU（含早已停售/促销过期），生产订单只用 46 个活跃 SKU
- 影响：admin 商品列表/搜索充斥死数据；FK 完整性无风险
- 修复：批量 is_enabled=false 长尾 SKU；定义清理规则（创建 > 6 个月且无销售记录 → 自动停用）

**P2：products 6 行无任何 mall_product_skus 关联**

- 含义：商城展示有商品行但点进去无 SKU 可买
- 修复：业务侧补关联或软删

**死代码 / 永不命中**

- `product_categories.display_icon`：整列 0/55 行非 NULL，admin 表单从未填过
- 9 行一级 product_kind=NULL 行中 4 行（"222/招牌/王牌/明星"）capability 全 NULL，是手填测试残留
- 19 行 product_skus + 11 行 products `updated_at = created_at`（自创建以来从未编辑），archive 0012 一次性 INSERT 后冷数据

**FK 删除行为风险**

- mall_product_skus / mall_bundle_groups 引用都未声明 ON DELETE CASCADE：删 products 行需先手动 DELETE 关联表（admin 当前未实现"删商品"路径，未来加按钮会因引用拦截）

---

## 🔧 EXTEND / 04-product

**P0 字段扩展候选（业务依赖，缺即资损 / 提成错算）**

| # | WF 源 | PG 新增列 | 类型 | 业务理由 |
|---|------|---------|------|---------|
| 1 | `UDT_M_1281.UDF_M_20688` 提成分类（5 值，填充率 100%；其中 `产品无提成` 174 行） | `product_skus.commission_class` | text NOT NULL default '自销自耗' | **影响提成计算资损**：当前 commission_rate_matrix 路由用 product_categories.sales_category（粗粒度），SKU 层 174 个"产品无提成" SKU 销售员仍会拿提成 |
| 2 | `UDT_M_1460.UDF_M_17174` 是否赠送（'是'=202 / '否'=549 / 空=3） | `product_skus.is_gift` | boolean NOT NULL default false | **赠品 SKU 与正常 SKU 同等存在**：202 行赠品没标志位，开单/财务/提成无法区分卖出 vs 赠出 → 资损 |

**P1 字段扩展候选（信息流失，未来需要）**

| # | WF 源 | PG 新增列 | 类型 | 业务理由 |
|---|------|---------|------|---------|
| 3 | `UDT_M_1281.UDF_M_14507` 单位（次/件/瓶/支等 17 distinct，填充率 100%） | `product_skus.unit` | text | 开单页明细行展示单位，sale_items 需快照 |
| 4 | `UDT_M_1281.UDF_M_17477` 招牌定位（明星=379 / 王牌=140 / 招牌=28 ...，填充率 72%） | `product_skus.banner_label` | text | 前端"招牌项目"标签栏依据，目前靠 admin 手填一级类目（4 行测试残留即是这个） |
| 5 | `UDT_S_1280.UDF_S_14497/14498/14499` 起始/启用/截止日期（datetime2，100%） | `product_skus.valid_start` / `valid_end` | date / date | archive 0021 已把 valid_* DROP，运行时无版本控制；2056 SKU 都有有效期 |
| 6 | `UDT_M_341.UDF_M_1872/1873/12636/1874` 规格/供货商/品牌/系列 | `products.spec_text` / `supplier` / `brand` / `series` | text ×4 | 院装产品 99% 信息丢失；库存盘点/采购/品牌专区展示必备 |
| 7 | `UDT_M_341.UDF_M_4795/7541` 员工购入价/公司进货价 | `products.employee_price` / `cost_price` | numeric(10,2) ×2 | 利润分析依赖进货价；员工内购走线下记账 |
| 8 | `UDT_S_1459.UDF_S_17175/17191/17193` 促销方案名/现金券面值/套餐总价 | 新表 `promotion_schemes` + `product_skus.promotion_scheme_id` FK | 新表 | 现 promo 名仅作分类名进 product_categories；附带 cash_voucher / bundle_total 丢失 |
| 9 | `UDT_M_1281.UDF_M_14569` 三级品项细分（30+ distinct，填充率 95%） | `product_categories` 加第三级 / `product_skus.sub_category` | text | PG 仅 2 层分类；新人培训 / 数据看板按治疗大类切片需要 |

**P2 字段扩展候选（nice-to-have）**

- `UDT_M_1281.UDF_M_17411` 外围市场 / `UDF_M_17478` 昌九贡 / `UDT_M_1383.UDF_M_17479` → `product_skus.outer_market_enabled` / `changjiugong_enabled`（布尔 ×2）
- `UDT_S_1459.UDF_S_17157/17158` 促销开始/结束 → 见 #8 promotion_schemes
- `UDT_M_1383.UDF_M_17415` 是否可用 → `product_skus.is_in_use`（独立于 is_enabled）
- `UDT_M_1460.UDF_M_17170` 折扣金额 → `product_skus.discount_amount` numeric(10,2)
- `UDT_M_341.UDF_M_1876-1880` 多层批发价 → `products.tier_prices` jsonb

**实施依赖**

- 必须先 `db:generate` + `db:migrate` 加 PG 列，再写一次性回填脚本
- admin UI 配套（新增可编辑字段）：`is_gift / commission_class / banner_label / unit / spec/supplier/brand/series`
- UDT_M_341 全量（2043 行）需重写 sync-products 去掉 `WHERE UDF_M_7494='是'` 过滤
- 新表 `promotion_schemes` 影响 product_categories.category_name 当前混合语义

**无源放弃**

- `products.description`：UDT_M_1281 schema 经 R2 探针验证不含产品描述字段，admin 手填唯一来源

---

## ⚠️ P0 / 16-store-unbind

**clientApi `requestUnbind` SQL 列名错配 → 顾客端"申请解绑门店"业务永久失效**

- 位置：`fengyu-client/cloudfunctions/clientApi/routes/store.js:156-158`
- 问题：INSERT `store_unbind_requests` 显式列清单写了 `from_store_name`，但 PG 5434 实测列只有 `from_store_id`（NOT NULL）；入参也传的是 `boundStoreName` 字符串而非 `boundStoreId`（hash）
- 引入：自模块上线以来从未跑通；2026-04-26 review 在 5434 双向核验：
  - `information_schema.columns` 无 `from_store_name`
  - `from_store_id` is_nullable=NO，default=NULL
  - `store_unbind_requests` 总行数 = 0（无任何成功 INSERT）
  - `operation_logs.action LIKE 'store_unbind.%'` 命中 0（审批路径同样未触发）
- 后果：顾客每次点击"申请解绑此门店"必抛 PostgreSQL `column "from_store_name" of relation "store_unbind_requests" does not exist`，前端显示"申请失败"。下游店长/admin 审批路径也因此从未触发过。
- 修复方向（A 推荐）：
  - A. 把 INSERT 列改回 `from_store_id`，入参改用 `ctx.auth.boundStoreId`（auth 中间件已暴露）
  - B. 给 schema 加 `from_store_name` 列（不推荐，重复存储 store_id 已能 JOIN stores 取名）
- 详情见下文「16 / store_unbind_requests」章节。

---

## ⚠️ P0 / 05-service

**staffApi service.create 一上线即报错 → 员工端服务单无法新建（业务永久失效）**

- 位置：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:L207-224`
- 问题：INSERT service_items 显式包含 `sku_id` 列，但 5434/fengyu 实际 service_items 表 + db/schema/service.ts + db/migrations/0000_baseline.sql:L292-302 **均不存在 sku_id 列**
- 引入：commits `d37b596` / `7f8367b`（2026-04-25），尚未在生产复现失败因为最近一次成功写入是 2026-04-23 `FY-FW-2604230001`（commit 之前）
- 后果：staffApi 一旦完成 cloudbase 部署，员工端开服务单全部 PostgreSQL `column "sku_id" does not exist` 报错；现网无 5434 表结构补 sku_id 的迁移
- 修复方向（二选一）：
  - A. 移除 service.js INSERT 列清单中的 `sku_id` 字段及其参数（推荐，与 schema 对齐）
  - B. 写新 migration 给 service_items 加 sku_id 列 + 同步 schema/service.ts + 同步 admin createServiceOrder

---

## 01 / sale_orders

- ✅ ~~`document_type` 来源不明~~ → **R1.5 已解决**：`archive/0023_document_type.sql` 用 PG 规则推导（会员类型 + 金额阈值），**未保留 WorkFine UDF_S_371 业绩类型 5 值原始语义**。⚠️ 业务侧若需保留 5 值，最终迁移需补 `legacy_perf_category` 列直接抽 UDF_S_371
- ✅ ~~`payable_amount`、`paid_amount` 与 payments 不一致~~ → **R1.5 已解决**：migration `0003:L58` UPDATE paid_amount=total_amount + `0004:L38` UPDATE payable_amount=total_amount-prepaid_card_amount 链式回填
- `opened_by`、`preferred_employee_id` — 历史无；可考虑从 `UDT_M_217` 取分配最高的员工作为 opened_by 近似
- `client_phone` — 历史 NULL；可从 `client_wechat_users.phone` JOIN 回写

### sale_orders 已被脚本读但未对接到 PG 的 WorkFine 列

- `UDT_S_209.UDF_S_18619` 会员等级（下单时）— 未对接，影响历史订单的会员等级追溯
- `UDT_S_209.UDF_S_4729` 本单欠款合计 — 未对接，PG 也无承载列
- `UDT_S_209.UDF_S_17216` 本单消耗现金券 — 应进 `sale_orders.coupon_discount`，未对接
- `UDT_S_209.UDF_S_17190` 赠送现金券 — 未对接
- `UDT_S_209.UDF_S_13708` 顾客来源 — 未对接（应进 `client_wechat_users.source_channel`）
- `UDT_S_209.UDF_S_17315` 是否锁客 — 未对接
- `UDT_S_209.UDF_S_18162` 是否纳客 — 未对接
- `UDT_S_209.UDF_S_3323` 美容部充公业绩 — 未对接
- `UDT_S_209.UDF_S_523` 收款核对 — 未对接

## 01 / sale_items

- `store_id` — 必填字段，但 `migrate-history-orders.js` INSERT 列清单未含；需要找到后续回填来源
- `sku_id` — 全部 NULL，无法关联 `product_skus`；建议最终迁移按 `product_name + spec_name + price` 组合匹配补回
- `sku_spec_name` — 全部 NULL（脚本未抽）
- `is_shengmei` — 全部 NULL（migration 0014 才加列）
- `service_fee` — 历史全 0（运行时从 product_skus.service_fee 拷贝，历史无依据）

### sale_items 已被脚本读但未对接的 WorkFine 列

- `UDT_M_213.UDF_M_4939` 赠送(是/否) — **业务关键**：赠送行 received=0 与正常零元订单无法区分
- `UDT_M_213.UDF_M_14494` 销售数量 — 脚本固定 quantity=1，**实际数量 ≥ 2 的订单数据失真**
- `UDT_M_213.UDF_M_392` 品项分类 — 读了未写
- `UDT_M_213.UDF_M_396` 单价优惠 — 未对接
- `UDT_M_213.UDF_M_397` (decimal，含义不明) — 未对接
- `UDT_M_213.UDF_M_398` 应收金额 — 未对接
- `UDT_M_213.UDF_M_400` 顾客欠款 — 未对接
- `UDT_M_213.UDF_M_4937` 已付款次数 — 未对接（分期）
- `UDT_M_213.UDF_M_4938` 单次价格 — 未对接（衍生量）
- `UDT_M_213.UDF_M_14495` 疗程项目编号 — 未对接
- `UDT_M_213.UDF_M_14496` 单位 — 未对接

## 01 / sale_allocations

- `UDT_M_217.UDF_M_418` 职位 — 读了未写（PG 无对应列）
- `UDT_M_217.UDF_M_419` 员工姓名 — 同上
- `UDT_M_217.UDF_M_420-423` 业绩品类拆分（眉眼/唇/祛斑/单品）— 未对接（4 个金额列）
- `UDT_M_217.UDF_M_2315` 职位序列编码 — 未对接
- `role_type` — 不来自 WorkFine，从 `staff_wechat_users.skills[0]` 派生；准确性依赖员工档案数据质量

## 01 / sale_order_payments

- ✅ ~~整表来源不明~~ → **R1.5 已解决**：`0004_yellow_magma.sql:L41-110` migration 末尾 3 段 INSERT FROM sale_orders（销售单/回款/退款各一段），2026-03-14 部署当天写入 75244 行 WorkFine-linked payments
- `UDT_M_1259` 收款方式明细整表未对接 — WorkFine 端多支付方式拆分信息已丢失，全部归并为单行 `'线下/首次支付'`。如业务需保留多通道明细，最终迁移要从 UDT_M_1259 重做，按 (sale_order_id, payment_method) 多行 INSERT

## 02 / org_nodes

- `org_nodes.id` 与 `stores.store_id` 派生算法不一致（前者 3 段 hashId，后者 2 段），最终迁移需谨慎保留两个不同 hash 否则 FK 链断裂
- `org_nodes.sort_order` 市场层级取决于扫描遍历顺序，**不稳定**

## 02 / stores

- ⚠️ `stores.closed_at` **数据失真**：PG 16 行用 `updated_at::date` 兜底回填，不是真实闭店日期。WorkFine `UDT_M_219.UDF_M_11957`（17 行非空 datetime）才是真实闭店日期，sync 脚本未抽取
- `stores.bed_count` 仅 5/148 行非 NULL（WorkFine 端 UDF_M_8590 大量 0 被脚本 `row.bed_count \|\| null` falsy 判断丢弃；最终迁移应改为 `row.bed_count ?? null` 或显式判 null）
- `UDT_M_219.UDF_M_3683` 疑似门店编号（如"351"/"352"/"348"）未抽取，可能影响其他系统关联
- `UDT_M_219.UDF_M_3264 / UDF_M_12033 / UDF_M_21371` 含义未明，未对接
- 150 → 148 行差额：WorkFine 有 150 行 valid stores，PG 仅 148 行；UPSERT 不删除，差额来源未查清
- 顾客向字段（cover_image / images / district / street_address / lat / lng / phone / business_hours / description / announcement / parking_info）由 admin 手工维护，**不来自 WorkFine**；最终迁移不应覆盖这些

## 03 / client_wechat_users

- ⚠️ `member_level` 99.99% 流失：WF UDF_S_1477 取值集（普通/会员/贵宾/体验/白金/铁粉/...）与 PG enum（初钻/星钻/粉钻/金钻/黑钻）完全不兼容；sync 直接拷只命中"黑钻/粉钻"少数偶然重叠值。**最终迁移建议补 `legacy_member_level text` 列**保留 WF 原文
- ⚠️ `customer_source` 99.99% 流失：WF UDF_S_6446 1300+ 自由文本（拓客/推广部拓客/38卡/员工姓名等）被裁剪到 7 个枚举值（53610 → 3843 行）。**最终迁移建议补 `legacy_customer_source text` 列**
- `gender` — sync 未抽取，PG 全 NULL；推测来源 UDT_S_311.UDF_S_1486 待 sample 验证
- `bound_employee_name` — schema 注释"冗余随 boundEmployeeId 写入"但 sync 未实现，PG 0/58803
- ⚠️ `is_married` toBool 把 NULL/空值映射成 false；PG 现状 57163/58803 行存伪 false（WF 真实有值仅 8408 行），数据语义错误
- ⚠️ `spending_tier` 全部默认 `<1990`：没有任何脚本计算，包括 1647 会员客全部为 `<1990`，**实际 schema 默认值未被覆盖**。需要补 backfill 按 sale_orders 累计金额打档
- `customer_type='体验客'` 数恒为 0：recalc-all-customer-types CTE 依赖 product_skus → product_categories.product_kind 链路，但商品域 SKU 数据 v2.1 重构未完整覆盖体验卡
- ⚠️ `category` 列已 DROP（archive 0016）但 sync-workfine.js:L493/L532-543 仍试图 INSERT — sync 在 baseline 后再跑会 column does not exist 报错（当前由 2026-04-16 停用规避）
- WF UDT_S_311.UDF_S_1474（顾客建档日期 datetime2）未抽，PG `created_at` 用同步时刻；**[2026-04-26 量化] 58187/59239 (98.2%) 有值**
- ⚠️ `monthly_activity` **PG 现状 0/58803 全 NULL**（doc 标"每日 cron 计算"但 calc-monthly-activity.js 在生产从未跑过，与 10/points + 12/messages cron-worker 零产出同源问题）
- ⚠️ `gender` 真实数据源仍未定位：sync 未抽，PG 全 NULL；**[2026-04-26 排除] UDF_S_1486 取值是 `'否'`（疑似某种 bool 标志）不是性别**，需在 UDT_S_311 其他 33 个未对接列中继续排查
- `is_married` 三态分布修正：实测 false=57113 / null=1640 / true=50（doc 描述"57163 行存伪 false"略偏；admin 路径已写回 1640 行 NULL）
- WF UDT_S_311.UDF_S_17856/17857/17858（decimal，疑似累计消费/储值）未对接，**可能是 spending_tier 真实数据源**
- WF UDT_S_311.UDF_S_1483/1484（nvarchar(350)，地址/备用电话）未对接，schema 也无承载列
- WF UDT_S_311.UDF_S_1712 (A/B/C/D/E 价值分档，23356 行有值) — `category` 列删除后 WF 价值分档信息**完全丢失**

## 03 / staff_wechat_users

- ⚠️ `id_card` schema 标注 AES-256-GCM 加密，但 sync 写明文；3251/3299 行需核对运行时是否真加密，否则违反 PII 合规
- ⚠️ `hired_at` 数据失真：3299/3299 全部用 `created_at::date` 兜底；**[2026-04-26 更新] UDF_S_1162（datetime2）100% 覆盖 + 91.3% 行与 employee_id 嵌入日期戳偏差≤90天，强证据为真实入职日期，最终迁移直接抽**
- ⚠️ `resigned_at` 数据失真：1279 离职行全部 = `updated_at::date` 兜底；**[2026-04-26 验证] UDT_S_287.UDF_S_1626（datetime2）非空行数 = 1279，与 PG is_resigned=true 行数完美匹配，确认即真实离职日期**
- ⚠️ `resigned_reason`（PG 无承载列）：**[2026-04-26 验证] UDT_S_287.UDF_S_1625（nvarchar）非空行数 = 1279，取值 `'个人原因'`/`'0'` 等，确认即离职原因，schema 应加列承载**
- `skills` 仅 955/3299 行有值（远低于 position_name 3298/3299），sale_allocations.role_type 派生大部分回退到 fallback `'美容师'`
- `bound_employee_name` 的反向（员工是否被多少顾客绑定）— 未对接但派生信息需要
- WF UDT_S_287.UDF_S_1157（nvarchar(3000) 备注）未抽
- WF UDT_S_287 共 60+ 列，sync 仅用 9 列；剩余 50+ 列含义不明（推测：合同/学历/紧急联系人/银行账户）
- 3375 → 3299 行差额（76 行）来源未确认

## 04 / product_categories

- ⚠️ `product_kind` 数据失真：sync-products mapBigCategory 把 UDT_M_1281.UDF_M_17783 的 4 个原值（生美 396 / 非生美 222 / 否 157 / 是 23）全部坍缩为 `'护理项目'`，**生美/非生美区分丢失**（实际 product_skus.is_shengmei 通过 archive 0012 从老 products 继承，**唯一保留路径**）
- ⚠️ `display_color` 一级行 5 中 4：migration 0014:L13-22 按 `category_name='组合套餐'` 命中，PG 实际行名为"福利活动"（archive 0029 改名后又被 baseline 还原回"福利活动"？），**福利活动一级行 display_color 为 NULL**
- ⚠️ archive 0017 / 0029 在不同时点种子不同的一级行集合：0017 种 4 行（福利活动/护理项目/家居产品/充值卡），0029 改名"福利活动→组合套餐"并新增"体验卡"。**PG 现状 9 行一级**（含 5 个"原始" + 4 个 admin 后建），存在双重历史
- product_categories.sales_category 32/55 行 NULL：archive 0012:L59-65 一次性聚合，但当时旧 products 表 sales_category 大量 NULL；最终迁移需 admin 手工补齐

## 04 / product_skus

- ⚠️ `spec_name` 是合并字段：archive 0012:L83-85 `spec_name = p.name || ' ' || sk.spec_name`，**包含完整商品名+规格**（如"蜜语水润嫩肤护理 10次卡"），不可拆。最终迁移如要恢复"原始 SKU 名"需重新从 WF 抽
- ⚠️ `sku_id` 命名混杂：1700 行 16 字符 sha256 hash（旧脚本）+ 20 行 `sku-` 前缀（admin 新建）。同一物理实体跨命名空间，不可仅靠前缀判断来源
- `special_price` 12/1720 行非 NULL — 几乎全 NULL，无 WF 映射
- `service_fee` 12/1720 行 > 0 — 几乎全 0，无 WF 映射；archive 0018 仅回填 sale_items.service_fee 不回填本表
- `market_scope` 335/1720 行非 NULL — 仅门店自定义/促销 SKU 有值
- `is_shengmei` 1003/1720 行非 NULL — 717 行 NULL（含家居产品 + 早期未对齐 SKU）

### product_skus 已被脚本读但未对接的 WorkFine 列

- ⚠️ `UDT_M_1281.UDF_M_17477 招牌定位`（明星/招牌/王牌）— 未对接，PG 无 banner_position 列，**招牌标签信息完全丢失**
- ⚠️ `UDT_M_1460.UDF_M_17174 是否赠送` — 未对接，**赠品 SKU 与正常 SKU 无法区分**
- ⚠️ `UDT_M_1281.UDF_M_20688 产品无提成` — 未对接，影响提成计算
- `UDT_M_1281.UDF_M_14507` 单位（次/瓶/支）— 未对接，PG 无 unit 列
- `UDT_M_1281.UDF_M_14569` 品项三级细分 — 未对接，PG 仅 2 层分类
- `UDT_M_1281.UDF_M_17411 / UDT_M_1383.UDF_M_17479` 市场可用标记 — 未对接
- `UDT_M_1460.UDF_M_17170` 折扣金额 — 未对接
- `UDT_M_1460.UDF_M_17166 / UDT_M_1460.UDF_M_17176-17177` 单位/含义不明 — 未对接

## 04 / products

- 几乎纯 admin 后台维护：`cover_image` 1/960、`detail_images` 1/960、`description` 10/960，**展示属性完全依赖后续手工录入**
- ⚠️ `product_id` 命名混杂：14 行 `prod-` 前缀（admin 新建）+ 946 行 16 字符 sha256 hash（旧脚本残留）
- `category_id` 经 archive 0012:L80 改写为 `'mall-' || old_category_id`，FK 链断；最终迁移如重做 mall_categories 编号需同步级联

### products 已被脚本读但未对接的 WorkFine 列

- ⚠️ **UDT_M_341 99% 数据未导入**：valid 仅 22/2043（依赖 UDF_M_7494='是'），其余 2021 行院装产品 PG 无承载
- 上述院装产品的 `UDF_M_1872 规格` / `UDF_M_1873 供货商` / `UDF_M_12636 品牌` / `UDF_M_1874 产品系列` / `UDF_M_1876-1880 多层价格` / `UDF_M_4795/4796 员工购` / `UDF_M_7541 公司进货价` 全部丢失
- ⚠️ `UDT_S_1280 / UDT_S_1382 / UDT_S_1459 主表` 的 `UDF_S_14497-14499 有效期版本` — 完全丢失，PG 没有版本概念
- ⚠️ `UDT_S_1459` 促销方案级字段：`UDF_S_17191 附带现金券金额` / `UDF_S_17193 促销方案套餐售价` / `UDF_S_17175 促销方案名` — 仅 plan_name 进 product_categories.category_name，其余丢失

## 04 / mall_categories

- 整表是 archive 0012 一次性 1:1 复制 product_categories（前缀 `mall-`），与 WF 无映射；archive 0018 加 category_group 组层级、archive 0019 删 is_valid 列
- ⚠️ `category_id` 命名混杂：11 行 `mall-cat-` 命名空间 + 11 行 `mall-grou`/`mall-mgrp` + 27 行 `mall-` + 16 字符 hash 残留
- `category_group` 38/49 非 NULL（11 行一级 + 38 行二级）

## 04 / mall_product_skus

- ⚠️ archive 0012:L73-75 一次性回填导致 `mall_product_skus.product_id` 实际是**历史 spu_id（hash）**，最终迁移如重写 product_id 编号需同步级联
- 整表是新系统抽象（多对多关联），与 WF 无映射，最终迁移可保持空白由 admin 维护
- `bundle_price` 9/1748 非 NULL；`bundle_group_id` 26/1748 非 NULL — 套餐场景占比极低

## 04 / mall_bundle_groups

- 完全新系统独立（archive 0020 加表），WF 没有套餐"N 选 M"语义
- PG 现状仅 6 行（开发期手工创建），最终迁移留空

## 05 / service_orders

- ⚠️ `service_order_type` **100% 数据失真**：PG 607847 行全部 `'售前'`，WorkFine UDT_S_259.UDF_S_1417 真实分布 96% `'售后'`（250303/8621）。失真链路：migrate-service-records.js 写入时按 UDF_S_1417 派生，archive `0024_service_order_type_rename.sql` 一次性 UPDATE 用 `client_wechat_users.customer_type='会员客'` 重写覆盖。**最终迁移必须直接抽 UDF_S_1417 重做，不要复用 0024 派生规则**
- ⚠️ `completed_at` 历史值 = `service_date` cast，仅日期粒度，全部当天 00:00:00；**真实完成时刻 WorkFine 无源**，最终迁移必须放弃
- `commission_status` 99.999% 行 = `'待分配'`，但 migrate 脚本未写入、schema 列允许 NULL、git history 无对应 backfill SQL —— **未找到回填来源**，最终迁移需补显式默认 `'待分配'`
- `remark` 历史 NULL：UDT_S_259/762 无 remark 字段（与 sale_orders 不同），仅运行时 staffApi 写
- `appointment_id` / `started_at` migrate 脚本不写；前者 UDT_S_762.UDF_S_843（售前独有 datetime 预约时间）可作迁移补全候选
- `client_user_id` 1341/607847 行 NULL（顾客 customer_id 在 PG 无映射）
- 7 行 service_date 在 2028-2099 异常区间（脏值，脚本未做日期范围校验）
- HLD- 编号段 UDT_S_259 / UDT_S_762 共用 → migrate-presale-services Phase 2 用 `ON CONFLICT (service_order_id) DO NOTHING` 防主键冲突，**售前数据可能被先到的售后静默覆盖丢失**
- `assigned_employee_id` 是"第一条明细的员工"简化派生，多明细多员工的护理单只记一个；UDT_S_259.UDF_S_2599（主表员工编号）才是真"该单负责人"语义但脚本未抽

### service_orders 已被脚本读但未对接的 WorkFine 列

- `UDT_S_259.UDF_S_823` 顾客姓名 — 读了未写（PG schema 无 customer_name 列于 service_orders，与 sale_orders 设计不一致）
- `UDT_S_259.UDF_S_1417` 服务分类（售前/售后真实标签）— 读了进 serviceType 派生但被 archive 0024 整体覆盖丢失
- `UDT_S_259.UDF_S_2126` 顾客电话 — 未对接
- `UDT_S_259.UDF_S_2599` 主表员工编号（单负责人）— 未对接
- `UDT_S_259.UDF_S_829` 是否核算卡数 / `UDF_S_830` 拓客类型 / `UDF_S_831` 推广员 — 未对接（拓客业务关键标签）
- `UDT_S_259.UDF_S_819` 顾客类型 / `UDF_S_826` 服务时长描述 / `UDF_S_2127` / `UDF_S_2600` / `UDF_S_2601` / `UDF_S_982` / `UDF_S_17143` — 未对接
- `UDT_S_762.UDF_S_843` 预约/到店时间（**售前独有** datetime）— 未对接，可作 appointment 关联或 started_at 真实来源候选

## 05 / service_items

- ⚠️ `service_duration` **字段映射存疑**：脚本读 UDT_M_260.UDF_M_840 当作分钟数（service.js 也叫 `serviceDuration`），但 workfine_database.md L689 标注 UDF_M_840 是"服务费金额"。PG 现状 712154/851624 = 83.6% 行有值，需在最终迁移前抽样校验：若中位值在 30-180 → 字段是分钟数（脚本对、文档错）；若是金额 → 字段映射错位，应进 service_fee 列
- ⚠️ `is_shengmei` 6/851624 行非空（archive 0008 链式回填）— 上游 sale_items.is_shengmei 自己几乎全 NULL，回填无效
- `sales_category` 851621/851624 ≈ 100% 行值统一 `'自销自耗'`（archive 0011 链式回填上游硬编码）— 实际上没有区分价值
- `unit_real_price` schema 注释"sale_items 快照"，但 migrate 脚本实际从 WF 子表 UDF_M_6869 直接抽，**非从 PG sale_items 派生**；运行时（service.js）才是真"快照"
- `service_item_id` migrate 派生 `'SVCI-' + service_order_id + '-' + OBYID`，runtime 派生 `svc-{uuid}`；7 行 FY-FW-/svc- 命名空间与 851617 行 SVCI-HLD- 命名空间共存

### service_items 缺失列（schema 设计应补但未补）

- `product_name` — 脚本读了 UDT_M_260.UDF_M_835 但未写入；展示需 JOIN sale_items.product_name（设计与 sale_items 快照模式不一致）
- `employee_name` — 脚本读了 UDT_M_260.UDF_M_839 但未写入；展示需 JOIN staff_wechat_users.name
- `service_fee` — 脚本读了 UDT_M_260.UDF_M_837 用于 service_commissions.commission_amount 计算，但未写入 service_items 任何字段
- ⚠️ `is_gift` — UDT_M_260.UDF_M_6902 是否赠送（**业务关键**）：2025+ 数据 17% 行标"是"，**赠送服务记录与正常记录无法区分**，最终迁移建议加列
- ⚠️ `satisfaction` — UDT_M_260.UDF_M_842 顾客满意度未对接，**关系到员工绩效评估**

### service_items 已被脚本读但未对接的 WorkFine 列

- `UDT_M_260.UDF_M_835` 项目名称 — 读了未写
- `UDT_M_260.UDF_M_837` 本次消耗 — 读了未写（仅用于 commission 计算）
- `UDT_M_260.UDF_M_839` 员工姓名 — 读了未写
- `UDT_M_260.UDF_M_6868` 品项分类 — 读了未写
- `UDT_M_260.UDF_M_6902` 是否赠送（业务关键）— 读了未写
- `UDT_M_260.UDF_M_842` 顾客满意度（业务关键）— 未对接
- `UDT_M_260.UDF_M_841` 项目个数 / `UDF_M_838` 员工职位 / `UDF_M_2473` 职位序列编码 — 未对接
- `UDT_M_260.UDF_M_7007` 可用次数（核销时刻剩余）/ `UDF_M_7135` 有效日期 — 未对接（与 sale_items 同步信息）
- ⚠️ `UDT_M_260.UDF_M_16309` 疗程项目编号（**售后独有**，关联 UDT_M_1281.UDF_M_14503）— 未对接，**可作未来 sku_id 回填的关键关联键**
- `UDT_M_260.UDF_M_7341` / `UDF_M_14213` / `UDF_M_14214` / `UDF_M_14833` / `UDF_M_16136` / `UDF_M_17859` / `UDF_M_19156` / `UDF_M_19753-19759` 含义不明 — 未对接
- `UDT_M_763.UDF_M_7014` 次数变化（**售前独有**）/ `UDF_M_14211/14212/14832/14834/17860` — 未对接

## 05 / runtime 漂移（非血缘问题但记入待核）

- ⚠️ `staffApi/routes/service.js:L208-211` INSERT service_items 显式列出 `sku_id`，但当前 PG schema 无该列。PG 现状仅 7 行非 HLD 数据（5 行 FY-FW-/2 行 svc-）— 与 runtime create 路径数量级不匹配，**生产 INSERT 应该会报 column does not exist**。需运维侧核实是否吞错或部署版本不一致；与本模块迁移血缘无关

## 06 / appointments

- 整表零 WorkFine 迁移路径（WorkFine 无独立预约实体，仅 `UDT_S_762.UDF_S_843` 售前预约/到店时间字段，109,390 行 100% 填充）。本表为 100% 新系统独立表
- ⚠️ `appointments.confirmed_at` schema 注释"员工确认预约时记录"但 3 处 confirm 入口（clientApi / staffApi / admin actions）**均未写**该列；PG 现状 0/5 行非空（含 seed），疑似漏实现 — 要么补 SET confirmed_at = NOW()，要么删列
- ⚠️ `appointments.employee_id` schema NOT NULL 与 `clientApi/routes/appointment.js:L116` `staffWfId \|\| null` 写法存在隐患：前端强制选美容师才能通过约束，逻辑上无防御性兜底
- ⚠️ `UDT_S_762.UDF_S_843` 售前预约/到店时间未对接：65% 与服务日期同日 / 35% 不同日，**确实承载历史预约语义**。若业务需追溯，应在最终迁移：① service_orders 加 `legacy_appt_time` 列直接抽；或 ② 每行 UDT_S_762 派生一行 appointments(status='已完成')；但 WorkFine 端没有"取消/超时关闭"概念，仅能映射到完成态
- `appointments.cancelled_reason` PG 0/5 行非空（seed appt-005 已取消但理由空字符串）— 运行时 cancel 写 `cancelledReason \|\| ''`，**空字符串**进库；建议改成 NULL
- `appointments.sale_item_id` 4/5 非空（seed appt-005 取消未挂卡）— 表示业务允许"先约后选卡"，但目前 staffApi `service.create(appointmentId)` 链路是否能吃 NULL sale_item_id 待核（与 05/service_items.sale_item_id 严依赖矛盾）
- PG 现状 5 行全部由 `admin/src/db/seed.ts:L253-257` 一秒内 INSERT（appointment_id 格式 `appt-001..005` 非生产格式）— 生产环境 0 真实预约

## 07 / permission_roles

- 整表零直接 WorkFine 字段映射：sync 仅在 PG 内对 `staff_wechat_users + stores + org_nodes` 做 JOIN 推导，**质量传递自上游 03-user / 02-org**
- ⚠️ `updated_by` 在 `assignRole` / `revokeRole` 路径**未填**（admin actions 漏写） → PG 25 行 NULL，与 `created_by` 不对称；如未来用此列做"上次谁改"审计需补
- ⚠️ 5 个在职员工（in-service 2020 vs distinct perm_emp 2015）**无任何权限行**：sync-workfine.js:L442 `if (!storeScope) continue` 跳过 store_id IS NULL 的员工。最终迁移需决定是否补默认 staff 行
- ⚠️ "代理经理" position（pos.includes('代理')）被 sync-workfine.js:L448 强制降级为 `role=staff`，**剥夺 manager 权限**；148 manager 行可能漏掉应授权但被代理标识压制的人
- ⚠️ spec `workfine-sync.spec.md §4.6` 文档过时：写"其他 → role=employee"但实际代码 fallback 是 `staff`（PG enum 也只有 staff，无 employee）
- 历史撤销记录已物理删除：archive `0016_permission_roles_hard_delete.sql` 把 `is_void`/`voided_at` 列 DROP 了，所有 `is_void=true` 行被一次性 DELETE，**无法追溯历史撤销审计**；如需恢复需从 `operation_logs.action='permission.revoke'` 重建
- WorkFine 平台 `tb_sys_role`(22 行)/`tb_sys_user_role`(169 行)/`tb_sys_role_org`(170 行) 等 7 张系统表与本模块**完全无关**（WorkFine SaaS 平台级管理角色，如 `系统管理员`/`模板设计者`），**不应对接**——记入 gaps 仅作已确认无关佐证
- sync 仅产出 3 个 role（`staff`/`manager`/`finance`），剩余 4 个 enum（`admin`/`hr`/`product`/`customer_mgr`）必须依赖 admin UI 手工分配；PG 现状 10 行符合预期

## 08 / commission_rate_matrix

- 整表 100% 新系统独立，WorkFine MSSQL **完全无业务对应实体**（probe `sys.extended_properties` 描述含"提成"/"分成"/"抽成"/"比例" 全部 0 行；表名包含 commission/rate 仅命中 19 张 SaaS 平台 `tb_sys_strategy_*` 与提成无关）。最终迁移脚本对本表**无源可抽**

## 09 / coupon_templates

- 整表 100% 新系统独立，WorkFine MSSQL **完全无业务对应实体**（probe `INFORMATION_SCHEMA.TABLES LIKE '%coupon/voucher/ticket/cashbond%'` 0 行；`sys.extended_properties` 列描述含 `券`/`抵扣`/`优惠` 0 行；表级描述含 `券` 0 行）。本模块没有任何 migrate / sync 脚本，admin/cron/share-gift 全部新系统独立录入
- ⚠️ `coupon_templates.template_id` **命名混杂**：3 行 `coupon-tpl-NNN`（seed）+ 5 行 16-char hex（早期 admin 后台录入）+ 1 行 `tpl-{Date.now()}`（admin 后期录入）；最终迁移可保留全部命名空间无强约束
- ⚠️ `coupon_templates.applicable_*_ids` 全部 text[]，**无 FK / 无 DB 约束**（applicable_product_ids → products / applicable_category_ids → product_categories / applicable_store_ids → stores / applicable_market_ids → org_nodes type='市场'）— admin 改下游主键不会自动失效模板引用数组，最终迁移前需扫描 dangling refs
- `coupon_templates.max_discount` 0/9 行非 NULL — **折扣券封顶机制当前无任何模板使用**（seed `coupon-tpl-003` 原有 200 元封顶配置在 PG 现状被人工改成 NULL）
- `coupon_templates.applicable_market_ids` 1/9 行 / `applicable_store_ids` 2/9 / `applicable_category_ids` 2/9 / `applicable_product_ids` 0/9 — **大部分模板"全场可用"**，复杂适用范围功能未被实际使用

## 09 / user_coupons

- 整表 100% 新系统独立，从未在任何 migrate / sync 脚本被 INSERT
- ⚠️ `expire_at` 派生算法 **6 副本不一致**（admin issueCoupon / batchIssueCoupons / cron-birthday / cron-thanksgiving / cron-upgrade / share-gift × 3 副本），其中 cron-thanksgiving 硬编码 10 天忽略 validity_mode，cron-birthday + cron-upgrade + share-gift 有 365/90 天兜底，admin 配置异常直接报错。同模板同时段发出的券 expire_at 可能不同。最终迁移直接拷现状值无需重建，但运行时持续脆弱（关联 ticket `coupon-template-validity-validation.md §5.4`）
- ⚠️ `face_value_override` schema 注释"分享礼等场景写入；NULL 时回退到 template.discount_value"——三个运行时副本（client/staff/payNotify share-gift.js 字节级一致）+ admin/staff/client coupon 列表读取点都用 `COALESCE(uc.face_value_override, ct.discount_value)`，但 `refunds.ts:L347` 计算会员降档"已享用券价值"时**只读 ct.discount_value 不读 uc.face_value_override**，分享礼券的真实使用值被算成模板默认值，可能高估 → 会员降档处罚偏严
- ⚠️ user_coupons 状态 `'已过期'` **无定时清扫器**，仅依赖 `coupon.list / coupon.available` 入口（client + staff 双副本）懒扫一次。如顾客长期不打开列表，券会卡在 `'未使用'` + `expire_at < NOW()` 状态。SQL 查询用 `expire_at > NOW()` 二次过滤防御
- PG 5434 现状 17 张 user_coupons **全部 `cpn-*` 命名空间**（admin issueCoupon / batchIssueCoupons），**cron 三 STEP（生日/感恩日/升级）+ 分享礼三副本运行时路径完全无产出**——疑似 cron-worker 未实际运行 / system_configs 的 couponTemplateIds 数组为空 / 真实顾客无 inviter_user_id（5 行 seed 客户）
- WF `UDT_S_311.UDF_S_17856 / 17857 / 17858`（顾客侧 47k/52k/44k 行 decimal，含义未明）— **可能是顾客现金券累计余额/可用/冻结分类**，最终迁移前应业务侧确认；如确认是券余额，需评估是否回填到 prepaid_cards（11/储值卡 schema）或新增字段
- WF 销售单级 3 字段 `UDT_S_209.UDF_S_17190 赠送现金券`（1547 行 > 0）/ `UDF_S_17216 本单消耗现金券`（18 行 > 0）/ `UDF_S_17194 余额`（81568 行全部填充）— 已在 01-order 列入 gaps，**无法重建 user_coupon 实例**（缺 coupon_id/template_id/状态/过期时间/适用范围）；如需历史追溯应在 sale_orders 加 legacy_grant_coupon_amount / legacy_redeem_coupon_amount 两列直接抽，**不要派生 user_coupons 行**
- ⚠️ **覆盖度严重不足**：PG 24 个市场（`org_nodes WHERE type='市场'`）仅 3 个有提成规则（南昌/九江/Y九江），其余 21 个市场云函数 `getCommissionRates` 直接抛 `INVALID_PARAMS: 未找到市场 "${marketName}" 的提成配置`。**21 个市场的店长目前完全无法做营业额分配**——业务侧必须补齐，否则正式上线后大面积分配失败
- ⚠️ `role_type='推广'` 1 行残留：archive `0010_commission_role_rename.sql` 已 `UPDATE 推广 → 推广师`，但 baseline reset 后又有 1 行（南昌市场销售单/自销自耗，created_at=2026-03-13，rate=0.05）进入。运行时 `service.complete`（service.js:L404）按 `staff_wechat_users.skills[0]` 取角色（约定值 `推广师`），与本行 `推广` 不相等，**该行永远命中不到任何员工**，rate=0 → 推广员永久无提成。最终迁移前必须 `UPDATE commission_rate_matrix SET role_type='推广师' WHERE role_type='推广'` 或 DELETE
- ⚠️ `service.commission.missing_rate` 容错仅写 `operation_logs` 不告警：21 个市场长期 rate=0 不浮出业务面，**实质损失提成发放但无人察觉**。建议加 cron / dashboard 红线告警
- `amount_tier_max` UNIQUE 不参与，应用层 `hasTierOverlap` 无 advisory lock，多线程并发录入存在生成重叠行的隐患（DB 不强约束）
- spec `backend.pr.spec.md §2.7` 列示例 `order_type` 为 `"sale"、"service"` + `role_type` 为 `"技师"、"推广"`，与 archive 0009/0010 + 0010_fix 后的实际中文枚举不一致，文档过时
- `getCommissionRates` 用 `marketName` 字符串 JOIN（`WHERE org_nodes.name = $1`）：admin 改市场名后本表行不会失效（org_id hashId 不变），但前端 `currentMarket.name` 查询会失败 → 市场改名是潜在 break 风险

## 10 / point_transactions

- 整表 100% 新系统独立，WorkFine MSSQL **完全无积分实体**（probe `sys.extended_properties` 列描述含"积分/会员积分/积分余额/奖励分/points" 0 行；列名含 `point/score/credit/积分` 仅 4 行 SaaS 平台无关列；表名/描述含"积分" 0 行）。本模块没有任何 migrate / sync / backfill 脚本，5 个运行时入口（cron 三 STEP + 消费链 3 副本）是唯一数据来源
- ⚠️ **PG 5434 现状 0 行**（point_transactions 完全空 + `client_wechat_users.points_balance > 0` 用户数 = 0 + `points_updated_at IS NOT NULL` 行数 = 0）：cron-worker 在 5434 baseline reset 后从未成功写入，消费链 3 副本（payNotify / clientApi / staffApi）也无任何产出。需运维侧核实：① cron-worker 是否实际部署 + 启动 + 能成功跑 STEP 2/3/4；② `system_configs` 的 `birthday_benefits` / `thanksgiving_benefits` / `member_level_benefits` 是否有有效配置；③ `POINTS_ACCRUAL_ENABLED` feature flag 是否被误关；④ 真实订单是否触发过 settlePointsForOrder（sale_orders 142811 行不可能全部 amount<100 → floor=0）
- `customer_points` 表已 archive 0016 物理 DROP，余额迁入 `client_wechat_users.points_balance`（archive `manual-applied/0011_merge_customer_points_into_client_users.sql` 一次性 UPDATE 完成）。最终迁移不需要重建 customer_points，但需保证 03-user 模块的 points_balance / points_updated_at 字段血缘记录正确
- ⚠️ `point_transactions.type` 列从 enum 退化为 text（archive 0016:L57-58）+ 默认值 `'获取'`（实际写入路径 5 个全显式覆盖，default 永远命中不到）。已知 5 个取值：`'生日积分'` / `'感恩回馈'` / `'等级升级奖励'` / `'消费赠送'` / `'消费冲销'`。最终迁移可评估是否收紧回 enum，但需先固化全部取值
- ⚠️ `external_ref` 仅 cron 三 STEP 写入（`birthday-pts-` / `thx-pts-` / `member-upgrade-`），消费链 3 副本永远 NULL（依赖 ref_order_id 差值法天然幂等）。两套幂等机制并存——最终迁移如统一改成 external_ref 唯一通道需评估对消费链 delta 算法的影响
- ⚠️ 三处 `utils/points.js` **字节级一致副本**（client + staff + payNotify），云函数独立部署单元跨目录 require 不可行。任一处修改后必须同步另两端，是脆弱点
- ⚠️ `refresh-member-levels.ts` 处理降级时**不 INSERT 反向流水也不减 balance**——降级仅清 `member_level_locked_until` 改 `member_level`。如顾客先升后降再升，第二次升级 `external_ref = member-upgrade-{userId}-{toLevel}` 命中 ON CONFLICT → RETURNING 空 → **不重发升级奖励**。属设计决策（同档不复发），若业务侧期望"二次升级要补发"需重新设计幂等键
- ⚠️ `refunds.ts:L398-414` 用 `external_ref = member-upgrade-...` 查升级奖励 + `amount<0 AND created_at>=upgradedAtThreshold` FIFO 近似归属"已享用积分"。当顾客同时消耗消费赠送积分和升级奖励积分时，FIFO 把"消费赠送被消耗的部分"误算入"升级奖励被消耗" → **高估 usedUpgradePoints → 高估 suggestedOverdraftDeduction**（会员降档处罚偏严）
- ⚠️ STEP 5（`audit-points-balance.ts`）**仅告警不修复**（决策 D7）：发现 `points_balance ≠ SUM(amount)` 偏差时只 INSERT operation_logs + notifyOps 推企微，永远不 UPDATE points_balance。如果上游入口写流水但漏 UPDATE balance（或反之），偏差会持续累积，必须人工查清来源后手工修
- ⚠️ `point_transactions` 无 `updated_at` 列（流水表设计），admin 列表页 `orderBy(desc(createdAt))` 是约定例外（actions/points.ts:L149 显式注释）

## 11 / prepaid_cards

- ⚠️ **schema 完全无 `expire_date` 列**：WorkFine 端 `UDT_M_213.UDF_M_7122` 是充值/疗程卡到期日（migrate-active-cards 脚本 L116 还过滤 `expire_date > NOW()` 才算活跃），到 PG prepaid_cards 表完全消失，**余额永不过期**。如业务侧依赖该约束（"几年前的余额不能再用"），最终迁移必须加 expire_date 列 + 过期清理 cron
- ⚠️ `card_id` 形如 `'CARD-{storeId}-{userId}'`：0003_abandoned_aqueduct.sql DROP `store_id` 列后，PK 字符串里仍**不可逆**残留 store_id 段（1761/1763 行符合该模式，2 行例外是 admin/UUID + 运行时 `FY-CARD-{ts}{rand}`）。最终迁移建议规范化为 UUID 或 FY-CARD 前缀，与运行时统一
- ⚠️ `balance` 对赠品卡走 fallback 链 ②（`unit_price`）或 ③（`received`），可能高估"可退现金价值"。**未抽 `UDT_M_213.UDF_M_4939` 赠送标志**，赠品卡与正常卡在 PG 端无法区分
- 充值卡名称信息丢失：`sale_items.product_name`（如「2024 福利预存款」「202.4预存款」「会员卡充值」）未对接到 prepaid_cards / card_transactions 任一表的描述列。多张同价位卡无法区分来源
- product_name LIKE 关键字筛选 (`%充值%/%储值%/%预存%/%余额%`) 命中 2496 行，但 WorkFine UDT_M_213 端含相同关键字的 3158 行，**差额 662 行**（可能是 01/order migrate 已过滤掉的过期/无客户/无门店项；或关键字漏 case 如「会员卡」「现金券」）
- 同 user 历史多卡信息（0003 migration 前 (user_id, store_id) 拆分）已被合并丢失，**无法回溯各店原始充值额**

## 11 / card_transactions

- ⚠️ **0 行 type='扣款'**：5434 现状 2499 行全为 type='充值'，扣卡运行时链路（`staffApi/order.confirmOffline 储值卡抵扣` / `approveRefund 回冲` / `createRepayment` / `createRefund` 共 5+ 处 INSERT card_transactions 入口）在 baseline reset 后从未产出。需运维侧核实：① 是否有顾客做过储值卡抵扣 → confirmOffline；② 充值卡订单是否走过创建-抵扣闭环；③ 是否所有 1763 张卡都还是初始余额未动
- ⚠️ `amount` 对赠品卡和零金额订单是 fallback 估值，不是实付金额；与 `sale_items.received`（实付现金）字段未关联，**无法重建"实际现金支付额"**（如顾客 ¥1000 卡用 ¥800 现金 + ¥200 礼券购买，PG 端只有 ¥1000 入账记录）
- 幂等键 `(card_id, type='充值', ref_order_id)` 仅由应用层保证，无 DB UNIQUE 约束。批量重跑脚本 / 运行时 race 都可能产生重复行
- type='充值' 流水的 `created_at` 直接拷自 `sale_orders.sale_order_datetime`，**不是 PG INSERT 时刻**——审计"何时入账"必须用 admin 端 sale_orders.created_at 反查（已在 01/order 文档说明）

## 12 / messages

- 整表 100% 新系统独立，WorkFine MSSQL **完全无消息/通知/站内信实体**（`notes/research/workfine_database.md` 全文检索 "消息/notification/通知/message" 0 命中）。本模块没有任何 migrate / sync / backfill 脚本，6 个运行时入口（cron 三 STEP + share-gift 三副本）是唯一数据来源
- ⚠️ **PG 5434 现状仅 1 行**（id=2，title=`'测试'`，2026-04-09 单点）：6 个生产入口在 baseline reset 后**全部 0 写入**。与 10/points 模块同源问题——cron-worker 在生产环境疑似未正常运转，share-gift 链路也无任何分享单产出。需运维侧核实：① cron-worker 是否实际部署 + 启动 + 能跑 STEP 2/3/4；② `system_configs` 的 `member_level_benefits` / `birthday_benefits` / `thanksgiving_benefits` / `share_gift` 是否有有效 messageTitle 配置；③ share-gift 的 payNotify 触发链路是否有产出
- ⚠️ `recipient_type='员工'` 永远命中不到：enum 预留员工通知通道，但**无任何代码写入员工消息**，staffApi 也无 message 路由（cloudfunctions/staffApi/routes/ 无 message.js）。是死值还是后续要做的接口？需产品侧确认
- ⚠️ `message_type` 仅写 `'system'`，schema 注释（L21）说"如 order/appointment/service/system"4 类，运行时**6 个入口全部硬编码 `'system'`**。前端按 `message_type` 区分图标/分组 UI 当前无法工作
- cron 三 STEP（升级/生日/感恩）写消息时 `ref_entity_type` / `ref_entity_id` **全 NULL**（仅 share-gift 三副本写 `'sale_order'`）：前端"点击跳详情"路径走不通；如业务期望升级消息能跳到积分流水或会员档案页，需在 cron 入口补 `ref_entity_type='customer', ref_entity_id=userId`
- ⚠️ share-gift 三副本（client / staff / payNotify）字节级一致：与 points 模块同样的脆弱性，云函数独立部署单元跨目录 require 不可行。任一处修改 messages INSERT 列必须同步改另两端
- 没有任何"消息已读批量清理 / TTL 删除 / 归档"路径：messages 表会无限增长，cron 三 STEP × 客户数 × 365 天后量级会失控；最终迁移可考虑补一个清理 cron 或加分区
- 没有"未读数推送"或"客户端消息中心入口主动通知"机制：客户必须主动进消息列表才会触发 read.js → UPDATE is_read，否则一直挂"未读"角标
- ⚠️ `messages` 无 `updated_at` 列：is_read 翻转后无审计时间；admin 端列表/统计 orderBy 走 `desc(createdAt)`

## 13 / operation_logs

- 整表 100% 新系统独立，WorkFine 端无对应业务审计实体。`tb_sys_log`（208 万行）/ `tb_sys_workflow_task_log`（1.1 万行）属 WorkFine 平台层日志（log_what 是"创建表单/用户登入登出"，log_who 是 WorkFine 内部用户 int id），**语义不与 PG `<module>.<method>` 业务 action 对齐，最终迁移不应导入**
- ⚠️ **PG 5434 现状 295 行**：seed.ts 占 7 行（id=1..7，含 4 行虚假 source='staffApi'），其余 286 行全部由 admin actions `logOperation()` 写入。**实际运行时 cloudfunctions（staffApi/clientApi/payNotify）+ cron 在 baseline reset 后写入 ≤ 5 行**（cronTask=1，staffApi=4 但全是 seed 虚构）。运维侧需核实：① cron-worker 是否实际产出 refresh-member-levels / 生日 / 感恩 / settle-failed 等审计行；② staffApi share-gift / service.complete.rate_missing / settlePointsSafe 三处运行时入口是否真的没触发过
- ⚠️ `org_node_id` / `org_node_name` 在 cloudfunctions 入口（staffApi service.js / share-gift / points / payNotify / cron 5 STEP）写入路径上**架构性缺失**：只有 `lib/operation-log.ts:L40-58` 主动 SELECT org_nodes 反查（admin 路径），其他 12+ 个直接 SQL INSERT 入口都不写 org_node_id/name → 这两列在 cron / share-gift / settleFailed 行恒为 NULL。当前 PG 表面填充率 294/295 是 seed 把 org 字段写满的假象。如果 admin 后台日志页对 org 列做硬过滤（如 `WHERE org_node_id = $1`），cron 写入的告警类日志会被遗漏
- ⚠️ `detail` JSON schema 跨 V1 / V2 / V3 三套版本无升级策略：
  - V1：早期 `logOperation` 直接传任意对象（占多数）
  - V2：`logUpdate` / `logTransition` 包装 `{ _v: 2, _t: 'update'|'transition', changes/from/to }`
  - V3：仅 cron `customer.memberLevelChange` 用 `{ _v: 3, _t: 'transition' }`（与 lib 默认 V2 不一致）
  - 下游消费方（admin logs.ts）直接返回 jsonb 给前端，不解析；后续如需统计/筛选 detail 字段需 case-by-case
- `action` / `target_type` 没有枚举常量约束，全部字符串字面值散落在 12+ 调用点，命名约定为 `<module>.<method>` 实际形成 50+ 命名空间。新动作完全靠 grep + 代码评审保证一致；admin `logs.ts:L52` 已用 `like '${module}.%'` 模糊匹配
- `target_id` 类型不一致：业务表用主键字符串，cron `dataIntegrity.roleTypeNull` 把表名（`'sale_allocations'`）当 target_id；admin 后台按 (target_type, target_id) 分组 SQL 会出现"伪同实体"聚类
- ⚠️ staffApi / clientApi / payNotify 三副本：`share-gift.js` 的 `INSERT INTO operation_logs ('share.giftGranted', ...)` + `points.js` 的 `INSERT INTO operation_logs ('points.settleFailed', ...)` 各有 3 份字节级一致拷贝（与 12/messages 同源问题）。任一字段调整需三处同步改，长期 drift 风险高
- seed.ts 7 行（id=1..7）2025-2026 年虚构时间戳混淆 source 区分：4 行 `source='staffApi'` 实际是 admin 端 seed.ts 写入，审计 SQL 用 source 区分入口时需排除 id ≤ 7；最终业务上线后建议 truncate 或 mark `source='seed'`
- migration 0032 已 DROP NOT NULL on `operator_employee_id` / `operator_name`（系统级 cronTask / payNotify 不必有操作人）；但 `action` / `target_type` / `target_id` 仍 NOT NULL，cron audit-role-type-nulls 用表名占位 `target_id` 也算合规绕过

## 14 / service_commissions

- ⚠️ `allocation_ratio` 100% NULL（616,210/616,210）：migrate-service-records.js INSERT 列清单仅 6 列不含此列；runtime service.js:L438 写硬编码 `1.00` 但 PG 0 行运行时产出。**多员工分配语义在 PG 中完全空缺**，最终迁移如要重建需基于 sale_allocations 反推或全部硬编码 1.00
- ⚠️ `consume_amount` 100% = 0：archive 0018:L17-19 把全部 commission_amount 兜底回填到 fixed_fee，consume_amount ADD COLUMN DEFAULT '0' **不回填**；runtime service.complete 路径才会产生 consume_amount > 0 的行（PG 现状 0 行）。**双字段模型（fixed_fee + consume_amount）在历史数据中完全不成立**
- ⚠️ `commission_rate` 派生语义彻底不兼容：migrate 路径用 `Math.min(9.9999, service_fee / unit_real_price)` 数学反推（distinct=141, min=0.01, max=9.9999, avg=1.1445）；runtime 路径用 `commission_rate_matrix WHERE order_type='服务单'` 矩阵查询（一般 0.01~0.30）。**PG 现状 100% 行是 migrate 派生值，与提成矩阵无关**
- ⚠️ migrate-service-records.js `WHERE YEAR(UDF_S_822) >= 2025` 硬切片：UDT_M_260 中 2024 年 213,304 行 + 2023 年 147,177 行 + 早期 50+ 行 = **约 360,000+ fee>0 行完全未导入 PG**。员工 2024 及更早的服务提成在 PG 中不可见
- ⚠️ WorkFine 脏数据未做卫语句被直接传入：MAX `commission_amount = 22,864,061.73`（HLD-2409280171 sess_used=99,769、unit_price=229.17）；TOP3 还有 11,755,596 / 9,999,990。最终迁移建议加 `sess_used BETWEEN 1 AND 100` 或类似卫语句
- ⚠️ `role_type` 派生路径双源不一致：
  - migrate-service-records.js:L168 用 `skills[0]`
  - migrate-presale-services.js:L301 用 `skills[0]`
  - backfill-service-commissions-roletype.js:L60 用 `skills[1]`（**注意**：与 migrate 不一致）
  - runtime service.js:L396 用 `skills[0]`
  - PG 现状全表由 backfill 兜底（baseline reset 后 role_type 全 NULL 触发回填）。最终迁移必须统一为 `skills[0]`，否则 sale_allocations / service_commissions 同员工 role_type 不一致
- ⚠️ runtime `service.complete` 写入 0 行（与 12/messages、10/points 同源问题）：PG 创建时间窗口 100% 在 2026-03-15（migrate 单次跑），baseline reset 后 staffApi 完全无产出。需运维核实是否有任何服务单走过完整 create→start→complete 链
- `UDT_M_260.UDF_M_6902` 是否赠送（143,773 行 ≈ 17% 标"是"）— 赠送服务依然产生 service_fee，提成 PG 端无法区分（与 05/service_items 同 gap）
- `UDT_M_260.UDF_M_842` 顾客满意度 — 关联员工绩效评估，未对接
- `UDT_M_260.UDF_M_838` 员工职位（如"督导"/"美容师"/"养生学徒"）— 比 `staff_wechat_users.skills[0]` 更准的角色派生候选源
- `UDT_M_260.UDF_M_2473` 职位序列编码（"第一职位"等）— 与 sale_allocations.UDF_M_2315 同套编码，未对接
- ⚠️ `commission_rate_matrix` 21 个市场缺规则：runtime 写入会取 rate=0 + INSERT operation_logs.action='service.complete.rate_missing'，业务**静默失败**不浮出业务面（与 08/commission gap 同源）
- ⚠️ workfine_database.md L689 把 `UDF_M_840` 标注为"服务费"是错的：MSSQL 探源 99.997% 行 ∈ [1, 300]、avg=12.77、max=2500（典型分钟数），sample 也显示与 service_fee 不等；正确含义是"服务时长（分钟）"。05/service_items 之前标记的"字段映射存疑"可结案为**脚本对、文档错**

## 15 / pickup_records

WorkFine 无任何 pickup 类语义实体（`sys.tables` / `sys.extended_properties` 全 0 命中），本模块 100% 新系统独立、无字段流失。

### 运行时风险

- ⚠️ `pickup_records` 整表 **0 行** + 上游 `sale_items.product_type='家居产品'` 仅 1 行（`picked_up_quantity=0`）：admin 已实现完整 `createPickupRecord` 事务（带原子累加 + scope 校验 + 审计日志）和列表/详情/创建页 UI，但 5434 至今从未被业务触发。最终迁移如果新增家居产品 SKU 数据，需 e2e 回归 `getAvailablePickupItems` → `createPickupRecord` 全链路。
- ⚠️ 架构上**无 cloudfunctions 入口**（staffApi / clientApi 均无 pickup action）：所有提货记录仅能从 admin web 创建，员工端小程序和客户端小程序无对应 UI 或接口。如未来要支持员工端扫码提货，需新增 staffApi 路由 + 复用 admin 端的事务逻辑。

## 16 / store_unbind_requests

WorkFine 无任何"门店绑定 / 解绑 / 申请"语义实体（`sys.tables` / `sys.extended_properties` / `notes/research/workfine_database.md` 全部 0 命中），本模块 100% 新系统独立、无字段流失。

### 运行时风险

- ⚠️ **clientApi `requestUnbind` SQL 列名 Bug**：`fengyu-client/cloudfunctions/clientApi/routes/store.js:156-158` INSERT 写入了不存在的列 `from_store_name`（PG schema 列名是 `from_store_id`），且入参传的是 `boundStoreName` 字符串而非 store_id（hash）。每次顾客点击"申请解绑此门店"必抛 `column "from_store_name" does not exist`，PG `store_unbind_requests` 自上线以来**从未成功写入过任何一行**（5434 现状 0 行），整条解绑业务链路对顾客端永久失效。修复：列名改回 `from_store_id`，入参改用 `ctx.auth.boundStoreId`。优先级高于任何迁移工作（业务功能完全失效）。
- ⚠️ **staffApi vs admin 审批联动清空字段不一致**：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:94` 仅清 `client_wechat_users.bound_store_id`；`fengyu-admin/src/actions/store-unbind.ts:93-94` 同时清 `bound_store_id + bound_employee_id`。staff 端审批通过后顾客的 `bound_employee_id` 残留，与 admin 路径行为不一致。
- ⚠️ **缺业务索引**：高频 WHERE 条件 `(user_id, status)`（clientApi:L147/L177）和 `(from_store_id, status)`（staffApi:L56/L368）无复合索引。当前 0 行无影响，业务放量后会全表扫。
- ⚠️ **updated_at 三套写法共存**：clientApi/staffApi 手写 `SET updated_at = NOW()`，admin 走 Drizzle `$onUpdate` hook（schema:L20），运行时一致但代码风格不统一；如果未来某个路径漏写手动 `updated_at`，admin 默认排序 `desc(updatedAt)` 会失真。

## ⚠️ EDGE / 16-store-unbind

> R2 8 维度审计 verdict = **serious-edge-cases**（命中 6/8：FK + drift 干净，其余 6 维全命中；HIGH×3 + MED×1 + LOW×2）
> 探针：5434 实测 rowCount=0 / FK 4 完整 / orphan 3 项 0 行 / 列结构 9/9 与 schema 严格匹配 / opLog `store_unbind%` 命中 0 / `bound_employee_id` 当前 4218 行均叠在 bound_store_id 之上（emp_only_orphan=0）

### HIGH 级（P0 bug 修复**之后**必须立即跟进，否则放新隐患到生产）

- ⚠️ **partial unique 兜底缺失**（维度 4：unique 守住）：clientApi:L146-152 通过 SELECT-then-INSERT 检查"是否已有 pending"，中间无 advisory lock，**双击/并发提交可绕过**生成 2 行同 user_id 待处理申请。staff 端列表会同时展示 2 行需分别审批，任意一行通过后另一行 status 仍 '待处理' 永远悬挂。修复：补 `CREATE UNIQUE INDEX ON store_unbind_requests (user_id) WHERE status='待处理'`。R1 仅自报"放量性能差"，未识别这是**正确性**问题。
- ⚠️ **bound_employee_id 隐式不变量风险**（维度 5：跨模块一致性）：5434 实测 4218 行 `bound_employee_id IS NOT NULL`、`emp_only_orphan=0`，业务上"绑员工必绑门店"是隐式不变量。staff 路径审批 `bound_store_id=NULL` 但保留 `bound_employee_id`，会逐渐打破不变量；admin 路径行为正确（同时清两字段）。修复：staffApi/store.js:L93-96 同步加 `bound_employee_id = NULL`，与 admin 对齐。
- ⚠️ **死代码连锁** （维度 6）：除 R1 已自报的 P0 INSERT 列名错（永不命中）外，下游 4 个查询入口（clientApi getUnbindRequest/cancelUnbindRequest + staffApi unbindRequests + admin getUnbindRequests）+ admin/staffApi 4 个审批/拒绝路径合计 **8 个代码路径连续 17+ 天 0 行真实流量**，单元测试覆盖但生产从未触发。

### MED/LOW 级

- ⚠️ **审批并发重复 UPDATE 双写审计**（维度 8 LOW）：admin/store-unbind.ts:L82-96 SELECT-then-UPDATE 中间无 row lock，两个店长同时点"通过"，bound_store_id=NULL 是幂等的（无害），但 `operation_logs` 会同时产生 2 行 `store_unbind.approve` 审计记录，看起来"被通过了两次"。修复：admin update WHERE 加 `AND status='待处理'`，rowCount=0 时跳过 logTransition。
- ⚠️ **scopeCondition + LIMIT 顺序**（维度 8 LOW）：admin/store-unbind.ts:L43 `LIMIT 500` 在 `scopeCondition` 之后，对 admin 角色合理；当业务体量起来，需要补真正的服务端分页（参考 admin.sys.spec.md §5）。
- ⚠️ **NULL/空串混淆**（维度 2 LOW）：clientApi:L158 入参 `boundStoreName \|\| ''` 用空串兜底，P0 修复后改用 `boundStoreId` 时若沿用此模式，from_store_id NOT NULL 列会接受空串，触发 FK 反查 stores 0 行而抛错。修复时显式 `if (!boundStoreId) throw INVALID_PARAMS`。

## 🔧 EXTEND / 16-store-unbind

> WorkFine 完全无解绑实体（R1 三轮 + R2 重判 0 命中），所有候选均为**新系统独立列**

- **P1.1 `cancelled_at` / `cancel_reason`**：取消时间和原因。当前 cancelUnbindRequest 只改 status='已取消' + updated_at，丢失"何时取消、为什么取消"的核心审计信息；与 reviewed_by/reviewed_at/reject_reason 三件套对称。前端弹窗收集 reason，时间戳 = NOW()。预期年级 100~1000 行（58797 个 bound_store 顾客 ×解绑率 0.1~1%）
- **P1.2 `requested_employee_id`**：顾客在哪个员工/店长引导下提交解绑（区分"店长引导转店" vs "顾客主动流失"）。clientApi requestUnbind payload 加 `referredByEmployeeId`，FK staff_wechat_users.employee_id，NULLABLE。同时辅助统计"店长 X 帮助过几个顾客解绑"
- **P1.3 `reviewed_via`**：审批来源端枚举 `'staff_app' / 'admin_web'`。当前 reviewed_by 字段无法区分审批渠道，而两个渠道**联动逻辑不同**（staff 仅清 store_id、admin 同时清 employee_id），出问题时无法快速定位
- **P2.1 `from_store_name`** 快照（**注意**：与 P0 bug 误用的列名同名，但语义不同 — 这里是历史归档快照而非 FK 替代）：远期门店行可能彻底删除，丢失上下文；与 sale_orders.store_name 已采用的模式一致
- **P2.2 `expected_response_at`** SLA 超时（如 `created_at + 7 days`）：让 cron 直接 `WHERE expected_response_at < NOW() AND status='待处理'` 拉超时清单。字段先有不阻塞产品决策
- **P2.3 `unbind_reason_category`** 解绑原因结构化枚举（搬家/转店/服务不满意/误绑/其他）：当前 note 是自由文本无法做"流失原因分布统计"。前端弹窗强制单选

**总结：P0×0 / P1×3 / P2×3**。无 WF 字段反推；P0 修复后可任意节奏推进。

## 17 / system_configs

WorkFine 无任何"业务级 key/value 配置表"语义实体。MSSQL 探源结果：

- `sys.tables` 名称 LIKE '%config%' / '%setting%' / '%threshold%' / '%param%' → 4 命中，**全部** 是 WorkFine 平台元数据：
  - `tb_sys_setting`（11 行）只存 SystemName='凤御 数据管理平台'、登录页 logo PNG、企业微信 corpId/Secret、备份目录 JSON、UUID（id=1）—— **零业务运营参数**
  - `tb_sys_api_param` / `tb_sys_fun_param` / `tb_sys_stored_procedure_param` 是 WorkFine 工作流引擎的接口/函数参数定义
- `sys.extended_properties` 描述含"门槛 / 阈值 / 开关 / 全局配置" → 0 命中
- `notes/research/workfine_database.md` 全文检索"配置 / threshold / 轮播 / banner" → 0 命中

WorkFine 把业务规则（会员等级阈值、积分汇率、轮播图、升级权益）全部硬编码在工作流引擎的"流程图节点 + 公式表达式"里，没有独立配置实体。本模块 **100% 新系统独立**，最终迁移完全不需要触及。

### 治理问题（key 级）

- ⚠️ **死键 `order_prefix='FY-XSD-WX-'`**：PG 残留 1 行（updated_at=2026-03-21，最早），全仓 grep `order_prefix` 在 `*.js / *.ts / *.sql` 中 0 hits。订单号前缀实际硬编码在 staffApi/clientApi `order.create`。最终迁移建议清理或归档为说明性注释。
- ⚠️ **`order_timeout='10'` 无消费方**：admin `/settings` UI 可保存（`SystemSettings` interface 含此字段），但 cloudfunctions / cron-worker / scripts 全 0 处读取。产品需求半残留：可能曾计划做"待支付订单超时关闭"但只完成配置入口、未接 cron 消费方。
- ⚠️ **`share_gift_config` 设计实现 + 业务未启用**：admin `saveShareGiftConfig` 与 share-gift 三副本（payNotify/clientApi/staffApi）读取链路均已实现，但 PG 现状此 key **不存在**。share-gift 自上线起 100% 走 `granted: false, reason: 'no_config'` 静默降级，与 `09/user_coupons` 文档"分享礼三副本零产出"完全自洽。需要业务方在 admin `/share-gift` 页启用一次。
- ⚠️ **`points_to_yuan_rate=0.01` 没有 admin UI**：`SystemSettings` interface 不含此字段，仅由 0006 migration `INSERT ON CONFLICT DO NOTHING` 兜底建出。`getPointsToYuanRate` fallback=0.01。业务方需要调整时只能手动 SQL UPDATE。建议在 admin `/settings` 加输入框。

### 运行时风险

- ⚠️ **`new_member_threshold` 跨进程缓存失效不完整**：admin `saveSettings` 在门槛变更时主动广播 `clientApi.config.invalidateConfig`（settings.ts:L221-232），但 **staffApi / payNotify / cron-worker** 在另一个 envId 或独立进程，admin **不广播给它们**。它们只能依赖 `system_configs.updated_at` 戳的 30 秒被动核对。这意味着改门槛后最长 30 秒不一致窗口期内 staff 端可能用旧值判定会员资格。需要补 `callClientFunction('staffApi', ...)` 和 `callClientFunction('payNotify', ...)` 两条广播。
- ⚠️ **`saveSettings` / `saveMemberBenefits` / `saveShareGiftConfig` 三处都内联 `CREATE TABLE IF NOT EXISTS system_configs`**：baseline 之前的兜底（远程库 schema 未对齐时自我修复），baseline reset 后已是冗余但未删除。属于无害但可清理的代码。
- ⚠️ **测试夹具脚本 `verify-member-level-cron.js` 写生产 key**：脚本会 `INSERT ON CONFLICT DO UPDATE` 把 `new_member_threshold` 改成 `'1990'`、把 `member_level_benefits` 改成测试 JSON。当前仓库无 npm script 自动调用，需手动执行才会触发，但**没有 DB URL 防护**，跑错环境会污染生产配置。建议加 `DATABASE_URL must NOT contain 5434` 的硬校验。
