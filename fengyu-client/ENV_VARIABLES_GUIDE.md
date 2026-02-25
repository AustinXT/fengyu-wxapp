# 云函数环境变量配置指南

## 环境变量配置

### 方式一：通过 CloudBase 控制台（推荐）

1. **打开控制台**：
   https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf

2. **找到云函数**：
   - 在云函数列表中找到 `clientApi`
   - 点击进入详情页

3. **配置环境变量**：
   - 点击「配置」选项卡
   - 找到「环境变量」部分
   - 点击「编辑」

4. **添加以下环境变量**：

```
变量名: PG_CONNECTION_STRING
变量值: postgresql://fengyu:fengyu123@47.113.202.7:5432/fengyu_wxapp
```

```
变量名: MSSQL_CONNECTION_STRING
变量值: Server=111.229.31.128,1433;Database=wkdb_20220804_86cd3292;User Id=Sa;Password=oHx#+Q;TrustServerCertificate=True
```

5. **保存配置**

### 方式二：使用 cloudbaserc.json（需要重新部署）

配置文件已更新：`fengyu-client/cloudbaserc.json`

```json
{
  "envId": "cloud1-3gpht4b01ff88838",
  "version": "2.0",
  "functions": [
    {
      "name": "clientApi",
      "timeout": 30,
      "envVariables": {
        "PG_CONNECTION_STRING": "postgresql://fengyu:fengyu123@47.113.202.7:5432/fengyu_wxapp",
        "MSSQL_CONNECTION_STRING": "Server=111.229.31.128,1433;Database=wkdb_20220804_86cd3292;User Id=Sa;Password=oHx#+Q;TrustServerCertificate=True"
      },
      "runtime": "Nodejs18.15",
      "handler": "index.main"
    }
  ]
}
```

重新部署：
```bash
tcb fn deploy clientApi --envId cloud1-3gpht4b01ff88838 \
  --dir /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/cloudfunctions/clientApi \
  --force
```

---

## 环境变量说明

### PostgreSQL 连接串

**格式**：`postgresql://用户名:密码@主机:端口/数据库名`

**示例**：
```
postgresql://fengyu:fengyu123@47.113.202.7:5432/fengyu_wxapp
```

**参数说明**：
- 主机: `47.113.202.7` (ali-demo 服务器)
- 端口: `5432`
- 数据库: `fengyu_wxapp`
- 用户名: `fengyu`
- 密码: `fengyu123`

### SQL Server 连接串

**格式**：`Server=主机,端口;Database=数据库;User Id=用户名;Password=密码;TrustServerCertificate=True`

**示例**：
```
Server=111.229.31.128,1433;Database=wkdb_20220804_86cd3292;User Id=Sa;Password=oHx#+Q;TrustServerCertificate=True
```

**参数说明**：
- 主机: `111.229.31.128` (WorkFine 服务器)
- 端口: `1433`
- 数据库: `wkdb_20220804_86cd3292`
- 用户名: `Sa`
- 密码: `oHx#+Q`
- TrustServerCertificate: `True` (信任自签名证书)

---

## 向后兼容性

代码已更新支持两种格式：

### PostgreSQL
- ✅ `PG_CONNECTION_STRING` (推荐)
- ❌ 分离格式（未实现，因为 pg 库原生支持连接串）

### SQL Server
- ✅ `MSSQL_CONNECTION_STRING` (推荐)
- ✅ 分离格式（向后兼容）：
  - `MSSQL_SERVER`
  - `MSSQL_PORT`
  - `MSSQL_USER`
  - `MSSQL_PASSWORD`
  - `MSSQL_DATABASE`

**优先级**：如果同时配置了连接串和分离格式，优先使用连接串。

---

## 验证配置

### 1. 检查环境变量

在云函数日志中打印环境变量（仅用于调试）：

```javascript
console.log('PG_CONNECTION_STRING:', process.env.PG_CONNECTION_STRING ? '已配置' : '未配置')
console.log('MSSQL_CONNECTION_STRING:', process.env.MSSQL_CONNECTION_STRING ? '已配置' : '未配置')
```

### 2. 测试数据库连接

创建测试 action：

```json
{
  "action": "test.connection",
  "payload": {}
}
```

预期返回：
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "pg": { "connected": true },
    "mssql": { "connected": true }
  }
}
```

---

## 安全建议

1. **不要在代码中硬编码密码**
   - ✅ 使用环境变量
   - ❌ 不要写在代码中

2. **定期轮换密码**
   - 建议每 3-6 个月更换一次数据库密码
   - 更换后同步更新环境变量

3. **限制数据库访问**
   - PostgreSQL: 只允许 CloudBase 环境 IP 访问
   - SQL Server: 只读权限，仅允许 SELECT

4. **使用 SSL 连接（生产环境）**
   - PostgreSQL: `?ssl=true`
   - SQL Server: `Encrypt=True`

---

## 故障排查

### 问题 1: 连接超时

**可能原因**：
- 防火墙未开放端口
- 数据库服务未启动
- IP 地址错误

**解决方法**：
```bash
# 检查 PostgreSQL 端口
telnet 47.113.202.7 5432

# 检查 SQL Server 端口
telnet 111.229.31.128 1433
```

### 问题 2: 认证失败

**可能原因**：
- 密码错误
- 用户不存在
- 数据库不存在

**解决方法**：
```bash
# 测试 PostgreSQL 连接
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -U fengyu -d fengyu_wxapp -c "SELECT 1"

# 测试 SQL Server 连接（需要 sqlcmd 工具）
sqlcmd -S 111.229.31.128,1433 -U Sa -P 'oHx#+Q' -d wkdb_20220804_86cd3292 -Q "SELECT 1"
```

### 问题 3: 环境变量未生效

**可能原因**：
- 部署后未重启云函数
- 环境变量名称拼写错误

**解决方法**：
1. 在控制台确认环境变量已保存
2. 重新部署云函数
3. 检查变量名大小写

---

## 下一步

1. ✅ 配置环境变量
2. ⏳ 初始化 PostgreSQL 数据库表结构
3. ⏳ 执行接口联调测试
4. ⏳ 部署到生产环境

---

## 相关文档

- [数据库初始化指南](DATABASE_INIT.md)
- [云函数部署指南](cloudfunctions/clientApi/DEPLOYMENT.md)
- [系统架构设计](.42cog/spec/system_architecture.md)
