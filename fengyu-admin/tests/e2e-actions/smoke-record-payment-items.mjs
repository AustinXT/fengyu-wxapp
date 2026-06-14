#!/usr/bin/env bun
/**
 * 多子项「选择性补卡」回款冒烟（入口 wrapper）
 *
 * 验证 C6 设计：款项记录合并为「一笔现金流动」（ref=null），子项定向（钱精确落选中卡）
 * 改由 sale_items.pending_received 承载 —— 只补 A 卡时 A 精确补满、B/C 不动。
 *
 * 实现见 smoke-record-payment-items.impl.mjs；拆两文件的理由同 smoke-record-payment.mjs
 * （admin Server Action 需 bun --preload 注入 next/cache + @/lib/auth mock，且 cwd=fengyu-admin/）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_admin-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-record-payment-items.impl.mjs')

const child = spawn(
  process.execPath,
  ['--preload', PRELOAD, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 1))
