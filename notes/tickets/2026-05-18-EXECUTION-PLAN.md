# 2026-05-18 Ticket 批量实施执行计划（剩余 5 张）

> **状态更新 2026-05-18**：原 8 张 ticket 中 **B1 / B4 / B5 已完整落地**（commits `a982e99` / `d69fe77` / `3ffef69` + `7a35e83` + `fae6cea`），已归档至 `notes/tickets/archives/`。本文档仅编排**剩余 5 张待实施 ticket**。
>
> 用户决策已锁定（§A），可直接按 Wave 顺序通过多 Agent 并行落地。
>
> **触发方式**：
> - 一次性全量：`@notes/tickets/2026-05-18-EXECUTION-PLAN.md` 让我"按 Wave 1 → 2 顺序执行"
> - 分 Wave 单跑：`按 EXECUTION-PLAN §B Wave 1 启动 4 Agent 并行`
> - 单 ticket 跑：`按 EXECUTION-PLAN §B.Wave1.AgentA 落地 B2`

---

## A. 决策锁定表（实施时直接采纳）

| # | 决策 | 选定 | 实施含义 | 关联 ticket |
|---|------|------|---------|------------|
| ~~D1~~ | ~~B4 历史抓取时间窗~~ | ~~A~~ | ~~已完成（commit d69fe77）~~ | ✅ 归档 |
| ~~D2~~ | ~~B4 审核通过 status~~ | ~~A~~ | ~~已完成~~ | ✅ 归档 |
| ~~D3~~ | ~~B4 未审核排除统计~~ | ~~A~~ | ~~已完成~~ | ✅ 归档 |
| ~~D4~~ | ~~B5 寄存单入口~~ | ~~A~~ | ~~已完成（commit 3ffef69 + 7a35e83）~~ | ✅ 归档 |
| ~~D5~~ | ~~B5 寄存单 allocation~~ | ~~A~~ | ~~已完成~~ | ✅ 归档 |
| ~~D6~~ | ~~B1 卡列表 scope~~ | ~~A~~ | ~~已完成（commit a982e99，普查证实无需放开）~~ | ✅ 归档 |
| D8 | B2 历史迁移 | **B** | **不做** PR-3 拆分；仅 PR-1/PR-2/PR-4 | B2 |
| D9 | B9 每人限领 | **B** | **完全不限制**（不补 schema 列） | B9 |
| D11 | B3 硬删除 | **A** | 未使用允许硬删，其它一律软删 | B3 |
| D12 | B6 库存入口 | **A** | manager / admin / finance 三角色可见 | B6 |
| D13 | B10 mapping target | **A** | 允许 NULL，admin 编辑页逐条填 | B10 |

---

## B. Wave 实施编排（剩余 5 张 ticket）

### Wave 1 — 全部剩余 ticket（**4 Agent 并行，约 2.5h**）

无 schema 共享冲突（B10 schema 是新建独立表），可全部并行。

