# #301 阶段1调查与守护（2026-10-03）

采样时刻：PG 2026-10-03T03:14:07.608Z；WorkFine 2026-10-03T03:14:07.267Z。PG 使用 REPEATABLE READ READ ONLY；WorkFine 只 SELECT，两库无法同一快照。脚本 `db/scripts/audit-customer-binding.js` 可复跑，默认只输出汇总，`--out` 以0600新文件保存候选。未回填/迁库/部署。

## 根因证据与界限

当前PG 5746 顾客，员工绑定NULL 4061；空串0、带空白0、不存在员工0、不同门店0，已离职员工绑定33。不同门店仅描述形态，#250已定不做顾客门店/员工门店互查，不能据此判脏。

按当前会员客、入会月份、上海时区：7月35/53=66.0%，8月59/155=38.1%，9月43/193=22.3%。旧审计63.5%/20.8%不是固定阈值，随新增/历史归因变化，下降趋势仍成立。

8/9月缺绑定会员96+150=246，无 `customer.assign` 审计、无 `changes.boundEmployeeId.from` 非空审计。7/8月没有admin `customer.update` 绑定非空→空事件，9月4条也不属于这246人；这不涵盖转店审批。复核请求表：7/8/9月已通过转店6/50/93条，其中8月1条、9月4条关联当前8/9月缺绑定会员。换店审批本就主动清空员工，属于确实发生的“写后清空”分支，不能把全部246人定为从未绑定。更支持新会员未分配，**不是证实从未绑定**：历史日志未覆盖所有手工SQL/同步/合并；转店审批另通过请求表复核，不可凭缺日志断言绝不存在覆盖。

四条已要求路径：
- `updateCustomer`：未传/undefined/同值不更新绑定（#250已有守护）；显式null可解绑并清冗余姓名，主表单带updatedAt并发守卫。
- `createCustomer`：可无绑定建档；不要求“新会员一定有员工”，管理员不能被脚本自动替代分配。
- `assignCustomer`：显式合法员工，校验第二主体scope并同步ID/姓名。staff.assign同样显式操作。
- `mergeClientProfile`：仅源字段空才搬孤儿值；修复事务外读空、并发分配后被孤儿旧值覆盖的竞态：在原客户行写入位置 FOR NO KEY UPDATE 复核 ID/姓名，两者任一变化就保留当前绑定并从 fieldsMigrated 移除。未改变既有孤儿员工 scope 处理政策。

扩展扫描：clientApi登录INSERT只写微信身份；bindStore不写员工；会员跃迁recalc只写标签/归因；审批换店清空员工为既有业务。WorkFine三个同步UPDATE无条件覆盖，但脚本自9/23无条件拒prod，当前PG customer_id均空，不能以源码直接推定生产8月运行过同步覆盖。

## 时间轴

同步覆盖代码在2026-03-13/15已存在（5d2805d48/66782c681），不是8月新引入。7/26登录同号幂等修复4cf6b5d37不写绑定；8/24 f20d3a04e涉及单据口径，8/26 af23d39ee/022022ab7新增档案人工覆盖字段但不保护或改变员工绑定。9/22 #250将update/create/assign scope、undefined和同值竞态收敛；9/23 8e967e8dd禁止prod同步。git/migration扫描未找到8月新增全量清空此列的迁移。

这是代码提交时间轴，**未获得对应生产发布/同步执行历史与逐行旧快照**，不能把commit日期写成部署日期。待定位是否某次发布导致业务分配减少，必须结合运营分配流程与日志留存。

## 回填候选（不执行）

当前缺绑定范围4061人（含非会员）；规则如下：
- 首单：最早已支付/已完成销售单，COALESCE(paid_at,created_at)→sale_order_id确定性选单，opened_by为候选，非“最早任意状态订单”。
- 服务：最早已完成服务单，service_date→created_at→service_order_id选单，服务明细employee_id为主操候选；同单多个主操记歧义，不挑一个。
- WorkFine：PG行持有customer_id时只做该ID精确匹配（源中查不到也不退到同手机号其它客户）；PG行无此ID才按手机号匹配；UDF_S_6444主要是姓名，按姓名+来源门店匹配现PG员工，保留多候选歧义，不直接把姓名写employee_id。离职候选另列，active不是准确率承诺。

