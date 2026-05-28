---
name: wx-requirement-adapt
description: |
  用于从业务需求描述出发，追踪相关代码路径，审计当前实现与新需求的差异，
  帮助生成差异报告和修改计划。适用于业务规则调整、概念重定义、流程变更。
  当用户说"规则改了"、"流程调整"、"需求变更"、"概念变了"时使用。
argument-hint: <需求变更描述>
metadata:
  title: 需求变更适配
  description_zh: 业务需求变更的代码路径追踪、差异审计与修改计划
  author: nvoyager
  version: 1.0.0
  license: 42plugin-personal
---

# 需求变更适配

从业务需求描述出发，追踪代码路径，审计差异，生成修改计划。

## 何时使用

- 业务规则调整（如"内部单定价规则改了"）
- 审批/状态流程变更（如"退款增加财务审批环节"）
- 权限模型变更（如"顾客管理员也能开单"）
- 概念重定义（如"售前/售后的判定逻辑变了"）
- 定价/计算逻辑变更（如"提成规则从固定比例改为阶梯"）

## 不适用

- 变更目标是字面字符串（枚举值/字段名）→ `/wx-change-propagation`
- 全新功能开发 → `/wx-implement-feature`
- 仅后端 API 变更 → `/wx-implement-api`

## 与 wx-change-propagation 的协作

本技能是"思考"技能（What needs to change），`wx-change-propagation` 是"执行"技能（How to propagate）。

```
wx-requirement-adapt 输出修改计划
    ├── 结构性变更项（枚举/字段/表）→ 交接给 /wx-change-propagation
    └── 逻辑变更项 → 本技能直接指导执行
```

---

## 1 需求分解

从用户描述中提取以下要素：

| 要素 | 说明 | 示例 |
|------|------|------|
| **变更概念** | 哪个业务概念在变 | 退款审批流程 |
| **当前行为** | 系统现在怎么做的 | 店长创建退款单 → 状态=待审批 → 店长审批 |
| **期望行为** | 变更后应该怎么做 | 增加财务审批环节 |
| **受影响角色** | 哪些角色受影响 | manager, finance |
| **受影响端** | 哪些应用端受影响 | staff, admin |

---

## 2 概念→代码位置映射表

根据变更概念，快速定位需要审计的代码入口：

| 业务概念 | 主要代码位置 |
|---------|-------------|
| **订单创建/支付** | `staffApi/routes/order.js` (create, confirmOffline), `clientApi/routes/order.js` (create, pay), `fengyu-admin/src/actions/orders.ts` |
| **退款流程** | `staffApi/routes/order.js` (createRefund, approveRefund, rejectRefund) |
| **回款/转换** | `staffApi/routes/order.js` (createRepayment, createConversion) |
| **提成计算** | `staffApi/routes/allocation.js`, `fengyu-admin/src/actions/allocations.ts`, `db/schema/commission.ts` |
| **权限模型** | `fengyu-admin/src/lib/permissions.ts` (PERMISSION_MATRIX), `fengyu-admin/src/lib/menu.ts`, `staffApi/middleware/auth.js` (requirePosition) |
| **服务单流程** | `staffApi/routes/service.js` (create, start, complete, cancel), `fengyu-admin/src/actions/services.ts` |
| **预约流程** | `clientApi/routes/appointment.js`, `staffApi/routes/appointment.js`, `fengyu-admin/src/actions/appointments.ts` |
| **商品管理** | `fengyu-admin/src/actions/products.ts`, `db/schema/product.ts`, `db/schema/enums.ts` (productKindEnum, productTypeEnum) |
| **顾客分类** | `db/schema/enums.ts` (customerTypeEnum, spendingTierEnum, monthlyActivityEnum), `fengyu-admin/src/actions/customers.ts` |
| **会员等级** | `db/schema/enums.ts` (memberLevelEnum), `fengyu-admin/src/actions/customers.ts`, `clientApi/routes/points.js` |
| **优惠券** | `fengyu-admin/src/actions/coupons.ts`, `clientApi/routes/coupon.js`, `staffApi/routes/coupon.js` |
| **门店解绑** | `clientApi/routes/store.js`, `staffApi/routes/store.js`, `fengyu-admin/src/actions/store-unbind.ts` |
| **数据看板** | `staffApi/routes/staff.js` (dashboard), `fengyu-admin/src/actions/dashboard.ts` |

---

## 3 代码路径追踪

对每个受影响的业务概念，按三层追踪：

### 3.1 数据库层

- 相关表和列？（读 `db/schema/*.ts`）
- 涉及哪些枚举？值是否需要变更？
- 是否需要新增/修改约束？
- 现有数据是否需要迁移？

