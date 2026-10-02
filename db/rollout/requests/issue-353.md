# #353 既有正式迁移交接

状态：接入隔离 DB 集成分支；待评审/合并。开发、生产库执行事实尚未核对，本次没有连接业务库。
来源：`1b965a6f7693b4a3df044cf45f3ab039f4318fbc` 的已提交 schema 与完整 SQL/journal/snapshot；原工作树未提交业务改动未接入。
基线：`9fec5940e9ca103111db4434a078b4bf760279fa`；旧 0000–0057 SQL 与 journal 逐字节/条目一致。

## 正式候选

- tag：`0058_store_surplus_standard_price`；idx：58；when：1790834272000（均保留生成器原值）。
- SQL：`db/migrations/0058_store_surplus_standard_price.sql`。
- SHA256：`f7fb41a1127d3e9b61507e6f0199913ea39b309559ccf8858db454c165047690`。
- `inventory_skus.standard_price numeric(12,2)` 可空、无默认/回填，负数和 NaN 拒绝；存量 SKU 保持 NULL，不从 WorkFine 或其他价格推算。
- 新增分院盘溢类型与盘点盘溢血缘 CHECK；复用 0052 血缘函数其余分支，按来源明细先加锁，新增正差异累计上限和同主体/SKU/完成态守卫。
- 金额触发器仅给两种盘溢补标准价兜底；实际价含 0 优先，采购订单供应链成本价分支保留。
- 无额外一次性脚本，无价格回填。原 SQL/journal/snapshot 未修改内容、编号或时间。

## 环境执行顺序

1. 发版授权后分别断言 dev / prod 目标，按待发布 SHA 的完整 journal 与目标库 `drizzle.__drizzle_migrations` 只读核对实际 pending、when 和内容 hash。未知状态不能当作未执行；库超前/hash 漂移则停止。
2. 迁移前只读检查既有 SKU 价格 CHECK，确认无需回填、安排低峰锁窗口。该候选没有内置 lock_timeout，为保留原 SQL hash，用 `PGOPTIONS='-c lock_timeout=3s' DATABASE_URL=<已断言目标> npm --prefix db run db:migrate` 限制取锁等待；不能直接执行 SQL 或跳过 journal。命令执行发布树全部 pending，其他待迁项也必须已核准。
3. 核对该 tag 的实际 hash/when、standard_price 可空且无默认、三个 CHECK 定义和两个触发函数；确认存量 standard_price 无未经批准填充。额外脚本：无。
4. 数据库校验成功后，才允许发布 #353 标准价/盘溢业务代码（业务代码独立开发/评审）；数据库先行兼容既有代码。
5. 此 DB PR 合入 dev 后，#365 才可基于最新 journal 正式生成供应商归属迁移，再走私有验证、评审与 DB PR。#507 继续 draft，不能据本候选交接认定其 migration CI 已修复。

## 私有验证

- 仅 `127.0.0.1:54405`，数据库 `verify_353_handoff` / `verify_353_empty`；不迁共享或业务库。
- schema 再生成无变化；journal/SQL 一致；旧基线 58 条 → db:migrate 增量；从零 bootstrap 59 条。
- 增量前植入旧 SKU/单据明细，迁移后新增价 NULL、旧价/金额不变。
- `STORE_SURPLUS_PG_TEST_URL=<上述私有目标> node --test db/scripts/__tests__/store-surplus-migration.pg.test.js` 覆盖价格、两种盘溢、正差异累计、错误来源/主体/SKU/状态/数量，以及采购订单成本价分支；另跑既有数量 PG 回归。
- 具体日志/结论见集成 checkpoint `_tmp/db-integration-353/` 与交付 PR。
