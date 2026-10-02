#!/usr/bin/env bun
/**
 * 日常数据一览表（#369）业绩拆分真库冒烟（入口 wrapper）：cwd 切到 fengyu-admin/ 让 @ 路径解析生效，
 * 真正的实现在 smoke-daily-overview-split.impl.mjs。
 *
 * 用法：
 *   bun fengyu-admin/tests/e2e-actions/smoke-daily-overview-split.mjs              # 默认 dev 库、2026-08
 *   START=2026-09-01 END=2026-09-24 bun fengyu-admin/tests/e2e-actions/smoke-daily-overview-split.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_DIR = path.resolve(__dirname, '..', '..')
const IMPL = path.join(__dirname, 'smoke-daily-overview-split.impl.mjs')

const child = spawn(process.execPath, [IMPL], { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 1))
