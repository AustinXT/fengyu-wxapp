---
type: arch
number: "014"
date: 2026-10-01
title: 数据库变更独立开发、集中集成与分环境执行台账
tags: [database, migration, workflow]
related: []
---

# arch/014 数据库变更独立开发、集中集成与分环境执行台账

## 决策

用户确认取消 issue 开发期间长驻迁移令牌。业务分支独立开发、验证、评审，登记每条迁移请求；正式 Drizzle 迁移由集成会话基于最新 dev 串行生成和私有库验证。短锁仅保护生成/验证/本地提交，候选交接记录跨越评审和等待合并阶段，不占锁。

dev/prod 使用相同不可变迁移历史，分别记录部署前的迁移、一次性脚本、依赖/顺序及执行证据。目标库 journal 的 when/hash 是实际执行事实，台账不替代数据库记录。

## 保留的约束

前一正式迁移未合并时，下一项不能从旧 journal 生成；但该依赖只约束迁移集成，不约束 issue 发车、编码或评审。不手改号/when，不另建环境专用 journal，不降低完整验证和双谱系评审要求。未完成正式迁移的交付只能 draft。

本次只是修改协作规则与登记计划，没有授权或执行 merge、业务库迁移、回填或部署。现有 #353 候选先交接，不删除其他活跃会话的旧锁。#364 改为待迁移集成，保留代码检查点。

## 入口

- `db/rollout/README.md`：集中集成流程与过渡规则。
- `db/rollout/requests/`：各 issue 迁移请求。
- `db/rollout/dev.md` / `prod.md`：分环境部署计划和执行记录。
- issue-dev、issue-sweep、release-all：分别接入开发、排队与发布流程。
