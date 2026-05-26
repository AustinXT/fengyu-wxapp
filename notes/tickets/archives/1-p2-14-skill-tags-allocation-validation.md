# Ticket: P2-14 skillTags 驱动的业绩分配校验重写

> ⚠️ 2026-04-25 后置：本 ticket 多处提到「保留旧 4 值 `[自采自销, 他销自耗, 他销他耗, 生态合作]` 不变」，
> 该决议已于 2026-04-25 翻新（`自采自销` → `自销自耗`，详见 `00-decisions.md` #2）。
> mass replace 后本文件中"保留旧 4 值 [自销自耗, ...]" 等描述失真，仅保留作为历史记录。
> 当前生效 enum：`[自销自耗, 他销自耗, 他销他耗, 生态合作]`。

> 生成日期：2026-04-10
> 关联决策：`notes/adapt-plans/00-decisions.md` §2 Q5
> 关联适配计划：`notes/adapt-plans/03-staff-commission.md` §2.2/§2.4 / §4 Phase 2.2-2.4 / Phase 3.1-3.2 / Phase 4.1
> 严重级别：P2（非线上 Bug，功能性重构；影响提成结算正确性）
> 修复归属：拆 3 个 PR 上线（cloudfn → admin → miniprogram），共享一个 feature 分支

---

## 0 一句话背景

业务方在 2026-04-10 权威决策（`00-decisions.md` Q5）：**业绩分配校验改为按 `staff_wechat_users.skills` 中的"有效技能标签"独立建池校验**，三角色（美容师/养生师/推广师）互不约束；废除从部门名（美容部/养生部/推广部）反推角色的映射。无结构性变更，全部为算法层重写。

与 `03-staff-commission.md` 原 Phase 2.2 的差异：**`salesCategoryEnum` 换值被 00-decisions §1 取消**，本 ticket 保留旧 4 值 `[自销自耗, 他销自耗, 他销他耗, 生态合作]` 不变；原 Phase 1.x 的 DB 结构性变更（service_fee 快照 / service_commissions 扩列 / salesCategoryEnum）本 ticket 不涉及，其中与服务提成相关的部分已由 commit `9a7e832` 完成。

---

## 1 问题定位

### 1.1 后端（staffApi 云函数）

