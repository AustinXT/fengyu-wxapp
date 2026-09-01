#!/usr/bin/env bun
/**
 * 进销存退货双链冒烟（入口 wrapper）。
 *
 * 链路（说明.md §6.2/§8 + 流程图退货支线）：
 *   院退货（门店发起，预留不扣减）→ 市场审批 → 市场退货入库（真实单价随单）
 *   市场退货（市场发起）→ 供应链审批 → 供应链退货入库
 *   + 驳回释放预留 + 不可自审 / 跨层审批负向断言
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
const IMPL = path.join(__dirname, 'smoke-inventory-returns.impl.mjs')

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
