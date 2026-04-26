# 审计报告：流量 / 推广员链路（25）

**v1+v2 合并版 · 2026-04-26**
**审计时间**：2026-04-25（v1）/ 2026-04-26 23:30（v2 独立重审）
**域 ID**：25
**审计员**：claude-opus-4-7（v1）；claude-opus-4-7（独立审计员，v2）
**关联 PR/Ticket**：retain audit-19 P0-19-05（inviterUserId 校验弱）+ audit-04 P0-04-01（payNotify 无签名→自动发券）+ audit-10 E10-customer-source

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema（字段） | `db/schema/user.ts:43` `customerSource` + `db/schema/user.ts:45` `promoterEmployeeId`（FK→`staff_wechat_users.employee_id`） | ↑ | ↑ |
| Schema（枚举） | `db/schema/enums.ts:95-106` `customerSourceEnum`（10 值） | ↑ | ↑ |
| Schema（业绩归属） | `db/schema/order.ts:228` `sale_allocations.role_type` 含 `推广师` | ↑ | ↑ |
| Action/Route（写入） | `src/actions/customers.ts:395-473 updateCustomer`（promoterEmployeeId / customerSource） | — | `clientApi/routes/auth.js:201-289 bindStore`（首次 + 后续覆盖） |
| Action/Route（inviter） | — | — | `auth.js:255-278`（前缀 + EXISTS + 静默 try/catch） |
| Action/Route（消费） | — | `mgmt-traffic.js:542 summary`（5 Section，不读 promoter/customer_source）；`staff.js performanceDetail`（仅 sa.employee_id） | — |
| 鉴权守卫 | `requirePermission(customer:update)` + `scopeCondition` | `requireManagementLevel()` | 仅 OPENID 鉴权，无业务守卫 |
| 前端（选择器） | `customer-detail-page.tsx:149-178 searchEmployees`（无 scope） | — | `store-detail.ts:130-156 promoterName 文本当 employeeId 提交**← 字段错位** |
| 前端（来源渠道） | `customer-detail-page.tsx:613-637`（10 值硬编码） | — | `store-detail.ts:58-61 sourceGroups`（10 值硬编码） |
| Zod Schema | `schemas.ts:131` `customerSource: z.string()`（不卡 enum） | — | — |
| 测试 | `customers.test.ts:388/559` 仅赋 null；`auth.test.js:150-329` 共 11 个 bindStore，**0 个覆盖 sourceChannel/promoterEmployeeId** | `mgmt-traffic.test.js`（11 段，**完全不读 promoter/customerSource**） | — |
| 索引 | `db/schema/user.ts:79-86` 含 openid/phone/customer_id/bound_store_id；**无 `promoter_employee_id` 索引** | — | — |

---

## 2. 数据流图

```
┌─[client UI]──────────────────────────────────────────────────┐
│ store-detail.wxml:144 「来源渠道」van-radio-group               │
│   sourceGroups (前端 10 值硬编码, 与 enum 平行)                │
│ store-detail.wxml:160 「推荐人」van-field input                │
│   promoterName 是**人类可读字符串**                            │
└──────────────────────────────────────────────────────────────┘
        │ promoterEmployeeId: promoterName || undefined  ← ⚠ 字段错位
        ▼
┌─[clientApi.bindStore]─────────────────────────────────────────┐
│ auth.js:201-253                                                │
│  1. 查 user / 校验 storeId                                     │
│  2. ✗ sourceChannel 不校验 enum 集合                           │
│  3. ✗ promoterEmployeeId 不校验存在/在职/同店                  │
│  4. inviter 前缀 + EXISTS + 静默 try/catch (audit-19 P0-19-05) │
│  5. ✗ bindStore 不写 operation_logs                            │
└──────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────┐
   │ 前端 store-detail.ts:142     │
   │  promoterName (中文文本)     │ ──▶ FK 23503 → bindStore 整体失败
   │  ✗ 无 employee 选择器        │    → 顾客 100% 无法绑店
   └──────────────────────────────┘

┌─[client_wechat_users]─────────────────────────────────────────┐
│ customer_source       customerSourceEnum (PG)                  │
│ promoter_employee_id  varchar(30) FK→staff_wechat_users       │
│ inviter_user_id       text FK→client_wechat_users             │
└──────────────────────────────────────────────────────────────┘
        │
        ├───→ admin updateCustomer（无校验）
        │        - searchEmployees 无 scopeCondition
        │        - 不写 operation_logs（仅通用 logUpdate diff）
        │        - 不校验 promoter 在职/同店
        │        - customerSource z.string() 不卡 enum
        │
        ├───→ payNotify.share-gift（基于 inviter_user_id，非 promoter）
        │     ⚠ 与"推广员业绩归属"无任何关联
        │
        ├───→ sale_allocations（完全无 promoter 消费路径）
        │     performanceDetail 仅用 sa.employee_id
        │
        └───→ mgmt-traffic 5 section（仅 customer_type/status）
              不读 customer_source / promoter_employee_id
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

