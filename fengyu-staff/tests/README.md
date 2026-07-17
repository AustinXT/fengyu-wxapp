# fengyu-staff 端测试总览

员工端小程序的自动化测试入口。三层金字塔：

| 层 | 路径 | 工具 | 速度 | 用途 |
|----|------|------|------|------|
| **L1 unit** | `cloudfunctions/staffApi/__tests__/` | Vitest + mocks | 毫秒级 | 单元逻辑/工具函数/中间件 |
| **L2 cloudfn smoke** | `tests/e2e-cloudfn/` | bun + 真实 PG + 本地 require | 秒级 (8s/smoke) | action 路由 × 状态分支 |
| **L3 miniprogram smoke** | `tests/e2e-miniprogram/` | miniprogram-automator + 微信 IDE | 10s+/smoke | 前端 + 云函数 + PG 全链路 |

---

## L1 unit（Vitest）

```bash
cd fengyu-staff/cloudfunctions/staffApi
npm test                  # 全套
npm run test:watch        # watch 模式
npm run test -- routes/order.test.js  # 单文件
```

详见 `cloudfunctions/staffApi/CLAUDE.md`。

---

## L2 cloudfn smoke（推荐日常开发使用）

覆盖 staffApi 全部 module × 状态分支 × 角色/范围矩阵。改一行代码 10 秒看结果。

四类用例（按文件名前缀过滤）：

| 类别 | 数量 | 重点 | filter 关键字 |
|------|------|------|---------------|
| 业务功能 smoke | 36 | 单 action × 状态分支（store-level manager 视角） | order, service, alloc, customer, card, appointment, staff, store, product, auth, coupon, confirm |
| **rbac 准入矩阵** | 4 文件 / 59 case | 7 种角色 × 3 种 scope（HQ/市场/门店）合法配对 + 多绑定归并 | `rbac` |
| **deny 越权拒绝** | 3 文件 / 12 case | 跨店/跨市场/越级 mgmt-* / 部门 scope 拒绝路径 | `deny` |
| **mgmt 三视角** | 4 文件 / 29 case | mgmtDashboard/Customer/Product/Traffic 在 all/market/store 三种 scope 下的可见性 + 跨范围拒绝 | `mgmt` |
| **xend 跨端链** | 3 文件 / 12 case | staff confirmOffline → client card.history、refund 审批 → client 可见、同单 4 视角 | `xend` |

> 2026-05-28 补强（共 8 个文件改动 / 1 个新 smoke + 7 处既有 smoke 末尾追加）：新增
> `smoke-order-refund-list-detail.mjs`（refundList/refundDetail + 老 saleOrderId 兼容 + 跨店 deny），
> 既有 7 处末尾追加：`smoke-staff-departments`(+skillTags) /
> `smoke-service-lifecycle`(+service.list/counts/detail) /
> `smoke-customer-detail`(+customer.appointments/phoneChangeLogs) /
> `smoke-order-refund`(+customer.refundHistory) /
> `smoke-alloc-suggest`(+allocation.pendingList/rates) /
> `smoke-service-commission`(+serviceCommission.pendingList/detail) /
> `smoke-mgmt-dashboard`(+mgmtDashboard.salesData × 3 scope) /
> `smoke-appointment-confirm`(+appointment.list/detail)。详见 RUN-REPORT-2026-05-28.md。

```bash
# 全套
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs

# 分组跑（迭代时省时间）
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter rbac
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter deny,mgmt
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter xend
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter order

# 单个
bun fengyu-staff/tests/e2e-cloudfn/smoke-rbac-store-level.mjs

# 清理残留命名空间
bun fengyu-staff/tests/e2e-cloudfn/cleanup.mjs
```

详见 `tests/e2e-cloudfn/README.md`。

---

## L3 miniprogram smoke（覆盖 UI 链路）

8 个 smoke 覆盖员工端关键用户流程。需要先在微信开发者工具装载 staff 项目。

```bash
# 一次性配置：IDE 装载 staff 项目（需 quit 后 cli auto）
/Applications/wechatwebdevtools.app/Contents/MacOS/cli quit
pkill -9 -f wechatwebdevtools && sleep 5
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram --port 9420
until lsof -nP -iTCP:9420 -sTCP:LISTEN | grep -q IPv6; do sleep 3; done

# 全套
bun fengyu-staff/tests/e2e-miniprogram/run-all.mjs

# 单个
bun fengyu-staff/tests/e2e-miniprogram/smoke-staff-confirm-offline.mjs
```

详见 `tests/e2e-miniprogram/README.md`。

---

## 命名空间隔离（重要）

每层用独立的命名空间前缀，互不污染：

| 层 | 命名空间 | 测试手机号 |
|----|----------|------------|
| L2 | `TE2L2_*` | 19999099001 / 19999099002 |
| L3 | `TEST_E2E_L3_*` | 见 `helpers/constants.mjs` |

两层共享同一个生产业务库 `5433/fengyu_wxapp`。L2 cleanup / L3 cleanup 都用 LIKE 前缀精确匹配，**绝不**触及生产数据。

---

## 已知生产 bug（被 e2e 守住）

- `staffApi/routes/service.js:207` — service.create INSERT service_items 引用不存在的 `sku_id` 列。
  → smoke-service-create / smoke-service-lifecycle FAIL；删除该列引用 + 对应 $5 参数后 PASS。
- `staffApi/routes/service.js:439` — service.complete `ON CONFLICT ON CONSTRAINT uq_svc_comm_item_emp_role`。
  该名是 partial unique INDEX 非真正 CONSTRAINT，PG 不接受此语法。
  → 改为 `ON CONFLICT (service_item_id, employee_id, role_type) WHERE is_void = false DO NOTHING`。

---

## 跨子项目说明

- `tests/e2e-cloudfn/` (repo 根) — 留 payNotify (client 域) + recordPayment (admin 域) smoke
- `tests/e2e-miniprogram/` (repo 根) — 留 client home smoke
- `fengyu-client/tests/` — client 端单独 e2e（独立维护）
- `fengyu-admin/tests/e2e-chains/` — admin 跨页业务链路 Playwright 测试（link-1~23）

各子项目的 e2e 测试在该项目自己的目录下；不集中放 root `tests/`。
