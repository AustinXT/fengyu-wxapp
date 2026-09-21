---
type: arch
number: "013"
date: 2026-09-21
title: 服务单服务人员候选放开到「本店 ∪ 门店所属市场出差支援」，并给 staff.list 引入 scene 参数
tags: [staff, admin, picker, skills, service, org]
related: ["005"]
---

# arch/013 服务单服务人员候选放开到「本店 ∪ 门店所属市场出差支援」

## 背景与动机

2026-09-05 需求沟通会（`notes/meetings/meeting-20260905/summary.md` 第 14 行「服务单人员」）：

> 出差的美容师/养生师/品项老师/店长都能选，本店人员置顶（配合店长检查营业额分配）

痛点（`article.md` §六）：上次改版后出差人员只出现在**营业额分配**那边，**服务单这边反而不展示**；
员工开服务单选美容师时误以为选了就等于完成营业额分配，店长每天要逐一核对。

改前口径（arch/005 固化）：三个入口（开单 / 顾客端下单 / 服务单）共用一份
`skills && ARRAY['美容师','养生师']` + `store_id = 本店` 的候选过滤。

## 技术选型

### 决策 1：给 `staff.list` 加 `scene` 参数（**推翻 arch/005 的选型结论**）

arch/005 曾明确拒绝该方案：「给 `staff.list` 加过滤参数区分调用方 —— 改动更大、打破现有单源一致性」。
当时三个入口的业务口径**确实相同**，单源是对的。本次业务把它们**拆开**了：服务单要放宽，
开单与顾客端明确维持原样（issue #210 验收标准第 7、8 条）。口径既已分叉，
继续共用一条 SQL 就会把开单和顾客端一并放开，属于需求外的副作用。

| 方案 | 取舍 |
|---|---|
| **给 `staff.list` 加 `scene` 分支（选用）** | 默认分支 SQL **字面不动**，另外 4 个调用方（开单 / 顾客列表 / 顾客详情 / 员工绩效）零风险 |
| 继续单源、一处放开 | 会连带放开开单与顾客端，违反验收标准 |
| 新开 `staff.serviceCandidates` 路由 | 语义更干净，但要在小程序端再接一条链路；`scene` 分支已足够且改面更小 |

arch/005 的适用范围因此收窄为「开单 + 顾客端下单」，服务单一路以本文为准。

### 决策 2：admin 侧从「客户端过滤全量员工档案」改为「目标门店级候选 Server Action」

改前：`services/create/page.tsx` 预取 `getEmployees()` 全量员工传给客户端，
由 `order-service-staff.ts` 在浏览器里过滤。新口径下该方案有两个硬伤：

1. 员工档案的 `marketName` 派生自「门店 → 市场」，`store_id` 为空的直挂节点员工（各市场养生部、
   品项公司）恒为 `null`，**锚不到市场**；
2. `getEmployees()` 走 `employeeScopeCondition`，门店级账号**看不到**市场内别店员工，候选恒空。

改为新增 `getServiceStaffCandidates(targetStoreId)`，与既有 `getAllocationEmployeeCandidates`
同范式（目标门店级、最小字段、不外泄档案 PII）。顺带把手机号/身份证从客户端 bundle 里摘掉了。

`order-service-staff.ts` 与其测试**原样保留**——它仍被开单页使用，口径不变。

### 决策 3：技能白名单参数化，不就地放宽

`employee-assignment` 的技能白名单由硬编码 `ARRAY['美容师','养生师']` 改为入参，
默认值**跟着场景走**：`marketSupport`（服务单）默认四项，其余默认两项。
避免「传了 marketSupport 却忘了传 skills」静默退回两项，造成前端选得到、提交被拒。

## 架构设计

### 候选口径

```
候选 = 本店在职员工
     ∪ (锚定市场 = 开单门店所属市场 ∧ is_on_business_trip = true ∧ 在职)
技能 ∈ ['店经理', '美容师', '养生师', '品项老师']（数组顺序即排序优先级）
排序 = 本店整体置顶 → 块内按白名单下标（array_position 取最小）→ 姓名 → 工号
```

**锚定市场**：`store_id` 非空取门店父级市场节点；为空（直挂市场/部门节点）沿 `org_nodes.parent_id`
向上取最近 `type='市场'` 节点。复用营业额分配候选已有的同款 SQL 片段。

### 指派资格第三态

`employee-assignment` 的 `assignmentScope` 从两态扩为三态：