- **[P0-25-01]** client `bindStore` 绑定推广员零校验（FK / 在职 / 门店 / 角色全跳过）
  - 来源：v1 + v2（P0-25v2-01）
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:245-248`
  - 现象：
    ```js
    if (promoterEmployeeId) {
      params.push(promoterEmployeeId)
      setClauses.push(`promoter_employee_id = $${params.length}`)
    }
    ```
    无任何 `SELECT FROM staff_wechat_users WHERE employee_id=$1 AND is_resigned=false` 校验。FK 兜底拒绝完全不存在的 employeeId，但：
    1. 已**离职**员工（is_resigned=true）仍可被绑定（FK 不感知 resigned）
    2. **跨门店**任意员工可被绑定（FK 不感知 store_id）
    3. **非美容师角色**（财务/HR/总部）员工仍可成为"推荐人"
  - 风险：未来若启用基于 promoter_employee_id 的提成自动归属（spec 已暗含 sale_allocations.role_type='推广师'），离职/跨店/非员工角色可被冒充为推广源；与 audit-04 payNotify 无签名联动 → 资损放大
  - 复现：1) 前端拦截 bindStore 请求；2) payload 改为 `{storeId: 'store-001', promoterEmployeeId: 'EMP-离职员工'}`；3) UPDATE 成功（DB FK 仅校验存在，不校验在职/scope）
  - 修复：(L3) 加 `SELECT employee_id FROM staff_wechat_users WHERE employee_id=$1 AND is_resigned=false AND store_id=$2(=storeId)`，未命中则 `INVALID_PARAMS: 推广员不存在或不属于该门店`

- **[P0-25-02]** client 前端把"中文姓名"直接当 `promoterEmployeeId` 提交（100% 绑店失败）
  - 来源：v1 + v2（P0-25v2-02）
  - 文件：`fengyu-client/miniprogram/pagesStore/store-detail/store-detail.ts:142`
  - 现象：TS `onConfirmBind` 行 142 直接 `promoterEmployeeId: promoterName || undefined`，`promoterName` 来自 `<input v-model="promoterName" />` 自由文本（line 125-127）。后端字段名 `promoterEmployeeId` 实际是员工编号（`FY-YYMMDD-NNNN` 格式），而非姓名。与 admin 端 `searchEmployees` 异步搜索精确选 `emp.employeeId` 形成**完全相反**的语义。
  - 风险：
    - 数据脏：DB FK 兜底报 23503（整个 UPDATE 回滚），**bindStore 整体失败 → 顾客无法绑店**，即使其他参数全对
    - 错误信息原始 23503 被 `Toast.fail(err?.message || '绑定失败')` 暴露给顾客（PII / 内部表名泄露）
    - 即使后端补上"中文→employee_id 解析"，"小李"重名问题无法消歧
  - 复现：顾客打开 store-detail → 选门店 → 来源选`老带新` → 推广员栏输入"小李" → 点确认绑定 → PG 抛 FK constraint → 顾客看到报错且门店未绑定
  - 修复：(L9) 必须改成"先调 `staff.searchByName` 拿到 employee_id 再传"，或砍掉自由文本输入改为下拉；当前字段名 `promoterName` 语义误导

- **[P0-25-03]** admin `searchEmployees` 推广员选择器零 scope（跨集团 PII 暴露 + 跨店推广人）
  - 来源：v1
  - 文件：`fengyu-admin/src/actions/employees.ts:73-102`
  - 现象：
    ```ts
    export async function searchEmployees(keyword: string) {
      const session = await getSession()
      requirePermission(session, 'customer:update')  // 仅查权限，不查 scope
      return db.select(...).from(staffWechatUsers)
        .where(and(
          eq(staffWechatUsers.isResigned, false),
          or(ilike(name, pattern), ilike(phone, pattern))
        ))
        // ⚠ 完全无 scopeCondition(session, staffWechatUsers.storeId)
        .limit(20)
    }
    ```
    任何拥有 `customer:update` 权限的用户（manager / customer_mgr）即可模糊搜索全集团所有在职员工。返回字段含 `phone`（customer-detail-page 行 517 显示 `${name} (${phone})`）→ CC6 PII 暴露。同模块 `getEmployees`（行 52-67）正确加了 `scopeCondition` ✅，双轨实现。
  - 风险：店长 store-X 输入"李"可获取全国所有姓李的员工 phone（PII 越权）；店长把 store-Y 美容师设为本店顾客推广人 → 业绩归属错位
  - 复现：manager 角色登录（绑店 store-X）→ 进任意顾客详情→编辑→推荐人输入"王" → 返回结果含其他门店姓王的所有员工
  - 修复：(L7) 加 `scopeCondition(session, staffWechatUsers.storeId)` + 传 `customerStoreId` 参数限定同店 + 隐藏/脱敏 phone

- **[P0-25-04]** admin `updateCustomer` 改 promoterEmployeeId 不校验员工 / 在职 / 同店（与 v2 P0-25v2-04 同源）
  - 来源：v1 + v2（P0-25v2-04 的一部分）
  - 文件：`fengyu-admin/src/actions/customers.ts:395-473` + `schemas.ts:126-142`
  - 现象：
    - `updateCustomer` 入参 `promoterEmployeeId: string | null`（行 412），直接 `db.update(...).set(data as any)`（行 453）
    - 完全无 server 端 `SELECT staffWechatUsers WHERE is_resigned=false` 校验
    - Zod schema 行 131 仅 `customerSource: z.string().optional().nullable()`；promoterEmployeeId 整个未在 schema 声明
    - `customerSource` 无 Zod enum 校验，仅依赖 PG enum 兜底（22P02）
  - 风险：后端不重算前端值（CC4 命中）；promoter 离职后历史无提示，admin UI 反查"员工姓名"显示为"未知"；customerSource 传入非 enum 值（如"小红书"）被 PG 拒绝但错误前缀不规范
  - 修复：(L7) `customerSource: z.enum(customerSourceEnum.enumValues)` + 加 `promoterEmployeeId: z.string()`；actions/customers.ts 加 is_resigned=false 校验

- **[P0-25-05]** 推广员业绩归属机制完全缺失（spec 暗示存在 / 代码 0 处实现）
  - 来源：v1（v2 进度表"4/7/8"未列入此 P0，故以 v1 为准）
  - 文件：spec `.42cog/pm/staff.pr.spec.md` "营业额分配"章节 + `db/schema/order.ts` sale_allocations + `staffApi/routes/staff.js performanceDetail`
  - 现象：
    - schema `client_wechat_users.promoter_employee_id` 注释"推荐人（美容师员工ID）"暗示业务上是**推广业绩归属源**
    - PLAN §2 域 25 检查点："推广员业绩归属、来源渠道枚举完整性、推广员变更追溯"
    - grep `promoter` 全仓 staffApi/routes/* + payNotify/* + admin/src/actions/* 业绩相关路径 → **0 命中**
    - performanceDetail / dashboard / sa.suggest / sa.save 全部仅以 `sa.employee_id` 计提成
    - 推广员"贡献"仅作为顾客档案标签，不计任何业绩 / 提成 / 看板指标
  - 风险：业务能力空缺（市场期望地推卡渠道员工获得推荐顾客业绩分成）；spec / schema / 代码三段断裂；与"分享礼"（inviter_user_id 顾客互推）逻辑独立，运营容易混淆"该用谁"
  - 复现：跑 §7 SQL #4/5 — 对所有有 promoter_employee_id 的顾客订单，验证 sale_allocations 中是否有以 promoter 为 employee_id 的行 → 大概率返回 0%
  - 修复：(L0+L3+L7 三层联动) 需 PM 决策后补：sale_orders 快照列 + allocation.suggest 自动加推广师行 + mgmt-traffic 推广榜 section

---

### 3.2 P1（数据一致 / 状态错乱）

- **[P1-25-06]** `bindStore` 后续覆盖：promoterEmployeeId / customerSource 可被任意次重写，无 first-time guard
  - 来源：v1 + v2（P1-25v2-04）
  - 文件：`clientApi/routes/auth.js:240-253`
  - 现象：与同函数 `inviter_user_id` 的"仅当 IS NULL 时写入"（行 271）形成对照，promoter / source 没有这层守卫。顾客每次进 store-detail 重新 bindStore（换绑门店）就覆盖，无变更日志。
  - 风险：业绩归属可被顾客自助修改（与 audit-19 P0-19-05 inviter 防套利同模式但更宽松）；与 P0-25-05 联合放大：未来若启用 promoter 自动提成，顾客可在每次下单前换推广员套现
  - 修复：二选一——严格首绑（加 `promoter_employee_id IS NULL` guard）或允许变更但写 operation_logs

- **[P1-25-07]** `inviterUserId` 仅前缀校验 + 静默吞错（retain audit-19 P0-19-05）
  - 来源：v1
  - 文件：`clientApi/routes/auth.js:255-278`
  - 现象：`startsWith('FYGK-')` + EXISTS + try/catch console.warn 静默吞错。与 P0-25-01 同事务执行，任一失败可能引起静默状态偏移；与 payNotify 无签名 + share-gift 自动发券联动 → 资损放大
  - 修复：见 audit-19 §3.1 P0-19-05 修复方案

- **[P1-25-08]** customerSource 三端硬编码 10 值，添加新渠道需三处同步（spec 漂移高危）
  - 来源：v1（v2 P0-25v2-04 对应规格不一致，三端 enum 漂移在 v1 已记）
  - 文件：
    - DB enum：`db/schema/enums.ts:95-106`（10 值）
    - admin UI：`customer-detail-page.tsx:619-633`（10 值 hardcode `<option>`）
    - client UI：`store-detail.ts:58-61 sourceGroups`（10 值 hardcode）
    - **v2 新发现**：`client.pr.spec.md:242` 仅列 8 项老 channel 名（推广部/自进/内部地推/第三方拓客），与 DB 10 值和前端硬编码全部对不上（spec 8 ≠ DB 10 ≠ admin 任意）
  - 风险：spec 与 DB 两套语义；admin 编辑顾客时可写入任何字符串（前端 select 可绕过）
  - 修复：L0 spec 与 enums.ts 对齐；L0 评估改软枚举（system_configs）

- **[P1-25-09]** `mgmt-traffic` 客量统计完全不消费 customer_source / promoter_employee_id
  - 来源：v1 + v2（P1-25v2-01）
  - 文件：`staffApi/routes/mgmt-traffic.js:1-625`
  - 现象：5 section 全部是 customer_status / customer_type / service_date 等行为指标；不按 source / promoter 切片。"流量"字面（拓客渠道效果分析）严重不符；运营问"地推卡渠道带来多少新会员？""推广员张三本月转化率？"系统无答案。
  - 风险：业务报表不完整；与 P0-25-05 同源（字段写入了但完全没有读出口径）
  - 修复：增 Section 6 "渠道经营"（按 customer_source 分组）+ Section 7 "推广员排行"（按 promoter_employee_id 分组）

- **[P1-25-10]** customerSource 在历史 WorkFine 同步顾客上长期 NULL（无 backfill）
  - 来源：v1
  - 现象：customer_source enum 列允许 NULL；WorkFine 同步路径（`db/scripts/sync-workfine.js`）无写入；历史顾客 100% NULL → admin 列表筛选 source 时不可见 → 报表偏差
  - 修复：一次性 backfill，回填"自进店"或新建"未知"enum 值

- **[P1-25-11]** Zod `customerSchema` 不约束 customerSource 枚举集合（CC4 后端不重算前端值）
  - 来源：v1 + v2（P1-25v2-02）
  - 文件：`admin/src/lib/schemas.ts:131`
  - 现象：`customerSource: z.string()` 接受任意字符串；admin updateCustomer 行 453 直接 `set(data as any)`；类型断言 `as typeof clientWechatUsers.customerSource.enumValues[number]` 绕开 Zod（v2 发现）
  - 修复：schema 改 `z.enum([...])`；actions 加 `!enumValues.includes()` 前置校验

- **[P1-25-12]** admin updateCustomer 不写 promoterEmployeeName 冗余字段（与 boundEmployeeId/Name 双轨）
  - 来源：v1
  - 文件：`admin/src/actions/customers.ts:428-437`
  - 现象：schema 行 32-34 设计 `bound_employee_id` + `bound_employee_name` 冗余对，admin 在 boundEmployeeId 变更时同步写 name；promoter_employee_id 没有对应冗余 name 列，admin UI 行 159 反查 employees 列表，离职 / 跨店 promoter 显示为"未知"
  - 修复：(L0+L7) 加列 `promoter_employee_name varchar(50)`；updateCustomer 在 promoterEmployeeId 变更时同步写

- **[P1-25-13]** 推广员变更追溯缺失（bindStore 无 operation_logs）
  - 来源：v2（v1 §3 跨端一致表中已提及，v2 独立作为 P1 条目）
  - 文件：`clientApi/routes/auth.js:201-289`
  - 现象：bindStore 写入 `customer_source` / `promoter_employee_id` 不调 `logOperation`；admin 端 `updateCustomer` 走 `logUpdate`（行 469）但 cloud function 端无对等
  - 风险：客户端首次绑店设置的来源渠道 / 推广员，事后无法追溯"什么时候、谁、怎么改的"；反作弊取证缺失
  - 修复：L3 auth.js 末尾加 `INSERT INTO operation_logs(action='auth.bindStore', before=null, after={sourceChannel, promoterEmployeeId})`

- **[P1-25-14]** mgmt-traffic 三副本 scope helper 与主 helper 漂移（与 audit-CC3-05 同源）
  - 来源：v2（P1-25v2-07）
  - 文件：`mgmt-traffic.js:50-79` vs `utils/scope.js:139 buildStoreScopeCondition`
  - 现象：与 audit-CC3 §P0-CC3-05 同源（Top 5 横切问题）；mgmt-traffic 三副本 scope helper 与主 scope.js 实现不一致，双轨维护风险累积
  - 风险：scope 漂移累积，跨店越权风险随代码变更扩大
  - 修复：联动 audit-CC3-05 统一重构 scope helper

---

### 3.3 P2（代码质量 / 可维护）

- **[P2-25-15]** mgmt-traffic.js 文件命名误导：实际是"客流量数据子页"，与"渠道流量 / 推广员"概念错位。建议重命名 `mgmt-customer-volume.js`
- **[P2-25-16]** `bindStore` 动态 SQL 构造（setClauses + params 数组）可读性差，建议抽 helper
- **[P2-25-17]** `bindStore` 错误前缀混乱：promoter / inviter 失败静默 console.warn，不抛错无前缀（CC5 命中）
- **[P2-25-18]** `store-detail.ts:58-61 sourceGroups` 注释 0 行，建议加 `// 与 db/schema/enums.ts:95 customerSourceEnum 保持同步`
- **[P2-25-19]** admin `customer-detail-page.tsx:151-178` 键盘可访问性 / 无障碍缺测试
- **[P2-25-20]** `searchEmployees` 权限项是 `customer:update`（行 75），搜员工应为 `employee:list`（CC4 隐式合约错位）
- **[P2-25-21]** `promoter_employee_id` 列无索引（v2 P2-25v2-01）
  - 文件：`db/schema/user.ts:79-86`
  - 修复：L0 加 partial index `idx_client_users_promoter WHERE promoter_employee_id IS NOT NULL`
