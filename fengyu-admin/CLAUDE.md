# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

管理后台（Admin Panel），当前处于规划阶段，目录为空。

## 需求规范

详见 `.42cog/pm/admin.pr.spec.md`，包含：
- 组织架构管理（门店/部门/员工）
- 商品与定价管理
- 订单与财务报表
- 权限与角色管理
- 数据同步监控

## 技术选型（待定）

尚未确定具体技术栈。需与现有 PostgreSQL 数据库对接，复用 `db/schema/` 中的表结构定义。
