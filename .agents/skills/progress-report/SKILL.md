---
name: progress-report
description: |
  Generates a client-facing progress PDF from git commits since the last report.
  Collects commits per sub-project, translates to business language, outputs PDF
  via pandoc + XeLaTeX. Use when user says "生成汇报", "进度报告", "甲方汇报",
  "出个 PDF", "progress report", or "/progress-report".
argument-hint: "[--since \"日期\" | --days N]"
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
metadata:
  author: NightVoyager
  version: 1.0.0
  title: 甲方进度汇报 PDF
  description_zh: |
    从 git 提交历史生成面向甲方的中文进度汇报 PDF。
    按管理后台/客户端/员工端/数据库分端统计，业务语言描述。
---

# 甲方进度汇报 PDF 生成

从 git 历史中提取变更，翻译为甲方能理解的业务语言，生成专业的中文 PDF 报告。

## When to Use

- 需要向甲方汇报项目进度时
- 定期（每隔几天）出一份 PDF 进度报告
- 用户说 "生成汇报"、"出个报告"、"甲方要看进度"

**Don't use for:**
- 内部技术文档（用 /dev-changedoc）
- Git changelog 自动生成（用 git log 即可）
- 实时进度看板

## Quick Reference

| 任务 | 命令 |
| ---- | ---- |
| 生成报告 | `/progress-report` |
| 指定起始日期 | `/progress-report --since "2026-04-07"` |
| 指定天数 | `/progress-report --days 3` |

## Prerequisites

- `pandoc` >= 3.0（已安装：`pandoc --version`）
- `xelatex`（TeX Live，已安装：`xelatex --version`）
- 中文字体：Songti SC（宋体-简）、Heiti SC（黑体-简）

## Workflow

### Phase 1: 确定 Git 范围

1. 读取状态文件 `.Codex/last-report.json`：

```bash
cat .Codex/last-report.json 2>/dev/null || echo '{"commit": null, "date": null}'
```

2. 确定基准点：
   - 如果用户传了 `--since "日期"` 参数 → 用 `git log --since="日期"` 做范围
   - 如果用户传了 `--days N` 参数 → 用 `git log --since="N days ago"` 做范围
   - 如果 `last-report.json` 存在且 `commit` 非 null → 用 `<commit>..HEAD` 做范围
   - 如果首次运行（无状态文件）→ 提示用户选择：最近 7 天 / 指定日期 / 指定 commit

3. 记录当前 HEAD commit hash（用于 Phase 5 更新状态）：

```bash
git rev-parse HEAD
```

**Exit criteria:** 确定了 git log 的范围参数（`GIT_RANGE`）。

### Phase 2: 收集各端变更

按 4 个维度分别收集 commit（排除 merge commit）：

```bash
# 管理后台
git log ${GIT_RANGE} --no-merges --format="%h %s" -- fengyu-admin/

# 客户端小程序
git log ${GIT_RANGE} --no-merges --format="%h %s" -- fengyu-client/

# 员工端小程序
git log ${GIT_RANGE} --no-merges --format="%h %s" -- fengyu-staff/

# 数据库 + 云函数后端
git log ${GIT_RANGE} --no-merges --format="%h %s" -- db/ cloudfunctions/
```

如果某端没有 commit，记为"本期无更新"。

同时统计整体数据：
```bash
# 总提交数
git log ${GIT_RANGE} --no-merges --oneline | wc -l

# 文件变更统计（注意：时间模式下需先取最早 commit hash）
# 如果 GIT_RANGE 是 commit 范围（如 abc123..HEAD），直接 git diff：
git diff ${GIT_RANGE} --stat | tail -1
# 如果 GIT_RANGE 是时间参数（如 --since="3 days ago"），先取最早 commit：
OLDEST=$(git log ${GIT_RANGE} --no-merges --format="%H" | tail -1)
git diff ${OLDEST}^..HEAD --stat | tail -1
```

**Exit criteria:** 4 端的 commit 列表 + 整体统计已收集完毕。

### Phase 3: 生成 Markdown 报告

用收集到的 commit 列表，按以下规则生成 Markdown：

**翻译规则（核心）：**
- 把技术性 commit message 翻译为甲方能理解的业务语言
- `feat(order): add advisory lock` → "完善了订单系统的并发安全保护"
- `fix(auth): handle null openid` → "修复了用户登录偶发失败的问题"
- `chore(db): migrate xxx` → "优化了数据库结构"
- `ci(xxx)` / `chore(deps)` 等纯技术维护 → 可合并为"日常技术维护与优化"
- 同一功能的多个 commit 合并为一条业务描述
- 使用中文，语气专业但不过度技术化

**Markdown 结构：** 使用模板 `templates/report.md` 填充内容，将结果写入 `reports/` 目录：

```text
reports/凤御_进度汇报_YYYYMMDD.md
```

**Exit criteria:** Markdown 报告已写入 reports/ 目录。

### Phase 4: 转换为 PDF

使用 pandoc + XeLaTeX 生成 PDF：

```bash
pandoc "reports/凤御_进度汇报_YYYYMMDD.md" \
  -o "reports/凤御_进度汇报_YYYYMMDD.pdf" \
  --pdf-engine=xelatex \
  --metadata-file=".Codex/skills/progress-report/templates/pandoc.yaml" \
  -V geometry:margin=2.5cm \
  -V fontsize=11pt
```

如果 pandoc 失败：
- 检查字体名称是否正确（`fc-list :lang=zh family`）
- 检查 LaTeX 包是否缺失（`tlmgr install xxx`）

**Exit criteria:** PDF 文件已生成在 `reports/` 目录中。

### Phase 5: 更新状态 & 报告

1. 更新状态文件：

```json
// .Codex/last-report.json
{
  "commit": "<当前 HEAD hash>",
  "date": "YYYY-MM-DD",
  "output": "reports/凤御_进度汇报_YYYYMMDD.pdf"
}
```

2. 向用户报告：
   - PDF 路径
   - 覆盖的日期范围
   - 总提交数和各端提交数
   - 提醒用户检查内容后发送给甲方

## Common Mistakes

| 问题 | 解决 |
| ---- | ---- |
| PDF 中文乱码 | 检查 pandoc.yaml 中的 CJKmainfont 是否与 `fc-list` 输出一致 |
| 首次运行无基准 | 提示用户指定 `--since` 或 `--days`，不要用全量 git log |
| commit 太多导致报告冗长 | 合并同功能 commit，技术维护类统一归纳为一条 |
| reports/ 被 git 追踪 | 确认 `reports/` 在 `.gitignore` 中 |

## Resources

| Type | Path | Description |
| ---- | ---- | ----------- |
| Template | [templates/report.md](templates/report.md) | Markdown 报告模板 |
| Config | [templates/pandoc.yaml](templates/pandoc.yaml) | pandoc XeLaTeX 中文配置 |
| State | `.Codex/last-report.json` | 上次汇报状态（commit + 日期） |
| Output | `reports/` | PDF 输出目录 |
