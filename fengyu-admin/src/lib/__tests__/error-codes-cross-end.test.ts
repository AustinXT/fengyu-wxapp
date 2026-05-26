/**
 * 跨端错误前缀白名单一致性守护（admin 侧 vitest）
 *
 * 配合 staff 侧 vitest
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`
 * 形成对称守护（test-colocation feedback：admin CI 必须自查自家文件）。
 *
 * 一致性目标：9 项官方错误前缀，四端字面量字节同义：
 *   ├── fengyu-admin/src/lib/api-error.ts       (TS, ERROR_PREFIXES 导出)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js (CJS)
 *   ├── fengyu-client/cloudfunctions/clientApi/utils/error-codes.js (CJS)
 *   └── fengyu-client/cloudfunctions/payNotify/error-codes.js (CJS)
 *
 * 任一端漂移 → 测试失败 → 错误信息提醒维护者同步另外三端。
 *
 * 解析策略：
 *   - admin TS：直接 import('@/lib/api-error') 取 ERROR_PREFIXES
 *   - 云函数 CJS：createRequire 加载 .js 取 mod.ERROR_PREFIXES
 */

import { describe, test, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const requireFromHere = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// admin/src/lib/__tests__/ → repo root 上 4 级
const REPO_ROOT = path.resolve(__dirname, '../../../..')

const FILES = {
  staffJs: path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js'),
  clientJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/utils/error-codes.js'),
  payNotifyJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/error-codes.js'),
}

const EXPECTED_PREFIXES = [
  'UNAUTHORIZED',
  'PHONE_REQUIRED',
  'INVALID_PARAMS',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'CONFLICT',
  'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
]

function loadCjsPrefixes(p: string): string[] {
  delete requireFromHere.cache[requireFromHere.resolve(p)]
  const mod = requireFromHere(p) as { ERROR_PREFIXES: readonly string[] }
  return [...mod.ERROR_PREFIXES]
}

describe('audit-CC5 P0：四端 ERROR_PREFIXES 白名单一致性守护（admin 侧）', () => {
  let prefixes: Record<'adminTs' | 'staff' | 'client' | 'payNotify', string[]>

  beforeAll(async () => {
    const adminMod = await import('@/lib/api-error')
    prefixes = {
      adminTs: [...adminMod.ERROR_PREFIXES],
      staff: loadCjsPrefixes(FILES.staffJs),
      client: loadCjsPrefixes(FILES.clientJs),
      payNotify: loadCjsPrefixes(FILES.payNotifyJs),
    }
  })

  describe('9 项官方白名单（含且仅含）', () => {
    const sorted = [...EXPECTED_PREFIXES].sort()
    test('admin lib/api-error.ts', () => {
      expect([...prefixes.adminTs].sort()).toEqual(sorted)
    })
    test('staff utils/error-codes.js', () => {
      expect([...prefixes.staff].sort()).toEqual(sorted)
    })
    test('client utils/error-codes.js', () => {
      expect([...prefixes.client].sort()).toEqual(sorted)
    })
    test('payNotify error-codes.js', () => {
      expect([...prefixes.payNotify].sort()).toEqual(sorted)
    })
  })

  describe('admin TS vs 三端云函数 CJS（任一漂移 → 同步另外三端）', () => {
    test('admin TS == staff JS', () => {
      expect([...prefixes.adminTs].sort()).toEqual([...prefixes.staff].sort())
    })
    test('admin TS == client JS', () => {
      expect([...prefixes.adminTs].sort()).toEqual([...prefixes.client].sort())
    })
    test('admin TS == payNotify JS', () => {
      expect([...prefixes.adminTs].sort()).toEqual([...prefixes.payNotify].sort())
    })
  })

  describe('CODE_MAP 一致性（admin TS vs 三端 CJS）', () => {
    test('admin CODE_MAP 与 staff/client/payNotify 完全一致', async () => {
      const adminMod = await import('@/lib/api-error')
      const staffMod = requireFromHere(FILES.staffJs) as { CODE_MAP: Record<string, number> }
      const clientMod = requireFromHere(FILES.clientJs) as { CODE_MAP: Record<string, number> }
      const payMod = requireFromHere(FILES.payNotifyJs) as { CODE_MAP: Record<string, number> }
      // 解 ReadonlyRecord，比较普通对象
      const adminMap = { ...adminMod.CODE_MAP }
      expect({ ...staffMod.CODE_MAP }).toEqual(adminMap)
      expect({ ...clientMod.CODE_MAP }).toEqual(adminMap)
      expect({ ...payMod.CODE_MAP }).toEqual(adminMap)
    })
    test('PHONE_REQUIRED 与 PERMISSION_DENIED 共用 -403（已知约定）', async () => {
      const { CODE_MAP } = await import('@/lib/api-error')
      expect(CODE_MAP.PHONE_REQUIRED).toBe(-403)
      expect(CODE_MAP.PERMISSION_DENIED).toBe(-403)
    })
  })

  describe('ApiError class + runWithApiResponse HOF 基础行为', () => {
    test('ApiError 实例化保留 prefix/message/data', async () => {
      const { ApiError } = await import('@/lib/api-error')
      const err = new ApiError('INVALID_PARAMS', '缺 id', { hint: 'x' })
      expect(err.name).toBe('ApiError')
      expect(err.prefix).toBe('INVALID_PARAMS')
      expect(err.message).toBe('INVALID_PARAMS: 缺 id')
      expect(err.data).toEqual({ hint: 'x' })
    })
    test('runWithApiResponse 成功路径返回 {success:true, data}', async () => {
      const { runWithApiResponse } = await import('@/lib/api-error')
      const res = await runWithApiResponse('test', async () => 42)
      expect(res).toEqual({ success: true, data: 42 })
    })
    test('runWithApiResponse 失败路径返回 {success:false, code, errorType, message}', async () => {
      const { runWithApiResponse, ApiError } = await import('@/lib/api-error')
      const res = await runWithApiResponse('test', async () => {
        throw new ApiError('NOT_FOUND', '订单不存在')
      })
      expect(res).toMatchObject({
        success: false,
        code: -404,
        errorType: 'NOT_FOUND',
        message: '订单不存在',
      })
    })
    test('runWithApiResponse 非白名单前缀降级为 {-1, null, 服务器内部错误}', async () => {
      const { runWithApiResponse } = await import('@/lib/api-error')
      const res = await runWithApiResponse('test', async () => {
        throw new Error('CARD_NOT_FOUND: 充值卡不存在')
      })
      expect(res).toMatchObject({
        success: false,
        code: -1,
        errorType: null,
        message: '服务器内部错误',
      })
    })
    test('runWithApiResponse 二级前缀语法（一级解析 + 子标签随 message 透出）', async () => {
      const { runWithApiResponse } = await import('@/lib/api-error')
      const res = await runWithApiResponse('test', async () => {
        throw new Error('INVALID_STATE: STATE_TRANSITION_BLOCKED: 订单状态已被其他操作变更')
      })
      expect(res).toMatchObject({
        success: false,
        code: -400,
        errorType: 'INVALID_STATE',
        message: 'STATE_TRANSITION_BLOCKED: 订单状态已被其他操作变更',
      })
    })
  })
})
