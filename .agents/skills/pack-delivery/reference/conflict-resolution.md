# Phase 1 冲突分类决策详表

prod 分支合并 main（`git merge origin/main`）时的冲突处理决策。核心原则：

> **prod 独有改动几乎全是旧 timestamp 范式代码，已被 main 的 0076 timestamptz 范式取代 → 合并 content 冲突一律采 main。**

## 冲突类型与处理

### UU（content 冲突）— 全采 main

```bash
git checkout --theirs <file>   # --theirs = origin/main（被合并）侧
git add <file>
```

**理由**：prod 独有的实质改动是旧 timestamp 范式残留：
- 无时区 `timestamp("xxx")` → 应为 `timestamp("xxx", { withTimezone: true })`
- `setTypeParser(1114, ...'+08:00')` 补偿链（0076 转 timestamptz 后预期失效）
- 旧 `nowTs` / `beijingTs` 转换 helper

采 prod 会导致 schema 与 5433 生产库（已迁 0076）不一致。

### DU/UD（modify-delete）— 保持删除

prod 交付分支不保留测试代码。main 删的文件（测试 / 旧 helper），prod 也删：

```bash
git rm <file>       # main 删、prod 改 → 跟 main 删
# 或 git add <file> # 记录删除
```

### main 新增测试文件（无冲突但不该留）— git rm

合并会带入 main 新增的测试文件，交付分支不需要：

```bash
git rm -f <新增测试文件>
```

历史案例：`tz-probe-helper.ts`、`smoke-timestamp-reader.mjs`（0076 迁移期的探针测试）。

## 常见冲突文件

| 文件 | 冲突原因 |
|---|---|
| `db/schema/*.ts`（order/product/service/user/appointment…） | timestamp 范式（无时区 → withTimezone） |
| `fengyu-admin/src/lib/db-time.ts` | 旧 timestamp 补偿链 |
| `fengyu-admin/src/lib/datetime.ts` | 旧转换 helper |
| `fengyu-client/cloudfunctions/*/db/pg.js` | setTypeParser(1114) |
| `fengyu-staff/cloudfunctions/staffApi/db/pg.js` | setTypeParser(1114) |
| `fengyu-staff/cloudfunctions/payNotify/index.js` | timestamp 读取 |

## 安全闸门命令清单

合并 commit 前必须全绿：

```bash
# 1. 0076 迁移进入
ls db/migrations/0076_to_withtimezone.sql

# 2. journal 条数与 5433 生产库一致
jq '.entries | length' db/migrations/meta/_journal.json
# 对比生产库（以实际为准，历史基线 77，会随新迁移增长）：
#   psql <5433/fengyu_wxapp> -c "select count(*) from drizzle.__drizzle_migrations"

# 3. schema 范式为 withTimezone（仅剩合理例外）
grep -rn 'timestamp(' db/schema/ | grep -v 'withTimezone'

# 4. 凭据 grep 无命中（合并可能带回 main 的真值）
grep -rnE '47\.113\.202\.7|47\.96\.87\.33|fengyu123|Se[14]Qimoh|822290059430BFA|D9261078|uIj6CPg1GZAY10dXFfsEAQ|OP00000003|00dfba8194c41b84cf' \
  --include='*.ts' --include='*.js' --include='*.json' \
  db/ fengyu-admin/src/ fengyu-*/cloudfunctions/ 2>/dev/null
# 排除 .env / *.example / *.lock（占位默认值非真凭据）
```

## push refspec 陷阱

prod 分支默认跟踪 `origin/main`（历史原因）。直接 `git push` 会推到 main，**污染开发分支**。

**正确**：显式 refspec 推 prod：

```bash
git push origin prod:prod          # 推本地 prod → 远程 prod
git push -u origin prod:prod       # 首次：同时修正跟踪关系为 origin/prod
```

修正跟踪后，后续可正常 `git push`（已指向 origin/prod）。

## 合并带回的副作用

content 冲突采 main 后，**main 的完整 JS/TS 注释会跟着回来**（prod 原由历史 commit `71cfc7f4` / `6f48195a` AST 剥净）。

→ 合并后**必须重跑 Phase 2**（`strip-comments.mjs`）剥净注释，再 Phase 3 重新打包。`pack-delivery.mjs` 的 JS/TS 残留扫描（6a）会作为这一步的验证：源码剥净时报告「无残留」，否则列出漏剥文件回 Phase 2 补。
