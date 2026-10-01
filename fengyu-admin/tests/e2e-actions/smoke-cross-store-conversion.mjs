#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const adminDir = path.resolve(dir, '../..')
const commonGitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
  cwd: adminDir, encoding: 'utf8',
}).trim()
const baseRoot = path.dirname(path.resolve(adminDir, commonGitDir))
const testDatabaseUrl = process.env.E2E_DATABASE_URL || (() => {
  const devEnv = readFileSync(path.join(baseRoot, 'envs/dev.env'), 'utf8')
  return devEnv.match(/^PG_CONNECTION_STRING=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
})()
if (!testDatabaseUrl) throw new Error('缺少测试库连接：E2E_DATABASE_URL 或 envs/dev.env')
const child = spawn(process.execPath, [
  '--preload', path.join(dir, '_admin-preload.mjs'),
  path.join(dir, 'smoke-cross-store-conversion.impl.mjs'),
], {
  cwd: adminDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_STORE_ID: 'TE2LS_STORE',
    TEST_ADMIN_EMP_ID: 'TE2LS_MGR',
    E2E_DATABASE_URL: testDatabaseUrl,
    PG_CONNECTION_STRING: testDatabaseUrl,
    DATABASE_URL: testDatabaseUrl,
  },
})
child.on('exit', (code) => process.exit(code ?? 1))
