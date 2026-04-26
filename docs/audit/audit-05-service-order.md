# 审计报告：服务单 + 扣次原子性 (05)

**审计时间**：2026-04-25 22:30
**域 ID**：05
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/service.ts:15-80`（service_orders / service_items）+ `db/schema/service-commission.ts:16-51` | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/services.ts:285-561`（start/complete/cancel/create + 列表/详情） | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:21-794`（create/start/complete/cancel/list/detail/counts） | `fengyu-client/cloudfunctions/clientApi/routes/service.js:12-138`（detail/list 只读） |
| 前端 | `fengyu-admin/src/app/(main)/services/{page.tsx,_components/services-page.tsx,_components/service-create-page.tsx,[id]/page.tsx,create/page.tsx}` | `fengyu-staff/miniprogram/pages/service/*` | `fengyu-client/miniprogram/pages/service/*` |
| 测试 | `fengyu-admin/src/actions/services.test.ts` | — | — |

## 2. 数据流图

```
admin.create / staff.create
  ├─ 校验顾客活动服务单（仅 staff）
  ├─ INSERT service_orders.待服务
  └─ INSERT service_items（unit_real_price / is_shengmei / sales_category 从 sale_items 快照拷贝）

staff.start / admin.startServiceOrder
  └─ UPDATE service_orders SET status='服务中', started_at=NOW() WHERE service_order_id=$1 AND status='待服务'   <CAS>

staff.complete / admin.completeServiceOrder
  ├─ FOR each service_item:
  │    UPDATE sale_items SET remaining_sessions = remaining_sessions - sessionUsed
  │      WHERE sale_item_id=$1 AND store_id=$2 AND remaining_sessions >= sessionUsed AND remaining_sessions IS NOT NULL  <真原子>
  │    若扣减后剩 0：UPDATE appointments(sale_item_id) SET status='已关闭'
  ├─ FOR each service_item: 计算 fixed_fee + consume_amount → INSERT service_commissions ON CONFLICT DO NOTHING
  ├─ UPDATE service_orders SET status='已完成', completed_at=NOW(), commission_status='已分配'
  │    WHERE service_order_id=$1 AND status='服务中'   <CAS>
  └─ 关联预约：UPDATE appointments SET status='已完成' WHERE appointment_id=$1 AND status='已确认'

staff.cancel / admin.cancelServiceOrder
  └─ UPDATE service_orders SET status='已取消' WHERE service_order_id=$1 AND status=$2  <CAS，不回滚次数>
```

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

#### [P0-05-01] staff.create 写入不存在的列 `sku_id`，**所有 staffApi 服务单创建必失败**
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:207-224`
- **现象**：INSERT 语句列清单含 `sku_id`，但 `service_items` 表自 0000_baseline 起从未定义此列；schema `db/schema/service.ts:52-80` 也无 `skuId`/`sku_id` 字段。本域 0008（is_shengmei）、0011（sales_category）等增量迁移均未补 sku_id。
- **风险**：staffApi `service.create` 调用一定抛 PG `42703 column "sku_id" of relation "service_items" does not exist`，员工端"护理"Tab 完全无法新建服务单。整条 staff 服务核销链路 100% 阻塞。这是**编码即生产事故**级别的 P0。
- **复现**：1) 门店模式登录员工端；2) 进入"护理 → FAB 新建"；3) 选 sale_item + employee 提交；4) 后端报错 `INVALID_PARAMS:` 不会触发，PG 直接抛列不存在错误，前端显示"未识别错误"。
- **波及**：直接导致 real.md #1 次数防超卖在 staff 链路完全失效（核销没法启动 → 不会扣次，但也会跨越业务流程，店员只能用 admin 后台代办）；使 P1 顾客端 service.list/detail 永远空。
- **修复**：(L0/L3) 二选一：
  - L0：补一条 migration `ALTER TABLE service_items ADD COLUMN sku_id text REFERENCES product_skus(sku_id);` 并把 schema 同步加 `skuId`
  - L3：删除 service.js:210 INSERT 列清单中的 `sku_id` 与 `$5` 占位符及 line 217 的 `skuId` 实参（admin 不读 sku_id，业务可移除）

#### [P0-05-02] 三端服务单号前缀 / 生成器互斥，跨端 ID 重复风险与号段碎片
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:768-790`（`HLD-WX-{YYMMDD}NNNN`）vs `fengyu-admin/src/actions/services.ts:498-516`（`FY-FW-{YYMMDD}NNNN`）
- **现象**：staff 用 `HLD-WX-` 前缀，admin 用 `FY-FW-` 前缀，相互不感知。两端都按各自 LIKE 前缀 `MAX(后 4 位)+1`，跨端会落入两个号段空间。理论上不冲撞，但：
  1. service_orders.serviceOrderId 是单一主键全局空间，前缀差异让"今日服务单"统计、外部对账、客服按编号搜索分裂；
  2. `.42cog/real.md` 与 `CLAUDE.md` 全局规范规定订单号格式 `FY-XSD-WX-{YYMMDD}NNNN`，**没有任何一端遵守**该格式（包括 admin 服务单 `FY-FW-` 也是新发明的前缀）；
  3. staff 端的 advisory lock key 是 `Buffer.from('svc_order_id').reduce((h,b)=>(h*31+b)&0x7fffffff,0)`，admin 是 `hashtext('service_order_id_gen')`，**不同 lock key**，两端并发 create 不互斥。当 admin 改用 staff 前缀时立刻可重号。
- **风险**：当前号段冲突隐藏，但任何一端调整前缀（业务一致性修复）都会撞号；下游统计、看板、客服按号查找全部混乱；advisory lock key 不一致是潜在 P0（real.md #1/CC2 兜底失败）。
- **复现**：1) admin 创建服务单 `FY-FW-260425XXXX`；2) staff 创建服务单 `HLD-WX-260425XXXX`；3) 顾客端 service.list 同一日两条，customerService 按"今日所有服务单"统计需 `LIKE 'HLD-WX-260425%' OR LIKE 'FY-FW-260425%'`；4) 假设运维将 admin 前缀改为 `HLD-WX-`，并发 create 因 lock key 不同 → 重号 23505。
- **修复**：(L0/L3) 统一前缀（建议全用 `FY-FW-{YYMMDD}NNNN` 与销售单 `FY-XSD-WX-` 区分语义），并把 advisory lock key 收敛到同一 helper（`db/scripts/...` 或共享 SQL fragment）。

#### [P0-05-03] staff.create 整段事务前置只读 SQL 不在事务内，存在 TOCTOU 重复创建窗口
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:55-164`
- **现象**：appointment 关联校验（line 56-69，含"该预约已关联服务单"防重）、订单行剩余次数校验（line 81-117）、活动服务单校验（line 142-151，"同一顾客只能有一个进行中的服务单"）全部在事务**外**用 `pg.query` 读，随后第 169 行才 `pg.transaction` 开 INSERT。两条以及"已存在 service_orders.appointment_id"和"已有进行中服务单"都是经典 TOCTOU：并发两次 create 均能通过事务外校验，事务内同时 INSERT，无 UNIQUE 约束兜底（appointment_id 没建 unique，client_user_id+status IN(...) 也没建 partial unique）→ 同一预约可被关联两条服务单 / 同顾客同时存在两条"待服务"。
- **风险**：违反 real.md #1（疗程核销原子操作前提是"一次只能开一条"）+ #4（状态推进唯一）。重复服务单 → 重复 complete 时同 sale_item 被两次扣次（第二次因 CAS 守卫会失败，但提成 service_commissions 已写入两条 → 资损隐患）。
- **修复**：(L0/L3) L0 补 partial unique：`CREATE UNIQUE INDEX uq_so_appointment ON service_orders(appointment_id) WHERE appointment_id IS NOT NULL;` + `CREATE UNIQUE INDEX uq_so_client_active ON service_orders(client_user_id) WHERE status IN ('待服务','服务中');`。L3 把所有校验移入事务并在末尾再 INSERT。

#### [P0-05-04] cancel **不回滚** remaining_sessions，但允许在"服务中"状态取消（次数已部分计算？实则未扣，但语义违直觉）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:722-764`
- **现象**：cancel 允许 `'待服务','服务中'` 两个状态都取消，且仅 UPDATE service_orders.status='已取消'，**不动** sale_items.remaining_sessions、不动 service_commissions、不动 appointments。
  - 实际扣次只发生在 complete，所以"服务中 → 已取消"不会造成数据资损。但 admin.cancel 仅允许"待服务"取消（services.ts:417 `eq(serviceOrders.status, '待服务')`），**两端口径不一致**。
  - 一旦未来有人在 start 时即扣次（基于"服务开始就占用次数"的需求），现 cancel 路径会让次数永久泄漏。
  - 当前 staff 允许"服务中→已取消"，但 commission_status 字段未置 null/'已取消'，仍保留 default null（已分配语义残留）。
- **风险**：admin/staff 状态机分歧（CC1 跨端不一致），CC4 状态机崩坏的"灰色区域"——服务中能取消，但 admin 看到"已取消"详情时仍可能展示到一半的服务记录混乱。
- **修复**：(L3/L7) staff.cancel 收敛到只允许"待服务"，对齐 admin。或 admin 也开放"服务中→已取消"并补 commission_status='已取消' 维度。建议前者。

#### [P0-05-05] staff.complete 内 service_commissions UPSERT 缺关键回退；rate 缺失时静默写 rate=0
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:401-449`
- **现象**：commission_rate_matrix 查询无匹配时 `rate=0`，仅写一条 operation_logs 提示"rate_missing"，提成 INSERT 仍照常 with `rate=0` 走完，并把 service_orders.commission_status 置为 `'已分配'`（line 454）。运维补完矩阵规则后**没有任何回扫机制**重算这批 rate=0 的提成；service_commissions 唯一索引 `uq_svc_comm_item_emp_role WHERE is_void=false`（service-commission.ts:44-46）也阻止后续重写。
- **风险**：员工提成永久按 0 入账（直接资损 → 员工绩效页 / 月度日历少计），且没有自动告警链路（仅 operation_logs 静默）。real.md 未直接列"提成不丢"，但属于资损 P0。
- **修复**：(L3/L7) rate=0 且 consumeBase>0 时应：
  - 选项 A：抛错让 staff 重试（业务受阻 → 不可取）
  - 选项 B：写入 commission_status='待分配' + 不写 service_commissions，留待 admin allocation 补；运维补矩阵后批跑回扫；service-commission.ts 唯一索引保留即可，因没写就不会冲突
  - 选项 C：写入提成行 + commission_status='待分配' + admin 控制台展示这些 service_orders + 一键重算（admin.completeServiceOrder 当前**完全不写** service_commissions，见 P0-05-08）

#### [P0-05-06] admin.completeServiceOrder 完全不写 service_commissions，admin 路径下提成永久缺失
- **文件**：`fengyu-admin/src/actions/services.ts:333-396`
- **现象**：admin 完成服务单仅原子扣减 + 状态推进 + revalidatePath，**未触发 service_commissions 写入**，也不更新 service_orders.commission_status。staff.complete 同样动作会写完整提成 + 置 '已分配'。
- **风险**：admin 后台触发完成的服务单，员工提成永远是 0（员工绩效报表与 staff.complete 路径下的口径完全错位）。real.md #1 + 业务 KPI 资损。
- **修复**：(L7) 把 staff.complete 内的 commission 计算逻辑抽到 `db/helpers/service-commission.ts`，admin/staff 共用；或 admin 直接调云函数转发。

#### [P0-05-07] complete 触发的 appointment 自动关闭范围过大：扣到 0 即关闭"所有"该 sale_item 的待确认/已确认预约（含他人/未来不同时段）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:377-385`
- **现象**：当 sale_items.remaining_sessions 扣到 0，UPDATE 所有 `status IN ('待确认','已确认') AND sale_item_id=该卡` 的 appointments 全部置 '已关闭'。问题：
  - 一张卡可能由多个客户共享（家庭卡/赠送）—— `appointments.client_user_id` 与 service_orders.client_user_id 可能不一致；
  - 若 sale_item 因退款/转换重新加回次数（refund/convert 场景），已被关的预约不会回滚；
  - 关闭未走预约状态机校验（CC4 状态机：'已确认'→'已关闭' 是合法但应记 `cancelled_reason`，当前没写 reason）。
- **风险**：合法预约被错误关闭（C 端用户体验事故），状态机崩坏边缘。
- **修复**：(L3) 关闭范围限定本顾客（`AND client_user_id = so.client_user_id`），写 cancelled_reason='次数耗尽'。

#### [P0-05-08] complete 内嵌 commission 计算把 admin/staff 行为永久不可对齐 —— **重复跨端业务**
- **文件**：`staff service.js:387-450` vs `admin services.ts:357-380`
- **现象**：staff 在 service.complete 内用 ~60 行 JS 实时查 commission_rate_matrix，admin 同名动作完全不查。两套行为不仅不一致，且 staff 实现存在 N+1（per-item rate 查询）、N+1+1（per-item INSERT operation_logs）。real.md 未要求两端口径一致，但作为单一事实表，分歧产生不可调和资损（P0-05-06 已记）。这条作为重复体跨端不一致再单列。
- **修复**：(L3/L7) 收敛到一处（推荐 admin 调 staffApi 内部 RPC，或抽 db helper），或者把提成生成移到 cron-worker（脱离 complete 主路径，提升原子性 + 减少 staff.complete 锁时间）。

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-05-09] is_shengmei / sales_category / unit_real_price 快照仅在 create 拷贝，sale_items 退款冲销后未重算
- **文件**：`staff service.js:196-205`
- **现象**：service_items 三个快照字段从 sale_items 当前值拷贝。若 service_orders.create → 期间订单退款写入 refund_out 行（不动原 sale_item，新增 refund_out 行）→ 原快照可继续核销，但提成口径 sales_category 已不应再产生收益。无重算/反推机制。
- **风险**：退款后服务单仍按原 sales_category 计算提成，real.md #2 价格快照不可变与 #3 支付幂等的边界场景。
- **修复**：(L7) admin 退款审批后联动检查关联 service_items 是否已 complete；若已 complete 则反向 INSERT service_commissions(is_void=true) 或 INSERT 红冲行。

#### [P1-05-10] staff.list 列表查询缺少 scope 助手（buildStoreScopeCondition）
- **文件**：`staff service.js:480-518, 619-636`
- **现象**：staff 服务单 list/detail/counts 只用 `so.store_id = $1`（单 store_id 取 effectiveStoreId）。管理层模式（loginLevel='management'）下 effectiveStoreId 应为 null，list/detail/counts 都会查不到任何数据（management 用户在 service Tab 看到空）。CC3 命中。
- **风险**：管理层用户 service Tab 一片空白，不一致体验；总部 / 市场角色无法看下属门店服务单。
- **修复**：(L3) 用 `utils/scope.js` 的 `buildStoreScopeCondition(ctx.auth, 'so.store_id', $n)`，与 order.list 同模式。

#### [P1-05-11] complete 流程内 commission 计算 N+1 查询；complete 大单（10+ items）显著拉长事务
- **文件**：`staff service.js:401-411`
- **现象**：每个 service_item 独立查 commission_rate_matrix 一次。事务内串行，10 个 item 即 10 次往返。
- **风险**：CC2 长事务 + 持锁；对 sale_items 的 UPDATE 锁链拉长 → 顾客端并发 service.list 阻塞。
- **修复**：(L3) 一次拼接 IN(...) + ORDER BY amount_tier_min DESC 用 LATERAL JOIN 批量取 rate；或事务前查好 rateMap。

#### [P1-05-12] client.service.detail / list 直接返回 service_orders.assigned_employee_id（员工 ID 是内部 PK 不应暴露）
- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/service.js:23-43, 83-101`
- **现象**：返回 employee_id（WorkFine 内部 ID 风格 string PK）。CC6 PII 命中虽不直接泄漏 PII，但暴露内部 PK 让顾客端可枚举。
- **修复**：(L3) 仅返回 employeeName / 头像，不返回 employee_id。

#### [P1-05-13] client.service.detail 不校验 service_order 状态，已取消的服务单也对顾客可见
- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/service.js:39-46`
- **现象**：仅 `client_user_id = $2` 过滤，未对 status 做任何过滤。已取消的服务单仍展示到顾客的"服务记录"。
- **修复**：(L3) `AND so.status IN ('待服务','服务中','已完成')`。

#### [P1-05-14] generator 用 `Date#toISOString().slice(2,10)` UTC 时区跨午夜重号
- **文件**：`staff service.js:769-770`
- **现象**：与 audit-02 P0-02-02 相同模式。北京时间 00:00–08:00 staff 端用 UTC 算出昨日 dateStr，admin 用 `to_char(NOW(), 'YYMMDD')` 即 PG 服务器时区。两端跨午夜后小时窗口算出不同号段。
- **修复**：(L3) 统一用 PG `to_char(NOW() AT TIME ZONE 'Asia/Shanghai', 'YYMMDD')`。

#### [P1-05-15] generateServiceItemId 用 `Math.random()`，无唯一约束（service_item_id 是 PRIMARY KEY 但靠 random 兜底）
- **文件**：`staff service.js:792-794`
- **现象**：`'si_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)`，约 36^9 ≈ 10^14 空间，Birthday paradox 在 1e7 次插入下碰撞概率 < 1e-3，但有概率。admin 用 `${id}-${index}` 形式更稳。
- **修复**：(L3) 改为 `${serviceOrderId}-${String(idx+1).padStart(2,'0')}` 同 admin。

#### [P1-05-16] start 不存在的幂等：重复点 start 第二次直接报"状态已变更"，前端 UI 体验差
- **文件**：`staff service.js:266-273`
- **现象**：start CAS WHERE status='待服务'，第二次 start 立即抛错。complete 有幂等分支（line 311-318），start 没有。前端 staff "开始服务" 按钮被网络抖动重连发两次时报错。
- **修复**：(L3) start 加幂等：if so.status==='服务中' 直接返回成功。

### 3.3 P2（代码质量 / 可维护）

#### [P2-05-17] errorMessage 全部 INVALID_PARAMS 前缀，状态相关错误应该用 PERMISSION_DENIED 或新增前缀
- **文件**：`staff service.js:103, 263, 321, 322, 458` 等
- **现象**：状态机失败、剩余次数不足、关联预约非法都是 `INVALID_PARAMS:`，与 audit-02 P2-02-17 一致：自定义错误前缀（`次数不足:`、line 367）甚至直接抛中文，不在 4 约定内。CC5 命中。
- **修复**：(L3) 引入 `STATE_INVALID:` / `RESOURCE_EXHAUSTED:` 前缀或挂在 INVALID_PARAMS 之下细分 reason 字段。

#### [P2-05-18] complete 内 SELECT remaining_sessions 二次查询冗余
- **文件**：`staff service.js:372-385`
- **现象**：UPDATE 后再 SELECT 看是否归 0，可改用 `RETURNING remaining_sessions` 一句。当前两次往返。
- **修复**：(L3) 改 `UPDATE ... RETURNING remaining_sessions`。

#### [P2-05-19] list 顾客姓名兜底逻辑过度复杂（client_wechat_users.name + sale_orders.customer_name）
- **文件**：`staff service.js:560-588`
- **现象**：先查 client_wechat_users.name，缺则从最近订单 customer_name 取。v3.1 后 client_wechat_users 已合并 customers，name 应该已齐；兜底逻辑成为死代码。
- **修复**：(L3) 删除兜底，留警告 log。

#### [P2-05-20] complete 内 INSERT operation_logs 'rate_missing' 写到 detail JSON，但 source='staffApi' 不等于其他模块用 'staffApi' 还是 'staff_api'
- **文件**：`staff service.js:419-430`
- **现象**：source 字段值与其他模块不一致（cron-worker 用 'cronTask'）。CC9 命中（操作日志 source 命名不规范）。
- **修复**：(L3) 统一为 'staff_api' 或 'staffApi'，文档化。

#### [P2-05-21] start/complete/cancel 的 detail 查询都用 `SELECT *`
- **文件**：`staff service.js:248, 295, 731`
- **现象**：`SELECT *` 把所有列拉回 JS，包括将来新增字段；维护性差。
- **修复**：(L3) 改 explicit column list。

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 服务单号前缀 | `FY-FW-` | `HLD-WX-` | 不生成 | 号段碎片，无法跨端搜索 | P0 |
| advisory lock key | `hashtext('service_order_id_gen')` | `Buffer.reduce` 私有 hash | — | 跨端并发 create 不互斥 | P0 |
| service_items.sku_id INSERT | 不写（schema 也无） | **写**（PG 报列不存在） | — | staff create 100% 失败 | P0 |
| commission 写入 | 无 | 有（per-item） | — | admin 完成路径无提成 | P0 |
| cancel 状态范围 | 仅"待服务" | 待服务+服务中 | — | 状态机分歧 | P1 |
| start 幂等 | 无 | 无 | — | 抖动重试报错 | P1 |
| 服务记录可见状态 | 全部 | 默认 store 内 | 全部含已取消 | client 看到无意义已取消 | P1 |
| serviceItemId 生成 | `${orderId}-${idx}` | `Math.random()` | — | staff 端理论碰撞 | P1 |
| 时区基准 | PG `to_char(NOW())` | UTC `toISOString()` | — | 跨午夜重号窗口 | P1 |

## 5. 横切检查（套用 §3）

- [x] CC1 数值精度：`Math.round(x*100)/100` 在 staff complete 中正确使用；NUMERIC(10,2)/(5,4) 列定义合规。
- [ ] **CC2 并发幂等**：
  - staff.create 事务外校验 → P0-05-03
  - admin / staff lock key 不同 → P0-05-02
  - start 无幂等 → P1-05-16
  - generateServiceOrderId 用 toISOString slice → P1-05-14（同 audit-02 跨午夜模式后续命中）
- [ ] **CC3 组织隔离**：staff list/detail/counts 未用 `buildStoreScopeCondition` → P1-05-10（audit-01 §CC3 后续命中，管理层模式空白）
- [ ] **CC4 后端鉴权**：admin completeServiceOrder 用 `isAdminScope` + 预查 storeId 包含在 scopeStoreIds，但 cancel/start 直接 `scopeCondition()` 拼 WHERE，模式不统一（CC4 admin 隐式合约后续命中）。
- [ ] **CC5 错误码**：`INVALID_PARAMS:` 滥用、混入中文裸抛、source 字段命名不规范 → P2-05-17/05-20（audit-01/02 后续命中）
- [x] CC6 PII：service.list 顾客姓名脱敏未做（已在 audit-01 P0-PII-06 体系内），本域不重复登记；employee_id 暴露 → P1-05-12。
- [ ] **CC7 时间字段**：started_at / completed_at 写入责任清晰；但 `Date#toISOString().slice(2,10)` 时区漂移 → P1-05-14。
- [ ] **CC8 WXML/Vant**：未深入前端验证。
- [ ] **CC9 测试与残留**：services.test.ts 未覆盖 staff.create 的 sku_id 列 INSERT（admin 测试覆盖不到 staff 实现），P0-05-01 是测试盲区典型。

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/service.ts` + 新 migration | (a) 决策保留 `sku_id` → ADD COLUMN，否则 (b) 移除 staff INSERT 的 sku_id；新增 `appointment_id` partial unique；新增 `client_user_id WHERE status IN(...)` partial unique | P0-05-01, P0-05-03 |
| L0 schema/enums | `db/schema/service-commission.ts` | 增加 status 列（'已生成','待重算','已作废'）支持 rate=0 重算流 | P0-05-05 |
| L3 staff routes | `staffApi/routes/service.js:207-224` | 删除 sku_id 列引用（或改 schema 后保留） | P0-05-01 |
| L3 staff routes | `staffApi/routes/service.js:55-164` | 整段挪入事务内，事务外只做参数校验 | P0-05-03 |
| L3 staff routes | `staffApi/routes/service.js:722-764` | cancel 限定仅 '待服务'，对齐 admin | P0-05-04 |
| L3 staff routes | `staffApi/routes/service.js:377-385` | 关闭预约时加 `AND client_user_id` + 写 cancelled_reason | P0-05-07 |
| L3 staff routes | `staffApi/routes/service.js:480/619/810` | 接入 buildStoreScopeCondition | P1-05-10 |
| L3 staff routes | `staffApi/routes/service.js:266-273` | start 加幂等分支 | P1-05-16 |
| L3 staff routes | `staffApi/routes/service.js:769-770` | dateStr 改 PG 时区版本 | P1-05-14 |
| L3 staff routes | `staffApi/routes/service.js:792-794` | serviceItemId 改 `${orderId}-${idx}` 模式 | P1-05-15 |
| L3 client routes | `clientApi/routes/service.js:23-43` | 加 status IN 过滤 + 不返回 employee_id | P1-05-12, P1-05-13 |
| L7 admin actions | `fengyu-admin/src/actions/services.ts:333-396` | 调用 staff complete 等价提成生成逻辑（或 cron 异步重算） | P0-05-06 |
| L7 admin actions | `fengyu-admin/src/actions/services.ts:498-516` | 前缀对齐 staff（或反之），lock key 收敛 | P0-05-02 |
| L9 staff frontend | `pages/service/*` | 增加"开始服务"重复点保护 | P1-05-16 |

## 7. 验证 SQL（在 5434/fengyu EXPLAIN，禁止写入）

```sql
-- (1) 确认 service_items 表是否有 sku_id 列（应 0 行；P0-05-01 实证）
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='service_items' AND column_name='sku_id';

-- (2) 检查 service_orders 是否已存在跨前缀混用
SELECT
  CASE
    WHEN service_order_id LIKE 'HLD-WX-%' THEN 'HLD-WX'
    WHEN service_order_id LIKE 'FY-FW-%' THEN 'FY-FW'
    ELSE 'OTHER'
  END AS prefix,
  COUNT(*)
FROM service_orders
GROUP BY 1;

-- (3) 是否存在同一 appointment_id 关联多条 service_orders（P0-05-03 实证）
SELECT appointment_id, COUNT(*)
FROM service_orders WHERE appointment_id IS NOT NULL
GROUP BY appointment_id HAVING COUNT(*) > 1;

-- (4) 是否存在同顾客多条进行中服务单
SELECT client_user_id, COUNT(*)
FROM service_orders WHERE status IN ('待服务','服务中')
GROUP BY client_user_id HAVING COUNT(*) > 1;

-- (5) 已完成服务单中 commission_rate=0 但 consume_amount>0 的提成行（P0-05-05 实证）
SELECT COUNT(*)
FROM service_commissions
WHERE commission_rate = 0 AND consume_amount > 0 AND is_void = false;

-- (6) admin 路径下完成的服务单（commission_status IS NULL 且 status='已完成'）（P0-05-06 实证）
SELECT COUNT(*) FROM service_orders WHERE status='已完成' AND commission_status IS NULL;

-- (7) 验证 cancel 'service_order' 状态分布（P0-05-04 状态机审计）
SELECT status, COUNT(*) FROM service_orders WHERE status='已取消' GROUP BY status;

-- (8) 是否存在 sale_item_id 已耗尽但仍有未关闭预约（P0-05-07 副作用）
SELECT a.sale_item_id, a.status, si.remaining_sessions
FROM appointments a
JOIN sale_items si ON si.sale_item_id = a.sale_item_id
WHERE a.status IN ('待确认','已确认') AND si.remaining_sessions = 0;
```

## 8. 回归测试用例（建议）

1. **P0-05-01 复现**：本地 5434 直接 `INSERT INTO service_items (..., sku_id, ...) VALUES (...)`，确认报 42703；写一个 staffApi 集成测试用例（mock pg）覆盖 service.create。
2. **P0-05-02 advisory lock key 一致性**：staff + admin 并发 1000 次 service.create，确认无 23505。
3. **P0-05-03 TOCTOU**：Goroutine/Promise.all 并发跑 5 次 staff.create 同 appointmentId 或同 clientUserId+'待服务'，断言只有 1 条插入成功。
4. **P0-05-05 rate=0 路径**：清空 commission_rate_matrix 行执行 service.complete，验证应当不写 service_commissions（或可重算）。
5. **P0-05-06 admin 完成不写提成**：admin completeServiceOrder 后查 service_commissions 应当与 staff.complete 等价。
6. **P0-05-07 预约关闭范围**：构造一张共享卡 sale_item，由顾客 A 完成最后一次服务，验证顾客 B 的预约 NOT 被关闭。
7. **P1-05-10 management 模式列表**：管理层登录调 service.list，断言能看到 scope 内全部门店服务单。
8. **P1-05-13 client list 已取消过滤**：创建一条 cancel 的服务单，client.service.list 应不包含它。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB）：☑**
- 涉及历史数据：☑（P0-05-05 需要回扫历史 rate=0 提成；P0-05-06 admin 路径下完成的服务单需要补提成；P0-05-07 需要回扫被错误关闭的预约）
- 修复成本：**L**（4 个 P0 + 8 个 P1 + 5 个 P2，跨端协调，含 schema 变更）

## 10. 后续待办

- [ ] 与域 06 预约转单确认：service.create 校验"appointment 已关联"是否应该升 partial unique
- [ ] 与域 07/08 提成域确认 rate=0 时的处理流（重算策略 + admin 补单 UI）
- [ ] 与域 11 退款确认 sale_items refund 后 service_items 快照是否回写
- [ ] 与域 23 操作日志确认 source='staffApi' vs 'staff_api' 命名规范
- [ ] 跨域统一 ID 生成 helper（订单 / 服务单 / 款项流水 / 退款单）
