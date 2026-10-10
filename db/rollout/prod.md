# prod 数据库发布台账

目标：`118.178.196.26:5433/fengyu_wxapp`。同一套 Drizzle 迁移，独立执行记录；详见 [集成规则](README.md)。

历史迁移执行状态：**2026-10-02 v1.17.14 已核对并迁移成功**。0048–0060 共13条正式迁移已执行；61条本地when/hash全匹配，另保留1条既有守卫白名单0034旧记录。详见本次执行及验证证据。

| 请求 | 正式迁移 tag / hash | 前置检查 → 执行 → 后置校验 | 依赖代码 | 状态 | 执行证据 |
|---|---|---|---|---|---|
| [#353](requests/issue-353.md) | `0058_store_surplus_standard_price` / `f7fb41a1127d3e9b61507e6f0199913ea39b309559ccf8858db454c165047690` | 目标断言 + journal/hash 只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下 db:migrate 全部已核准 pending → 列/CHECK/触发函数/hash 校验；额外脚本：无 | #353 标准价与盘溢业务须先迁库后上线；#365 正式生成须等本项合入 dev | 本环境执行成功（v1.17.14，见末尾） | `_tmp/release-prod-v1.17.14/post.json`、`schema-verify.log` |
| [#364](requests/issue-364.md) | 与 #356 共用 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 角色定义只读核对 → 目标断言后的 db:migrate → 角色授权/镜像一致性校验 | admin 新结算页闸，须先迁权限 | 本环境执行成功（v1.17.14，见末尾） | `_tmp/release-prod-v1.17.14/post.json`、`schema-verify.log` |
| [#365](requests/issue-365.md) | `0059_market_supplier_owner` / `332af31a4e32e18752fb85af354ddaec813ad7e07e28f9883a9df51ef76b8c82` | 显式目标断言 + journal/hash、存量总数/启用停用数与名称唯一只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下 db:migrate 全部已核准 pending → `node db/scripts/verify-inventory-v3-schema.js`、存量 NULL 与数量/hash 只读核对；额外脚本：无 | #507 admin 与同构建 export-worker 必须先迁库后发布；#364 权限请求仍待集成 | 本环境执行成功（v1.17.14，见末尾） | `_tmp/release-prod-v1.17.14/post.json`、`schema-verify.log` |
| [#356](requests/issue-356.md) | 与 #364 共用 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 目标断言 + 全部journal/hash只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下db:migrate → lifecycle/有效trigger、权限定义与镜像、hash校验；额外脚本：无 | #356作废与#364结算页须先迁库后发布admin | 本环境执行成功（v1.17.14，见末尾） | `_tmp/release-prod-v1.17.14/post.json`、`schema-verify.log` |

集成完成后填写实际文件路径、内容 hash、前后置校验命令和准确顺序。登记一次性脚本还必须列明幂等性、目标断言、事务和失败续跑方法；没有额外脚本写“无”。

执行后记录：状态（待执行/执行中/成功/失败）、时间、发布 SHA、执行人、迁移 tag/hash、脱敏日志或验证证据。失败不继续依赖代码发布；不得用另一环境的成功记录补本表。

## 2026-10-02 v1.17.14 prod 发版前核验（Codex）

- 用户已回复 `yes` 确认本次生产迁移与版本；发布 SHA `26c13fccd14572790e710d56a6e2f7b1f7b7ced1`。两端 APP_VERSION 已生成 v1.17.14；两站类型检查、staff388/admin27/analyst476测试通过。
- 生产目标 `118.178.196.26:5433/fengyu_wxapp`。只读核验49行journal：48条本地when/hash匹配，另1条为既有守卫明确允许的0034旧记录（未改写）；0048至0060共13条pending。
- 存量采购价缺失、旧采购口径在途发货、主体身份冲突、供应商名称重复均为0；供应商0条。证据 `_tmp/release-prod-v1.17.14/pre.json`。
- 依次0048→0060，经显式目标断言后，`PGOPTIONS=-c lock_timeout=3s` 下统一db:migrate；迁移内含已有review的数据调整，不单独执行修复/回填脚本。随后journal/hash、列/CHECK/trigger/权限镜像、inventory-v3-schema只读核验，再部署依赖代码。额外脚本：无。
- 集成/验证依据：Git中13条正式迁移已合入本发布树；#335/#336/#341/#379/#270/#480私有验证见对应 `_tmp/issue-N/verify.md`；#367见PR394私有事务验证及review记录；#494见PR495隔离PG到0057与真库8例、此前两路review。PR495明确最终HEAD双谱系未补齐，不将其标为最终双谱系通过；本次检查当前不可变SQL、现有验证与发版门禁。0058–0060私有库/最终双谱系依据见原表与 `_tmp/db-integration/current.md`，已随#510/#507/#511合并。dev结果不代替prod结果。

| 正式迁移 | when | SQL SHA-256 | 变更与集成依据 | prod状态 |
|---|---|---|---|---|
| `0048_hesitant_scarlet_spider` | 1789999039383 | `94184dac75fee5877b375c3694631ea6d758f9f4e612a16ed037c4c9c8847af0` | 支付场次快照列（#214）；集成提交 `41d0708fc` | 成功 |
| `0049_purchase_order_all_lines_inbound` | 1790239563071 | `4eb5fe57a50640dce8ac6cf335ef05c5762e027a527c118864c65a0867d8456e` | 采购单金额/履约修正（#335）；集成提交 `acd5e7434` | 成功 |
| `0050_data_center_report_permissions` | 1790269580605 | `b82b67c6910f8d0b90474e3b0262d0654446397faf79ed6fa3d6221737e3c15e` | 报表权限与镜像（#367）；集成提交 `afb26019f` | 成功 |
| `0051_commission_price_threshold` | 1790295411207 | `f5d9653d7b4ff4089036664f6d919c4ba0b0db7d7c5552d4ba7c664787f8939b` | 服务提成阈值（#379）；集成提交 `ea0697e8b` | 成功 |
| `0052_shipment_from_market_report` | 1790302157503 | `d9bdc130d6d4d8460aa1625870674aa39a01674507a4386496d617f96f692979` | 直连市场报货发货（#336）；集成提交 `7d4aaaace` | 成功 |
| `0053_stocktake_zero_quantity` | 1790307069052 | `2541b4805d26e4dbc622f9ffdb634c73329ea776fcc52e3af2ed35ffa19e4941` | 盘点实盘数允许零（#351）；集成提交 `33ce39b84` | 成功 |
| `0054_pickup_frozen_amount` | 1790333373116 | `829d0387d3911499c6d71adedee7f849e8b7cfa551a66ca7c1b950235f19f570` | 提货金额冻结（#341）；集成提交 `0ed3acc94` | 成功 |
| `0055_inventory_location_identity_guard` | 1790673195829 | `b19dc017fda4b2a7b96fc35e314b64b36ec5dff03e04bb352e36e70eb00d2cce` | 库存主体身份守卫（#270）；集成提交 `b9ae8e6ff` | 成功 |
| `0056_allocation_finance_save` | 1790758190587 | `1f8da0224b683fd5ef6e2dbe3179b2d9a92d78553e8d89d45fbc647b1448551b` | 财务分配权限（#480）；集成提交 `feb695201` | 成功 |
| `0057_oval_calypso` | 1790819962098 | `f7e8d89964d313137305fdf47493342eb899f1f5d44785b60101c9fec9a65f5e` | 冻结成交分类与报表业绩（#494）；集成提交 `9f532980b` | 成功 |
| `0058_store_surplus_standard_price` | 1790834272000 | `f7fb41a1127d3e9b61507e6f0199913ea39b309559ccf8858db454c165047690` | 标准价与盘溢（#353）；集成提交 `5047b1c4f` | 成功 |
| `0059_market_supplier_owner` | 1790904222525 | `332af31a4e32e18752fb85af354ddaec813ad7e07e28f9883a9df51ef76b8c82` | 市场供应商归属（#365）；集成提交 `abfa07924` | 成功 |
| `0060_summary_void_store_settlement` | 1790906092154 | `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 汇总作废与结算权限（#356/#364）；集成提交 `7ec1d780b` | 成功 |

### 生产迁移执行成功

- 执行人 Codex，用户本轮 `yes` 授权；时间 2026-10-02T08:05:52.415Z。目标118.178.196.26:5433/fengyu_wxapp，PGOPTIONS lock_timeout=3s，真实db:migrate退出0，13条迁移同事务成功。
- journal现62行=61条本地when/SQL哈希精确匹配+1条既有白名单0034旧记录；无pending，未修复/改写历史。最新0060/hash `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b`。
- inventory-v3-schema全项PASS；7个新增列、2个业绩视图、lifecycle定义、角色新增动作及范围不变、权限镜像、供应商数量和新增字段无额外回填通过。自检脚本初次使用错误提货列名导致检验失败，按0054正式列名pickup_unit_price/pickup_amount校正后通过；数据库无修补。
- 脱敏证据 `_tmp/release-prod-v1.17.14/migrate.log`、`schema-verify.log`、`pre.json`、`post.json`。仅prod成功；本次不操作dev。

### v1.17.14 prod 全量发布完成

- 完成时间 2026-10-02T08:18:36.854Z，执行人 Codex。发布SHA `26c13fccd14572790e710d56a6e2f7b1f7b7ced1`；两站实际revision `26c13fccd145-dirty.f7c06c8ee369`，包含prod台账与两端version.ts未提交改动。构建时差异保存在 `_tmp/release-prod-v1.17.14/release-build.diff`；本台账收尾追加不属于已构建内容，不将dirty发布表述为仅commit可复现。
- admin release `prod-26c13fccd145-dirty.f7c06c8ee369-455142880860-20261002T080554Z-91833`，镜像 `fengyu-admin:prod-26c13fccd145-dirty.f7c06c8ee369-a87938fd433b`；脚本exit0/RELEASE_OK。analyst release `prod-26c13fccd145-dirty.f7c06c8ee369-455142880860-20261002T081202Z-94630`，同版本analyst镜像；脚本exit0/RELEASE_OK。
- 两容器running，HTTP3000/3001均307，DB118.178.196.26:5433/fengyu_wxapp，Analyst origin=https://analyst.meiyayabeauty.com/；镜像ID与配置由部署脚本核验，独立终检见remote-verify.json。
- 显式prod通道串行部署staffApi/clientApi/payNotify，3行deployed、exit0。config pull与fn detail独立回读：PG目标为生产、DEPLOY_CHANNEL=primary；staff false/release、CLIENT_SECRET/CLIENT_APPSECRET完整，client TMAP密钥正确，跨端HMAC一致，client/payNotify的PAYNOTIFY_FN_NAME=payNotify。
- 冒烟：staff空请求-1（缺action，技能允许），staff/client auth.login返回0，client store.list返回0。初次验证脚本误将公开登录0判为失败，检查接口当前行为后校正判据；未修补线上代码。烟测仅证明函数运行与接口响应，不冒称完整已登录业务流程验收。响应证据仅留脱敏code/action，不保留顾客资料。
- 证据 `_tmp/release-prod-v1.17.14/`：迁移pre/post/migrate/schema-verify、analyst-deploy.log、remote-verify.json、cloud-deploy.log、cloud-verify.json及脱敏smoke；admin release记录可在生产版本化发布目录核验。
- `.active=prod`；本次未发布影子函数、未操作dev库、未commit/push。剩余未提交文件：本台账与client/staff version.ts。两端APP_VERSION=v1.17.14，小程序须手工上传两端正式版才能生效。


## 2026-10-02 daily 分支合并

- `0061_daily_report_loop`：SHA-256 `8643243a716f7b6e249af83bd7360b4ee0c8fdc306f0a5d08f8df0602f43ac05`。待部署，生产库未执行日报迁移。
- 原日报分支 `0057_daily_report_loop` 与 dev 既有编号冲突，顺延至 `0061`；SQL 字节和原 `when=1790921441006` 不变，已执行记录可继续按 when/hash 匹配。`0057` 至 `0060` 的 dev 迁移完整保留。
- 合并快照包含最新 dev schema 和三张日报表；`db:generate` 返回无 schema 变化。

## 2026-10-03 日报 V2 集中集成

- 正式迁移 `0062_daily_v2_operating_pk`，when=`1791020803394`，SQL SHA-256 `dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca`。基于最新 origin/dev，在隔离分支 codex/daily-v2-migration 集成日报 V2。
- 内容仅四张新表及 daily_reports 四个 nullable 字段与约束/索引；无删除/回填，旧日报正文和明细不变。复合唯一索引先于引用它的外键创建。
- 私有空库重放63条通过；存量已提交日报升级完整保留；日报47项、后台26项测试通过；DB测试99项通过、13项环境型跳过；两端类型检查通过；生成器二次核验无额外结构变化。
- 用户本聊天已授权 dev 建表、后端及后台更新和联调；沿用跳过双谱系决定。部署顺序：核验 dev 历史→db:migrate→结构与历史回读→dailyApiDev→admin dev→真实小程序联调。无额外数据脚本。
- prod：未授权、未执行、未部署。未来复用本文件，不重生成编号；上线依赖该迁移先执行。

## 2026-10-06 v1.17.23 prod 迁移执行

- 用户确认沿用 v1.17.23，并单独回复 yes 授权生产迁移和后续发布；发布 HEAD bbcad717d。执行人 Codex，时间 2026-10-05T18:14:54.153Z。
- 目标 118.178.196.26:5433/fengyu_wxapp；先只读检查历史，pending 为0061→0062，无额外脚本。沿用上述集中集成与私有验证依据。
- 显式目标断言后，PGOPTIONS=-c lock_timeout=3s 下真实 db:migrate 退出0。0061 hash 8643243a716f7b6e249af83bd7360b4ee0c8fdc306f0a5d08f8df0602f43ac05、0062 hash dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca 已回读匹配，七张日报相关表存在。
- 脱敏证据：_tmp/release-prod-v1.17.23/pre.json、post.json、migrate.log；仅 prod 执行。

### v1.17.23 prod 发布完成

- 执行人 Codex；发布 HEAD bbcad717dc39，实际两站 revision bbcad717dc39-dirty.3a4e68bf5050，包含本台账与两端 version.ts 未提交改动。收尾追加不属于已构建内容，不以 commit 单独代表可复现构建。
- admin release prod-bbcad717dc39-dirty.3a4e68bf5050-dec16b06d9d5-20261005T182345Z-29339；analyst release prod-bbcad717dc39-dirty.3a4e68bf5050-dec16b06d9d5-20261005T182540Z-31804；两脚本退出0、RELEASE_OK。镜像各为 prod-bbcad717dc39-dirty.3a4e68bf5050-a87938fd433b。
- admin 初次切换被旧孤儿备份 running 记录阻断，尚未切容器；只读核实无 pg_dump、内核锁空闲后，在持 runtime.lock 时暂停旧 cron worker，按脚本支持的停止worker恢复路径重试。新版worker恢复运行并自动将2026-09-21孤儿记录标failed，未删活锁或改写备份文件。
- 独立终检：admin/analyst/cron-worker/export-worker均running、DB118.178.196.26:5433/fengyu_wxapp；两站HTTP307，Analyst origin=https://analyst.meiyayabeauty.com/。证据remote-verify.json。
- 显式prod通道串行部署staffApi/clientApi/payNotify成功；独立fn detail回读三函数生产PG/primary、staff false/release与两项secret非空、client TMAP完整、HMAC跨端一致、client/payNotify通知归属payNotify。staff空请求code=-1（缺action，技能允许）冒烟通过。
- 两站类型0错误；staff399/admin27/analyst476测试通过；DB132通过、16环境型跳过。两条迁移后journal门禁通过，无pending。证据目录_tmp/release-prod-v1.17.23/。
- .active=prod，未commit/push。未提交文件：db/rollout/prod.md、client/staff miniprogram/utils/version.ts；两端APP_VERSION=v1.17.23须手动上传正式版小程序生效。独立日报dailyApi不属于release-all默认三函数，本次未部署。

## 2026-10-06 明细快照回填（是否生美 / 经营类型）

- 目标：用当前 SKU / 品项分类配置刷新 `sale_items`、`service_items` 的 `is_shengmei`（是否生美）与 `sales_category`（经营类型）四列快照。
- 脚本：`db/scripts/backfill-item-snapshots-shengmei-category.js`（新增；幂等、默认 dry-run、写入需 `--confirm-target` 逐字确认、导出 CAS 回滚文件、经 `_lib/assert-db-target` 白名单）。执行人 Claude，2026-10-06。
- 前置只读核对（`fengyu_ro`，118.178.196.26:5433）：`sale_items` 137,733 行、`service_items` 27,531 行，四列差异均为 **0**；派生表 `sale_item_performance_events` / `sale_payment_item_receipts` / `sale_payment_allocatable_items` / `sale_reportable_item_events` 亦为 0；`sale_items.product_kind_at_sale` 亦为 0。
- 执行：`ADMIN_DATABASE_URL` 显式目标断言后 `--execute --confirm-target=118.178.196.26:5433/fengyu_wxapp`，命中 **0 行，未写入、未生成回滚文件**（脚本按设计在 0 行时不写库）。
- 归因：prod 已于 **2026-10-05 17:23** 有一次批量对齐（`sale_items` 8,366 行 + `service_items` 1,039 行，跨 20 个 SKU），与当日 17:19–17:23 的 4 个 SKU 生美标记修正同批；其后无新的 SKU/分类改动，10-05 之后新开的 296 行 `sale_items` 写入时即取当前值。
- ⚠ 口径备注：`sale_items.is_shengmei` 在 #378 定为「**不回填**的开单快照（生美业绩口径）」；10-05 的批量对齐已把它改到与 SKU 当前值一致，与 #378 原口径相反。若需保留开单快照口径，须另行评估回退。
- 本地验证（未连业务库）：临时 docker PG 全量 `db:migrate` + 夹具端到端 22 项断言通过（命中数、写入、幂等归零、NULL 源不覆盖、无 SKU 行回退、回滚恢复、漂移 CAS 默认拒绝 + `--allow-drift` 跳过）。`npm run db:test` 132 通过 / 0 失败。

## 2026-10-06 顾客分类 / 会员标签全量重算（#257 + #524 口径）

- 目标：按 #524（部分支付单、转换单的实际新增非体验实收参与入会判定）+ #257（双向同步，放弃只升不降）的新口径，对 prod 全量顾客做 `customer_type` → `member_level` 的离线重算，并补齐同一链条上的首次入会归因与升级单标记。
- 执行人 Claude，2026-10-06；用户在本会话明确选择「三步全跑留台账」。目标库 118.178.196.26:5433/fengyu_wxapp。未操作 dev，未改 schema，无迁移。
- 执行前状态：10-06 02:23 v1.17.23 换镜像后，03:02 每日 cron 已用新代码跑过一遍（`customerTypes` 更新 143 行；`memberLevels` 37 升级 / 0 降级 / 156 保级期内 / 1873 不变）。独立只读审计（`audit-customer-type-transitions.js` 真实 SQL，脚本自带 60s 超时在 prod 触发 57014，放宽到 900s 重跑）范围 5819 人、待变更 **0**，即分类侧当日已由 cron 对齐。
- 备份：`~/backups/fengyu/fengyu_prod_pre_tagrecalc_20261006-132434.dump`（custom format，18.8 MB，mode 600；`lx-prod` 上用 PG16 `pg_dump` 生成后取回，远端临时文件已删）。
- 执行顺序与结果（每步单独事务，前一步核验通过后才推进）：
  1. `db/scripts/recalc-all-customer-types.js --apply` — `customer_type` 0 行 / `member_level` 0 行 / `became_member_at` 0 行；自检「会员客缺入会时间 0、非会员带等级 0」通过，COMMIT。
  2. `db/scripts/recalc-became-member-at.js --apply` — 命中 2067 会员客，**更新 26 行**（dry-run 预示 25，期间有 1 行实时写入）；SELFCHECK 通过，COMMIT。
  3. `db/scripts/backfill-membership-upgrade-doc-type.js --apply` — 命中 2067 单，**更新 722 单**（`document_type`→售前一次 352 单 + 补 `is_membership_upgrade` 443 单，有重叠）；「会员客但无达标单」异常由 4 归 0，COMMIT。
- 收敛复核（`fengyu_ro` 只读 dry-run，三步全部再跑）：分类 0 / 0 / 0；入会时间「将变更 0 行」；升级单标记「需改 document_type 0 单、需补 flag 0 单」。两次独立快照结论一致。
- 遗留（未处理，均为设计内或待拍板）：
  - 6 位**非会员客仍带 `became_member_at`**：按 #257「降级不清历史归因」保留，脚本只告警不清理。再达标归因留 #257 E。
  - 401 位会员客 `member_level` 为 NULL：逐人核对近 12 月净消费**全部 < 1990**，属滚动 12 月口径的正常结果。本会话已与用户确认「保持现状」，不按终身消费或下单时金额改判。
  - `member_level` 有 156 人处在 150 天保级期内（现值高于滚动 12 月口径应得档位），为既有保级规则，非漏算。
- 证据：`~/backups/fengyu/tagrecalc-20261006/{step1-recalc-all-customer-types,step2-recalc-became-member-at,step3-backfill-membership-upgrade-doc-type,step4-verify-dryruns}.log`（含含手机号的私有名单一律未入 git）。
- 备注：本台账条目不自动授权后续回填；`became_member_at` 前移会重排会员报表的历史分布（2026-09-22 那轮已发生过同类效应，属预期）。


## #548 转换退款：部署待执行（2026-10-09 集中集成）

- 正式迁移 `0063_conversion_refund_local_responsibility`；when `1791543196400`；SQL SHA-256 `ad71fa10fcd0ed022cb57f01322a5ebe18eb54afd9082a522d5f71af95d71d49`。与业务代码同 PR #552 合入，旧63条 SQL/journal 身份不变。
- prod 状态：**未执行、未部署**。本记录表示已准备交付，不表示目标库已迁；部署前只读核验实际 journal 的 pending 与既有 when/hash。
- 私有验证：空库64条重放；存量63→64真实 db:migrate；历史普通单/转换明细/部分已用积分批次/原 earned_at、expire_at、流水和余额精确保留；新增列默认 NULL、交接表为空；唯一/非负/不同订单/FK约束通过；二次 db:generate 无变更。
- 顺序：目标断言及 journal 核验 → 本次及实际 pending 正式 db:migrate → 结构与 journal 回读 → `DATABASE_URL="$TARGET_DATABASE_URL" node db/scripts/audit-conversion-value-sources.js` 只读审计 → 四端同版发布 → 小程序与人工实效验收。不得先发依赖新列/表的代码。
- 额外自动写脚本：**无**。历史缺口不按现价/余额猜算；确定映射的补建须单独形成可审查交付，未经确认的项目维持退款保护。候选 `requests/issue-548.sql` 不再单独执行。
- 不回写原销售业绩/旧佣金；退款只冲本单新增，积分在转换时交接。发生新退款后不可回滚到旧欠款/积分归属代码。
- 部署时在本环境另追加执行时间、发布SHA、实际迁移身份、审计/结构和人工验收结果，不推定另一环境同步完成。


## #553 体验业绩资格：正式迁移已准备，部署待执行（2026-10-10 集中集成）

- 正式迁移 `0064_experience_performance_only_trial`；when `1791619262174`；SQL SHA-256 `dfdb12450b1450150827e1adfd10373656ce2b0c09df2540fe8166656e234ba1`。与业务代码同 PR #554 合入，旧64条正式历史身份与内容不变。
- prod 状态：**未执行、未部署**。本记录为代码交付准备，不表示目标库已迁；未部署不是 PR 合并闸门。
- 私有验证：空库65条重放；存量64→65真实Drizzle迁移/二次幂等、旧when/hash及七张基础表整行指纹不变；升级后业绩4,073,751.98，除体验现付差31,124.20均为旧余额。schema/正式SQL/snapshot等价守护及真库正反例通过；二次生成无变化。
- 迁移只替换两个可计业绩视图：已售 `is_experience` 资格，不按品类排除；保持原款项净额/封顶/尾差/card/residual规则，无数据回填，无额外写脚本。`SET LOCAL lock_timeout='3s'`，锁冲突直接回滚；只使用真实Drizzle事务入口，不把候选SQL另行执行到业务库。
- 发布顺序：合并代码和迁移 → 目标断言及journal只读核验实际pending → 授权发布内执行db:migrate → 结构及journal/金额只读回验 → 发布依赖admin/export worker版本 → staff/daily同源指标与导出实效核验。实际pending可能还含此前已合并迁移，必须按journal完整顺序执行。
- 不自动merge/关单/迁业务库；部署时另追加本环境执行时间、SHA、迁移身份与独立结果，不推定另一环境同步成功。
