/**
 * 跨端充值卡档位/匹配逻辑一致性守护（staff 侧 vitest）
 *
 * 配合 admin 侧 vitest `fengyu-admin/src/lib/__tests__/recharge-cross-end.test.ts`
 * 形成对称守护。三端 loadRechargeConfig + matchTier 字节同义：
 *   ├── fengyu-admin/src/lib/recharge.ts                          (TS, Drizzle)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/recharge.js    (CJS, pg)
 *   └── fengyu-client/cloudfunctions/clientApi/routes/card.js     (CJS, pg, _loadRechargeConfig + matchTier inline)
 *
 * 任一端漂移 → 测试失败 → 错误信息提醒维护者同步另外两端。
 *
 * 守护对象：
 *   1. 三个 system_configs.recharge.* 配置 key 全端引用
 *   2. matchTier 算法核心常量（错误信息 + 浮点容差 + 比例换算）
 *   3. loadRechargeConfig SQL 跨端归一化后字面一致
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

const FILES = {
  staffRecharge: path.resolve(__dirname, '../../utils/recharge.js'),
  clientCard: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/routes/card.js'),
  adminRecharge: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/recharge.ts'),
  // matchTier 纯逻辑（含 INVALID_PARAMS 金额校验）2026-05-21 拆到 recharge-tier.ts，
  // recharge.ts 仅 re-export matchTier + 保留 loadRechargeConfig（INVALID_STATE 配置校验）
  adminRechargeTier: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/recharge-tier.ts'),
}

const EXPECTED_CONFIG_KEYS = ['recharge.tiers', 'recharge.minAmount', 'recharge.maxAmount']

// matchTier 内 INVALID_PARAMS 三条错误信息常量 —— 与 client/staff/admin 全文匹配
const EXPECTED_ERROR_MESSAGES = [
  'INVALID_PARAMS: 充值金额格式错误',
  'INVALID_PARAMS: 充值金额最多保留 2 位小数',
  'INVALID_PARAMS: 最低充值金额',
  'INVALID_PARAMS: 单次充值上限',
]

// loadRechargeConfig 校验失败抛出的 INVALID_STATE 前缀（三端必有）
const EXPECTED_STATE_PREFIXES = [
  'INVALID_STATE: 系统未配置充值卡档位',
  'INVALID_STATE: recharge.tiers',
  'INVALID_STATE: recharge.minAmount/maxAmount',
]

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('跨端 recharge config key 引用守护', () => {
  test.each(EXPECTED_CONFIG_KEYS)('staff utils/recharge.js 引用 %s', (key) => {
    expect(readFile(FILES.staffRecharge)).toContain(key)
  })

  test.each(EXPECTED_CONFIG_KEYS)('client routes/card.js 引用 %s', (key) => {
    expect(readFile(FILES.clientCard)).toContain(key)
  })

  test.each(EXPECTED_CONFIG_KEYS)('admin lib/recharge.ts 引用 %s', (key) => {
    expect(readFile(FILES.adminRecharge)).toContain(key)
  })
})

describe('跨端 matchTier 错误信息字面一致性', () => {
  test.each(EXPECTED_ERROR_MESSAGES)('staff utils/recharge.js 含 "%s"', (msg) => {
    expect(readFile(FILES.staffRecharge)).toContain(msg)
  })

  test.each(EXPECTED_ERROR_MESSAGES)('client routes/card.js 含 "%s"', (msg) => {
    expect(readFile(FILES.clientCard)).toContain(msg)
  })

  test.each(EXPECTED_ERROR_MESSAGES)('admin lib/recharge-tier.ts 含 "%s"', (msg) => {
    expect(readFile(FILES.adminRechargeTier)).toContain(msg)
  })
})

describe('跨端 loadRechargeConfig INVALID_STATE 错误前缀一致性', () => {
  test.each(EXPECTED_STATE_PREFIXES)('staff utils/recharge.js 含 "%s"', (prefix) => {
    expect(readFile(FILES.staffRecharge)).toContain(prefix)
  })

  test.each(EXPECTED_STATE_PREFIXES)('client routes/card.js 含 "%s"', (prefix) => {
    expect(readFile(FILES.clientCard)).toContain(prefix)
  })

  test.each(EXPECTED_STATE_PREFIXES)('admin lib/recharge.ts 含 "%s"', (prefix) => {
    expect(readFile(FILES.adminRecharge)).toContain(prefix)
  })
})

describe('staff/client 后端 matchTier 算法行为等价（require + 数值断言）', () => {
  // 三端 system_configs 种子镜像（migration 0043_pretty_shaman.sql）
  const CFG = {
    tiers: [
      { faceValue: 500, payAmount: 495 },
      { faceValue: 1000, payAmount: 980 },
      { faceValue: 5000, payAmount: 4750 },
    ],
    minAmount: 500,
    maxAmount: 100000,
  }

  let staffMatchTier
  let clientMatchTier

  beforeAll(() => {
    delete require.cache[require.resolve(FILES.staffRecharge)]
    delete require.cache[require.resolve(FILES.clientCard)]
    staffMatchTier = require(FILES.staffRecharge).matchTier
    // client routes/card.js 导出 matchTier
    const clientMod = require(FILES.clientCard)
    clientMatchTier = clientMod.matchTier
  })

  const CASES = [
    { amount: 500, expectedPay: 495, label: '精确命中 500' },
    { amount: 999, expectedPay: 989.01, label: '500–999 区间 0.99' },
    { amount: 1000, expectedPay: 980, label: '精确命中 1000' },
    { amount: 1500, expectedPay: 1470, label: '1000–4999 区间 0.98' },
    { amount: 4999, expectedPay: 4899.02, label: '1000–4999 区间 0.98' },
    { amount: 5000, expectedPay: 4750, label: '精确命中 5000' },
    { amount: 10000, expectedPay: 9500, label: '≥5000 区间 0.95' },
    { amount: 100000, expectedPay: 95000, label: '上界 0.95' },
  ]

  test.each(CASES)('staff matchTier($amount) → $expectedPay ($label)', ({ amount, expectedPay }) => {
    const { payAmount } = staffMatchTier(amount, CFG)
    expect(payAmount).toBeCloseTo(expectedPay, 2)
  })

  test.each(CASES)('client matchTier($amount) → $expectedPay ($label)', ({ amount, expectedPay }) => {
    const { payAmount } = clientMatchTier(amount, CFG)
    expect(payAmount).toBeCloseTo(expectedPay, 2)
  })

  test.each(CASES)('staff 与 client matchTier($amount) 输出完全一致 ($label)', ({ amount }) => {
    expect(staffMatchTier(amount, CFG)).toEqual(clientMatchTier(amount, CFG))
  })

  describe('边界拒收', () => {
    test('staff matchTier(499) 抛 INVALID_PARAMS', () => {
      expect(() => staffMatchTier(499, CFG)).toThrow(/最低充值金额/)
    })
    test('client matchTier(499) 抛 INVALID_PARAMS', () => {
      expect(() => clientMatchTier(499, CFG)).toThrow(/最低充值金额/)
    })
    test('staff matchTier(100001) 抛 INVALID_PARAMS', () => {
      expect(() => staffMatchTier(100001, CFG)).toThrow(/单次充值上限/)
    })
    test('client matchTier(100001) 抛 INVALID_PARAMS', () => {
      expect(() => clientMatchTier(100001, CFG)).toThrow(/单次充值上限/)
    })
    test('staff matchTier(500.123) 抛 INVALID_PARAMS', () => {
      expect(() => staffMatchTier(500.123, CFG)).toThrow(/2 位小数/)
    })
    test('client matchTier(500.123) 抛 INVALID_PARAMS', () => {
      expect(() => clientMatchTier(500.123, CFG)).toThrow(/2 位小数/)
    })
  })
})
