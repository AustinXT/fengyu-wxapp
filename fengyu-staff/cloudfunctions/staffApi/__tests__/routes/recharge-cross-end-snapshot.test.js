/**
 * 跨端充值卡档位/常量一致性守护（staff 侧 vitest）
 *
 * 一致性目标：三端 RECHARGE_TIERS / RECHARGE_MIN_AMOUNT / RECHARGE_MAX_AMOUNT /
 * RECHARGE_VIRTUAL_SKU_ID + matchTier 行为字节同义：
 *   ├── fengyu-admin/src/lib/recharge.ts                          (TS, regex 提取源码)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/recharge.js    (CJS, require)
 *   └── fengyu-client/cloudfunctions/clientApi/routes/card.js     (CJS 内部 const, regex 提取源码)
 *
 * 任一端漂移 → 测试失败 → 提醒维护者三端同步。
 *
 * 来源：notes/tickets/2026-05-19-recharge-tiers-cross-end-snapshot-test.md
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

const FILES = {
  staffJs: path.resolve(__dirname, '../../utils/recharge.js'),
  adminTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/recharge.ts'),
  clientCardJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/routes/card.js'),
  clientConstantsJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/routes/_constants.js'),
}

// staff 端可直接 require（CJS 模块导出全部常量）
function loadStaffValues() {
  delete require.cache[require.resolve(FILES.staffJs)]
  const mod = require(FILES.staffJs)
  return {
    RECHARGE_TIERS: mod.RECHARGE_TIERS,
    RECHARGE_MIN_AMOUNT: mod.RECHARGE_MIN_AMOUNT,
    RECHARGE_MAX_AMOUNT: mod.RECHARGE_MAX_AMOUNT,
    RECHARGE_VIRTUAL_SKU_ID: mod.RECHARGE_VIRTUAL_SKU_ID,
    matchTier: mod.matchTier,
  }
}

/**
 * 通用：从源码字符串里提取常量定义。
 *   - extractTiers: 抓 `RECHARGE_TIERS = [...]` 的 [{ faceValue, discount }, ...] 数组
 *   - extractNumber(name): 抓 `<name> = <number>` 整数
 *   - extractString(name): 抓 `<name> = '<value>'` 字符串
 */
function extractTiers(src) {
  const match = src.match(/RECHARGE_TIERS[^=]*=\s*\[([\s\S]*?)\]/)
  if (!match) throw new Error('未找到 RECHARGE_TIERS = [...] 声明')
  const body = match[1]
  // 每个 {faceValue: N, discount: F} 抽出一对
  const entryRe = /\{\s*faceValue\s*:\s*(\d+(?:\.\d+)?)\s*,\s*discount\s*:\s*(\d+(?:\.\d+)?)\s*\}/g
  const tiers = []
  let m
  while ((m = entryRe.exec(body)) !== null) {
    tiers.push({ faceValue: Number(m[1]), discount: Number(m[2]) })
  }
  if (tiers.length === 0) throw new Error('RECHARGE_TIERS 数组解析为空')
  return tiers
}

function extractNumber(src, name) {
  const re = new RegExp(`${name}[^=]*=\\s*(\\d+(?:\\.\\d+)?)`)
  const m = src.match(re)
  if (!m) throw new Error(`未找到 ${name} = <number> 声明`)
  return Number(m[1])
}

function extractString(src, name) {
  const re = new RegExp(`${name}[^=]*=\\s*['"]([^'"]+)['"]`)
  const m = src.match(re)
  if (!m) throw new Error(`未找到 ${name} = <string> 声明`)
  return m[1]
}

function loadFromSource(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  return {
    RECHARGE_TIERS: extractTiers(src),
    RECHARGE_MIN_AMOUNT: extractNumber(src, 'RECHARGE_MIN_AMOUNT'),
    RECHARGE_MAX_AMOUNT: extractNumber(src, 'RECHARGE_MAX_AMOUNT'),
  }
}

