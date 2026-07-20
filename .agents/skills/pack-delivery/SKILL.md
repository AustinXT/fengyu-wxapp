---
name: pack-delivery
description: |
  在 prod worktree 把 main 最新代码合并进 prod 并处理冲突，剥净全部注释
  (JS/TS 用 AST、WXML/WXSS/SQL/SH 用正则，直接改源码树并提交)，再用内置
  pack-delivery.mjs 加固打包成客户交付 zip。三阶段流水线：合并 → 清洗 → 打包。
  Use when 用户说 打包交付 / 客户交付 / pack delivery / 合并 main 到 prod 做交付 /
  清洗注释重新打包。产出 fengyu-delivery-<ver>.zip，不给客户 git 仓库。
  与 release-all 互补：release-all 把代码部署到 dev/prod 服务器，本 skill 产出给客户的源码 zip。
argument-hint: '[merge-only|clean-only|pack-only|skip-merge|skip-clean]'
disable-model-invocation: true
user-invocable: true
allowed-tools: 'Bash, Read, Grep'
metadata:
  author: NightVoyager
  version: 1.0.0
  title: 客户交付打包
  description_zh: 合并 main→prod + 剥净注释 + 加固打包成 zip
  license: 42plugin-personal
---

# pack-delivery — fengyu-wxapp 客户交付打包

把客户交付维护编排成三阶段流水线：**合并 main→prod（解冲突）→ 剥净全部注释 → 加固打包成 zip**。本 skill 复用内置的 `strip-comments.mjs`（AST+正则剥注释）和 `pack-delivery.mjs`（加固打包），不重写逻辑，只按正确顺序调用并做校验。产出 `fengyu-delivery-<ver>.zip` 给客户（**不给 git 仓库**）。

复用脚本（skill 内置，位于 `.claude/skills/pack-delivery/scripts/`，不要改）：
- `strip-comments.mjs` — Phase 2 源码树剥注释（JS/TS 用 @babel/parser AST，WXML/WXSS/SQL/SH 用正则；白名单保留 eslint-disable/@ts-*/statement-breakpoint/shebang，豁免 deploy-admin.sh）
- `pack-delivery.mjs` — Phase 3 加固打包 7 步（复制→删架构资产→关 sourcemap→泛化 package.json→剥副本注释→扫 JS/TS 残留 + 凭据扫→zip）

参数（可组合）：`merge-only` `clean-only` `pack-only` `skip-merge` `skip-clean`。无参数 = 完整 Phase 0→4。

## Usage

`/pack-delivery [merge-only|clean-only|pack-only|skip-merge|skip-clean]` — 手动触发（强副作用，不会被自动调用）。须在 prod worktree 根目录运行（`pwd` 含 `/worktrees/fengyu-wxapp/prod`）。

---

## §0 护栏（每次必须遵守，不可破例）

