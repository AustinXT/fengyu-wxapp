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
 * **返回值**（负向前查 `(?<![.\w])` 实现）。
 *
 * ⚠️ 注意措辞：返回值形态之所以不在本扫描口径内，只是因为 **Next 不脱敏返回值**，
 * 展示侧无需再解一次 digest；**不等于服务端已经净化过**。服务端那一侧由下面第二个
 * describe 单独守护（评审 round 2 指出原注释把「返回值形态」笼统称作「安全」过宽）。
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

/**
 * 列 src 下的受版本控制文件，再在 JS 侧过滤。
 *
 * **不要**用 `git ls-files 'src/app/**' + '/*.tsx'` 这类 pathspec —— git 的 `**` 要求至少一个目录段，
 * `src/app/layout.tsx` 这种直接位于目录下的文件会被静默漏掉（本护栏初版就踩了，扫描面少 3 个文件）。
 */
function listFiles(predicate: (f: string) => boolean): string[] {
  const out = execFileSync('git', ['ls-files', 'src'], { cwd: ADMIN_ROOT, encoding: 'utf8' })
  const files = out.split('\n').filter(Boolean).filter((f) => !f.includes('.test.'))
  if (files.length === 0) throw new Error('git ls-files 返回空，护栏会变成 vacuous pass')
  return files.filter(predicate)
}

const listClientFiles = () =>
  listFiles((f) => (f.startsWith('src/app/') || f.startsWith('src/components/')) && f.endsWith('.tsx'))

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

/**
 * 服务端侧守护：Server Action 的**返回值** message 不得由 catch 到的异常直接派生。
 *
 * 返回值不经 Next 脱敏，`catch { return { message: err.message } }` 会把原始 PG 报错
 * （约束名 / SQL 片段）直送前端 toast —— 这是 digest 之外的第二条泄漏通道（issue #133 的
 * 双谱系评审发现，两个谱系独立指出）。本 PR 已把 11 处改走 `businessErrorMessage()`。
 *
 * ALLOWLIST 里剩下的是**刻意保留**的供应商错误透传：拉卡拉/微信返回的 errmsg 对运维定位
 * （如 40125 invalid appsecret）有实际价值，且会写进 `lastErrorMessage` 供排查。把它们一律
 * 换成中文兜底会丢掉运维信息，属产品决策而非 bug 修复，另开 issue 处理。
 */
const SERVER_RETURN_RE =
  /(?:message:\s*|(?:const|let)\s+\w*[mM]essage\w*\s*=\s*)(?:`[^`]*\$\{)?(?:(?<![.\w])(?:err|error|e|ex)(?:\s*instanceof\s+Error\s*\?\s*(?:err|error|e|ex))?(?:\s+as\s+Error\s*\)?)?\??\.message)|\$\{\w*[eE]rr(?:Data|or)?\??\.errmsg\}/

/**
 * 已核定豁免。按**代码片段**而非行号定位 —— 行号会随无关改动漂移，误报比漏报更磨人。
 *
 * 两类：
 * 1. 供应商错误透传（刻意保留）：拉卡拉 / 微信返回的 errmsg 对运维定位有实际价值
 *    （如 40125 invalid appsecret），且会写进 `lastErrorMessage` 供排查。
 *    一律换成中文兜底会丢掉运维信息，属产品决策而非 bug 修复，另开 issue。
 * 2. 已经 fail-closed（正则看得到赋值、看不到后面的守卫）。
 */
const SERVER_ALLOWLIST: readonly { file: string; snippet: string; reason: string }[] = [
  {
    file: 'src/actions/orders.ts',
    snippet: '`生成失败: ${retryErr.errcode} ${retryErr.errmsg}`',
    reason: '微信 wxacode 接口 errcode/errmsg，运维定位需要（如 40125 appsecret 配错）',
  },
  {
    file: 'src/actions/orders.ts',
    snippet: '`生成失败: ${errData.errcode} ${errData.errmsg}`',
    reason: '同上',
  },
  {
    file: 'src/actions/orders.ts',
    snippet: 'const message = err instanceof Error ? err.message : String(err)',
    reason: '已 fail-closed：紧接着 parseErrorPrefix，非白名单走「冻结在线回款金额失败」兜底',
  },
  {
    file: 'src/actions/lakala-onboarding.ts',
    snippet: 'const message = error instanceof Error ? error.message : "电子合同申请失败"',
    reason: '拉卡拉电子合同返回的拒绝原因，运维需要且会写入 lastErrorMessage',
  },
  {
    file: 'src/actions/lakala-onboarding.ts',
    snippet: 'const message = error instanceof Error ? error.message : "提交失败"',
    reason: '拉卡拉进件返回的拒绝原因，同上',
  },
]

function allowed(file: string, line: string): boolean {
  return SERVER_ALLOWLIST.some((a) => a.file === file && line.includes(a.snippet))
}

describe('issue #133 防回归：Server Action 返回值不得直接回传异常 message', () => {
  it('src/actions 下无未经 businessErrorMessage 的异常透传', () => {
    const files = listFiles((f) => f.startsWith('src/actions/') && f.endsWith('.ts'))

    const violations: string[] = []
    for (const file of files) {
      const lines = readFileSync(path.join(ADMIN_ROOT, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes('businessErrorMessage')) return
        if (!SERVER_RETURN_RE.test(line)) return
        if (allowed(file, line)) return
        violations.push(`${file}:${i + 1}  ${line.trim()}`)
      })
    }

    expect(
      violations,
      violations.length
        ? `以下 Server Action 把 catch 到的异常 message 直接放进返回值，Next 不脱敏返回值，\n` +
            `原始 PG 报错会直达用户 toast。改走 businessErrorMessage(err, '<中文兜底>')，\n` +
            `或在 SERVER_ALLOWLIST 写明豁免理由：\n` +
            violations.map((v) => `  - ${v}`).join('\n')
        : '',
    ).toEqual([])
  })

  it('豁免项仍然存在（防止 allowlist 变成过期的死条目）', () => {
    for (const entry of SERVER_ALLOWLIST) {
      const source = readFileSync(path.join(ADMIN_ROOT, entry.file), 'utf8')
      expect(
        source.includes(entry.snippet),
        `${entry.file} 已不含该片段，应从 SERVER_ALLOWLIST 移除：${entry.snippet}`,
      ).toBe(true)
    }
  })
})
