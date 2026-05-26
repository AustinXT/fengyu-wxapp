# L3 微信小程序 E2E 自动化测试

基于微信官方 `miniprogram-automator` + 微信开发者工具 CLI 的真机/IDE 级 E2E。
区别于 L2（云函数 action 直测）：L3 真正驱动小程序运行时（wx API、Page 生命周期、Vant 组件渲染），
能验证"前端 + 云函数 + PG"完整链路。

> 命名空间：所有测试数据使用 `TEST_E2E_L3_*` 前缀，与 L2 Agent 的 `TEST_E2E_L2_*` 完全隔离，
> 共享同一个生产业务库 PG。

## 一次性配置（必做）

### 1. 微信开发者工具开启 "服务端口"

`miniprogram-automator` 通过 IDE 的本地 HTTP 服务通信，**默认端口 9420**。

操作：

1. 启动微信开发者工具
2. 顶部菜单 `设置` → `安全设置`
3. 勾选 **"服务端口"**（端口号保留 `9420` 默认）
4. 重启微信开发者工具一次
5. 验证：

   ```bash
   curl http://127.0.0.1:9420
   ```

   返回任意 HTTP 响应（不是 `Connection refused`）即视为开启成功。

#### 重要：IPv4 vs IPv6 ws server

实测在 macOS 上，IDE 在同一个 9420 端口同时开了**两个不同协议的 server**：

| 协议 | 监听地址 | 用途 | curl 响应 |
|------|----------|------|----------|
| HTTP backend | `127.0.0.1:9420` (IPv4) | IDE 内部 HTTP 接口 | `404 Cannot GET /` |
| WebSocket automation | `[::1]:9420` (IPv6) | miniprogram-automator 入口 | `426 Upgrade Required` |

`helpers/automator.mjs` 的 `connect()` 已经按顺序尝试 `localhost / [::1] / 127.0.0.1`，
让 OS 优先解析到 IPv6 命中 ws server。**不要硬编码 `ws://127.0.0.1:9420`**，它一定连不上。

诊断命令：

```bash
# 检查 IPv6 listener 是否就位（必须有 IPv6 那行才能 ws 连通）
lsof -nP -iTCP:9420 -sTCP:LISTEN
```

如果只有 IPv4 listener 没有 IPv6，说明 IDE 没真正进入 automation 模式，
通常需要在 IDE 中实际**打开过项目并加载完成**才会建 IPv6 ws server。

### 1.5 IDE 项目装载

`smoke-client-*` 要求 IDE 装 `fengyu-client/miniprogram`（appid `wx811eb4ded3dfba3f`）；  
`smoke-staff-*` 要求 IDE 装 `fengyu-staff/miniprogram`（appid `wxe3f5d9ee6a94d22d`）。

切换项目（**必须 quit IDE 后再 cli auto**，否则会被拒）：

```bash
# 完全清理 IDE（含 pkill 守护进程）
/Applications/wechatwebdevtools.app/Contents/MacOS/cli quit
pkill -9 -f wechatwebdevtools
sleep 5

# 启 IDE 并装载 staff 项目，自动化 9420
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram \
  --port 9420

# 等到 lsof 出现 IPv6 9420 listener（通常需要 15~30s，有时更久）
until lsof -nP -iTCP:9420 -sTCP:LISTEN 2>/dev/null | grep -q IPv6; do sleep 3; done

# 现在可以跑 staff smoke
bun tests/e2e-miniprogram/smoke-staff-confirm-offline.mjs
```

切到 client：

```bash
# 同样：quit + pkill + cli auto，--project 指向 client
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/miniprogram \
  --port 9420
```

**经验**：IDE 起 IPv6 ws server 的时机有偶然性。如果 60s 后还没起 IPv6 listener，
关闭 IDE 重来一次；或者用 GUI 打开 IDE→装项目→设置中勾选 "服务端口=9420"→重启 IDE。

### 2. （可选，店长流程才需要）开启云函数 ALLOW_TEST_OPENID

`smoke-client-home.mjs` 不需要登录，可跳过此步。
但需要店长/顾客真实身份的 smoke（如 `smoke-staff-confirm-offline.mjs`）依赖云函数测试模式。

**安全提示**：`ALLOW_TEST_OPENID=true` 会允许任意 `_testOpenid` 参数覆盖真实 OPENID。
**仅限开发环境**，正式上线必须关闭。

#### 当前状态

`fengyu-staff/cloudbaserc.json` 已含 `ALLOW_TEST_OPENID=true`，
远端 staffApi 已通过 `tcb fn config update staffApi` 同步部署，验证已生效：

```bash
tcb fn detail staffApi | grep -A1 'Environment variables'
# 应包含 ALLOW_TEST_OPENID=true; CLIENT_SECRET=...; MSSQL_...; PG_CONNECTION_STRING=...; WXACODE_ENV_VERSION=develop
```

#### 重新打开（如果以后被关掉）

