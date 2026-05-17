# L3 业务场景 E2E 测试方案

## 1. 目的与定位

**L3 smoke 已经覆盖**：每个 staff Tab / 子包页面能不能加载 + 关键 setData 字段是否落地。守护"小程序运行时连得通云函数 + 页面渲染没崩"。

**业务场景 E2E 要补的盲区**：
- 多步流转中**中间 UI 状态**对不对（购物车小红点、Tab 徽章数、按钮 disable 条件、toast 文案）
- **跨页面状态机**（开单页 → qrcode 页 → 订单详情页，状态、数据一致）
- **角色显隐**（manager vs 美容师 同一页面看到不同按钮）
- **业务不变量在 UI 上的反映**（扣卡次后列表 -1、退款审批后徽章 -1、积分入账后顾客等级 tag 跳档）

**L3 不该做的（属于 L2 / 单元测试责任）**：
- 单 action 的纯后端逻辑（金额计算、SQL 正确性、FK 守卫）
- 边界值 / 错误码穷举
- 跨端协同（client 端 + staff 端 同一会话，IDE 单窗口约束做不到）

---

## 2. 方法论：场景四象限

| 业务复杂度↓ \ UI 复杂度→ | 单页 UI | 多页 UI |
|---|---|---|
| **简单后端** | 单元测试 | L3 smoke（已覆盖）|
| **复杂后端** | L2 cloudfn smoke | **L3 业务场景**（本设计） |

**L3 业务场景的入选标准（必须同时满足）**：
1. 用户完整故事 ≥ 3 步页面流转
2. 至少 1 处"UI 显隐 / disable / 徽章数"业务规则
3. 后端写一份数据，前端读一份，**前后端不一致就是 bug**
4. 不能仅靠 L2 检查发现（即"看 PG 知道 OK"但"用户看不见"也算 bug）

---

## 3. 候选场景全景图（13 个，按优先级标注）

| # | 场景 | 优先级 | 步数 | 主要风险点 |
|---|------|--------|------|---------|
| BS-01 | 完整开单链路：选品 → 购物车 → 顾客 → 优惠券 → 提交 → qrcode | **P0** | 6 | 4 步交互 + 价格汇总实时计算 |
| BS-02 | 退款审批端到端：发起 → 审批 → 徽章 -1 | **P0** | 4 | 跨页面徽章联动 + scope 校验 |
| BS-03 | 服务单 Tab 自动迁移：待服务 tap → 服务中 Tab 出现 → 完成 → 已完成 Tab | **P0** | 5 | Tab 状态机 + 卡余次实时反映 |
| BS-04 | 营业额分配：待分配徽章 → 智能分配 → 调比例 → 保存 → 徽章消失 | **P0** | 5 | 比例 ≤100% 校验 + 徽章联动 |
| BS-05 | 预约 → 到店 → 服务单自动创建 | P1 | 4 | 跨页面 state hand-off |
| BS-06 | 角色显隐回归：店长 vs 美容师 同登 workbench/profile，按钮可见性差异 | P1 | 2×多 | 角色 capability 驱动 wxml v-if |
| BS-07 | 顾客分配（拓客）：店长选员工 → 美容师列表 -1 → 顾客切到目标员工 | P1 | 4 | 双 actor，需切换登录 |
| BS-08 | 转换单 ConversionPanel：选源卡 → 选目标 → 差额展示 → 提交 → 储值卡入账 | P1 | 5 | ConversionPanel 组件交互复杂 |
| BS-09 | 充值卡开单：选 SKU/自定义金额 → 提交 → qrcode → 顾客扫码 callback → balance | P1 | 5 | qrcode → callback 链路 |
| BS-10 | 会员等级跳档可视化：开单后 customer-detail 顾客 tag 从 '初钻' → '星钻' | P2 | 3 | 业务规则触发 UI tag 更新 |
| BS-11 | 多店店长切店：profile bindStore → workbench 数据切换 | P2 | 3 | scope 切换 + 缓存失效 |
| BS-12 | 退款理由必填 / customPrice 守卫的 toast 文案 | P2 | 2 | 错误提示 UX |
| BS-13 | 数据看板（dashboard）周期切换 + 排行榜联动 | P3 | 3 | 仅读路径，价值有限 |

**首批做 P0 共 4 个**；P1 看时间排进 round 2；P2/P3 留 backlog。

---

## 4. 详细场景设计（P0 四个）