#### Agent A — B2 单次卡拆行（仅写入侧，不动历史）
**Ticket**：`notes/tickets/2026-05-18-single-session-card-quantity-not-split.md`
**Skill**：wx-coding + admin-coding
**Files**：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:283` 后插入"按 quantity 拆 N 行"逻辑
  - 触发条件：`productType === '疗程卡' AND quantity > 1`
  - 拆后：每行 `quantity=1`, `session_count=sku.session_count`, 折扣/优惠券均摊到每行
- `fengyu-admin/src/actions/orders.ts` `createOrder` 同上拆行逻辑
- `fengyu-admin/src/app/(main)/cards/_components/cards-page.tsx:141` 单次卡标签加 `×N` 兜底显示（D8=B 老卡仍合并显示）

**跳过**（D8=B）：PR-3 历史迁移脚本 `db/scripts/split-merged-single-cards.js`

**DoD**：
- 新开"单次卡 ×10" → sale_items COUNT=10（每行 quantity=1 / session_count=1）
- 新开"10次卡 ×2" → sale_items COUNT=2（每行 quantity=1 / session_count=10）
- 老卡（合并行）仍显示 ×N 一行
- `bun fengyu-admin/src/actions/orders.test.ts` 加 3 case

**预计**：1.5h

---

#### Agent B — B3 分类硬删除补齐（停用 UI 已完成）
**Ticket**：`notes/tickets/2026-05-18-product-category-disable-delete.md`
**Skill**：admin-coding
**当前进度**：停用 UI 已存在（`categories-page.tsx:158` updateCategory({isValid:false})）

**剩余 PR**（D11=A 硬删除规则）：
- PR-1.1 列表加 "状态" 列 + "包含已停用 ☐" 筛选器（30 min）
- PR-2 一级分类 productKind 停用：`product-kind-management-dialog.tsx` 扩 `isValid?` 入参 + 切换开关（20 min）
- PR-3 新增 `deleteCategory(categoryId, expectedUpdatedAt)` action（45 min）
  - 校验 `productSkus.categoryId` 无引用
  - 校验 `coupon_templates.applicable_category_ids` 无引用
  - 双校验通过：硬删；任一引用：返回 `INVALID_STATE: 引用未清理...`
- PR-4 商品创建/SKU 下拉过滤 `isValid=true`（15 min）
- 单测 + e2e smoke（30 min）

**DoD**：
- 删除有 SKU 引用 → 拒绝并返回错误码
- 删除无引用 → DB 行物理消失（DELETE 而非 UPDATE）
- 默认列表仅启用项；勾选筛选器后展示全部

**预计**：2.5h

---

#### Agent C — B6 staff "我的"页库存管理占位（路径已修正）
**Ticket**：`notes/tickets/2026-05-18-staff-inventory-management-entry-placeholder.md`
**Skill**：wx-coding
**Files**（**注意路径修正：my → profile**）：
- `fengyu-staff/miniprogram/pages/profile/profile.{ts,wxml}` 加 "库存管理" 菜单项
- 菜单显示条件：`isManager() || isAdmin() || isFinance()`（D12=A）
- 新建 `fengyu-staff/miniprogram/packageMy/inventory/inventory.{ts,wxml,wxss,json}`
- 占位页内容：
  - 标题：库存管理
  - 文案：功能开发中，敬请期待。库存操作目前仍在 WorkFine 桌面端进行。
  - 8 表预览（灰色不可点击）：出货 / 入库 / 调拨申请 / 调拨执行 / 盘点 / 报损 / 报溢 / 期初余额
  - 底部：详细需求请联系管理员

**不动**：admin、不动云函数、不引 mssql

**DoD**：
- staff 我的页可见 "库存管理"（仅 3 角色）
- 点击进入占位页，无报错
- 普通美容师登录看不到该入口

**预计**：1h

---

#### Agent D — B9 优惠券绑定限制 bug
**Ticket**：`notes/tickets/2026-05-18-coupon-binding-restriction-not-enforced.md`
**Skill**：admin-coding（三端 coupon）
**Steps**：
1. **跳过 C7（同模板每人限领 N 张）**（D9=B 完全不限制）
2. 跑 `cd fengyu-admin && bun run test src/actions/coupons.test.ts` 输出 FAIL 列表
3. 按 FAIL 定位 C1-C6 / C8-C10 中具体哪几项失效
4. 修复对应 action：
   - admin: `fengyu-admin/src/actions/coupons.ts` issueCoupon
   - client: `fengyu-client/cloudfunctions/clientApi/routes/coupon.js`
5. 加 vitest + e2e case，确认 FAIL 转 PASS
6. cron 派发路径无需特殊 bypass（D10 自动消解）

**DoD**：
- 测试套件 PASS（原 FAIL case 现 PASS）
- 违反 Cx 限制 → 拒绝并返回错误码 `INVALID_STATE: COUPON_BINDING_<X>: ...`

**预计**：2h（含 Step 1 定位时长）

---

#### Agent E — B10 PR-1 + PR-2 映射表 schema + admin 上传页
**Ticket**：`notes/tickets/2026-05-18-product-mapping-table-intake.md`
**Skill**：admin-coding + db
**Files**：
- **PR-1 schema**：
  - 新建 `db/schema/legacy-product-mapping.ts`（按 ticket §2.1 设计）
  - `db/schema/index.ts` 导出
  - `npm run db:generate` → 临时 docker PG 验证 → 5434 `db:migrate`
- **PR-2 admin 上传页**：
  - 新建 `fengyu-admin/src/app/(main)/legacy-product-mapping/page.tsx` CSV 上传 + 预览 + 入库
  - 新建 `fengyu-admin/src/actions/legacy-product-mapping.ts`：`uploadMappingCsv` / `listMappings` / `updateMapping` / `deleteMapping`
  - D13=A：允许 target NULL，预览页只警告（不拒绝）；非法 `target_category_id`（不存在）标红
- 权限：`legacy_product_mapping:read` / `:write`

**跳过**：PR-3 diff 脚本（等业务方 CSV 到位再做）+ PR-4 spec/memory 更新（实施后再补）

**DoD**：
- legacy_product_mapping 表在 5434 落地
- admin /legacy-product-mapping 可上传 CSV → 预览 → 入库
- 测试上传 10 行（含 5 行 target NULL + 5 行有效）→ 全部入库，预览页警告 5 行待映射

**预计**：2.5h

---

### 并行策略汇总（更新）

| Wave | Agent | 串行/并行 | 预计 | 阻塞点 |
|------|-------|----------|------|-------|
| 1 | A/B/C/D/E | **5 并行** | 2.5h（最长 Agent B 与 E） | 无（B10 schema 是独立新表，无冲突）|
| **总** | | | **2.5h** | |

> 与原计划对比：原 3 Wave 总 8h → 现 1 Wave 总 2.5h（68% 缩减，因 B1/B4/B5 已完成）。

---

## C. 归档钩子（每张 ticket 完成后强制执行）

实施 Agent 在 PR 全部 commit 完成后**必须**执行下面 3 步，不要交回主对话。

### C.1 ticket 文件追加"完成记录"

在 `notes/tickets/2026-05-18-<name>.md` 末尾追加：

```markdown
---

