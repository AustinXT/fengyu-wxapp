#!/usr/bin/env bun
/**
 * P0-15-01 admin recordPayment 端到端冒烟（入口 wrapper）
 *
 * 这是一个 bun child-process 引导器。真正的实现在 smoke-record-payment.impl.mjs；
 * 之所以拆两个文件，是因为：
 *   - admin 的 Server Action（'use server'）依赖 next/cache.revalidatePath、
 *     @/lib/auth.getSession、@/lib/permissions.requirePermission 等 Next.js 上下文
 *   - 这些必须通过 bun --preload 提前 Bun.plugin().module() 注入 mock 才能拦截 import
 *   - 同时需要 cwd = fengyu-admin/ 才能让 tsconfig 的 @ / @db 路径解析生效
 *
 * 父进程仅负责：
 *   1. spawn child（bun --preload <预热> --cwd <admin/> <impl>）
 *   2. 透传 stdout/stderr
 *   3. 透传 exit code
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ADMIN_DIR = path.join(REPO_ROOT, 'fengyu-admin')
const PRELOAD = path.join(__dirname, '_admin-preload.mjs')
const IMPL = path.join(__dirname, 'smoke-record-payment.impl.mjs')

const child = spawn(
  process.execPath, // 当前 bun 可执行
  ['--preload', PRELOAD, IMPL],
  { cwd: ADMIN_DIR, stdio: 'inherit', env: process.env },
)

child.on('exit', (code) => process.exit(code ?? 1))