### BS-01 完整开单链路（最复杂，最有价值）

**用户故事**：店长 A 在 order-create 页给顾客小王（手机 1399…）开一张 ¥600 单品 + 1 张 ¥1500 疗程卡，使用 30 元优惠券，线下收款，跳到 qrcode 等顾客付款。

**前置 fixture**：
- 店长（已绑权限）
- 顾客（已绑店）
- 2 个 SKU：单品 ¥600 / 疗程卡 ¥1500 × 5 次
- 用户优惠券：¥30 现金券 minSpend=200

**步骤 + 断言矩阵**：
| Step | 操作 | UI 断言 | PG 断言（异步）|
|------|------|---------|--------------|
| 1 | navigateToTab `/pages/order-create/order-create` | 大类 Tab 列出，第一个高亮，data.skus 非空 | — |
| 2 | tap '疗程卡' 大类 | data.activeCategory='疗程卡'，SKU 列表更新 | — |
| 3 | tap "加入购物车" (sku=疗程卡) × 1 | 购物车 badge=1，data.cart.length=1 | — |
| 4 | tap '单品' 大类 → tap "加入购物车" (sku=单品) × 1 | badge=2，cart 含 2 项，data.cartTotal=2100 | — |
| 5 | 打开结算弹层（tap 购物车 icon） | 弹层 visible，data.checkoutVisible=true | — |
| 6 | 选顾客（tap "选择顾客" → 在结果列表 tap 小王） | data.selectedClient.userId 落地 | — |
| 7 | 选优惠券 → 自动应用 | data.couponDiscount=30，data.payableAmount=2070 | — |
| 8 | 选支付方式 '线下'、tap "提交" | toast "提交中" → 跳 packageOrder/order-qrcode | sale_orders 行存在，status='待确认收款' |
| 9 | qrcode 页加载完成 | data.saleOrderId 显示，price=2070 | sale_items=2，coupon_id 写入，allocation_status='待分配' |

**实现要点**：
- `tapByText` 当前实现遍历 view/button/text，对 Vant 组件不可靠 → 必须先做 `Issue-H1` (见 §6)
- 第 9 步 PG 断言不能立即查（需等待异步 setData）→ `waitForData((d) => d.saleOrderId)` + `await pgPoll(orderId, '已支付')`
- 内部单 / 转换单分别另起 BS-01b/c（共用同一份步骤模板）

---

### BS-02 退款审批端到端

**用户故事**：店长 A 给顾客小王已支付订单 ¥800 发起 ¥200 退款，店长 B（另一账号）在 refund-list 看到徽章 +1，进 refund-detail 同意，徽章 -1，订单 refunded_amount=200。

**前置 fixture**：
- 店长 A + 店长 B（同店）
- 顾客 + 已支付 sale_order(¥800, received=800)

**步骤 + 断言矩阵**：
| Step | Actor | 操作 | UI 断言 | PG 断言 |
|------|-------|------|---------|---------|
| 1 | A | navigate `/packageOrder/order-list` → tap 订单 → tap "退款" → 填 ¥200 + 原因 → 提交 | toast "退款已发起，等待审批" | sale_order_payments 新增 1 行 change_type='退款' status='待审批' amount=-200 |
| 2 | B | login + navigate workbench | 工作台 todoList "待审批退款" 徽章 = 1 | — |
| 3 | B | navigate `/packageOrder/refund-list` | 列表第 1 行 = 步骤 1 的退款 | — |
| 4 | B | tap 进 refund-detail | 显示 ¥200 + 原因 + "同意" "拒绝" 按钮 | — |
| 5 | B | tap "同意" | toast "审批通过" → 回 refund-list，徽章 = 0 | sop.status='已支付' + sale_orders.refunded_amount=200 |

**实现要点**：
- 双 actor → 用 `loginAs(testOpenid)` 切换（不需重启 IDE，调 `loginStaffWithTestOpenid` 重写 globalData 即可）
- 徽章数字需要 `waitForData((d) => d.todoList?.pendingRefundCount === 1)` 等异步刷新

---

### BS-03 服务单 Tab 自动迁移

**用户故事**：美容师 C 给小王做疗程卡（剩 5 次）。在"待服务"Tab 看到该服务单 → tap "开始服务" → 自动切到"服务中" → tap "完成服务" → 切到"已完成"，且剩余次数变 4 次。

**前置 fixture**：
- 美容师 C（仅 staff 角色）
- 顾客 + 疗程卡 sale_item (remaining_sessions=5)
- 服务单 status='待服务'

