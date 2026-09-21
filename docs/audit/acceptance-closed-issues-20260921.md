# 已关闭 issue 补验收报告（库存管理以外）

- **日期**：2026-09-21
- **范围**：28 条已 CLOSED 且不属于库存管理模块的 issue，合计 **145 条验收标准**
- **基线**：`chore/closed-issues-acceptance` @ `81004162`（dev / test / main 三线同点）
- **方法**：代码与迁移静态核验 → dev 库（101.34.242.103:5433/fengyu_wxapp）只读取证 → 自动化测试 → dev admin（v1.16.33）只读 UI 验收
- **原则**：全程不写业务库、不触发导出任务、不部署

> 为什么要补验收：这批 issue 当初随 PR 合并即关闭，验收标准从未逐条核对过。

## 一、结论总览

| 分组 | issue | 结论 | 未达标 / 待办 |
|------|-------|------|----------------|
| 归属日期口径 | #137 #138 #139 #140 #141 #142 | **6 条通过** | #137 两条软项未留痕（见 §3.1） |
| 顾客资产与提货 | #120 #121 #122 #125 #128 #145 #153 | **7 条通过** | L2 smoke 期望过时（见 §4.2） |
| 绩效页 | #123 #159 | **2 条通过** | — |
| 基础设施 | #133 #136 #146 #148 #151 | **5 条通过** | #146 AC4 名不副实（见 §3.2） |
| 导出 | #183 | **1 条通过** | — |
| 积分与会员权益 | #63 #64 #67 #68 #69 #71 | **6 条通过** | — |
| 积分商城 | #70 | **确认未实现** | 以 NOT_PLANNED 关闭，需求仍在 |

**27 条达标，1 条（#70）为未实现关闭。** 无一条出现「声称修好实际没修」。

## 二、自动化测试结果

| 套件 | 结果 | 说明 |
|------|------|------|
| admin vitest | **187 文件 / 3108 用例全绿** | — |
| staffApi vitest | **60 文件 / 2091 用例全绿**（60 skipped） | 含全部 `cross-end-*` snapshot |
| admin `tsc --noEmit` | **0 错误** | — |
| staff 小程序 `tsc --noEmit` | **0 错误** | #123 / #159 的 AC 之一 |
| staff L2 e2e-cloudfn（连 dev 库） | 起点 **34 PASS / 20 FAIL** → 校正后 **54 / 54 全绿** | 20 个失败逐个定性后**全是测试债**，已全部修复；见 §7.4 |
| admin 只读 UI 验收（dev 站点） | **5 PASS / 3 SKIP** | 新建套件，见 §5 |
| #136 守护反向验证 | **双向响亮失败** | 见 §3.3 |

## 三、逐条证据（仅列关键与例外）

### 3.1 #137 款项归属日期收敛

dev 库实测：

```
sale_order_payments.performance_attribution_date IS NULL      → 0 行
首次支付行归属日期 ≠ 所属订单归属日期（I6）                    → 0 行
视图 sale_item_performance_events 中 LATERAL/paired_payment   → 0 处
```

- AC1 ✅ `0041_bizarre_wolfpack.sql:25` 视图直读 `sop.performance_attribution_date`，CASE 与 LATERAL 配对子查询已删
- AC2 ✅ `trg_sale_orders_sync_payment_attribution`（AFTER UPDATE OF …）在库中存在
- AC3 ✅ **以 CHECK 约束 `chk_sop_attribution_date_present` 实现，而非 `SET NOT NULL`**。迁移内注释写明理由：`.notNull()` 会让 drizzle 的 `$inferInsert` 把该列变必填。效果等价，与验收标准字面不同，此处按达标计
- AC4 ✅ admin `lib/performance-attribution.ts` 直读、staffApi `utils/attribution-guard.js` 同步
- AC6 ✅ cron 巡检已加 I6 + I6b（文件头 L18-19）
- AC5 / AC7 ⚠ **迁移前双库 drift 报告、订单改期后三处同步的回归记录，未在 PR 或仓库中找到留痕**。库侧现状（drift=0 / NULL=0）已由本次实测补上，但"迁移前"那次核对无法追认

### 3.2 #146 cron 资金不变量

