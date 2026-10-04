# 日报 V2 数据库集成请求

- 2026-10-03 用户确认完整原型实施及结构影响计划，开发分支 daily。
- 候选结构见 daily-v2.sql；schema 源为 db/schema/daily-report.ts。
- 依赖既有0061日报三表及最新dev业务视图。既有员工与顾客微信身份不修改。
- 新增经营周期／月周目标／PK班级及门店参与；日报指导关系和周期／金额快照为nullable，旧日报保持回读兼容。
- 金额存分（bigint），限定JS安全整数；月目标确认锁定与周编辑校验由后端事务执行。
- 修改已使用周期时保留已提交日报快照，实时统计读取新配置；不更新工资或原始销售／服务日期。配置更新需影响预览及审计。
- 正式迁移待集中集成，不在开发阶段运行共享dev/prod库迁移，不手写正式编号／when／journal。
- 验证：独立Docker PostgreSQL从零重放旧历史，再执行本候选；真实目标确认锁定／周版本／授权范围／并发／第四周余额测试。最终schema与候选需在集中集成时逐项比对。
- 发布顺序：正式迁移通过集成和评审 → 单独授权目标环境迁移 → 云函数／小程序／后台配置发布 → 多身份联调。

## 2026-10-03 继续实施的验证

- daily-v2 已合并回 daily，候选结构未改动、未迁共享库。日报47项测试、后台真实PG配置及菜单26项测试、两端类型检查通过。
- 微信开发者工具 UI 使用模拟接口；后台 UI 使用本机一次性私有 PG。截图 `_tmp/daily-ui/`，不视为真实云端验收。
- 工作树迁移扫描未发现其他两个工作树的 schema/migrations 未提交改动；尚缺全部 open PR 的迁移核验（gh 未登录），正式集成不能开始。
- GLM/DeepSeek 探测未通过：本机缺 opencode 和 DeepSeek 配置。证据 `_tmp/daily-review/probe-1/summary.json`；未冒充已评审。

## 2026-10-03 日报 V2 集中集成

- 正式迁移 `0062_daily_v2_operating_pk`，when=`1791020803394`，SQL SHA-256 `dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca`。基于最新 origin/dev，在隔离分支 codex/daily-v2-migration 集成日报 V2。
- 内容仅四张新表及 daily_reports 四个 nullable 字段与约束/索引；无删除/回填，旧日报正文和明细不变。复合唯一索引先于引用它的外键创建。
- 私有空库重放63条通过；存量已提交日报升级完整保留；日报47项、后台26项测试通过；DB测试99项通过、13项环境型跳过；两端类型检查通过；生成器二次核验无额外结构变化。
- 用户本聊天已授权 dev 建表、后端及后台更新和联调；沿用跳过双谱系决定。部署顺序：核验 dev 历史→db:migrate→结构与历史回读→dailyApiDev→admin dev→真实小程序联调。无额外数据脚本。
- 状态：正式迁移已生成并通过私有验证；等待本次授权 dev 更新及真实联调。

### 2026-10-03 日报 V2 dev 实际执行结果

- 北京时间17:51:51，`0062_daily_v2_operating_pk` 经显式目标校验后的 `npm --prefix db run db:migrate` 执行成功。目标101.34.242.103:5433/fengyu_wxapp；SQL hash `dc0ebb9de66e09ce48580fd43e1dff002ba8d439b8e1a560981474fc45e4e7ca`、when `1791020803394`，库记录id64。四张新增表、四个新增字段及迁移记录回读通过；日报行数执行前后均0。
- 发布提交 `f998dc19cbc2`，admin release `dev-f998dc19cbc2-b4377b31991a-20261003T095253Z-24341`，镜像 `fengyu-admin:dev-f998dc19cbc2-64bb1bcb771b`，部署脚本RELEASE_OK。
- 使用统一入口 `DAILY_DEPLOY_BACKEND=wechat WX_DEVTOOLS_PORT=41652 scripts/deploy-cloudfunctions.sh dev daily` 上传dailyApiDev到cloud1-d5gz7zr8x6c38bd49。26个JS文件完整下载回读一致。微信CLI最终返回待核验提示（退出1），随后通过云控制台只读核验：Node.js18.15、256MB、30秒、PG公网dev目标且无连接覆盖参数、DEPLOY_CHANNEL=shadow、TZ=Asia/Shanghai。
- 小程序已重新编译；当前微信真实身份auth.login及11个读取接口均code0：period.list/target.read/pk.classes/report.history/metrics.read/contacts.list/report.read/business.list/report.previous/manager.list/management.read。未模拟接口。首页和目标页实际显示尚未配置经营周期。
- 验收限制：当前绑定管理员无主门店，不能替代普通员工填报验收；真实经营月/四周日期与PK分班未收到用户决定，保持空配置；共享库未写入虚构日报。后续需有门店的员工身份完成保存/提交/店长回读，以及业务配置后的目标和PK验证。三角色截图自动化在首个首页后超时，不将其计为全角色UI验收。
- 交付PR https://github.com/AustinXT/fengyu-wxapp/pull/523 ，仍待合并。已同步本机daily分支；在PR合入dev前，其他会话不得从旧dev再次生成0062。外部双谱系按用户明确指示跳过。
- 脱敏执行证据在起点仓库 `_tmp/daily-v2-release/`。prod未迁移、未部署。