**步骤 + 断言矩阵**：
| Step | 操作 | UI 断言 | PG 断言 |
|------|------|---------|---------|
| 1 | navigateToTab `/pages/service/service` | Tab '待服务' 默认激活，data.list 含 1 项 | — |
| 2 | tap 服务单卡 → 弹"开始服务"确认 → 确认 | toast "服务已开始" → Tab 自动切 '服务中'，data.activeTab='服务中'，list 含 1 项 | service_orders.status='服务中' + started_at 非空 |
| 3 | tap 服务单 → 弹"完成服务"确认 → 确认 | toast "服务已完成" → Tab 切 '已完成'，list 含 1 项 | service_orders.status='已完成' + completed_at + sale_items.remaining_sessions=4 |
| 4 | navigate `/packageCustomer/customer-detail` (顾客) | data.customer.lastServiceDate=今天 + 剩余次数显示 "4 次" | — |

**前置已知 bug**（参考 RUN-REPORT）：service.complete 的 ON CONFLICT 语法 bug 未修则本 scenario step 3 必 FAIL。可作"修复回归验证"用。

---

### BS-04 营业额分配

**用户故事**：店长 A 看 workbench "待分配" 徽章=1 → 进 allocation-list → 选订单 → 进 revenue-allocation → 点"智能分配"看到自动填充 → 调整某员工比例至 40% → 保存 → 回 list 徽章=0。

**前置 fixture**：
- 店长 A（manager + 美容师 skill）
- 已支付 + 待分配 sale_order
- 2 名美容师（有 skills）

**步骤 + 断言矩阵**：
| Step | 操作 | UI 断言 | PG 断言 |
|------|------|---------|---------|
| 1 | workbench | data.todoList.pendingAllocationCount=1，徽章可见 | — |
| 2 | tap "待提成分配" → navigate `/packageOrder/allocation-list` | list 含 1 项 | — |
| 3 | tap 订单 → navigate `/packageOrder/revenue-allocation` | 显示订单总额 + sale_items 列表 | — |
| 4 | tap "智能分配" 按钮 | 自动填充 N 行分配（按 skills 推荐），data.allocations.length≥1 | — |
| 5 | 修改第 1 行 ratio 0.50→0.40，添加第 2 行 ratio 0.30 | data.allocations[0].ratio=0.40，总比例显示 0.70（含警示如有） | — |
| 6 | tap "保存" | toast "分配已保存" → 回 list，list.length=0，回 workbench 徽章=0 | sale_allocations 写 2 行 + sale_orders.allocation_status='已分配' |

**实现要点**：
- "智能分配"按钮需要 `tapByText('智能分配')` 或 `selector` 精确点
- ratio 修改需要操作 input 或 picker（取决于 wxml 实现，需先 inspect）

---

## 5. P1 场景设计要点（简版）

### BS-05 预约 → 到店 → 服务单
- fixture: appointment(status=已确认)
- 步骤：appointment-detail → tap "顾客到店" → tap "创建服务单" → service-create 页带入 client + items → 提交
- 关键断言：service_orders.appointment_id 写入 + appointment 自动转 '已完成'

### BS-06 角色显隐回归
- 不是 1 个场景而是个**矩阵**测试：4 个角色 × 5 个页面 × 每页 2-3 个关键按钮
- 实现：写 `assertElementVisible/Hidden` helper + 数据驱动循环
- 价值：防止 v-if 条件改错后某角色看到不该看到的按钮（权限漏洞）

### BS-07 顾客分配（双 actor）
- 店长 A 分配顾客小王给美容师 C
- 切美容师 C 登录 → 进我的客户 → 看到小王
- 关键：loginAs 切换不需要重启 IDE

### BS-08 转换单
- ConversionPanel 是组件，需要先用 `page.$('conversion-panel')` 定位
- 步骤多但流程线性，按 BS-01 模板

### BS-09 充值卡开单
- 流程同 BS-01 但 SKU 是充值卡
- 验证点：sale_orders.is_recharge_card=true + sale_items.is_recharge_card=true（混单守卫）

---

## 6. 基建增量（必须先做，否则场景跑不了）

