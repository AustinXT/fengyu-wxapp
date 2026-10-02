#!/usr/bin/env bun
/**
 * `src/lib/org-ancestry.ts` 两条递归 CTE 的真库语义冒烟（入口 wrapper）。
 *
 * ## 为什么必须有这个
 *
 * #259 的「最近门店祖先」与 #249 的「旧店子树上的角色绑定」是这两个 issue 的**全部**判据，
 * 而 `employees.test.ts` 把它们所在的模块整个 mock 掉了 —— 单测只能锁 action 的分支逻辑，
 * 锁不住 SQL 自己。第 4 轮两个评审谱系各自独立指出：把递归退化成单表查询、把子树匹配退化成
 * 精确匹配、删掉 path 防环，全套单测照样绿。
 *
 * 更要紧的是，纯 SQL **文本**断言也挡不住「结构对、语义错」：把
 * `JOIN chain c ON o.id = c.parent_id` 写反成 `o.parent_id = c.id`，上溯就变下探，
 * 而 `WITH RECURSIVE` / `UNION ALL` / `parent_id` 一个关键词都不少。只有真 PG 能分辨。
 *
 * 用法（容器不在会自动拉起，模板库与进销存冒烟共用）：
 *   bun fengyu-admin/tests/e2e-actions/smoke-org-ancestry.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureInventoryE2eDb } from './helpers/inv-e2e-db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_DIR = path.resolve(__dirname, '..', '..')
const IMPL = path.join(__dirname, 'smoke-org-ancestry.impl.mjs')

/**
 * 独立运行库：`ensureInventoryE2eDb` 每次调用都 `DROP … WITH (FORCE)` 再从模板重建，
 * 与进销存冒烟共用一个运行库时会互相踢掉连接。容器与模板库仍然共用。
 */
const CONN = ensureInventoryE2eDb({ runDb: 'fengyu_org_ancestry_e2e' })

const child = spawn(process.execPath, [IMPL], {
  cwd: ADMIN_DIR,
  stdio: 'inherit',
  env: {
    ...process.env,
    E2E_DATABASE_URL: CONN,
    DATABASE_URL: CONN,
    PG_CONNECTION_STRING: CONN,
  },
})
child.on('exit', (code) => process.exit(code ?? 1))
