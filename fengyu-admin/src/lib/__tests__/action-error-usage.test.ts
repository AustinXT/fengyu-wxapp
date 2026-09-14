import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * 防回归护栏：客户端展示 Server Action 错误时，禁止直接吃 catch 绑定的 `.message`。
 *
 * 背景（issue #133）：Next 生产构建把 Server Action / RSC 抛出的 `error.message` 脱敏成
 * 英文占位，业务文案只活在 `digest` 里。绕过 `actionErrorMessage()` 直接展示 `err.message`
 * 的地方，线上一律给用户看英文话术——本次一口气修了 11 处，但**没有任何机制阻止第 12 处出现**
 * （pr-ready sibling 审查的 P1）。故用本用例把这个形态钉死。
 *
 * ## 判定口径
 *
 * 只盯「catch 绑定名（err / error / e / ex）**直接**取 .message，且作为用户可见展示函数的入参」。
 * 刻意**不**匹配 `res.error.message` / `data.error.message` 这类——它们取自 Server Action 的
 * **返回值**，Next 不脱敏返回值，是安全且被广泛使用的形态（负向前查 `(?<![.\w])` 实现）。
 *
 * 这是 best-effort tripwire 不是证明：新写法（如先赋给中间变量再展示）躲得过。
 * 命中即人工判断——要么改走 `actionErrorMessage()`，要么在 ALLOWLIST 里写明豁免理由。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_ROOT = path.resolve(HERE, '../../..')

/** 用户可见的展示入口。 */
const SINKS = ['toast.error', 'toast.success', 'toast.warning', 'alert', 'setError', 'setMessage']

/**
 * catch 绑定名直接取 message：`err.message` / `e?.message` / `(err as Error).message`。
 * `(?<![.\w])` 挡掉 `res.error.message` —— 前面有 `.` 说明它是某个返回值对象的字段，安全。
 */
const CATCH_MESSAGE_RE = /(?<![.\w])(?:err|error|e|ex)\s*(?:as\s+Error\s*\)?\s*)?\??\.message/

/** 已核定豁免：`path:line` → 理由。留空数组即「零豁免」。 */
const ALLOWLIST: Record<string, string> = {}

function listClientFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', 'src/app/**/*.tsx', 'src/components/**/*.tsx'],
    { cwd: ADMIN_ROOT, encoding: 'utf8' },
  )
  return out.split('\n').filter(Boolean).filter((f) => !f.includes('.test.'))
}

describe('issue #133 防回归：客户端不得直接展示 catch 到的 err.message', () => {
  it('src/app 与 src/components 下无绕过 actionErrorMessage 的展示点', () => {
    const violations: string[] = []

    for (const file of listClientFiles()) {
      const lines = readFileSync(path.join(ADMIN_ROOT, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!SINKS.some((sink) => line.includes(`${sink}(`))) return
        if (line.includes('actionErrorMessage')) return
        if (!CATCH_MESSAGE_RE.test(line)) return
        const location = `${file}:${i + 1}`
        if (location in ALLOWLIST) return
        violations.push(`${location}  ${line.trim()}`)
      })
    }

    expect(
      violations,
      violations.length
        ? `以下展示点直接吃了 catch 到的 .message，生产构建下用户会看到英文脱敏话术。\n` +
            `改走 actionErrorMessage(err, '<业务兜底文案>')，或在本文件 ALLOWLIST 写明豁免理由：\n` +
            violations.map((v) => `  - ${v}`).join('\n')
        : '',
    ).toEqual([])
  })

  it('判定口径自检：返回值形态不误报、catch 形态不漏报', () => {
    // 安全形态（Server Action 返回值，Next 不脱敏）——必须不命中
    expect(CATCH_MESSAGE_RE.test('toast.error(res.error.message)')).toBe(false)
    expect(CATCH_MESSAGE_RE.test('toast.error(data.error.message)')).toBe(false)
    expect(CATCH_MESSAGE_RE.test('toast.error(res.message)')).toBe(false)
    // 危险形态——必须命中
    expect(CATCH_MESSAGE_RE.test('toast.error(err.message)')).toBe(true)
    expect(CATCH_MESSAGE_RE.test('toast.error(e?.message || "失败")')).toBe(true)
    expect(CATCH_MESSAGE_RE.test('alert((err as Error).message)')).toBe(true)
    expect(CATCH_MESSAGE_RE.test('setError(error.message)')).toBe(true)
  })
})
