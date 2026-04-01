---
name: smart-commit
title: 安全提交 + 审计分组
description: >
  Use when committing and pushing git changes with audit-friendly grouping -
  uses gitleaks for security scanning (auto-redacts detected secrets), checks
  branch safety and .gitignore completeness, groups changes by logical purpose
  into separate commits, then pushes after user confirmation. Triggered by
  requests like "帮我提交代码", "smart commit", "分批提交", "commit and push", "安全提交".
alwaysApply: false
metadata:
  author: user3602
  version: 1.0.1
  title: 安全提交 + 审计分组
  description_zh: gitleaks 安全扫描（支持自动脱敏），按逻辑目的拆分 commit，检查分支安全和 .gitignore，push 前确认 remote 状态。
---

# Smart Commit

## Overview

职责分离架构：🔒 gitleaks 负责安全扫描（零 token、150+ 规则）；🧠 Claude AI 负责分组决策。Claude 只读 `git diff --stat` 和文件名，**不读取文件内容**。

## When to Use

- 积累了多个不同目的的改动，需要拆分为有意义的 commit
- 提交前想检查是否有密钥、手机号等敏感信息意外混入
- 想要规范的 commit message，方便后续审计和回溯

**不适用于：** 只需要 `git add . && git commit -m "fix"` 的简单单次提交

## 执行步骤

### 第零步：环境与分支检查

同时运行：
```bash
git branch --show-current
git log --oneline -1 2>/dev/null || echo "NO_COMMITS"
cat .gitignore 2>/dev/null | head -30
which gitleaks 2>/dev/null || echo "GITLEAKS_MISSING"
```

**分支安全：** 若在 main/master/develop，发出醒目警告并询问是否继续。

**.gitignore 检查：** 若不存在或未覆盖 `.env`、`*.key`、`*.pem`，提示补充。

**gitleaks 检查：** 若未安装（`GITLEAKS_MISSING`），告知用户运行 `brew install gitleaks` 后重试。本 skill 强依赖 gitleaks，不使用 AI 替代扫描。

### 第一步：了解改动范围（不读内容，只看结构）

同时运行：
```bash
git status --short
git diff HEAD --stat   # 只看文件名和行数，不读内容
```

对于 `??` 状态的新增未追踪文件，只记录文件名和大小：
```bash
wc -c <文件路径>
```

如果没有任何改动，告知用户"当前没有需要提交的修改"后退出。

⚠️ **AI 对话记录（chats/ 等目录）是最高风险区**：用户在对话中可能说出真实密码。不在此步骤读取其内容，安全扫描完全交给 gitleaks。

### 第二步：运行 gitleaks 扫描（核心安全门控）

```bash
# 暂存所有变更
git add -A

# 运行扫描（自动检测自定义规则）
if [ -f .gitleaks.toml ]; then
  gitleaks protect --staged --verbose --config .gitleaks.toml
else
  gitleaks protect --staged --verbose
fi
LEAK_STATUS=$?

# 立即 unstage，等待后续分批提交
git reset HEAD
```

**根据结果：**
- `LEAK_STATUS=0`：✅ 继续下一步
- `LEAK_STATUS=1`：🚨 立即停止，展示报告，执行以下流程：

**⛔ 发现泄漏时的处理规则（强制）：**

1. **先备份，再处理**（在对任何文件做删除或修改之前）：
   ```bash
   BACKUP_DIR=~/Desktop/smart-commit-backup-$(date +%Y%m%d-%H%M%S)
   mkdir -p "$BACKUP_DIR"
   cp -r <含泄漏的文件或目录> "$BACKUP_DIR/"
   echo "备份已保存到: $BACKUP_DIR"
   ```

2. **展示泄漏详情**：文件名 + 行号 + 规则类型

3. **提供处置选项，等待用户选择**：
   - `"自动脱敏"` → **默认推荐**，用 JSON 报告提取 secret 值，Python 批量替换为 `[REDACTED]`，重新扫描后继续：
     ```bash
     git add -A
     GITLEAKS_CMD="gitleaks protect --staged --report-format json --report-path /tmp/gitleaks_report.json"
     [ -f .gitleaks.toml ] && GITLEAKS_CMD="$GITLEAKS_CMD --config .gitleaks.toml"
     eval $GITLEAKS_CMD; git reset HEAD

     python3 -c "
     import json
     with open('/tmp/gitleaks_report.json') as f: findings = json.load(f)
     SKIP_RULES = set()  # 可按需加入已知误报规则 ID
     secrets = {item['Secret'] for item in findings
                if item['RuleID'] not in SKIP_RULES and len(item['Secret']) >= 12}
     files = {item['File'] for item in findings
              if item['RuleID'] not in SKIP_RULES and len(item['Secret']) >= 12}
     for path in files:
         content = open(path).read()
         for s in secrets: content = content.replace(s, '[REDACTED]')
         open(path, 'w').write(content)
         print(f'Redacted: {path}')
     "
     ```
     脱敏后自动重新扫描，若仍有告警，继续向用户展示剩余问题。
   - `"跳过该文件"` → 从本次提交中排除该文件，其余继续
   - `"我已处理"` → 用户自行修改后，重新运行 /smart-commit
   - `"清洗历史"` → 仅在用户明确要求时，说明 `git filter-repo` **会删除本地文件**，再次确认后才执行

