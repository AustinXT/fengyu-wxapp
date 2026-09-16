# staff 端 scope 隔离链路（scope-isolation）

**最近一次更新**：2026-05-19（首版）
**目的**：staff 端云函数 scope 隔离的端到端验证，与 admin 端 `fengyu-admin/tests/e2e-chains/`
的镜像测试套件。两端 scope 语义必须保持一致；任一端漂移立即影响业务隔离。

---

## 0. 目录约定

```
fengyu-staff/tests/scope-isolation/
├── README.md                              # 本文件
├── setup.mjs                              # 公共 setup（环境变量 + openid seed）
├── seed-openids.sql                       # 给 admin 已 seed 的 FY-TEST-* 员工注入确定性 openid
├── run-all.mjs                            # 串行跑全部 scope-*.mjs
├── scope-s1-customer-cross-store.mjs      # S-1 + S-2 customer 跨店列表 / paidOrders / calendar
├── scope-s3-customer-assign-deny.mjs      # S-3 customer.assign assertCustomerInScope + assertEmployeeInScope
├── scope-s4-mgmt-dashboard-cascade.mjs    # S-4 scopeOptions 级联 + S-5 summary validateScope
└── scope-s8-mgr-cross-store-deny.mjs      # S-8 店长 A 跨店访问 store-nc02（6 路 scope 守卫聚合验证）
```

跑批：

```bash
bun fengyu-staff/tests/scope-isolation/run-all.mjs
# 或单跑
bun fengyu-staff/tests/scope-isolation/scope-s1-customer-cross-store.mjs
```

---

## 0.1 依赖

跑这套链路之前，必须确保下列 fixture 已就绪：

1. **admin 端 seed-scope-fixtures.sql 已跑**（FY-TEST-MGR2 / FY-TEST-CLIENT-NC02 / FY-TEST-CLIENT-OM）。
   admin 跑批指引见 `fengyu-admin/tests/e2e-chains/README.md` §1.D。
2. **本 setup.mjs 跑 seed-openids.sql**（自动幂等，每次 import 触发一次），给 FY-TEST-* 员工
   注入 `staff-scope-{employee_id}` 前缀的 openid，让 `_testOpenid` 通道可以认领他们。
3. **环境变量** `ALLOW_TEST_OPENID=true`（继承自 `../e2e-cloudfn/setup.mjs`，
   云函数 auth 中间件读此 flag 决定是否尊重 `_testOpenid`）。
4. **PG 连接** `101.34.242.103:5433/fengyu_wxapp`（与 admin e2e 共库，详见 memory `project_db_dual_env`）。

---

## 0.2 测试账号（与 admin 端共用）

| openid（_testOpenid 注入） | employee_id | 角色 | store/scope | 用途 |
|---------------------------|------------|------|-------------|------|
| `staff-scope-FY-TEST-MGR`  | FY-TEST-MGR  | manager | store-nc01 | 单店店长 scope 测试 |
| `staff-scope-FY-TEST-MGR2` | FY-TEST-MGR2 | manager | store-nc02 | 跨店反例（与 MGR 互为对照） |
| `staff-scope-FY-TEST-MKT`  | FY-TEST-MKT  | manager | 南昌市场 | 市场聚合 + market validateScope 反例 |
| `staff-scope-FY-TEST-ADM`  | FY-TEST-ADM  | admin | 总部 | 全量基线对照 |

`_loginLevel` 与 `_currentStoreId` 一并传入控制员工 loginLevel：

- **store 模式**：MGR / MGR2，`_currentStoreId` = 自店 id；effectiveStoreId 生效
- **management 模式**：MKT / ADM，effectiveStoreId=null；走 scopeStoreIds / validateScope

---

## 1. 链路一览（S-1 ~ S-7）

> S-1/S-2/S-3/S-4/S-5 已实现自动化 spec；S-6/S-7 暂为 TODO（业务价值低 + 手动 SQL + invokeStaffApi 即可验证）。

### S-1：customer.search 跨店不可见

**spec**：`scope-s1-customer-cross-store.mjs`（与 S-2 合一）
**主题**：`customer.search(keyword)` 按 `effectiveStoreId` 过滤，仅本店顾客命中。`customer.search(phone)`
设计上跨店命中（顾客换店仍可识别），保留为合理 cross-store 身份匹配。
**关键引用**：`routes/customer.js:search:25-71`
**检查点**：
- MGR(nc01) keyword='NC02测试客' → 0 命中
- MGR(nc01) phone='13800138002'（NC02 顾客）→ 命中（cross-store 身份）
- MGR(nc01) empty list 不含 NC02 / OM 顾客
- MGR2(nc02) keyword='NC01' → 0 命中

### S-2：customer.giftHistory / paidOrders / calendar 店内过滤

