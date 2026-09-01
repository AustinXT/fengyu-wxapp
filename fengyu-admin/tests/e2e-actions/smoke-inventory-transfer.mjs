#!/usr/bin/env bun
/**
 * 进销存调货闭环 + 自采链冒烟（入口 wrapper）。
 *
 * 链路（说明.md §4/§8.2/§10.3）：
 *   分院间调货：限同市场（跨市场拒绝）→ 出库 → 目标门店收货确认生成入库，真实单价延续
 *   市场间调货：出库归来源市场、入库归目标市场；调用端传 marketId 不能改变归属；
 *               自采 SKU 不得跨市场调出
 *   自采链：市场自采入库（仅归属市场）→ 门店报货 → 分院配货核算货款 → 门店收货
 *
 * 数据库供给同 smoke-inventory-chain：本地 docker 一次性库。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureInventoryE2eDb } from './helpers/inv-e2e-db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_DIR = path.resolve(__dirname, '..', '..')
const PRELOAD = path.join(__dirname, '_inv-smoke-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-inventory-transfer.impl.mjs')

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