用 cron 内**原文口径**在 dev 库逐块执行 8 条 SELECT：

```
I1  received = Σ已支付款项（豁免 workfine）     → 0 违规   ✅ AC2 达标
I2  refunded_amount = -Σ退款                   → 0 违规
I2b refunded ≤ received                        → 0 违规
I3  积分余额 = Σ未过期批次                      → 1196 违规 ⚠ 见 §6.1
I4  储值卡余额 = Σ卡流水                        → 0 违规
I5  payable = total − prepaid                  → 0 违规
I6  首次支付归属日 = 订单归属日                  → 0 违规
```

> 初查 I1 曾得 14068 条，是漏掉 `legacy_source IS DISTINCT FROM 'workfine'` 豁免所致；按 cron 原文口径复核为 0，14068 全部是被豁免的 WorkFine 历史单。

- AC3 ✅ 八块 SQL 全部真库可执行
- AC4 ⚠ **验收标准要求"对每个 SQL 块做可执行性校验，防止语法错误再次潜伏"，但新增的单测 `cron/__tests__/audit-payment-invariants.test.ts` 用 `vi.mock('@/db')` 把 `db.execute` 整个 mock 掉了 —— SQL 从不发往 PG，测不出语法错误，正是当初潜伏 5 个月的同一盲区。** 真库校验只存在于 `tests/e2e-chains/cron-08-*.spec.ts`（该文件自己也写明"真实 SQL 语法只有这里能验"），而 e2e-chains 不在常规 CI 内。**建议**：把 cron-08 纳入 CI，或给每块 SQL 加 `EXPLAIN` 级冒烟

### 3.3 #136 四分类收敛（含反向验证）

验收标准 AC6 要求"临时加第 5 个枚举值，确认所有未同步处响亮失败"。本次实做两轮，跑完即回滚，工作区已复原：

| 改动点 | 结果 |
|--------|------|
| `db/schema/enums.ts` 加第 5 值 | `sales-categories-enum-snapshot.test.js` **FAIL**：`expected [4 项] to deeply equal [Array(5)]` |
| `admin/src/lib/sales-categories.ts` 改一个字面量 | 同一套件 **FAIL**：`fengyu-admin lib/sales-categories.ts 第 1 处命中与单源不一致` |

守护真实有效。单源为 `db/schema/enums.ts`，运行时副本 4 处（staffApi / admin / payNotify / efficiency.ts）全部在守护清单内，且测试文件头对"有意子集 `IN ('自销自耗','他销自耗')` 全仓 11 处不得扩成四值"有明确豁免声明。

### 3.4 #120 / #122 / #145 / #153 的数据层量化

修复到底让多少行"从看不见变成看得见"，dev 库实测：

| issue | 总行数 | 旧口径可见 | **修复后新增可见** |
|-------|--------|-----------|------------------|
| #120 家居产品行 | 526 | 366 | **160**（30.4%） |
| #122 疗程卡行 | 128975 | 115555 | **13420**（10.4%） |
| #145/#153 转入家居行 | 15（4 张单） | 0 | **15** |

（#145/#153 原 issue 称生产 14 行，dev 副本为 15 行，同量级。）

### 3.5 #151 地址迁移

`grep -rn "47.113.202.7"` 全仓（排除 node_modules）**0 处命中** —— 比验收标准（"只应剩 e2e 库"）更彻底。`db/CLAUDE.md:228/231` 有单一权威表述。

### 3.6 #70 积分商城

`gh issue view 70` 的 `stateReason = NOT_PLANNED`，关闭评论写明"尚未发现数据模型、后台配置入口、兑换下单接口或顾客/员工端流程"。本次复核确认：全仓无 `积分商城` / `points_mall` / 兑换下单相关实现。**结论：不是验收不通过，是需求未开工而被关单，需求本身仍然有效。**

## 四、staff L2 回归基线（起点 34 / 20，校正后 54 / 54）

20 个失败已单独重跑确认**稳定复现**（非并发污染），逐个定性后**没有一个是功能回归**。
下面保留当时的初判，最终定性与修复见 §7.4。