|依据|有候选|唯一候选|唯一且在职|歧义|
|---|---:|---:|---:|---:|
|首单员工|970|970|970|0|
|服务主操|3468|3468|3388|0|
|WorkFine映射|364|360|318|4|

至少两个唯一依据互相冲突994人；三依据均唯一25人，其中冲突25人。具体名单保存在本地备份目录，不入git。WorkFine62883源行不能等同PG顾客数。

## 阶段1尚未通过的验收

已交调查证据、三候选统计与“不清空已有绑定”守护；**尚未证实8月某个写入/部署导致批量丢绑定，也未完成新数据覆盖率回到60%的止血效果**。不擅自把首单/主操/WorkFine的一条规则实施为自动绑定。若业务确认是未分配，新客应由谁在何时指定需决定；存量回填仍在阶段2另拍依据。本交付保持draft，不宣称整条bug修复。

新增调查复核：service_items.employee_id schema NOT NULL；同时工具仍显式过滤null/空白主操防候选统计失真。个人名单导出检查真实父目录及所有祖先的.git，拒绝仓库/软链入仓库，0600且wx不覆盖；工具7条边界测试通过。

止血检查点：110个admin顾客用例通过（含源非空、读空后新分配已提交、锁内仍空继续原迁移）。临时PG使用真实Drizzle同款查询确认读到新绑定、FOR NO KEY UPDATE使后续分配等待提交；未执行真实Server Action对业务库写入。该确定性竞态已修，但未证明生产8月覆盖率下降由它导致，原60%效果验收仍待。

## 2026-10-04 继续轮：完整合并动作回归

恢复同一 PR 分支并合入最新 origin/dev（02e9d8063，#520/#522 已合并）。原 worktree/checkpoint 目录已缺失；a199 提交、研究文档及私有调查导出仍在，未重做历史调查或伪造缺失的本地评审文件。

新增 `fengyu-admin/tests/e2e-actions/verify-customer-binding.mjs`，从 admin 运行：
```bash
bun --preload ./tests/e2e-actions/_admin-preload.mjs ./tests/e2e-actions/verify-customer-binding.mjs
```
脚本自建唯一临时 PostgreSQL 容器、强制 E2E_DATABASE_URL 为 localhost 随机端口，finally 停容器，不读取或写入业务库。实际调用完整 mergeClientProfile 和真实 Drizzle；会话、权限、审计与 Next 缓存使用既有替身。夹具仅包含本动作所需列/外键，不冒充完整迁移重放或真实鉴权验收。

三例通过：
1. 事务外读取未绑定后，另一 PG 连接在事务开始前完成新分配：保留新员工 ID/姓名，fieldsMigrated 不虚报搬迁绑定，ordersReassigned=1。
2. 锁内仍未绑定：按既有规则搬孤儿绑定，返回字段与数据库一致。
3. 已有员工绑定：不覆盖为孤儿员工。
每例同时验证九张引用表全部迁移、积分余额重算与孤儿删除。临时移除 #301 保护块后，同一完整动作回归在绑定字段迁移断言失败；finally 已恢复源码。此为对原确定性竞态的回归判据，不证明它解释了生产 8 月下跌。

最新 admin tsc 通过，顾客单测 110/110。新增测试本身不改变员工归属业务规则。PR 仍 draft：新客归属方式未选择，生产历史根因及 ≥60% 实效验收尚无足够证据。下一步由业务确定分配时点/负责人，再实现、完整验证与最终双谱系评审；存量回填依据仍另属阶段 2。


## 2026-10-05 已确认人工分配规则与止血实现

用户确认「店长明确指定员工」及跨 admin/client/staff 实施计划。首次入会前必须存在真实 `bound_employee_id` 对应员工；沿 #250 既有校验，不新增员工门店与顾客门店相等或离职状态限制。客户端无分配权限，不自动用开单人/主操/推荐人替代。存量会员及已有 became_member_at 记录属于阶段2，不阻断正常消费。

