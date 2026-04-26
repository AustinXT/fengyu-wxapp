# 审计报告：流量 / 推广员链路 (25)

**审计时间**：2026-04-25
**域 ID**：25
**slug**：traffic-promoter
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—（首次审计）；retain audit-19 P0-19-05（inviterUserId 校验弱）+ audit-04 P0-04-01（payNotify 无签名→自动发券）+ audit-10 E10-customer-source
**规范版本**：`real.md` v3.1.0（命中 #5 后端鉴权 / #6 组织域数据隔离）

---

## 1. 三端入口对照

| 层 | admin | staff | client | payNotify |
|----|-------|-------|--------|-----------|
| Schema | `db/schema/user.ts:43-45` clientWechatUsers.{customerSource, promoterEmployeeId} + `db/schema/enums.ts:95-106` customerSourceEnum (10 值) + FK→staffWechatUsers.employeeId | ↑ | ↑ | ↑ |
| 写入路径（promoter） | `src/actions/customers.ts:395-473 updateCustomer`（含 promoterEmployeeId / customerSource） | **完全无路由读/改 promoter / customer_source** | `clientApi/routes/auth.js:201-289 bindStore`（首次 + 后续覆盖） | — |
| 写入路径（inviter） | — | — | `auth.js:255-278`（仅前缀+EXISTS+静默 try/catch） | — |
| 推广员选择器 | `_components/customer-detail-page.tsx:149-178` (`searchEmployees`) → `actions/employees.ts:73-102 searchEmployees`（**完全无 scope，不限店、不限 isResigned… isResigned=false 但跨集团搜索**） | — | `pagesStore/store-detail/store-detail.ts:130-156` 把 `promoterName` 文本字符串当 employeeId 直传 | — |
| 来源渠道选择器 | `_components/customer-detail-page.tsx:613-637` `<Select>`（10 值硬编码） | — | `pagesStore/store-detail/store-detail.ts:58-61 sourceGroups`（10 值硬编码） + WXML `:144-159 van-radio-group` | — |
| 业务消费（业绩） | — | `staffApi/routes/staff.js:167-680` performanceDetail / dashboard 全部以 `sa.employee_id` 计 — **零处读 promoter_employee_id** | — | — |
| 业务消费（自动赠券） | — | — | — | `payNotify/share-gift.js:55-60`（**inviter_user_id 触发**，非 promoter_employee_id 触发；P0-04-01 无签名→任意伪造放大） |
| Zod schema | `src/lib/schemas.ts:131` `customerSource: z.string().optional().nullable()`（**未约束 10 值**） | — | — | — |
| 客量数据子页 | — | `staffApi/routes/mgmt-traffic.js:1-625 summary`（5 section：注册/到店客流/会员状态/会员被经营/新会员经营。**完全不参与 promoter / customer_source 维度统计**） | — | — |
| 测试 | `actions/customers.test.ts:388/559`（promoterEmployeeId / customerSource 仅赋 null）；`actions/employees.test.ts` 缺 searchEmployees 越权用例 | — | `__tests__/routes/auth.test.js:240-287` 仅覆盖 inviter 前缀路径 | — |

---

## 2. 数据流图

```
┌─[client UI]──────────────────────────────────────────┐
│ store-detail.wxml:144 「来源渠道」 van-radio-group    │
│   sourceGroups (前端 10 值硬编码, 与 enum 平行声明)    │
│ store-detail.wxml:160 「推荐人」 van-field input      │
│   promoterName 是**人类可读字符串**                   │
└──────────────────────────────────────────────────────┘
        │ promoterEmployeeId: promoterName || undefined  ← ⚠ 字段错位
        ▼
┌─[clientApi.bindStore]─────────────────────────────────┐
│ auth.js:201-253                                       │
│ 1. 查 user / 校验 storeId                              │
│ 2. 动态拼 SET 子句：                                   │
│    customer_source = $sourceChannel  (PG enum 兜底)    │
│    promoter_employee_id = $promoterEmployeeId          │
│      ⚠ 未校验：FK存在 / 在职 / 同店 / 角色合法         │
│ 3. inviter 前缀 + EXISTS + 静默 try/catch (P0-19-05)   │
│ 4. invalidateAuthCache(OPENID)                         │
└──────────────────────────────────────────────────────┘
        ▼
┌─[client_wechat_users]─────────────────────────────────┐
│ customer_source       customerSourceEnum (PG)          │
│ promoter_employee_id  varchar(30) FK→staff_wechat_users│
│ inviter_user_id       text FK→client_wechat_users      │
│ invited_at            timestamp                        │
└──────────────────────────────────────────────────────┘
        │
        ├───→ admin updateCustomer (任意 admin/manager/customer_mgr 可改)
        │        - searchEmployees 选择器零 scope
        │        - 不写 operation_logs.{from→to} diff（依赖 logUpdate diff 通用）
        │        - 不校验 promoter 在职 / 在客户绑定门店
        │
        ├───→ payNotify.share-gift (基于 inviter_user_id, 非 promoter)
        │        ⚠ 与"推广员业绩归属"无任何关联
        │
        └───→ staff routes 完全不消费这两个字段
                - performanceDetail 仅用 sa.employee_id
                - mgmt-traffic 5 section 仅用 customer_type / status
                - 不读 customer_source / promoter_employee_id
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-25-01]** client `bindStore` 绑定推广员零校验（FK / 在职 / 门店 / 角色全跳过）
- 文件：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:245-248`
- 现象：
  ```js
  if (promoterEmployeeId) {
    params.push(promoterEmployeeId)
    setClauses.push(`promoter_employee_id = $${params.length}`)
  }
  ```
  无任何 `SELECT 1 FROM staff_wechat_users WHERE employee_id=$1 AND is_resigned=false` 校验。FK 兜底（schema 行 45 declared FK→staff_wechat_users.employee_id）会拒绝完全不存在的 employeeId，但：
  1. 已**离职**员工（is_resigned=true）仍可被绑定（FK 不感知 resigned）
  2. **跨市场 / 跨店**任意员工可被绑定（FK 不感知 store_id）
  3. **非美容师角色**（财务 / HR / 总部）员工仍可成为顾客的"推荐人"（FK 不感知 position_name）
