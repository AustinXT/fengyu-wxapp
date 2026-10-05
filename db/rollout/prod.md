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