> ⚠ 跑全套时别同时开两个 `run-all.mjs`：它们共用 `TE2LS` 命名空间，会互相清夹具。
> 本次就因重复启动导致 alloc 三个用例假红，单跑即通过。

### 4.1 与本次验收范围相关（3 个，均为测试债）

| smoke | 失败断言 | 判定 |
|-------|---------|------|
| `smoke-order-list` | 待支付 tab 查不到待支付单（传了 2000-01-01~2100-12-31） | **#139 的预期后果**。`order.js:2892` 注释已写明"0 笔已入账款项的订单——纯待支付单——在本口径下不入选，与 admin 一致，非缺陷"，前端也有"未产生收款的订单不在结果内"提示。**smoke 期望未随 #139 更新** |
| `smoke-order-home-conversion` | 折抵后 `picked_up_quantity` 应=10，实际=3 | **#154 拆列后的新语义**：`order.js:2469` 明确"家居产品转出把数量记在 `converted_quantity`（#154 拆列前记在 `picked_up_quantity`）"。**smoke 期望是拆列前的旧语义** |
| `smoke-order-pickup-conversion` | 同上（应=2，实际=0） | 同上。该 smoke 其余 10 项断言全绿：转入行可见 → 可提 → 超量被拒 → 提满消失 → 再折抵后消失，**正是 #153 的主验收链路** |

### 4.2 与验收范围无关（17 个）

- `smoke-order-pickup` / `smoke-inventory`：报 `手工覆盖市场进货价必须填写价格和原因` —— 进销存联动开关在 dev 打开后的夹具缺口
- `smoke-alloc-save/delete/suggest`、`smoke-allocation-freeze`：报 `saleItemId … 不属于该回款`。该校验 2026-06/07 引入（按支付维度隔离 `sale_payment_allocatable`），夹具直插 payment 未建立分摊关系
- `smoke-confirm-offline-debt-card`：确认线下收款时储值卡抵扣未发生（现金应收 4000 而非 3100、卡余额未扣、缺"储值卡抵扣"行）。**涉及资金链路，建议单独立项排查**，本次未定性
- 其余 deny / rbac 类：多为夹具与角色绑定约束（如"角色 manager 不能绑定到部门型组织节点"）冲突

> **结论：L2 基线之前是红的，但红的主因是测试未随 #139 / #154 / 0039 约束 / 权限矩阵更新，
> 不是这 28 条 issue 的功能回归。校正工作已在本轮完成（§7.4），基线现为 54/54。**

## 五、dev admin 只读 UI 验收（新增套件）

新增 `fengyu-admin/playwright.acceptance.config.ts` + `tests/e2e-acceptance/`，直接打 dev 站点，不起本地 server、不建夹具、不写库。

```bash
cd fengyu-admin && npx playwright test --config=playwright.acceptance.config.ts
```

| 用例 | 结果 |
|------|------|
| 登录 dev admin | ✅ |
| #140 工作台现金流 KPI 渲染（今日业绩 / 已扣退款 / 金额） | ✅ |
| #138 数据中心可打开且无 RSC 报错 | ✅ |
| #183 顾客列表导出入口 + 无脱敏报错 | ✅ |
| #183 员工列表导出入口 | ✅ |
| #120 / #122 / #145 / #153 顾客详情三例 | ⏭ **SKIP** |

**SKIP 原因**（非缺陷）：`getCustomerById` 开头有 `isAdminOnly` 短路 —— **纯 admin 角色不碰顾客数据**，须 admin+manager / customer_mgr / finance。dev 上现成的账号 `INVT-ADM-01`（库存 E2E 留下）恰好是纯 admin，因此顾客详情页对它恒为 404。套件已做前置检测并明确 skip，避免把"看不到"误报成"没修好"。

**要补齐这三条 UI 验收，需要一个带 manager / customer_mgr / finance 角色的 dev admin 账号。** 代码层与数据层证据（§3.4）已覆盖同一结论。

## 六、验收范围外的发现

### 6.1 积分余额不变量在 dev 库长期违规（I3）

```
违规顾客 1196 人：1195 人账面虚高（合计 +45900 分），1 人偏低（−20 分）
point_batches 中 expired_at 非空 → 0 行；已过期仍有余额的批次 → 0 行
dev cron 每日在跑，operation_logs 里 points.balanceMismatch 已累计 19252 条
```

