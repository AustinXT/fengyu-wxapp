# 凤御美业 — 系统架构提要

> 仅提供三端全局拓扑与文档索引。各端详细架构见对应 spec 文件。

## 架构拓扑

```text
┌─ 微信小程序 ──────────────────────────────┐
│  fengyu-client（C端）  fengyu-staff（B端）  │
└──────┬─────────────────────────┬─────────┘
       │ wx.cloud.callFunction  │
┌──────▼────────┐  ┌────────────▼──┐  ┌─ Web ─────────────┐
│ clientApi     │  │ staffApi      │  │ fengyu-admin       │
│ payNotify     │  │               │  │ adminApi（独立部署）│
│ CloudBase A   │  │ CloudBase B   │  │                    │
└──────┬────────┘  └───────┬──────┘  └─────────┬──────────┘
       │                   │                    │
       └───────────────────┼────────────────────┘
                           ▼
              PostgreSQL（自托管，三端共享）
```

## 三端速查

| 端 | 定位 | 认证 | 云函数 | envId |
|----|------|------|--------|-------|
| 顾客端 | C端消费者 | 微信 OPENID（静默） | clientApi + payNotify | `cloud1-3gpht4b01ff88838` |
| 员工端 | B端门店管理 | 微信 OPENID + RBAC | staffApi | `cloud1-9g3ydpg512eecc99` |
| 管理后台 | Web 内部管理 | 手机号+密码 → JWT | adminApi | 独立部署 |

## 隔离与共享

| 独立（各端隔离） | 共享 |
|------------------|------|
| CloudBase 环境、云函数 | PostgreSQL 实例（唯一共享资源） |
| OPENID（两小程序 appid 不同） | 业务数据（orders/products/…） |
| 用户表（client_ / staff_wechat_users） | Drizzle schema 定义（db/） |

## 详细文档索引

| 文档 | 范围 |
|------|------|
| [`client.sys.spec.md`](client.sys.spec.md) | 顾客端架构：认证流、购物车状态、中间件链、业务流 |
| [`staff.sys.spec.md`](staff.sys.spec.md) | 员工端架构：RBAC 权限模型、域过滤、开单/分配/核销业务流 |
| [`admin.sys.spec.md`](admin.sys.spec.md) | 管理后台架构：JWT 认证、RBAC、Next.js + tRPC 技术栈 |
| [`../pm/backend.pr.spec.md`](../pm/backend.pr.spec.md) | 后端数据模型、权限矩阵、状态机、核心业务规则 |
| [`../pm/admin.pr.spec.md`](../pm/admin.pr.spec.md) | 管理后台需求：数据填报/业务操作/系统管理 |
