# 审计报告：门店绑定 / 解绑申请流 (12)

**审计时间**：2026-04-25 15:30
**域 ID**：12
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

---

> ### ✅ 2026-05-17 复核状态
>
> | 问题 ID | 原状态 | 2026-05-17 复核 |
> |---------|--------|-----------------|
> | **P0-12-01** client requestUnbind 写不存在的 `from_store_name` 列 | 未修复 | ✅ **已修复** — `clientApi/routes/store.js:156` 已改用 `from_store_id`；ticket `2026-04-27-client-requestUnbind-from-store-name.md` 归档 |
> | 其余 P0/P1 | — | 未复核 |

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/store-unbind.ts:6-21` (storeUnbindRequests) + `db/schema/user.ts:30 boundStoreId` | ↑ | ↑ |
| Enum | `db/schema/enums.ts:72-77` storeUnbindRequestStatus 4 值 | ↑ | ↑ |
| 首次绑定 | `(main)/stores/_components/stores-page.tsx`（仅创建/编辑门店） | — | `clientApi/routes/auth.js:201-290 bindStore` |
| 申请提交 | — | — | `clientApi/routes/store.js:138-162 requestUnbind` |
| 申请查询 | `actions/store-unbind.ts:26-57 getUnbindRequests` | `staffApi/routes/store.js:39-69 unbindRequests` | `clientApi/routes/store.js:167-192 getUnbindRequest` |
| 取消申请 | — | — | `clientApi/routes/store.js:198-219 cancelUnbindRequest` |
| 审批通过 | `actions/store-unbind.ts:59-107 approveUnbind` | `staffApi/routes/store.js:75-106 approveUnbind` | — |
| 审批拒绝 | `actions/store-unbind.ts:109-152 rejectUnbind` | `staffApi/routes/store.js:112-136 rejectUnbind` | — |
| 待办计数 | — | `staffApi/routes/staff.js:367-371` (`pendingUnbindCount`) | — |
| 逆地理 | — | — | `clientApi/routes/store.js:225-261 geocode` |
| 测试 | `actions/store-unbind.test.ts` (60+ 用例) | `__tests__/routes/store.test.js` (12 用例) | `__tests__/routes/store.test.js` (20 用例) |
| 入口路由 | `(main)/store-unbind/page.tsx` + `(main)/stores` Tab | `requireManager()` 守卫 | `auth()` 默认中间件（无 `requirePhone`） |

---

## 2. 数据流图

```
client.requestUnbind  → INSERT store_unbind_requests(status='待处理')   [P0-12-01: 写不存在的 from_store_name 列]
                      ↓
client.getUnbindRequest  → SELECT pending（client 自查）              [P0-12-01: 同样读不存在的 from_store_name]
                      ↓
staff.unbindRequests  → SELECT WHERE from_store_id=$storeId AND status='待处理'
                      ↓
                 ┌──────────────┴──────────────┐
                 ↓                             ↓
   staff.approveUnbind                staff.rejectUnbind        client.cancelUnbindRequest
   pg.transaction:                    UPDATE status='已拒绝'    UPDATE status='已取消'
     UPDATE bound_store_id=NULL       reject_reason=$2          [无 CAS / 无事务]
     UPDATE status='已通过'            [无 CAS]
   [bound_employee_id 残留]
   [无 operation_logs 写入]
                 ↑ 双路径
   admin.approveUnbind / rejectUnbind
   (drizzle tx + logTransition)        [bound_employee_id 已清，与 staff 不一致]