### Issue-H1 鲁棒 tap helper（阻塞 BS-01/02/04）
当前 `tapByText` 遍历 `view, button, text` 太慢且对 Vant 组件不可靠。改造：
```js
// helpers/automator.mjs
export async function tap(page, { selector, text, index = 0 }) {
  // 优先 selector，text 作为二次过滤
  const els = await page.$$(selector || 'view, button, text, navigator, .van-button')
  const matches = []
  for (const el of els) {
    if (text) {
      const t = await el.text().catch(() => '')
      if (!t.includes(text)) continue
    }
    matches.push(el)
  }
  if (matches[index]) { await matches[index].tap(); return true }
  throw new Error(`tap not found: selector=${selector} text=${text} index=${index}`)
}

export async function tapByText(page, text) { return tap(page, { text }) }
```

### Issue-H2 toast 断言 helper（阻塞 BS-01/02/03）
小程序 wx.showToast 不是 DOM 节点。劫持方式：
```js
// 在 evaluate 里全局 hook wx.showToast，把 title 推到全局数组
await page.evaluate(() => {
  if (!wx.__e2e_toasts) {
    wx.__e2e_toasts = []
    const orig = wx.showToast
    wx.showToast = function (opts) { wx.__e2e_toasts.push(opts.title); return orig(opts) }
  }
})
// 断言
export async function assertToast(page, expectedText, timeoutMs = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const toasts = await page.evaluate(() => wx.__e2e_toasts || [])
    if (toasts.some(t => t.includes(expectedText))) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`assertToast 超时: 期望含 "${expectedText}"`)
}
```

### Issue-H3 loginAs 切账号 helper（阻塞 BS-02/07）
不重启 IDE 也能切登录身份：
```js
export async function loginAs(miniProgram, openid) {
  // 1. 清 storage + globalData
  await miniProgram.evaluate(() => {
    wx.removeStorageSync('_test_openid')
    const app = getApp()
    if (app?.globalData) app.globalData = { systemInfo: app.globalData.systemInfo }
  })
  // 2. 重走 login 流程
  return loginStaffWithTestOpenid(miniProgram, openid)
}
```
注意：auth.login 不读 `_testOpenid` → roles/staffWfId 还是 IDE 真实账号决定。要切真账号必须用 staff fixture 把 _testOpenid 对应的 employee_id 在 PG 里准备好 + 让后续 action（带 _testOpenid）走对账号 scope。Manager 角色判定靠 callStaffApi 的 auth 中间件，那条是吃 _testOpenid 的。