cron STEP 9 只告警不修复，告警持续堆积无人处理。与 MEMORY 中「到店积分冲销漏扣批次」（前两轮 repair 只扣 `points_balance`、batch remaining 仍满）方向相关，但本次数据显示主体是**反向**（balance 高于批次和），说明存在第二条只加余额不落批次的路径。**建议立项排查**。

### 6.2 e2e 库在新机尚未建

`101.34.242.103` 上只有 `fengyu_wxapp`，没有 `fengyu_e2e`（`fengyu` 角色 `rolcreatedb=false`）。后果：**admin 全部写库型 e2e（`tests/e2e-pages` 21 spec、`tests/e2e-chains` 23 link）当前无法运行**，包括 §3.2 提到的 cron-08。这是 #151 的遗留尾巴，验收标准里没写，但影响回归能力。

### 6.3 环境事实

- dev admin 版本 `v1.16.33`，与 worktree 最近 tag 一致 —— 本批改动**已发到 dev**
- dev 库最新迁移 id=49（2026-09-21 12:44），0040/0041/0046/0047 均已应用

## 七、排查结论与已做的处置（2026-09-21 补）

### 7.1 【最重要】这批改动在 prod 上基本没上线

| 项 | dev | prod |
|---|---|---|
| 迁移 | 0047（全量） | **0040**，待应用 **7 条**（0041~0047） |
| 0041 视图直读 | ✅ | ❌ 仍有 5 处 `paired_payment`（旧 CASE+LATERAL） |
| `trg_sale_orders_sync_payment_attribution` | ✅ | ❌ 不存在 |
| `chk_sop_attribution_date_present` | ✅ | ❌ 不存在 |
| `sale_items.converted_quantity`（0046） | ✅ | ❌ 不存在 |
| admin 镜像 | v1.16.33 | **e0e7d734（2026-09-12）**，早于 #137 合入 |

即 **#137 / #138 / #139 / #140 / #141 的口径收敛、#154 拆列、#183 导出列在生产上全都没生效**。
当前 prod 是「旧代码 + 旧库」自洽状态，**没有在出错**：实测 prod I1 / I2 / I2b / I4 / I5 全部 0 违规。
prod I6 有 34 条脱拍且每天新增，但旧视图有 CASE 回退兜着，不构成错账；这 34 条会被
**0041 的「① 回填首次支付行」自动拉齐**，不需要额外脚本。

**新增 `db/scripts/preflight-release.js`**（只读）：一条命令给出目标库落后几个迁移、
待应用清单与逐条风险、5 项不变量现值、0041/0046 交付物是否到位，以及出自
`docs/changes/arch/012` 的执行顺序硬约束。对 prod 已跑通。

> 结论修订：本报告 §1 的「27 条达标」指**代码与 dev 环境达标**，不等于生产已修复。

### 7.2 I3 积分虚高：根因是到店积分从不建批次

prod 1210 户账面虚高 46940 分（dev 1195 户 / 45900 分）。根因：

```
「到店赠送」正向流水 2759 条 / 55180 分，point_batches 里一条对应记录都没有
```

三端 `visit-points`（staffApi / clientApi / admin lib）发放时只 `INSERT point_transactions`
+ `UPDATE points_balance`，**从不建批次**；而消费赠送路径（`utils/points.js` 的
`grantPointBatch`、`points-settle.ts`）都建。后果三条：① I3 永久违规、cron 每日刷告警；
② **到店积分事实上永不过期**（过期处理只扫批次），与 #67 的 365 天口径相悖；
③ 抵扣时 `consumePointBatches` 尽力扣、扣不够也不报错，而余额校验看 `points_balance`
—— 所以**顾客不吃亏**，但账本长期不平，将来若把余额改成由批次汇总，这部分会凭空消失。

**已做**：
- 三端 `visit-points` 补建批次（与 `grantPointBatch` 逐字同口径：365 天、`earned_at` 取流水
  `created_at`）。两端单测全绿；并在 dev 库用事务 + ROLLBACK 实跑了改后的 SQL，
  确认批次正确落地（`到店赠送 | 20 | 20 | 365 天`）且无残留。