- **[P2-25-22]** mgmt-traffic 测试 0 覆盖 promoter / customerSource 维度（v2 P2-25v2-02）
  - 文件：`mgmt-traffic.test.js`
  - 现象：11 个 describe 覆盖注册/客流/会员状态，不存在 promoter / customer_source 关键字
- **[P2-25-23]** client `bindStore` 测试缺 sourceChannel / promoter 路径（v2 P2-25v2-03）
  - 文件：`auth.test.js:150-329`
  - 现象：11 个 bindStore 测试覆盖 storeId + inviter，**0 个覆盖 sourceChannel / promoterEmployeeId 写入**
  - 修复：加 4 个 case：(a) 不传→不出现 setClauses；(b) 传合法→写入；(c) 传非法 channel→拒绝；(d) 传非法 promoter→拒绝
- **[P2-25-24]** 前端 `sourceGroups` 数组硬编码与 DB enum 双轨（v2 P2-25v2-04）
  - 修复：L3 加 `clientApi.config.customerSourceList`，前端从云端拉
- **[P2-25-25]** 前端 `promoterName` 字段名语义误导（v2 P2-25v2-05）
  - 现象：data 字段叫 `promoterName`（暗示姓名），却作为 `promoterEmployeeId` 提交（暗示 ID）
  - 修复：重命名 + 改成 employee_id 绑定值