| scope | 条件 | 用途 |
|---|---|---|
| `localOnly`（默认） | `store_id = 本店` | 开单等普通指派 |
| `allocationSupport` | `store_id = 本店 OR is_on_business_trip`（无市场限制） | 营业额 / 服务提成分配 |
| `marketSupport`（新增） | `store_id = 本店 OR (is_on_business_trip AND 锚定市场 = 目标门店市场)` | 服务单创建 |

候选查询与校验查询的 WHERE **严格等价**，否则会出现「前端选得到、提交被拒」或反向绕过。

### 目标门店市场 JOIN 用 LEFT 而非 INNER

既有 3 份分配候选副本用的是 `JOIN stores target_store`。本次新代码改用 LEFT JOIN：
`stores.org_node_id` 在 schema 上可空（`db/migrations/0009` 的触发器强制非空，但 schema 层无约束），
一旦目标门店没挂组织节点，INNER JOIN 会让整条查询返回 0 行 ——
候选空事小，**校验侧会把本店员工也判成非法**，该门店服务单直接开不出来。
LEFT JOIN 则 `target_market.id` 为 NULL、出差分支自然不成立，本店分支照常放行（优雅降级）。

### 跨端副本与守护

锚定市场 SQL 现有 **5 份**独立副本（禁提取 shared，用户已 veto）：

| 副本 | 用途 |
|---|---|
| `staffApi/utils/employee-assignment.js` | 服务单候选与校验（本次新增，导出片段给 `routes/staff.js` 复用） |
| `staffApi/routes/allocation.js` | 营业额分配候选 |
| `staffApi/routes/serviceCommission.js` | 服务提成候选 |
| `fengyu-admin/src/lib/employee-anchor-market-sql.ts` | admin 单源（本次新增） |
| `fengyu-admin/src/actions/employees.ts` | 分配候选内联副本 |

新增 `staffApi/__tests__/routes/anchor-market-sql-snapshot.test.js` 守护：
锚定 CASE 表达式五端字节同义（别名归一后比对）+ 技能白名单三份副本同序
（含小程序 `SERVICE_ROLES`）+ `staff.list` 默认分支内联字面量与 `DEFAULT_ASSIGNABLE_SKILLS` 一致
+ 目标门店 JOIN 必须全程 LEFT + 开单/顾客端口径不被波及。

## 相关文件

**staff**
- `cloudfunctions/staffApi/utils/employee-assignment.js` — 第三态 scope + 技能白名单参数化 + SQL 片段导出
- `cloudfunctions/staffApi/routes/staff.js` — `list()` 新增 `scene='service'` 分支（默认分支字面不动）
- `cloudfunctions/staffApi/routes/service.js` — `create` 校验改用 `marketSupport`
- `miniprogram/packageService/service-create/service-create.ts` — 传 `scene`、四项角色标签、外援标签读 `assignmentScope`、picker 改用 `e.detail.index`

**admin**
- `src/lib/employee-anchor-market-sql.ts`（新）— 锚定市场 SQL 片段 + 两份技能白名单常量
- `src/lib/service-staff-candidate.ts`（新）— 服务人员 picker 文案（纯 TS，不引 drizzle，供客户端组件用）
- `src/lib/employee-assignment-server.ts` — 第三态 scope + 白名单入参
- `src/actions/employees.ts` — 新增 `getServiceStaffCandidates`
- `src/actions/services.ts` — `createServiceOrder` 校验改用 `marketSupport`
- `src/app/(main)/(operations)/services/create/page.tsx` + `_components/service-create-page.tsx` — 候选改异步加载

db 无 schema 变更。

## 已知边界（实现时确认，非缺陷）

1. **品项老师按本口径仍选不到**：21 人全部挂「品项公司」（`type='市场'`、父节点为品牌总部，
   与「南昌凤御」等业务市场**并列**），锚定市场永不等于任何业务门店所属市场。
   用户已知悉并选择先按严格市场口径落地。后续若要放开需业务方先定归属方案。
2. **skills 未打标的员工选不到**：口径按 `skills` 数组判定（arch/005 固化，不按 `position_name`）。
   dev 库实测：`position_name` 含「经理」的在职有门店员工 92 人中 48 人未打「店经理」标签。
   需 HR 在 admin 员工管理补标签，与「未开启出差支援选不到」同属数据侧维护。
3. **外援看不到自己被指派的服务单**：`service.js` 的 list / start / complete / cancel / detail
   均按 `effectiveStoreId` 收口，外援员工在 staff 端查不到该单，需本店人员或店长推进。
   修它要动 5 处 scope 口径并放开员工跨门店可见性，属独立的产品决策，未在本次处理。