```

`auth.bindStore`（首次/换绑）独立路径：直接 `UPDATE bound_store_id=$1`，**不要求** `bound_store_id IS NULL`，可在已绑定状态下覆盖换店，**绕过整个解绑申请流**（P0-12-02）。

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### **[P0-12-01]** client.requestUnbind / getUnbindRequest / 测试夹具同时使用不存在的 `from_store_name` 列 → 顾客解绑流 100% 不可用

- **文件**：
  - `fengyu-client/cloudfunctions/clientApi/routes/store.js:155-159`（INSERT 写 `from_store_name`）
  - `fengyu-client/cloudfunctions/clientApi/routes/store.js:175-176`（SELECT 读 `from_store_name`）
  - `fengyu-client/cloudfunctions/clientApi/routes/store.js:186`（返回 fromStoreName 字段）
  - `fengyu-client/cloudfunctions/clientApi/__tests__/routes/store.test.js:111`（mock 用 `from_store_name`）
- **现象**：`store_unbind_requests` 表权威列定义 `from_store_id text NOT NULL`（`db/schema/store-unbind.ts:11-13` + `db/migrations/0000_baseline.sql:347-358`）；客户端 `requestUnbind` 的 INSERT 语句却写：
  ```sql
  INSERT INTO store_unbind_requests (request_id, user_id, from_store_name, status, note)
  VALUES ($1, $2, $3, '待处理', $4)
  ```
  - 列 `from_store_name` 不存在 → PG `42703 column "from_store_name" of relation "store_unbind_requests" does not exist`
  - 即使 PG 容忍（不会容忍），`from_store_id NOT NULL` 约束也会触发 `23502`
  - 同模块 `getUnbindRequest`（line 175）SELECT 也读 `from_store_name`，永远抛错
  - 测试夹具 mock `from_store_name` 让单元测试假绿，**测试反向锁死了 P0 错误代码**（同 audit-08 §5 CC9 反模式）
- **风险**：顾客端"申请解绑门店"按钮 100% 不可用；用户提交后看到 "INVALID_PARAMS: 服务器内部错误" 通用提示（不在错误前缀白名单），无任何方式自助解绑。该域**生产环境完全失效**。
- **复现**：
  1. 顾客在 `pages/me/index` 点击"申请解绑"
  2. 调 `wx.cloud.callFunction({name:'clientApi', data:{action:'store.requestUnbind', payload:{note:'搬家'}}})`
  3. 云函数日志：`column "from_store_name" of relation "store_unbind_requests" does not exist`
  4. UI toast 显示 "服务器内部错误"
- **修复**（L3）：
  ```javascript
  // store.js:155-159
  await pg.query(
    `INSERT INTO store_unbind_requests (request_id, user_id, from_store_id, status, note)
     VALUES ($1, $2, $3, '待处理', $4)`,
    [requestId, userId, boundStoreId, note || null]
  )
  // store.js:174-180 同步改 SELECT 加 LEFT JOIN stores 取 store_name
  ```
- **关联**：测试夹具同步修，否则 P 0 修复后单测全红

---

#### **[P0-12-02]** auth.bindStore 不校验 `bound_store_id IS NULL`，可静默覆盖换店绕过解绑申请流（real.md #4 状态单向推进违背）

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:201-290`
- **现象**：业务流"顾客换店必须先解绑"由 `store_unbind_requests` 流转保证。但 `auth.bindStore`：
  ```javascript
  // auth.js:239
  const setClauses = ['bound_store_id = $1', 'updated_at = $2']
  // 无 WHERE bound_store_id IS NULL 兜底
  await pg.query(
    `UPDATE client_wechat_users SET ${setClauses.join(', ')} WHERE user_id = $${params.length}`,
    params
  )
  ```
  且 `requestUnbind` 入口校验 `if (!boundStoreId)`，意味着**已绑定状态下** bindStore 直接覆盖 → 顾客无需经过店长审批即可任意切换门店；解绑申请流被完全绕过。
- **风险**：
  1. 绕过审批：顾客可在 client 任意切换门店，店长完全不知情
  2. 跨店数据归属错乱：原门店历史订单 / 服务单 / 提成 / 储值卡（按 client_user_id + 当前 bound_store_id）归属新店统计
  3. 顾客可与"竞争分配"的美容师串通跨店换绑套利
  4. 状态机硬约束 #4 违背：`bound_store_id` 不应在持有 pending 申请时被另一路径改写
- **复现**：
  1. 顾客 A 已绑定门店 X
  2. 直接调 `auth.bindStore({storeId:'Y'})`，无任何错误
  3. `bound_store_id` 静默从 X 翻到 Y，无操作日志，店长 X / Y 都不知情
- **修复**（L3）：
  ```javascript
  // auth.js bindStore 加守卫
  if (users[0].bound_store_id && users[0].bound_store_id !== storeId) {
    throw new Error('PERMISSION_DENIED: 已绑定门店，请先发起解绑申请')
  }
  // 或加 SQL 兜底：UPDATE ... WHERE user_id=$X AND (bound_store_id IS NULL OR bound_store_id=$1)
  ```
- **关联**：real.md #4 状态单向 / #6 组织域隔离

---

#### **[P0-12-03]** 三端 `bound_store_id` 清空时机不一致：staff approveUnbind 不清 `bound_employee_id`，admin 清

- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:92-103`（仅 UPDATE `bound_store_id = NULL`）
  - `fengyu-admin/src/actions/store-unbind.ts:92-95`（UPDATE `boundStoreId: null, boundEmployeeId: null`）
- **现象**：解绑后顾客的"绑定美容师"残留语义：
  - staff 路径：`UPDATE client_wechat_users SET bound_store_id = NULL`，`bound_employee_id` / `bound_employee_name` / `promoter_employee_id` / `customer_source` 完全不动
  - admin 路径：`UPDATE ... SET boundStoreId: null, boundEmployeeId: null`（清两列）
  - 同一资源、同一审批语义、两个 SoT；并且都没清 `bound_employee_name`（admin schema 含此列但 action 漏清）
- **风险**：
  1. 数据不一致：审批员选 staff 还是 admin 入口，最终 DB 状态不同
  2. 顾客解绑后再次 bindStore 到 Y 店时，`bound_employee_id` 仍是原 X 店员工 → 服务分配 / 业绩计算把新店服务分到老员工
  3. promoter_employee_id / customer_source / inviter_user_id 全部残留，新店 customer_source 错认
- **修复**（L3 + L7）：抽 helper `helpers/unbind-customer.js`，统一清空字段集合 `{boundStoreId, boundEmployeeId, boundEmployeeName, customerSource, promoterEmployeeId, inviterUserId, invitedAt}`；staff / admin 共调

---

#### **[P0-12-04]** staff approveUnbind / rejectUnbind / client cancelUnbindRequest **三端均无 CAS**（status 状态机崩坏 + 双写资金风险）

- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:97-102`（UPDATE WHERE 仅 request_id）
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:128-132`（同上）
  - `fengyu-client/cloudfunctions/clientApi/routes/store.js:213-216`（同上）
  - `fengyu-admin/src/actions/store-unbind.ts:84-90` / 132-141（drizzle UPDATE 也仅 WHERE requestId）
- **现象**：所有状态翻转都是 SELECT-then-UPDATE 模式，事务外读 status，事务内 UPDATE 不带 `AND status='待处理'` CAS：
  ```javascript
  // staffApi/routes/store.js
  const rows = await pg.query(`SELECT ... FROM store_unbind_requests WHERE request_id = $1`, [requestId])
  if (req.status !== '待处理') throw ...
  await pg.transaction(async (client) => {
    await client.query(`UPDATE client_wechat_users SET bound_store_id = NULL ...`)
    await client.query(`UPDATE store_unbind_requests SET status = '已通过' WHERE request_id = $2`)  // ← 无 status CAS
  })
  ```
- **风险**：
  1. 顾客 cancel 与店长 approve 并发：两者都看到 `'待处理'`，都进 UPDATE，最终 status 取决于 commit 顺序；若 approve 先到 → 顾客 cancel 把已通过翻回 已取消 + bound_store_id 已经为 NULL
  2. 同申请两个店长并发 approve：`bound_store_id = NULL` 重复执行幂等，但 `reviewed_by` 被晚到的覆盖；审计追溯断裂
  3. real.md #4 状态单向推进违背：终态可被覆盖
- **修复**（L3 + L7）：UPDATE 加 `WHERE request_id=$1 AND status='待处理'`，校验 `result.rowCount === 1`；rowCount=0 时回滚事务并返回 "申请状态已变化"

---

#### **[P0-12-05]** 同一顾客无 partial UNIQUE，依赖事务外 SELECT 防重 → 并发可写多行 pending（real.md #7 业务等价：同一顾客同一时间 ≤1 pending）

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/store.js:146-153`
- **现象**：`requestUnbind` 用：
  ```javascript
  const existing = await pg.query(
    `SELECT request_id FROM store_unbind_requests WHERE user_id = $1 AND status = '待处理'`,
    [userId]
  )
  if (existing.length > 0) throw new Error('INVALID_PARAMS: 已有待审批的解绑申请...')
  // ...事务外 INSERT
  await pg.query(`INSERT INTO store_unbind_requests ...`, [...])
  ```
  - SELECT-then-INSERT 模式无锁；DB 也无 partial unique 索引兜底
  - schema (`db/schema/store-unbind.ts:6-21`) 无任何复合 unique
- **风险**：
  1. 顾客双击 / 重试 / 弱网下并发提交两次：两个进程都 SELECT empty → 都 INSERT → DB 出现两条 pending 行
  2. staff `unbindRequests` 列表展示重复申请；approve 一条另一条仍是 pending → 顾客在 client 看到 "已有 pending 申请" 但 store_X 店长已审批过
  3. cancel 也同样可能写多次（虽然 cancel 是 UPDATE，但若已有重复行只能 cancel 一条）
- **修复**（L0 + L3）：
  ```sql
  CREATE UNIQUE INDEX uq_store_unbind_pending
    ON store_unbind_requests (user_id)
    WHERE status = '待处理';
  ```
  + 应用层 INSERT 用 `ON CONFLICT DO NOTHING` 兜底，rowCount=0 时返回幂等 success（参考 audit-06 同模式）

---

#### **[P0-12-06]** geocode 无任何鉴权 / 频次限制 → 任何已注册用户可调，第三方 LBS API 配额可被恶意刷穷

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/store.js:225-261`
- **现象**：
  - `auth()` 中间件仅校验 OPENID 存在；geocode 走默认 auth 后无 `requirePhone()` 守卫，未注册用户（`userId: null`）仍可调
  - 路由直接读 `process.env.TMAP_KEY` / `TMAP_SECRET` 拼 sig 调腾讯地图 API
  - 无 IP 限频 / 无每日配额 / 无缓存（同坐标重复打 LBS）
  - `INVALID_PARAMS` 文案统一吞掉腾讯返回，但 `console.error('[geocode] LBS API error:', JSON.stringify(json))` 写入 cloudbase 日志（含 sig hash 与 LBS 详细错误码）
- **风险**：
  1. 配额耗尽：腾讯地图日 1 万次免费 quota（共享所有云函数）。攻击者通过 wx.cloud.callFunction 循环刷 → 顾客端门店列表"按城市筛选"功能瘫痪
  2. 资金风险：超额收费按调用计；TMAP_SECRET 一旦在异常栈被泄露，攻击者可直接绕过云函数从外网请求
  3. CC4 + CC6 双重命中：未鉴权 + 错误日志含敏感 secret hash
- **修复**（L3）：
  - 加 `requirePhone()` 守卫，至少限定登录用户
  - 加 cloudbase 同步限频（同 OPENID 60 秒内至多 5 次）
  - 同坐标内存缓存 5 分钟（坐标 round 到小数点后 3 位即可命中重用）
  - 错误日志只 `error.code`，不全 stringify

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-12-07]** staff approveUnbind / rejectUnbind / cancelUnbindRequest 全程**不写 operation_logs**（与 admin 路径不对称）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:75-136` + `fengyu-client/cloudfunctions/clientApi/routes/store.js:198-219`
- **现象**：admin 三个 action 在尾部都调 `logTransition(session, 'store_unbind.approve' / 'store_unbind.reject', ...)`（line 101 / 146）；staff 与 client 路径完全不写。
- **风险**：店长在 staff 端审批完全无审计追溯；只能从 `reviewed_by` + `reviewed_at` 反推；与 audit-23（操作日志）域要求"关键动作必写"违背
- **修复**（L3）：复用 `helpers/operation-log.js`（参考 staff order.confirmOffline 写法），或集中迁移到统一中间件

