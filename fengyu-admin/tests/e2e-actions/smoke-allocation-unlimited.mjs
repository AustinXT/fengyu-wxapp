#!/usr/bin/env bun
/** 使用现有 admin preload 注入会话与 Next.js 上下文，业务 action/数据库保持真实。 */
import { TEST_STORE_ID, TEST_MANAGER_EMP_ID } from './setup.mjs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const adminDir = path.resolve(testsDir, '..', '..')
const child = spawn(process.execPath, [
  '--preload', path.join(testsDir, '_admin-preload.mjs'),
  path.join(testsDir, 'smoke-allocation-unlimited.impl.mjs'),
], { cwd: adminDir, stdio: 'inherit', env: { ...process.env, DATABASE_URL: process.env.PG_CONNECTION_STRING, E2E_DATABASE_URL: process.env.PG_CONNECTION_STRING, TEST_STORE_ID, TEST_ADMIN_EMP_ID: TEST_MANAGER_EMP_ID } })
child.on('exit', (code) => process.exit(code ?? 1))