- **[P2-25-26]** `client.pr.spec.md:242` 与 enums.ts 漂移（v2 P2-25v2-06）
  - 现象：spec 列 8 项老 channel，DB 是 10 项新 channel；spec 早于实现且未更新
  - 修复：L0 spec 文档刷新
- **[P2-25-27]** mgmt-traffic 错误前缀符合规范但缺中文 fallback（v2 P2-25v2-07）— 仅观察
- **[P2-25-28]** `client_wechat_users.promoter_employee_id` 列无 `is_resigned=false` 触发器/CHECK（v2 P2-25v2-08）— 仅观察（业务校验放应用层即可，DB 不强制）

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| promoter 写入校验 | updateCustomer 无校验 | — | bindStore 无校验 | 离职/跨店员工持续吃业绩 | P0-25-01/04 |
| promoter 选择器 | searchEmployees 零 scope | — | **文本 input → 直传 employeeId** | 字段错位 + PII 暴露 | P0-25-02/03 |
| promoter 业绩消费 | — | 0 处使用 | — | spec 暗示存在但代码空缺 | P0-25-05 |
| customerSource 枚举集合 | z.string() 不卡 | mgmt-traffic 不读 | 前端 10 值硬编码 | spec 8 ≠ DB 10 ≠ admin 任意 | P0-25-04 / P1-25-08 |
| inviter 校验 | — | — | 前缀+EXISTS+静默吞错 | retain audit-19 P0-19-05 | P1-25-07 |
| 变更追溯 | logUpdate diff ✅ | — | bindStore **不写** operation_logs | 反作弊取证缺失 | P1-25-13 |
| 客量数据消费 | — | mgmt-traffic 5 section 不切 | — | promoter 字段写了但无读出口径 | P1-25-09 |
| name 同步 | bound_employee_name 冗余 ✅ / promoter 无 ❌ | — | — | 离职 promoter 显示"未知" | P1-25-12 |
| scope helper | — | mgmt-traffic 三副本漂移 | — | CC3-05 横切 | P1-25-14 |
| 枚举来源 | 硬编码 10 值 | — | 硬编码 10 值 | 三处复制粘贴 | P1-25-08 |
| WorkFine 同步 | — | — | — | customer_source 不维护 | P1-25-10 |