- 雪上加霜：client 前端 `store-detail.ts:142` 直接把**人类输入文本**（如"小李"）作为 employeeId 传入。FK 拒绝后报错被 `wx.cloud.callFunction` reject → 顾客看到中文 SQL 错误 / 整个绑店事务回滚。
- 风险：
  - 资损：与 audit-04 P0-04-01 联合 → 若启用基于 promoter_employee_id 的提成自动归属（spec 已定，代码未实现），离职员工 / 跨店员工 / 非员工角色可被冒充为推广源
  - 数据脏：promoter_employee_id 写入"小李""老板"等中文文本 → DB FK 兜底报 23503 但事务回滚，整个 bindStore 失败 → 顾客无法绑店
  - 业绩归属错位：管理后台 `customer-detail` 反查 `promoterEmployeeId` 显示离职员工姓名作为推广源（无 is_resigned 提示）
- 复现：1) 顾客在 client 选门店；2) "推荐人姓名（选填）"输入"FY-260101-9999"（不存在员工）→ FK 拒绝整个 UPDATE → bindStore 失败；3) 输入有效但已离职的 employeeId → 绑定成功，离职员工被永久标记为推广人。
- 修复：(L3 clientApi/routes/auth.js)
  ```js
  if (promoterEmployeeId) {
    const empRow = await pg.query(
      `SELECT employee_id, is_resigned, store_id, position_name
       FROM staff_wechat_users WHERE employee_id = $1`,
      [promoterEmployeeId]
    )
    if (!empRow.length) {
      throw new Error('INVALID_PARAMS: 推荐人员工不存在')
    }
    if (empRow[0].is_resigned) {
      throw new Error('INVALID_PARAMS: 推荐人已离职')
    }
    // 业务规则：推广员必须属于绑店所在门店
    if (empRow[0].store_id !== storeId) {
      throw new Error('INVALID_PARAMS: 推荐人不属于该门店')
    }
    params.push(promoterEmployeeId)
    setClauses.push(`promoter_employee_id = $${params.length}`)
  }
  ```
  + 同步把 `staffWechatUsers` schema 增加 `idx_staff_users_store_position` 索引覆盖该校验

#### **[P0-25-02]** client UI 字段错位：`promoterName`（文本姓名）当 `promoterEmployeeId` 提交（用户体验崩坏）
- 文件：`fengyu-client/miniprogram/pagesStore/store-detail/store-detail.ts:142` + `.wxml:160-167`
- 现象：
  - WXML "推荐人姓名（选填）" `<van-field>` 收集**人类可读字符串**进入 data.promoterName
  - TS `onConfirmBind` 行 142 直接 `promoterEmployeeId: promoterName || undefined`
  - 后端字段名 `promoterEmployeeId` 实际是员工编号（`FY-YYMMDD-NNNN` 格式，schema 行 45 长度限制 30），而非姓名
  - 与 admin 端 `customer-detail-page.tsx:539-544` 通过 `searchEmployees` 异步搜索精确选 `emp.employeeId` 形成两端**完全相反**的语义
- 风险：
  - 100% 路径下顾客输入姓名"张三"→ 后端 FK 校验失败 → bindStore 报 23503 → 整个绑店流程被推荐人字段拖垮
  - 即使纯空（用户跳过推荐人）也是常态，但一旦输入即失败 → UX 灾难
  - 与 audit-13 / audit-19 同模式："前端 UI 设计与后端字段语义错位"（CC8 WXML/Vant 一致性）
- 复现：1) 真实顾客绑店输入"美容师小张"；2) bindStore 失败但 Toast 仅显示"绑定失败"无具体原因；3) 顾客重试 N 次仍失败；4) 改成空才成功。
- 修复：(L9 client miniprogram 二选一)
  - **选项 A（推荐）**：改 UI 为美容师选择器（与 admin 同模式），调用新增 `clientApi.staff.search?storeId=$boundStoreId&keyword=...`，返回 `{employeeId, name, position}` 数组，顾客选择后传 employeeId
  - **选项 B（最小改动）**：把字段重命名为 `promoterName: string`（仅记录文本，不参与业绩），新增列 `client_wechat_users.promoter_name varchar(50)` 替代当前 promoter_employee_id 写入路径；同时保留 promoter_employee_id 留给 admin 后台精确绑定

