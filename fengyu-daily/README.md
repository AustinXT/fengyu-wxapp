# 凤御日报：首期最小闭环

在 `daily` 分支开发，参考 `daily-report/daily-summary-miniapp-v2.html`。

## 本期功能

- 微信手机号授权绑定：日报 AppID + OPENID 独立绑定既有员工编号，不覆盖员工端 OPENID，不创建员工档案。
- 自动查询本人当天已开始/待确认/已完成的实际服务，以及当日有效销售业绩分配。
- 服务来源销售仅作为项目来源展示，避免重复填写同一订单反馈。
- 业务反馈、后续跟进、今日行动、今日成长、明日计划。
- 保存草稿、提交、历史回读；店长只可查看权限门店内已提交日报。
- 每员工每天一份日报，版本冲突拒绝覆盖；当天提交可修改后再次提交，历史已提交只读。
- 提交时冻结业务快照，订单/项目改名不修改已提交内容。

阶段目标不包括目标配置、周期统计、PK、导师点评或后台 Web 页面。

## 角色工作台与底部导航

登录响应沿用员工端 `roleBindings`、组织范围展开、`staffLevel` 和看板权限判断。日报保留员工端 `scope`、`permission-matrix` 独立副本，并通过字面量测试守护。工作台由服务端返回，前端保存的选择只控制显示，不参与后端鉴权。

- 员工：首页 / 记录 / 我的，显示本人日报和最近记录。
- 店长：首页 / 本店 / 我的，显示店长角色所授权门店的提交和未提交员工。
- 管理层：总览 / 组织 / 我的，需要已有看板权限及非空门店范围；总览、组织逐层浏览、人员查找和门店日报查询使用服务端授权范围。
- 多身份用户可在“我的”切换工作台；每次登录重新校验可用身份，权限撤销后本地旧选择自动失效。

当前总览统计单日、按当前在职员工计算。经营月 / 周、目标和 PK 仍属于后续阶段，不能将当前统计解释为历史出勤或完整原型已经交付。

## 开发配置

| 配置 | 值 |
| --- | --- |
| 小程序 AppID | `wx4da3e1e9ad861396` |
| CloudBase 环境 | `cloud1-d5gz7zr8x6c38bd49` |
| 开发版函数 | `dailyApiDev` |
| 开发业务库 | `101.34.242.103:5433/fengyu_wxapp` |

本期仅部署开发版；体验版/正式版调用 `dailyApi`，正式发布需单独配置和部署。账号凭据不进入源码；开发库连接串来自忽略提交的 `envs/dev.env`。

## 身份与权限

使用 `wx-server-sdk` 的可信 `getWXContext()`，不支持客户端传入 OPENID、员工编号或直接手机号作为身份。手机号优先通过微信一次性 code 服务端兑换，也兼容员工端使用的 cloudID，由云函数通过 `getOpenData` 读取；不接受客户端解密对象。需日报小程序自身具备手机号授权能力，并使用微信真机验证；`config.json` 声明 `phonenumber.getPhoneNumber`。

关联手机号必须已存在于在职员工档案。微信或员工编号已绑定其他身份时拒绝自动换绑，由管理员核对处理。离职或权限撤销立即生效。

店长门店范围由 `permission_roles` 中 `is_store_manager` 角色对应的组织范围展开。草稿正文、版本和草稿是否存在均不对店长开放。未提交名单按当前在职员工展示，历史日期的该名单不代表历史应出勤人员。

员工端的 PG 连接池、组织权限范围、错误码工具保留独立副本，单测检查字面一致；没有跨端共享目录。

## 运行与部署

```bash
npm --prefix fengyu-daily ci
npm --prefix fengyu-daily/cloudfunctions/dailyApi ci
npm --prefix fengyu-daily run typecheck
npm --prefix fengyu-daily test

# 先确认待执行清单，再迁开发库（仅允许日报迁移）
node scripts/migrate-daily-dev.mjs
node scripts/migrate-daily-dev.mjs --apply

# 登录开通日报环境的账号
npx --yes --package=@cloudbase/cli tcb login
# 如果提示已登录，但 env list 没有日报环境，先 logout 再 login 切换账号。
npx --yes --package=@cloudbase/cli tcb env list

# 部署入口统一走项目脚本；daily 不包含在现有 all 的默认范围中。
scripts/deploy-cloudfunctions.sh dev daily --plan
scripts/deploy-cloudfunctions.sh dev daily
```