```bash
# 走 cloudbaserc.json 中的 envVariables，TCB CLI 会选 Override/Merge
cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff
printf '\n' | TENCENTCLOUD_SECRETID=<.env 里> TENCENTCLOUD_SECRETKEY=<.env 里> \
  tcb fn config update staffApi
# 选 "Override update" (默认第一项)
```

`cloudbaserc.json` 的 envVariables 永远是 source of truth；用 `Override update` 是最稳的姿势
（不依赖远端现状），但要确保 cloudbaserc.json 中已包含全部 5 个变量：
ALLOW_TEST_OPENID / CLIENT_SECRET / MSSQL_CONNECTION_STRING / PG_CONNECTION_STRING / WXACODE_ENV_VERSION。

#### 关闭测试模式（生产化前必跑）

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff
# 1) 编辑 cloudbaserc.json，删除 envVariables 里的 "ALLOW_TEST_OPENID": "true" 那行
# 2) 重新 push 配置
printf '\n' | TENCENTCLOUD_SECRETID=<key> TENCENTCLOUD_SECRETKEY=<secret> \
  tcb fn config update staffApi
# 3) 校验
tcb fn detail staffApi | grep -A1 'Environment variables'  # 应不再包含 ALLOW_TEST_OPENID
```

**不要使用** `tcb fn deploy --force`（会重置环境变量）。
**也不要**直接用 tcb 命令行传 `--envVars`（已废弃，CLI 3.x 走 cloudbaserc.json）。

### 3. 安装依赖

仓库根已声明，首次拉代码后跑：

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp
npm install     # 或 bun install
```

## 跑法

### 预检（强烈推荐先跑）

```bash
bun tests/e2e-miniprogram/setup.mjs
```

依次检测：IDE 端口、PG 连接、基础 fixture。失败会打印明确指引。

### 单个 smoke

```bash
# 无需 ALLOW_TEST_OPENID（验证 L3 链路通的 hello-world）
bun tests/e2e-miniprogram/smoke-client-home.mjs

# 需要 ALLOW_TEST_OPENID（验证店长确认线下收款）
bun tests/e2e-miniprogram/smoke-staff-confirm-offline.mjs
```

### 批量跑

```bash
bun tests/e2e-miniprogram/run-all.mjs
```

`run-all.mjs` 会先 probe IDE 当前装的项目 appId，**只跑匹配的 smoke**，
其他标 `SKIP`。这是因为切换 IDE 项目 + 等 IPv6 ws ready 在 macOS 上不稳定，
所以采用"装好一个跑一个"的策略：

```bash
# 跑 staff 一族
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram --port 9420
# 等 IPv6 listener 起来
until lsof -nP -iTCP:9420 -sTCP:LISTEN | grep -q IPv6; do sleep 3; done
bun tests/e2e-miniprogram/run-all.mjs   # client SKIP，staff PASS

# 跑 client 一族
/Applications/wechatwebdevtools.app/Contents/MacOS/cli quit
pkill -9 -f wechatwebdevtools && sleep 5
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/miniprogram --port 9420
until lsof -nP -iTCP:9420 -sTCP:LISTEN | grep -q IPv6; do sleep 3; done
bun tests/e2e-miniprogram/run-all.mjs   # staff SKIP，client PASS
```

### 清理 fixture

任何 smoke 失败可能留下 L3 数据残骸，跑：

```bash
bun tests/e2e-miniprogram/cleanup.mjs
```

只会删 `TEST_E2E_L3_*` 命名空间，**不会触及生产数据**。

## 目录结构

```
tests/e2e-miniprogram/
├── README.md                          # 本文
├── setup.mjs                          # 全局预检
├── teardown.mjs / cleanup.mjs         # L3 命名空间清理
├── run-all.mjs                        # 顺序跑全部 smoke
├── smoke-client-home.mjs              # 顾客端首页（无需登录）
├── smoke-staff-confirm-offline.mjs    # 员工端确认线下收款（需 ALLOW_TEST_OPENID）
└── helpers/
    ├── constants.mjs                  # 命名空间常量、CLI 路径、超时
    ├── automator.mjs                  # launch / disconnect / 端口检测
    ├── pg.mjs                         # pg.Pool 单例 + tx 封装
    ├── fixtures.mjs                   # 造数 + 命名空间清理
    ├── login.mjs                      # _testOpenid 登录 + 直调 staffApi
    └── pg-assert.mjs                  # PG 业务状态断言
```

## 重要约束

1. **IDE 必须保持运行**：automator 只控制 IDE，不能替代它启动小程序运行时。
2. **IDE 当前项目必须与 smoke 匹配**：IDE 单窗口加载单项目；
   跑 `smoke-client-*` 时 IDE 要打开 `fengyu-client/miniprogram/`，
   跑 `smoke-staff-*` 时 IDE 要打开 `fengyu-staff/miniprogram/`。
   错配会得到 `cloud.callFunction:fail FunctionName parameter could not be found`，
   因为云函数注册在对应小程序的 envId 下。
3. **同一时间只能跑一个 smoke**：IDE 单窗口加载单项目，并行会互相打架。
   `run-all.mjs` 已串行设计。
4. **不动 L2 Agent 目录**：本测试只读 `fengyu-staff/` / `fengyu-client/`，
   完全不碰 `tests/e2e-cloudfn/`。
