import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

/**
 * 硬编码 `const X = true` —— 这正是 2026-09 的事故形态：dev 线把四端开关写死 true，
 * 合并进 main 后一旦部署，提货会在 assertWorkfineInventoryInitialized 处全量抛
 * INVALID_STATE（prod 的 inventory_cutover_states 是空表）。开关必须由环境驱动。
 */
function hardcodedTrue(relativePath: string, exportName: string): boolean {
  return new RegExp(`(?:export\\s+)?const\\s+${exportName}\\s*=\\s*true`).test(readSource(relativePath))
}

const CLOUD_FN_FLAGS = [
  '../fengyu-client/cloudfunctions/clientApi/utils/feature-flags.js',
  '../fengyu-staff/cloudfunctions/staffApi/utils/feature-flags.js',
]
const MINIPROGRAM_FLAGS = '../fengyu-staff/miniprogram/utils/feature-flags.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('进销存发布开关 fail-closed', () => {
  it.each([
    ['true', 'false', true, false],
    ['false', 'true', false, true],
    ['true', 'true', true, true],
    [undefined, undefined, false, false],
    ['false', 'false', false, false],
    ['1', 'TRUE', false, false],
    ['', '', false, false],
  ])('ENTRY=%s / LINKAGE=%s 独立控制', async (entry, linkage, entryExpected, linkageExpected) => {
    vi.stubEnv('NEXT_PUBLIC_INVENTORY_ENTRY_ENABLED', entry)
    vi.stubEnv('NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED', linkage)
    vi.resetModules()
    const mod = await import('./inventory-feature-flags')
    expect(mod.INVENTORY_ENTRY_ENABLED).toBe(entryExpected)
    expect(mod.INVENTORY_LINKAGE_ENABLED).toBe(linkageExpected)
    const { MENU_CONFIG } = await import('./menu')
    const pickup = MENU_CONFIG.flatMap(item => 'children' in item ? item.children : []).find(item => item.href === '/pickup-records')
    expect(pickup?.hidden).toBe(!entryExpected)
    expect(MENU_CONFIG.find(item => item.label === '库存管理')?.hidden).toBe(!linkageExpected)
  })

  it('联动与 admin 入口禁止硬编码 true，staff 登记入口独立开放', () => {
    expect(hardcodedTrue('src/lib/inventory-feature-flags.ts', 'INVENTORY_ENTRY_ENABLED')).toBe(false)
    expect(hardcodedTrue('src/lib/inventory-feature-flags.ts', 'INVENTORY_LINKAGE_ENABLED')).toBe(false)
    for (const path of CLOUD_FN_FLAGS) {
      expect(hardcodedTrue(path, 'INVENTORY_LINKAGE_ENABLED'), path).toBe(false)
    }
    expect(hardcodedTrue(MINIPROGRAM_FLAGS, 'INVENTORY_ENTRY_ENABLED')).toBe(true)
    expect(hardcodedTrue(MINIPROGRAM_FLAGS, 'INVENTORY_LINKAGE_ENABLED')).toBe(false)
  })

  it('两个云函数副本都读 process.env.INVENTORY_LINKAGE_ENABLED', () => {
    for (const path of CLOUD_FN_FLAGS) {
      expect(readSource(path), path).toContain("process.env.INVENTORY_LINKAGE_ENABLED === 'true'")
    }
  })

  it.each(['develop', 'trial', 'release', undefined, 'throw'])('staff %s：登记开放，联动仅 develop', (version) => {
    const source = readSource(MINIPROGRAM_FLAGS)
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
    const exports: Record<string, boolean> = {}
    runInNewContext(compiled, { exports, wx: { getAccountInfoSync() {
      if (version === 'throw') throw new Error('unavailable')
      return { miniProgram: { envVersion: version } }
    } } })
    expect(exports.INVENTORY_ENTRY_ENABLED).toBe(true)
    expect(exports.INVENTORY_LINKAGE_ENABLED).toBe(version === 'develop')
  })

  it('staff 只将提货入口接到 ENTRY，库存入口接到 LINKAGE', () => {
    for (const page of ['workbench', 'profile']) {
      const base = `../fengyu-staff/miniprogram/pages/${page}/${page}`
      expect(readSource(`${base}.ts`)).toContain('inventoryLinkageEnabled: INVENTORY_LINKAGE_ENABLED')
      const wxml = readSource(`${base}.wxml`)
      expect(wxml).toMatch(/wx:if="{{[^}]*inventoryLinkageEnabled[^}]*}}"[^>]*(?:goInventory|onNavInventory)/)
      expect(wxml).toMatch(/wx:if="{{[^}]*inventoryEntryEnabled[^}]*}}"[^>]*(?:goPickup|onNavPickup)/)
    }
  })
})

describe('prod 环境模板守护', () => {
  // prod 的 inventory_cutover_states 为空表，开关一开提货即全量失败。
  // 期初库存导入并核验为「已初始化」之前，这两个键必须保持 false。
  it('prod.env.example 登记开启、两个联动键仍 false', () => {
    const source = readSource('../envs/prod.env.example')
    expect(source).toMatch(/^NEXT_PUBLIC_INVENTORY_ENTRY_ENABLED=true$/m)
    expect(source).toMatch(/^INVENTORY_LINKAGE_ENABLED=false$/m)
    expect(source).toMatch(/^NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=false$/m)
  })

  it('云函数模板把开关透传给 staffApi / clientApi', () => {
    for (const path of ['../fengyu-staff/cloudbaserc.example.json', '../fengyu-client/cloudbaserc.example.json']) {
      expect(readSource(path), path).toContain('"INVENTORY_LINKAGE_ENABLED": "${INVENTORY_LINKAGE_ENABLED}"')
    }
  })

  it('admin 构建链把 NEXT_PUBLIC_ 开关传进镜像', () => {
    expect(readSource('../docker/Dockerfile.admin')).toContain('ARG NEXT_PUBLIC_INVENTORY_ENTRY_ENABLED=')
    expect(readSource('../.claude/skills/remote-deploy/deploy-common.sh')).toContain('--build-arg NEXT_PUBLIC_INVENTORY_ENTRY_ENABLED=')
    expect(readSource('../docker/Dockerfile.admin')).toContain('ARG NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=')
    expect(readSource('../.claude/skills/remote-deploy/deploy-common.sh'))
      .toContain('--build-arg NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=')
  })
})
