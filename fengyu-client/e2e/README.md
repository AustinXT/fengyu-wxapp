# fengyu-client E2E（miniprogram-automator）

通过微信开发者工具的自动化端口模拟用户操作小程序，可以让 Claude Code 直接驱动 IDE 跑流程。

## 一次性准备

1. **打开服务端口**：微信开发者工具 → 设置 → 安全 → 「服务端口」打开（默认 `9420`）
2. **导入项目**：DevTools 打开 `fengyu-client/` 目录（`project.config.json` 在此目录）
3. **登录态**（关键）：小程序登录靠 `wx.login` + 手机号绑定，automator 无法全自动完成。**首次手动用真机/IDE 模拟手机号登录一次**，IDE 会保存登录态，后续 automator 连上就是已登录状态。
4. 依赖已在 `package.json`，若未装跑：`cd fengyu-client && npm i`

## 跑冒烟脚本（推荐 CC 调用）

```bash
cd fengyu-client
node e2e/smoke.js              # 连已开的 IDE
LAUNCH=1 node e2e/smoke.js     # IDE 没开时由脚本拉起
```

流程：首页 → 预约 Tab → 我的 → 商城 → 我的订单。每步打印 path + 关键 data 字段，截图保存在 `e2e/screenshots/<时间戳>/`。

退出码 0 通过 / 1 失败，CC 看 stdout 即可知道结果。

## 写新流程

直接照 `smoke.js` 加 `step('xxx', async () => {...})`。不引入测试框架，所有 e2e 都用 automator 直接驱动 + 独立 node 脚本。

## 常见坑

- **没开服务端口**：`connect` 报 `connect ECONNREFUSED 127.0.0.1:9420`。去 DevTools 设置里勾上。
- **CLI 路径不对**：脚本默认 macOS 路径 `/Applications/wechatwebdevtools.app/Contents/MacOS/cli`，Windows/Linux 自行改 `smoke.js` 顶部常量。
- **页面进了登录页**：登录态丢了，去 IDE 里手动登录一次。
- **switchTab 卡住**：tabBar 路径要带前导 `/`，且必须是 `app.json` 里的 `pages` 列表。
- **page.$ 找不到 Vant 内部元素**：Vant 是自定义组件，外层选择器（`.van-tab`）能拿到，深层 DOM 要进 shadow root，automator 不支持，建议改用 `page.data()` 断言。
- **截图全黑**：开发者工具最小化了，让窗口保持可见。
