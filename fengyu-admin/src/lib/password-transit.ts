import 'server-only'
import { constants, privateDecrypt } from 'crypto'

/**
 * 密码传输层解密（服务端）
 *
 * 前端用 RSA 公钥（jsencrypt，PKCS#1 v1.5 填充）加密密码后传输，服务端在此用私钥
 * 解密还原明文，再交给现有 bcrypt 校验/哈希。`admin_passwords` 存储语义不变。
 *
 * 私钥来自 `RSA_PRIVATE_KEY` 环境变量，存的是 base64(PEM)，规避多行 PEM 在
 * env / docker-compose 中的换行问题。
 *
 * jsencrypt 默认 PKCS#1 v1.5 填充，故这里必须显式 `RSA_PKCS1_PADDING`
 * （Node 的 privateDecrypt 默认是 OAEP，填充不匹配会解密失败）。
 */
export function decryptPassword(ciphertextB64: string): string {
  const keyB64 = process.env.RSA_PRIVATE_KEY
  if (!keyB64) {
    // fail-fast：绝不静默回退到接收明文
    throw new Error('INVALID_STATE: 密码加密未配置（缺少 RSA_PRIVATE_KEY）')
  }

  const privateKey = Buffer.from(keyB64, 'base64').toString('utf8')
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(ciphertextB64, 'base64'),
  )
  return decrypted.toString('utf8')
}
