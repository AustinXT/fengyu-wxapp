#!/usr/bin/env bun
/**
 * admin legacy-orders 端到端冒烟（入口 wrapper）
 *
 * 守护 2026-06 修复的 postgres.js driver 三类 bug：
 *   - Bug A：CAS 用 Date 对象 → timestamptz 时区偏移 → approve 永久 CONFLICT
 *   - Bug B：用了 postgres.js 不存在的 .rowCount（应 .count）→ reject/改金额/改手机号
 *            永久 CONFLICT、import inserted 计数恒 0
 *
 * 现有 legacy-orders.test.ts 用 vi.mock('@/db') 完全 mock 掉 db，无法暴露 driver
 * 级行为；本 smoke 连真 PG（与生产同库的 5434），是唯一能拦住这类回归的测试层。
 *
 * 真正实现见 smoke-legacy-orders.impl.mjs；本文件仅 spawn child（bun --preload）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_legacy-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-legacy-orders.impl.mjs')

const child = spawn(
  process.execPath,
  ['--preload', PRELOAD, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 1))
