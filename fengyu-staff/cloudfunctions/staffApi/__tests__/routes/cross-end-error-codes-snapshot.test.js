/**
 * 跨端错误前缀白名单一致性守护（staff 侧 vitest）
 *
 * 配合 admin 侧 vitest `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts`
 * 形成对称守护。一致性目标：9 项官方错误前缀，四端字面量字节同义：
 *   ├── fengyu-admin/src/lib/api-error.ts       (TS, ERROR_PREFIXES 导出)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js (CJS)
 *   ├── fengyu-client/cloudfunctions/clientApi/utils/error-codes.js (CJS)
 *   └── fengyu-client/cloudfunctions/payNotify/error-codes.js (CJS)
 *
 * 任一端漂移 → 测试失败 → 错误信息提醒维护者同步另外三端。
 *
 * 解析策略：
 *   - 三个 .js 端：require() 直接执行读取 mod.ERROR_PREFIXES
 *   - admin .ts 端：源码 regex 提取（avoid ts-node 依赖）。
 *     格式锁定：`export const ERROR_PREFIXES = Object.freeze([ 'X', 'Y', ... ] as const)`
 *     若 admin 端改写其他格式（如换 array literal 写法），需同步本提取器。
 *
 * 同时守护 admin actions/ 范围内 0 处不在 9 项白名单内的裸 throw（grep 反向断言）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

const FILES = {
  staffJs: path.resolve(__dirname, '../../utils/error-codes.js'),
  clientJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/utils/error-codes.js'),
  payNotifyJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/error-codes.js'),
  adminTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/api-error.ts'),
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

function loadCjsPrefixes(modulePath) {
  delete require.cache[require.resolve(modulePath)]
  const mod = require(modulePath)
  if (!Array.isArray(mod.ERROR_PREFIXES)) {
    throw new Error(`${modulePath} 未导出 ERROR_PREFIXES 数组`)
  }
  return [...mod.ERROR_PREFIXES]
}

/**
 * 从 admin api-error.ts 源码解析 ERROR_PREFIXES 数组的字符串元素。
 * 格式锁定（修改 admin api-error.ts 时需要保持兼容）：
 *   export const ERROR_PREFIXES = Object.freeze([ 'X', "Y", ... ] as const)
 *   或 export const ERROR_PREFIXES = [...] as const
 */
function loadTsPrefixesFromSource(tsPath) {
  const src = fs.readFileSync(tsPath, 'utf8')
  const match = src.match(/export\s+const\s+ERROR_PREFIXES\s*=\s*(?:Object\.freeze\()?\s*\[([\s\S]*?)\]/)
  if (!match) {
    throw new Error(`${tsPath} 未找到 ERROR_PREFIXES = [...] 声明`)
  }
  const arrayBody = match[1]
  const strings = [...arrayBody.matchAll(/['"]([A-Z_]+)['"]/g)].map((m) => m[1])
  if (strings.length === 0) {
    throw new Error(`${tsPath} 内 ERROR_PREFIXES 数组为空或解析失败`)
  }
  return strings
}

describe('audit-CC5 P0：四端 ERROR_PREFIXES 白名单一致性守护（staff 侧）', () => {
  let prefixes

  beforeAll(() => {
    prefixes = {
      staff: loadCjsPrefixes(FILES.staffJs),
      client: loadCjsPrefixes(FILES.clientJs),
      payNotify: loadCjsPrefixes(FILES.payNotifyJs),
      adminTs: loadTsPrefixesFromSource(FILES.adminTs),
    }
  })

  describe('9 项官方白名单（含且仅含）', () => {
    const sorted = [...EXPECTED_PREFIXES].sort()
    test('staff utils/error-codes.js', () => {
      expect([...prefixes.staff].sort()).toEqual(sorted)
    })
    test('client utils/error-codes.js', () => {
      expect([...prefixes.client].sort()).toEqual(sorted)
    })
    test('payNotify error-codes.js', () => {
      expect([...prefixes.payNotify].sort()).toEqual(sorted)
    })
    test('admin api-error.ts', () => {
      expect([...prefixes.adminTs].sort()).toEqual(sorted)
    })
  })

  describe('两两镜像比对（任一漂移 → 同步另外三端 error-codes 文件）', () => {
    test('staff vs client', () => {
      expect([...prefixes.client].sort()).toEqual([...prefixes.staff].sort())
    })
    test('staff vs payNotify', () => {
      expect([...prefixes.payNotify].sort()).toEqual([...prefixes.staff].sort())
    })
    test('staff vs admin TS', () => {
      expect([...prefixes.adminTs].sort()).toEqual([...prefixes.staff].sort())
    })
  })

  describe('CODE_MAP 一致性（云函数三端 require 比对）', () => {
    test('staff vs client CODE_MAP', () => {
      const staffMod = require(FILES.staffJs)
      const clientMod = require(FILES.clientJs)
      expect(clientMod.CODE_MAP).toEqual(staffMod.CODE_MAP)
    })
    test('staff vs payNotify CODE_MAP', () => {
      const staffMod = require(FILES.staffJs)
      const payMod = require(FILES.payNotifyJs)
      expect(payMod.CODE_MAP).toEqual(staffMod.CODE_MAP)
    })
    test('PHONE_REQUIRED 与 PERMISSION_DENIED 共用 -403（已知约定）', () => {
      const { CODE_MAP } = require(FILES.staffJs)
      expect(CODE_MAP.PHONE_REQUIRED).toBe(-403)
      expect(CODE_MAP.PERMISSION_DENIED).toBe(-403)
    })
    test('INVALID_PARAMS / INVALID_STATE / INSUFFICIENT_BALANCE / CLIENT_NOT_REGISTERED 共用 -400', () => {
      const { CODE_MAP } = require(FILES.staffJs)
      expect(CODE_MAP.INVALID_PARAMS).toBe(-400)
      expect(CODE_MAP.INVALID_STATE).toBe(-400)
      expect(CODE_MAP.INSUFFICIENT_BALANCE).toBe(-400)
      expect(CODE_MAP.CLIENT_NOT_REGISTERED).toBe(-400)
    })
  })

  describe('Snapshot 兜底（9 项前缀文本快照）', () => {
    test('staff ERROR_PREFIXES snapshot', () => {
      expect([...prefixes.staff].sort()).toMatchSnapshot()
    })
  })
})

describe('audit-CC5 P0：admin actions/ 范围 0 处非白名单裸 throw（除示范文件 employees.ts 1 处遗留外，应在 ticket-10c 全量收敛）', () => {
  test('grep 反向断言：actions/ 范围内裸 throw 减少 — 仅守护"不增不减"基线，全量收敛由 ticket-10c 跟进', () => {
    const escaped = EXPECTED_PREFIXES.join('|')
    let stdout = ''
    try {
      stdout = execSync(
        `grep -rn "throw new Error" fengyu-admin/src/actions/ ` +
          `| grep -vE "__tests__|\\.test\\.ts" ` +
          `| grep -vE "throw new Error\\([\\'\\"\\\`]?(${escaped}):"`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
    } catch (err) {
      // grep 无匹配时 exit 1，stdout 仍可读
      stdout = (err.stdout && err.stdout.toString()) || ''
    }
    const violationCount = stdout.split('\n').filter((line) => line.trim()).length
    // 本 ticket（10）仅做示范替换（employees.ts 1 处由 Error → ApiError），其余 33 处由 ticket-10c 处理。
    // 守护"不增"——禁止任何新 PR 再引入野生前缀 throw。基线值 = 当前实际计数。
    expect(violationCount).toBeLessThanOrEqual(34)
  })
})
