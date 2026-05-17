# 接入 `bun run lint:cas-guards` 到 GitHub Actions PR Gate

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | ⏳ 待实施 |
| 优先级 | **P1**（CI 守门缺失，回归无防护；非资损，但 Top10 #8 闭环依赖） |
| 端 | 项目根（`.github/workflows/`） |
| 修复成本 | **S**（< 1h） |
| 来源 | SUMMARY v4 §6.1 #A + E13 cas 守门 epic |
| 关联 ticket | `archives/2026-05-17-state-machine-cas-guard.md` |

---

## 0 一句话背景

`scripts/lint-cas-guards.mjs` + 11 处 CAS 站点 + 8 处 CAS-EXEMPT 注释 已于 2026-05-18 全部落地（commits d5b7741 / 346f73c / 6510e87），但 lint **未接入任何 GitHub Actions workflow / git hook**，未来若有人新写 `UPDATE sale_orders SET status=...` 缺 CAS 守卫，本地不跑 `bun run lint:cas-guards` 时无任何拦截 → Top10 #8 仍处于"代码完成但守门缺失"半开状态。

## 1 现状（grep 实证）

### 1.1 已存在的产物

`scripts/lint-cas-guards.mjs:1-68`（68 行，无外部依赖，纯 node 脚本）：

```js
#!/usr/bin/env node
// scripts/lint-cas-guards.mjs
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
...
const TABLES = ['sale_orders', 'appointments', 'service_orders', 'store_unbind_requests', 'sale_order_payments']
const updateRe = new RegExp(`UPDATE\\s+(${TABLES.join('|')})[\\s\\S]{0,400}?SET[\\s\\S]{0,400}?status`, 'g')
const guardRe = /(AND|WHERE)[\s\S]{0,200}status\s*(=|IN|=\s*ANY)/
...
if (failed) { console.error(`\n✘ ${failed} 处...`); process.exit(1) }
```

`package.json:12`：

```json
"scripts": {
  "lint:cas-guards": "node scripts/lint-cas-guards.mjs"
}
```

### 1.2 GitHub Actions 现有 workflow（3 个）

```
.github/workflows/
├── claude-code-review.yml    # PR 自动 review（anthropics/claude-code-action@v1）
├── claude.yml                # @claude 触发式（issue / pr_review_comment）
└── db-migrations-check.yml   # PR paths-filtered（db/schema, db/migrations）
```

- `claude-code-review.yml` 无 lint step，只调用 anthropics action 做 review
- `db-migrations-check.yml` 仅在 db schema 变更时触发，scope 不匹配
- **无通用 lint workflow**

### 1.3 husky / lint-staged 状态

```bash
$ grep -l "husky\|lint-staged" package.json fengyu-admin/package.json
（无输出）
$ ls .husky/
no .husky/
```

**husky 未安装**；若选 git hook 路径需要先 `bun add -D husky` + `bun husky init`，工作量从 S 升 M。

## 2 修改计划

### 2.1 推荐方案：新建 `.github/workflows/lint.yml`

新建独立轻量 workflow（与 admin `bun run lint` / `npx tsc --noEmit` 同位），便于后续 admin/staff/client 其它 lint 任务并列扩展。

```yaml
name: Repo-level lint

on:
  pull_request:
    paths:
      - 'fengyu-admin/src/**/*.ts'
      - 'fengyu-admin/src/**/*.tsx'
      - 'fengyu-admin/src/**/*.js'
      - 'fengyu-staff/cloudfunctions/**/*.js'
      - 'fengyu-client/cloudfunctions/**/*.js'
      - 'scripts/lint-cas-guards.mjs'
      - '.github/workflows/lint.yml'

jobs:
  cas-guards:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Run CAS guard lint
        run: node scripts/lint-cas-guards.mjs
```

> 注：脚本只依赖 `node` + `git ls-files`，**不需要 bun / npm ci**，所以不必装 deps。
> 失败信息会以 `MISS-CAS-GUARD: <file>:<line>` 形式打到 PR Checks 日志。

### 2.2 备选方案 A：合并到 `claude-code-review.yml`

在 anthropics action 之前插入 lint step：

```yaml
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Lint CAS guards          # ← 新增
        run: node scripts/lint-cas-guards.mjs

      - name: Run Claude Code Review
        ...
```

缺点：lint 失败时 anthropics action 也被 fail-fast 跳过，PR 自动 review 等于丢失。**不推荐**。

### 2.3 备选方案 B：husky pre-commit

需要先装 husky（项目根 `bun add -D husky` + `bun husky init`），然后：

```sh
# .husky/pre-commit
node scripts/lint-cas-guards.mjs
```

缺点：(1) husky 当前未安装；(2) 本地 hook 可被 `--no-verify` 绕过；(3) CI 端仍需独立守门。
**仅作为 CI 守门之外的本地辅助**，不替代 GitHub Actions gate。

### 2.4 执行步骤

1. 新建 `.github/workflows/lint.yml`（按 §2.1 模板）
2. 提交 PR
3. 在 PR 上故意将 `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 中任一 `// CAS-EXEMPT: ...` 注释改成普通文字（如 `// note: ...`），workflow 应失败并输出 `MISS-CAS-GUARD: ...`
4. 恢复注释，workflow 应通过，再 merge

## 3 验收 DoD

- [ ] `.github/workflows/lint.yml` 已创建，触发条件含 `fengyu-{admin,staff,client}/**` + `scripts/lint-cas-guards.mjs` 自身
- [ ] PR 提交后 GitHub Checks 标签出现 `Repo-level lint / cas-guards` 任务
- [ ] 主动破坏一处 CAS-EXEMPT 注释（例如 `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 内任一处），workflow 失败、日志含 `MISS-CAS-GUARD: <file>:<line>` 与 `✘ N 处状态机 UPDATE 缺少 CAS 守卫或 CAS-EXEMPT 注释`
- [ ] 恢复注释后 workflow 重跑通过，日志含 `✔ 全部状态机 UPDATE 已携带 CAS 守卫或 CAS-EXEMPT 注释`
- [ ] SUMMARY §2 Top10 #8 状态标注由 "代码完成，CI 守门未接" → "**DONE**（含 CI 守门）"
- [ ] SUMMARY §4 E13 epic 状态由 🔶 → ✅
- [ ] SUMMARY §6.1 #A 行打勾归档
- [ ] （可选）`.husky/pre-commit` 不在本 ticket 范围，需另立 ticket（如做本地兜底）

## 4 影响范围与回滚

**范围**：
- 仅新增 `.github/workflows/lint.yml` 一个文件
- 不改业务代码、不改 lint 脚本本身
- 不引入 npm 依赖（脚本零依赖纯 node）

**潜在副作用**：
- 触发条件 `paths` 匹配 `fengyu-{admin,staff,client}/**`，几乎每个 PR 都会跑；任务本身 < 5s，GitHub Actions 免费配额内可忽略
- 如果未来扩展 `scripts/lint-cas-guards.mjs` 的 TABLES 列表，旧 PR rebase 后可能失败 — 这是预期行为

**回滚**：
- 删除 `.github/workflows/lint.yml` 即可，无 schema/数据影响

**out-of-scope**：
- husky 本地 hook（如需，单独立 ticket）
- 其它 lint 任务（如 admin ESLint、staff e2e smoke）汇总到此 workflow（保持单一职责，可后续扩 jobs）
- 把 lint 接入 `bun run` 包装（脚本路径已通过 `package.json` `lint:cas-guards` 暴露，workflow 直接 `node` 调脚本是更稳的写法，避免依赖 bun runtime 在 GH runner 上的版本）
