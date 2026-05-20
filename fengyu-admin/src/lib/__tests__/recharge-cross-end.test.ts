/**
 * 跨端充值卡档位/匹配逻辑一致性守护（admin 侧 vitest）
 *
 * 配合 staff 侧 vitest
 * `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-recharge-snapshot.test.js`
 * 形成对称守护（test-colocation feedback：admin CI 必须自查自家文件）。
 *
 * 一致性目标：三端 loadRechargeConfig + matchTier 字节同义：
 *   ├── fengyu-admin/src/lib/recharge.ts                          (TS, Drizzle)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/recharge.js    (CJS, pg)
 *   └── fengyu-client/cloudfunctions/clientApi/routes/card.js     (CJS, pg, _loadRechargeConfig + matchTier inline)
 *
 * 任一端漂移 → 测试失败 → 错误信息提醒维护者同步另外两端。
 */

import { describe, test, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { matchTier as adminMatchTier, type RechargeConfig } from '@/lib/recharge'

const requireFromHere = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// admin/src/lib/__tests__/ → repo root 上 4 级
const REPO_ROOT = path.resolve(__dirname, '../../../..')

const FILES = {
  adminRecharge: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/recharge.ts'),
  staffRecharge: path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/utils/recharge.js'),
  clientCard: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/routes/card.js'),
}

const EXPECTED_CONFIG_KEYS = ['recharge.tiers', 'recharge.minAmount', 'recharge.maxAmount']

const EXPECTED_ERROR_MESSAGES = [
  'INVALID_PARAMS: 充值金额格式错误',
  'INVALID_PARAMS: 充值金额最多保留 2 位小数',
  'INVALID_PARAMS: 最低充值金额',
  'INVALID_PARAMS: 单次充值上限',
]

const EXPECTED_STATE_PREFIXES = [
  'INVALID_STATE: 系统未配置充值卡档位',
  'INVALID_STATE: recharge.tiers',
  'INVALID_STATE: recharge.minAmount/maxAmount',
]

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

describe('跨端 recharge config key 引用守护', () => {
  test.each(EXPECTED_CONFIG_KEYS)('admin lib/recharge.ts 引用 "%s"', (key) => {
    expect(readFile(FILES.adminRecharge)).toContain(key)
  })

  test.each(EXPECTED_CONFIG_KEYS)('staff utils/recharge.js 引用 "%s"', (key) => {
    expect(readFile(FILES.staffRecharge)).toContain(key)
  })

  test.each(EXPECTED_CONFIG_KEYS)('client routes/card.js 引用 "%s"', (key) => {
    expect(readFile(FILES.clientCard)).toContain(key)
  })
})

describe('跨端 matchTier 错误信息字面一致性', () => {
  test.each(EXPECTED_ERROR_MESSAGES)('admin lib/recharge.ts 含 "%s"', (msg) => {
    expect(readFile(FILES.adminRecharge)).toContain(msg)
  })

  test.each(EXPECTED_ERROR_MESSAGES)('staff utils/recharge.js 含 "%s"', (msg) => {
    expect(readFile(FILES.staffRecharge)).toContain(msg)
  })

  test.each(EXPECTED_ERROR_MESSAGES)('client routes/card.js 含 "%s"', (msg) => {
    expect(readFile(FILES.clientCard)).toContain(msg)
  })
})

describe('跨端 loadRechargeConfig INVALID_STATE 错误前缀一致性', () => {
  test.each(EXPECTED_STATE_PREFIXES)('admin lib/recharge.ts 含 "%s"', (prefix) => {
    expect(readFile(FILES.adminRecharge)).toContain(prefix)
  })

  test.each(EXPECTED_STATE_PREFIXES)('staff utils/recharge.js 含 "%s"', (prefix) => {
    expect(readFile(FILES.staffRecharge)).toContain(prefix)
  })

  test.each(EXPECTED_STATE_PREFIXES)('client routes/card.js 含 "%s"', (prefix) => {
    expect(readFile(FILES.clientCard)).toContain(prefix)
  })
})

describe('admin/staff/client matchTier 行为等价（require + 数值断言）', () => {
  // 三端 system_configs 种子镜像（migration 0043_pretty_shaman.sql）
  const CFG: RechargeConfig = {
    tiers: [
      { faceValue: 500, payAmount: 495 },
      { faceValue: 1000, payAmount: 980 },
      { faceValue: 5000, payAmount: 4750 },
    ],
    minAmount: 500,
    maxAmount: 100000,
  }

  type Matcher = (amount: number, cfg: RechargeConfig) => { discount: number; payAmount: number }

  let staffMatchTier: Matcher
  let clientMatchTier: Matcher

  beforeAll(() => {
    const staffMod = requireFromHere(FILES.staffRecharge)
    const clientMod = requireFromHere(FILES.clientCard)
    staffMatchTier = staffMod.matchTier
    clientMatchTier = clientMod.matchTier
  })

  const CASES = [
    { amount: 500, expectedPay: 495 },
    { amount: 999, expectedPay: 989.01 },
    { amount: 1000, expectedPay: 980 },
    { amount: 1500, expectedPay: 1470 },
    { amount: 4999, expectedPay: 4899.02 },
    { amount: 5000, expectedPay: 4750 },
    { amount: 10000, expectedPay: 9500 },
    { amount: 100000, expectedPay: 95000 },
  ]

  test.each(CASES)('admin matchTier($amount) → $expectedPay', ({ amount, expectedPay }) => {
    expect(adminMatchTier(amount, CFG).payAmount).toBeCloseTo(expectedPay, 2)
  })

  test.each(CASES)('三端 matchTier($amount) 输出完全一致', ({ amount }) => {
    const a = adminMatchTier(amount, CFG)
    const s = staffMatchTier(amount, CFG)
    const c = clientMatchTier(amount, CFG)
    expect(s).toEqual(a)
    expect(c).toEqual(a)
  })

  describe('边界拒收三端同步', () => {
    test('amount=499 三端均抛"最低充值金额"', () => {
      expect(() => adminMatchTier(499, CFG)).toThrow(/最低充值金额/)
      expect(() => staffMatchTier(499, CFG)).toThrow(/最低充值金额/)
      expect(() => clientMatchTier(499, CFG)).toThrow(/最低充值金额/)
    })
    test('amount=100001 三端均抛"单次充值上限"', () => {
      expect(() => adminMatchTier(100001, CFG)).toThrow(/单次充值上限/)
      expect(() => staffMatchTier(100001, CFG)).toThrow(/单次充值上限/)
      expect(() => clientMatchTier(100001, CFG)).toThrow(/单次充值上限/)
    })
    test('amount=500.123 三端均抛"2 位小数"', () => {
      expect(() => adminMatchTier(500.123, CFG)).toThrow(/2 位小数/)
      expect(() => staffMatchTier(500.123, CFG)).toThrow(/2 位小数/)
      expect(() => clientMatchTier(500.123, CFG)).toThrow(/2 位小数/)
    })
  })
})
