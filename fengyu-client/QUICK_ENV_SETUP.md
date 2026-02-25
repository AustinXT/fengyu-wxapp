# 快速配置指南 - clientApi 云函数环境变量

## 配置步骤

### 1. 打开 CloudBase 控制台

访问链接：
https://tcb.cloud.tencent.com/dev?envId=cloud1-3gpht4b01ff88838#/scf

### 2. 配置环境变量

1. 在云函数列表中找到 **clientApi**
2. 点击函数名称进入详情页
3. 点击「**配置**」选项卡
4. 找到「**环境变量**」部分
5. 点击「**编辑**」按钮

### 3. 添加以下两个环境变量

#### 环境变量 1: PostgreSQL 连接

```
变量名: PG_CONNECTION_STRING
变量值: postgresql://fengyu:fengyu123@47.113.202.7:5432/fengyu_wxapp
```

#### 环境变量 2: SQL Server 连接

```
变量名: MSSQL_CONNECTION_STRING
变量值: Server=111.229.31.128,1433;Database=wkdb_20220804_86cd3292;User Id=Sa;Password=oHx#+Q;TrustServerCertificate=True
```

### 4. 保存配置

点击「**保存**」按钮

### 5. 验证配置

配置保存后，环境变量立即生效（无需重新部署）

---

## 配置后验证

### 方法 1: 在云函数测试面板测试

1. 在云函数详情页点击「**测试**」选项卡
2. 输入测试参数：

```json
{
  "action": "store.list",
  "payload": {}
}
```

3. 点击「**运行测试**」
4. 查看返回结果，应该包含门店列表数据

### 方法 2: 在小程序中调用

```javascript
wx.cloud.callFunction({
  name: 'clientApi',
  data: {
    action: 'store.list',
    payload: {}
  },
  success: res => {
    console.log('门店列表:', res.result)
  },
  fail: err => {
    console.error('调用失败:', err)
  }
})
```

---

## 环境变量说明

### PostgreSQL 连接串

- **主机**: 47.113.202.7 (ali-demo 服务器)
- **端口**: 5432
- **数据库**: fengyu_wxapp
- **用户**: fengyu
- **密码**: fengyu123

**注意**: 确保 ali-demo 服务器的防火墙已开放 5432 端口，并允许 CloudBase 环境访问。

### SQL Server 连接串

- **主机**: 111.229.31.128 (WorkFine 服务器)
- **端口**: 1433
- **数据库**: wkdb_20220804_86cd3292
- **用户**: Sa
- **密码**: oHx#+Q
- **选项**: TrustServerCertificate=True (信任自签名证书)

---

## 故障排查

### 问题 1: 连接超时

**检查方法**:
```bash
# 测试 PostgreSQL 连接
telnet 47.113.202.7 5432

# 测试 SQL Server 连接
telnet 111.229.31.128 1433
```

**解决方法**:
- 确认防火墙规则
- 确认数据库服务已启动
- 确认 IP 地址正确

### 问题 2: 认证失败

**PostgreSQL 解决方法**:
```bash
# 在 ali-demo 服务器上
sudo -u postgres psql
postgres=# ALTER USER fengyu WITH PASSWORD 'fengyu123';
```

**SQL Server 解决方法**:
- 确认用户名和密码正确
- 确认 SQL Server 启用了混合模式认证

### 问题 3: 环境变量未生效

**解决方法**:
1. 在控制台确认环境变量已保存
2. 检查变量名拼写（区分大小写）
3. 等待 1-2 分钟让配置生效

---

## 下一步

1. ✅ 配置环境变量（当前步骤）
2. ⏳ 初始化 PostgreSQL 数据库表结构
3. ⏳ 执行接口联调测试
4. ⏳ 部署员工端云函数 staffApi

---

## 相关文档

- [完整环境变量配置指南](./ENV_VARIABLES_GUIDE.md)
- [数据库初始化指南](../DATABASE_INIT.md)
- [云函数部署文档](./cloudfunctions/clientApi/DEPLOYMENT.md)