5. **不修改生产代码**：仅在 `tests/e2e-miniprogram/` + `package.json` devDeps 改动。
6. **失败时优先看**：
   - 端口未开 → 跑 `curl http://127.0.0.1:9420` 验证；helper 也会自动扫 IDE 进程的监听端口
   - `Port 9420 is in use` → IDE 已经在 9420 监听了，本 helper 已默认走 connect 模式，
     若仍报错说明 launch 路径被触发，多半是 IDE 没装载任何项目；先在 IDE 中手动打开项目
   - login 失败 (`UNAUTHORIZED` / `_testOpenid` 被忽略) → 远端 `ALLOW_TEST_OPENID` 没开
   - cloudfn `FUNCTION_NOT_FOUND` → IDE 当前装载的项目和 smoke 期望的项目不一致（见约束 2）
   - launch 超时 → IDE 加载小程序慢（首次编译/未构建 npm），先在 IDE 中构建 npm 再跑
   - PG 断言失败 → 跑 `bun tests/e2e-miniprogram/cleanup.mjs` 清残留后重试

## 扩展指南

新增 smoke 时遵循：

1. 文件名 `smoke-<scope>-<scenario>.mjs`（如 `smoke-staff-create-order.mjs`）
2. 主键 / openid 全部走 `helpers/constants.mjs` 暴露的 `TEST_E2E_L3_*`
3. 失败时 finally 里必须 `cleanupL3TestData()` + `disconnect(miniProgram)` + `closePool()`
4. 任何新建的 PG 表写入都要在 `helpers/fixtures.mjs.cleanupL3TestData()` 里加对应 DELETE

## 与 L2 测试的协作

| 维度 | L2 (cloudfn) | L3 (miniprogram) |
|------|--------------|------------------|
| 入口 | 直接调用云函数 action | 通过小程序运行时调 `wx.cloud.callFunction` |
| 命名空间 | `TEST_E2E_L2_*` | `TEST_E2E_L3_*` |
| 依赖 IDE | 否 | **是** |
| 覆盖 UI | 不覆盖 | 覆盖（页面渲染、Vant 组件、wx API） |
| 速度 | 快（秒级） | 慢（启动 IDE ~10s+） |

L2 跑回归 + 边界；L3 跑关键路径（登录、下单、收款、预约）。

## 业务场景 spec（scenarios/bs*.spec.mjs）

| 编号 | 文件 | 优先级 | 说明 |
|------|------|--------|------|
| BS-01 | bs01-order-flow | P0 | 完整开单链路 |
| BS-02 | bs02-refund-approve | P0 | 退款审批 |
| BS-03 | bs03-service-lifecycle | P0 | 服务单 Tab 自动迁移 |
| BS-04 | bs04-allocation | P0 | 营业额分配徽章联动 |
| BS-05 | bs05-appt-to-service | P1 | 预约 → 到店 → 服务单 |
| BS-06 | bs06-role-visibility | P1 | 4 类身份 18 条 UI 显隐矩阵 |
| BS-07 | bs07-customer-assign | P1 | 顾客分配双 actor |
| BS-08 | bs08-conversion-panel | P1 | ConversionPanel 交互 |
| BS-09 | bs09-card-recharge | P1 | 充值卡开单 → qrcode |
| **BS-10** | **bs10-mgmt-scope-options** | **P1** | **管理层 scope 切换（HQ/market/store）** |
| **BS-11** | **bs11-multi-store-switch** | **P1** | **市场经理 workbench 切 A1↔A2** |
| **BS-12** | **bs12-cross-store-deny** | **P1** | **跨店越权 UI 拒绝** |

### 跑业务场景

```bash
# 一键脚本（自动 quit/cli auto staff 项目）
./fengyu-staff/tests/run-staff-l3.sh --scenarios

# 过滤跑（推荐迭代时）
./fengyu-staff/tests/run-staff-l3.sh --scenarios --filter bs10,bs11,bs12

# 全部 12 个场景
./fengyu-staff/tests/run-staff-l3.sh --scenarios --bail
```

### BS-10/11/12 fixture 依赖

这三个 spec 共用 `createTestPersonnelMatrix()`（2 市场 × 3 门店 + 5 个不同 role/scope 员工），由 `helpers/fixtures.mjs` 提供：

| 员工 | role | scope | openid 常量 |
|------|------|-------|------------|
| mgrA1 | manager | 门店 A1 | TEST_OPENID_MANAGER |
| mgrA2 | manager | 门店 A2 | TEST_OPENID_MANAGER_A2 |
| mgrMarket | manager | 市场 A | TEST_OPENID_MANAGER_MARKET |
| mgrHQ | manager | 总部 | TEST_OPENID_MANAGER_HQ |
| finHQ | finance | 总部 | TEST_OPENID_FINANCE_HQ |
| mgrB1 | manager | 门店 B1 | TEST_OPENID_MANAGER_B1 |

需要远端 staffApi 已开启 `ALLOW_TEST_OPENID=true`（见上文 §2）。
