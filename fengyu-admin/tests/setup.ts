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

afterEach(() => {
  cleanup()
})
