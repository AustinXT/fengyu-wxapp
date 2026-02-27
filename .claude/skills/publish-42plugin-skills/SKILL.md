---
name: publish-42plugin
description: |
  用于批量发布或更新本地技能到 42plugin 套包，帮助处理版本号管理、非交互式 CLI
  确认与并行发布多个技能。当用户说"发布技能"、"批量发布"、"更新技能名称"、
  "publish skill"、"重新发布插件"时使用。
argument-hint: '[技能目录路径或套包名称]'
user-invocable: true
metadata:
  author: opc
  version: 1.0.0
  title: 批量发布 42plugin 技能
  description_zh: 批量将本地 SKILL 发布或更新到 42plugin 套包，处理版本管理与非交互确认
---

# 批量发布 42plugin 技能

将本地 `.claude/skills/` 目录下的技能批量发布或更新到 42plugin 套包。

## 用法

```bash
/publish-42plugin-skills                          # 发布当前项目所有技能
/publish-42plugin-skills wx-implement-api         # 发布指定技能
/publish-42plugin-skills wx-implement-api wxapp   # 指定技能和套包
```

## 何时使用

- 修改了 `metadata.title` 或其他字段后，需要同步到网页显示
- 首次将一批本地技能发布到套包
- 批量升级套包中多个技能的版本

## 不适用

- 单个技能的首次创建（用 `42plugin-meta`）
- 搜索和安装插件（用 `42plugin`）
- 删除已发布的插件（需手动到 42plugin 网站操作）

---

## Step 1: 确认发布范围

### 1.1 扫描待发布技能

读取技能目录下所有 SKILL.md，提取关键字段：

```bash
# 查看所有本地技能
ls .claude/skills/

# 读取某个技能的 metadata
head -15 .claude/skills/<skill-name>/SKILL.md
```

重点提取：
- `name` — 技能标识符
- `metadata.version` — 当前版本号
- `metadata.title` — 网页显示标题（这是发布后网页展示的名称）

### 1.2 确认套包信息

```bash
# 查看可用套包
42plugin list --json | jq '.[].sourceKit'

# 或查看当前账号的套包
42plugin publish --help  # 会显示可用套包
```

> **重要：** 套包名必须预先存在。如需新建套包，先通过 42plugin 网站创建。

### 1.3 确认发布模式

```text
发布场景：
  [ ] 首次发布（技能从未上传过）
  [ ] 更新已发布技能（需要升级版本号）
  [ ] 更新 metadata（如修改了 title，必须重新发布才能同步）
```

---

## Step 2: 版本号管理

### 2.1 检查远程版本

```bash
# 查看套包中的当前技能版本
42plugin search "<author>/<kit>" --json --limit 20 | jq '.plugins[] | {name, version: .version}'
```

### 2.2 升级 SKILL.md 版本号

**如果远程已存在同版本，CLI 会弹出交互提示。最简单的做法是先升级版本号：**

编辑 `SKILL.md`，将 `metadata.version` 从 `1.0.1` 改为 `1.0.2`：

```yaml
metadata:
  version: 1.0.2  # 从 1.0.1 升级
```

> **规则：** `metadata.version` 决定发布版本号，格式为 `major.minor.patch`。
> 升级后 CLI 检测到版本变化，直接发布不再询问。

---

## Step 3: 执行发布

### 3.1 单个技能发布

```bash
# 基本命令
echo "Y" | 42plugin publish .claude/skills/<skill-name> --type skill --kit <kit-name>

# 参数说明：
# echo "Y" |     — 通过管道自动回答版本升级确认提示
# --type skill   — 指定类型（skill/agent/command/hook）
# --kit <name>   — 必须指定套包名，避免交互式选择（仅填名称，不加 author/）
```

### 3.2 批量并行发布

同时发布多个技能，节省时间：

```bash
echo "Y" | 42plugin publish .claude/skills/skill-a --type skill --kit <kit> &
echo "Y" | 42plugin publish .claude/skills/skill-b --type skill --kit <kit> &
echo "Y" | 42plugin publish .claude/skills/skill-c --type skill --kit <kit> &
wait
echo "✅ 全部发布完成"
```

> **注意：** `&` 让命令在后台并行执行，`wait` 等待所有后台任务完成。

### 3.3 常见 CLI 选项

| 选项 | 说明 |
|------|------|
| `--kit <name>` | 指定套包（必填，避免交互） |
| `--type skill` | 指定插件类型 |
| `--public` | 公开发布（默认私有） |
| `--force` | 强制发布（即使内容未变） |
| `--dry-run` | 仅验证，不实际发布 |

---

## Step 4: 验证发布结果

### 4.1 检查发布输出

成功的发布输出示例：

```text
✓ 发布成功!
  ⚡ opc/wx-implement-api
  版本: v1.0.2
  类型: skill
  状态: 更新
```

### 4.2 验证套包内容

```bash
# 搜索确认技能已更新
42plugin search "<author>/<kit>" --json --limit 20 | \
  jq '.plugins[] | {name, title, version}'
```

确认每个技能的 `title` 已经更新为 SKILL.md 中的 `metadata.title`。

---

## 常见问题排查

### 问题 1: 版本升级交互提示

```text
? 发现已存在版本 v1.0.1，是否更新到 v1.0.2? (Y/n)
```

**原因：** 远程存在同版本，CLI 询问是否升级。

**解决：**
- 方案 A（推荐）：先在 SKILL.md 中手动升级 `metadata.version`，再发布
- 方案 B：`echo "Y" | 42plugin publish ...` 通过管道自动回答

### 问题 2: 套包不存在

```text
错误: 套包 "opc/wxapp" 不存在
```

**原因：** `--kit` 参数格式错误，只需填套包名，不加作者前缀。

**解决：** `--kit wxapp`（不是 `--kit opc/wxapp`）

### 问题 3: title 在网页上不更新

**原因：** `metadata.title` 修改后，必须重新发布才能同步到网页。

**解决：** 升级版本号 → 重新发布 → 等待几分钟后刷新网页

### 问题 4: 旧名称插件残留

如果技能改名（如 `implement-api` → `wx-implement-api`），旧名称的插件仍在云端共存。

**解决：** CLI 没有 `unpublish` 命令，需手动到 42plugin 网站删除旧插件。

---

## 输出摘要

完成后输出：

```text
发布套包：<kit-name>
发布结果：
  ✅ skill-a — v1.0.2（更新）title: 新标题A
  ✅ skill-b — v1.0.2（更新）title: 新标题B
  ❌ skill-c — 失败：<错误信息>
验证状态：已通过 / 需处理
```
