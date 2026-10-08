# LX CODING 美业演示环境

基于 main `5607efcb`，开发分支 `codex/lxcoding-demo`。Logo 原件来自 bizforge-designer 的 `vault/truth/DesignerUI/assets/logo-black.png` 与 `logo-white.png`。

## 部署拓扑

- 主机：`lx-test` / `101.34.242.103`。
- 后台：`http://101.34.242.103:8094/login`。
- PostgreSQL：服务器 `127.0.0.1:8096`，库 `lxcoding_demo`；公网不开放数据库。
- `8095` 已用于 `lingxie-beauty-introduction`，保留原服务。
- 独立 compose 项目、Docker 网络、PostgreSQL 数据目录、文件目录与 JWT/RSA 密钥。
- 登录 Cookie：`lxcoding-demo-token`，避免同 IP 不同端口与开发后台互相覆盖。
- 演示账号同时绑定总部 `admin` 与 `customer_mgr`，保留 main 的纯系统管理员不查看顾客详情规则，支持实际顾客管理演示。
- 后台数据库启动守卫只接受 `demo-postgres:5432/lxcoding_demo`。真实微信、CloudBase、支付、OCR 凭据与连接覆盖均被拒绝。
- 上传与导出文件写入本地演示卷；导出下载检查提交人后签发 5 分钟链接。
- 支付演示使用线下流程；商户入网、OCR 使用 mock。后台业务 Server Actions 连接独立 PG，不部署或调用现有业务云函数。

## 重新部署

在此分支的干净工作区运行：

```bash
bash scripts/demo/deploy.sh
```

本机需 Node.js 22、Docker Desktop、`fengyu-admin/node_modules` 与 SSH `lx-test`。始终本地构建 linux/amd64 镜像，服务器仅加载镜像，不构建源码。

`envs/demo.env` 是演示密钥与登录账号的本地权威源；首次自动生成，权限 0600，不提交 Git。保持这份文件可避免更新时更换数据库密码和登录密钥。远端目录 `/www/wwwroot/lxcoding-demo`，服务配置同样为 0600。

数据库通过专用 SSH 隧道初始化；bootstrap 严格接受 `127.0.0.1:58096/lxcoding_demo`，逐条执行现有 migration 并写入对应 hash 与 journal 时间，不改变现有业务库或迁移文件。模拟数据仅在空库首次创建；之后重复部署保留演示中的操作记录，不自动清库。

首次数据：4 家门店、21 名员工、60 位顾客、8 个商品、192 笔订单、106 张服务单、12 条预约、12 张储值卡、24 张顾客优惠券。全部独立生成，没有复制开发库或生产库数据。

## 验证

- 类型检查；演示目标隔离、文件签名/目录逃逸、登录、上传与 CloudBase 等相关测试。
- PostgreSQL 63 条迁移与源文件 hash 一致。
- Chrome 真实登录，检查 12 个业务页面、图片上传与匿名访问拒绝、60 行顾客 XLSX 导出。
- 后台 healthcheck 同时探测数据库与 HTTP；检查现有凤御后台和 8095 介绍站的容器保持原样。
