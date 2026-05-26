import 'server-only'
import { constants, privateDecrypt } from 'crypto'

/**
 * 密码传输层解密（服务端）
 *
 * 前端用 RSA 公钥（node-forge，RSA-OAEP + SHA-256）加密密码后传输，服务端在此用私钥
 * 解密还原明文，再交给现有 bcrypt 校验/哈希。`admin_passwords` 存储语义不变。
 *
 * 私钥来自 `RSA_PRIVATE_KEY` 环境变量，存的是 base64(PEM)，规避多行 PEM 在
 * env / docker-compose 中的换行问题。
 *
 * 填充方式必须与客户端一致：`RSA_PKCS1_OAEP_PADDING` + `oaepHash: 'sha256'`。
 * 历史踩坑：原用 `RSA_PKCS1_PADDING`（PKCS#1 v1.5），但 Node 18.19.1+ 因
 * CVE-2023-46809（Marvin 攻击）禁用了 privateDecrypt 的 PKCS1 padding，生产
 * （node:18-alpine 18.20.8）每次解密都抛 "RSA_PKCS1_PADDING is no longer supported"，
 * 被 login 的 catch 当成认证失败 → 误报「手机号或密码错误」。改用 OAEP 根治。
 */
export function decryptPassword(ciphertextB64: string): string {
  const keyB64 = process.env.RSA_PRIVATE_KEY
  if (!keyB64) {
    // fail-fast：绝不静默回退到接收明文
    throw new Error('INVALID_STATE: 密码加密未配置（缺少 RSA_PRIVATE_KEY）')
  }

  const privateKey = Buffer.from(keyB64, 'base64').toString('utf8')
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(ciphertextB64, 'base64'),
  )
  return decrypted.toString('utf8')
}
