# clientApi 云函数部署指南

## 前置条件

1. 已创建 CloudBase 环境(客户端专用环境)
2. 已创建 PG 自托管数据库并导入 schema
3. 已配置 WorkFine SQL Server 访问权限

## 部署步骤

### 方式一: 使用 CloudBase MCP 工具(推荐)

#### 1. 查询 CloudBase 环境 ID

```bash
# 使用 envQuery MCP 工具查询客户端环境 ID
# 环境名称: fengyu-client
```

#### 2. 准备环境变量

创建环境变量配置:

```javascript
const envVariables = {
  PG_CONNECTION_STRING: 'postgresql://用户名:密码@主机:5432/fengyu_wxapp',
  MSSQL_SERVER: '47.96.87.33',
  MSSQL_PORT: '1433',
  MSSQL_USER: 'SD',
  MSSQL_PASSWORD: 'Se4Qimoh',
  MSSQL_DATABASE: 'wkdb_20220804_86cd3292'
}
```

#### 3. 部署云函数

使用 `createFunction` MCP 工具:

```javascript
{
  envId: '客户端环境ID',
  func: {
    name: 'clientApi',
    runtime: 'Nodejs18.15',
    handler: 'index.main',
    timeout: 30,
    envVariables: envVariables,
    vpc: {
      vpcId: 'vpc-xxx', // 如果 PG 在 VPC 内,需要配置
      subnetId: 'subnet-xxx'
    }
  },
  functionRootPath: 'fengyu-client/cloudfunctions',
  force: true
}
```

#### 4. 验证部署

```bash
# 使用 invokeFunction MCP 工具测试
{
  envId: '客户端环境ID',
  functionName: 'clientApi',
  data: {
    action: 'store.list',
    payload: {}
  }
}
```

### 方式二: 使用微信开发者工具

#### 1. 上传云函数

1. 打开微信开发者工具
2. 进入 `fengyu-client` 项目
3. 右键点击 `cloudfunctions/clientApi` 目录
4. 选择「上传并部署: 云端安装依赖」

#### 2. 配置环境变量

1. 打开 CloudBase 控制台
2. 进入云函数 → clientApi → 配置
3. 添加环境变量:

```
PG_CONNECTION_STRING=postgresql://...
MSSQL_SERVER=47.96.87.33
MSSQL_PORT=1433
MSSQL_USER=SD
MSSQL_PASSWORD=Se4Qimoh
MSSQL_DATABASE=wkdb_20220804_86cd3292
```

#### 3. 配置超时时间

建议设置为 30 秒(默认可能较短)

#### 4. 配置 VPC(如需要)

如果 PG 数据库在 VPC 内,需要配置:
- VPC ID
- 子网 ID

## 常见问题

### 1. 数据库连接失败

**原因**: PG 连接串错误或网络不通

**解决**:
- 检查 PG_CONNECTION_STRING 格式
- 检查 PG 是否允许 CloudBase IP 访问
- 如果 PG 在 VPC 内,配置云函数 VPC

### 2. WorkFine 查询超时

**原因**: WorkFine 服务器响应慢

**解决**:
- 增加云函数超时时间到 30-60 秒
- 检查 WorkFine 服务器负载

### 3. 依赖安装失败

**原因**: node_modules 过大或网络问题

**解决**:
- 使用云端安装依赖
- 检查 package.json 依赖版本
- 清除 node_modules 后重新上传

### 4. 环境变量未生效

**原因**: 部署后未更新环境变量

**解决**:
- 使用 MCP 工具或控制台手动更新
- 重新部署云函数

## 性能优化

### 1. 连接池配置

`db/pg.js` 已配置连接池(最大 5 连接),冷启动优化。

### 2. WorkFine 查询优化

- 只查询必要字段
- 添加索引(WorkFine 侧)
- 避免大表扫描

### 3. PG 查询优化

- 使用索引
- 避免 SELECT *
- 使用分页查询

## 监控与日志

### 查看日志

1. CloudBase 控制台 → 云函数 → clientApi → 日志
2. 筛选错误日志(code != 0)
3. 查看执行时间、内存使用

### 告警配置

建议配置以下告警:
- 错误率 > 5%
- 平均执行时间 > 5 秒
- 内存使用 > 80%

## 下一步

1. 部署 `payNotify` 云函数(微信支付回调)
2. 配置微信支付商户信息
3. 实现员工端 `staffApi` 云函数
4. 配置实时推送(WebSocket 或轮询)

## 相关文档

- [系统架构设计](../../.42cog/spec/system_architecture.md)
- [wx-coding 技能文档](../../.claude/skills/wx-coding/SKILL.md)
