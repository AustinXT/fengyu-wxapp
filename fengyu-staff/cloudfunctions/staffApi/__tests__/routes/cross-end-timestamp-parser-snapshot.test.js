/**
 * 跨端 PG `timestamp without time zone` (OID 1114) 读取侧一致性守护（staff 侧 vitest）。
 *
 * 配合 admin 侧 vitest
 *   `fengyu-admin/src/lib/__tests__/cross-end-timestamp-parser-snapshot.test.ts`
 * 形成对称守护。一致性目标：1114 字面按北京墙钟 (+08:00) 解析 Date，五端字面量字节同义：
 *   ├── fengyu-staff/cloudfunctions/staffApi/db/pg.js                    (CJS, setTypeParser)
 *   ├── fengyu-client/cloudfunctions/clientApi/db/pg.js                 (CJS, setTypeParser)
 *   ├── fengyu-client/cloudfunctions/payNotify/config.js                (CJS, setTypeParser)
 *   ├── fengyu-client/cloudfunctions/payNotify/index.js                 (CJS, setTypeParser)
 *   └── fengyu-admin/src/db/index.ts                                    (TS,  parseTimestamp1114 + types.beijingTimestamp)
 *
 * 任一端漂移 → 测试失败 → 提醒维护者同步另外 4 端。修复动机见 admin 侧镜像文件 header。
 *
 * 策略：直接断言每端源码字面包含同一段 canonical 表达式子串（不提取 body，避开嵌套括号
 * regex 截断坑），格式无关——只要五端都含这段精确子串即视为对齐。
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

const FILES = {
  staffJs: path.resolve(__dirname, '../../db/pg.js'),
  clientJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/db/pg.js'),
  payNotifyConfigJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/config.js'),
  payNotifyIndexJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/index.js'),
  adminTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/db/index.ts'),
}

// 五端共享的 canonical 解析表达式（含 null 短路 + 北京墙钟 +08:00 构造）。
const CANONICAL_EXPR = "val === null ? null : new Date(val.replace(' ', 'T') + '+08:00')"

function readSrc(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('audit-P0：五端 1114 timestamp reader 一致性守护（staff 侧）', () => {
  const sources = {
    staffJs: readSrc(FILES.staffJs),
    clientJs: readSrc(FILES.clientJs),
    payNotifyConfigJs: readSrc(FILES.payNotifyConfigJs),
    payNotifyIndexJs: readSrc(FILES.payNotifyIndexJs),
    adminTs: readSrc(FILES.adminTs),
  }

  describe('canonical 解析表达式（五端字节同义）', () => {
    test('staff db/pg.js', () => {
      expect(sources.staffJs).toContain(CANONICAL_EXPR)
    })
    test('client db/pg.js', () => {
      expect(sources.clientJs).toContain(CANONICAL_EXPR)
    })
    test('payNotify config.js', () => {
      expect(sources.payNotifyConfigJs).toContain(CANONICAL_EXPR)
    })
    test('payNotify index.js', () => {
      expect(sources.payNotifyIndexJs).toContain(CANONICAL_EXPR)
    })
    test('admin db/index.ts parseTimestamp1114', () => {
      expect(sources.adminTs).toContain(CANONICAL_EXPR)
    })
  })

  describe('各端 OID 锚点（防 setName 错位 / 防误删 setTypeParser 行）', () => {
    test('staff db/pg.js: setTypeParser(1114, ...)', () => {
      expect(sources.staffJs).toMatch(/setTypeParser\(\s*1114\b/)
    })
    test('client db/pg.js: setTypeParser(1114, ...)', () => {
      expect(sources.clientJs).toMatch(/setTypeParser\(\s*1114\b/)
    })
    test('payNotify config.js: setTypeParser(1114, ...)', () => {
      expect(sources.payNotifyConfigJs).toMatch(/setTypeParser\(\s*1114\b/)
    })
    test('payNotify index.js: setTypeParser(1114, ...)', () => {
      expect(sources.payNotifyIndexJs).toMatch(/setTypeParser\(\s*1114\b/)
    })
  })

  describe('admin TS 注册完整性', () => {
    test('db/index.ts 含 `parse: parseTimestamp1114`', () => {
      expect(sources.adminTs).toMatch(/parse:\s*parseTimestamp1114\s*,?/)
    })
    test('db/index.ts 含 `from: [1114]`', () => {
      expect(sources.adminTs).toMatch(/from:\s*\[1114\]/)
    })
  })

  describe('canonical 表达式单例 snapshot（任一端漂移 → 与本 snapshot 不一致）', () => {
    test('canonical 表达式文本 snapshot', () => {
      expect(CANONICAL_EXPR).toMatchSnapshot()
    })
  })
})
