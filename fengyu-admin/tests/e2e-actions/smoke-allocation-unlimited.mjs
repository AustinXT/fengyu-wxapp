#!/usr/bin/env bun
/** 使用现有 admin preload 注入会话与 Next.js 上下文，业务 action/数据库保持真实。 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const adminDir = path.resolve(testsDir, '..', '..')
const child = spawn(process.execPath, [
  '--preload', path.join(testsDir, '_admin-preload.mjs'),
  path.join(testsDir, 'smoke-allocation-unlimited.impl.mjs'),
], { cwd: adminDir, stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 1))