## 完成记录

- 完成日期：YYYY-MM-DD
- 完成 commit：abc1234, def5678, ...
- 实际落地清单：
  - <文件路径>（行数）— 说明
- DoD 逐项核对：
  - [x] PR-1 ...
  - [⚠️] PR-3 ...（实际偏差：xxx）
- 决策应用：D? = ?
- 关联同批 ticket：notes/tickets/archives/2026-05-18-*.md
```

### C.2 移动到 archives/

```bash
git mv notes/tickets/2026-05-18-<name>.md notes/tickets/archives/
```

### C.3 commit 描述声明

```
commit 信息末尾追加：

归档 ticket: notes/tickets/archives/2026-05-18-<name>.md
```

参考归档范式：`notes/tickets/archives/2026-05-18-workfine-legacy-orders-unaudited-flow.md` 末尾的"完成记录"小节。

---

## D. 端到端验证（Wave 完成后）

### D.1 类型检查（3 终端并行）
```bash
cd fengyu-admin && npx tsc --noEmit
cd fengyu-staff/miniprogram && npx tsc --noEmit
cd fengyu-client/miniprogram && npx tsc --noEmit
```

### D.2 单元测试
```bash
cd fengyu-admin && bun run test
```

### D.3 跨端 snapshot 守卫
```bash
bun fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js
bun fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts
bun fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js
```

### D.4 admin server-action smoke
```bash
bun fengyu-admin/tests/e2e-actions/cleanup.mjs
# B9 修复后跑现有 coupon 测试
bun run test src/actions/coupons.test.ts
```

### D.5 手动 smoke
- **B2**：staff 开 1 单 "单次卡 ×10" → cards 列表 10 行（老卡仍 ×N 一行）
- **B3**：删除有 SKU 引用的分类 → 拒绝；删除无引用 → 物理消失
- **B6**：以美容师角色登录 staff → 我的页**看不到** "库存管理"；切换到店长 → 可见
- **B9**：触发某条 Cx 限制 → 拒绝并返回错误码
- **B10**：admin 上传含 NULL target 的 CSV → 预览页警告但允许入库

---

## E. ticket 来源映射（便于 Agent 反查）

| Ticket ID | 状态 | 文件路径 |
|-----------|------|---------|
| B1 | ✅ 已归档 | `notes/tickets/archives/2026-05-18-treatment-card-listing-filter-audit.md` |
| B2 | ❌ 待实施 | `notes/tickets/2026-05-18-single-session-card-quantity-not-split.md` |
| B3 | 🟡 部分完成（停用 UI 已有，缺硬删除/筛选器/下拉过滤）| `notes/tickets/2026-05-18-product-category-disable-delete.md` |
| B4 | ✅ 已归档 | `notes/tickets/archives/2026-05-18-workfine-legacy-orders-unaudited-flow.md` |
| B5 | ✅ 已归档 | `notes/tickets/archives/2026-05-18-sale-order-type-deposit-add.md` |
| B6 | ❌ 待实施（路径已修正 my → profile）| `notes/tickets/2026-05-18-staff-inventory-management-entry-placeholder.md` |
| B9 | ❌ 待实施 | `notes/tickets/2026-05-18-coupon-binding-restriction-not-enforced.md` |
| B10 | ❌ 待实施（仅 PR-1/PR-2，PR-3 等业务方 CSV）| `notes/tickets/2026-05-18-product-mapping-table-intake.md` |

---

## F. 启动命令模板

### 一次性启动 Wave 1（推荐）
```
按 @notes/tickets/2026-05-18-EXECUTION-PLAN.md §B Wave 1 启动 5 Agent 并行（B2 + B3 + B6 + B9 + B10）。
每个 Agent 完成后自动执行 §C 归档钩子（C.1 追加完成记录 + C.2 git mv + C.3 commit 标注）。
全部完成后跑 §D 验证。
```

### 单 Agent 启动
```
按 EXECUTION-PLAN §B.Wave1.AgentA 落地 B2
按 EXECUTION-PLAN §B.Wave1.AgentB 落地 B3 剩余部分
按 EXECUTION-PLAN §B.Wave1.AgentC 落地 B6
按 EXECUTION-PLAN §B.Wave1.AgentD 落地 B9
按 EXECUTION-PLAN §B.Wave1.AgentE 落地 B10
```

### 仅验证
```
按 EXECUTION-PLAN §D 跑端到端验证
```

---

## G. 关联

| 项 | 说明 |
|----|------|
| 来源 plan | `/Users/nv/.claude/plans/ticket-batch-tickets-binary-globe.md` |
| 来源会议 | `notes/meetings/meeting-20260507/` + `notes/meetings/meeting-20260423/` |
| 来源决策 | 见 §A 决策锁定表 |
| 已完成 commit | `fae6cea` schema 双特性 + `d69fe77` B4 legacy-orders + `3ffef69` + `7a35e83` B5 寄存单 + `a982e99` B1 普查脚本 |
| 反馈 memory | `feedback_decision_with_scenario.md`（让用户拍板时必须配业务场景）|
| 项目铁律 | `feedback_no_legacy_compat.md`（D8=B 依据）/ `feedback_mssql_readonly.md` |
| schema 规约 | `db/CLAUDE.md` — 必走 db:generate + db:migrate |
| 跨端守护 | cross-end-sql-snapshot + cross-end-error-codes-snapshot test |

---

## H. 已归档 ticket 完成记录参考

每张已归档 ticket 末尾都有详细"完成记录"小节，包含 commit SHA + 实际落地清单 + DoD 偏差 + 决策应用，可直接 grep 反查：

```bash
grep -A 30 "## 完成记录" notes/tickets/archives/2026-05-18-treatment-card-listing-filter-audit.md
grep -A 30 "## 完成记录" notes/tickets/archives/2026-05-18-workfine-legacy-orders-unaudited-flow.md
grep -A 30 "## 完成记录" notes/tickets/archives/2026-05-18-sale-order-type-deposit-add.md
```
