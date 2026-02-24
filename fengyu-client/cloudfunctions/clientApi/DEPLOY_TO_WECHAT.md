# clientApi 云函数部署指南

## 目标环境
- **环境 ID**: `cloud1-3gpht4b01ff88838`
- **小程序 APPID**: `wx811eb4ded3dfba3f`
- **云函数名**: `clientApi`

## 部署方法

### 方法 1: 使用微信开发者工具（推荐）

1. **打开微信开发者工具**
   - 打开项目 `fengyu-wxapp`
   - 确保 `project.config.json` 中配置了正确的 appid: `wx811eb4ded3dfba3f`

2. **上传云函数**
   - 在左侧文件目录中找到 `cloudfunctions/clientApi`
   - 右键点击 `clientApi` 文件夹
   - 选择「上传并部署：云端安装依赖」
   - 等待上传完成（约 1-3 分钟）

3. **验证部署**
   - 点击「云开发」控制台
   - 进入「云函数」页面
   - 查看 `clientApi` 函数是否显示为最新版本

### 方法 2: 使用微信云开发控制台

1. **访问控制台**
   ```
   https://mp.weixin.qq.com/
   ```

2. **进入云开发**
   - 登录小程序后台
   - 点击「开发」→「开发管理」→「云开发」
   - 选择环境 `cloud1-3gpht4b01ff88838`

3. **上传云函数**
   - 进入「云函数」页面
   - 点击「新建云函数」或找到 `clientApi`
   - 选择「上传代码」
   - 上传 `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/cloudfunctions/clientApi` 目录

### 方法 3: 使用 cloudbase CLI（需要切换账号）

如果 `cloud1-3gpht4b01ff88838` 属于另一个腾讯云账号，需要：

1. **切换腾讯云账号**
   ```bash
   tcb login --force
   ```

2. **重新部署**
   ```bash
   cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client
   tcb fn deploy clientApi --dir cloudfunctions/clientApi --envId cloud1-3gpht4b01ff88838
   ```

## 部署后验证

### 在小程序中测试

```javascript
// 在小程序页面中调用
wx.cloud.init({
  env: 'cloud1-3gpht4b01ff88838'
})

wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'store.list',
    payload: {}
  }
}).then(res => {
  console.log('云函数调用成功', res)
}).catch(err => {
  console.error('云函数调用失败', err)
})
```

### 在云开发控制台测试

1. 进入云开发控制台
2. 点击「云函数」→「clientApi」
3. 点击「测试」标签
4. 输入测试参数：
   ```json
   {
     "action": "store.list",
     "payload": {}
   }
   ```
5. 点击「运行测试」

## 常见问题

### Q: 环境不存在错误
**A**: 确保 `cloud1-3gpht4b01ff88838` 是微信小程序云开发环境，而不是腾讯云 CloudBase 环境。两者是不同的体系。

### Q: 权限不足
**A**: 确保当前登录的微信开发者账号有该小程序的管理员权限。

### Q: 云函数目录找不到
**A**: 检查 `project.config.json` 中的 `cloudfunctionRoot` 配置是否正确：
```json
{
  "cloudfunctionRoot": "cloudfunctions/"
}
```

## 相关文件

- 云函数代码: `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/cloudfunctions/clientApi/`
- MCP 配置: `/Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/mcp.json`
- 小程序配置: `project.config.json`

## 需要帮助？

如果遇到问题，请检查：
1. 微信开发者工具是否登录了正确的账号
2. 小程序 APPID 是否正确
3. 云开发环境是否已开通
