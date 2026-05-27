---
type: ops
number: "001"
date: 2026-05-27
title: admin 容器锁定东八区（tzdata + TZ=Asia/Shanghai），修复后台时间列晚 8 小时
tags: [timezone, docker, admin, postgres-js]
related: []
---

# ops/001 admin 容器锁定东八区，修复后台时间列晚 8 小时

## 执行概述
- 时间：2026-05-27
- 环境：prod（远程 admin 容器，47.113.202.7:3000）
- 影响：管理后台所有读 `timestamp` 列并格式化的页面（积分流水 / 订单 / 提成 / 退款 / 日志 / 储值卡流水 / 组织等）

## 现象
后台「积分流水」等页面时间比真实时间晚 8 小时，呈现未来时间。
例：库里真实值 `2026-05-27 11:24:01`，页面显示 `2026-05-27 19:24:01`。

## 根因
数据本身正确，错在 **admin 容器进程时区 = UTC**：

1. 线上库 5433/`fengyu_wxapp` 会话时区 = `Asia/Shanghai`，`created_at` 是
   `timestamp without time zone`，存的是**北京墙钟时间**（实测 `11:24:01.861946`）。
2. admin 跑在 `node:18-alpine`，**未设 `TZ`、未装 `tzdata` → 进程 UTC**。
   `docker-compose.yml` 给了 `cron-worker` `TZ=Asia/Shanghai`，唯独 `admin` 服务漏了；
   且 alpine 不含 tzdata，单设 TZ 也会被 musl 退回 UTC。
3. `postgres.js`（`src/db/index.ts:11`）把无时区的 `11:24:01` 按进程 UTC 解析成
   JS Date `11:24:01Z`（比真实 instant `03:24:01Z` 快 8h）。
4. server action `r.createdAt.toISOString()` → `…11:24:01Z` 传前端。
5. 前端 `lib/utils.ts` `formatDateTime`（`getHours()`，浏览器东八区）→ 渲染 `19:24:01`。

三端云函数（clientApi/staffApi/payNotify）入口都设了 `process.env.TZ='Asia/Shanghai'`，
小程序又在用户手机（东八区）格式化，所以只有 admin 出错。

## 修复步骤

### 1. `docker/Dockerfile.admin`（runner stage）
```dockerfile
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai
```
同一镜像被 admin 与 cron-worker 共用，cron-worker 现有 TZ 也借此真正生效。

### 2. `docker/docker-compose.yml`（admin 服务 environment）
```yaml
      - TZ=Asia/Shanghai
```
与 cron-worker 对齐，显式声明双保险。

### 3. 重建并部署
```bash
.claude/skills/remote-deploy/deploy-admin.sh
```

## 验证
- `docker exec fengyu-admin date` → `CST` / `+0800`
- `docker exec fengyu-admin node -e "console.log(new Date('2026-05-27 11:24:01').toISOString())"`
  → `2026-05-27T03:24:01.000Z`（修复前为 `…T11:24:01Z`）
- 刷新「积分流水」页：`FY-XSD-WX-2605270017` 时间从 `19:24:01` 恢复为 `11:24:01`

## 坑记录
### 问题
`node:18-alpine` 默认不含 tzdata，仅 `ENV TZ=Asia/Shanghai` 而不 `apk add tzdata`，
musl libc 找不到 `/usr/share/zoneinfo/Asia/Shanghai` 会静默退回 UTC，等于没改。
### 解决方案
runner stage 必须 `apk add --no-cache tzdata` 后再设 TZ。

## 后续 TODO
- [ ] （可选加固）前端 `lib/utils.ts` formatDate/formatDateTime 与 ~13 个页面的
      `toLocaleString` 改用显式 `timeZone: 'Asia/Shanghai'`（Intl），使后台在非东八区
      浏览器下也正确。本轮未做（员工浏览器均东八区，根因修复后已全部正确）。
