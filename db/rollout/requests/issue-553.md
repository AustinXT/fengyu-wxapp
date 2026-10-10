# #553 业绩仅排除体验卡：视图迁移请求

状态：待集中迁移集成。用户已确认跨端方案；本单独立开发不生成正式迁移，不迁共享 dev/prod。

## 目标与依赖
修改 sale_reportable_payment_events / sale_reportable_item_events 的资格：仅 sale_items.is_experience=true 排除，其余已售行计入。一级/二级品项类别保留分组功能，不作为资格过滤。现金封顶、正负转换、退款、卡价值及确定性分币尾差算法保持。历史 residual 按已售体验快照，非体验保留、体验归零。

依赖当前 origin/dev 正式历史（截至 0063），必须保留既有 sale_items.is_experience、sale_order_performance_events、sale_item_performance_events 与 receipt。无新表/列/枚举，无数据回填。0057 及既有 journal/hash 不改。

候选：issue-553.sql，仅供本地私有 PostgreSQL 及集中集成参考，由修改后的 Drizzle schema 两个视图直接渲染；admin experience-performance-views.test.ts 逐字校验候选与 schema 等价。候选不是业务库执行入口，不占用编号或 journal。正式迁移由集中集成流程生成并验证（包括依赖视图的创建/替换顺序，不使用 CASCADE 删除无关对象）。

## 数据兼容与验证
- 返回列及原资金事实视图不变。仍冻结已售体验资格，不查询当前 SKU 来推断；缺 SKU/分类保留已售资格与显式兜底。
- 真库套件 tuoke-performance.pg.test.js 已转为 #553 体验语义，并在外层事务应用候选、结束回滚；私有目标仅允许 loopback，拒绝连接参数覆盖，禁止业务库名。CI 正式历史重放后执行同一候选与正反例。
- 覆盖跨类别体验、同类别非体验粉红、5000=5168-168 转换、混合体验、多次回款、跨月退款、现金/卡拆分、尾差、零分母、缺明细和历史 residual。
- admin 旧余额与关闭订单真库回归改测新 schema；staff 与日报通过同源视图继承，只核验现有独立指标范围。
- 生产 9 月回归仅从只读同一快照抽取事实，在本地私有库应用候选复算；线上旧视图数值与候选新口径明确区分。证据留 issue checkpoint，不提交客户明细。

## 集成与上线顺序
1. 集中集成基于最新 dev 生成正式视图迁移；空库全历史重放和存量升级验证，无资金记录/已售快照变动；生成完整 migration/journal/snapshot 并重做最终双谱系评审。
2. 正式迁移与业务 PR 互相引用，集成完成前业务 PR 保持 draft，保留 worktree。
3. 授权发布时各环境独立校验 journal、先迁视图，再部署对应 admin/export worker。staff/daily 若无源码变化，已部署查询会自动读取新视图，发布核验必须覆盖同名指标。
4. 分别记录 dev/prod 执行状态，本次请求不表示迁库或部署授权；生产新值须待授权迁移后另做线上实效核验。
