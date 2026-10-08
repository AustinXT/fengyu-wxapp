# 日报独立调试环境

## 固定连接

- 本地后台：`http://localhost:3010`，在仓库根目录运行 `npm --prefix fengyu-admin run dev:daily`。
- 日报专用数据库：`101.34.242.103:8151/fengyu_daily_dev`，PostgreSQL 16。
- 容器：`fengyu-daily-postgres`；独立卷：`fengyu-daily-pgdata`；重启策略 `unless-stopped`。
- 日报小程序开发版仍调用 `dailyApiDev`，CloudBase 环境仍为 `cloud1-d5gz7zr8x6c38bd49`。
- 原 dev 的 `3000` 后台、`5433/fengyu_wxapp`、其他云函数未切换。

## 配置与日常操作

私密连接放在已忽略的 `envs/daily.env`，权限 0600；不修改 dev/prod 配置。应用使用非超级用户 `daily_app`，建表使用独立实例管理用户 `daily_owner`。本地启动先检查目标库和五项目标列，再启动 Next；不会运行 cron/export worker。后台另有 DAILY_ISOLATED 数据库守卫及页面提示。不要直接运行普通 `npm run dev` 来代替日报入口。

本地登录还需要 `NEXT_PUBLIC_RSA_PUBLIC_KEY` 与 `RSA_PRIVATE_KEY`（base64 PEM）。已在 daily.env 生成日报专用密钥对，启动脚本校验是否配对；这些密钥只用于密码传输，不改变账号密码。修改公钥后须重启本地后台并刷新浏览器。首次初始化遗漏了这两项，导致客户端加密抛错，页面误显示“网络异常”；已补齐。

更新云函数只走 `scripts/deploy-cloudfunctions.sh dev daily`；CLI 身份不可用时可用 `DAILY_DEPLOY_BACKEND=wechat` 前缀。微信 CLI 只能更新代码，脚本仍会退出并要求运行配置核验，不能把上传成功当作部署成功。控制台应保持 PG_CONNECTION_STRING 指向 8151 日报库、DEPLOY_CHANNEL=shadow、TZ=Asia/Shanghai、Nodejs18.15、256MB、30秒，并验证真实 auth.login/target.read。

备份：`scripts/backup-daily-db.sh`；备份保存在服务器 `/www/wwwroot/fengyu-daily-db/backups/`。首次 dev 快照为同目录上一级的 `dev-initial.dump`；配置、备份目录权限收紧。目标存在时禁止自动重新初始化；不会自动同步源库，也不把日报库整体恢复回 dev。

新实例限制 768MB 内存、1 CPU、40连接；初始复制保留所有业务数据和绑定关系，不启动业务定时任务。旧测试绑定码已过期；已有微信绑定继续可用。

## 五项目标候选结构

已仅在日报库执行 `db/rollout/requests/daily-five-metrics.sql`。执行前检查四列均不存在，事务执行后核对正式迁移历史逐项保持一致；候选 hash 保存在服务器 `five-metrics-candidate.sha256`。不得为候选 SQL 手工添加 Drizzle journal。

正式迁移仍待集中集成，前置 PR #523 未自动合并；独立库采用候选结构并不表示共用 dev 已升级。将来正式迁移衔接需要先核对独立库候选状态，避免重复添加列。

## 经营周期模板候选结构

2026-10-05：备份日报库到 `/www/wwwroot/fengyu-daily-db/backups/daily-20261005T134826Z.dump` 后，以 `daily_owner` 在 `fengyu_daily_dev` 事务执行 `db/rollout/requests/daily-cycle-templates.sql`。SHA-256 `f54f3e70cd3014a65bb1834016566dd21a685c39e18272086bde6ab3f63d6225`。回读确认三张新表、`daily_operating_periods` 四个新增字段及应用账号周期查询可用；未修改 Drizzle journal。正式迁移仍待集中集成，生成/执行前必须核对该候选结构并避免重复 DDL。

## 2026-10-04 核验

