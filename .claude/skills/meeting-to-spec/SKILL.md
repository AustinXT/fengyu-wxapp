---
name: meeting-to-spec
description: |
  从会议纪要中提取核心决策，澄清理解后更新 spec 文档。
  当用户说"整理会议需求"、"更新 spec"、"会议决议落地"、
  "帮我看看上次开会说了什么"、"把会议内容整理一下"、
  "notes/meetings 目录下的内容"时激活。
metadata:
  title: 会议纪要转需求规范
  description_zh: 会议决策提取、需求澄清、spec 文档更新
  author: nvoyager
  version: 1.0.0
---

# 会议纪要→需求规范

从会议记录中提取决策，澄清理解后更新 spec 文档。

## 何时使用

- 会议后需要将决策同步到 spec 文档
- 需要澄清会议内容的理解偏差
- 用户说"整理会议需求"、"更新 spec"、"会议决议落地"

## 不适用

- 代码实现 → `/wx-implement-feature` 或 `/wx-implement-api`
- 逐字稿转清理版 article → `/transcript-to-article`
- 纯文档格式调整

---

## 1 会议记录格式

会议记录存放于 `notes/meetings/meeting-YYYYMMDD/`，标准结构：

```
meeting-YYYYMMDD/
├── *-逐字稿文本-*.txt       # 原始语音识别逐字稿
├── article.md               # 清理版议事录（按议题分段）
└── summary.md               # 摘要版（核心决策 + 待办）
```

### article.md 格式

```markdown
# 会议标题

**日期：** YYYY-MM-DD
**参与方：** 夜航星（技术方）、张凯（业务方）

---

## 一、议题标题

### 当前问题
[问题描述]

### 讨论过程
[讨论记录]

### 结论与待办
| 事项 | 负责方 | 说明 |
|------|--------|------|
| ... | ... | ... |

---

## 二、下一议题
...
```

### summary.md 格式

```markdown
# 会议摘要 — 主题（YYYY-MM-DD）

## 核心决策
[决策 1 描述]
[决策 2 描述]

## 待XX整理后再开发的需求
1. [需求描述]
2. ...

## 旁线事项
[非技术事项]
```

---

## 2 Spec 文档格式

规范文档位于 `.42cog/pm/`，按端拆分：

| 文件 | 覆盖端 | 核心章节 |
|------|--------|---------|
| `backend.pr.spec.md` | 后端服务 | 技术架构 → 数据模型 → API 接口(P0/P1/P2) → 权限认证 → 业务流程 |
| `client.pr.spec.md` | 顾客端小程序 | 页面规格 → 功能需求 → 交互流程 |
| `staff.pr.spec.md` | 员工端小程序 | Tab 结构 → 功能需求 → 角色权限 |
| `admin.pr.spec.md` | 管理后台 | 页面规格 → 功能需求(AC-XX) → 权限矩阵 |
| `workfine-sync.spec.md` | 数据同步 | 同步策略 → 实体映射 → 运行计划 |

### Spec Frontmatter 约定

```markdown
# 凤御双美容院 — [端口名] 产品需求规格书

> **文档版本**: X.Y.Z
> **范围**: [端口描述]
> **约束文档**: `.42cog/real.md` | `.42cog/cog.md`
> **日期**: YYYY-MM-DD
```

### 数据模型章节格式

```markdown
### 2.X table_name（中文说明）

| 字段 | 类型 | 说明 |
|------|------|------|
| `field` | type | 描述 |

> **约束**:
> - UNIQUE(...)
> - INDEX(...)
> - FK → table.field
```

### 关联文档

- `cog.md` — 全局认知模型（核心实体定义、业务流程）
- `real.md` — 硬性约束（不可违反的规则）
- `*.ui.spec.md` — UI 设计规范（在 `.42cog/design/`）
- `*.sys.spec.md` — 系统架构规范（在 `.42cog/dev/`）

---

## 3 强制工作流

### Phase 1 — 读取会议记录

1. 优先读 `summary.md`（快速掌握决策全貌）
2. 再读 `article.md` 中与决策相关的章节补充细节
3. 提取以下内容：
   - **核心决策列表**（已确定、可立即开发的）
   - **待确认需求**（标记为"待 XX 整理"的）
   - **涉及的业务概念**
   - **参会人分工**

### Phase 2 — 澄清门控