- 新增 `db/scripts/backfill-visit-points-batches.js`，**默认 dry-run，须显式 `--apply`**。
  dev 上预演：1195 户 / 2523 行补建 / 保留额合计 45900，与缺口完全吻合，无一户未覆盖。
  口径：按用户缺口 D 倒序（新的先保留）分配 `remaining`，`expire_at` = 流水时间 + 365 天。
  存量全部落在 2026-08-24~09-21，**没有"补建即过期"的行**，所以不需要业务拍板。

### 7.3 #146 AC4 补齐：SQL 可执行性冒烟

新增 `fengyu-admin/tests/e2e-actions/smoke-cron-sql-executable.mjs`：读 cron STEP 源文件、
抽出每个 `db.execute(sql\`…\`)` 的 SQL、还原编译期常量后逐块 `EXPLAIN`。
不调用 STEP 本体（它命中违规会写 operation_logs + 推企微，I3 现在真有违规），
也不抄 SQL 副本（抄本会与源码各自漂移）。

覆盖 4 个只读巡检 STEP 共 **23 块 SQL，全部通过**。
**反向验证**：把 I1 的 `WHERE` 挪回 `LEFT JOIN` 之前（复刻 #146 的原始写法），
脚本立刻报 `syntax error at or near "LEFT"`；回滚即绿 —— 正是现有 `vi.mock` 单测抓不到的那个。

### 7.4 L2 失败的定性与修复（20 个失败全部修完）

**结论先行：20 个失败**逐个定性后**没有一个是功能回归**，全是测试债。五类根因：