**spec**：`scope-s1-customer-cross-store.mjs`（与 S-1 合一）
**主题**：跨店顾客的订单 / 服务流水 / 日历不返回；`buildStoreScopeCondition(o.store_id)` 在 SQL 层
强制过滤。
**关键引用**：`routes/customer.js:calendar:140-228` `paidOrders` `giftHistory` `refundHistory`
**检查点**：
- MGR(nc01) `customer.paidOrders(NC02 user_id)` → 被拒 或 0 行
- MGR(nc01) `customer.calendar(NC02 user_id, today range)` → 被拒 或 0 行

### S-3：customer.assign 越权拒绝

**spec**：`scope-s3-customer-assign-deny.mjs`
**主题**：`customer.assign` 双层 scope 守卫（assertCustomerInScope + assertEmployeeInScope）：
店长不能跨店挪顾客，也不能把本店顾客分给他店员工。
**关键引用**：`routes/customer.js:assign:1010-1046` + `utils/scope-guards.js`
**检查点**：
- 反例 1：MGR(nc01) assign NC02 顾客 → PERMISSION_DENIED（顾客不在 scope）
- 反例 2：MGR(nc01) assign NC01 顾客 给 FY-TEST-MGR2 → PERMISSION_DENIED（员工不在 scope）
- 正例：MGR(nc01) assign NC01 顾客 给本店员工 → 通过；afterAll 自动回滚 bound_employee_id

### S-4：mgmtDashboard.scopeOptions 级联返回

**spec**：`scope-s4-mgmt-dashboard-cascade.mjs`（与 S-5 合一）
**主题**：`mgmtDashboard.scopeOptions` 返回当前账号有权见的市场列表（用于前端市场→门店级联挑选）；
headquarters 全量，market 仅自己 scope。
**关键引用**：`routes/mgmt-dashboard.js:scopeOptions:98-119`
**检查点**：
- ADM staffLevel=headquarters → markets = 全部活跃市场（与 DB count 一致）
- MKT staffLevel=market → markets = [南昌市场] 单元素

### S-5：mgmtDashboard.summary validateScope 校验

**spec**：`scope-s4-mgmt-dashboard-cascade.mjs`（与 S-4 合一）
**主题**：`summary` 调用前 `validateScope(auth, scopeType, scopeId)` 拦截越权请求；
**关键引用**：`routes/mgmt-dashboard.js:validateScope:130-154`
**检查点**：
- 反例 1：MKT 传 scopeType='all' → PERMISSION_DENIED
- 反例 2：MKT 传 scopeType='market', scopeId=南昌市场2 → PERMISSION_DENIED
- 反例 3：MKT 传 scopeType='store', scopeId=他市场门店 → PERMISSION_DENIED
- 正例：ADM 传 scopeType='all' → 通过
- 反例 4：MGR(店长) 调 summary → requireManagementLevel 拦截（staffLevel=store_manager）

### S-6（TODO）：mgmt-product.entryDates scope 一致

**主题**：`mgmt-product.entryDates` 返回的 store_id 集合应严格等于 scope 范围；MKT 跨店合并、MGR 单店、ADM 全部。
**关键引用**：`routes/mgmt-product.js:validateScope + buildSaleScope/buildClientScope`
**未自动化原因**：与 S-5 行为基本对称（同一 validateScope 函数副本），手动 invoke + DB diff 5 分钟可验证。

### S-8：店长 A 跨店访问 store-nc02 全路径拒绝

**spec**：`scope-s8-mgr-cross-store-deny.mjs`
**主题**：聚合验证最新加上的 6 处 scope 守卫，对标 admin `link-32-store-scope-list-isolation.spec.ts` 的反例风格。
**关键引用**：
- `routes/staff.js:64-78 (list)`、`471-485 (bindStore)` — `isStoreInScope`
- `routes/store.js:17-53` — `scopeStoreIds` 过滤
- `routes/customer.js:444-455 (paidOrders)`、`980-989 (customerBalance)` — `assertCustomerInScope`
- `routes/order.js:779-807 (qrcode)` — `isStoreInScope`
**检查点**：
- (1) MGR(nc01) `staff.list({storeId:'store-nc02'})` → `PERMISSION_DENIED: 不在权限范围内的门店`
- (2) MGR(nc01) `staff.bindStore({storeId:'store-nc02'})` → `PERMISSION_DENIED`，且 DB 未写入新 storeId
- (3) MGR(nc01) `store.list()` → 仅返回 store-nc01，不含 store-nc02
- (4) MGR(nc01) `customer.paidOrders({clientUserId=NC02})` → `PERMISSION_DENIED: 顾客不在当前门店范围内`
- (5) MGR(nc01) `customer.customerBalance({customerUserId=NC02})` → `PERMISSION_DENIED`
- (6) MGR(nc01) `order.qrcode({saleOrderId=NC02 临时单})` → `PERMISSION_DENIED: 订单不在当前门店范围内`
**临时数据**：第 (6) 条断言需 store-nc02 上一笔 sale_order，本 spec 入口 seed `FY-SCOPES8-WX-0001`（sale_order + sale_item），`finally` 块强制 cleanup。与 admin link-32 `FY-CHAIN32-WX-0001` 临时单同模式。