- 初始源库约299MB，压缩备份18,782,357字节；恢复后440条库存单据、1条经营周期、1条目标。
- 本机以 daily_app 连接成功；真实 CloudBase 请求在独立实例留下 daily_app 连接记录。
- 云端30个JS文件与本地字节一致。真实微信 auth.login、period.list、target.read、pk.classes、report.history、metrics.read 均返回code0，未模拟接口。
- 本地配置、目标填报、进度、PK四个页面使用短期测试会话均HTTP200，显示独立库标识；此项不冒充密码登录或手机验收。
- 当前微信绑定员工没有所属门店，真实日报保存测试返回“员工尚未分配门店”；未随意分配门店，保存/提交闭环待有门店的员工身份验收。真实手机验收需用户通过开发者工具真机调试完成。
- 共用后台部署state与初始化前一致；原5433库未出现visits列。没有执行源库写入、没有部署原后台或其他云函数。
- 云函数53项私有PG测试全部通过，防误连/绑定守卫5项通过；后台类型检查通过。执行证据及回滚代码/配置在忽略目录 `_tmp/daily-isolation/`。

## 恢复

切换失败时先恢复备份中的 dailyApiDev 代码与原三项环境变量，通过统一部署入口发布并验证。备份包含代码包及私密连接，不提交Git。独立库保留用于排查，不自动删除数据卷；源dev快照只能恢复到确认的空独立库。

## 2026-10-07 经营周期开发环境更新

- 经用户授权，备份后在日报独立测试库 101.34.242.103:8151/fengyu_daily_dev 应用 daily-cycle-full.sql 候选约束，允许1～31周。46个经营月份、2份日报及Drizzle历史保持不变。备份：/www/wwwroot/fengyu-daily-db/backups/daily-20261007T145831Z.dump。
- 使用统一入口 DAILY_DEPLOY_BACKEND=wechat WX_DEVTOOLS_PORT=41652 scripts/deploy-cloudfunctions.sh dev daily 上传 dailyApiDev。CloudBase CLI 当前身份无法访问环境，使用开发者工具既有登录。
- 云端下载回读核对 routes/target.js、utils/operating-target.js、utils/operating-period.js 以及部署脚本既有关键文件，均与本地字节一致；控制台最后更新时间2026-10-07 23:01:05。
- 控制台只读核验：PG指向8151日报独立测试库，账号daily_app；DEPLOY_CHANNEL=shadow、TZ=Asia/Shanghai、Node.js18.15、256MB、30秒。未修改环境变量。
- 微信开发者工具重新编译，真实云端 auth.login、period.list、pk.classes、report.history 返回code0。首轮未传scope的个人目标查询被当前微信店长身份正确拒绝，随后按店长门店scope补验 target.read、metrics.read 均返回code0，现有四周周期兼容读取成功。
- 未更新普通dev/prod共享数据库、其他云函数或远程管理后台。正式Drizzle迁移仍待集中集成；真机可变周填写仍待验证。

## 2026-10-07 PK恢复全市场配置

- 根据用户确认，PK按归属月统一分班，取消区域月份导致的市场配置分割。11月/12月/次年1月均可配置全部54家门店；10月3个班级、9条分配保留。
- 测试库候选结构及备份见 `db/rollout/requests/daily-pk-global.md`；正式迁移仍待集成。
- 后台统一保存同月全部班级；云函数授权按是否参与该班判断，同班返回全部参与人员，指标使用每人所属市场实际日期。后台与小程序显示该日期口径，筛选保留原排名。
- 后台、小程序类型检查通过；云函数JS语法检查通过。只读核验11月全部市场54店、10月存量班级，数据库month_key回填完整。
- 通过统一入口更新dailyApiDev，回读 routes/pk.js、utils/pk-board.js、utils/pk-month.js与本地字节一致。未修改环境变量（此前控制台核实为8151日报独立库/daily_app、shadow、Asia/Shanghai、Nodejs18.15、256MB、30秒）。
- 真实微信云端只读验证 pk.classes 返回code0和4个月份；pk.read 返回code0，27行均带经营月/周日期。不代表手机性能或跨市场实数完整验收，真机待验证。
- 本批未改用户班级配置内容、未部署远程后台或正式云函数。
