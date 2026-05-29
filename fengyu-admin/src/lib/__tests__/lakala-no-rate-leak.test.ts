import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * §0★ 费率全 admin 角色全位置不可见 — CI 守护测试（plan §10.1 第 22 项）
 *
 * 静态扫描以下文件，禁止出现任何费率字段名：
 *   - fengyu-admin/src/app/(main)/lakala-onboarding/**\/*.tsx
 *   - fengyu-admin/src/app/(main)/stores/[id]/edit/**\/*.tsx
 *   - fengyu-admin/src/components/lakala/**\/*.tsx
 *
 * 任一文件含敏感词 → 测试 fail。
 * 后端 / Server Action / lakala-redact.ts 等不在扫描范围（它们需要内部注入费率到拉卡拉 payload，
 * 但绝不能让字段名渗到任何渲染产物或 jsonb 落库未脱敏处）。
 */

// 完整大小写敏感词 + 大小写不敏感词（去除"rate"单字以避免误杀 generateRandomString 之类）
const FORBIDDEN_TOKENS: string[] = [
  'feeRate',
  'rateType',
  'rateCode',
  'merFeeRate',
  'serviceFee',
  'feeData',
  'cardFeeRate',
  'singleFeeRate',
  'costFeeRate',
  'srvFeeRate',
  'feeRatePct',
  'feeRateTypeCode',
  'feeRateTypeName',
  'feeUpperAmtPcnt',
  'feeLowerAmtPcnt',
  'feeRateStDt',
  'feeAssumeType',
  // 大写下划线变体（如 RATE_CODE / FEE_RATE）
  'FEE_RATE',
  'RATE_CODE',
  'RATE_TYPE',
]

const ROOT = resolve(__dirname, '../../..')

const SCAN_ROOTS = [
  join(ROOT, 'src/app/(main)/lakala-onboarding'),
  join(ROOT, 'src/app/(main)/stores/[id]/edit'),
  join(ROOT, 'src/components/lakala'),
]

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = join(dir, e)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) walk(p, acc)
    else if (s.isFile() && (p.endsWith('.tsx') || p.endsWith('.ts'))) acc.push(p)
  }
  return acc
}

describe('lakala 费率字段全 UI 不可见（plan §0★ + §10.1 第 22 项）', () => {
  const files = SCAN_ROOTS.flatMap((root) => walk(root))

  it('扫描范围内至少含 6 个页面 + StepProgress + stores/[id]/edit 文件（防误判 0 文件）', () => {
    // 6 个 lakala-onboarding 页面 (list / new / detail / edit / attachments / realname / logs)
    // + StepProgress.tsx + stores edit page + store-edit-page.tsx
    expect(files.length, `扫描到的 .tsx/.ts 文件过少：${JSON.stringify(files)}`).toBeGreaterThanOrEqual(7)
  })

  it.each(FORBIDDEN_TOKENS)('禁止字段名 "%s" 不出现在 lakala 相关 UI / StepProgress / stores edit 页', (token) => {
    const offenders: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(token)) {
          offenders.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: lines[i].trim() })
        }
      }
    }
    expect(
      offenders,
      `费率字段名 "${token}" 泄漏到 UI：\n${offenders.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n')}`,
    ).toEqual([])
  })

  it('lakala-onboarding 页面不出现"费率"中文分组标题（plan §0★ 删除"费率"分组）', () => {
    // 6 分组：基本 / 法人 / 经营 / 结算 / 附件 / 实名报备（不含费率）
    const offenders: Array<{ file: string; line: number; text: string }> = []
    // 仅扫描 lakala-onboarding UI；StepProgress 等组件可以提及"费率"做注释也禁止？
    // 这里只对 lakala-onboarding 子树严格 — 因为它代表表单分组渲染
    const onboardingFiles = files.filter((f) => f.includes('/lakala-onboarding/'))
    const TITLE_REGEX = /(?:CardTitle|<h1|<h2|<h3)[^>]*>.*费率/
    for (const file of onboardingFiles) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (TITLE_REGEX.test(lines[i])) {
          offenders.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: lines[i].trim() })
        }
      }
    }
    expect(
      offenders,
      `lakala-onboarding 表单出现"费率"分组标题（plan §0★ 禁止）：\n${offenders
        .map((o) => `${o.file}:${o.line}  ${o.text}`)
        .join('\n')}`,
    ).toEqual([])
  })
})
