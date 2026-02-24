# CloudBase 控制台 URL 入口

所有控制台 URL 遵循格式：`https://tcb.cloud.tencent.com/dev?envId=${envId}#/{path}`

| 功能 | 路径 |
|---|---|
| 概览 | `#/overview` |
| 模板中心 | `#/cloud-template/market` |
| NoSQL 数据库 | `#/db/doc` |
| NoSQL 集合 | `#/db/doc/collection/${collectionName}` |
| 数据模型 | `#/db/doc/model/${modelName}` |
| MySQL 数据库 | `#/db/mysql/table/default/` |
| 云函数列表 | `#/scf` |
| 云函数详情 | `#/scf/detail?id=${functionName}&NameSpace=${envId}` |
| 云托管 | `#/platform-run` |
| 云存储 | `#/storage` |
| AI+ | `#/ai` |
| 静态托管 | `#/hosting` |
| 身份认证 | `#/identity` |
| 登录管理 | `#/identity/login-manage` |
| 令牌管理 | `#/identity/token-management` |
| 微搭低代码 | `#/lowcode/apps` |
| 日志监控 | `#/logs` |
| 环境配置 | `#/settings` |
