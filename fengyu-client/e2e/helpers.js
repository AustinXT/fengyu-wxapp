/**
 * E2E 测试辅助工具
 */
const automator = require('miniprogram-automator')
const config = require('./automator.config')

let miniProgram = null

/**
 * 连接到已打开的开发者工具项目（不启动新实例）
 * 需要开发者工具已打开并启用服务端口
 */
async function connect() {
  if (miniProgram) return miniProgram
  miniProgram = await automator.connect({
    wsEndpoint: 'ws://localhost:9420',
  })
  return miniProgram
}

/**
 * 启动开发者工具并打开项目（首次运行时使用）
 */
async function launch() {
  if (miniProgram) return miniProgram
  miniProgram = await automator.launch({
    cliPath: config.cliPath,
    projectPath: config.projectPath,
  })
  return miniProgram
}

/**
 * 关闭连接
 */
async function disconnect() {
  if (miniProgram) {
    await miniProgram.disconnect()
    miniProgram = null
  }
}

/**
 * 等待指定时间（ms）
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { connect, launch, disconnect, sleep }