- 客户交付物是 **zip**，**绝不给 git 仓库**（1803 commit / 1039 tag / 88MB 对象库全可达，`git log -p` 能取回所有被删内容）
- **绝不 push main**：prod 默认跟踪 origin/main，必须 `git push origin prod:prod` 显式 refspec，否则污染 main
- JS/TS 注释**必须 AST 剥**，**绝不正则盲剥**（会破坏字符串/正则字面量）
- 不混淆代码（标识符不重命名，源码清洗是唯一保护层）
- 合并 UU content 冲突**全采 main**（prod 独有是旧 timestamp 范式，采 prod 会与 5433 生产库不一致）—— 详见 [reference/conflict-resolution.md](reference/conflict-resolution.md)
- 不删 `db/schema/`、`db/migrations/`、`_journal.json`（部署命脉）；不删 `mock/`、`mock-api.ts`（生产软依赖）
- `envs/prod.env` 真值**不入 git**（.gitignore 保护；打包只放 `*.example`）
- 注释白名单必须保留：`shebang` / `eslint-disable` / `statement-breakpoint` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`
- 豁免 `.claude/skills/remote-deploy/deploy-admin.sh`（部署说明有文档价值）
- halt on anomalous output：凭据闸门命中 / 异常输出立即停下问用户

---

## §1 Phase 0 — 预检门禁（全只读，任一失败立即停）

1. 确认在 prod worktree：`pwd` 含 `/worktrees/fengyu-wxapp/prod`
2. `git status` 工作区干净（feedback_deploy_check_git_status）
3. `git fetch origin && git log --oneline HEAD..origin/main` — 看 prod 落后 main 多少 commit，复述给用户
4. 记录当前 `APP_VERSION`：`grep -h APP_VERSION fengyu-*/miniprogram/utils/version.ts`

**Exit criteria**：在 prod worktree、工作区干净、落后量已确认。

---

## §2 Phase 1 — 合并 main → prod（除非 `skip-merge`；`merge-only` 到此结束）

> prod 是交付分支，需含 main 最新功能。合并会把 main 的完整注释带回，Phase 2 必须重剥。

1. **干跑评估冲突**（评估后可 `git merge --abort` 放弃）：
   ```bash
   git merge --no-commit --no-ff origin/main
   git diff --name-only --diff-filter=U        # UU = content 冲突
   git ls-files -u | grep -E '^(DD|DU|UD)'     # modify/delete 冲突
   ```

2. **分类解决**（决策详表见 [reference/conflict-resolution.md](reference/conflict-resolution.md)）：
   - **UU content** → `git checkout --theirs <file> && git add <file>`（**全采 main**）— prod 独有改动是旧 timestamp 范式代码
   - **DU/UD modify-delete** → 保持删除（`git rm <file>` 或 `git add` 记录删除）
   - **main 新增测试文件**（无冲突但不该留）→ `git rm -f <file>`（如 `tz-probe-helper.ts`、`smoke-timestamp-reader.mjs`）

3. **安全闸门验证**（合并带回的代码不破坏生产口径，命令清单见 reference）：
   - `db/migrations/0076_to_withtimezone.sql` 存在
   - `_journal.json` 条数与 5433 生产库 `drizzle.__drizzle_migrations` 计数一致
   - schema 范式为 `timestamp("xxx", { withTimezone: true })`
   - 凭据 grep 无命中（`47.113.202.7` / `47.96.87.33` / `fengyu123` / `Se[14]Qimoh` 等）

4. `git commit -m "merge: 合并 main(<main-short>)→ prod,对齐 <范式/主题>"`

5. **push（显式 refspec！）**：
   ```bash
   git push origin prod:prod   # 不要 git push（默认推 origin/main 会污染 main）
   ```
   若 prod 未跟踪 origin/prod：`git push -u origin prod:prod`

6. （部署需要时）引入 prod env 真值（不入 git，从主仓复制到 worktree）：
   ```bash
   cp "$(dirname "$(git rev-parse --git-common-dir)")/envs/prod.env" envs/prod.env
   # .gitignore 已保护 envs/prod.env 不入 git
   ```

**Exit criteria**：prod 含 main 全部代码、闸门全绿、push origin/prod 成功。

---

## §3 Phase 2 — 剥净全部注释（除非 `skip-clean`；`clean-only` 到此结束）

> 合并把 main 的完整注释带回，必须重剥。**作用域 = 源码树，改完 commit**（prod 分支永久全干净）。

1. 首次运行前装依赖（@babel/parser；strip-comments.mjs 带自举，缺失时也会自动装）：
   ```bash
   cd .claude/skills/pack-delivery/scripts && npm install && cd -
   ```

2. 在 prod 根运行：
   ```bash
   node .claude/skills/pack-delivery/scripts/strip-comments.mjs
   ```
   - JS/TS（`.ts/.tsx/.js/.jsx/.mjs/.cjs`）：@babel/parser AST，按 comment range 倒序删注释字符（代码字符零改动），保留白名单
   - WXML `<!--…-->`｜WXSS/CSS `/*…*/`｜SQL 行首 `--`｜SH 行首 `#`（保留 shebang，豁免 deploy-admin.sh）
   - 自动跳过 `node_modules/.git/.next/.tree/dist/delivery-staging/delivery`、顶层 `scripts/`、`__tests__/e2e`、test 文件、`.claude`（除 remote-deploy）

