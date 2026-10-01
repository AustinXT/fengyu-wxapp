# #365 市场自有供应商归属与自采入库选填

- 状态：待迁移集成；分支 `feat/issue-365-market-suppliers`；业务检查点初版 `efe6a5191`，最终评审 SHA/PR 见 issue 评论与 PR。
- 工作树：`.tree/feat/issue-365-market-suppliers`，本地验证/评审证据 `_tmp/issue-365/`。本条不生成正式迁移、不持开发令牌、不改 journal。正式 tag/hash：尚未生成。
- 依赖：基于最新 origin/dev `9fec5940e` 的 schema；集中集成先交接 #353 既有候选，避免旧 journal 撞号。此变更与标准价无业务依赖，正式编号/when 由集成生成器分配。工作流规则已随 `c97f8c0e7` 进入 dev；业务分支已同步含 #349 的最新 dev `9fec5940e` 后重新验证/送审。
- 变更目标：`inventory_suppliers.owner_market_id text NULL REFERENCES org_nodes(id)` 与归属索引；删除全局名称唯一 `uq_inventory_suppliers_name`，建立 `UNIQUE(name) WHERE owner_market_id IS NULL` 和 `UNIQUE(owner_market_id,name) WHERE owner_market_id IS NOT NULL`。schema 权威来源 `db/schema/inventory.ts`。
- 候选 SQL：[issue-365.sql](issue-365.sql)。仅私有验证，带独立事务与 `SET LOCAL lock_timeout='3s'`，不写 Drizzle journal；集中集成须按 schema 生成正式迁移三件套并比较候选差量。正式 SQL 若改变须重放/复审。
- 数据兼容：存量全部保留 NULL，含停用档案，UI 标「供应链共有」；不回填/重命名/删除数据。现有名称全局唯一意味着建两条 partial unique 不需去重。市场内启用/停用同样禁止重名，不同市场或市场/共有允许同名。`supplier_id` 外键、历史单据/批次冻结名不动。
- 前置只读检查：核对列不存在、现有全局唯一索引存在、按 name 的重复组数=0；记录供应商总数和启用/停用数，不含联系人/电话。检查业务 schema/journal/hash 与待发布树一致。
- 原子性与重入：正式迁移受 Drizzle 事务管理，锁超时或索引失败全部回滚；本候选用于一次 apply，不用 IF NOT EXISTS 掩盖漂移。不承诺直接重复 apply 幂等。失败后核对 schema 与 journal，恢复集成候选；只读/测试夹具脚本不承担正式发布。
- 验证：端口 54405，私有 `pg-verify-365`。候选在空库基线上与有 NULL 存量（启用/停用）的基线上 apply；检查新 FK、旧索引删除、两条 partial unique 与索引；共有/本市场重名各拒、跨市场同名允许、无效 owner FK 拒；真实 engine/action 验证供应链/市场读写隔离、SKU 和自采入库后端拒伪造 supplierId，空供应商单头/批次/明细均 NULL。
- 上线顺序（dev/prod 分别登记）：前置 schema/journal/名称唯一只读核对 → 正式 `db:migrate` → `DATABASE_URL=<显式目标> node db/scripts/verify-inventory-v3-schema.js` 校验归属列/FK/新索引及旧索引消失，另只读核对存量 NULL 数 → 上线本分支 admin 与相同构建的 export-worker → 三账号实效验证。没有独立回填脚本；不需要云函数/小程序发布。
- 应用依赖：新查询使用 owner_market_id，旧库会 42703，必须先迁库后发布；不能把当前 draft 当可部署代码合并。集中 DB PR 与业务 PR 互相引用，正式迁移与最终业务 HEAD 都需评审；不自动 merge、迁业务库或部署。
- 实效层：供应链只见共有、市场 A 见共有+A（不见 B）；市场 A 在供应商页和 SKU 弹窗可建档；同名后缀与 NULL 标识；空供应商自采入库完成；改名/停用保留历史冻结信息。

- 私有 action smoke 可重复执行，每次使用随机运行标识隔离供应商名称；完整库为一次性夹具，验证完成只删除本单容器，不在共享库运行或清理。候选 PG 专测从旧基线 apply，只能在重新构建的私有基线上重跑。
