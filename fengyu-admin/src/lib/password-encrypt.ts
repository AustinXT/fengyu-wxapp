import { JSEncrypt } from 'jsencrypt'

/**
 * 密码传输层加密（客户端）
 *
 * 用服务端公钥（`NEXT_PUBLIC_RSA_PUBLIC_KEY`，存的是 base64(PEM SPKI)）对密码做
 * RSA 加密，返回 base64 密文，交给 server action（login / changePassword）。
 * 服务端用 `decryptPassword`（lib/password-transit.ts）还原明文。
 *
 * 选用纯 JS 的 jsencrypt 而非浏览器 Web Crypto：`crypto.subtle` 仅在安全上下文
 * （HTTPS / localhost）暴露，而本后台允许跑在纯 HTTP 上，jsencrypt 不受此限制。
 */
export function encryptPassword(plain: string): string {
  const pubB64 = process.env.NEXT_PUBLIC_RSA_PUBLIC_KEY
  if (!pubB64) {
    throw new Error('密码加密未配置（缺少 NEXT_PUBLIC_RSA_PUBLIC_KEY）')
  }

  const encryptor = new JSEncrypt()
  encryptor.setPublicKey(atob(pubB64))
  const ciphertext = encryptor.encrypt(plain)
  if (ciphertext === false) {
    throw new Error('密码加密失败')
  }
  return ciphertext
}
