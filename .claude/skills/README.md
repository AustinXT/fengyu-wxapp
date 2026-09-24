# Skills 索引

本目录下共 19 个项目级 skill，按"与项目代码的距离"分四类归档，便于快速判断某个需求该走哪条路径。

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

## D. issue 工作流（3 个）

维护期主线：甲方需求 → issues → 开发 → PR。需求歧义必停等拍板；质量闸门（三层验证 + pr-ready 对抗审查 + 双谱系评审）是放手让 AI 执行的前提，不因维护期降级。

| Skill | 一句话作用 | 典型触发 |
|---|---|---|
| `req-to-issues` | 需求（会议纪要/口头/聊天）→ 去重 → 确认后批量建 gh issues | "把需求建成 issues" |
| `issue-dev` | 单条 issue：**开隔离 worktree** → 分流 → 实现 → 三层验证 → pr-ready + 双谱系评审 → PR base dev → 回收 | "处理 issue #N" / "发车" |
| `issue-sweep` | 遍历 open issues 逐条走 issue-dev 全闸门，ledger 断点续跑，攒 PR 出汇总表 | "把 open issues 清一遍" |

> 三步串联：会议后先 `req-to-issues` 落任务（spec 更新另走 `meeting-to-spec`）；单条在场处理用 `issue-dev`；批量清积压用 `issue-sweep`（可配 `/loop` 长跑）。merge 与关单始终由人执行。
> 状态管理：过程产物与 checkpoint 落 `_tmp/issue-<N>/`（state/triage/spec/verify/review），sweep 进度在 `_tmp/issue-sweep/run-*.md`，中断可重入。
> 配套配置：pr-ready 项目模版在 `~/.claude/skills/pr-ready/templates/fengyu-wxapp.md`；双谱系 harness 链在 `.claude/dev-launch.review.md`（本机专属，已 gitignore）。

---

## 决策指引

```
需求属于哪一类？
 ├─ 写文档 / PRD / 会议纪要 / Agent 设计   →  A 类
 ├─ 改代码 / 改页面 / 改 schema             →  B 类
 │     └─ 涉及结构性变更（枚举/字段/表）     →  先走 wx-change-propagation
 │     └─ 业务规则/流程变更                  →  先走 wx-requirement-adapt
 │     └─ 线上错误                           →  走 wx-debug-production
 ├─ 部署 / 测试 / 安全 / 发版                →  C 类
 │     └─ 长时自驱工作流                     →  /loop + dev-loop
 └─ 甲方需求 / issue 驱动开发                →  D 类
       ├─ 需求落任务                         →  req-to-issues
       ├─ 单条 issue 开发                    →  issue-dev
       └─ 批量清积压                         →  issue-sweep（可配 /loop）
```

## 陷阱守卫（必记）

| 场景 | 必须激活的 skill | 防御目标 |
|---|---|---|
| 改枚举 / 删字段 / 改 `db/schema/` | `wx-change-propagation` | 10 层依赖未传播导致线上炸 |
| 线上报错 / 查云函数日志 | `wx-debug-production` | 乱猜根因、乱改代码 |
| 部署云函数 | `cloudbase-deploy` | 误用 `tcb fn deploy --force` 重置环境变量 |
| 写 `.wxml` + Vant 组件 | `vant-weapp` | 事件类型漏标、组件属性错配 |