---

## 5. 横切检查（仅记录有问题项）

- [x] CC1 数值精度：本域不涉及金额计算，N/A
- [ ] **CC2 并发幂等**：bindStore 重写 promoter/source 无 first-time guard；promoter UPDATE + inviter UPDATE 不在一个 transaction，部分失败可能产生混合状态 → P1-25-06
- [ ] **CC3 组织域数据隔离**：admin searchEmployees 零 scope（P0-25-03）；mgmt-traffic 三副本 scope helper 与主 helper 漂移（P1-25-14，与 CC3-05 同源）→ **P0**
- [ ] **CC4 后端鉴权**：admin updateCustomer + Zod 不校验 customerSource enum（信任前端）→ P1-25-11；admin searchEmployees 用 `customer:update` 搜员工（语义错位）→ P2-25-20；client bindStore 无业务守卫 → **P0**
- [ ] **CC5 错误码**：bindStore promoter/inviter 路径全部 console.warn 静默吞错 + 无前缀 → P2-25-17；mgmt-traffic.js 错误前缀符合规范 ✓
- [ ] **CC6 PII**：admin searchEmployees 返回 phone 字段（customer-detail-page.tsx 行 517），跨集团模糊搜索批量收集员工 phone → P0-25-03；client bindStore 报错可能透传 PG 23503（含表/列名）→ P2
- [x] CC7 时间字段：bindStore 写入 `updated_at` ✅；inviter 写 `invited_at` ✅
- [ ] **CC8 WXML/Vant**：client store-detail.wxml 语义错位（promoterName 当 employeeId 传）→ P0-25-02
- [ ] **CC9 测试与残留**：bindStore 11 个 case 0 覆盖 promoter/source；mgmt-traffic.test.js 0 覆盖 promoter 维度；admin customers.test.ts 仅赋 null → **P2**

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/user.ts:43` | 加 `promoter_employee_name varchar(50)` 冗余列 | P1-25-12 |
| L0 schema | `db/schema/order.ts` sale_orders | 评估加 `promoter_employee_id_snapshot` 列 | P0-25-05 |
| L0 schema | `db/schema/order.ts` sale_allocations | 评估加 `is_from_promoter boolean` 或 sales_category 加"推广引流" | P0-25-05 |
| L0 schema | `db/schema/commission.ts` | 加"推广引流" sales_category 默认 rate | P0-25-05 |
| L0 schema | `db/schema/enums.ts:95-106` | 评估改软枚举（system_configs） | P1-25-08 |
| L0 schema | `db/schema/user.ts:79` | 加 `idx_client_users_promoter` partial index | P2-25-21 |
| L0 spec | `.42cog/pm/client.pr.spec.md:242` | 来源渠道枚举与 enums.ts 对齐 | P0-25-04 / P2-25-26 |
| L3 云函数 | `clientApi/routes/auth.js:241-248` | (a) `VALID_SOURCES.has(sourceChannel)` 校验；(b) `SELECT FROM staff_wechat_users WHERE employee_id=$1 AND is_resigned=false AND store_id=$storeId` 校验 promoter；(c) 写 operation_logs；(d) 评估 first-write-wins guard | P0-25-01 / P0-25-02 / P1-25-13 / P1-25-06 |
| L3 测试 | `clientApi/__tests__/routes/auth.test.js` | 补 promoter 不存在/已离职/跨店 + sourceChannel 合法/非法 + first-write-wins 四类用例 | P2-25-23 |
| L3 云函数 | `staffApi/routes/allocation.js suggest` | 检查 promoter，自动加"推广师"行（默认 5%） | P0-25-05 |
| L3 云函数 | `payNotify/index.js handleSuccess` | 写 sa 时若 promoter 存在补一行 | P0-25-05 |
| L3 云函数 | `staffApi/routes/mgmt-traffic.js` | 加 Section 6 "渠道经营" + Section 7 "推广员排行" | P1-25-09 |
| L3 测试 | `staffApi/__tests__/routes/mgmt-traffic.test.js` | 加 promoter / customerSource 维度统计回归 | P2-25-22 |
| L3 云函数 | `staffApi/routes/customer.js detail` | 返回 promoterEmployeeName / customerSource 给员工端 | P1-25-09 |
| L3 云函数 | `mgmt-traffic.js:50-79` | 统一 scope helper 与 `utils/scope.js:139` 一致 | P1-25-14（联动 CC3-05）|
| L7 admin | `actions/employees.ts:73-102 searchEmployees` | 加 `customerStoreId` 参数 + scopeCondition + 脱敏 phone | P0-25-03 |
| L7 admin | `actions/customers.ts:395-473 updateCustomer` | 加 promoter is_resigned=false 校验 + customerSource enum 校验 + 同步 promoter_employee_name | P0-25-04 / P1-25-11 / P1-25-12 |
| L7 admin | `lib/schemas.ts:126-142 customerSchema` | `customerSource: z.enum([...])` + 加 `promoterEmployeeId: z.string()` | P1-25-11 |
| L9 前端 | `pagesStore/store-detail/store-detail.ts:55-156` | (a) promoterName → promoterEmployeeId 绑定 employee_id；(b) 新增员工名→searchByName 下拉；(c) 来源渠道列表从云端拉 | P0-25-02 / P2-25-24 / P2-25-25 |
| L9 前端 | `store-detail/store-detail.wxml:160-167` | 改 `<van-field>` 为员工 picker | P0-25-02 |
| 数据治理 | `db/scripts/backfill-customer-source.ts`（新增） | WorkFine 历史顾客 customer_source backfill | P1-25-10 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (1) 验证 P0-25-01：promoter 离职 / 跨店被绑定的脏数据范围
SELECT c.user_id, c.phone, c.bound_store_id AS customer_store,
       c.promoter_employee_id,
       sw.name AS promoter_name, sw.is_resigned, sw.store_id AS promoter_store
FROM client_wechat_users c
LEFT JOIN staff_wechat_users sw ON sw.employee_id = c.promoter_employee_id
WHERE c.promoter_employee_id IS NOT NULL
  AND (sw.is_resigned = true OR sw.store_id IS DISTINCT FROM c.bound_store_id)
LIMIT 100;

-- (2) 验证 P1-25-10：customer_source 在历史 WorkFine 顾客上的 NULL 率
SELECT
  COUNT(*) FILTER (WHERE openid IS NULL) AS workfine_only,
  COUNT(*) FILTER (WHERE openid IS NULL AND customer_source IS NULL) AS workfine_null_source,
  COUNT(*) FILTER (WHERE openid IS NOT NULL) AS wechat_user,
  COUNT(*) FILTER (WHERE openid IS NOT NULL AND customer_source IS NULL) AS wechat_null_source,
  COUNT(*) AS total
FROM client_wechat_users;

-- (3) 验证 P0-25-02：promoter_employee_id 写入了非员工编号格式的脏数据
SELECT user_id, phone, promoter_employee_id, length(promoter_employee_id) AS l
FROM client_wechat_users
WHERE promoter_employee_id IS NOT NULL
  AND promoter_employee_id NOT LIKE 'FY-%'
LIMIT 50;

-- (4) 验证 P0-25-05：promoter 顾客的销售订单是否在 sale_allocations 中体现 promoter（预期：0）
WITH promoter_customers AS (
  SELECT user_id, promoter_employee_id FROM client_wechat_users
  WHERE promoter_employee_id IS NOT NULL
)
SELECT pc.promoter_employee_id,
       COUNT(DISTINCT o.sale_order_id) AS orders_count,
       SUM(CASE WHEN sa.employee_id = pc.promoter_employee_id THEN 1 ELSE 0 END) AS sa_with_promoter
FROM promoter_customers pc
JOIN sale_orders o ON o.client_user_id = pc.user_id AND o.status = '已支付'
LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
LEFT JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id AND sa.is_void = false
GROUP BY pc.promoter_employee_id
HAVING SUM(CASE WHEN sa.employee_id = pc.promoter_employee_id THEN 1 ELSE 0 END) = 0
LIMIT 50;

-- (5) 验证来源渠道分布（核对前端 10 值是否全用上）
SELECT customer_source, COUNT(*) AS n
FROM client_wechat_users
WHERE customer_source IS NOT NULL
GROUP BY customer_source
ORDER BY n DESC;

-- (6) 查找已写入"非员工 ID"的脏数据（中文姓名等）
SELECT user_id, promoter_employee_id, customer_source, created_at
FROM client_wechat_users
WHERE promoter_employee_id IS NOT NULL
  AND promoter_employee_id NOT IN (SELECT employee_id FROM staff_wechat_users)
LIMIT 50;

-- (7) 推广员与顾客绑定门店不一致（跨店推广）
SELECT c.user_id, c.bound_store_id, c.promoter_employee_id, s.store_id AS promoter_store
FROM client_wechat_users c
JOIN staff_wechat_users s ON s.employee_id = c.promoter_employee_id
WHERE c.bound_store_id IS NOT NULL
  AND s.store_id IS NOT NULL
  AND c.bound_store_id <> s.store_id
LIMIT 50;

-- (8) promoter 字段在 sale_orders / sale_allocations 列出现率
EXPLAIN ANALYZE SELECT 1
FROM information_schema.columns
WHERE column_name LIKE '%promoter%'
  AND table_schema = 'public';
```