脚本要求 `tcb` 在 PATH；如果用 npx，可在同一次 shell 中提供：

```bash
npx --yes --package=@cloudbase/cli -c 'bash scripts/deploy-cloudfunctions.sh dev daily'
```

脚本固定校验环境、函数名、开发库 IP/端口/库名；已有函数先读环境变量并合并，再上传，上传后回读核验。首期拒绝 `prod daily` / `both daily`。

### 微信开发者工具登录的环境

如果腾讯云 CLI 账号看不到 `cloud1-d5gz7zr8x6c38bd49`，但微信开发者工具可以看到，可以使用该工具的既有登录上传代码：

```bash
DAILY_DEPLOY_BACKEND=wechat WX_DEVTOOLS_PORT=41652 bash scripts/deploy-cloudfunctions.sh dev daily
```

先在正确环境的控制台创建同名 `dailyApiDev`，运行版本选择 **Node.js 18.15**。微信 CLI 首次创建采用默认版本，因此脚本禁止它首次创建。

控制台「版本与配置 → 配置 → 高级配置」需设置：超时 **30 秒**、内存 **256 MB**；环境变量 `PG_CONNECTION_STRING` 使用本地 `envs/dev.env` 中的同名值，`TZ=Asia/Shanghai`，`DEPLOY_CHANNEL=shadow`。凭据不要粘贴到聊天或提交到 Git。

微信 CLI 上传必须使用 `--report` 等待逐函数结果，再下载云端代码，比对入口、登录、日报及数据库文件；仅退出码为 0 不代表代码已更新。脚本包含这些回读检查。

微信 CLI 不能推送或完整回读环境变量。脚本会明确返回“部署仍待核验”；需在控制台核验配置并从开发版小程序调用 `auth.login`，才能认定联调通过。

微信开发者工具打开本目录，重新编译，使用开发版测试。手机号必须与开发库的员工档案一致；店长必须在开发库有对应角色范围。

### 尚未开通手机号能力时的开发测试

执行 `node scripts/create-daily-test-binding.mjs <员工手机号>`，只读开发库核对在职员工，生成4小时有效的随机测试码。原码保存在忽略文件 `_tmp/daily-deploy/test-binding-code.txt`，云函数配置 `utils/test-binding.json` 仅保存哈希、目标员工编号和有效期，并随统一部署入口上传；两个文件都不能提交 Git。

开发版首页的“开发测试绑定”输入该码，即可用日报自身 OPENID 绑定已有员工编号。服务端同时要求 `DEPLOY_CHANNEL=shadow` 和固定开发库地址；正式版不显示入口，正式通道/生产库拒绝调用。绑定事务锁定员工行，已绑定的员工或微信不能再次使用，也不会覆盖员工端 OPENID。该入口仅用于当前开发测试，并非正式管理员发码功能。

## 验证

后端真实数据库测试只允许本地独立 `/test` 库，不能指向真实业务库：

```bash
DAILY_TEST_DATABASE_URL=postgresql://postgres:test@localhost:54399/test npm --prefix fengyu-daily test
```

空库迁移验证按 `db/CLAUDE.md` 使用临时 Docker PostgreSQL 和 `bootstrap-from-zero.sh`，验证后销毁容器。

```bash
npm --prefix fengyu-daily run test:ui
```

UI 自动化通过开发者工具，临时模拟接口返回；不替代真实微信绑定和云端联调。测试结束恢复微信方法，截图保存在 `_tmp/daily-ui/`。

## 本期接口

`auth.login`、`auth.bindPhone`、`auth.bindTestCode`（仅开发测试）、`report.read`、`report.save`、`report.submit`、`report.history`、`manager.list`、`manager.detail`、`management.read`。

统一 `{ action, payload }` 输入，`{ code, message, data, errorType? }` 响应。`PHONE_REQUIRED` 与 `PERMISSION_DENIED` 均为 -403，前端按 `errorType` 区分。
