#!/usr/bin/env bun
/**
 * Phase 2D · admin 拉卡拉商户入网端到端冒烟（wrapper）
 *
 * 真正实现见 smoke-lakala-onboarding.impl.mjs；本文件只 spawn child（cwd=fengyu-admin/）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_admin-preload.mjs')
const PRELOAD_LAKALA = path.join(__dirname, '_lakala-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-lakala-onboarding.impl.mjs')

const child = spawn(
  process.execPath, // bun
  ['--preload', PRELOAD, '--preload', PRELOAD_LAKALA, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)
child.on('exit', (code) => process.exit(code ?? 1))