| 位置 | 说明 |
|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:16` | 常量 `DEPT_TO_ROLE = { '美容部':'美容师', '养生部':'养生师', '推广部':'推广师' }` — 依赖部门名，违反 Q5 |
| `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:31-144` | `save`：不校验整十档、不校验每池 ≤3 人、不按角色分池、采信前端 `totalAmount`、INSERT 未写入 `role_type` 列 |
| `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:272-293` | `resolveStaffDepartment` — 通过 `org_nodes.name` 反推角色 |
| `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:310-428` | `suggest` — 只对美容师/养生师（`beautyDepts = ['美容师','养生师']`）输出建议，忽略推广师；依赖 `resolveStaffDepartment` 的部门→角色推断 |
| `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:59-142` | `departments` 返回 members 不含 `skills`，前端无法按技能标签分组 |
| `fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:40-98` | `ctx.auth` 不含 `skills` 字段，前端请求后无法知道当前操作员的技能池 |

### 1.2 管理后台（fengyu-admin）

| 位置 | 说明 |
|---|---|
| `fengyu-admin/src/actions/allocations.ts:156-158` | `getRoleGroup` 把美容师/养生师合并为 `beautician` 组；Q5 要求三角色独立 |
| `fengyu-admin/src/actions/allocations.ts:242-260` | `batchSaveAllocations` 事务内 INSERT 直接 `totalAmount: a.totalAmount`，采信前端；Q5 要求服务端重算 |
| `fengyu-admin/src/actions/service-commissions.ts:64-65` | 同样的 `getRoleGroup` 合并模式 |
| `fengyu-admin/src/app/(main)/allocations/_components/allocation-detail-page.tsx:36-38` | 前端 `getRoleGroup` 合并 UI |
| `fengyu-admin/src/app/(main)/allocations/_components/allocation-detail-page.tsx:418-429` | UI "美容师/养生师" 合并展示 groupSums.beautician |
| `fengyu-admin/src/app/(main)/allocations/_components/service-commission-detail-page.tsx:36-38` / `307`/`478-500` | 服务提成页同样的合并模式 |

### 1.3 员工端小程序

| 位置 | 说明 |
|---|---|
| `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts:239-289` | `onStaffSelected` 通过 `department` 查提成比例并自动填金额；员工按部门名分组 |
| `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts:264` | `const salesCat = item.sales_category \|\| '自销自耗'` — 旧枚举硬编码兜底（保留，因 00-decisions §1 不换枚举） |
| `fengyu-staff/miniprogram/utils/allocation-calc.ts:32` | `const beautyDepts = ['美容部', '养生部']` — 部门名硬编码 |
| `fengyu-staff/miniprogram/app.ts` globalData | 无 `skills` 字段，登录后无法缓存当前用户技能标签 |

---

## 2 Q5 权威规则（复读）

摘自 `00-decisions.md` §2 Q5：

> 1. 从 `staff_wechat_users.skills`（数组）读取每个员工的有效技能标签
> 2. 对每个技能标签分别建立一个"业绩分配池"
> 3. 每个池独立校验 `SUM(池内分配金额) ≤ 商品金额`，池之间不互相约束
> 4. 即：同一商品下，一个员工以"美容师"身份分到的金额和另一个员工以"养生师"身份分到的金额互不干扰
> 5. 技能标签的权威列表由 `staff_wechat_users.skills` 的历史取值决定，不写入枚举
> 6. 选人后角色自动填入：也从 `skills` 字段读取（如员工只有一个技能标签则自动填，多个则让用户选）

**工作定义（本 ticket 内部）**：
- **池（pool）**：`(saleItemId, roleType)` 二元组，`roleType` ∈ `skills` 数组
- **每池容量**：最多 3 人（与 admin 现行 `MAX_PER_GROUP` 对齐）
- **每池金额合计**：`SUM(total_amount) ≤ sale_items.received`（容差 0.02 元，覆盖整十档 × 浮点的舍入）
- **整十档**：`allocationRatio ∈ {0.10, 0.20, ..., 1.00}`（与 admin 现行 `VALID_RATIOS` 对齐）
- **技能标签可选列表**：`['美容师', '养生师', '推广师']`（当前代码硬编码于 `SKILL_TAGS`）。Q5 第 5 条说"由 skills 的历史取值决定，不写入枚举"——本 ticket **保留硬编码**作为短期兜底，长期迁移到"从 `staff_wechat_users.skills` DISTINCT 聚合"不在本 ticket 范围

---

## 3 执行方案

### Phase A — 后端云函数（staffApi）

#### A1. `middleware/auth.js` 注入 `skills`

**文件**：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js`

```diff
     SELECT
       u.employee_id,
       u.phone,
       u.name,
       u.position_name,
       u.store_id,
       u.is_resigned,
+      u.skills,
       s.store_name,
       m.name AS market_name,
       d.name AS department
     FROM staff_wechat_users u
```

`authData` 同步新增：

```diff
     authData = {
       openid: effectiveOpenid,
       phone: user.phone,
       staffWfId: isActive ? user.employee_id : null,
       storeId: isActive ? user.store_id : null,
       roles,
       position: isActive ? user.position_name : null,
       storeName: isActive ? user.store_name : null,
       marketName: isActive ? user.market_name : null,
-      department: isActive ? user.department : null
+      department: isActive ? user.department : null,
+      skills: isActive ? (Array.isArray(user.skills) ? user.skills : []) : []
     }
```