#### **[P0-25-03]** admin `searchEmployees` 推广员选择器零 scope（跨集团 PII 暴露 + 跨店推广人）
- 文件：`fengyu-admin/src/actions/employees.ts:73-102`
- 现象：
  ```ts
  export async function searchEmployees(keyword: string) {
    const session = await getSession()
    requirePermission(session, 'customer:update')   // ← 仅查权限，不查 scope
    // ...
    return db.select({...}).from(staffWechatUsers)
      .where(and(
        eq(staffWechatUsers.isResigned, false),
        or(ilike(name, pattern), ilike(phone, pattern))
      ))
      // ⚠ 完全无 scopeCondition(session, staffWechatUsers.storeId)
      .limit(20)
  }
  ```
  - 任何拥有 `customer:update` 权限的用户（manager / customer_mgr）即可输入任意姓氏关键字模糊搜索全集团所有在职员工
  - 返回字段含 `phone`（admin UI customer-detail-page 行 517 显示 `${name} (${phone})`）→ PII 暴露
  - 同模块同文件 `getEmployees`（行 52-67）正确加了 `scopeCondition(session, staffWechatUsers.storeId)` ✅，**双轨实现**
- 风险：
  - PII 越权：店长 store-X 输入"李"可获取全国所有姓李的员工 phone（CC6 命中）
  - 跨店推广员：店长 store-X 把 store-Y 的美容师设为本店顾客的推广人 → 业绩归属错位（如未来启用 promoter 自动提成）
- 复现：1) 用 manager 角色登录（绑店 store-X）；2) 进任意顾客详情→编辑→推荐人输入"王"；3) 返回结果含其他门店姓王的所有员工。
- 修复：(L7 admin/actions/employees.ts)
  ```ts
  export async function searchEmployees(keyword: string, customerStoreId?: string) {
    const session = await getSession()
    requirePermission(session, 'customer:update')
    const trimmed = keyword.trim()
    if (!trimmed) return []
    const pattern = `%${trimmed}%`
    const conditions: SQL[] = [
      eq(staffWechatUsers.isResigned, false),
      or(ilike(staffWechatUsers.name, pattern), ilike(staffWechatUsers.phone, pattern))!,
    ]
    // 推广员必须在客户绑店内（业务规则）
    if (customerStoreId) {
      conditions.push(eq(staffWechatUsers.storeId, customerStoreId))
    }
    // 非 admin 用户额外按 session scope 过滤
    const scopeC = scopeCondition(session, staffWechatUsers.storeId)
    if (scopeC) conditions.push(scopeC)
    return db.select(...).from(staffWechatUsers).where(and(...conditions)).orderBy(...).limit(20)
  }
  ```
  + 调用方 `customer-detail-page.tsx:167` 传 `customer.boundStoreId` 作为第二个参数
  + 隐藏 phone 字段或脱敏中间 4 位（CC6）

#### **[P0-25-04]** admin `updateCustomer` 改 promoterEmployeeId 不校验员工存在 / 在职 / 同店 / 角色（信任前端）
- 文件：`fengyu-admin/src/actions/customers.ts:395-473`
- 现象：
  - `updateCustomer` 入参 `promoterEmployeeId: string | null`（行 412），直接 `db.update(...).set(data as any)`（行 453）
  - 完全无 server 端 `SELECT staffWechatUsers WHERE employee_id=$1 AND is_resigned=false` 校验
  - 同模块 `boundEmployeeId` 变更分支（行 428-437）有补 `boundEmployeeName` 冗余字段（虽然只查 name 不查 is_resigned），promoterEmployeeId **完全未做**
  - Zod `customerSchema` 行 131 仅 `customerSource: z.string().optional().nullable()`，未校验 10 值集合；同样 promoter 完全无 schema 项（行 124-141 整个 schema 没声明 promoterEmployeeId）
- 风险：
  - 后端不重算前端值（CC4 命中）：恶意 admin / 前端 BUG 写入任意字符串到 promoter_employee_id（FK 兜底但 FK 同 P0-25-01 不感知 is_resigned）
  - 数据漂移：promoter 离职后历史记录无任何提示，admin UI 反查 `employees.find(e=>e.employeeId===customer.promoterEmployeeId)?.name`（行 159）当 employees 列表只查在职时，离职 promoter 显示为"未知员工"
  - customerSource 同样不校验：传入"小红书"（不在 10 值内）会被 PG enum 兜底拒绝（22P02），但错误前缀不规范（CC5）
