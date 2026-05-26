#!/usr/bin/env bun
/**
 * createRefund 退款额封顶（防部分支付超退）端到端冒烟（入口 wrapper）。
 *
 * 实现在 smoke-refund-cap.impl.mjs；本 wrapper 用 bun --preload 注入 mock，cwd=fengyu-admin/。
 *
 * 用法：bun fengyu-admin/tests/e2e-actions/smoke-refund-cap.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_admin-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-refund-cap.impl.mjs')

const child = spawn(
  process.execPath,
  ['--preload', PRELOAD, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 1))
