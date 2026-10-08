# dev 数据库发布台账

目标：`101.34.242.103:5433/fengyu_wxapp`。同一套 Drizzle 迁移，独立执行记录；详见 [集成规则](README.md)。

历史迁移执行状态：**2026-10-02 用户专项授权后已修复 0034 多余旧记录**。0058/0059/0060 已执行成功；详见末尾核验及修复记录。

| 请求 | 正式迁移 tag / hash | 前置检查 → 执行 → 后置校验 | 依赖代码 | 状态 | 执行证据 |
|---|---|---|---|---|---|
| [#353](requests/issue-353.md) | `0058_store_surplus_standard_price` / `f7fb41a1127d3e9b61507e6f0199913ea39b309559ccf8858db454c165047690` | 目标断言 + journal/hash 只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下 db:migrate 全部已核准 pending → 列/CHECK/触发函数/hash 校验；额外脚本：无 | #353 标准价与盘溢业务须先迁库后上线；#365 正式生成须等本项合入 dev | 已随 #510 合入 dev；本环境执行成功（见末尾） | dev正式执行成功；证据见末尾发布记录 |
| [#364](requests/issue-364.md) | 与 #356 共用 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 角色定义只读核对 → 目标断言后的 db:migrate → 角色授权/镜像一致性校验 | admin 新结算页闸，须先迁权限 | 已随 #511 合并；本环境执行成功（见末尾） | dev正式执行成功；证据见末尾发布记录 |
| [#365](requests/issue-365.md) | `0059_market_supplier_owner` / `332af31a4e32e18752fb85af354ddaec813ad7e07e28f9883a9df51ef76b8c82` | 显式目标断言 + journal/hash、存量总数/启用停用数与名称唯一只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下 db:migrate 全部已核准 pending → `node db/scripts/verify-inventory-v3-schema.js`、存量 NULL 与数量/hash 只读核对；额外脚本：无 | #507 admin 与同构建 export-worker 必须先迁库后发布；#364 权限请求仍待集成 | 已随 #507 合入 dev；本环境执行成功（见末尾） | 仅私有库验证，未连接本环境 |
| [#356](requests/issue-356.md) | 与 #364 共用 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 目标断言 + 全部journal/hash只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下db:migrate → lifecycle/有效trigger、权限定义与镜像、hash校验；额外脚本：无 | #356作废与#364结算页须先迁库后发布admin | 已随 #511 合并；本环境执行成功（见末尾） | 60→61真实Drizzle升级、空库61条、11条PG正负例/权限幂等、镜像锁超时回滚后重试通过；dev正式执行成功；证据见末尾发布记录 |

集成完成后填写实际文件路径、内容 hash、前后置校验命令和准确顺序。登记一次性脚本还必须列明幂等性、目标断言、事务和失败续跑方法；没有额外脚本写“无”。

执行后记录：状态（待执行/执行中/成功/失败）、时间、发布 SHA、执行人、迁移 tag/hash、脱敏日志或验证证据。失败不继续依赖代码发布；不得用另一环境的成功记录补本表。

## 2026-10-02 dev 只读发布前核验（Codex）

- 目标已断言 `101.34.242.103:5433/fengyu_wxapp`；使用 `BEGIN READ ONLY` 查询 journal，未执行任何业务库写操作。
- 核验发布候选基线 `2f43739e3` + 本交付0060：本地journal共61条；目标journal共59行=58条when/hash精确匹配+1条多余旧记录。正确计数是本地61=已应用58+pending3；库的第59行不属于本地不可变历史。
- 历史差异：`0034_lakala-onboarding-schema-repair` 的SQL SHA-256 `d4549ec0237b8f4441af860a02c0905e59e382e3c07503063f6310ec95b896bd` 在库有两行：id34/created_at=`1787637056739`（多余旧记录）与id36/created_at=`1787715148177`（已匹配本地when）。git `c65260594`（2026-08-26）改了该when，SQL内容未变；本地时间戳已被正确记录，不能再把id34更新为同一when造成两个canonical记录，亦不得由常规发版自行删改journal。
- pending：0058/0059/0060，确切hash见表；无额外脚本。历史差异未按专项流程处理前，常规db:migrate/admin/analyst/云函数发布全部停止。
- 脱敏证据：起点仓库 `_tmp/db-integration/356-364/dev-journal-readonly.json` 与 `dev-journal-0034-readonly.json`，核验时间 `2026-10-02T02:03:47.300Z`。本记录不更改prod状态，也不授权journal修复。

## 2026-10-02 dev journal 专项修复（Codex）

- 用户明确授权“修复”；目标 `101.34.242.103:5433/fengyu_wxapp`，发布 `v1.17.8` / `e70c6d09594aeef01bfc6c845d85ca1c5d1b76e4`。
- `2026-10-02T02:44:30.878Z` 在事务和 journal 表锁内精确删除 id34/hash=`d4549ec0237b8f4441af860a02c0905e59e382e3c07503063f6310ec95b896bd`/created_at=`1787637056739`，前提为正确 id36/created_at=`1787715148177` 同 hash 存在。仅删除1行；正确记录及其它行逐项核验未变。
- 先执行真实事务回滚演练，确认59行完整恢复；正式修复后58行全部匹配本地when/hash。重复删除0行，幂等通过。没有业务数据/schema或本地迁移历史变更。0058/0059/0060仍pending。
- 脱敏证据及修复前完整journal备份：`_tmp/release-dev-v1.17.8/journal-before-apply.json`、`repair-dry-run.json`、`repair-apply.json`；精确修复脚本 `repair-journal.cjs`。失败会事务回滚；重跑先核验目标和全部历史，旧行已不存在则0行成功。仅dev，prod未操作。

## 2026-10-02 v1.17.8 发版续跑预检

- 两站TypeScript零错误；staff跨端388/admin跨端27/analyst476测试全部通过。env目标、origin、无占位符、`.active=prod`通过；lx-test公网IP=101.34.242.103且5433监听通过。
- 前置只读检查：58条journal全部when/hash匹配；pending为0058/0059/0060。供应商13条，均启用，名称重复组0；owner_market_id/standard_price列尚不存在，旧全局唯一索引存在。证据 `_tmp/release-dev-v1.17.8/pre.json`。
- Docker引擎 `docker info` 超时未响应，环境就绪门禁未通过，停止发版；尚未执行db:migrate、admin/analyst或云函数部署。journal专项修复已提交，无需重复修复。

## 2026-10-02 v1.17.8 正式迁移成功（Codex）

- 实际发布工作树 `.tree/release-dev-v1.17.8`，tag `v1.17.8`，SHA `e70c6d09594aeef01bfc6c845d85ca1c5d1b76e4`；Docker重启恢复后环境门禁通过。主仓后续仅版本/台账提交，业务树相同。
- 显式断言目标 `101.34.242.103:5433/fengyu_wxapp`，`PGOPTIONS=-c lock_timeout=3s` 下真实 `npm --prefix db run db:migrate` 退出0；按0058→0059→0060同事务应用，无额外脚本。
- 后置只读核验：61条journal全部精确when/hash匹配，无pending或额外记录；标准价/供应商归属列可空无默认；新索引和CHECK/触发器通过；旧全局供应商名称索引已删除；lifecycle有效trigger/函数更新；角色仅按既定规则新增结算动作、范围未变、镜像逐角色一致。
- 供应商迁移前后13条/启用13/停用0；归属非NULL=0，标准价非NULL=0，无未经授权回填。角色动作按集合比较，SQL排序使用PG collation，不假定JS码点序一致。
- 执行/校验时间见 `_tmp/release-dev-v1.17.8/post.json`；日志 `migrate.log`、`schema-verify.log`，含前置/后置完整脱敏证据 `pre.json`/`post.json`。本记录仅dev成功；prod未操作。

- admin发布成功：`dev-e70c6d09594a-dirty.7f3ae329bdd4-53eb6861f4d8-20261002T025007Z-38332`；镜像 `fengyu-admin:dev-e70c6d09594a-dirty.7f3ae329bdd4-23af48d8e55c`，发布脚本exit0/RELEASE_OK，镜像ID与运行配置/健康门禁通过。日志 `_tmp/release-dev-v1.17.8/admin-deploy.log`。

- analyst发布成功：`dev-e70c6d09594a-dirty.7f3ae329bdd4-53eb6861f4d8-20261002T025632Z-52141`；镜像 `fengyu-analyst:dev-e70c6d09594a-dirty.7f3ae329bdd4-23af48d8e55c`，exit0/RELEASE_OK。线上两容器running、相同revision、DB=`172.18.0.1:5433/fengyu_wxapp`、origin=`https://analyst.meiyayabeauty.com/`、HTTP3000/3001均307，5433监听通过。证据 `analyst-deploy.log`、`remote-verify.log`。

## 2026-10-02 v1.17.8 dev 全量发布完成

- 完成时间 `2026-10-02T03:01:36.165Z`（北京时间11:01），执行人Codex。tag `v1.17.8` 未移动，发布SHA `e70c6d09594aeef01bfc6c845d85ca1c5d1b76e4`，两端版本生成改动指纹 `dirty.7f3ae329bdd4`。两站镜像/manifest均携带此实际脏版本标识。
- admin/analyst两个release及运行终检结果见上文。迁移0058/0059/0060及精确hash见表，全部已执行且校验通过；无额外回填。
- 串行显式 `scripts/deploy-cloudfunctions.sh dev` 完成 `staffApiDev`、`clientApiDev`、`payNotifyDev`，3行deployed和环境回读通过。仅影子函数，正式函数未部署；`.active=prod`。
- 线上终检：3个函数PG=`101.34.242.103:5433/fengyu_wxapp`、DEPLOY_CHANNEL=shadow；staff true/develop、CLIENT_SECRET/CLIENT_APPSECRET已验证，client TMAP密钥非空且与配置匹配，HMAC两端一致，client/payNotify的PAYNOTIFY_FN_NAME=payNotifyDev。envId均为现有prod前缀。
- 空staff冒烟code=-1（缺少action）；staff/client auth.login、client store.list无身份请求均code=-401，鉴权烟测通过，不代表已登录业务实效验证。
- 证据 `_tmp/release-dev-v1.17.8/`：`cloud-deploy.log`、`cloud-verify.json`/`.log`、各smoke JSON、两站部署日志和remote终检，以及专项修复与迁移前后证据。运行依赖在发布工作树按锁文件npm ci安装；初次依赖预检中止时未上传函数。
- 主仓版本文件已由另一个提交保存；本次不commit/push。主仓未提交文件为本台账；发布工作树仍有两端version.ts生成改动，保留用于复现指纹。小程序需手工上传client/staff开发版，新APP_VERSION仅上传后生效。prod没有迁移、修复或部署。

## 2026-10-02 v1.17.12 dev 发版迁移核验（Codex）

- 执行时间 2026-10-02T03:58:04.176Z；发布 SHA `0245129a063506fe939d2f562d397de8e0f19c2f`，沿用用户确认的 tag `v1.17.12`。
- 显式断言目标 `101.34.242.103:5433/fengyu_wxapp`；执行前后全部 journal 的 when/SQL SHA-256 历史匹配，无 pending、额外历史或必要专项脚本。最新迁移 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b`。
- `PGOPTIONS=-c lock_timeout=3s` 下真实 `npm --prefix db run db:migrate` 退出0；无新增迁移。脱敏证据 `_tmp/release-dev-v1.17.12/migration-gate.json`、`migrate.log`。仅登记 dev，prod 未操作。

### 本次 dev 全量发布完成

- 完成时间 2026-10-02T04:08:30.319Z；执行人 Codex。两站实际发布 revision `0245129a0635-dirty.c9cb3fca4682`，包含两端 version.ts 与本台账在构建时的未提交改动；未 commit/push。
- admin release：`dev-0245129a0635-dirty.c9cb3fca4682-53eb6861f4d8-20261002T035808Z-24524`；部署脚本退出0/RELEASE_OK。
- analyst release：`dev-0245129a0635-dirty.c9cb3fca4682-53eb6861f4d8-20261002T040419Z-36893`；部署脚本退出0/RELEASE_OK。
- 线上两容器 running、HTTP 均307、DB 均 `172.18.0.1:5433/fengyu_wxapp`，宿主公网101.34.242.103/5433监听通过；Analyst origin `https://analyst.meiyayabeauty.com/` 与配置一致。
- 显式 dev 通道串行更新 staffApiDev/clientApiDev/payNotifyDev，3行 deployed、脚本退出0。config pull 与 fn detail 只读回读通过：三个影子函数 PG 均101.34.242.103:5433/fengyu_wxapp、DEPLOY_CHANNEL=shadow，staff true/develop、CLIENT_SECRET/CLIENT_APPSECRET非空且目标密钥一致，client TMAP密钥校验、两端HMAC一致、PAYNOTIFY_FN_NAME=payNotifyDev。envId均prod前缀。
- 空staff冒烟-1，staff/client auth.login及client store.list无身份请求-401，鉴权冒烟通过；不代表已登录业务流程验证。
- 脱敏证据 `_tmp/release-dev-v1.17.12/`：两站与云函数部署日志、remote-verify.json、cloud-verify.json及smoke JSON。版本已核对v1.17.12，.active=prod；prod未迁移或部署。小程序两端须手工上传开发版才能生效。


## 2026-10-02 daily 分支合并

- `0061_daily_report_loop`：SHA-256 `8643243a716f7b6e249af83bd7360b4ee0c8fdc306f0a5d08f8df0602f43ac05`。日报迁移在本轮 Git 合并前已执行于开发库；本轮未连接数据库执行迁移。
- 原日报分支 `0057_daily_report_loop` 与 dev 既有编号冲突，顺延至 `0061`；SQL 字节和原 `when=1790921441006` 不变，已执行记录可继续按 when/hash 匹配。`0057` 至 `0060` 的 dev 迁移完整保留。
- 合并快照包含最新 dev schema 和三张日报表；`db:generate` 返回无 schema 变化。

## 2026-10-03 日报 V2 集中集成

- 正式迁移 `0062_daily_v2_operating_pk`，when=`1791020803394`，SQL SHA-256 `dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca`。基于最新 origin/dev，在隔离分支 codex/daily-v2-migration 集成日报 V2。
- 内容仅四张新表及 daily_reports 四个 nullable 字段与约束/索引；无删除/回填，旧日报正文和明细不变。复合唯一索引先于引用它的外键创建。
- 私有空库重放63条通过；存量已提交日报升级完整保留；日报47项、后台26项测试通过；DB测试99项通过、13项环境型跳过；两端类型检查通过；生成器二次核验无额外结构变化。
- 用户本聊天已授权 dev 建表、后端及后台更新和联调；沿用跳过双谱系决定。部署顺序：核验 dev 历史→db:migrate→结构与历史回读→dailyApiDev→admin dev→真实小程序联调。无额外数据脚本。
- dev：执行前只读核验既有正式历史全部匹配，唯一 pending 为0062；本条记录时尚未执行。

### 2026-10-03 日报 V2 dev 实际执行结果

- 北京时间17:51:51，`0062_daily_v2_operating_pk` 经显式目标校验后的 `npm --prefix db run db:migrate` 执行成功。目标101.34.242.103:5433/fengyu_wxapp；SQL hash `dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca`、when `1791020803394`，库记录id64。四张新增表、四个新增字段及迁移记录回读通过；日报行数执行前后均0。
- 发布提交 `f998dc19cbc2`，admin release `dev-f998dc19cbc2-b4377b31991a-20261003T095253Z-24341`，镜像 `fengyu-admin:dev-f998dc19cbc2-64bb1bcb771b`，部署脚本RELEASE_OK。
- 使用统一入口 `DAILY_DEPLOY_BACKEND=wechat WX_DEVTOOLS_PORT=41652 scripts/deploy-cloudfunctions.sh dev daily` 上传dailyApiDev到cloud1-d5gz7zr8x6c38bd49。26个JS文件完整下载回读一致。微信CLI最终返回待核验提示（退出1），随后通过云控制台只读核验：Node.js18.15、256MB、30秒、PG公网dev目标且无连接覆盖参数、DEPLOY_CHANNEL=shadow、TZ=Asia/Shanghai。
- 小程序已重新编译；当前微信真实身份auth.login及11个读取接口均code0：period.list/target.read/pk.classes/report.history/metrics.read/contacts.list/report.read/business.list/report.previous/manager.list/management.read。未模拟接口。首页和目标页实际显示尚未配置经营周期。
- 验收限制：当前绑定管理员无主门店，不能替代普通员工填报验收；真实经营月/四周日期与PK分班未收到用户决定，保持空配置；共享库未写入虚构日报。后续需有门店的员工身份完成保存/提交/店长回读，以及业务配置后的目标和PK验证。三角色截图自动化在首个首页后超时，不将其计为全角色UI验收。
- 交付PR https://github.com/AustinXT/fengyu-wxapp/pull/523 ，仍待合并。已同步本机daily分支；在PR合入dev前，其他会话不得从旧dev再次生成0062。外部双谱系按用户明确指示跳过。
- 脱敏执行证据在起点仓库 `_tmp/daily-v2-release/`。prod未迁移、未部署。

### 2026-10-03 日报配置 HTTP 页面异常修复

- 实际浏览器 `/settings/daily` 控制台确认 `TypeError: crypto.randomUUID is not a function`，HTTP IP 地址不支持该安全上下文 API。
- 提交 `f199f9bbd702` 将经营月与 PK 班级 ID 改为 `crypto.getRandomValues` 生成，并改用惰性表单初始化。回归测试 2 项通过，admin `npx tsc --noEmit` 通过。
- dev admin release `dev-f199f9bbd702-b4377b31991a-20261003T103707Z-28830`，脚本 exit 0 / RELEASE_OK；未执行数据库迁移。
- 使用真实已登录浏览器刷新后，版本显示 `f199f9bbd702`，经营月和四周日期表单正常显示，新增经营月、PK 页签切换正常。未写入业务日期或分班配置；已有经营月的添加班级行为通过 HTTP 环境组件回归验证。


## 2026-10-06 v1.17.20 dev 发版迁移核验（Codex）

- 核验时间 `2026-10-05T16:00:37.261Z`；用户确认沿用 tag `v1.17.20`，发布 SHA `3c77448df3361eaa1b289893a1fc76366603fcfa`，包含未提交的单 CloudBase 环境配置与后台影子调用修复。
- 显式目标 `101.34.242.103:5433/fengyu_wxapp`；执行前后全部63条 journal 按 when/SQL SHA-256 一一精确匹配，无缺失、额外记录、pending 或额外专项脚本。历史 when 非编号顺序，核验按身份集合比较。
- `PGOPTIONS=-c lock_timeout=3s` 下真实 `npm --prefix db run db:migrate` 退出0，无新增迁移。最新 `0062_daily_v2_operating_pk` / `dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca` / when `1791020803394`。
- 脱敏证据 `_tmp/release-dev-v1.17.20/migration-before.json`、`migration-after.json`、`migrate.log`。仅登记dev，prod未操作。


### v1.17.20 dev 全量发布完成

- 完成时间 `2026-10-05T16:19:27.013Z`，执行人 Codex。发布SHA `3c77448df3361eaa1b289893a1fc76366603fcfa`，实际镜像 revision `3c77448df336-dirty.c323a5759ff1`；包含单 CloudBase 环境配置/校验修复、admin按ENV_PROFILE路由影子函数、构建排除本地_tmp和本台账。未commit/push。
- admin 首次构建被本地 `_tmp/acceptance-ui-copy` 的绝对路径导入阻断，未上传或切换；补充 `.dockerignore` 的 `**/_tmp` 后重试成功。admin release `dev-3c77448df336-dirty.c323a5759ff1-4499de4ec1db-20261005T160717Z-19960`；analyst release `dev-3c77448df336-dirty.c323a5759ff1-4499de4ec1db-20261005T161311Z-25801`，两脚本exit0/RELEASE_OK。
- 两站运行中，HTTP3000/3001均307，DB均172.18.0.1:5433/fengyu_wxapp；脚本核验宿主公网101.34.242.103与5433监听通过；Analyst origin=https://analyst.meiyayabeauty.com/。admin线上ENV_PROFILE=dev，client/staff CloudBase标识为当前prod前缀，dev后台调用映射到*Dev。
- 类型门禁均0错误；staff跨端399/admin跨端27/analyst476项通过；修复回归：部署配置16、admin云函数调用13项通过。db:migrate退出0，全部63条when/hash前后精确一致，无pending与专项脚本。最新0062与hash见上文。
- 显式dev通道串行部署staffApiDev/clientApiDev/payNotifyDev，3行deployed、脚本exit0、变量回读通过。独立config pull/fn detail回读全部6个函数：primary PG118.178.196.26，shadow PG101.34.242.103，均5433/fengyu_wxapp；DEPLOY_CHANNEL与PAYNOTIFY_FN_NAME按归属匹配，staff开关false/release与true/develop正确，CLIENT_SECRET/CLIENT_APPSECRET/TMAP变量非空且配置匹配，分通道HMAC两端一致。正式函数只读核验，未部署。
- 影子冒烟：staff空payload code=-1，staff/client auth.login、client store.list无身份请求code=-401，通过；不代表已登录业务流程验收。APP_VERSION两端v1.17.20，.active=prod。
- 脱敏证据 `_tmp/release-dev-v1.17.20/`：迁移前后/日志、admin-deploy-retry.log、analyst-deploy.log、cloud-deploy.log、remote-verify.json、cloud-verify.json与smoke JSON。本台账收尾追加发生在两站构建后，镜像指纹对应构建时工作树。
- Git未提交文件：runtime-config.mjs/runtime-config.test.mjs、.dockerignore、db/rollout/dev.md、admin cloudbase.ts/cloudbase.test.ts。本地忽略配置envs/dev.env的envId/CDN亦已修正。client/staff小程序如需更新须手工上传开发版；日报独立dailyApiDev不在release-all默认3函数范围内。本次prod无迁移或部署。

## 2026-10-06 明细快照回填（是否生美 / 经营类型）

- 目标：用当前 SKU / 品项分类配置刷新 `sale_items`、`service_items` 的 `is_shengmei` 与 `sales_category` 四列快照。脚本 `db/scripts/backfill-item-snapshots-shengmei-category.js`（commit `25a84190f`）。执行人 Claude。
- 目标 `101.34.242.103:5433/fengyu_wxapp`；`envs/dev.env` 的 `PG_CONNECTION_STRING` 显式传 `DATABASE_URL` + 白名单断言 + `--confirm-target` 逐字确认。
- 执行前 dry-run：`sale_items` **8344 行**（`service_items` 0 行）。构成：古法瑶浴(寄存专用) 4127、头皮舒养(寄存专用) 3534、年轻态 ZX 系列 631、健康爱你礼包养护 18、其余含 `NULL→true/false` 与少量经营类型变化 ~34。
- 这些差异即 #378 描述的「SKU 事后改标」历史行；dev 此前保持 #378 原口径（`sale_items` 不回填），本次按用户要求对齐到当前 SKU 配置，**等于把「sale_items 不回填」的口径反转落到 dev**（prod 已于 2026-10-05 做过同样对齐）。
- 执行：`--execute` 写入 **sale_items 8344 行 + service_items 0 行**，单事务提交，写入后复核归零。回滚文件（CAS，含四列原值）落项目外 `~/backups/fengyu/backfill-snapshot-dev-20261006T132545.json`。
- ⚠ 口径备注同 prod：`sale_items.is_shengmei` 原为 #378 的开单快照口径，本次对齐后与 SKU 当前值一致；若需退回开单快照口径，用上述回滚文件恢复。


## 2026-10-08 v1.17.25 dev 发版迁移核验（Codex）

- 核验时间 2026-10-08T06:30:22.400Z；用户确认沿用 tag v1.17.25 发布当前 HEAD，SHA 481acd58db5ca2a5496592a33ebc268140aab2fc。
- 显式目标 101.34.242.103:5433/fengyu_wxapp；执行前后全部63条 journal 按 when/SQL SHA-256 逐条精确匹配，无 pending、额外历史或必要专项脚本。最新 0062_daily_v2_operating_pk，when 1791020803394，hash dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca。
- PGOPTIONS=-c lock_timeout=3s 下真实 npm --prefix db run db:migrate 退出0，无新增迁移；执行人 Codex。脱敏证据 _tmp/release-dev-v1.17.25/migration-before.json、migration-after.json、migrate.log。仅记录 dev；prod 未操作。

### v1.17.25 dev 全量发布完成

- 完成时间 2026-10-08T06:37:30.009Z，执行人 Codex。发布 SHA 481acd58db5ca2a5496592a33ebc268140aab2fc，沿用用户确认的 tag v1.17.25；两站实际 revision 481acd58db5c-dirty.05e7bac4dc4e。包含两端 version.ts 与构建时本台账改动；未commit/push。
- admin release `dev-481acd58db5c-dirty.05e7bac4dc4e-4499de4ec1db-20261008T063026Z-5819`；脚本exit0/RELEASE_OK。
- analyst release `dev-481acd58db5c-dirty.05e7bac4dc4e-4499de4ec1db-20261008T063431Z-74615`；脚本exit0/RELEASE_OK。
- 两站running，HTTP3000/3001均307，DB均172.18.0.1:5433/fengyu_wxapp；宿主公网101.34.242.103/5433监听核验通过。Analyst origin=https://analyst.meiyayabeauty.com/，admin ENV_PROFILE=dev，CloudBase标识为当前prod前缀。
- 显式dev通道串行部署staffApiDev/clientApiDev/payNotifyDev，3行deployed，脚本exit0和环境变量回读通过。独立config pull/fn detail只读回读6函数：primary PG118.178.196.26，shadow PG101.34.242.103，均5433/fengyu_wxapp；DEPLOY_CHANNEL、PAYNOTIFY_FN_NAME按归属匹配；staff开关与CLIENT_SECRET/CLIENT_APPSECRET、client TMAP变量、分通道两端HMAC校验通过。正式函数仅只读核验，未部署。
- 影子staff空payload=-1，staff/client auth.login与client store.list无身份请求=-401，鉴权冒烟通过；不代表已登录业务流程验收。类型检查0错误，staff407/admin27/analyst476项测试通过，DB脚本132通过/16环境型跳过。db:migrate退出0，63条when/hash前后一致，无pending。
- 脱敏证据 _tmp/release-dev-v1.17.25/：迁移前后、migrate.log、两站部署日志、remote-verify.log、cloud-deploy.log、cloud-verify.json及smoke JSON。APP_VERSION两端v1.17.25，.active=prod。
- 本台账收尾发生在构建之后，镜像指纹对应构建时工作树。未提交文件为db/rollout/dev.md、两端miniprogram/utils/version.ts。小程序须手工上传client/staff开发版才生效；dailyApiDev不在默认3函数范围。本次prod未迁移或部署。
