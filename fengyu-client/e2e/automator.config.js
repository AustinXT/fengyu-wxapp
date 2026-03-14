/**
 * miniprogram-automator 配置
 * 需要微信开发者工具已打开并启用了服务端口
 *
 * 使用前：
 *   1. 打开微信开发者工具 → 设置 → 安全设置 → 开启服务端口
 *   2. 导入 fengyu-client 项目
 *
 * 运行：cd fengyu-client && npx vitest run e2e/
 */
const path = require('path')

module.exports = {
  // 微信开发者工具 CLI 路径（macOS）
  cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
  // 项目路径
  projectPath: path.resolve(__dirname, '..'),
}
