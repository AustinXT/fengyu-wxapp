# 获取腾讯云 API 密钥指南

## 步骤 1: 访问腾讯云控制台

打开浏览器，访问：
https://console.cloud.tencent.com/cam/capi

## 步骤 2: 登录腾讯云账号

使用你的腾讯云账号登录（账号：ApplePasswords-2b5）

## 步骤 3: 创建或查看 API 密钥

### 选项 A: 查看现有密钥

如果你已经有 API 密钥：
1. 在「API 密钥管理」页面查看现有密钥
2. 点击「显示」查看 SecretKey（默认隐藏）
3. 复制 SecretId 和 SecretKey

### 选项 B: 创建新密钥

如果没有密钥或想创建新密钥：
1. 点击「新建密钥」按钮
2. 输入密钥名称（如：`fengyu-wxapp-deploy`）
3. 点击「确定」创建
4. **重要**: 立即复制并保存 SecretId 和 SecretKey（SecretKey 只显示一次）

## 步骤 4: 配置环境变量

获取到密钥后，有两种配置方式：

### 方式 1: 临时环境变量（推荐）

在终端中执行：

```bash
export TENCENTCLOUD_SECRETID="你的SecretId"
export TENCENTCLOUD_SECRETKEY="你的SecretKey"
```

然后运行配置脚本：

```bash
cd /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client
./configure-env.sh
```

### 方式 2: 一行命令（更安全）

```bash
TENCENTCLOUD_SECRETID="你的SecretId" \
TENCENTCLOUD_SECRETKEY="你的SecretKey" \
./configure-env.sh
```

### 方式 3: 永久配置（添加到配置文件）

编辑 `~/.zshrc` 或 `~/.bash_profile`：

```bash
# 腾讯云 API 密钥
export TENCENTCLOUD_SECRETID="你的SecretId"
export TENCENTCLOUD_SECRETKEY="你的SecretKey"
```

然后重新加载配置：

```bash
source ~/.zshrc  # 或 source ~/.bash_profile
```

---

## 安全建议

1. **不要将密钥提交到 Git 仓库**
   - ✅ 使用环境变量
   - ✅ 添加 `.env` 到 `.gitignore`
   - ❌ 不要写在代码中

2. **定期轮换密钥**
   - 建议每 3-6 个月更换一次
   - 在腾讯云控制台删除旧密钥，创建新密钥

3. **使用子账号密钥**
   - 不要使用主账号密钥
   - 为部署任务创建专用的子账号
   - 只授予必要的权限（CloudBase 相关权限）

4. **IP 白名单（可选）**
   - 在腾讯云控制台设置密钥的 IP 白名单
   - 只允许特定 IP 使用该密钥

---

## 权限要求

API 密钥需要以下权限：

- `QcloudSCFFullAccess` - 云函数全读写权限
- `QcloudTCBFullAccess` - CloudBase 全读写权限

或使用自定义策略：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "scf:UpdateFunctionConfiguration",
        "scf:GetFunction"
      ],
      "resource": [
        "qcs::scf:ap-shanghai:uid/*:namespace/cloud1-3gpht4b01ff88838/function/clientApi"
      ]
    }
  ]
}
```

---

## 验证密钥

获取密钥后，可以验证是否有效：

```bash
# 使用腾讯云 CLI 验证
tcb login --apiSecretKey YOUR_SECRET_KEY --apiSecretId YOUR_SECRET_ID

# 或测试列出环境
tcb env:list
```

---

## 下一步

获取密钥后，请提供给我（SecretId 和 SecretKey），我将自动配置环境变量。

**注意**: 提供密钥后，我会立即配置环境变量，不会存储密钥信息。
