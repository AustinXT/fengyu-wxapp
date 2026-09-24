/**
 * 三端 pg date parser（OID 1082）跨端一致性守护
 *
 * 用户决策：不抽取 cloudfunctions-shared 共享代码，各端保留独立副本。
 * 背景（PR #113 审查 F7）：staffApi 曾单独新增 setTypeParser(1082, val => val)，
 * clientApi / payNotify 同源副本漏同步——clientApi 默认 parser 把 'YYYY-MM-DD'
 * 转成进程本地零点 Date，JSON 序列化成 UTC 后疗程卡有效期在小程序端偏移一天。
 * 一致性靠本 snapshot test 守护——任一端缺失或写法漂移即失败。
 *
 * 守护对象：
 *   ├── fengyu-staff/cloudfunctions/staffApi/db/pg.js
 *   ├── fengyu-client/cloudfunctions/clientApi/db/pg.js
 *   └── fengyu-client/cloudfunctions/payNotify/index.js（内联 getPg）
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  staffPgJs: path.resolve(__dirname, '../../db/pg.js'),
  clientPgJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/db/pg.js'),
  payNotifyIndexJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/payNotify/index.js'),
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('三端 pg date parser（OID 1082）跨端守护', () => {
  const sources = Object.fromEntries(
    Object.entries(FILES).map(([key, p]) => [key, readFile(p)]),
  )

  test.each(Object.keys(FILES))('%s 声明 date parser 保持 YYYY-MM-DD 文本', (key) => {
    const src = sources[key]
    expect(src).toMatch(/pg\.types\.setTypeParser\(1082,\s*\(val\)\s*=>\s*val\)/)
  })

  test.each(Object.keys(FILES))('%s 的 bigint / numeric parser 同步存在（三端同款口径）', (key) => {
    const src = sources[key]
    expect(src).toMatch(/pg\.types\.setTypeParser\(20,\s*\(val\)\s*=>\s*\(val === null \? null : parseInt\(val, 10\)\)\)/)
    expect(src).toMatch(/pg\.types\.setTypeParser\(1700,\s*\(val\)\s*=>\s*\(val === null \? null : parseFloat\(val\)\)\)/)
  })
})