未注册分支也设 `skills: []`。注意 `AUTH_CACHE` 的缓存结构会自动带上新字段，**无需显式失效**——但 CI 若提前部署了含该字段的前端，旧缓存的 `ctx.auth.skills` 会是 `undefined`，下游要做 `\|\| []` 兜底。

#### A2. `routes/allocation.js` 重写 `save`

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/allocation.js`

目标：与 admin `batchSaveAllocations` 对齐所有校验（含 totalAmount 服务端重算），并将 `getRoleGroup` 替换为恒等映射。

新增常量（文件顶部）：

```js
const VALID_RATIOS = new Set(['0.10','0.20','0.30','0.40','0.50','0.60','0.70','0.80','0.90','1.00'])
const MAX_PER_POOL = 3
const AMOUNT_TOLERANCE = 0.02  // 整十档 × 浮点舍入的容差
```

删除 `DEPT_TO_ROLE` 常量（line 16）。

重写 `save` 的主体（约 line 90-144），新增入参 `roleType` 字段必传校验，并做池校验：

```js
// 2a. 加载 sale_items.received 快照（用于服务端重算 totalAmount）
const itemsResult = await pg.query(
  'SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1',
  [saleOrderId]
)
const receivedMap = new Map(itemsResult.map(r => [r.sale_item_id, Number(r.received)]))

// 2b. 校验每行分配并服务端重算金额
const enriched = []
for (const a of allocations) {
  if (!a.saleItemId) throw new Error('INVALID_PARAMS: 分配记录缺少 saleItemId')
  if (!validItemIds.has(a.saleItemId)) {
    throw new Error(`INVALID_PARAMS: saleItemId ${a.saleItemId} 不属于该订单`)
  }
  if (!a.employeeId) throw new Error('INVALID_PARAMS: 分配记录缺少 employeeId')
  if (!a.roleType) throw new Error('INVALID_PARAMS: 分配记录缺少 roleType')

  const ratioStr = Number(a.allocationRatio).toFixed(2)
  if (!VALID_RATIOS.has(ratioStr)) {
    throw new Error('INVALID_PARAMS: allocationRatio 必须为整十百分比（0.10~1.00）')
  }

  const received = receivedMap.get(a.saleItemId) || 0
  // 服务端重算 totalAmount，忽略前端传入值
  const totalAmount = Math.round(received * Number(ratioStr) * 100) / 100
  enriched.push({ ...a, allocationRatio: ratioStr, totalAmount })
}

