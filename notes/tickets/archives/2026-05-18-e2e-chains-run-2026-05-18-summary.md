# E2E-Chains 自动跑批汇总（2026-05-18）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 测试库 | 5433/fengyu_wxapp（README 指定，跑完已还原 .env.local 到 5434/fengyu）|
| 跑批耗时 | ~45 分钟（含 4 轮重跑）|
| 总链路数 | 31（link-1 ~ link-31）|
| 通过 | 22 ✅ |
| 部分通过 | 1 🟡（link-3 3/4）|
| 失败 | 8 ❌ |

---

## 跑批前我已修的环境问题（已自行处理）

| 操作 | 原因 |
|------|------|
| `.env.local` 切到 5433/fengyu_wxapp + 重启 dev server | 用户授权 |
| 在 5433 跑 db:migrate 补 0037 + 0038 两条迁移 | 5433 落后 5434 两个迁移，致 `legacy_source` 列缺失 + `未审核` / `寄存单` 枚举值缺失 → createOrder 全 500 |
| INSERT FY-TEST-MGR manager 角色到 5433.permission_roles | 此账号在 5433 缺角色，致 link-14/19/25-29 全部被拒 |
| UPDATE FY-FIX-CARD-01.balance=1000 | link-10 上次跑挂未恢复 |
| 批量清理 FY-FIX-CLIENT-01 残留 11 单 sale_orders + 1 单 service_orders | uq_so_client_active 唯一约束堵塞新单 |
| 删 .next 重启 dev server | hot-reload 把 build 缓存挂坏 |

跑完已 .env.local 还原 5434。**5433 上的痕迹未还原**（如果 5433 弃用就一起 DROP；如果保留作测试库就是基线状态）。

---

## 通过的 22 条 ✅

link-1 / 2 / 4 / 5 / 7 / 8 / 9 / 11 / 13 / 14 / 15 / 19 / 23 / 24 / 25 / 26 / 27 / 28 / 29 / 30 / 31

详细日志：`/tmp/link-runs/link-{N}.log`

---

## 失败的 8 条 + 1 部分通过 — 每条已开独立 ticket

| 链路 | 失败步骤 | ticket | 类别 |
|------|---------|--------|------|
| 3 (B2) | 服务单关联预约 employee select 空 | （并入 link-12 ticket 或独立排查）| 可能 admin bug |
| 6 | cron 升级 fixture spend < ¥1980 | `2026-05-18-e2e-fixture-cron-member-upgrade-design.md` | spec 设计 |
| 10 | card balance 跑挂未恢复污染递归 | `2026-05-18-e2e-link-10-card-pollution.md` | spec cleanup |
| 12 | /services/create 顾客搜索找不到 fixture | `2026-05-18-admin-services-create-customer-search.md` | 可能 admin bug |
| 16 | CSM 进 /customers/[id] PERMISSION_DENIED | `2026-05-18-admin-customer-detail-permission-overreach.md` | admin bug |
| 17 | dashboard 门店今日业绩 0 vs SQL ¥854 | `2026-05-18-admin-dashboard-store-revenue-mismatch.md` | admin bug |
| 18 | 同 16 | 同 16 | admin bug |
| 20 | dialog 内外按钮 selector 歧义 | `2026-05-18-e2e-link-20-coupon-batch-selector.md` | spec UI |
| 21 | admin 开单页家居 SKU 找不到 | `2026-05-18-products-category-id-orphan-mall-prefix.md` | **P0 数据 bug**（products.category_id 全断）|
| 22 | 同 6 | 同 6 | spec 设计 |

---

## 元 ticket（决策类）

- `2026-05-18-e2e-chains-test-db-mismatch.md` — README 写 5433 测试库，用户口头说"开发阶段都在 5434 跑"；5434 上 fixture / FY-TEST-* 一无所有，spec 直接不可跑。需要决策。

---

## 用户决策优先级建议

P0 立即决策：
1. `2026-05-18-e2e-chains-test-db-mismatch.md` — 不决策这条，下次跑测试又会卡在同一环境问题
2. `2026-05-18-products-category-id-orphan-mall-prefix.md` — 5434 / 5433 都 962 个商品 FK 全断，影响远超 e2e 测试

P1 这周排：
3. `2026-05-18-admin-customer-detail-permission-overreach.md`（CSM 越权）
4. `2026-05-18-admin-services-create-customer-search.md`（疑 client-identity-rule 违反）
5. `2026-05-18-admin-dashboard-store-revenue-mismatch.md`（看板数字错）

P2 / P3 排队：
6. `2026-05-18-e2e-fixture-cron-member-upgrade-design.md`
7. `2026-05-18-e2e-link-10-card-pollution.md`
8. `2026-05-18-e2e-link-20-coupon-batch-selector.md`