---

#### **[P1-12-08]** admin getUnbindRequests 用 `scopeCondition` 过滤，但 staff `unbindRequests` 用 `ctx.auth.storeId`（员工档案默认门店），多店店长漏申请

- **文件**：
  - `fengyu-admin/src/actions/store-unbind.ts:40` `scopeCondition(session, storeUnbindRequests.fromStoreId)`
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:42-58` `WHERE r.from_store_id = $1`（取 `ctx.auth.storeId`）
- **现象**：staff middleware 已注入 `scopeStoreIds[]`（多店店长可见多店），但 store.unbindRequests 只查 `storeId`（员工档案默认门店）。多店店长（market manager / multi-store manager）会漏看其他门店的 pending 申请。
- **关联**：CC3 第一条"middleware 注入 scopeStoreIds 但 SQL 不调用 helper"。同模式已在 audit-05/06/07/10/11 命中
- **修复**（L3）：改用 `buildStoreScopeCondition(auth, 'r.from_store_id', $n)`

---

#### **[P1-12-09]** staff approveUnbind 与 rejectUnbind 的 `effectiveStoreId` 校验同样用 `ctx.auth.storeId`，与 unbindRequests 不一致

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:78-88` + `:115-125`
- **现象**：审批权限校验 `if (req.from_store_id !== storeId)`，`storeId` 来自 `ctx.auth.storeId`（员工档案默认门店）；管理层模式登录（`loginLevel='management'`）下 `effectiveStoreId === null`，但 `storeId` 仍是员工档案 store_id —— 用错字段。
- **风险**：管理层（市场 / 总部）店长无法跨店审批；多店店长仅能审批默认门店的申请
- **修复**（L3）：改用 `ctx.auth.scopeStoreIds.includes(req.from_store_id)`；管理层 `effectiveStoreId=null` 时也能命中

---

#### **[P1-12-10]** rejectUnbind reject_reason 在 staff 端无必填校验，admin 端前端必填但后端可空

- **文件**：
  - admin 前端 `store-unbind-page.tsx:65-67` 校验 `!rejectReason.trim()`（前端必填）
  - admin action `store-unbind.ts:139` 直接 `rejectReason: reason`（后端无校验）
  - staff `store.js:116-132` `rejectReason || null`（后端允许空）
- **风险**：店长前端绕过（直接调云函数）可写入 `reason=''` 的拒绝；顾客只看到"已拒绝"无原因，无法整改
- **修复**（L3 + L7）：staff/admin 后端都强制 `if (!rejectReason || rejectReason.trim().length === 0) throw 'INVALID_PARAMS: 拒绝原因不能为空'`

---

#### **[P1-12-11]** 申请 `note` / 拒绝 `rejectReason` 无长度上限 / 无敏感词过滤

- **文件**：
  - schema `db/schema/store-unbind.ts:15` `note: text('note')`（无 length）
  - schema `:18` `rejectReason: text('reject_reason')`（无 length）
- **现象**：text 类型无长度上限；client 端 / staff 端均无 substring；顾客可恶意写入超长字符串（DoS 表存储），或包含 PII / 辱骂内容（admin 列表展示无脱敏）
- **风险**：CC6 PII 命中弱化版（顾客可主动暴露第三方手机号 / 身份证）+ 表膨胀
- **修复**（L0 + L3）：schema 改 `varchar(500)`，应用层 `note.substring(0, 500)`

---

