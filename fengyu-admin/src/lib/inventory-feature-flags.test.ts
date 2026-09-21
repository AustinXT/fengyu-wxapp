import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INVENTORY_ENTRY_ENABLED, INVENTORY_LINKAGE_ENABLED } from './inventory-feature-flags'

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
  // tests/setup.ts 把 env 设成 'true'（与 dev 一致），这里验证开启态确实生效。
  it('env=true 时开启', () => {
    expect(INVENTORY_ENTRY_ENABLED).toBe(true)
    expect(INVENTORY_LINKAGE_ENABLED).toBe(true)
  })

  it('env 缺失时关闭 —— prod 镜像不传 build-arg 即走此路径', async () => {
    vi.stubEnv('NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED', undefined as unknown as string)
    vi.resetModules()
    const mod = await import('./inventory-feature-flags')
    expect(mod.INVENTORY_ENTRY_ENABLED).toBe(false)
    expect(mod.INVENTORY_LINKAGE_ENABLED).toBe(false)
  })

  it('只有字面量 true 才开启', async () => {
    for (const value of ['false', '1', 'TRUE', '']) {
      vi.stubEnv('NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED', value)
      vi.resetModules()
      const mod = await import('./inventory-feature-flags')
      expect(mod.INVENTORY_LINKAGE_ENABLED, `env=${value} 不应开启`).toBe(false)
    }
  })

  it('四端都没有硬编码 true', () => {
    expect(hardcodedTrue('src/lib/inventory-feature-flags.ts', 'INVENTORY_ENTRY_ENABLED')).toBe(false)
    expect(hardcodedTrue('src/lib/inventory-feature-flags.ts', 'INVENTORY_LINKAGE_ENABLED')).toBe(false)
    for (const path of CLOUD_FN_FLAGS) {
      expect(hardcodedTrue(path, 'INVENTORY_LINKAGE_ENABLED'), path).toBe(false)
    }
    expect(hardcodedTrue(MINIPROGRAM_FLAGS, 'INVENTORY_ENTRY_ENABLED')).toBe(false)
    expect(hardcodedTrue(MINIPROGRAM_FLAGS, 'INVENTORY_LINKAGE_ENABLED')).toBe(false)
  })

  it('两个云函数副本都读 process.env.INVENTORY_LINKAGE_ENABLED', () => {
    for (const path of CLOUD_FN_FLAGS) {
      expect(readSource(path), path).toContain("process.env.INVENTORY_LINKAGE_ENABLED === 'true'")
    }
  })

  it('staff 小程序按 envVersion 判别（拿不到 process.env）', () => {
    const source = readSource(MINIPROGRAM_FLAGS)
    expect(source).toContain('wx.getAccountInfoSync()')
    expect(source).toContain("envVersion === 'develop'")
  })
})

describe('prod 环境模板守护', () => {
  // prod 的 inventory_cutover_states 为空表，开关一开提货即全量失败。
  // 期初库存导入并核验为「已初始化」之前，这两个键必须保持 false。
  it('prod.env.example 两个键都是 false', () => {
    const source = readSource('../envs/prod.env.example')
    expect(source).toMatch(/^INVENTORY_LINKAGE_ENABLED=false$/m)
    expect(source).toMatch(/^NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=false$/m)
  })

  it('云函数模板把开关透传给 staffApi / clientApi', () => {
    for (const path of ['../fengyu-staff/cloudbaserc.example.json', '../fengyu-client/cloudbaserc.example.json']) {
      expect(readSource(path), path).toContain('"INVENTORY_LINKAGE_ENABLED": "${INVENTORY_LINKAGE_ENABLED}"')
    }
  })

  it('admin 构建链把 NEXT_PUBLIC_ 开关传进镜像', () => {
    expect(readSource('../docker/Dockerfile.admin')).toContain('ARG NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=')
    expect(readSource('../.claude/skills/remote-deploy/deploy-common.sh'))
      .toContain('--build-arg NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=')
  })
})