---

## 8. 回归测试用例（建议）

1. **client bindStore + 离职推广员**：mock `staff_wechat_users` 含 `(EMP-001, is_resigned=true)`；`bindStore({storeId, promoterEmployeeId: 'EMP-001'})` 应抛 `INVALID_PARAMS: 推广员已离职`
2. **client bindStore + 跨店推广员**：mock `EMP-001 store_id='store-002'`，`bindStore({storeId: 'store-001', promoterEmployeeId: 'EMP-001'})` 应抛 `INVALID_PARAMS: 推广员不属于该门店`
3. **client bindStore + 非法来源**：`bindStore({storeId, sourceChannel: 'foobar'})` 应抛 `INVALID_PARAMS: 来源渠道非法`
4. **client bindStore + 中文姓名当 promoterEmployeeId**：`bindStore({storeId, promoterEmployeeId: '小李'})` 应在应用层抛 `INVALID_PARAMS`，不让 PG FK 兜底
5. **admin searchEmployees scope**：manager(store-X) 调用 → 只返回 store-X 员工；admin 调用 → 全集团；非 admin 不传 customerStoreId → 仅 session scope
6. **admin updateCustomer customerSource 非 enum**：传"小红书"→ 拒绝（Zod 校验而非 PG 22P02）
7. **admin updateCustomer promoter 离职**：传已离职 employeeId → 拒绝
8. **operation_logs 写入**：bindStore 触发后 `SELECT * FROM operation_logs WHERE action='auth.bindStore'` 至少 1 行
9. **first-write-wins 语义**：首次 bindStore 写入 promoter='EMP-001'；第二次传 'EMP-002'，`promoter_employee_id` 仍为 'EMP-001'
10. **mgmt-traffic Section 6/7**：插 `customer_source='美团'` 新会员 + promoter 关联顾客订单 → 渠道经营段 / 推广员排行数据正确

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（promoter 离职数据 / customer_source NULL / 中文姓名脏数据需排查）
- 修复成本：**M-L**（P0-25-05 业绩归属机制是新功能，需 PM 决策；其他 P0/P1 都是补校验）