#### **[P1-12-12]** auth.bindStore 不要求 phone 已绑定（同 audit-01 P2-BINDSTORE-11 后续命中）

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:201-290`
- **现象**：`auth.bindStore` 路由仅过 `auth()` 中间件，不调 `requirePhone()`；未绑手机号的 OPENID 也能写 `bound_store_id`（虽然实际用户必须先 bindPhone 才能进绑店页面，但 API 层无守卫）
- **关联**：audit-01.md §3.3 P2-BINDSTORE-11 已记录
- **修复**（L3 + L9 spec）：加 `requirePhone()` 守卫；spec 明确"绑店前置 = 绑机"

---

#### **[P1-12-13]** 解绑后顾客**积分余额 / 储值卡余额 / 优惠券 / 历史订单**保留还是清零策略缺失

- **文件**：spec `.42cog/pm/backend.pr.spec.md:394`：`已通过 后清除 client_wechat_users.bound_store_id；已取消 = 顾客主动撤销`（仅一行）
- **现象**：spec 与代码均未约定解绑后：
  - `points_balance`（client_wechat_users.points_balance）保留还是清零？
  - `prepaid_cards.balance`（跨店共账，按 user_id 聚合）保留？
  - `user_coupons` 中 `applicable_store_ids` 含原店的券是否失效？
  - `member_level` / `spending_tier` 保留还是回退？
  - 跨店转分的服务单 / 历史订单的 store_id 不动（已是历史快照）
- **风险**：业务规则空白；顾客解绑后再绑新店，可能继承所有金钱性资产 → 跨店套利路径
- **修复**（L9 spec）：先在 backend.pr.spec.md §2.17 / 4.x 章节补"解绑后资产归属表"，再在 staff/admin approveUnbind 实现策略

---

### 3.3 P2（代码质量 / 可维护）

#### **[P2-12-14]** staff approveUnbind 错误前缀 `INVALID_PARAMS: 申请状态不允许审批` 应该是 `PERMISSION_DENIED` 或新枚举

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/store.js:89` / `:126`
- **现象**：状态不允许审批（已通过 / 已拒绝 / 已取消）的申请，error 前缀用 `INVALID_PARAMS`，语义偏离（参数没问题，是状态阻止）；与 audit-02 / 03 / 11 同模式
- **修复**（L3）：CC5 跨域统一时合并

---

#### **[P2-12-15]** admin getUnbindRequests `.limit(500)` 硬上限无分页，列表超量后早期解绑申请被截断

- **文件**：`fengyu-admin/src/actions/store-unbind.ts:43`
- **现象**：500 条硬上限 + 无分页 / 无筛选；管理后台顾问应能看完整历史。同时 staff `unbindRequests` 也无分页（一次取全门店所有 pending）。
- **风险**：500 行 PG fullscan 性能不影响 P0；UX P2
- **修复**（L7）：改服务端分页（参考 audit-13 优惠券 / audit-04 listOrders 模式）

---

#### **[P2-12-16]** unbindRequests 手机号脱敏在 staff 端做（`phone.slice(0,3)+'****'+phone.slice(-4)`），admin 端不脱敏

- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/store.js:66` `phoneMasked: r.phone ? r.phone.slice(0, 3) + '****' + r.phone.slice(-4) : '未知'`
  - `fengyu-admin/src/actions/store-unbind.ts:34, 49` `customerPhone: clientWechatUsers.phone`（明文）
- **现象**：staff 端店长看到脱敏号；admin 端管理员看到完整手机号；脱敏策略应统一抽 `helpers/phone.ts mask()`（CC6 跨域待统一改造项已记录）
- **风险**：admin 用户群更广（finance / hr 也能查），明文号违反最小权限原则
- **修复**（L7）：admin 列也脱敏；admin schema 加权限项 `customer:phone:full` 控制谁能看明文

---

#### **[P2-12-17]** crypto.randomUUID() 生成 requestId 与项目惯用 ID 格式（`FY-XXX-` 前缀）不一致

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/store.js:154`
- **现象**：项目其他单据（订单 `FY-XSD-WX-...` / 退款单 `FY-TKD-WX-...` / 服务单等）用业务前缀 + 序号；解绑申请用裸 UUID（`xxx-xxx-xxx-xxx`），代码可读性差，admin 列表难肉眼定位
- **修复**（L3）：改 `FY-UNB-WX-{YYMMDD}{4位序号}` 类似格式（与 P0-12-01 修复时一同改 schema 列 + 应用层）

---

#### **[P2-12-18]** stores-page.tsx Tab 同时承载"门店管理"+"解绑审批" 两个语义重的页面，与 store-unbind/page.tsx 重复

- **文件**：
  - `fengyu-admin/src/app/(main)/stores/_components/stores-page.tsx:51-55` Tab="stores"|"unbind"
  - `fengyu-admin/src/app/(main)/store-unbind/page.tsx`（独立页面）
- **现象**：两条入口指向同一审批 action（approveUnbind/rejectUnbind）；UI 双轨，操作员可能在 stores Tab 审过，又在 store-unbind 页再点一次（前端无 disable，后端有 status='待处理' 校验拒第二次）。建议合并为单一入口。
- **修复**（L9 UX）：保留 store-unbind/page.tsx，移除 stores-page.tsx 的 unbind Tab；或反之

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 写入列名 | `fromStoreId` (drizzle) ✅ | `from_store_id` ✅ | **`from_store_name`** ❌ | client 全失效 | **P0** |
| approve 清空字段 | `boundStoreId, boundEmployeeId` | 仅 `bound_store_id` | — | 数据漂移 | P0 |
| 审批权限 scope | `scopeCondition + isInScope` (drizzle) | `ctx.auth.storeId` 单值 | — | 多店店长漏申请 | P1 |
| operation_logs | `logTransition` 写入 | **未写** | **未写** | 审计断裂 | P1 |
| reject_reason 必填 | 前端必填，后端不校验 | 后端允许空 | — | 拒绝无原因 | P1 |
| status CAS | 全无 | 全无 | 全无 | 状态机崩坏 | P0 |
| pending 排他 | 无 partial UNIQUE | 无 | SELECT-then-INSERT | 并发多 pending | P0 |
| 手机号脱敏 | **明文** | `138****1111` | — | PII 泄露 | P2 |
| 错误前缀 | 多裸 `Error('解绑申请不存在')` | `INVALID_PARAMS:` 但语义错配 | `UNAUTHORIZED:`/`INVALID_PARAMS:` | UI 文案映射断 | P2 |
| 列表分页 | `.limit(500)` 截断 | 无分页 | 仅自己一条 | UX | P2 |
| ID 格式 | UUID | — | UUID | 与项目惯例不符 | P2 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [x] CC1 数值精度：本域无金额，跳过
- [ ] **CC2 并发与幂等**：
  - status UPDATE 全无 CAS（P0-12-04）
  - requestUnbind 无 partial UNIQUE 兜底（P0-12-05）
  - 并发 approve / cancel 终态可被覆盖