4. **严禁自行执行的操作**（必须等用户明确授权）：
   `rm -rf` / `git filter-repo` / `git push --force` / `git reset --hard`

> gitleaks 内置 150+ 规则，覆盖 AWS、GCP、GitHub、Stripe、Tencent 等。项目根目录存在 `.gitleaks.toml` 时自动使用自定义规则。

### 第三步：规划提交方案

```bash
git log --oneline -5 2>/dev/null
```

沿用历史语言和前缀约定。历史过简（< 5 字）则采用 Conventional Commits 格式。

**分组原则（优先级从高到低）：**
1. 按修改目的（同 bug 修复 / 同功能 / 纯文档 → 各自成组）
2. 按子项目边界（不同 `src/子目录` 分开）
3. 避免混搭 `feat` 与 `chore`
4. 小改动合并（每文件 ≤ 3 行 → 合并）

**commit message：** Subject `type: 描述` ≤ 72 字符；涉及文件 > 3 个 / 含重要决策时必写 Body。

### 第四步：统一展示并确认

```
【✅ 安全扫描】：gitleaks 未发现泄漏

【📋 计划提交 N 个 commit】：
  1. feat: xxx（文件：a.py, b.md）
  2. chore: 更新对话记录（文件：chats/...）

【🚀 推送目标】：origin/分支名

回复：
  "确认" → 提交 + push
  "只提交" → 提交但不 push
  "修改第N个" → 调整分组或 message
```

### 第五步：分批提交

按计划分批执行 `git add <具体文件> && git commit`，每完成一个打印：`✓ [1/3] type: xxx`

### 第六步：推送

1. `git fetch origin` 检查 remote 状态
2. 若 remote 有新提交 → 暂停，建议先 `git pull --rebase`
3. 状态正常 → `git push`
4. 若在功能分支，询问是否创建 Pull Request

## 推荐 .gitleaks.toml 配置

如果项目存在 `.gitleaks.toml`，smart-commit 会自动使用它。以下是经过实际验证、修复了常见误报的推荐配置：

```toml
title = "gitleaks config"

# 扩展默认规则集（保留 gitleaks 内置的 150+ 条规则）
[extend]
useDefault = true

# ─── 腾讯云 ─────────────────────────────────────────────────────
[[rules]]
id          = "tencent-cloud-secret-id"
description = "Tencent Cloud SecretId"
regex       = '''AKID[A-Za-z0-9]{32,40}'''
tags        = ["tencent", "cloud", "key"]

[[rules]]
id          = "tencent-cloud-secret-key"
description = "Tencent Cloud SecretKey (32位字母数字，常见于配置文件)"
regex       = '''(?i)(secret[_-]?key|secretkey)\s*[=:：]\s*["']?([A-Za-z0-9]{32})["']?'''
tags        = ["tencent", "cloud", "key"]

# ─── 通用密码赋值（配置文件中的结构化密码）──────────────────────
[[rules]]
id          = "generic-password-assignment"
description = "Generic password in config/code"
# `:` 或 `=` 后最多允许一个空格，排除 SSH 提示（`user@host's password:         Permission denied`，多空格）
regex       = '''(?i)(password|passwd|pwd)\s*[=:：]\s?["']?([^\s"'#]{6,})["']?'''
tags        = ["password", "generic"]

[rules.allowlist]
regexes     = [
  # 排除示例/文档中的占位符
  '''(?i)(your[_-]?password|example|placeholder|changeme|<password>|\*{3,}|xxx+)''',
]

# ─── 全局白名单（减少误报）──────────────────────────────────────
[allowlist]
paths       = [
  '''.env.example''',  # 示例文件，通常只含占位符
]
regexes     = [
  '''(?i)your[_\-]?(api[_\-]?)?key''',         # 文档中的 "your-api-key" 说明
  '''sk_test_[a-zA-Z0-9]+''',                   # Stripe 测试密钥（非生产）
  '''-----BEGIN PRIVATE KEY-----[`）\s]''',     # 文档/对话中对 PEM 格式的描述性引用
]
```

**已修复的已知误报：**

| 场景 | 触发规则 | 修复方式 |
|------|---------|---------|
| SSH 登录提示 `user@host's password:         ` | `generic-password-assignment` | `:` 后改 `\s*` 为 `\s?`，多空格不匹配 |
| 文档中出现 `` `-----BEGIN PRIVATE KEY-----` `` | `private-key`（内置） | 全局 allowlist 排除后跟 markdown 标点的格式 |
| gitleaks 把变量名 `SecretKey` 报为 secret | `tencent-cloud-secret-key` | Secret 长度过滤（自动脱敏跳过 length < 12）|

## Common Mistakes

| 错误 | 影响 | 修复 |
|------|------|------|
| gitleaks 未安装就跳过扫描 | 密钥泄漏无法检测 | 第零步强制检查，未安装则中止 |
| 自动脱敏跳过 length < 12 的 secret | 误报变量名被替换破坏文件 | 过滤短字符串，只替换真实密钥格式 |
| 发现泄漏后直接执行 rm -rf / filter-repo | 数据永久丢失 | 必须先备份，等用户授权 |
| 所有改动一个 commit | 无法审计回溯 | 按逻辑目的拆分 |
| 盲目沿用低质量历史风格 | commit 无意义 | 历史过简则用 Conventional Commits |