// 2c. 按 (saleItemId, roleType) 分池校验
const pools = new Map()
for (const a of enriched) {
  const key = `${a.saleItemId}|${a.roleType}`
  if (!pools.has(key)) pools.set(key, [])
  pools.get(key).push(a)
}
for (const [key, pool] of pools) {
  const [saleItemId] = key.split('|')
  if (pool.length > MAX_PER_POOL) {
    throw new Error(`INVALID_PARAMS: 每个商品每个技能标签最多分配 ${MAX_PER_POOL} 人`)
  }
  // 每池金额合计 ≤ received（容差 0.02）
  const received = receivedMap.get(saleItemId) || 0
  const sum = pool.reduce((s, a) => s + a.totalAmount, 0)
  if (sum > received + AMOUNT_TOLERANCE) {
    throw new Error('INVALID_PARAMS: 分配金额合计超过商品金额')
  }
  // 同池不能重复员工
  const empIds = new Set()
  for (const a of pool) {
    if (empIds.has(a.employeeId)) {
      throw new Error('INVALID_PARAMS: 同商品同技能标签不能重复分配同一员工')
    }
    empIds.add(a.employeeId)
  }
}
```

INSERT 改为写入 `role_type` 列（与 admin 对齐）：

```diff
       await client.query(
         `INSERT INTO sale_allocations
-           (sale_item_id, employee_id, department_name, allocation_ratio, total_amount, is_void, created_at, updated_at)
-         VALUES ($1, $2, $3, $4, $5, false, $6, $6)`,
+           (sale_item_id, employee_id, role_type, department_name, allocation_ratio, total_amount, is_void, created_at, updated_at)
+         VALUES ($1, $2, $3, $4, $5, $6, false, $7, $7)`,
         [
-          alloc.saleItemId,
-          alloc.employeeId,
-          alloc.departmentName || null,
-          alloc.allocationRatio != null ? alloc.allocationRatio : 1.0,
-          Number(alloc.totalAmount) || 0,
-          now
+          alloc.saleItemId,
+          alloc.employeeId,
+          alloc.roleType,          // 来自 enriched
+          alloc.departmentName || null,
+          alloc.allocationRatio,
+          alloc.totalAmount,       // 服务端重算值
+          now
         ]
       )
```

#### A3. `routes/allocation.js` 重写 `suggest` 与 `resolveStaff*`

**目标**：从"按部门查角色"改为"按 skills 查角色池"；对每个 (item × 员工 skills) 生成建议行。

- `resolveStaffDepartment(staffWfId)` 改名 `resolveStaffRoles(staffWfId)`，返回 `{ staffWfId, name, skills: string[] }`：

```js
async function resolveStaffRoles(staffWfId) {
  const rows = await pg.query(
    'SELECT employee_id, name, skills FROM staff_wechat_users WHERE employee_id = $1',
    [staffWfId]
  )
  if (rows.length === 0) return null
  const row = rows[0]
  return {
    staffWfId: row.employee_id,
    name: (row.name || '').trim(),
    skills: Array.isArray(row.skills) ? row.skills : []
  }
}
```

- `suggest` 的核心改动：
  1. 删除 `beauticianInfo.resolvedDept` 相关字段，改为 `employeeRoles: string[]`
  2. 删除 `beautyDepts = ['美容师','养生师']` 白名单，改为遍历 `preferredEmployee.skills` 的每个 skill
  3. 对每个 (item × skill) 生成一条 `allocLine`，`roleType` 字段必填，`departmentName` 可选（兼容历史展示，填 `null`）
  4. 硬编码的 `orderRates: { '自销自耗': 0, '他销自耗': 0, '他销他耗': 0, '生态合作': 0 }` **保留不变**（00-decisions §1 取消枚举换值）
  5. 返回值中 `beauticianRequired` 保留（兼容前端），但语义含义改为 `preferredEmployeeRoles.length > 0`

**注意**：`suggest` 只负责"建议值"，不参与服务端校验；因此 `suggest` 不需要实现池校验逻辑。

#### A4. `routes/staff.js` departments 返回 `skills`

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:69-110`

给两条 SQL 都补上 `u.skills`：

```diff
     SELECT
       u.employee_id,
       u.name,
       u.position_name AS position,
+      u.skills,
       d.name AS department
     FROM staff_wechat_users u
```

Map 时：

```diff
     deptMap['美容部'] = beautyRows.map(r => ({
       staffWfId: r.employee_id,
       name: r.name || '',
       position: r.position || '',
-      department: '美容部'
+      department: '美容部',
+      skills: Array.isArray(r.skills) ? r.skills : []
     }))
```

**前向兼容**：返回结构仍按 department 分组，前端重构前可继续工作；重构后前端改为按 skills 重新桶化。

#### A5. `routes/auth.js` login/bindPhone 回传 skills

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/auth.js`

`login` 与 `bindPhone` 的返回体中新增 `skills: string[]`，便于前端 globalData 缓存。具体列需加到现有 SELECT staff_wechat_users 的字段列表中（与 A1 中间件独立，避免依赖 ctx.auth 未初始化的场景）。

---

### Phase B — 管理后台（fengyu-admin）

#### B1. `actions/allocations.ts` 三角色独立池

**文件**：`fengyu-admin/src/actions/allocations.ts:155-158`

```diff
-/** 角色组映射：美容师/养生师为同一组，推广师为独立组 */
-function getRoleGroup(roleType: string): string {
-  return roleType === '推广师' ? 'promoter' : 'beautician'
-}
+/** 技能标签池键：每个 roleType 独立，池间互不约束（00-decisions Q5） */
+function getPoolKey(roleType: string): string {
+  return roleType
+}
```

然后替换 `batchSaveAllocations` 内所有 `getRoleGroup` 调用为 `getPoolKey`；错误文案从"美容师/养生师"合并说法改为"{roleType}"单独提及。

**服务端重算 totalAmount**（关键，防前端篡改）：

`batchSaveAllocations` 内当前 `itemReceivedMap` 已查出 `received`；在校验通过后、事务 INSERT 之前，对每条 `allocations` 重算：

```ts
const enriched = allocations.map((a) => ({
  ...a,
  totalAmount: (Number(itemReceivedMap.get(a.saleItemId) ?? 0) * Number(a.allocationRatio)).toFixed(2),
}))
```

事务内 `.values(enriched.map(...))` 使用 `enriched` 而非原 `allocations`。

新增"每池金额合计 ≤ received（容差 0.02）"校验：

```ts
const received = Number(itemReceivedMap.get(saleItemId) ?? 0)
const sum = group.reduce((s, a) => s + Number(a.totalAmount), 0)
if (sum > received + 0.02) {
  return { success: false, message: `商品 ${saleItemId} 的 ${roleType} 分配金额超过商品金额` }
}
```

#### B2. `actions/service-commissions.ts` 同步

**文件**：`fengyu-admin/src/actions/service-commissions.ts:64-65`

同样将 `getRoleGroup` 改为 `getPoolKey` 恒等；与 `batchSaveAllocations` 保持对称。

#### B3. `allocation-detail-page.tsx` UI 三角色独立展示

**文件**：`fengyu-admin/src/app/(main)/allocations/_components/allocation-detail-page.tsx`

- L36-38 `getRoleGroup` → `getPoolKey`（恒等）
- L300-306 `groupSums` 改为以 `roleType` 为键，不再二选一合并
- L415-434 页脚比例展示从硬编码的两行（beautician / promoter）改为 `Object.entries(groupSums).map(...)`，每个 roleType 一行
- L473-502 `SaveButton` 内的角色组校验同步改为按 `poolKey = roleType` 分组
- 错误文案去掉"美容师/养生师"合并说法

#### B4. `service-commission-detail-page.tsx` 同步

**文件**：`fengyu-admin/src/app/(main)/allocations/_components/service-commission-detail-page.tsx`

改动与 B3 完全镜像（该文件就是 B3 的服务提成版本）。

---

### Phase C — 员工端小程序（fengyu-staff/miniprogram）

#### C1. `app.ts` globalData 新增 skills

```diff
 globalData: {
   ...
   phone: '',
+  skills: [] as string[],
 }
```

登录/bindPhone 回调时把 `res.skills` 写入 `globalData.skills` 并持久化到 localStorage。

#### C2. `revenue-allocation.ts` 按 skills 分组

**文件**：`fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts`

关键改动：

1. `AllocLine` 新增必填字段 `roleType: string`
2. `PickerGroup` 改为以 `skillTag: string` 分组（从后端新字段 `members[].skills` 展开：一个员工有 N 个 skills 就出现在 N 组里）
3. `onStaffSelected` 选人后，若目标 item 对应的技能池中该员工 skills 仅一个则自动填 roleType；多个则弹二级选项（复用现有 Vant Picker 做单选）
4. L264 硬编码 `'自销自耗'` **保留不变**（00-decisions §1 未换枚举）
5. 前端 **保留** `lookupRate` 作为"参考提成比例"显示用途（不参与校验），但金额字段改为由 `received × allocationRatio` 本地计算，不再等于 `received × commissionRate`
6. 选人后呈现三个 UI 元素：选技能标签（预填）→ 选整十档分配比例 → 显示重算金额（只读）
7. 保存前本地按 `(saleItemId, roleType)` 分池校验，每池 ≤3 人、金额合计 ≤ received（与后端完全一致）
8. 提交 payload 每条 allocation 带上 `roleType` 字段

**注意**：会议要求的"整十档选比例代替自动填金额"是 Phase 4.1 的重大交互重写。本 ticket 的最小可行实现是：**在后端加上整十档 + 池校验之后，前端临时继续采用现有交互（自动填 `received × commissionRate`），同时向 payload 注入 roleType 字段（从 skills 自动推断）**，以保证 cloudfn 校验不因前端未重构而批量拒绝请求。交互层重写拆成独立 ticket 跟进（见 §6 后续跟进）。

#### C3. `utils/allocation-calc.ts`

- 保留 `lookupRate` 与 `computeSummary` 的参考用途
- `lookupRate` 第 32 行的 `beautyDepts = ['美容部', '养生部']` 改为**空数组**（未来前端按 skills 后这里就成了死代码）；或直接删除该 branch

---

## 4 数据与部署前置

### 4.1 DB 脏数据预检

上线前执行（5434/fengyu 与 5433/fengyu_wxapp 两库都要）：

```sql
-- 1. 没有 skills 的在职员工（应为 0，否则分配页选人后无角色可填）
SELECT employee_id, name, position_name, store_id, skills
FROM staff_wechat_users
WHERE is_resigned = false
  AND (skills IS NULL OR cardinality(skills) = 0);

-- 2. 历史 sale_allocations 中 role_type 为 NULL 的记录（观测性，无需回填）
SELECT COUNT(*) FROM sale_allocations WHERE role_type IS NULL AND is_void = false;

-- 3. 历史分配中 total_amount 与 unit_real_price × ratio 偏差 > 0.02 的记录
SELECT sa.id, sa.sale_item_id, sa.allocation_ratio, sa.total_amount,
       si.received, (si.received * sa.allocation_ratio) AS expected
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
WHERE sa.is_void = false
  AND ABS(sa.total_amount - si.received * sa.allocation_ratio) > 0.02;
```

第 1 条如果非空：提示业务方在 admin `/employees/:id` 补 skills（阻塞 C2 上线）。
第 3 条如果非空：记录数量，不做回填（历史已完成分配不动）。

### 4.2 环境变量

本 ticket 不新增环境变量。`staffApi` 部署走 `tcb fn code update`，**禁止 `--force`**（会重置 `PG_CONNECTION_STRING` / `CLIENT_SECRET`），见 `project_cloudbase_envvar_risk.md`。

### 4.3 部署顺序

三个 PR 必须按以下顺序上线：

1. **PR-1 Phase A（cloudfn）**：先部署 staffApi，新校验对旧前端向后兼容 — 旧前端仍传 `departmentName`，新 cloudfn 若无 `roleType` 抛 `INVALID_PARAMS`。**为兼容窗口**，允许旧 payload：若无 `roleType`，**暂时从 `departmentName` 反推**（`'美容部'→'美容师''养生部'→'养生师''推广部'→'推广师'`）并写入 `operation_logs` 告警；PR-3 上线后下线该兜底。
2. **PR-2 Phase B（admin）**：admin 独立，只需 bun build + docker build + 远程部署
3. **PR-3 Phase C（miniprogram）**：发布小程序新版本，审核通过后上线；兜底的 `departmentName` 反推需要在 PR-3 全量后再发一次 PR-4 删除

---

## 5 单元测试清单

### 5.1 cloudfn 单测

新增文件：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/allocation.test.js`

- `save_rejects_non_decimal_ratio` — `allocationRatio=0.15` 被拒
- `save_rejects_over_three_per_pool` — 同一 (saleItemId,'美容师') 放 4 人被拒
- `save_allows_three_roles_independent` — 同一 saleItemId 美容师/养生师/推广师 各 2 人合计 6 人通过（三池独立）
- `save_recomputes_total_amount` — 前端传 `totalAmount=99999` 被忽略，后端重算为 `received × ratio`
- `save_rejects_pool_sum_over_received` — 某池两人 0.60+0.60 = 1.20 × received 被拒
- `save_allows_pool_sum_within_tolerance` — 0.30+0.30+0.40 合计 1.00 通过
- `save_rejects_missing_role_type` — payload 缺 `roleType` 被拒
- `save_inserts_role_type_column` — DB 插入断言 role_type 列为 '美容师'
- `save_pool_key_by_sale_item` — 两个不同 saleItemId 的美容师池互不约束
- `suggest_returns_roles_from_skills` — mock 员工 `skills: ['美容师','推广师']`，返回两条 allocLine

### 5.2 admin 单测

补齐 `fengyu-admin/src/actions/allocations.test.ts`：

- `batchSave_three_roles_independent_pools` — 美容师/养生师 同 item 分别 50%/50% 合计 100% 通过（当前合并会因 100% 不超而通过，但 Q5 的"独立"语义需要回归测试锁定：某个不合法场景，例如 美容师 110% 被拒，养生师 50% 通过）
- `batchSave_recomputes_total_amount_server_side` — 前端篡改 totalAmount 被忽略
- `batchSave_pool_sum_tolerance` — 0.30+0.30+0.40 合计 1.00 通过
- `service_commissions.test.ts` 同步三角色独立用例

### 5.3 端到端回归

- staff 小程序：店长开单 → 支付 → 进入分配页 → 同一 sku 添加美容师 A（50%）+ 养生师 B（60%）→ 保存通过；证明 A+B 两池不合并约束
- admin `/allocations/:id`：同订单再次打开，技能标签列显示"美容师"/"养生师"两行，比例合计展示三行（而非合并为"美容师/养生师"一行）
- 负向：美容师 A（60%）+ 美容师 C（50%）→ 保存拒绝（同池合计 110%）

---

## 6 验收标准（DoD）

- [ ] cloudfn `allocation.save` 拒绝 `roleType` 缺失、拒绝非整十档、三池独立校验
- [ ] cloudfn `allocation.save` 服务端重算 totalAmount，前端传入被忽略
- [ ] cloudfn `ctx.auth.skills` 在 login 后可读，`staff.departments` 返回 `members[].skills`
- [ ] admin `actions/allocations.ts` `getRoleGroup` 删除或恒等化；UI 页脚按 roleType 显示独立比例合计
- [ ] admin `actions/service-commissions.ts` 同步
- [ ] admin batchSave totalAmount 服务端重算通过测试
- [ ] staff miniprogram 提交 allocation payload 每条含 `roleType`；globalData.skills 可读
- [ ] 单元测试新增 ≥ 15 条，全部通过
- [ ] 生产脏数据预检 §4.1 第 1 条 = 0 行
- [ ] PR-1 上线后 24 小时内 `operation_logs` 无"departmentName 反推"警告的异常集中爆发（观察兜底使用频率）
- [ ] 无线上订单的 `sale_allocations.total_amount` 被异常修改（抽检）

---

## 7 后续跟进（out of scope）

本 ticket **不** 包含：

1. **交互层重写**（`03-staff-commission.md` Phase 4.1）：revenue-allocation 页的"整十档选比例代替自动填金额" UI 变动；当前 ticket 只做了 payload 层面的 `roleType` 注入
2. **salesCategoryEnum 换值**（已被 `00-decisions.md` §1 取消）
3. **服务提成写入 service_commissions**（已由 commit `9a7e832` 完成）
4. **performanceDetail 口径修正**（已由 commit `9a7e832` 完成）
5. **"划卡数" dashboard 第 6 指标**（与 Q5 无关，另行立项）
6. **skills 权威列表迁移**（从硬编码 `SKILL_TAGS` 改为 DB DISTINCT 聚合）

---

## 8 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| PR-1 上线后旧前端传 `departmentName` 无 `roleType`，大面积 INVALID_PARAMS | 高 | §4.3 的 `departmentName` 反推兜底 + operation_logs 记录调用频率 |
| 生产员工 `skills` 为空导致前端无角色可选 | 中 | §4.1 脏数据预检作为上线阻塞 |
| 服务端重算 totalAmount 与前端显示出现 ≥0.02 差 | 低 | 舍入策略两端统一 `Math.round(× × 100)/100` |
| 三池独立校验后业务方发现存在"两个美容师 + 一个养生师"但养生师池单独超额的情况 | 低 | Q5 第 3 条明确池独立；该场景是会议期望行为，无需缓解 |
| 前端 `SKILL_TAGS` 与 `staff_wechat_users.skills` 实际值漂移（业务方自定义标签） | 低 | 暂不处理；后续跟进 §7 第 6 条 |
| admin 操作日志对 sale_allocations 旧记录的 role_type NULL 无回填 | 低 | §4.1 第 2 条只做观测，Q5 无回填要求 |

---

## 9 代码索引

| 层级 | 文件 | 关键行 | 动作 |
|---|---|---|---|
| cloudfn | `fengyu-staff/cloudfunctions/staffApi/middleware/auth.js` | 40-98 | A1：查 skills 注入 ctx.auth |
| cloudfn | `fengyu-staff/cloudfunctions/staffApi/routes/auth.js` | login/bindPhone | A5：返回 skills |
| cloudfn | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 16 | A2：删除 DEPT_TO_ROLE |
| cloudfn | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 31-144 | A2：save 重写（整十档 + 三池 + 重算 totalAmount + 写 role_type + departmentName 兜底） |
| cloudfn | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 272-428 | A3：resolveStaffRoles + suggest 重写 |
| cloudfn | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js` | 69-142 | A4：departments 返回 skills |
| admin | `fengyu-admin/src/actions/allocations.ts` | 155-281 | B1：getRoleGroup → getPoolKey + 服务端重算 + 池金额校验 |
| admin | `fengyu-admin/src/actions/service-commissions.ts` | 64-182 | B2：同步 |
| admin | `fengyu-admin/src/app/(main)/allocations/_components/allocation-detail-page.tsx` | 36-38/300-306/415-434/473-502 | B3：UI 三角色独立 |
| admin | `fengyu-admin/src/app/(main)/allocations/_components/service-commission-detail-page.tsx` | 36-38/… | B4：同步 |
| miniprogram | `fengyu-staff/miniprogram/app.ts` | globalData | C1：新增 skills |
| miniprogram | `fengyu-staff/miniprogram/packageOrder/revenue-allocation/revenue-allocation.ts` | 239-289 | C2：按 skills 分组 + 注入 roleType |
| miniprogram | `fengyu-staff/miniprogram/utils/allocation-calc.ts` | 32 | C3：beautyDepts 清空或删除 |

---

## 10 追溯

- **决策来源**：`notes/adapt-plans/00-decisions.md` §2 Q5（2026-04-10 业务方权威答复）
- **原始需求**：`notes/adapt-plans/03-staff-commission.md` §4 Phase 2.2-2.4 / Phase 3.1 / Phase 4.1
- **会议原文**：`.42cog/notes/meetings/meeting-20260324.md` §四/§五（推测路径，实际以 cog 中的文件为准）
- **已完成的关联工作**（out of scope 但上下文相关）：
  - commit `9a7e832` — 服务提成双字段模型 + performanceDetail 口径修正
  - commit `b78d15d` — 开单 cart 变动后重评估已选优惠券
  - commit `cb9a71c` — 满减门槛四端一致浮点兜底