- [ ] **CC3 组织域隔离**：
  - staff unbindRequests / approveUnbind / rejectUnbind 用 `ctx.auth.storeId` 而非 `scopeStoreIds`（P1-12-08 / P1-12-09）；管理层 `effectiveStoreId=null` 模式下完全不可用
- [ ] **CC4 后端统一鉴权**：
  - `client.geocode` 完全无 `requirePhone()` 守卫（P0-12-06）；任何已注册 OPENID 可耗 LBS 配额
  - `auth.bindStore` 缺 `requirePhone()` 守卫（P1-12-12）
- [ ] **CC5 错误码**：
  - staff `INVALID_PARAMS: 申请状态不允许审批` 与 4 约定语义偏离（P2-12-14）
  - admin `Error('解绑申请不存在')` 无前缀
- [ ] **CC6 PII**：
  - admin `getUnbindRequests` 返回明文手机号（P2-12-16）
  - geocode 错误日志全 stringify 含 sig hash（P0-12-06）
  - note / rejectReason 无长度上限（P1-12-11）
- [ ] **CC7 时间字段**：reviewed_at = `NOW()`（PG 时区）；createdAt / updatedAt 由 schema defaultNow 维护，本域无跨端 dateStr 计算，跳过
- [x] CC8 WXML/Vant：本域 client 无前端 UI 改动（仅"申请解绑"按钮），跳过
- [ ] **CC9 测试与残留**：
  - client `__tests__/routes/store.test.js:111` mock `from_store_name` **反向锁死 P0-12-01 错误代码**（同 audit-08 §5 CC9 反模式）
  - 修复 P0-12-01 必须同步修测试

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/store-unbind.ts` | 加 partial UNIQUE `(user_id) WHERE status='待处理'`；note/reject_reason 改 varchar(500) | P0-12-05 / P1-12-11 |
| L0 migration | `db/migrations/00NN_store_unbind_partial_unique.sql` | 创建索引 + ALTER TABLE | P0-12-05 |
| L3 client routes | `clientApi/routes/store.js:155-159` | INSERT 改 `from_store_id` 列 | **P0-12-01** |
| L3 client routes | `clientApi/routes/store.js:174-176` | SELECT 改 LEFT JOIN stores 取 store_name | **P0-12-01** |
| L3 client routes | `clientApi/routes/store.js:213-216` | UPDATE 加 `AND status='待处理'` CAS + rowCount 校验 | P0-12-04 |
| L3 client routes | `clientApi/routes/store.js:225-261` | geocode 加 `requirePhone()` + 限频 + 错误日志脱敏 | P0-12-06 |
| L3 client auth | `clientApi/routes/auth.js:239-253` | bindStore 加 `bound_store_id IS NULL OR =$storeId` 守卫 + requirePhone | P0-12-02 / P1-12-12 |
| L3 staff routes | `staffApi/routes/store.js:88-103` / `120-132` | UPDATE 加 status CAS + 清 bound_employee_id + buildStoreScopeCondition | P0-12-03 / P0-12-04 / P1-12-08 / P1-12-09 |
| L3 staff routes | `staffApi/routes/store.js` | 三个 action 加 logOperation | P1-12-07 |
| L3 staff routes | `staffApi/routes/store.js:117-132` | rejectReason 必填校验 | P1-12-10 |
| L7 admin actions | `actions/store-unbind.ts:84-95` | 抽 helper unbind-customer.js 共用 | P0-12-03 |
| L7 admin actions | `actions/store-unbind.ts:46-49` | customerPhone 输出脱敏 | P2-12-16 |
| L7 admin actions | `actions/store-unbind.ts:43` | .limit(500) → 改服务端分页 | P2-12-15 |
| L9 client tests | `__tests__/routes/store.test.js:111` | mock 改 `from_store_id` | P0-12-01 |
| L9 spec | `.42cog/pm/backend.pr.spec.md:394` | 补"解绑后资产归属表"+ "换店守卫" | P1-12-13 / P0-12-02 |
| L9 UI | `(main)/stores/_components/stores-page.tsx` | 移除 unbind Tab 重复入口 | P2-12-18 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1. 验证 from_store_name 列不存在（P0-12-01 锤实）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'store_unbind_requests';
-- 预期：request_id / user_id / from_store_id / status / note / reviewed_by / reviewed_at / reject_reason / created_at / updated_at（无 from_store_name）

-- 2. 验证生产环境是否已有违规 pending 多行（P0-12-05）
SELECT user_id, COUNT(*) AS pending_count
FROM store_unbind_requests
WHERE status = '待处理'
GROUP BY user_id
HAVING COUNT(*) > 1;
-- 预期：本应 0 行；如有则需先清理再加 partial UNIQUE

-- 3. 验证 bound_store_id 历史中是否曾被 bindStore 绕过解绑覆盖（P0-12-02）
-- 通过 operation_logs 反查（admin 路径有日志）
SELECT
  ol.created_at, ol.action, ol.target_id, ol.detail,
  cu.user_id, cu.bound_store_id
FROM operation_logs ol
LEFT JOIN client_wechat_users cu ON ol.target_id = cu.user_id
WHERE ol.action IN ('store_unbind.approve', 'store.bind')
ORDER BY ol.target_id, ol.created_at;
-- 期望模式：每个 target_id 的 store.bind / store_unbind.approve 交替；
-- 异常模式：连续多次 store.bind 之间无 store_unbind.approve（说明绕过解绑）

-- 4. 验证 staff approveUnbind 残留 bound_employee_id（P0-12-03）
-- 找出"已通过解绑申请，但 bound_employee_id 仍非空"的顾客
SELECT
  cu.user_id, cu.bound_store_id, cu.bound_employee_id, cu.bound_employee_name,
  sur.status, sur.reviewed_at
FROM client_wechat_users cu
JOIN store_unbind_requests sur ON sur.user_id = cu.user_id
WHERE sur.status = '已通过'
  AND cu.bound_store_id IS NULL
  AND cu.bound_employee_id IS NOT NULL;
-- 预期：staff approveUnbind 路径产生的行
```

