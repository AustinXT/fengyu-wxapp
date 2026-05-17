#!/usr/bin/env bun
/**
 * smoke-cards-listing-filter — 锁死 getCardsPaginated 的基础过滤口径
 *
 * ticket: notes/tickets/2026-05-18-treatment-card-listing-filter-audit.md
 *   普查（H1/H2/H3）通过后，本测试把"为什么某些 sale_items 不会出现在 /cards"
 *   的口径用断言固化，防止后续重构悄悄改宽 / 改窄过滤。
 *
 * 入口 wrapper：bun spawn 子进程 + --preload mock 注入。impl 见同名 .impl.mjs。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_admin-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-cards-listing-filter.impl.mjs')

const child = spawn(
  process.execPath,
  ['--preload', PRELOAD, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 1))
