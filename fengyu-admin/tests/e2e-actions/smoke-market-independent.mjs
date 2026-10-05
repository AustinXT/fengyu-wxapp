#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureInventoryE2eDb } from './helpers/inv-e2e-db.mjs'
const dir = path.dirname(fileURLToPath(import.meta.url))
const conn = ensureInventoryE2eDb({ runDb: 'fengyu_issue531_e2e' })
const child = spawn(process.execPath, ['--preload', path.join(dir, '_inv-smoke-preload.mjs'), path.join(dir, 'smoke-market-independent.impl.mjs')], {
  cwd: path.resolve(dir, '..', '..'), stdio: 'inherit',
  env: { ...process.env, E2E_DATABASE_URL: conn, DATABASE_URL: conn, PG_CONNECTION_STRING: conn },
})
child.on('exit', (code) => process.exit(code ?? 1))
