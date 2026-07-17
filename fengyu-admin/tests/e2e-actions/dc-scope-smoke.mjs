#!/usr/bin/env bun
/**
 * 数据中心 scope 冒烟（入口 wrapper）。
 *
 * bun child-process 引导器：用 `bun --preload _dc-smoke-preload.mjs` 在 cwd=fengyu-admin/ 跑 impl。
 * 默认连 5433 开发库；跑 5433 线上库：
 *   DATABASE_URL='postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp' bun tests/e2e-actions/dc-scope-smoke.mjs
 *
 * 验证：4 板块真实 SQL 跑通 + scope 隔离（admin 全部 / 市场账号只见本市场 / 越权选「全部」被拒）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_DIR = path.resolve(__dirname, '..', '..')
const PRELOAD = path.join(__dirname, '_dc-smoke-preload.mjs')
const IMPL = path.join(__dirname, 'dc-scope-smoke.impl.mjs')

// 数据中心 action 链路不依赖 JWT_SECRET（直调 action，不经登录/中间件），无需注入。
const child = spawn(process.execPath, ['--preload', PRELOAD, IMPL], {
  cwd: ADMIN_DIR,
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 1))