---

## 10. 后续待办

- [ ] 与 PM 对齐"推广员业绩归属"是否启动（P0-25-05）：是 → ticket-2026-04-XX-promoter-commission；否 → schema 加注释明确"仅档案标签"，mgmt-traffic 推广榜作为信息性指标
- [ ] 与 audit-19 P0-19-05（inviter 防套利）合并修复（同 bindStore 路径）
- [ ] 评估 customer_source enum 改软（system_configs）的迁移成本
- [ ] 把 mgmt-traffic.js 重命名为 mgmt-customer-volume.js
- [ ] 与 audit-13 / audit-19 同模式归集"前端 UI 文本字符串错传后端 ID 类字段"（P0-25-02 + audit-13 face_value_override 接近模式）
- [ ] 数据治理：跑 §7 SQL #1/3/5 评估存量脏数据，写一次性回填/清洗脚本
- [ ] 加测试覆盖（auth.test.js + mgmt-traffic.test.js + customers.test.ts）
- [ ] 与 audit-CC3-05 联动修复 mgmt-traffic 三副本 scope helper

---

## §11 v1→v2 合并摘要

**合并日期**：2026-04-26

**合并原则**：
- 同一问题两个版本描述有出入，以 v2 为准（v2 为独立审计员重审，细节更充分）
- v1 独有的 P0（P0-25-05 推广员业绩归属机制完全缺失）保留（v2 进度表"4P0"漏了这一项，以 v1 更全为准）
- v2 新增发现（v2-only）合并进来
- 无任何问题标记为 RESOLVED（两版快照时间接近，无"已修复"状态可记录）

