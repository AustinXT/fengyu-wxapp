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

### 2. （可选，店长流程才需要）开启云函数 ALLOW_TEST_OPENID

`smoke-client-home.mjs` 不需要登录，可跳过此步。
但需要店长/顾客真实身份的 smoke（如 `smoke-staff-confirm-offline.mjs`）依赖云函数测试模式。

**安全提示**：`ALLOW_TEST_OPENID=true` 会允许任意 `_testOpenid` 参数覆盖真实 OPENID。
**仅限开发环境**，正式上线必须关闭。

由用户在终端执行（本测试代码不会自动执行此命令）：

```bash
# staffApi（员工端）
tcb fn config update staffApi \
  --envVars 'ALLOW_TEST_OPENID=true,PG_CONNECTION_STRING=postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu,CLIENT_SECRET=<原值>'

# clientApi（顾客端，按需）
tcb fn config update clientApi \
  --envVars 'ALLOW_TEST_OPENID=true,PG_CONNECTION_STRING=postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu,TMAP_KEY=<原值>,TMAP_SECRET=<原值>'
```

**注意**：`tcb fn config update` 会**整体覆盖**环境变量，必须把所有原有变量一并附上，
否则会丢 `PG_CONNECTION_STRING` 等。请先 `tcb fn detail staffApi` 拿到原配置。

测试完成后建议关闭：

```bash
tcb fn config update staffApi --envVars 'PG_CONNECTION_STRING=...,CLIENT_SECRET=...'  # 不带 ALLOW_TEST_OPENID
```

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