### S-7（TODO）：order.create 不可指定他店 store_id

**主题**：店长开单时 `payload.storeId` 应被服务端强制覆盖为 `auth.effectiveStoreId`，
不接受前端伪造的他店 store_id。
**关键引用**：`routes/order.js:create`（开单事务内 storeId 来源）
**未自动化原因**：MGR(nc01) 开单 → 必定写 store-nc01，前端 input 无法影响最终 store_id。
属于 server-side 默认行为，写入一次 SQL 确认即可（用 link-32 同样套路）。

---

## 2. 与 admin e2e-chains 的镜像关系

| staff 链路 | 主题 | 对应 admin 链路 |
|-----------|------|---------------|
| S-1 | customer.search 跨店不可见 | link-32（admin 列表数据隔离） |
| S-2 | giftHistory/paidOrders/calendar 店内过滤 | link-32 |
| S-3 | customer.assign 越权拒绝 | link-37（admin cross-store action） |
| S-4 | mgmtDashboard.scopeOptions 级联 | link-35b（admin 列表级联选择器） |
| S-5 | mgmtDashboard.summary validateScope | link-33（admin 市场聚合）+ link-34（基线） |
| S-6 | mgmt-product.entryDates scope | link-32 |
| S-7 | order.create 不可指定他店 store_id | link-37 |
| S-8 | 店长 A 跨店 staff/store/customer/order 6 路守卫 | link-32（直接对应） |

**一致性维护规则**：admin 修改 `scopeCondition` / 角色权限 → 立即跑 staff scope-isolation；
反之亦然。两端云函数代码物理隔离（per CLAUDE.md "禁止跨端共享代码目录"），
一致性靠 snapshot 测试守护：

- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`
- `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts`

---

## 3. 失败定位 cheatsheet

| 症状 | 可能原因 | 排查命令 |
|------|---------|---------|
| `UNAUTHORIZED: 无法获取用户身份` | seed-openids.sql 未跑 / openid 不匹配 | `psql -c "SELECT employee_id, openid FROM staff_wechat_users WHERE openid LIKE 'staff-scope-%'"` |
| `(S4.2) MKT markets 应仅=南昌市场, 实际=[]` | FY-TEST-MKT 的 permission_roles 未含 (market, 南昌市场 id) | `psql -c "SELECT * FROM permission_roles WHERE employee_id='FY-TEST-MKT'"` |
| `(1) MGR keyword 不应命中 NC02 顾客` | scope 守卫漏改（如 customer.search 改用 scopeStoreIds 但 fallback 错）| `git log -p -- fengyu-staff/cloudfunctions/staffApi/routes/customer.js` |
| `NC02 顾客不存在` | admin seed-scope-fixtures.sql 未跑 | `PGPASSWORD=fengyu123 psql -h 101.34.242.103 -p 5433 -U fengyu -d fengyu_wxapp -f fengyu-admin/tests/e2e-chains/_helpers/seed-scope-fixtures.sql` |

---

## 4. 跑批结果（2026-05-19 首跑）

| spec | 结果 | checks | 备注 |
|------|------|--------|------|
| `scope-s1-customer-cross-store.mjs` | ✅ PASS | 6/6 | search keyword 隔离 + phone cross-store 身份匹配 + paidOrders/calendar 跨店拒 |
| `scope-s3-customer-assign-deny.mjs` | ✅ PASS | 3/3 | 顾客/员工双层 scope 守卫 + 正例对照 + DB 防御断言 |
| `scope-s4-mgmt-dashboard-cascade.mjs` | ✅ PASS | 6/6 | scopeOptions ADM/MKT 级联 + summary 4 路 validateScope 反例 |
| `scope-s8-mgr-cross-store-deny.mjs` | ✅ PASS | 6/6 | 店长 A 跨店访问 store-nc02 数据 6 路全拒（含 order.qrcode） |

**总计**：4 spec / 21 check / 100% PASS。Total runtime ~8s（pure cloudfn smoke，零 UI 开销）。

首跑 spec 微调记录：
- `scope-s1` calendar 入参从 `startDate/endDate` 改为 `year/month`（与 customer.calendar 路由签名对齐）
- `scope-s4` validateScope 断言从 `message.includes('PERMISSION_DENIED')` 改为 `code === -403 || errorType === 'PERMISSION_DENIED'`（云函数 buildErrorResponse 已剥离前缀，message 仅保留可读文案）

## 5. 后续行动

- [x] 跑首批（S-1 + S-3 + S-4 + S-8），收集结果并回填本 README 跑批结果表 ✅ 2026-05-19
- [ ] 实施 S-6 / S-7 自动化（如发现 mgmt-product / order.create 漂移再补）
- [ ] CI 集成：scope-isolation/run-all.mjs 加入 staff smoke 流水
- [ ] admin / staff 双端一致性回归任务：每次改 customer / mgmt-* 路由后必跑 admin link-32 + staff scope-s1