---

## 8. 回归测试用例（建议）

1. **client.requestUnbind 字段名修复后**：mock pg.query 检查 INSERT 第三个参数是 `boundStoreId` 不是 `boundStoreName`，且 SQL 文本含 `from_store_id` 不含 `from_store_name`
2. **bindStore 已绑定守卫**：boundCtx 已绑定门店 X，调 `bindStore({storeId:'Y'})` 应抛 `PERMISSION_DENIED: 已绑定门店`
3. **partial UNIQUE 索引存在**：`SELECT * FROM pg_indexes WHERE indexname='uq_store_unbind_pending'` 应 1 行
4. **status CAS**：mock UPDATE rowCount=0，approveUnbind 应抛"申请状态已变化"
5. **bound_employee_id 同步清空**：admin / staff 两路径 approve 后，UPDATE client_wechat_users 都应包含 bound_employee_id=NULL
6. **管理层 multi-store manager 跨店审批**：staff loginLevel='management' + scopeStoreIds=['s1','s2','s3']，approveUnbind from_store_id='s2' 应通过
7. **geocode requirePhone**：未绑手机号的 ctx 调 geocode 应抛 PHONE_REQUIRED
8. **geocode 限频**：同 OPENID 60 秒内第 6 次应抛 RATE_LIMITED
9. **rejectReason 必填**：rejectUnbind({rejectReason:''}) 应抛 INVALID_PARAMS
10. **operation_logs 写入**：staff approveUnbind / rejectUnbind / client cancelUnbindRequest 三个路径都断言 `logOperation` 被调用

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：**☑**
- 涉及历史数据：**☑**（需验证生产 PG 是否有 staff 路径残留 bound_employee_id 的客户）
- 修复成本：**M**（client INSERT 修字段名 = S；bindStore 守卫 + scope helper + CAS + partial unique + 字段统一 = M；不涉及微信回调或资金链路）

---

## 10. 后续待办

- [ ] 与 PM 对齐 P1-12-13：解绑后顾客资产（积分 / 储值卡 / 优惠券 / 等级）是保留 / 清零 / 跨店转移；按结论补 spec + 实现
- [ ] 与 PM 对齐 P0-12-02：bindStore 是否允许直接换店；如允许须明文写在 spec
- [ ] 写补丁 migration：partial UNIQUE + note/reject_reason length（合并 S12-1）
- [ ] 抽 `helpers/unbind-customer.js`（admin + staff 共用）
- [ ] geocode 限频 / 缓存方案（参考 audit-04 同类外部 API 调用治理）
- [ ] 生产数据修复 SQL：批量清理 staff 路径残留的 bound_employee_id（P0-12-03 历史数据）
- [ ] 横切：CC4 加入 "client 路由 requirePhone 漏调清单"，与 audit-06 P0-06-01 同诉求合并 sweep

---

## 11. 完成状态（2026-04-26 复验）

> 复验时间：2026-04-26 15:00
> 复验方式：读取 `clientApi/routes/store.js`（行140-260）、`staffApi/routes/store.js`（行1-139）、`clientApi/routes/auth.js`（行200-260）源码

### P0 级（阻断/资损/越权）