| 根因 | 涉及用例 | 说明 |
|------|---------|------|
| 夹具漏建「逐笔受领行」 | alloc×4、refund-core、refund-cascade-channels、order-refund、order-refund-list-detail、service-refund-freeze | 真实链路由 `capturePaymentAllocatables` 在付款事务内写 `sale_payment_item_receipts`；夹具直接 INSERT `sale_order_payments` 绕过了它。缺了它会以两种完全不同的面目暴露：分配报「saleItemId 不属于该回款」、退款报「退款金额无法完整映射到商品行实收」 |
| 查了订单维度的遗留表 | refund-core、refund-cascade-channels、alloc-save、alloc-delete | 分配与冲销实际落 `sale_payment_item_allocations`。**这一条不只是查不到**：两处「负数冲销净额=0」断言在空集上恒真 —— 守护看着绿，其实什么都没验 |
| 期望没跟上语义变更 | order-list(#139)、两个 conversion(#154 拆列)、alloc-save(整十规则 2026-07-21 取消)、confirm-offline / xend-scan(预选 vs 实扣字段)、order-pickup(错误前缀)、order-deposit(寄存单改走审批) | 详见下表 |
| 0039 新增的 DB 级校验 | deny-non-manager、order-refund-list-detail、order-pickup(三处) | 角色×节点类型 trigger、库存 SKU 价格模式 trigger、批次零余额建仓 trigger |
| 权限矩阵收紧 | rbac-hq-level、rbac-market-level | `customer_mgr` / `product` 本就无 `data_center:dashboard`（dev 与 prod 一致），用例却对 5 个角色一视同仁要求管理层入口 |

几个值得单独记的：

- **寄存单**：`createDeposit` 现在落「待审批」，审批入账在 admin 的 `approveDepositOrder`。
  用例原本断言的 `paid_sessions` / `unit_real_price` / `received` 都是审批**之后**才成立的，
  在 staff L2 这层无论如何跑不出来 —— 已移交 admin 侧覆盖。
- **order-pickup**：开启库存联动后，测试数据在共享 dev 库上**根本清不掉**
  （`inventory_movements` append-only 且 FK 引用 `doc_items` → docs 删不掉 → 顾客/员工/订单删不掉）。
  这正是「库存链路只跑一次性 docker 库」这条既有约定的由来。已改为按
  `INVENTORY_LINKAGE_ENABLED` 分流：默认跑主链路，库存断言需显式开启。
- **product-skulist**：夹具注释假设「一级品项已在生产库 seed」，但两库实测的一级品类只有
  其他/加项/家居/拓客引流卡/招牌/明星/王牌，夹具用的名字一个都不在 ——
  `skuList` 里 `JOIN product_categories parent` 把测试 SKU 整个过滤掉了。已改为按需补建。

#### 逐条明细

| 用例 | 定性 | 处置 |
|------|------|------|
| `smoke-confirm-offline-debt-card` | **测试债，非资金退化**：夹具写 `prepaid_card_amount`（已结算净额），而 `confirmOffline` 读 `pending_prepaid_card_amount`（预选待扣）。夹具造出「卡已扣但余额没少」的自相矛盾态，于是被当成没预选卡、欠款全算现金 | 给 `createTestSaleOrder` 加 `pendingPrepaidCardAmount` 参数并修正 `payable_amount` 公式；用例**已转绿**（现金 3100 + 卡 900 = 4000） |
| `smoke-alloc-save/delete/suggest`、`smoke-allocation-freeze` | **测试债**：往遗留表 `sale_payment_allocatable_items`（dev 尚存 390 行）写受领行，而生产侧读写的是 `sale_payment_item_receipts`（8513 行）。写错表不报错，只会让分配一律被拒成「saleItemId … 不属于该回款」 | 四个用例改到正确表；`smoke-allocation-freeze` 已转绿。`smoke-alloc-save` 另修三处过时期望：整十百分比规则已于 2026-07-21（`6f4f2d4a`）有意取消、落库表是 `sale_payment_item_allocations`（经 `receipt_id` 关联、金额列 `allocated_amount`）、超额文案改版 |
| `smoke-order-list` | **#139 的预期后果**，代码注释已写明「纯待支付单不入选，与 admin 一致，非缺陷」 | 改为不带日期守护枚举合并，另加 1b 正面固化 #139 口径；**已转绿** |
| `smoke-order-home-conversion` / `smoke-order-pickup-conversion` | **#154 拆列后的新语义**：折抵写 `converted_quantity` 而非 `picked_up_quantity` | 断言改到新列并补「两列之和不变」；**已转绿**（前者的 #182 段因 PR #196 未合默认跳过） |
| `smoke-order-pickup` | 0039 的三道库存 trigger + 联动开启后数据清不掉 | 夹具按新规则重建 + 按开关分流；**已转绿** |
| `smoke-order-deposit` | 寄存单改走审批，入账断言已不属 staff 层 | 断言改到「提交审批」语义，入账部分移交 admin；**已转绿** |
| `smoke-rbac-hq-level` / `smoke-rbac-market-level` | 权限矩阵里 customer_mgr / product 无管理层入口 | 按矩阵分流（有权的进得去、无权的被挡）；**已转绿** |
| `smoke-product-skulist` | 一级品类名在库中不存在，被 `JOIN parent` 滤掉 | 夹具按需补建一级品类；**已转绿** |
| `smoke-deny-non-manager` | 「部门 scope 员工」已被 0039 trigger 根除，场景不可达 | 翻转为守护该约束本身仍生效；**已转绿** |
| `smoke-xend-scan-confirm-scope` | 同 confirm-offline：预选 vs 实扣字段写错 | 改用 `pendingPrepaidCardAmount`；**已转绿** |

### 7.5 遗留表待清理（新发现）

`sale_payment_allocatable_items` 与 `sale_payment_item_receipts` 两张表并存，前者仅剩 390 行
历史数据、生产代码已不再读写，但 `db/schema/order.ts` 仍定义它，多个 backfill 脚本仍引用。
建议单独立项确认后下线，否则还会有人照着旧表名写测试或脚本。

## 八、复跑方式

```bash
# 静态 + 单测
cd fengyu-admin && npx vitest run && npx tsc --noEmit
cd fengyu-staff/cloudfunctions/staffApi && npx vitest run
cd fengyu-staff/miniprogram && npx tsc --noEmit

# dev 库只读取证（连接串取自 db/.env）
psql "$DATABASE_URL" -f docs/audit/... （本报告内 SQL 可直接粘贴）

# L2（连 dev 库，带 TE2LS 命名空间隔离与 cleanup）
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs

# dev admin 只读 UI
cd fengyu-admin && npx playwright test --config=playwright.acceptance.config.ts
```