### 3.2 后端逻辑层

- 云函数路由中的业务判断（if/switch on 枚举值、状态检查）
- SQL 查询中的 WHERE 条件
- Admin Server Actions 中的验证逻辑
- 权限检查（requirePosition、PERMISSION_MATRIX）

### 3.3 前端渲染层

- WXML/TSX 中的条件渲染（状态标签、按钮显隐）
- 下拉选项/Radio 选项的数据源
- formatters/format.ts 中的标签映射
- 页面数据绑定和交互逻辑

### 3.4 横切关注点检查清单

每次追踪完三层后，逐项确认：

- [ ] **权限检查**：新行为是否需要新的角色/权限？
- [ ] **审计日志**：`logOperation()` 是否需要记录新操作？
- [ ] **数据完整性**：FK 约束、唯一性约束是否受影响？
- [ ] **WorkFine 同步**：`db/scripts/sync-*.js` 是否需要调整映射？
- [ ] **seed 测试数据**：`fengyu-admin/src/db/seed.ts` 是否需要更新？
- [ ] **现有数据迁移**：生产环境的存量数据是否需要处理？

---

## 4 差异报告

**执行任何代码修改前，必须先输出差异报告。**

格式模板：

```markdown
## 差异报告: [变更标题]

### 当前行为
1. [步骤描述]（代码位置: file:line）
2. ...

### 期望行为
1. [步骤描述]
2. ...

### 差异分析

| 维度 | 当前 | 期望 | 影响范围 |
|------|------|------|---------|
| [维度名] | [现状] | [目标] | [受影响层/文件] |

### 修改计划（按执行顺序）

1. **[结构性变更]** → 交接给 /wx-change-propagation
   - [具体描述]

2. **[逻辑变更]** 直接执行
   - 文件: [path]
   - 改动: [描述]

3. ...

### 风险点
- [潜在风险和缓解措施]
```

---

## 5 常见变更模式

### 5.1 状态机扩展

当需要增加状态或转换路径时：

1. 识别相关状态枚举（`db/schema/enums.ts`）
2. 绘制当前状态转换图
3. 设计新的状态转换图
4. 搜索所有 `WHERE status = 'x'` 和 `status === 'x'` 的条件
5. 枚举值变更 → 交接 `/wx-change-propagation`
6. 转换逻辑变更 → 直接修改

### 5.2 权限模型变更

1. 检查 `fengyu-admin/src/lib/permissions.ts` 中的 `PERMISSION_MATRIX`
2. 检查 `fengyu-admin/src/lib/menu.ts` 中的菜单可见性
3. 检查云函数中间件 `requirePosition` / `requirePhone`
4. 检查前端 `isManager()` / `roles.includes()` 条件判断
5. 更新 E2E 测试中的权限断言

### 5.3 计算逻辑变更

1. 追踪触发点（如订单支付完成 → 触发提成计算）
2. 追踪计算管道（读取 commission_rate_matrix → 按规则计算 → 写入 sale_allocations）
3. 检查上下游：输入数据源是否变化？输出消费方是否受影响？
4. 检查看板/报表是否引用了计算结果

### 5.4 概念拆分/合并

当一个业务概念拆分为多个（或多个合并为一个）时：

1. 列举所有涉及的枚举变更 → 批量交接 `/wx-change-propagation`
2. 列举所有涉及的字段变更 → 批量交接 `/wx-change-propagation`
3. 列举逻辑分支变更 → 本技能直接处理
4. 验证拆分/合并后的数据完整性

---

## 6 边界

**Will**：
- 追踪代码路径，理解当前实现
- 生成差异报告和修改计划
- 识别结构性变更并交接给 `/wx-change-propagation`
- 直接指导逻辑变更的实现

**Won't**：
- 跳过差异报告直接改代码
- 擅自修改 `.42cog/cog.md` 或 `real.md`（全局约束需单独审慎处理）
- 替代用户做业务决策（遇到歧义必须澄清）

---

## 示例

```bash
/wx-requirement-adapt 退款流程增加财务审批环节
/wx-requirement-adapt 内部单定价规则从统一半价改为按提成矩阵走
/wx-requirement-adapt 售前/售后的判定逻辑改为按顾客类型自动判定
```

以"退款流程增加财务审批"为例，skill 会追踪 `staffApi/routes/order.js` 中的 createRefund/approveRefund 代码路径，生成当前 vs 期望行为的差异报告，识别出需要扩展 `order_status` 枚举并交接给 `/wx-change-propagation`。