| ID | 漏洞 | 验证结果 | 当前状态 |
|----|------|----------|----------|
| P0-12-01 | client requestUnbind / getUnbindRequest 使用 `from_store_name`（不存在） | **✅ 存在** `store.js:156` INSERT 写 `from_store_name`；`store.js:175` SELECT 读 `from_store_name`；`store.js:186` 返回 `fromStoreName: rows[0].from_store_name` | **未修复** — 顾客解绑流 100% 不可用 |
| P0-12-02 | auth.bindStore 不校验 `bound_store_id IS NULL`，绕过解绑申请流 | **✅ 存在** `auth.js:239` 无守卫；`auth.js:248` 直接 UPDATE `bound_store_id = $1`，无 null-check | **未修复** |
| P0-12-03 | staff approveUnbind 不清 `bound_employee_id`，admin 清（不一致） | **✅ 存在** `staffApi/store.js:94` 仅 `UPDATE bound_store_id = NULL`，未触及 `bound_employee_id` 等残留列 | **未修复** |
| P0-12-04 | 三端均无 CAS（status 状态机可被并发覆盖） | **✅ 存在** `store.js:214` cancel UPDATE 无 `AND status='待处理'`；`staffApi/store.js:99-101` approve UPDATE 无 CAS；`staffApi/store.js:129-132` reject 同上 | **未修复** |
| P0-12-05 | 无 partial UNIQUE，并发可写多条 pending | **✅ 存在** `store.js:146-158` SELECT-then-INSERT 模式，schema 无复合 unique；未读 cloudbase 侧无事务排他 | **未修复** |
| P0-12-06 | geocode 无 `requirePhone()` 鉴权 / 无频限 / 无缓存，可刷穷 LBS 配额 | **✅ 存在** `store.js:225-240` 直接 `const { latitude, longitude } = ctx.event.payload` 无守卫；无内存缓存；错误日志全 stringify 含 sig hash | **未修复** |

### P1 级（数据一致/状态错乱）

| ID | 漏洞 | 验证结果 | 当前状态 |
|----|------|----------|----------|
| P1-12-07 | staff approveUnbind / rejectUnbind / client cancel 不写 operation_logs | **✅ 存在** `staffApi/store.js:75-136` 全程无 `logOperation` 调用；`store.js:198-219` cancel 同上 | **未修复** |
| P1-12-08 | staff unbindRequests 用 `ctx.auth.storeId` 单值，多店店长漏申请 | **✅ 存在** `staffApi/store.js:42` `WHERE r.from_store_id = $1`（storeId 单值），未调用 scope helper | **未修复** |
| P1-12-09 | staff approveUnbind / rejectUnbind 用 `storeId` 校验，管理层模式失效 | **✅ 存在** `staffApi/store.js:88,125` `if (req.from_store_id !== storeId)` — `storeId` 取自员工档案默认门店，非 scopeStoreIds | **未修复** |
| P1-12-10 | rejectReason 在 staff 端无必填校验 | **✅ 存在** `staffApi/store.js:116` `rejectReason || null`，允许空字符串 | **未修复** |
| P1-12-11 | note / rejectReason 无长度上限 | **✅ 存在** schema `store-unbind.ts` 列类型为 `text`；应用层未做 substring | **未修复** |
| P1-12-12 | auth.bindStore 不要求 phone 已绑定 | **✅ 存在** `auth.js:202` 仅过 `auth()` 默认中间件，无 `requirePhone()` | **未修复** |
| P1-12-13 | 解绑后顾客积分/储值卡/优惠券/等级保留还是清零策略缺失 | **需 PM 对齐**：未读 spec 有此规则，补 spec 前无法实现 | **未修复 / 待对齐** |

### P2 级（代码质量/可维护）

| ID | 漏洞 | 验证结果 | 当前状态 |
|----|------|----------|----------|
| P2-12-14 | staff reject 错误前缀 `INVALID_PARAMS: 申请状态不允许审批` 语义偏离 | **✅ 存在** `staffApi/store.js:89,126` | **未修复** |
| P2-12-15 | admin getUnbindRequests `.limit(500)` 硬截断 | 未读 admin 源码（已有大量独立漏洞，优先级低） | 未验证 |
| P2-12-16 | admin 返回明文手机号，staff 脱敏 | 未读 admin 源码（独立 P2，跨端不一致已有大量 P0/P1） | 未验证 |
| P2-12-17 | requestId 用 `crypto.randomUUID()` 而非 `FY-UNB-WX-` 前缀 | **✅ 存在** `store.js:154` `crypto.randomUUID()` | **未修复** |
| P2-12-18 | stores-page.tsx 与 store-unbind/page.tsx 重复入口 | 未读 admin 前端源码（P2 UX 问题） | 未验证 |

### 复验结论

**6 个 P0 中 0 个修复，13 个已验证 P1/P2 中 0 个修复。**

所有已验证漏洞在代码中均完整保留。修复顺序建议：

1. **P0-12-01（first）** — 列名错误是整个域失效的根因，必须优先修；同步修测试夹具
2. **P0-12-02（second）** — 绑定绕过解绑是安全越权，必须优先修
3. P0-12-04/05（并发安全）→ P0-12-03（数据一致性）→ P0-12-06（外部 API 风险）
4. P1-12-07/08/09/10/12（L7 + L3）→ P1-12-11/13
5. P2 随常规迭代处理