### Issue-H4 截图收集（用于失败回放）
```js
export async function snapshot(miniProgram, label) {
  const ts = Date.now()
  const dir = path.join(__dirname, '..', 'test-results', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${label}-${ts}.png`)
  await miniProgram.screenshot({ path: file, fullPage: true })
  return file
}
```
每个 P0 场景在每个 step 前后截图；失败时把最近 3 张路径打进 stderr。

### Issue-H5 pgPoll 等异步副作用
某些 action 异步落库（积分发放、消息推送）。直接 query 不一定能立即看到。
```js
export async function pgPoll(sql, params, predicate, { timeoutMs = 5000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const rows = await query(sql, params)
    if (predicate(rows)) return rows
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`pgPoll 超时`)
}
```

---

## 7. 文件布局

```
fengyu-staff/tests/e2e-miniprogram/
├── smoke-staff-*.mjs                 # 既有 10 个 L3 smoke (保留)
├── scenarios/                        # 新增：业务场景
│   ├── README.md
│   ├── bs01-order-flow.spec.mjs      # 完整开单链路（P0）
│   ├── bs02-refund-approve.spec.mjs  # 退款审批（P0）
│   ├── bs03-service-lifecycle.spec.mjs # 服务单 Tab 迁移（P0）
│   ├── bs04-allocation.spec.mjs      # 营业额分配（P0）
│   ├── bs05-appt-to-service.spec.mjs # 预约 → 服务（P1）
│   ├── bs06-role-visibility.spec.mjs # 角色显隐矩阵（P1）
│   ├── bs07-customer-assign.spec.mjs # 顾客分配（P1）
│   ├── bs08-conversion-panel.spec.mjs # 转换单（P1）
│   └── bs09-card-recharge.spec.mjs    # 充值卡（P1）
├── helpers/
│   ├── automator.mjs                 # 扩 tap/tapByText/assertElementVisible
│   ├── toast.mjs                     # 新增（H2）
│   ├── login.mjs                     # 加 loginAs（H3）
│   ├── screenshot.mjs                # 新增（H4）
│   ├── pg.mjs                        # 加 pgPoll（H5）
│   └── ...
└── run-scenarios.mjs                 # 类似 run-all.mjs，但只跑 scenarios/
```

run-all 不动；scenarios 单独入口 `bun fengyu-staff/tests/e2e-miniprogram/run-scenarios.mjs`，因为：
- scenarios 慢（每个 30-90s）；smoke 全套已经 5 分钟，混合会让 CI 时间难看
- scenarios 失败率 > smoke（UI 脆性）；分开运行便于排查

---

## 8. 执行顺序 & 验收

### Phase 1：基建（必须先做，3 小时）
1. H1 tap helper 改造 → 用既有 smoke 验证不破坏
2. H2 toast 断言 → 在 smoke-staff-confirm-offline 加 1 行断言验证
3. H3 loginAs → 写小测验证切换
4. H4 截图 → 加到 confirm-offline，跑一次看输出文件
5. H5 pgPoll → 替换 confirm-offline 的同步 query

### Phase 2：P0 四个场景（按顺序 1 个 1 个做，每个 1-2 小时）
1. BS-01 开单（最复杂，先攻克）
2. BS-02 退款（依赖 H3 loginAs）
3. BS-03 服务单生命周期（等 staffApi service.complete 生产 bug 修后跑通）
4. BS-04 营业额分配

### Phase 3：P1 场景（按业务优先级，2 小时/个）
BS-05/06/07/08/09 按需

### Phase 4：CI 化（可选）
- `run-scenarios.mjs` 加 `--filter` `--bail`（任一失败停下）
- 失败时自动收集 screenshot + console.log + PG snapshot
- 后续可挂到 staff 分支 merge 前

### 验收标准
- Phase 1：5 个 helper 都有 1 个 demo 跑通
- Phase 2：4 个 P0 场景全 PASS，回归无 transient
- Phase 3：5 个 P1 场景全 PASS
- 总耗时：P0 ≤ 3 分钟，P0+P1 ≤ 8 分钟

---

## 9. 已知限制 & 取舍

| 限制 | 取舍 |
|------|------|
| IDE 单窗口 = 不能 staff + client 双端同时跑 | 双端协调走 L2（直接 invoke staffApi + clientApi）+ L3 mock 缺席 actor |
| auth.login 不读 _testOpenid，无法控制登录身份 | 后续 action 用 _testOpenid 拿到正确 scope；UI 显示身份用最初 login 返回（实际显示可能错，但 capability 检查是对的） |
| Vant 组件 tap 不能直接选 `.van-button` 内部 text | tap helper 支持 selector + text 二段过滤 |
| 微信支付 callback 在 IDE 里没办法真实触发 | 用 `callStaffApiWithTestOpenid('order.confirmOffline', ...)` mock 顾客支付动作 |
| screenshot 是 PNG 二进制，git 不应直接提交 | `tests/test-results/screenshots/` 加 .gitignore；CI 上可作为 artifact 上传 |

---

## 10. 与 L2 / L1 的协作

| 测什么 | L1 | L2 | L3 smoke | L3 scenario |
|--------|----|----|----------|-------------|
| 算法/工具函数 | ✅ | — | — | — |
| 单 action 业务逻辑 + 边界 | — | ✅ | — | — |
| 单 action × PG 副作用 | — | ✅ | — | — |
| 页面能否加载 | — | — | ✅ | — |
| 多步流转 + UI 中间态 | — | — | — | ✅ |
| 角色 capability 显隐 | — | — | — | ✅ |
| 跨页面状态机 | — | — | — | ✅ |
| 业务不变量 UI 反映 | — | — | — | ✅ |

任何 bug 都应该被金字塔某一层抓住。如果 L3 scenario 抓到的 bug 能在 L2 抓到，是 L2 漏；反之 L2 抓不到只能 L3 抓的，是 L3 的本职。

---

## 11. 后续可扩展（不在本期）

- **视觉回归**：截图 diff（pixelmatch）防 UI 改版肉眼难察觉的偏移
- **性能预算**：每场景跑完总耗时 / PG 查询数，超阈值预警
- **mock 微信支付 callback**：模拟 wxpay 回调写 sale_order_payments，让 BS-01 真的跑通付款
- **场景 DSL**：高频用 step 模板抽象成 `defineScenario({ steps: [...] })` 减少样板代码
- **跨端集成（client + staff）**：用 L2 直接 invoke 双端 API 拼接场景，绕开 IDE 单窗口约束
