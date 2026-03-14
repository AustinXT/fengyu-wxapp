const automator = require('miniprogram-automator')

module.exports = async function () {
  const miniProgram = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: require('path').resolve(__dirname, '..'),
  })
  global.__miniProgram = miniProgram
}
