---
name: req-to-issues
description: |
  把甲方需求（会议纪要、口头描述、聊天记录）提炼成结构化 gh issues。
  提取需求条目 → 与现有 issues 去重 → 按 [需求][模块] 惯例起草清单 →
  用户确认后批量创建。歧义条目标 [待确认] 并列出待答问题。
  当用户说"把需求建成 issues"、"这次会议的需求落成 issue"、"创建需求 issue"、
  "需求登记"、"req-to-issues"时激活。
argument-hint: '[会议目录 or 需求文本]，如: notes/meetings/meeting-20260905'
user-invocable: true
metadata:
  title: 需求 → gh issues
  description_zh: 甲方需求提炼为结构化 issues，去重 + 确认后批量创建
  author: nvoyager
  version: 1.0.0
  license: MIT
---

# 需求 → gh issues

维护期工作流第一步：把散落的甲方需求固化为可执行的 gh issues。后续开发走 `issue-dev`（单条）或 `issue-sweep`（批量）。

**原则**：需求理解准确 > 覆盖全面。每条 issue 必须有可验证的验收标准；理解存疑的条目宁可标 `[待确认]` 停下，也不猜着写。

## 输入来源

| 来源 | 处理 |
|---|---|
| 会议目录（`notes/meetings/meeting-YYYYMMDD/`） | 优先读 `summary.md` 的结论待办表，细节回查 `article.md`；不读逐字稿原文 |
| 口头描述 / 聊天记录粘贴 | 直接提取，逐条复述确认理解 |
| 已有 spec 变更 | spec 更新走 `meeting-to-spec`，本 skill 只负责落任务；两者可先后串用（先更 spec 再建 issue，issue 引用 spec 章节） |

## 流程

### 1. 提取需求条目

从输入中提取独立可交付的条目。拆分标准：**一条 issue = 一次可独立验收的交付**。同一功能的多个子点若必须一起上线，合为一条（正文里列子项）；性质差异大的拆开。

每条初判：
- 类型：需求（新功能/改动）/ Bug / 暂缓（业务未确认）/ 待确认（理解存疑）
- 模块：积分 / 回款 / 会员权益 / 库存 / 预约 / 服务单 / 收入查看 …（对齐已有 issue 的模块词）
- 涉及端：client / staff / admin / db / 云函数（clientApi / staffApi / payNotify）

### 2. 去重

```bash
gh issue list --state all --limit 100 --search "<关键词>"
```

对每条候选搜历史 issues（含 closed）：
- 已有 open issue 覆盖 → 不新建，必要时 `gh issue comment` 补充新信息
- closed issue 相关但需求有变 → 新建并在正文引用旧 issue（`相关 #N`）
- 会上确认"已实现/保持现状"的 → 不建 issue（如需留痕，评论到相关旧 issue）

### 3. 起草清单

标题惯例（对齐仓库现状）：

```
[需求][模块] 一句话描述     ← 新功能/改动
[Bug][模块] 一句话描述      ← 缺陷
[暂缓][模块] 一句话描述     ← 业务方未拍板，先登记不排期
[待确认][模块] 一句话描述   ← 技术方理解存疑，附待答问题
```

正文模板：

```markdown
## 背景

<需求方原话/会议结论引用，一两句>

## 需求描述

<做什么、怎么算做完；有业务口径的写清口径>

## 验收标准

- [ ] <可验证的检查点，逐条>

## 涉及端（初判）

<client / staff / admin / db / 云函数，可多项>

## 来源

<notes/meetings/meeting-YYYYMMDD/summary.md 或"口头需求 YYYY-MM-DD">
```

label：需求 → `enhancement`，Bug → `bug`；`[暂缓]`/`[待确认]` 不打 label（靠标题前缀过滤）。

### 4. 确认后批量创建

先向用户展示完整清单（表格：标题 / 验收标准要点 / 来源 / 存疑点），**等确认或修改后**再创建。

创建时 body 落临时文件防 shell 插值（正文含反引号/代码块）：

```bash
gh issue create --title "[需求][积分] xxx" --label enhancement --body-file /tmp/issue-body.md
```

创建完输出编号清单，提示下一步：单条 `issue-dev #N`，批量 `issue-sweep`。

## 常见错误

| 错误 | 修正 |
|---|---|
| 逐字稿全文贴进 issue | 只写结论 + 引用来源路径，正文一屏内读完 |
| 把讨论过程当结论 | 以 summary.md 结论待办表为准；会上有分歧未拍板的 → `[暂缓]` |
| 没有验收标准 | 每条至少一个可验证检查点，写不出来说明理解不够 → `[待确认]` |
| 跳过去重直接建 | 先搜 `--state all`，仓库里 `[暂缓]`/`[待确认]` 的旧单可能就是同一件事 |
| 未经确认就批量创建 | issue 是对外产物，清单必须先过用户 |
