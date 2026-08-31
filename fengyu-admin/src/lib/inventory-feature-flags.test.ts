import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INVENTORY_ENTRY_ENABLED, INVENTORY_LINKAGE_ENABLED } from './inventory-feature-flags'

function exportedTrue(relativePath: string, exportName: string): boolean {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')
  return new RegExp(`(?:export\\s+)?const\\s+${exportName}\\s*=\\s*true`).test(source)
}

describe('进销存发布开关跨端一致性', () => {
  it('admin 入口和联动已开启', () => {
    expect(INVENTORY_ENTRY_ENABLED).toBe(true)
    expect(INVENTORY_LINKAGE_ENABLED).toBe(true)
  })

  it('clientApi、staffApi 与 staff 小程序保持开启', () => {
    expect(exportedTrue('../fengyu-client/cloudfunctions/clientApi/utils/feature-flags.js', 'INVENTORY_LINKAGE_ENABLED')).toBe(true)
    expect(exportedTrue('../fengyu-staff/cloudfunctions/staffApi/utils/feature-flags.js', 'INVENTORY_LINKAGE_ENABLED')).toBe(true)
    expect(exportedTrue('../fengyu-staff/miniprogram/utils/feature-flags.ts', 'INVENTORY_ENTRY_ENABLED')).toBe(true)
    expect(exportedTrue('../fengyu-staff/miniprogram/utils/feature-flags.ts', 'INVENTORY_LINKAGE_ENABLED')).toBe(true)
  })
})
