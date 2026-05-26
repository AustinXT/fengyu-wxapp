/**
 * 跨端 PII helper 一致性守护（staff 侧 vitest）
 *
 * 配合 admin 侧 vitest `fengyu-admin/src/lib/__tests__/pii.test.ts` 形成对称守护。
 * 一致性目标：6 个 mask 函数 + sanitizeDetail 字面行为，三端字节同义：
 *   ├── fengyu-admin/src/lib/pii.ts                              (TS, named exports)
 *   ├── fengyu-staff/cloudfunctions/staffApi/utils/pii.js        (CJS)
 *   └── fengyu-client/cloudfunctions/clientApi/utils/pii.js      (CJS)
 *
 * 任一端漂移 → 测试失败 → 错误信息提醒维护者同步另外两端。
 *
 * 解析策略：
 *   - 两个 .js 端：require() 直接调用
 *   - admin .ts 端：源码字面 grep（avoid ts-node 依赖）+ 已存在 admin pii.test.ts 自测
 *
 * fixtures 锁定 ticket §6.3 表，新增/删除函数或行为变更必须先同步三端字面。
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

const FILES = {
  staffJs: path.resolve(__dirname, '../../utils/pii.js'),
  clientJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/utils/pii.js'),
  adminTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/pii.ts'),
}

const EXPECTED_EXPORTS = [
  'maskPhone',
  'maskName',
  'maskIdCard',
  'maskEmail',
  'maskOpenid',
  'sanitizeDetail',
  'SENSITIVE_KEYS',
]

const EXPECTED_SENSITIVE_KEYS = [
  'phone', 'mobile', 'tel',
  'idCard', 'id_card', 'idNumber',
  'email',
  'openid', 'open_id',
]

/** ticket §6.3 fixture — 任一行为漂移即触发跨端 snapshot 红灯 */
const FIXTURES = [
  ['maskPhone', '13812345678', '138****5678'],
  ['maskPhone', '12345', '1***5'],
  ['maskPhone', '', ''],
  ['maskPhone', null, ''],
  ['maskName', '张三', '张*'],
  ['maskName', '王小明', '王*明'],
  ['maskName', '李四五六', '李**六'],
  ['maskName', '王', '*'],
  ['maskIdCard', '110101199001011234', '1101**********1234'],
  ['maskIdCard', '12345', '*****'],
  ['maskEmail', 'foo@bar.com', 'f*o@bar.com'],
  ['maskEmail', 'a@b.c', 'a@b.c'],
  ['maskEmail', 'ab@c.d', 'a*@c.d'],
  ['maskOpenid', 'oABC1234XYZ5678', 'oABC*******5678'],
  ['maskOpenid', 'short', '*****'],
]

function loadCjsPii(modulePath) {
  delete require.cache[require.resolve(modulePath)]
  const mod = require(modulePath)
  return mod
}

function tsHasExport(tsSource, name) {
  // 匹配 `export function name` / `export const name` / `export {... name ...}`
  const fnRe = new RegExp(`export\\s+function\\s+${name}\\b`)
  const constRe = new RegExp(`export\\s+const\\s+${name}\\b`)
  return fnRe.test(tsSource) || constRe.test(tsSource)
}

describe('audit-CC6 P0：三端 PII helper 一致性守护（staff 侧）', () => {
  let staffPii, clientPii, adminTsSource

  beforeAll(() => {
    staffPii = loadCjsPii(FILES.staffJs)
    clientPii = loadCjsPii(FILES.clientJs)
    adminTsSource = fs.readFileSync(FILES.adminTs, 'utf8')
  })

  describe('三端导出完整性', () => {
    test('staff 暴露全部 7 个符号', () => {
      for (const name of EXPECTED_EXPORTS) {
        expect(staffPii[name]).toBeDefined()
      }
    })
    test('client 暴露全部 7 个符号', () => {
      for (const name of EXPECTED_EXPORTS) {
        expect(clientPii[name]).toBeDefined()
      }
    })
    test('admin TS 源码暴露全部 7 个符号', () => {
      for (const name of EXPECTED_EXPORTS) {
        expect(tsHasExport(adminTsSource, name)).toBe(true)
      }
    })
  })

  describe('SENSITIVE_KEYS 三端一致', () => {
    test('staff SENSITIVE_KEYS 与白名单字面一致', () => {
      expect([...staffPii.SENSITIVE_KEYS].sort()).toEqual([...EXPECTED_SENSITIVE_KEYS].sort())
    })
    test('client SENSITIVE_KEYS 与白名单字面一致', () => {
      expect([...clientPii.SENSITIVE_KEYS].sort()).toEqual([...EXPECTED_SENSITIVE_KEYS].sort())
    })
    test('admin TS 源码 SENSITIVE_KEYS 含全部白名单键（字面 grep）', () => {
      for (const key of EXPECTED_SENSITIVE_KEYS) {
        expect(adminTsSource).toMatch(new RegExp(`['"]${key}['"]`))
      }
    })
  })

  describe('mask 行为 fixture（staff vs client 字面一致）', () => {
    for (const [fn, input, expected] of FIXTURES) {
      const display = input === null ? 'null' : `"${input}"`
      test(`staff ${fn}(${display}) === "${expected}"`, () => {
        expect(staffPii[fn](input)).toBe(expected)
      })
      test(`client ${fn}(${display}) === "${expected}"`, () => {
        expect(clientPii[fn](input)).toBe(expected)
      })
      test(`staff vs client ${fn}(${display}) 字面相同`, () => {
        expect(clientPii[fn](input)).toBe(staffPii[fn](input))
      })
    }
  })

  describe('sanitizeDetail 行为 — 三端一致', () => {
    const input = {
      phone: '13812345678',
      name: '张三',
      idCard: '110101199001011234',
      email: 'foo@bar.com',
      openid: 'oABC1234XYZ5678',
      amount: 100,
      changes: { phone: { from: '13800000000', to: '13912345678' } },
    }
    const expected = {
      phone: '138****5678',
      name: '张三', // name 默认不脱敏（ticket §2.7）
      idCard: '1101**********1234',
      email: 'f*o@bar.com',
      openid: 'oABC*******5678',
      amount: 100,
      changes: { phone: { from: '138****0000', to: '139****5678' } }, // 继承 phone 上下文
    }
    test('staff sanitizeDetail', () => {
      expect(staffPii.sanitizeDetail(input)).toEqual(expected)
    })
    test('client sanitizeDetail', () => {
      expect(clientPii.sanitizeDetail(input)).toEqual(expected)
    })
    test('staff vs client sanitizeDetail 字面相同', () => {
      expect(clientPii.sanitizeDetail(input)).toEqual(staffPii.sanitizeDetail(input))
    })
  })

  describe('Snapshot 兜底', () => {
    test('staff fixture 表 snapshot', () => {
      const result = FIXTURES.map(([fn, input, expected]) => ({
        fn, input, expected, staffActual: staffPii[fn](input),
      }))
      expect(result).toMatchSnapshot()
    })
  })
})
