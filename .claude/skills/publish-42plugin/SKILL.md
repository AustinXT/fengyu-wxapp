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
  version: 1.0.1
  title: 发布 42plugin 技能
  description_zh: 批量将本地 SKILL 发布或更新到 42plugin 套包，处理版本管理与非交互确认
---

# 批量发布 42plugin 技能

将本地 `.claude/skills/` 目录下的技能批量发布或更新到 42plugin 套包。

## 用法

```bash
/publish-42plugin    # 发布当前项目所有技能
/publish-42plugin wx-implement-api    # 发布指定技能
/publish-42plugin wx-implement-api wxapp    # 指定技能和套包
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

重点提取并在交互中展示以下字段：

| 字段 | 说明 |
|------|------|
| `name` | 技能标识符，平台将其 Title Case 化后作为显示名（如 `wx-coding` → "Wx Coding"） |
| `metadata.version` | 当前版本号 |
| `metadata.title` | 中文标题（在交互中展示给用户，**不影响**平台卡片显示名） |
| `metadata.description_zh` | 中文描述（在交互中展示给用户） |

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
# 提取 metadata.title，作为平台显示名传入 --name
SKILL_DIR=".claude/skills/<skill-name>"
TITLE=$(grep -m1 '^\s*title:' "$SKILL_DIR/SKILL.md" | sed 's/.*title:[[:space:]]*//')
echo "Y" | 42plugin publish "$SKILL_DIR" -t skill -k <kit-name> --name "$TITLE"

# 参数说明：
# TITLE        — 从 metadata.title 自动提取，作为平台显示名
# echo "Y" |   — 通过管道自动回答版本升级确认提示
# -t skill     — 指定类型（skill/agent/command/hook），避免交互选择
# -k <name>    — 指定套包名，避免交互式选择（仅填名称，不加 author/）
# --name       — 将 metadata.title 设为平台显示名（平台默认用 name 字段 Title Case 化）
```

在交互中展示该技能的元信息（执行前告知用户）：

```bash
# 读取 metadata.title 和 metadata.description_zh 展示给用户
grep -E '^\s+(title|description_zh):' .claude/skills/<skill-name>/SKILL.md
```

示例展示格式：

```text
即将发布：<skill-name>
  title:          发布 42plugin 技能
  description_zh: 批量将本地 SKILL 发布或更新到 42plugin 套包，处理版本管理与非交互确认
  version:        1.0.1 → 套包: <kit-name>
```

### 3.2 批量并行发布

同时发布多个技能，节省时间：

```bash
for skill in skill-a skill-b skill-c; do
  TITLE=$(grep -m1 '^\s*title:' ".claude/skills/$skill/SKILL.md" | sed 's/.*title:[[:space:]]*//')
  echo "Y" | 42plugin publish ".claude/skills/$skill" -t skill -k <kit> --name "$TITLE" &
done
wait
echo "✅ 全部发布完成"
```

> **注意：** `&` 让命令在后台并行执行，`wait` 等待所有后台任务完成。

### 3.3 完整 CLI 参数速查

| 选项 | 短参数 | 说明 |
|------|--------|------|
| `--kit <name>` | `-k` | 指定套包（必填，避免交互） |
| `--type <type>` | `-t` | 指定插件类型 skill\|agent\|command\|hook |
| `--name <name>` | `-n` | 覆盖插件名称（kebab-case，默认取 SKILL.md 中 name 字段） |
| `--force` | `-f` | 强制发布（即使内容未变） |
| `--public` | | 公开发布（默认私有） |
| `--private` | | 私有发布（需 Pro 订阅） |
| `--dry-run` | | 仅验证，不实际发布 |
| `--no-sync-version` | | 不将 metadata.version 同步为发布版本号 |

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
# 确认各技能 title 和 version 已更新
42plugin search "<author>/<kit>" --json --limit 20 | \
  jq '.plugins[] | {name, title, version}'

# 安装整个套包验证可用性
42plugin install <author>/<kit-name>

# 安装单个技能验证
42plugin install <author>/<kit-name>/<skill-name>
```

> **注意：** 平台卡片显示名由 `name` 字段 Title Case 化得到（如 `wx-coding` → "Wx Coding"），`metadata.title` 不影响平台显示名，仅作为元数据存储。

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

**删除正确路径：** 我的插件 → `<kit名>` → `<插件名>` → 删除
（不要从全局搜索结果中删除，可能定位错误）

### 问题 5: 首次发布版本号被平台重置

**现象：** SKILL.md 中写的是 `version: 2.1.0`，但发布后平台显示 `v1.0.0`。

**原因：** 首次发布时平台强制从 `v1.0.0` 开始，忽略 SKILL.md 中的版本号。

**解决：** 发布后将 SKILL.md 中的 `metadata.version` 手动同步改回 `1.0.0`，保持一致。

### 问题 6: 同名插件跨套包迁移失败

**场景：** 将 `seed-data` 从 `wxapp` 套包迁移到 `dev` 套包。

**报错：** 同名插件已存在，无法在不同套包下重复发布。

**解决步骤：**
1. 到 42plugin 网站：我的插件 → `<源 kit>` → `<插件名>` → 删除
2. 等待几分钟（平台有缓存延迟，删完后 `42plugin search` 可能仍显示旧插件）
3. 确认 `42plugin search <name>` 已无结果后再重新发布
4. `42plugin publish .claude/skills/seed-data -t skill -k dev`

> **注意：** `42plugin purge` 只清除**本地**安装记录，不影响云端已发布的插件。

---

## 输出摘要

完成后输出：

```text
发布套包：<kit-name>
发布结果：
  ✅ skill-a — v1.0.2（更新）
      title: 新标题A
      description_zh: 中文描述A
  ✅ skill-b — v1.0.2（更新）
      title: 新标题B
      description_zh: 中文描述B
  ❌ skill-c — 失败：<错误信息>
验证状态：已通过 / 需处理
```
