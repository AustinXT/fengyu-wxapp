#!/usr/bin/env bun
/**
 * 进销存三级正向全链冒烟（入口 wrapper）。
 *
 * bun child-process 引导器：`bun --preload _inv-smoke-preload.mjs` 在 cwd=fengyu-admin/ 跑 impl。
 * 链路（说明.md §1-§7）：
 *   品项公司报货需求 → 供应链采购订单 → 供应链采购入库（总部备货）
 *   → 门店报货 → 市场汇总（日期过滤）→ 市场报货（福利单价-优惠=实际单价、实时库存参考、应付货款）
 *   → 采购订单 → 品项公司发货（赠送、无金额）→ 市场采购入库 → 分院配货（金额四件套）→ 院入库
 *   + 发货撤回申请/审批（§6.2）+ 价格档位/scope 负向断言（§9.4/§9.5）
 *
 * 连 5433 开发库（严禁生产库），命名空间 TE2AI，进场/退场均清理。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureInventoryE2eDb } from './helpers/inv-e2e-db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_DIR = path.resolve(__dirname, '..', '..')
const PRELOAD = path.join(__dirname, '_inv-smoke-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-inventory-chain.impl.mjs')

// 链路会写 inventory_movements（DB 级只追加），不允许在共享开发库留下不可删残留；
// 一律使用本地 docker 一次性库（helpers/inv-e2e-db.mjs，模板复制、逢跑即新）。
// 显式 env 优先于 bun 自动加载的 .env.local，避免连到 .env 残留地址。
const CONN = ensureInventoryE2eDb()

const child = spawn(process.execPath, ['--preload', PRELOAD, IMPL], {
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
