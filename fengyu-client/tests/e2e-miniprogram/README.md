# client L3 E2E（IDE automator 驱动真小程序）

12 条用户旅程，覆盖完整链路（前端 + 云函数 + PG）。

## 前置（一次性）

1. 微信开发者工具 → 设置 → 安全 → 服务端口 = 9420
2. 在 IDE 中装载 `fengyu-client/miniprogram` 项目（appid `wx811eb4ded3dfba3f`）
3. 等 IPv6 9420 ws listener 起来（约 15-60s）：
   ```bash
   until lsof -nP -iTCP:9420 -sTCP:LISTEN | grep -q IPv6; do sleep 3; done
   ```

## 跑法

```bash
# 预检
bun fengyu-client/tests/e2e-miniprogram/setup.mjs

# 全部 12 条
bun fengyu-client/tests/e2e-miniprogram/run-all.mjs

# 仅跑指定 journey
bun fengyu-client/tests/e2e-miniprogram/run-all.mjs --only j1,j2

# 单 journey
bun fengyu-client/tests/e2e-miniprogram/j6-scan-pay.spec.mjs

# 清残留
bun fengyu-client/tests/e2e-miniprogram/cleanup.mjs
```

## OPENID 模式

clientApi cloud function **默认未开** `ALLOW_TEST_OPENID=true`，所以 L3 journeys 走 **probe 模式**：

- 启动 spec 时 callFunction 'auth.login' 拿到当前 IDE 的真实 OPENID
- 用该 OPENID 在 `client_wechat_users` UPSERT 测试 fixture（phone / bound_store_id）
- 后续步骤的 callFunction 走真实 OPENID
- cleanup 反向把测试 fixture 字段恢复（详见 `helpers/client-l3-login.mjs`）

**可选优化**：把 clientApi 远端环境变量 `ALLOW_TEST_OPENID=true` 部署：
```bash
# 编辑 fengyu-client/cloudbaserc.json，在 clientApi.envVariables 加 "ALLOW_TEST_OPENID": "true"
# 然后
cd fengyu-client && printf '\n' | tcb fn config update clientApi
```
开启后 spec 跑时设环境变量 `ALLOW_TEST_OPENID_REMOTE=true`，使用固定的 `TEST_E2E_L3_CLIENT_OPENID` 跑，
不污染真实 IDE OPENID。详见 `helpers/client-l3-login.mjs::INJECT_MODE`。

## 12 条 Journey

| # | 文件 | 路径 / 关键 action |
|---|------|-------------------|
| 1 | j1-onboarding | app launch → auth.login → auth.bindStore → home tab |
| 2 | j2-shopping-to-cart | home → shop → service-detail → SKU 选规格 → 加购 → cart |
| 3 | j3-checkout-pay | cart → checkout → order.create → offlinePay |
| 4 | j4-order-management | profile → orders → detail → cancel |
| 5 | j5-appointment | appointment → create → 提交 → list 刷新 |
| 6 | j6-scan-pay | 模拟扫码 → scan-pay → scanAdjust → confirmPrepaidFull |
| 7 | j7-prepaid-card | profile → prepaid-cards → recharge |
| 8 | j8-points-messages | points + messages |
| 9 | j9-coupon | my-coupons + checkout 用券 |
| 10 | j10-store-switch | profile → store-select → 切换 |
| 11 | j11-profile-edit | profile-edit → 改昵称 / 头像 |
| 12 | j12-treatment-experience | treatment-cards + experience |

## 命名空间

- 数据：`TEST_E2E_L3_*`（与 L2 `TE2L2_*` 严格隔离）
- 商品：`TEST_E2E_L3_PROD` / `TEST_E2E_L3_SKU_N|C|E`
- 储值卡：`TEST_E2E_L3_CARD`
- 优惠券：`TEST_E2E_L3_CTPL` / `TEST_E2E_L3_CPN`
- 清理：`./helpers/fixtures.mjs::cleanupL3TestData()`

## 故障排查

| 症状 | 检查 |
|------|------|
| connect ws 失败 | `lsof -nP -iTCP:9420 -sTCP:LISTEN` 必须有 IPv6 行 |
| appId 不匹配 | IDE 当前装载的小程序非 client，切到 fengyu-client/miniprogram |
| FUNCTION_NOT_FOUND | 同上，cloud function 注册在 client 的 envId |
| PG 残留 | `bun fengyu-client/tests/e2e-miniprogram/cleanup.mjs` |


### #273 图片窗口专项（无需共享业务库）

`node fengyu-client/tests/e2e-miniprogram/cover-window.spec.mjs` 在独立ignored编译目录、测试AppID（touristappid）测试200体验卡/200订单明细/200首页与商城商品，往返及observer失效后每个页面最多24图片节点，且可视槽位完整。源码订单入口仍关闭，仅测试产物启用；App启动前测试产物禁用真实云请求，然后注入合成接口。原生导航通过专用协议调用，以实际路由等待就绪；scroll-view需等目标槽位到达后再断言，不能将尚未滚动的首屏当底部。微信工具RC版本握手缺字段时直接用automator协议并核验SDK3.14.3，不修改node_modules。

如需真实体验卡分页链路，先在127.0.0.1:54416的专用`issue256cireplay`库重放全部迁移，再显式设置`COVER_WINDOW_PG_TEST_URL`运行同一命令。它通过自动化协议调用真实product路由与真实SQL，测试200条分页、市场过滤和缩略URL；所有合成夹具在事务中，结束ROLLBACK。订单明细仍为合成API回包，不声称验证真实订单后端或CloudBase认证。无需关闭真实项目的域名校验，也不部署云函数。

兼容协议：已发布旧前端不传`limit/cursor`，仍获取完整体验卡列表；新前端显式传`limit:20`按游标增量加载，单页硬上限50。私有PG回归同时验证旧版200条与新版分页200条。无需限制有效SKU数量或在部署时读取生产库数量。

2026-10-05 补充：体验卡支持触底与“加载更多”按钮；翻页失败保留已有卡片与游标，可点击重试。专项原生视图测试覆盖真实按钮失败/重试到200条、从订单返回体验列表保留200条，以及订单切Tab后的图片窗口。
CI `experience-pagination-guard.yml` 的 `private-pg-pagination` 在独立合成PG16重放迁移后运行 `cover-window.pg.test.mjs`，验证真实路由10页200条无重复/遗漏及单次50条上限；不连接共享业务库。此CI不替代真机前端发布验收。
新前端源代码与云函数同在PR #516；云函数可先发布，旧版协议仍完整可见。新小程序通过审核发布后启用分页与封面窗口；旧版仍有其原有的全量加载内存开销，待自然升级后可另行退役兼容协议。

窗口在可见期间每200ms按原生槽位位置校准，覆盖观察器首屏正常、后续静默的情况；测量回包800ms超时后重试，迟到回包由请求号与世代隔离。隐藏/卸载停止测量与观察器。

两条独立判据：默认`full`专项验证四页正常/故障与返回；另执行`COVER_WINDOW_SCOPE=experience COVER_WINDOW_PG_TEST_URL=postgresql://postgres:test@127.0.0.1:54416/issue256cireplay node fengyu-client/tests/e2e-miniprogram/cover-window.spec.mjs`，聚焦真实product路由+私有PG+原生体验卡200条的同一链路（订单作为导航返回目标仍用合成回包）。聚焦通道不替代四页完整回归，日志分别声明范围。测试产物故障注入必须且只能命中一次，否则断言失败。
