# Skills 索引

本目录下共 16 个项目级 skill，按"与项目代码的距离"分三类归档，便于快速判断某个需求该走哪条路径。

> 默认路径：**描述意图让 skill 自动激活，不要手动挑 skill**。只在部署、循环、提交等场景才显式 `/xxx`。

---

## A. 开发无关（3 个）

不动项目代码，服务于文档、写作、规划、团队设计。

| Skill | 一句话作用 | 典型触发 |
|---|---|---|
| `transcript-to-article` | 语音转写稿 → 纠错 + 重组为可读文章 | "整理一下这段录音转写" |
| `meeting-to-spec` | 会议纪要提取核心决策 → 更新 spec 文档 | "整理会议需求" / "更新 spec" |
| `agent-team-architect` | 设计 Claude agent 团队分工与并行策略 | "怎么拆 agent 团队" |

---

## B. 直接用于开发（7 个）

落地到具体代码、schema、页面的实现与修改。

| Skill | 一句话作用 | 典型触发 |
|---|---|---|
| `wx-coding` | 小程序 Page/Component + CloudBase 云函数 Action 路由 | 在 `fengyu-client` / `fengyu-staff` 工作 |
| `admin-coding` | Next.js 15 后台：Server Actions、Drizzle、权限、E2E | 在 `fengyu-admin` 工作 |
| `vant-weapp` | Vant Weapp 组件复合模式与陷阱速查 | 写 `.wxml` 用 Vant 组件 |
| `wx-change-propagation` | 枚举/字段/表结构变更的 10 层依赖传播（先扫后改） | 改 `db/schema/enums.ts`、删字段、重命名 |
| `wx-requirement-adapt` | 需求变更 → 追踪代码路径 → 差异审计报告 | "规则改了" / "流程调整" |
| `wx-debug-production` | 线上错误排障闭环：查日志→定位→修复→部署→验证 | "线上报错了" / "接口调用失败" |
| `syncing-workfine` | WorkFine（SQL Server）→ PG 单向全量/增量同步 | "同步 WorkFine 数据" |

---

## C. 开发相关（6 个）

围绕编码前后的工程环节 —— 部署、质量、安全、发版、循环编排。

| Skill | 一句话作用 | 典型触发 |
|---|---|---|
| `cloudbase-deploy` | CloudBase 云函数部署（MCP 优先，tcb CLI 降级） | "部署云函数" |
| `remote-deploy` | admin 本地 docker build → 传镜像 → 远程 compose up | "部署 admin" |
| `wx-quality-assurance` | 测试策略 + E2E + 单元/集成 + WXML 编译 + 性能安全 | "跑测试" / "质量检查" |
| `security-review` | 云函数 SQL 注入/OPENID/权限/敏感数据审查 | "安全审计" |
| `wx-release-check` | 发版检查：盘点变更 → 部署 → 冒烟 → 对齐需求 → 提交 → tag | "发版检查" / "上线前检查" |
| `dev-loop` | 自驱循环 prompt 模板（QA / feature / refactor / fix 四套） | `/loop 30m /dev-loop qa <scope>` |

---

## 决策指引

```
需求属于哪一类？
 ├─ 写文档 / PRD / 会议纪要 / Agent 设计   →  A 类
 ├─ 改代码 / 改页面 / 改 schema             →  B 类
 │     └─ 涉及结构性变更（枚举/字段/表）     →  先走 wx-change-propagation
 │     └─ 业务规则/流程变更                  →  先走 wx-requirement-adapt
 │     └─ 线上错误                           →  走 wx-debug-production
 └─ 部署 / 测试 / 安全 / 发版                →  C 类
       └─ 长时自驱工作流                     →  /loop + dev-loop
```

## 陷阱守卫（必记）

| 场景 | 必须激活的 skill | 防御目标 |
|---|---|---|
| 改枚举 / 删字段 / 改 `db/schema/` | `wx-change-propagation` | 10 层依赖未传播导致线上炸 |
| 线上报错 / 查云函数日志 | `wx-debug-production` | 乱猜根因、乱改代码 |
| 部署云函数 | `cloudbase-deploy` | 误用 `tcb fn deploy --force` 重置环境变量 |
| 写 `.wxml` + Vant 组件 | `vant-weapp` | 事件类型漏标、组件属性错配 |
