#!/usr/bin/env bun
/**
 * confirmOfflinePayment 部分确认链路端到端冒烟（入口 wrapper）。
 *
 * 实现在 smoke-confirm-offline-partial.impl.mjs；本 wrapper 负责用 bun --preload 注入
 * next/cache + @/lib/auth + @/lib/permissions mock，并以 cwd=fengyu-admin/ 启动子进程。
 *
 * 用法：bun fengyu-admin/tests/e2e-actions/smoke-confirm-offline-partial.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_admin-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-confirm-offline-partial.impl.mjs')

const child = spawn(
  process.execPath,
  ['--preload', PRELOAD, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 1))