- 修复：(L7 admin/actions/customers.ts updateCustomer 增校验段)
  ```ts
  if (data.promoterEmployeeId !== undefined && data.promoterEmployeeId !== null) {
    const { staffWechatUsers } = await import('@db/user')
    const [emp] = await db.select({
      employeeId: staffWechatUsers.employeeId,
      isResigned: staffWechatUsers.isResigned,
      storeId: staffWechatUsers.storeId,
    })
      .from(staffWechatUsers)
      .where(eq(staffWechatUsers.employeeId, data.promoterEmployeeId))
      .limit(1)
    if (!emp) return { success: false, message: '推荐人员工不存在' }
    if (emp.isResigned) return { success: false, message: '推荐人已离职，请选择其他' }
    // 选项：是否要求 promoter 在客户绑店内？需 PM 确认
    // const [before2] = await db.select({ boundStoreId: clientWechatUsers.boundStoreId }).from(...).where(eq(.userId, userId))
    // if (before2.boundStoreId !== emp.storeId) return ...
  }
  if (data.customerSource && !customerSourceEnum.enumValues.includes(data.customerSource as any)) {
    return { success: false, message: '无效的来源渠道' }
  }
  ```
  + Zod schema 改 `customerSource: z.enum(customerSourceEnum.enumValues).optional().nullable()` + 加 `promoterEmployeeId: z.string().optional().nullable()`

