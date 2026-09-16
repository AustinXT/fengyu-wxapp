/**
 * staff 前端 maskPhone ↔ staffApi/utils/pii.js 一致性守护（#159）
 *
 * 背景：仓库已有一份权威 PII helper `cloudfunctions/staffApi/utils/pii.js`，与 clientApi、admin
 * 三端由 `staffApi/__tests__/routes/cross-end-pii-snapshot.test.js` 字面守护。但那份守护的清单是
 * **硬编码的 3 个文件**，不含任何 miniprogram 前端——新增前端副本既不提示也不报错。
 *
 * #159 给 staff 前端加 `utils/formatters.ts` 的 maskPhone 时就差点踩进去：照抄了
 * `fengyu-client/miniprogram/utils/format.ts` 那份游离的弱实现（`length < 7` 单守卫），
 * 会对 7~10 位号拼出比原值更长的假号、对 ≤6 位号完全不脱敏。
 *
 * 本文件把 staff 前端副本绑回权威实现，两道守护：
 *   ① **函数体字面比对**（归一化空白/注释后）—— 任何一侧改了实现即红，这才是「字面一致」
 *   ② 同一组 fixture + 0~15 位穷举的行为双向断言 —— 兜住字面相同但语义被外部依赖改变的情况
 *
 * 这不违反「禁止跨端共享代码目录」——运行时仍是各自独立副本，这里只是测试读取对方源码做一致性
 * 校验，与 cross-end-pii-snapshot.test.js 的做法相同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { maskPhone } from '../../utils/formatters'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pii = require('../../../cloudfunctions/staffApi/utils/pii.js') as {
  maskPhone: (v: unknown) => string
}

const PII_JS_PATH = path.resolve(__dirname, '../../../cloudfunctions/staffApi/utils/pii.js')
const FORMATTERS_TS_PATH = path.resolve(__dirname, '../../utils/formatters.ts')

/**
 * 抠出 `function maskPhone(...)` 的函数体并归一化（去注释、压空白）。
 * 两端签名不同（TS 带类型注解、CJS 不带），但函数体必须逐字符相同。
 */
function normalizedBody(filePath: string): string {
  const src = fs.readFileSync(filePath, 'utf8')
  const m = src.match(/function maskPhone\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)
  if (!m) throw new Error(`没在 ${filePath} 里找到 maskPhone 的函数体`)
  return m[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 与 cross-end-pii-snapshot.test.js 的 FIXTURES 中 maskPhone 行同源 */
const FIXTURES: Array<[string, string]> = [
  ['13812345678', '138****5678'],
  ['12345', '1***5'],
  ['', ''],
]

describe('staff 前端 maskPhone 与 staffApi/utils/pii.js 字面一致', () => {
  test('函数体逐字一致（归一化空白与注释后）—— 行为 fixture 挡不住未覆盖输入上的漂移', () => {
    const authoritative = normalizedBody(PII_JS_PATH)
    expect(normalizedBody(FORMATTERS_TS_PATH)).toBe(authoritative)
    // 防呆：正则抠错位置会得到空串，那样上面的断言会假绿
    expect(authoritative).toContain("'*'.repeat")
    expect(authoritative.length).toBeGreaterThan(80)
  })

  test.each(FIXTURES)('maskPhone(%j) === %j（两端同值）', (input, expected) => {
    expect(maskPhone(input)).toBe(expected)
    expect(pii.maskPhone(input)).toBe(expected)
  })

  test('null / undefined 两端都归一为空串（不是原样吐回）', () => {
    expect(maskPhone(null as unknown as string)).toBe('')
    expect(maskPhone(undefined as unknown as string)).toBe('')
    expect(pii.maskPhone(null)).toBe('')
    expect(pii.maskPhone(undefined)).toBe('')
  })

  test('≤7 位走「首尾各留一位」分支，不再拼出尾 4 位重复露出的假号', () => {
    // client 弱实现会把 7 位的 8812345 变成 881****2345（11 字符、尾 4 位既称被遮又完整露出）
    expect(maskPhone('8812345')).toBe('8*****5')
    expect(maskPhone('8812345')).toHaveLength(7)
    expect(maskPhone('8812345')).toBe(pii.maskPhone('8812345'))
  })

  test('8~10 位与权威实现同值（该区间 pii.js 本身也会补齐到 11 位，两端一致即可）', () => {
    for (const raw of ['12345678', '0532888888']) {
      expect(maskPhone(raw)).toBe(pii.maskPhone(raw))
    }
    expect(maskPhone('0532888888')).toBe('053****8888')
  })

  test('≤6 位脏号也必须脱敏，不能原样全显', () => {
    expect(maskPhone('1234')).toBe('****')
    expect(maskPhone('123456')).toBe('1****6')
    expect(maskPhone('1234')).toBe(pii.maskPhone('1234'))
    expect(maskPhone('123456')).toBe(pii.maskPhone('123456'))
  })

  test('两端对随机长度输入逐一同值（防单点 fixture 漏网）', () => {
    for (let len = 0; len <= 15; len++) {
      const raw = '1'.repeat(len)
      expect(maskPhone(raw)).toBe(pii.maskPhone(raw))
    }
  })
})
