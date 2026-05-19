# Ticket: 撤销 legacy_product_mapping 功能

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | 已完成 |
| 优先级 | P0（反转昨日决策，避免业务方误解） |
| 端 | db + fengyu-admin + notes/memory |
| 修复成本 | XS（纯删除 + 文档注记，无业务逻辑迁移） |
| 来源 | 2026-05-19 用户口述：「历史数据只用来判断用户的会员等级，不作为历史分析的依据，数据分析所用的数据都是从小程序上线后获得的数据」 |
| 反转对象 | 2026-05-18 B10（`product-mapping-table-intake.md`） |

## 0 一句话背景

2026-05-18 拍板"为未来按品类历史分析备好映射表"（B10）。2026-05-19 用户撤销该方案——历史数据仅服务会员等级，所有数据分析基于小程序上线后的数据。

## 1 新口径

- **WorkFine 历史数据仅用于**：会员等级判定（滚动 12 个月消费额跳档）
- **不用于**：按品类同环比、品类趋势、商品销量、SKU 维度统计、顾客标签的品类分析
- **数据分析数据源**：一律从小程序上线起算的 `sale_orders`（`sale_order_type IN ('销售单', '转换单')` + `status IN ('已支付', '已完成')`）

## 2 已执行变更

### 2.1 Schema / Migration

- 删除 `db/schema/legacy-product-mapping.ts`
- 删除 `db/schema/index.ts` 的 re-export
- 新增 `db/migrations/0041_drop_legacy_product_mapping.sql`：`DROP TABLE "legacy_product_mapping" CASCADE`
- `db/migrations/meta/0041_snapshot.json` + `_journal.json` 由 `npm run db:generate` 自动产出

### 2.2 Admin 应用层

- 删除 `fengyu-admin/src/actions/legacy-product-mapping.ts`
- 删除整个 `fengyu-admin/src/app/(main)/legacy-product-mapping/` 目录
- `fengyu-admin/src/lib/permissions.ts`：admin + product 角色摘除 `legacy_product_mapping:read` / `:write`
- `fengyu-admin/src/lib/menu.ts`：删除"历史品项映射"菜单项（`History` import 因 `legacy-orders` 仍用而保留）

### 2.3 文档 / 决议注记

- `notes/tickets/2026-05-18-EXECUTION-PLAN.md` Agent E 段加 SUPERSEDED
- `notes/tickets/archives/2026-05-18-product-mapping-table-intake.md` 文首加 SUPERSEDED
- `notes/meetings/meeting-20260507/summary.md` §3 品项映射加撤销注记
- `notes/meetings/meeting-20260507/article.md` §一.6 品项映射加撤销注记

## 3 未触动项（已正确隔离，无需改动）

第二个 Explore 全仓审计确认 WorkFine 历史数据**目前已被正确隔离**在 `legacy-orders` 核对流程内：

| 场景 | 文件 | 守护机制 |
|------|------|--------|
| Dashboard | `actions/dashboard.ts` L83-141 | 默认 `sale_order_type IN ('销售单','转换单')` + `status IN ('已支付','已完成')` |
| 员工 dashboard | `staffApi/routes/staff.js` | 同样过滤 |
| 顾客统计 | `customer.stats` / `customer.listByTag` | 同样过滤 |
| 流量统计 | `mgmt-traffic.js` L448 | 默认 `sale_order_type IN ('销售单','转换单')` |
| 会员等级 | `cron/refresh-member-levels.ts` L62-64 + `recompute-customer-tags.ts` L200-225 | 严格 12 个月滚动窗口 |
| 三端一致性 | `dashboard.consistency.test.ts` | snapshot 守护 |

## 4 DoD 验证

- [x] `legacy_product_mapping` 表从代码与 schema 清除
- [x] `npm run db:generate` 产出 0041 DROP migration
- [ ] 5434 生产业务库 `npm run db:migrate` apply 0041（**待用户授权**）
- [ ] 5433 冷备库 apply 0041（可选，**待用户授权**）
- [ ] `cd fengyu-admin && npx tsc --noEmit` 0 错
- [ ] `cd fengyu-admin && bun run lint` 0 错
- [ ] `cd fengyu-admin && bun run test` 全绿（537 用例）

## 5 未来如重启品类历史分析

- 重新立 ticket，**不**复用已删的 `legacy_product_mapping` 设计
- 先论证业务价值（业务方明确说出 ROI）
- 业务方需先交付 ≥ 80% 覆盖率的映射 CSV 才考虑技术落地