3. **校验**：
   ```bash
   node --check fengyu-admin/src/actions/orders.ts   # 抽查关键文件语法通过
   git diff --stat                                    # 改动文件数合理（仅合并带回注释的文件）
   ```
   抽样确认 `import` / `pgTable(` / `documentType` 等代码行未变（只删注释）。

4. 用 `/smart-commit` 提交：`delivery: 剥净合并带回的注释(JS/TS AST + WXML/WXSS/SQL/SH)`

**Exit criteria**：源码树注释剥净、`node --check` 通过、已提交。

---

## §4 Phase 3 — 加固打包（`pack-only` 到此结束）

1. 在 prod 根运行内置打包器：
   ```bash
   node .claude/skills/pack-delivery/scripts/pack-delivery.mjs
   ```
   7 步自动：复制 prod 树→delivery-staging → 删架构泄露资产 → 关 sourcemap → 泛化 package.json → 剥 WXML/WXSS/SQL/SH（副本兜底）→ 扫 JS/TS 残留 + 凭据扫 → zip

2. **看 6a 输出**（Phase 2 验证点）：
   - `✓ JS/TS 无残留注释` → Phase 2 洗净 ✓
   - `⚠ N 个 JS/TS 文件含残留` → **回 §3 重剥**（strip-comments 范围漏了某些文件）

3. **看 6b 输出**（凭据闸门）：
   - 命中真实凭据 → `process.exit(1)` 中止 → 先中和再打包（halt on anomalous output）

4. 产出 `fengyu-delivery-<ver>.zip`

**Exit criteria**：zip 生成、6a 零残留、6b 凭据零命中。

---

## §5 Phase 4 — 交付校验

```bash
ZIP=$(ls -t fengyu-delivery-*.zip | head -1)
unzip -l "$ZIP" | grep -E '\.git/|node_modules|envs/(prod|dev)\.env|release-all/'   # 应无输出
unzip -l "$ZIP" | grep -E 'db/schema/|_journal.json|remote-deploy/deploy-admin.sh|fengyu-admin/bun.lock|db/bun.lock'  # 应都存在
ls -lh "$ZIP"
```
报告 zip 路径 + 大小 + 文件数给用户。

---

## §6 收尾 — 手工步骤

1. `delivery-staging/` 可 `rm -rf`（zip 已生成；目录 gitignored）—— 留着可抽检。
2. zip 是给客户的；源码树的合并 / 清洗改动是内部交付分支状态（已提交）。
3. 若本次有未提交的合并 / 清洗改动 → `/smart-commit` 分组提交（合并一组、清洗一组）。

---

## §7 When to Use / When NOT

**Use**：
- 客户交付打包（完整三阶段）
- 合并 main 到 prod 做交付
- 合并后清洗注释重新打包
- 只跑某阶段（`*-only` / `skip-*`）

**NOT**：
- 代码发版部署（admin + 云函数，dev/prod）→ `/release-all`
- DB schema 迁移到 5433 → `db/CLAUDE.md`（独立人工前置，不在本 skill）
- 首次交付基线建立（删测试文件 / 中和凭据 / 删架构资产）—— 一次性，已由历史 commit `71cfc7f4`~`9864792a` 完成；本 skill 只做**增量维护**

---

## Resources

| 类型 | 路径 | 说明 |
|---|---|---|
| Script | [scripts/strip-comments.mjs](scripts/strip-comments.mjs) | Phase 2 源码树剥注释（AST + 正则） |
| Script | [scripts/pack-delivery.mjs](scripts/pack-delivery.mjs) | Phase 3 加固打包 7 步 |
| Reference | [reference/conflict-resolution.md](reference/conflict-resolution.md) | Phase 1 冲突分类决策详表 + 闸门命令 |