- admin/staff/client 的本地结算使用原 #187 实际分类查询；只有计算为会员客时核验绑定，失败让整笔本地事务回滚。后台错误处理透出店长分配提示。
- client 在线首次支付/回款，先按成功回调的实际现金终态和本次现金+待扣卡金额预演 receipt；复用原分摊算法、原 paid-sessions 瀑布及逐项退款 SQL、原分类 CTE。SAVEPOINT 中只临时更新订单/行实收，finally 回滚；随后才允许支付意图 CAS 与渠道下单。既有有效渠道意图优先复用，payNotify 不增加阻断。
- 人工入口沿用员工端顾客详情 `customer.assign` 和后台顾客详情；后台新建增加明确所属员工选择。创建审计补绑定字段，合并审计补实际迁移的绑定前后值；并发新分配仍受原合并保护。
- 新的 `verify-membership-binding.mjs` 使用独立临时 PG：真实 assignCustomer（认证/审计/cache 替身）、真实预演与 capture/分类 SQL，覆盖缺绑定/人工分配、部分与最终付款、退款、历史 receipt 缺失、混合体验、现金+待扣卡、两单不累计、悬挂员工 ID、客户行锁、事务回滚。付款最终会员写入在夹具中按原 SQL结果执行，并非完整线上渠道或所有结算 Action 的端到端联调。
- callback 测试补齐已漂移的 receipt 读取 mock，并覆盖分类会员客且未绑定仍 SUCCESS/COMMIT。线上已完成事实不能因为部署前意图或合法转店清空而拒绝记账。

尚未证实生产 8 月某次执行/部署造成整体断崖；已能复现客户端注册未分配而付款入会的缺落路径，并修复合并覆盖竞态。新客受控规则已验证，生产新会员 ≥60% 属部署后人工实效；旧意图/转店等例外用只读审计工具核对，不承诺实时100%。存量来源冲突仍不自动回填，阶段2须另定依据。未部署、未迁业务库、未改存量客户。


### 首轮评审后的边界修正

守护限定本次结算订单自身的单笔非体验毛实收达标，不因另一张历史达标单而阻挡本次体验/小额/部分付款；历史已达标但分类未更新属于阶段2异常档案，原分类更新规则继续执行。三端独立 helper 查询/参数/客户行锁行为一致性已测试，机器原因 `MEMBERSHIP_BINDING_REQUIRED` 放在 data，顾客提示无内部子标签。后台与员工开单页补前往顾客详情人工分配入口。

只读 receipt 规划同步到三个 JS 独立副本，既有 capture 字面快照继续守护，同时新加 preview 全文相等快照；admin 的既有 TS 分摊算法保持同义。私有 PG 退款案例实际命中完整 receipt 分支（SQL trace 明确包含 jsonb_to_recordset），另例命中不完整 receipt 瀑布分支，均有断言。线上临时状态 UPDATE 也携带 pending/partial CAS 并检查影响行数，finally 回滚后再做真实绑定检查。


### 补齐完整收款 Action 的私有 PG 验证

新增 `fengyu-admin/tests/e2e-actions/verify-membership-payment-actions.mjs`：独立临时 PostgreSQL 16 按当前 journal 逐条、逐事务重放 63 条实际迁移，随后运行真实 admin.confirmOfflinePayment / recordPayment、staff.confirmOffline、client.confirmPrepaidFull。云函数明确 PG_CONNECTION_STRING 注入同一 localhost 临时库，用各自真实 pg 池；handler 接构造的已认证上下文，真实 requireManager/requirePhone 继续执行；Next 会话/权限/审计/cache仍用既有preload替身，不冒充登录/渠道联调。

三端均验证缺绑定负例让现金、卡交易、receipt、积分和订单整体回滚，真实 assignCustomer 分配后原动作放行；会员 customer_type / became_member_at / bound_employee_id / 升级单标记由真实结算代码落库，不再由夹具手写标签。后台另外覆盖首次部分收款成功、最终录入回款被拒绝且首笔实收保留。所有例通过，PG池/容器已清理。

该测试补齐本地规则与结算链验证，但仍不替代真实渠道/OPENID登录/真机/生产运营覆盖率实效；不因此修改原issue整体验收状态。早先最小夹具的验证限制仍如实保留，完整Action证据是本次新增的独立结果。