#### **[P0-25-05]** 推广员业绩归属机制完全缺失（spec 暗示存在 / 代码 0 处实现）
- 文件：spec `.42cog/pm/staff.pr.spec.md` "营业额分配"章节 + `db/schema/order.ts` sale_allocations + `staffApi/routes/staff.js performanceDetail`
- 现象：
  - schema `clientWechatUsers.promoterEmployeeId`（行 44-45）注释"推荐人（美容师员工ID）"暗示业务上是**推广业绩归属源**
  - PLAN §2 行 97 域 25 检查点："**推广员业绩归属、来源渠道枚举完整性、推广员变更追溯**"
  - 实际代码：grep `promoter` 全仓 staffApi/routes/* + payNotify/* + admin/src/actions/* 业绩相关路径 → **0 命中**
  - performanceDetail / dashboard / sa.suggest / sa.save / sa.pendingList / commission_rate_matrix 全部仅以 `sa.employee_id` 计提成
  - 推广员"贡献"在系统里**仅作为顾客档案标签**，不计任何业绩 / 提成 / 看板指标
  - 与"分享礼"机制（基于 inviter_user_id 顾客互推）逻辑独立，运营理念冲突：分享礼是顾客→顾客，推广员是员工→顾客，但代码只实现前者
- 风险：
  - 业务能力空缺：销售/市场部门期望"地推卡渠道员工"或"老带新员工"获得推荐顾客的业绩分成 → 当前必须手工在 sa.suggest / sa.save 时再次输入员工 ID（与 promoterEmployeeId 字段重复劳动）
  - spec / schema / 代码三段断裂（CC9 命中）：promoter 字段写入路径（client/admin）齐全，但读出/消费路径完全空白
- 复现：跑下面 §7 SQL #4 / #5 — 对所有有 promoter_employee_id 的顾客订单，验证 sale_allocations 中是否有以 promoter 为 employee_id 的行 → 大概率返回 0%。
- 修复：(L0+L3+L7 三层联动)
  - **L0 schema** 决策：是否扩展 sale_allocations 加 `is_from_promoter boolean`，或 sales_category 枚举加 "推广引流"
  - **L3 staff allocation.suggest** 在新单 saleItem 的"建议分配"中，若该顾客有 promoter_employee_id 则自动加一行 `roleType='推广师', employeeId=promoter, allocationRatio=0.05`（默认 5%，可配置）
  - **L3 payNotify.handleSuccess** 在写 sa 时同步检查 promoter，按矩阵比例补行
  - **L7 admin commission rate matrix** 添加 "推广引流" sales_category 的 default rate
  - **L3 mgmt-traffic.summary** 增 section "推广员排行" — 按 promoter_employee_id 聚合本周期顾客数 / 实付额 / 转化新会员数
  - 见 SCHEMA-CHANGES S25-1 / S25-2

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-25-06]** `bindStore` 后续覆盖：`promoterEmployeeId` / `customerSource` 可被任意次重写（无 first-time-only 守卫）
- 文件：`clientApi/routes/auth.js:240-253`
- 现象：与同函数 `inviter_user_id` 的"仅当 IS NULL 时写入"（行 271）形成对照，promoter / source 没有这层守卫：
  ```js
  if (sourceChannel) { setClauses.push(`customer_source = $${params.length}`) }
  if (promoterEmployeeId) { setClauses.push(`promoter_employee_id = $${params.length}`) }
  ```
  顾客每次进 store-detail 重新 bindStore（如换绑门店 / 重选门店），就重新选来源渠道 + 推广员。后写覆盖前写，无变更日志。
- 风险：
  - 业绩归属可被顾客自助修改（与 audit-19 P0-19-05 inviter 防自邀套利同模式但更宽松）
  - 推广员变更追溯缺失（PLAN 检查点要求"推广员变更追溯"）：grep operation_logs 写入路径 → bindStore 完全不写 operation_logs
  - 与 P0-25-05 联合放大：未来若启用 promoter 自动提成，顾客可在每次下单前换推广员套现
- 修复：(L3) 二选一
  - 严格首绑：`promoter_employee_id IS NULL` + `customer_source IS NULL` 时才写
  - 允许变更但加审计：UPDATE 前 SELECT 旧值，写 operation_logs(`action='customer.changePromoter', detail={from, to}`)；管理后台保留改写权限即可

#### **[P1-25-07]** `inviterUserId` 仅前缀校验 + 静默吞错（retain audit-19 P0-19-05，本域 P1 因加重前提）
- 文件：`clientApi/routes/auth.js:255-278`
- 现象：(已在 audit-19 详记) `startsWith('FYGK-')` + EXISTS + 自邀 CHECK + try/catch console.warn 静默吞错。
- 本域加重维度：
  - 与 P0-25-01 (promoter 零校验) **同事务**执行；任一失败可能引起静默状态偏移
  - 与 audit-04 payNotify 无签名 + share-gift 自动发券联动 → 资损放大（已记 audit-19）
  - inviter（顾客→顾客）vs promoter（员工→顾客）两套独立机制并存，运营容易混淆"该用谁"
- 修复：见 audit-19 §3.1 P0-19-05 修复方案

#### **[P1-25-08]** customerSource 三端硬编码 10 值，添加新渠道需三处同步（spec 漂移高危）
- 文件：
  - DB enum：`db/schema/enums.ts:95-106`（10 值）
  - admin UI：`customer-detail-page.tsx:619-633`（10 值 hardcode `<option>`）
  - client UI：`pagesStore/store-detail.ts:58-61 sourceGroups`（10 值 hardcode 数组）
- 现象：三端各有一份独立的 10 值"复制粘贴"。新渠道（小红书 / 视频号 / 公众号）需 schema migration + admin select + client radio-group 三处同步修改。已在 ENUM-AUDIT.md E10-customer-source 标注，本域复现。
- 风险：
  - 漂移高危：任一端漏改 → 用户在 client 选了某新渠道 → bindStore 写入 PG enum 时报 22P02 拒绝
  - 业务节奏受迁移限制（只能在 schema migration 窗口加新渠道）
- 修复：(L0 二选一)
  - 软枚举：在 system_configs 加 `customer_source_options` JSON 配置，三端共读；保留 customerSource 列为 `varchar(50)` + 应用层校验
  - 半结构化：保留 PG enum + 增加 `customer_source_other text` 列承载"其他"渠道说明
  - 见 SCHEMA-CHANGES S25-3

#### **[P1-25-09]** `mgmt-traffic` 客量统计完全不消费 customer_source / promoter_employee_id（管理层视角失焦）
- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js:1-625`
- 现象：5 section 的 SQL 维度全部是 `customer_status` / `customer_type` / `service_date` / `paid_amount` / `became_member_at` 等"行为指标"，完全不按 customer_source / promoter_employee_id 切片：
  - Section 1 注册情况：仅 customer_type 分组
  - Section 2 到店客流：customer_type ROLLUP
  - Section 4 会员被经营：spend 分桶
  - Section 5 新会员经营：count / spend 总数
- 与"流量"一词字面理解（拓客渠道效果分析）严重不符；运营若问"地推卡渠道带来多少新会员？""推广员张三本月转化率？"系统无答案。
- 风险：业务报表能力不完整；与 P0-25-05（业绩归属缺失）同源（promoter / source 字段写入了但完全没有读出口径）
- 修复：(L3 mgmt-traffic.js) 在 Section 5 后增 Section 6 "渠道经营"：按 customer_source 分组的 newMembers count / spend；Section 7 "推广员排行"：按 promoter_employee_id 分组的 顾客数 / paid_amount / 新会员转化数

#### **[P1-25-10]** customerSource 在历史顾客 / WorkFine 同步顾客上长期 NULL（无 backfill）
- 文件：—（隐含问题，建议跑 SQL #2 验证）
- 现象：customer_source 是 enum 列允许 NULL；client bindStore 仅在 sourceChannel 显式传入时写入；WorkFine 同步路径（`db/scripts/sync-workfine.js`）grep `customer_source` → 无写入（同步不维护此列）。
- 历史 WorkFine 顾客（`openid IS NULL` 或老用户）100% NULL，admin 列表筛选 `customerSource` 时这部分顾客全部不可见 → 报表偏差。
- 修复：(L7 一次性 backfill) 写 db/scripts/backfill-customer-source.ts，根据 `customer_id` 是否存在（WorkFine 同步过的）回填 `自进店`；或直接业务确认是否要新建一个 enum 值"未知"。

#### **[P1-25-11]** Zod `customerSchema` 不约束 customerSource 枚举集合（CC4 后端不重算前端值）
- 文件：`fengyu-admin/src/lib/schemas.ts:131`
- 现象：`customerSource: z.string().optional().nullable()` 接受任意字符串。`updateCustomer` 行 453 直接 `db.update(...).set(data as any)`。
- 兜底依赖 PG enum 类型校验（22P02 错误码），但错误前缀 / message 不规范（CC5），UI 可能仅显示"更新失败"。
- 修复：见 P0-25-04 修复方案

#### **[P1-25-12]** admin updateCustomer 不写 promoterEmployeeName 冗余字段（与 boundEmployeeId/Name 双轨）
- 文件：`fengyu-admin/src/actions/customers.ts:428-437`（仅 boundEmployeeId 同步 boundEmployeeName）
- 现象：schema 行 32-34 设计 `bound_employee_id` + `bound_employee_name` 冗余对，admin 在 boundEmployeeId 变更时同步写 name；**promoter_employee_id 没有对应的 promoter_employee_name 列**，admin UI 行 159 反查 employees 列表，离职 / 跨店员工查不到。
- 与 audit-19 P1-19-08 同模式（"应同步冗余 name 但忘了"）。
- 修复：(L0+L7) 加列 `promoter_employee_name varchar(50)`；admin updateCustomer 在 promoterEmployeeId 变更时同步写

---

### 3.3 P2（代码质量 / 可维护）

- **[P2-25-13]** mgmt-traffic.js 文件命名误导：所谓"流量管理"实际是"客流量数据子页"，与 PLAN §2 域 25 "流量 / 推广员"语义错位。建议重命名 `mgmt-customer-volume.js` 或 `mgmt-traffic-volume.js` 避免与"渠道流量 / 推广员"概念混淆。
- **[P2-25-14]** `clientApi/routes/auth.js:241-253` 动态 SQL 构造（setClauses + params 数组）虽参数化安全（CC1 OK），但 17 行内对同一函数堆 3 个 if 分支（store / source / promoter）+ inviter 独立段，可读性差。建议抽 helper 或分函数。
- **[P2-25-15]** `bindStore` 错误前缀混乱：`UNAUTHORIZED:` / `INVALID_PARAMS:` 都用了，但 promoter / inviter 失败完全不抛错（静默吞）。CC5 命中。
- **[P2-25-16]** `pagesStore/store-detail.ts:58-61 sourceGroups` 注释 0 行，新增渠道时维护者不知道分组规则（线上 vs 线下）从何而来。建议加 `// 与 db/schema/enums.ts:95 customerSourceEnum 保持同步` 注释。
- **[P2-25-17]** admin `customer-detail-page.tsx:151-178` 异步搜索 promoter，搜索时关键字 `promoterSearch` 与已选值 `selectedPromoter.name` 在 input value 处于 promoterOpen 状态切换时显示逻辑（行 517）复杂，键盘可访问性 / 无障碍 缺测试。
- **[P2-25-18]** `searchEmployees` 动作权限项是 `customer:update`（行 75）— 错位（搜员工应该是 `employee:list`）。CC4 命中（隐式合约）。
- **[P2-25-19]** `customerSource` 字段在 `admin/src/db/seed.ts:120-121` 写入"老带新""美团"测试数据，但生产环境 customer_source 列可能 100% NULL（依赖 client UI 主动选）→ 测试数据与生产数据分布失真。
- **[P2-25-20]** mgmt-traffic.js 行 130-143 `resolveScopeName` 直接拼字符串字面量（`'全部市场'`），本地化无能力。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| promoter 写入 | updateCustomer ✅（无校验） | — | bindStore ✅（无校验） | — | 双写无校验 | P0-25-01/04 |
| promoter 选择器 | searchEmployees 零 scope（跨集团搜索） | — | 文本 input → 直传 employeeId | — | 字段错位 + PII 暴露 | P0-25-02/03 |
| promoter 业绩消费 | — | 0 处使用 | — | 0 处使用 | spec 暗示存在但代码空缺 | P0-25-05 |
| customerSource 写入 | updateCustomer + Zod 不校验 enum | — | bindStore + 不校验 enum | — | 仅依赖 PG 兜底 | P1-25-08/11 |
| customerSource 枚举来源 | 硬编码 10 值（行 619-633） | — | 硬编码 10 值（sourceGroups） | — | 三处复制粘贴 | P1-25-08 |
| inviter 校验 | — | — | 前缀 + EXISTS + 静默吞错 | 触发 share-gift 发券 | retain audit-19 P0-19-05 | P1-25-07 |
| 变更追溯 | logUpdate diff 通用 ✅ | — | bindStore 不写 operation_logs | — | client 路径无审计 | P1-25-06 |
| 客量数据子页 | — | mgmt-traffic 5 section ✅ | — | — | 不切 promoter / source | P1-25-09 |
| Zod schema | customerSource 用 z.string()（不限 enum）| — | — | — | 信任前端 | P1-25-11 |
| name 同步 | bound_employee_name 冗余 ✅ / promoter_employee_name 无 ❌ | — | — | — | 双轨 | P1-25-12 |
| WorkFine 同步 | — | — | — | — | customer_source 不维护 | P1-25-10 |

---

## 5. 横切检查（套用 §3 模板）

- [x] **CC1 数值精度**：本域不涉及金额计算（promoter 仅是身份字段）
- [ ] **CC2 并发幂等**：bindStore 重写 promoter / source 无 first-time guard 与无 operation_logs；与 P0-19-05 inviter 协同的事务模型未明（promoter UPDATE + inviter UPDATE 不在一个 transaction，部分失败可能产生 inviter 写入 / promoter 未写入的混合状态）→ P1-25-06
- [ ] **CC3 组织域数据隔离**：admin searchEmployees 零 scope（P0-25-03）；staff routes 完全不消费 promoter 字段所以无 scope 漏洞但**也意味着没有跨店推广员的合理性校验**
- [ ] **CC4 后端鉴权**：admin updateCustomer + Zod 不校验 customerSource enum（信任前端）→ P1-25-11；admin searchEmployees 用 'customer:update' 权限项，与"搜员工"语义错位 → P2-25-18
- [ ] **CC5 错误码**：bindStore promoter / inviter 路径全部 console.warn 静默吞错 + 无前缀 → P1-25-07 / P2-25-15
- [ ] **CC6 PII**：admin searchEmployees 返回 phone 字段（customer-detail-page.tsx 行 517 显示），跨集团模糊搜索可批量收集员工 phone → P0-25-03
- [x] **CC7 时间字段**：bindStore 写入 `updated_at = NOW()` ✅；inviter 写 `invited_at = NOW()` ✅
- [ ] **CC8 WXML/Vant**：client store-detail.wxml `<van-radio-group>` + `<van-field>` 用法标准；但语义错位（promoterName 当 employeeId 传）→ P0-25-02
- [ ] **CC9 测试与残留**：
  - `actions/customers.test.ts:388/559` 仅赋 null，未覆盖 promoter / source 越权写入路径
  - `clientApi/__tests__/routes/auth.test.js` 仅覆盖 inviter 前缀路径，promoter / source 校验 0 用例
  - `staffApi/__tests__/routes/allocation.test.js:685` 出现 `'推广师' rate=0.1`，但 staffApi/routes/staff.js 的 sa 计算从未 group by promoter，测试断言 vs 实际行为脱节（疑似前置 spec 已写但代码未实现的"测试反向锁死"）
  - `mgmt-traffic.js` 文件命名错位（P2-25-13）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/user.ts:43-45` | 增列 `promoter_employee_name varchar(50)` 冗余字段（与 bound_employee_name 对齐） | P1-25-12 |
| L0 schema | `db/schema/order.ts sale_allocations` | 增列 `is_from_promoter boolean default false` 或 sales_category 加 "推广引流" 值 | P0-25-05 |
| L0 schema | `db/schema/enums.ts:95-106` | 评估改软枚举（system_configs.customer_source_options） | P1-25-08 |
| L0 schema | `db/schema/commission.ts` 提成矩阵 | 加 "推广引流" sales_category 默认 rate | P0-25-05 |
| L3 cloudfunctions | `clientApi/routes/auth.js:201-289 bindStore` | 加 promoter is_resigned/store_id 校验 + first-time guard + operation_logs | P0-25-01 / P1-25-06 |
| L3 cloudfunctions | `staffApi/routes/allocation.js suggest` | 检查 promoter，自动加 "推广师" 行（默认 5%） | P0-25-05 |
| L3 cloudfunctions | `payNotify/index.js handleSuccess` | 写 sa 时若 promoter 存在补一行 | P0-25-05 |
| L3 cloudfunctions | `staffApi/routes/mgmt-traffic.js summary` | 加 Section 6 "渠道经营" + Section 7 "推广员排行" | P1-25-09 |
| L3 cloudfunctions | `clientApi/__tests__/routes/auth.test.js` | 补 promoter 不存在/已离职/跨店 三类用例 | P0-25-01 |
| L7 admin | `actions/employees.ts:73-102 searchEmployees` | 加 customerStoreId 参数 + scopeCondition + 隐藏 phone | P0-25-03 |
| L7 admin | `actions/customers.ts:395-473 updateCustomer` | 加 promoter is_resigned 校验 + customerSource enum 校验 + 同步 promoter_employee_name | P0-25-04 / P1-25-11 / P1-25-12 |
| L7 admin | `lib/schemas.ts:124-141 customerSchema` | `customerSource: z.enum(...)` + 加 `promoterEmployeeId: z.string().optional()` | P1-25-11 |
| L9 client | `pagesStore/store-detail/store-detail.ts:130-156 onConfirmBind` | 改 promoter 为美容师选择器（替代纯文本输入） | P0-25-02 |
| L9 client | `pagesStore/store-detail/store-detail.wxml:160-167` | 改 `<van-field>` 为美容师 picker | P0-25-02 |
| 数据治理 | `db/scripts/backfill-customer-source.ts`（新增） | WorkFine 历史顾客 customer_source backfill | P1-25-10 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (1) 验证 P0-25-01：promoter 离职员工被绑定的脏数据范围
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
-- 预期：若有非空但非 FY- 前缀，是中文姓名 / 旧 ID 残留

-- (4) 验证 P0-25-05：promoter 顾客的销售订单是否在 sale_allocations 中体现 promoter
WITH promoter_customers AS (
  SELECT user_id, promoter_employee_id FROM client_wechat_users
  WHERE promoter_employee_id IS NOT NULL
)
SELECT pc.promoter_employee_id,
       COUNT(DISTINCT o.sale_order_id) AS orders_count,
       SUM(CASE WHEN sa.employee_id = pc.promoter_employee_id THEN 1 ELSE 0 END) AS sa_with_promoter,
       SUM(CASE WHEN sa.employee_id IS NOT NULL AND sa.employee_id <> pc.promoter_employee_id THEN 1 ELSE 0 END) AS sa_other_employee
FROM promoter_customers pc
JOIN sale_orders o ON o.client_user_id = pc.user_id AND o.status='已支付'
LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
LEFT JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id AND sa.is_void=false
GROUP BY pc.promoter_employee_id
HAVING SUM(CASE WHEN sa.employee_id = pc.promoter_employee_id THEN 1 ELSE 0 END) = 0
LIMIT 50;
-- 预期：所有 promoter 都不在自己推广顾客的 sa 中（业绩零归属）

-- (5) 验证 P1-25-08：customer_source 分布
SELECT customer_source, COUNT(*) AS cnt
FROM client_wechat_users
GROUP BY customer_source
ORDER BY cnt DESC;

-- (6) 验证 P0-25-03：admin searchEmployees 跨集团搜索潜在数据范围
SELECT COUNT(DISTINCT store_id) AS unique_stores,
       COUNT(*) FILTER (WHERE is_resigned=false) AS active_employees,
       COUNT(*) AS total_employees
FROM staff_wechat_users;
-- 预期：存在 N 个店 × M 名员工，均可被任意 manager 搜到

-- (7) 验证 P1-25-06：promoter / source 是否被多次重写（无审计无法直接证明，间接看 updated_at vs created_at 差异）
SELECT user_id, customer_source, promoter_employee_id, created_at, updated_at,
       (updated_at - created_at) AS lifetime,
       last_login_at
FROM client_wechat_users
WHERE promoter_employee_id IS NOT NULL
  AND updated_at > created_at + INTERVAL '1 day'
ORDER BY (updated_at - created_at) DESC
LIMIT 50;
-- 预期：能看到 promoter 字段长期被反复修改但无审计依据
```

---

## 8. 回归测试用例（建议）

1. **client bindStore promoter 不存在/离职/跨店**：1) 传不存在 employeeId → INVALID_PARAMS；2) 传已离职 → INVALID_PARAMS；3) 传 store-X 员工但 storeId=store-Y → INVALID_PARAMS。
2. **client bindStore promoter first-time guard**：首次设置成功；二次提交不同 promoter → 拒绝（或写 operation_logs）。
3. **admin searchEmployees scope**：用 manager(store-X) 调用 → 只返回 store-X 员工；admin 调用 → 全集团；非 admin 调用且不传 customerStoreId → 仅 session scope；传不在 scope 的 customerStoreId → 拒绝。
4. **admin updateCustomer customerSource 非 enum**：传"小红书"→ 拒绝（业务前的 Zod / enum 校验，而非 PG 22P02）。
5. **admin updateCustomer promoter 离职**：传已离职 employeeId → 拒绝。
6. **mgmt-traffic Section 6 渠道经营**：插一批 `customer_source='美团'` + `customer_source='抖音'` 的新会员，调 summary period='month' → 渠道经营段 美团 vs 抖音 count/spend 正确。
7. **mgmt-traffic Section 7 推广员排行**：插 promoter 关联顾客订单 → 该 promoter 顾客数 / paid_amount 正确聚合。
8. **payNotify share-gift inviter vs promoter 双源不冲突**：同一 invitee 既有 inviter 又有 promoter，share-gift 仅基于 inviter 触发；如果未来加 promoter 触发，需独立测试避免双发。
9. **customer 详情页 PII 检查**：admin 用最低权限角色（hr） →  promoter / source 字段是否仅返回 employeeId 不返回 phone（CC6）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（promoter 离职数据回填 / customer_source NULL 回填）
- 修复成本：**M-L**（P0-25-05 业绩归属机制是新功能，需 PM 决策；其他 P0 都是补校验）

---

## 10. 后续待办

- [ ] 与 PM 对齐"推广员业绩归属"是否启动（P0-25-05）：是 → 走 ticket-2026-04-XX-promoter-commission；否 → schema 加注释明确"仅档案标签不参与业绩"，并把 mgmt-traffic 的"推广员排行"作为信息性指标（不挂提成）
- [ ] 与 audit-19 P0-19-05 (inviter 防套利) 合并修复 ticket（同 bindStore 路径）
- [ ] 评估 customer_source enum 改软（system_configs）的迁移成本（涉及 admin filter、mgmt-traffic 后续 Section 6、client UI radio-group）
- [ ] 把 mgmt-traffic.js 重命名为 mgmt-customer-volume.js（避免与本域名"流量/推广员"混淆）
- [ ] 与 audit-13 / audit-19 同模式归集"前端 UI 文本字符串错传后端 ID 类字段"（P0-25-02 + audit-13 face_value_override 接近模式）
- [ ] 数据治理：跑 §7 SQL #1 / #3 / #5 评估存量脏数据，写一次性回填 / 清洗脚本

---

返回完毕。