**此阶段不可跳过。** 对每个提取的决策，向用户确认：

```markdown
我从会议记录中提取了以下决策，请逐条确认：

1. **[决策标题]**
   我的理解：[用自己的话复述决策内容]
   影响端：[client/staff/admin/backend]
   是否正确？需要补充什么？

2. **[决策标题]**
   我的理解：...
   这条标记为"待张凯整理"，是否已有结论可以更新到 spec？
```

**重点澄清**：
- 业务术语定义（如"组合套餐"的具体含义）
- 范围边界（本次迭代 vs 后续迭代）
- 优先级判定（P0/P1/P2）
- 跨端影响（一个决策可能需要更新多个 spec）
- "待确认"项的当前状态（是否已有结论）

**必须等用户逐条确认/修正后再继续。**

### Phase 3 — 生成变更描述

对每个已确认的决策，输出结构化描述：

```markdown
## 迭代需求: [决策标题]

**当前状态**: [现在系统怎么做的]
**目标状态**: [变更后应该怎么做]
**影响端**: client / staff / admin / backend
**优先级**: P0 / P1 / P2
**涉及结构性变更**: 是/否（如果是，后续需交接给 /wx-change-propagation）
```

### Phase 4 — 更新 Spec 文档

1. 根据概念→Spec 章节映射表（见 §4），定位待更新的 spec 文件和章节
2. 更新内容，**严格保持现有格式约定**（表格、约束注释、缩进）
3. 更新 Frontmatter 中的文档版本号（patch +1，如 4.0.0 → 4.0.1）
4. 在 `article.md` 对应议题旁标记 ✅（表示已落地到 spec）

---

## 4 概念→Spec 章节映射表

| 业务概念 | 主 Spec | 章节位置 | 可能关联的 Spec |
|---------|---------|---------|----------------|
| 订单/支付/退款 | `backend.pr.spec.md` | §2 数据模型 + §3 API 接口 | `client.pr.spec.md`, `staff.pr.spec.md` |
| 商品/品项分类 | `backend.pr.spec.md` | §2 数据模型 (products) | `admin.pr.spec.md` §2 商品管理 |
| 商城/营销展示 | `client.pr.spec.md` | 首页/商城相关章节 | `admin.pr.spec.md` 商城管理 |
| 权限/角色 | `backend.pr.spec.md` | §4 权限认证 | `admin.pr.spec.md` §3 权限 |
| 员工绩效/提成 | `staff.pr.spec.md` | 工作台/绩效章节 | `backend.pr.spec.md` §3 API |
| 顾客档案/分类 | `backend.pr.spec.md` | §2 数据模型 (client_wechat_users) | `client.pr.spec.md`, `admin.pr.spec.md` |
| 服务单/护理 | `backend.pr.spec.md` | §2 + §3 | `staff.pr.spec.md` 护理 Tab |
| 预约 | `backend.pr.spec.md` | §2 + §3 | `client.pr.spec.md`, `staff.pr.spec.md` |
| 组织架构/门店 | `backend.pr.spec.md` | §2 (org_nodes, stores) | `admin.pr.spec.md` 组织管理 |
| 数据同步 | `workfine-sync.spec.md` | 全文 | — |
| UI/交互 | `client/staff.pr.spec.md` | 各功能章节 | 对应 `*.ui.spec.md` |

---

## 5 边界

**Will**：
- 读取会议记录，提取核心决策
- 与用户对话澄清理解偏差
- 生成结构化的迭代需求描述
- 更新 `.42cog/pm/*.pr.spec.md`
- 在 article.md 标记已落地议题 ✅

**Won't**：
- 直接修改代码（spec 更新后由用户决定何时实现，再交给对应 skill）
- 修改 `cog.md` 或 `real.md`（全局约束文档需单独审慎处理）
- 跳过 Phase 2 澄清阶段直接更新 spec
- 处理"待 XX 整理"的未确认需求（除非用户明确表示已有结论）

---

## 示例

```bash
/meeting-to-spec notes/meetings/meeting-20260407
/meeting-to-spec notes/meetings/meeting-20260324
```

以 `meeting-20260407` 为例，skill 会读取 summary.md 提取"商品管理/商城管理职责分离"等决策，逐条与用户澄清理解，确认后定位到 `backend.pr.spec.md` §2 数据模型和 `staff.pr.spec.md` 开单章节进行更新。
