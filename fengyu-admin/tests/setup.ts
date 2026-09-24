import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { generateKeyPairSync } from 'crypto'

// 为 encryptPassword/decryptPassword 提供一对 RSA 密钥（base64(PEM)）。
// 运行时生成，避免在源码里嵌入超长字面量；仅本进程单测使用，与生产密钥无关。
if (!process.env.RSA_PRIVATE_KEY || !process.env.NEXT_PUBLIC_RSA_PUBLIC_KEY) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  process.env.RSA_PRIVATE_KEY = Buffer.from(privateKey).toString('base64')
  process.env.NEXT_PUBLIC_RSA_PUBLIC_KEY = Buffer.from(publicKey).toString('base64')
}

// 进销存开关现由 env 驱动且默认关闭（见 src/lib/inventory-feature-flags.ts）。
// menu.test.ts / orders.test.ts 断言的是联动开启下的行为（库存菜单可见、冻结库存组成），
// 故在此显式开启，与 dev 环境一致。关闭态（未设 env）的 fail-closed 守护由
// src/lib/inventory-feature-flags.test.ts 用 vi.stubEnv 单独覆盖。
process.env.NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED =
  process.env.NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED || 'true'

afterEach(() => {
  cleanup()
})
