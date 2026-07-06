/**
 * 跨端 PG `timestamp without time zone` (OID 1114) 读取侧一致性守护（admin 侧 vitest）。
 *
 * 配合 staff 侧 vitest
 *   `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-timestamp-parser-snapshot.test.js`
 * 形成对称守护。test-colocation feedback：admin CI 必须自查自家文件。
 *
 * 一致性目标：1114 字面按北京墙钟 (+08:00) 解析 Date，五端字面量字节同义：
 *   ├── fengyu-staff/cloudfunctions/staffApi/db/pg.js                    (CJS, setTypeParser)
 *   ├── fengyu-client/cloudfunctions/clientApi/db/pg.js                 (CJS, setTypeParser)
 *   ├── fengyu-client/cloudfunctions/payNotify/config.js                (CJS, setTypeParser)
 *   ├── fengyu-client/cloudfunctions/payNotify/index.js                 (CJS, setTypeParser)
 *   └── fengyu-admin/src/db/index.ts                                    (TS,  parseTimestamp1114 + types.beijingTimestamp)
 *
 * 修复动机：根因 admin 读取侧（fix/003 之前仅云函数三端根治）一直靠会漂移的容器 TZ 撑着，
 * 反复复发 T+8 bug（[[project_cloudfn_pg_timestamp_tz]]）。把 5 端独立副本纳入 snapshot 守护，
 * 任一端漂移 → 测试失败 → 提醒维护者同步另外 4 端。
 *
 * 策略：直接断言每端源码字面包含同一段 canonical 表达式子串。不提取 body（避开嵌套括号
 * regex 截断坑），格式无关——只要五端都含这段精确子串即视为对齐。任一端改了 +08:00 偏移、
 * 换 replace 写法、或漏 null 短路，对应 toContain 立即失败。
 */

import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// admin/src/lib/__tests__/ → repo root 上 4 级
const REPO_ROOT = path.resolve(__dirname, '../../../..')

const FILES = {
  staffJs: path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/db/pg.js'),
  clientJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/db/pg.js'),
  payNotifyConfigJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/config.js'),
  payNotifyIndexJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/payNotify/index.js'),
  adminTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/db/index.ts'),
}

// 五端共享的 canonical 解析表达式（含 null 短路 + 北京墙钟 +08:00 构造）。
// 任一字符漂移（改偏移、换 replace、删 null 检查）都会让对应端 toContain 失败。
const CANONICAL_EXPR = "val === null ? null : new Date(val.replace(' ', 'T') + '+08:00')"

function readSrc(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

describe('audit-P0：五端 1114 timestamp reader 一致性守护（admin 侧）', () => {
  const sources = {
    staffJs: readSrc(FILES.staffJs),
    clientJs: readSrc(FILES.clientJs),
    payNotifyConfigJs: readSrc(FILES.payNotifyConfigJs),
    payNotifyIndexJs: readSrc(FILES.payNotifyIndexJs),
    adminTs: readSrc(FILES.adminTs),
  }

  describe('canonical 解析表达式（五端字节同义）', () => {
    for (const [name, src] of Object.entries(sources)) {
      test(`${name}: 含 canonical 表达式`, () => {
        expect(src).toContain(CANONICAL_EXPR)
      })
    }
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

  describe('admin TS 注册完整性（parseTimestamp1114 必须真的接上 types.beijingTimestamp.parse）', () => {
    test('db/index.ts 含 `parse: parseTimestamp1114`', () => {
      expect(sources.adminTs).toMatch(/parse:\s*parseTimestamp1114\s*,?/)
    })
    test('db/index.ts 含 `from: [1114]`（仅覆盖 timestamp without tz，不动 1184/1082）', () => {
      expect(sources.adminTs).toMatch(/from:\s*\[1114\]/)
    })
  })

  describe('canonical 表达式单例 snapshot（任一端漂移 → 与本 snapshot 不一致）', () => {
    test('canonical 表达式文本 snapshot', () => {
      expect(CANONICAL_EXPR).toMatchSnapshot()
    })
  })
})
