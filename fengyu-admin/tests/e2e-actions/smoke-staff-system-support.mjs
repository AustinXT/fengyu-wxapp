#!/usr/bin/env bun
/** 使用真实 admin actions 与 PG，复用 #530 的两端一致场景。 */
import { TEST_STORE_ID, TEST_MANAGER_EMP_ID } from '../../../fengyu-staff/tests/e2e-cloudfn/setup.mjs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const testsDir = path.dirname(fileURLToPath(import.meta.url))
const child = spawn(process.execPath, ['--preload', path.join(testsDir, '_admin-preload.mjs'),
  path.join(testsDir, 'smoke-staff-system-support.impl.mjs')], {
  cwd: path.resolve(testsDir, '../..'), stdio: 'inherit', env: { ...process.env, DATABASE_URL: process.env.PG_CONNECTION_STRING, E2E_DATABASE_URL: process.env.PG_CONNECTION_STRING, TEST_STORE_ID, TEST_ADMIN_EMP_ID: TEST_MANAGER_EMP_ID },
})
child.on('exit', code => process.exit(code ?? 1))
