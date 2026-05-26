import forge from 'node-forge'

/**
 * 密码传输层加密（客户端）
 *
 * 用服务端公钥（`NEXT_PUBLIC_RSA_PUBLIC_KEY`，存的是 base64(PEM SPKI)）对密码做
 * RSA-OAEP（SHA-256）加密，返回 base64 密文，交给 server action（login / changePassword）。
 * 服务端用 `decryptPassword`（lib/password-transit.ts）还原明文。
 *
 * 选用纯 JS 的 node-forge 而非浏览器 Web Crypto：`crypto.subtle` 仅在安全上下文
 * （HTTPS / localhost）暴露，而本后台允许跑在纯 HTTP 上，node-forge 不受此限制。
 *
 * 填充方式必须与服务端一致：RSA-OAEP + SHA-256（mgf1 也用 SHA-256）。
 * 注意：曾用 jsencrypt 的 PKCS#1 v1.5，但 Node 18.19.1+ 因 CVE-2023-46809（Marvin
 * 攻击）禁用了 privateDecrypt 的 PKCS1 padding，导致生产解密必抛异常。OAEP 不受影响。
 */
export function encryptPassword(plain: string): string {
  const pubB64 = process.env.NEXT_PUBLIC_RSA_PUBLIC_KEY
  if (!pubB64) {
    throw new Error('密码加密未配置（缺少 NEXT_PUBLIC_RSA_PUBLIC_KEY）')
  }

  const pem = atob(pubB64)
  const publicKey = forge.pki.publicKeyFromPem(pem)
  // encodeUtf8 → 二进制串（UTF-8 字节），保证非 ASCII 密码可正确还原
  const encrypted = publicKey.encrypt(forge.util.encodeUtf8(plain), 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  })
  return forge.util.encode64(encrypted)
}