describe('T7 — 三端充值卡档位/常量一致性守护（staff 侧）', () => {
  let staff, admin, client, clientVirtualSkuId

  beforeAll(() => {
    staff = loadStaffValues()
    admin = loadFromSource(FILES.adminTs)
    client = loadFromSource(FILES.clientCardJs)
    // client 的 RECHARGE_VIRTUAL_SKU_ID 在 _constants.js 里导出
    delete require.cache[require.resolve(FILES.clientConstantsJs)]
    clientVirtualSkuId = require(FILES.clientConstantsJs).RECHARGE_VIRTUAL_SKU_ID
    // admin 的 VIRTUAL_SKU_ID 在 recharge.ts 里
    const adminSrc = fs.readFileSync(FILES.adminTs, 'utf8')
    admin.RECHARGE_VIRTUAL_SKU_ID = extractString(adminSrc, 'RECHARGE_VIRTUAL_SKU_ID')
  })

  describe('RECHARGE_TIERS 字面一致', () => {
    test('staff vs admin', () => {
      expect(admin.RECHARGE_TIERS).toEqual(staff.RECHARGE_TIERS)
    })
    test('staff vs client', () => {
      expect(client.RECHARGE_TIERS).toEqual(staff.RECHARGE_TIERS)
    })
  })

  describe('RECHARGE_MIN_AMOUNT / MAX_AMOUNT 一致', () => {
    test('MIN — staff vs admin vs client', () => {
      expect(admin.RECHARGE_MIN_AMOUNT).toBe(staff.RECHARGE_MIN_AMOUNT)
      expect(client.RECHARGE_MIN_AMOUNT).toBe(staff.RECHARGE_MIN_AMOUNT)
    })
    test('MAX — staff vs admin vs client', () => {
      expect(admin.RECHARGE_MAX_AMOUNT).toBe(staff.RECHARGE_MAX_AMOUNT)
      expect(client.RECHARGE_MAX_AMOUNT).toBe(staff.RECHARGE_MAX_AMOUNT)
    })
  })

  describe('RECHARGE_VIRTUAL_SKU_ID 一致', () => {
    test('staff vs admin', () => {
      expect(admin.RECHARGE_VIRTUAL_SKU_ID).toBe(staff.RECHARGE_VIRTUAL_SKU_ID)
    })
    test('staff vs client (_constants.js)', () => {
      expect(clientVirtualSkuId).toBe(staff.RECHARGE_VIRTUAL_SKU_ID)
    })
    test('固定值锁定为 sku-recharge-virtual', () => {
      expect(staff.RECHARGE_VIRTUAL_SKU_ID).toBe('sku-recharge-virtual')
    })
  })

  describe('matchTier 行为基线（staff 运行时验证；admin/client 在各自端运行时同源）', () => {
    test('500 → 0.99 折 × 500 = 495', () => {
      const r = staff.matchTier(500)
      expect(r.discount).toBe(0.99)
      expect(r.payAmount).toBe(495)
    })
    test('999 → 仍走 500 档（0.99）', () => {
      const r = staff.matchTier(999)
      expect(r.discount).toBe(0.99)
      expect(r.payAmount).toBe(Math.round(999 * 0.99 * 100) / 100)
    })
    test('1000 → 0.98 折', () => {
      const r = staff.matchTier(1000)
      expect(r.discount).toBe(0.98)
      expect(r.payAmount).toBe(980)
    })
    test('5000 → 0.95 折', () => {
      const r = staff.matchTier(5000)
      expect(r.discount).toBe(0.95)
      expect(r.payAmount).toBe(4750)
    })
    test('小于 MIN 抛 INVALID_PARAMS', () => {
      expect(() => staff.matchTier(499)).toThrow(/INVALID_PARAMS/)
    })
    test('大于 MAX 抛 INVALID_PARAMS', () => {
      expect(() => staff.matchTier(100001)).toThrow(/INVALID_PARAMS/)
    })
    test('小数 > 2 位抛 INVALID_PARAMS', () => {
      expect(() => staff.matchTier(500.123)).toThrow(/INVALID_PARAMS/)
    })
  })
})
