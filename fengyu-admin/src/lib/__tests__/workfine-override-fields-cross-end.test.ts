/**
 * F7 WorkFine 覆盖白名单 MAP 跨端一致守护（admin 侧）。
 *
 * staff 侧同构副本：
 * fengyu-staff/cloudfunctions/staffApi/__tests__/routes/workfine-override-fields-cross-end.test.js
 * 改一端必须同步另一端。
 */

import { describe, test, expect } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const adminCustomersSrc = readFileSync(
  path.resolve(REPO_ROOT, 'fengyu-admin/src/actions/customers.ts'),
  'utf-8',
)
const staffCustomerSrc = readFileSync(
  path.resolve(REPO_ROOT, 'fengyu-staff/cloudfunctions/staffApi/routes/customer.js'),
  'utf-8',
)
const clientAuthSrc = readFileSync(
  path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/routes/auth.js'),
  'utf-8',
)

function extractFieldMap(src: string, name: string) {
  const block = src.match(new RegExp('const ' + name + ' = \\{([\\s\\S]*?)\\}'))
  if (!block) throw new Error('未找到 ' + name)
  return [...block[1].matchAll(/(\w+)\s*:\s*'([a-z_]+)'/g)].map((m) => [m[1], m[2]])
}

const adminMap = extractFieldMap(adminCustomersSrc, 'WORKFINE_OVERRIDE_FIELD_MAP')
const staffMap = extractFieldMap(staffCustomerSrc, 'WORKFINE_PROFILE_FIELD_MAP')
const clientInline = [...clientAuthSrc.matchAll(/ARRAY\['([a-z_]+)'\]/g)].map((m) => m[1])

describe('F7 WorkFine 覆盖白名单 MAP 跨端一致守护（admin 侧）', () => {
  test('admin WORKFINE_OVERRIDE_FIELD_MAP 含且仅含 6 项白名单', () => {
    expect(adminMap).toEqual([
      ['customerSource', 'customer_source'],
      ['birthday', 'birthday'],
      ['occupation', 'occupation'],
      ['isMarried', 'is_married'],
      ['skinIssue', 'skin_issue'],
      ['wellnessPreference', 'wellness_preference'],
    ])
  })

  test('staff WORKFINE_PROFILE_FIELD_MAP 与 admin MAP 键值逐项一致', () => {
    expect(staffMap).toEqual(adminMap)
  })

  test('client auth.js 内联 ARRAY ⊆ MAP 值集', () => {
    const adminMapValues = adminMap.map((entry) => entry[1])
    expect(clientInline.length).toBeGreaterThan(0)
    expect(clientInline.every((value) => adminMapValues.includes(value))).toBe(true)
  })

  test('staff EDITABLE_PROFILE_FIELDS 必须展开 MAP 键', () => {
    expect(staffCustomerSrc).toMatch(
      /EDITABLE_PROFILE_FIELDS[\s\S]{0,120}Object\.keys\(WORKFINE_PROFILE_FIELD_MAP\)/,
    )
  })

  test('admin 合并迁移 override 字段必须派生自 MAP', () => {
    expect(adminCustomersSrc).toMatch(
      /WORKFINE_OVERRIDE_FIELD_MAP\[field as keyof typeof WORKFINE_OVERRIDE_FIELD_MAP\]/,
    )
    expect(adminCustomersSrc).toMatch(/transferredOverrideFields\.add\(overrideField\)/)
    expect(adminCustomersSrc).toMatch(
      /(?:patch\.)?workfineOverrideFields\s*=\s*sql<string(?:\[\])?>`ARRAY\(/,
    )
  })
})
