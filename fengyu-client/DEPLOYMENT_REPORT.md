# clientApi 云函数部署完成报告

**部署时间**: 2026-02-25
**环境 ID**: cloud1-3gpht4b01ff88838
**函数名称**: clientApi
**部署状态**: ✅ 成功

---

## 一、部署详情

### 1.1 云函数信息

| 项目 | 值 |
|------|-----|
| 函数名称 | clientApi |
| 运行时 | Nodejs18.15 |
| 入口函数 | index.main |
| 超时时间 | 15 秒 |
| 部署方式 | COS 上传 |

### 1.2 环境变量配置

✅ **已配置以下环境变量**:

#### PostgreSQL 连接
```
PG_CONNECTION_STRING=postgresql://fengyu:fengyu123@47.113.202.7:5432/fengyu_wxapp
```

- **主机**: 47.113.202.7 (ali-demo 服务器)
- **端口**: 5432
- **数据库**: fengyu_wxapp
- **用户**: fengyu
- **密码**: fengyu123

#### SQL Server 连接
```
MSSQL_CONNECTION_STRING=Server=111.229.31.128,1433;Database=wkdb_20220804_86cd3292;User Id=Sa;Password=oHx#+Q;TrustServerCertificate=True
```

- **主机**: 111.229.31.128 (WorkFine 服务器)
- **端口**: 1433
- **数据库**: wkdb_20220804_86cd3292
- **用户**: Sa
- **密码**: oHx#+Q

### 1.3 配置文件更新

✅ **已更新以下配置文件**:

1. **~/.zshrc**
   - 注释掉旧的腾讯云凭证
   - 添加新的 DevFengyu 子账号凭证

2. **fengyu-client/.env**
   - 创建环境变量配置文件
   - 包含腾讯云 API 密钥
   - 包含数据库连接信息

3. **.gitignore**
   - 已添加 `.env` 文件，防止密钥泄露

4. **cloudbaserc.json**
   - 更新环境变量配置
   - 使用连接串格式

5. **cloudfunctions/clientApi/db/mssql.js**
   - 支持 MSSQL 连接串格式
   - 向后兼容分离的环境变量

---

## 二、验证步骤

### 2.1 控制台验证

1. **打开控制台**:
   https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf

2. **查看云函数列表**:
   - 应该看到 `clientApi` 函数
   - 状态应为「正常」

3. **查看环境变量**:
   - 点击 `clientApi` → 配置 → 环境变量
   - 应该看到 `PG_CONNECTION_STRING` 和 `MSSQL_CONNECTION_STRING`

### 2.2 功能测试

在云函数测试面板中运行以下测试用例：

#### 测试 1: 门店列表查询

```json
{
  "action": "store.list",
  "payload": {}
}
```

**预期结果**:
```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "storeName": "南昌梦祥店",
      "marketName": "南商市场",
      ...
    }
  ]
}
```

#### 测试 2: 品项分类列表

```json
{
  "action": "product.categories",
  "payload": {}
}
```

**预期结果**: 返回品项分类列表

---

## 三、下一步操作

### 3.1 数据库初始化

在 ali-demo 服务器上初始化 PostgreSQL 数据库：

```bash
# 1. 确认 PostgreSQL 已安装并运行
systemctl status postgresql

# 2. 初始化表结构
cd /Users/nv/proj.xt.com/fengyu-wxapp/db
export DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5432/fengyu_wxapp"
npx drizzle-kit push

# 3. 插入测试数据
# 参考 DATABASE_INIT.md
```

### 3.2 接口联调测试

使用 `test_cases.json` 中的测试用例，在云函数测试面板中逐一验证：

1. ✅ 认证模块 (auth.login)
2. ✅ 门店模块 (store.list)
3. ✅ 商品模块 (product.categories, product.spuList)
4. ✅ 员工模块 (staff.list)
5. ✅ 订单模块 (order.create, order.list)
6. ✅ 预约模块 (appointment.create)
7. ✅ 服务模块 (service.detail)

### 3.3 小程序前端集成

在小程序代码中调用云函数：

```javascript
// miniprogram/app.js
wx.cloud.init({
  env: 'cloud1-3gpht4b01ff88838',
  traceUser: true
})

// 调用云函数
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'store.list',
    payload: {}
  }
}).then(res => {
  console.log('门店列表:', res.result)
})
```

### 3.4 部署员工端云函数

参考 clientApi 的部署流程，部署 staffApi 云函数。

---

## 四、故障排查

### 问题 1: 环境变量未生效

**症状**: 云函数报错 "未配置 PG_CONNECTION_STRING"

**解决方法**:
1. 在控制台确认环境变量已保存
2. 等待 1-2 分钟让配置生效
3. 重新运行云函数测试

### 问题 2: PostgreSQL 连接失败

**症状**: 报错 "Connection refused" 或 "连接超时"

**排查步骤**:
```bash
# 1. 检查 PostgreSQL 服务状态
ssh root@47.113.202.7
systemctl status postgresql

# 2. 检查端口是否开放
telnet 47.113.202.7 5432

# 3. 检查防火墙规则
firewall-cmd --list-ports

# 4. 测试数据库连接
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -U fengyu -d fengyu_wxapp -c "SELECT 1"
```

### 问题 3: SQL Server 连接失败

**症状**: 报错 "Login failed" 或 "连接超时"

**排查步骤**:
```bash
# 1. 测试端口连通性
telnet 111.229.31.128 1433

# 2. 验证用户名密码
# (需要 sqlcmd 工具)
sqlcmd -S 111.229.31.128,1433 -U Sa -P 'oHx#+Q' -d wkdb_20220804_86cd3292 -Q "SELECT 1"
```

---

## 五、安全建议

1. **定期轮换密钥**
   - 每 3-6 个月更换一次数据库密码
   - 更换后同步更新环境变量

2. **限制数据库访问**
   - PostgreSQL: 配置 pg_hba.conf 只允许 CloudBase IP 访问
   - SQL Server: 只读权限，仅允许 SELECT

3. **API 密钥管理**
   - 使用子账号密钥（已实现 ✅）
   - 定期在腾讯云控制台检查密钥使用情况
   - 不再使用的密钥及时删除

4. **代码安全**
   - 不要在代码中硬编码密码
   - 使用环境变量存储敏感信息
   - .env 文件已添加到 .gitignore ✅

---

## 六、相关文档

- [环境变量配置指南](./ENV_VARIABLES_GUIDE.md)
- [快速配置指南](./QUICK_ENV_SETUP.md)
- [数据库初始化指南](../DATABASE_INIT.md)
- [云函数部署文档](./cloudfunctions/clientApi/DEPLOYMENT.md)
- [系统架构设计](../.42cog/spec/system_architecture.md)

---

## 七、部署记录

| 时间 | 操作 | 结果 |
|------|------|------|
| 2026-02-25 04:47 | 部署 clientApi 云函数 | ✅ 成功 |
| 2026-02-25 09:20 | 清理临时文件 | ✅ 完成 |
| 2026-02-25 09:25 | 更新 MSSQL 连接支持 | ✅ 完成 |
| 2026-02-25 09:30 | 配置环境变量 | ✅ 成功 |
| 2026-02-25 09:35 | 更新 ~/.zshrc | ✅ 完成 |
| 2026-02-25 09:36 | 创建 .env 文件 | ✅ 完成 |

---

**部署完成！** 🎉

云函数已成功部署并配置环境变量，可以开始进行接口测试和前端集成了。