**合并后计数**：**5P0 / 7P1 / 8P2**（去重后与 v1 一致；v2 总计 4/7/8，合并后 P0 补回 v1 独有的 P0-25-05）

**v2 新增独立发现**（v1 未覆盖）：
| 编号 | 内容 | 来源 |
|------|------|------|
| P1-25-13 | bindStore 无 operation_logs（v1 在跨端一致表中已提及，v2 独立作 P1 条目） | v2-only |
| P1-25-14 | mgmt-traffic 三副本 scope helper 与主 helper 漂移（与 CC3-05 同源） | v2-only |
| P2-25-28 | promoter_employee_id FK 无 is_resigned CHECK 触发器（观察项） | v2-only |

**v1 vs v2 描述差异**（以 v2 为准）：
- v2 §1 三端入口对照：schema/Action/前端/测试/索引更完整（含无 promoter 索引发现）
- v2 §2 数据流图：明确标注前端 promoterName → FK 23503 的 100% 绑店失败路径
- v2 §3 P0-25v2-04：将"三端 enum 漂移"拆出独立 P0（v1 中在 P1-25-08 / P0-25-04 中混合）
- v2 §6 修复建议：按 L0→L10 排序更清晰，含 L3 scope helper 统一行动项

**关键合并决策**：
- **P0-25-05 保留**：v2 进度表"4P0"未列业绩归属机制缺失，但 v1 有独立 P0-25-05（5/7/8 中 P0-05）。两版独立产出，口径以 v1 更全为准。
- **P1-25-14 scope 漂移**：v2 P1-25v2-07 与 audit-CC3-05 同源，跨域横切问题在 CROSS-CUTTING.md 已记录，本报告注明联动。
- **P0-25-04 三端 enum 漂移**：v2 P0-25v2-04 = v1 P0-25-04（部分）+ P1-25-08（部分），合并为 P0-25-04（风险更高，按 P0 定级）。