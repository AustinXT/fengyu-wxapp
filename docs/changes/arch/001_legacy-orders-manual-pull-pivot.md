---
type: arch
number: "001"
date: 2026-05-19
title: admin /legacy-orders 改为按顾客手动拉取（弃用全量 bulk 导入）
tags: [admin, legacy-orders, workfine, mssql, permissions]
related: []
---

# arch/001 admin /legacy-orders 改为按顾客手动拉取（弃用全量 bulk 导入）

## 背景与动机

2026-05-18 落地的 WorkFine 历史订单工作流采用「一次性 bulk 抓 8 万行进
`sale_orders.status='未审核'`」模式（`db/scripts/import-workfine-legacy.js`），
配合 admin /legacy-orders 列表做人工核对。运行一段时间后发现核心问题：

- **信噪比灾难**：绝大多数 WorkFine 历史顾客永远不会再到店，未审核行变成永久噪音
- **列表性能 & 心智负担**：admin 一打开就是几万行待审核
- **核对节奏失配**：核对天然由「顾客到店」触发，但数据却提前一次性灌进来，多余的等待行只会让店员视而不见

需要把「数据进入 PG 的时机」对齐到「真实业务触发点」。

## 技术选型

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 维持 bulk 全量 + admin 列表筛选 | 一次部署搞定 | 信噪比差、列表臃肿、与到店节奏脱节 | **否决** |
| admin 直连 WorkFine MSSQL，按顾客手动拉取 | 拉取量自动收敛到实际到店量；店员一次对话框内完成「搜→预览→导入」 | admin 新增对 WorkFine 网络依赖 | **采纳** |
| staff 小程序也提供拉取入口 | 店员手机端也能用 | MSSQL 暴露到云函数面增加安全面；店员到店核对场景已有 admin 即可 | 否决 |

**采纳理由**：拉取量随业务自然收敛，且 admin 已是审核唯一入口，把「拉取」和「审核」
放在同一界面工作流连贯（顾客详情页直接「拉历史订单 → 预览 → 导入 → 列表里出现待审核行 → approve」）。

## 数据模型

无 schema 变更。复用 2026-05-18 已落地的 `sale_orders` 列扩展
（`legacy_source` / `legacy_customer_id` / `legacy_raw_snapshot` / `audited_at` / `audited_by`）
和 `orderStatusEnum` 中的 `未审核` / `已作废` 值。

导入 SQL 使用 `ON CONFLICT (sale_order_id) DO NOTHING` 保证幂等，重复点「拉取」不会出错。

## 架构设计

### 新增模块

- **权限 key**：`legacy_order:pull`，授予 admin / manager / customer_mgr / finance
- **MSSQL 客户端**：`fengyu-admin/src/lib/workfine-mssql.ts` — admin Next.js 运行时直连
  WorkFine `47.96.87.33:1433`，只读 + 参数化查询，连接池化
- **三个 Server Actions**（`fengyu-admin/src/actions/legacy-orders.ts`）：
  - `searchWorkfineCustomer({ phone | customerId })` → 候选顾客列表，每行带 `existsInPg`
  - `previewWorkfineOrders({ workfineCustomerId })` → 订单列表，每行带 `alreadyImported` / `storeMatched`
  - `importWorkfineOrdersByCustomer({ workfineCustomerId, selectedOrderNos })` → 批量 INSERT，`ON CONFLICT DO NOTHING`
- **共享组件**：`PullWorkfineDialog` —— 两个挂载点：
  - `/legacy-orders` 顶部按钮（空状态搜索）
  - `/customers/[id]` 详情页按钮（预填 phone）

### 保持不变

- approve / reject / updatePhone / updateAmount 四个 Server Actions 不动，自然继续审核新拉取的行
- 标签重算（customer_status / customer_type / spending_tier / member_level）仍在 approve 时统一触发
- staff 顾客详情 `legacyOrderCount` badge 逻辑不变
- client bindPhone 自动按 phone 回填 `client_user_id` 不变
- dashboard 排除 `未审核` / `已作废` 不变

### 弃用

`db/scripts/import-workfine-legacy.js` 文件头部加 `@deprecated` 注释，代码保留作紧急批量回填 fallback，不再作为主链路。

## 影响范围

- **PG 数据**：上线前 PG 会被全清（见 memory `project_pre_launch_data_wipe.md`），
  所以现存 bulk 残留行无需迁移，新流程从 day-one 起即唯一入口
- **admin 网络拓扑**：admin Docker 容器需能访问 WorkFine `47.96.87.33:1433`
- **权限矩阵**：4 个角色获 `legacy_order:pull` 新 key
- **测试**：8 个新单元测试，1149 个 admin 测试全部通过，`tsc --noEmit` 0 错

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| admin 生产 Docker 到 WorkFine MSSQL 网络不通 | 部署前用 `tcpping 47.96.87.33 1433` 在远端 server 上验证；失败时回退到 bulk 脚本 |
| MSSQL 凭据泄漏 | `MSSQL_USER` / `MSSQL_PASSWORD` 走 admin .env，不入 git；查询全部参数化 |
| 误用 bulk 脚本造成噪音 | 文件头 `@deprecated` 注释 + 后续可加运行时 stderr 警告 |

**回滚**：代码侧 git revert 三个 actions + dialog + permissions diff；数据侧因 `ON CONFLICT DO NOTHING`
导入幂等，删除可用 `DELETE FROM sale_orders WHERE legacy_source='workfine' AND audited_at IS NULL`。

## 相关文件

- `fengyu-admin/src/lib/workfine-mssql.ts` — 新增 admin 端 MSSQL 客户端
- `fengyu-admin/src/actions/legacy-orders.ts` — 新增 3 个 actions（约 463 / 520 / 569 行起）
- `fengyu-admin/src/lib/permissions.ts` — 4 个角色加 `legacy_order:pull`
- `fengyu-admin/src/app/(main)/legacy-orders/` — 顶部按钮挂载点
- `fengyu-admin/src/app/(main)/customers/[id]/` — 详情页按钮挂载点
- `db/scripts/import-workfine-legacy.js` — 文件头加 `@deprecated`

## 相关变更记录

- memory `project_legacy_orders_workflow.md` — 工作流规范（2026-05-19 同步更新为 manual-pull 版）
- memory `project_pre_launch_data_wipe.md` — 解释为何无需迁移 bulk 残留行
- memory `reference_workfine_mssql.md` — WorkFine 只读连接信息
